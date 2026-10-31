'use server';

// Drawing one stage of a staged event (00272). The shape of each stage lives in
// the event's format_config; the rows come out of buildStageRows in
// packages/shared, and the fence is the legacy draw's: tear the stage down and
// claim a generation, insert under it, publish under the field lock.

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import {
  ExpectedError,
  buildAddedRoundRows,
  buildLateEntrantRows,
  buildStageRows,
  planLateEntrant,
  hasRedrawBlockers,
  isDoublesEvent,
  parseFormatConfig,
  reseededEntrants,
  resolveSlots,
  shuffleWithRng,
  sourceStages,
  stageComplete,
  stageNumber,
  stageReady,
  summariseRedrawBlockers,
  type FormatConfig,
  type FormatResults,
  type GroupsStage,
  formatResultsFrom,
  resolveStageMatches,
  slotRefLabel,
  type StageEntrant,
} from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  assertTournamentNotSuspended,
  assertDrawFieldEventWaiverSigned,
  assertNobodyLeftUnpaired,
  assertFieldDidNotGrow,
  settleWrites,
  assertWritesSucceeded,
  mustWrite,
  makeDrawRng,
  newDrawSeed,
  inIdOrder,
} from './_internal';
import { readTournamentCourts } from '../tournament-courts';
import { resolveStageCourts, rowForInsert, unknownStageCourtsMessage } from './stage-rows';

type AdminClient = ReturnType<typeof createAdminClient>;

const MIGRATION_MISSING = 'Run migration 00272 first';

// Undefined column, a column PostgREST's schema cache does not have, or a
// function it does not know: the database is older than this code.
function isSchemaMissing(error: { code?: string } | null): boolean {
  return !!error && ['42703', 'PGRST204', 'PGRST202', '42883'].includes(error.code ?? '');
}

async function assertStagedSchema(adminClient: AdminClient, eventId: string): Promise<void> {
  const [events, matches, pairs] = await Promise.all([
    adminClient.from('tournament_events').select('id, format_config, current_stage, rated').eq('id', eventId).maybeSingle(),
    adminClient.from('tournament_matches').select('stage, pool_number, group_number, slot, match_label, handicap_a, handicap_b').limit(0),
    adminClient.from('tournament_pairs').select('team_category').limit(0),
  ]);
  for (const { error } of [events, matches, pairs]) {
    if (isSchemaMissing(error)) throw new ExpectedError(MIGRATION_MISSING);
    if (error) throw new Error(`Could not read the event to draw it: ${error.message}`);
  }
}

type Entry = {
  id: string;
  seed: number | null;
  elo: number;
  status: string;
  category: string | null;
  identity: Record<string, string | number | null>;
  grp: number | null;
};

async function readEntries(adminClient: AdminClient, eventId: string, doubles: boolean): Promise<Entry[]> {
  if (doubles) {
    const { data, error } = await adminClient.from('tournament_pairs')
      .select('id, seed_number, combined_elo, group_number, player1_id, player2_id, status, team_category')
      .eq('event_id', eventId);
    if (error) throw new Error(`Could not read the event's entries: ${error.message}`);
    return (data ?? []).map((p) => ({
      id: p.id, seed: p.seed_number, elo: p.combined_elo ?? 400, status: p.status, category: p.team_category,
      // 00202's digest keys, as brackets.ts doublesIdentity builds them.
      identity: { p1: p.player1_id, p2: p.player2_id, ce: p.combined_elo ?? null },
      grp: p.group_number,
    }));
  }
  const { data, error } = await adminClient.from('tournament_participants')
    .select('id, seed_number, elo_before, elo_after, group_number, player_id, status')
    .eq('event_id', eventId);
  if (error) throw new Error(`Could not read the event's entries: ${error.message}`);
  return (data ?? []).map((p) => ({
    id: p.id, seed: p.seed_number, elo: p.elo_before ?? 400, status: p.status, category: null,
    identity: { p: p.player_id, eb: p.elo_before ?? null, ea: p.elo_after ?? null },
    grp: p.group_number,
  }));
}

type StagedMatch = {
  id: string;
  stage: number;
  status: string;
  is_bye: boolean | null;
  elo_snapshot: unknown;
  pool_number: number | null;
  group_number: number | null;
  round_number: number;
  match_label: string | null;
  match_number: number | null;
  is_third_place: boolean;
  a: string | null;
  b: string | null;
  winner: string | null;
  scores: unknown;
};

async function readStagedMatches(adminClient: AdminClient, eventId: string, doubles: boolean): Promise<StagedMatch[]> {
  const { data, error } = await adminClient.from('tournament_matches')
    .select('id, stage, status, is_bye, elo_snapshot, pool_number, group_number, round_number, match_label, match_number, is_third_place, pair_a_id, pair_b_id, participant_a_id, participant_b_id, winner_pair_id, winner_participant_id, scores')
    .eq('event_id', eventId)
    .not('stage', 'is', null);
  if (error) throw new Error(`Could not read the event's matches: ${error.message}`);
  return (data ?? []).map((m) => ({
    id: m.id,
    stage: m.stage!,
    status: m.status,
    is_bye: m.is_bye,
    elo_snapshot: m.elo_snapshot,
    pool_number: m.pool_number,
    group_number: m.group_number,
    round_number: m.round_number,
    match_label: m.match_label,
    match_number: m.match_number,
    is_third_place: m.is_third_place,
    a: doubles ? m.pair_a_id : m.participant_a_id,
    b: doubles ? m.pair_b_id : m.participant_b_id,
    winner: doubles ? m.winner_pair_id : m.winner_participant_id,
    scores: m.scores,
  }));
}

/** The event's play as the shared staged functions read it. */
function formatResults(cfg: FormatConfig, entries: Entry[], matches: StagedMatch[]): FormatResults {
  return formatResultsFrom(cfg, entries, matches);
}

function refuseRebuild(rows: StagedMatch[]): void {
  const blockers = summariseRedrawBlockers(rows);
  if (!hasRedrawBlockers(blockers)) return;
  const { played, rated, inProgress } = blockers;
  if (played > 0) {
    throw new ExpectedError(
      `${played} match${played === 1 ? '' : 'es'} in this stage ${played === 1 ? 'has' : 'have'} a result, and rebuilding the stage deletes every match in it. `
      + `Void or undo ${played === 1 ? 'it' : 'them'} first if the stage really has to be rebuilt.`,
    );
  }
  if (rated > 0) {
    throw new ExpectedError(
      `${rated} match${rated === 1 ? '' : 'es'} in this stage still carr${rated === 1 ? 'ies' : 'y'} an applied rating. Unvoid then undo ${rated === 1 ? 'it' : 'them'} first.`,
    );
  }
  if (inProgress > 0) {
    throw new ExpectedError(
      `${inProgress} match${inProgress === 1 ? '' : 'es'} in this stage ${inProgress === 1 ? 'is' : 'are'} being played right now. Undo the start first, or wait for the result.`,
    );
  }
}

async function publishStage(
  adminClient: AdminClient,
  eventId: string,
  stage: number,
  generation: string,
  doubles: boolean,
  entrants: string[],
  digests: Array<Record<string, string | number | null>> | null,
  sourceFingerprint: unknown,
): Promise<void> {
  const { data, error } = await adminClient.rpc('publish_stage_draw', {
    p_event_id: eventId,
    p_stage: stage,
    p_generation: generation,
    p_doubles: doubles,
    p_entrants: entrants,
    p_digests: digests,
    p_source_fingerprint: sourceFingerprint as never,
  });
  if (isSchemaMissing(error)) throw new ExpectedError(MIGRATION_MISSING);
  if (error) throw new Error(`Publishing the stage failed: ${error.message}`);
  const res = data as { ok?: boolean; reason?: string; count?: number; now?: number; expected?: number } | null;
  if (!res) throw new Error('Publishing the stage returned nothing.');
  if (res.ok) return;
  const again = 'Nothing was published. Press Draw again to rebuild it as the event now stands.';
  switch (res.reason) {
    case 'field_grew':
      throw new ExpectedError(`Entries arrived while this stage was being drawn, so it would have left somebody out. ${again}`);
    case 'entrant_left':
      throw new ExpectedError(`Somebody in this stage left the event while it was being drawn. ${again}`);
    case 'entrant_changed':
      throw new ExpectedError(`An entry changed while this stage was being drawn (a member swapped or a seed edited). ${again}`);
    case 'source_changed':
      throw new ExpectedError(`A result in an earlier stage changed while this stage was being drawn. ${again}`);
    case 'superseded':
      throw new ExpectedError('This stage was rebuilt by somebody else while it was being drawn, so nothing here was saved. Reload the event to see it.');
    case 'event_not_live':
      throw new ExpectedError('Start the event before drawing a later stage.');
    case 'event_completed':
      throw new ExpectedError('This event has been finalised, so its stages cannot be drawn again.');
    case 'not_staged':
      throw new ExpectedError('This event is not played in stages.');
    case 'foreign_matches':
      Sentry.captureMessage('publish_stage_draw: foreign matches in the stage', { level: 'error', tags: { eventId } });
      throw new Error('This stage contains matches from another draw and was not published.');
    case 'no_matches':
      Sentry.captureMessage('publish_stage_draw: nothing was built', { level: 'error', tags: { eventId } });
      throw new Error('No matches were created for this stage, so it was not published.');
    case 'event_not_found':
      throw new Error('Event not found');
    default:
      throw new Error('Could not publish the stage. Please try again.');
  }
}

async function drawStageImpl(eventId: string, stageKey: string, mode: 'draw' | 'redraw', drawSeed: number = newDrawSeed()) {
  const admin = await requireCapability('tournaments.draw.generate.write');
  const adminClient = createAdminClient();
  await assertStagedSchema(adminClient, eventId);

  const { data: event, error: eventError } = await adminClient.from('tournament_events').select('*').eq('id', eventId).maybeSingle();
  if (eventError) throw new Error(`Could not read the event: ${eventError.message}`);
  if (!event) throw new Error('Event not found');
  if (event.format !== 'staged') throw new ExpectedError('This event is not played in stages.');
  const cfg = parseFormatConfig(event.format_config);
  if (!cfg) throw new ExpectedError('This event\'s stages are not set out correctly. Fix them in the event settings first.');
  const k = stageNumber(cfg, stageKey);
  const stage = cfg.stages.find((s) => s.key === stageKey);
  if (k == null || !stage) throw new ExpectedError(`This event has no stage "${stageKey}".`);
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before drawing a stage.');
  if (event.status === 'completed') {
    throw new ExpectedError('This event has been finalised, so its stages cannot be drawn again.');
  }
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const doubles = isDoublesEvent(event.event_type);
  const fromField = stage.entrants.from === 'field';
  if (fromField && k !== 1) throw new ExpectedError('Only the first stage can be drawn from the field.');

  // Read before the matches, so a result that lands in between makes the
  // publish refuse rather than slip through.
  let sourceFingerprint: unknown = null;
  if (!fromField) {
    const { data, error } = await adminClient.rpc('staged_source_fingerprint', { p_event_id: eventId, p_stage: k });
    if (isSchemaMissing(error)) throw new ExpectedError(MIGRATION_MISSING);
    if (error) throw new Error(`Could not read the earlier stages: ${error.message}`);
    sourceFingerprint = data;
  }

  const matches = await readStagedMatches(adminClient, eventId, doubles);
  const own = matches.filter((m) => m.stage === k);
  if (mode === 'draw' && own.length > 0) throw new ExpectedError(`"${stage.name}" is already drawn. Use Redraw to rebuild it.`);
  if (mode === 'redraw' && own.length === 0) throw new ExpectedError(`"${stage.name}" has not been drawn yet.`);
  if (matches.some((m) => m.stage > k)) {
    throw new ExpectedError(`A later stage has already been drawn from "${stage.name}", so it cannot be rebuilt.`);
  }
  refuseRebuild(own);

  const entries = await readEntries(adminClient, eventId, doubles);
  let entrants: StageEntrant[];
  let drawnIds: string[];
  let digests: Array<Record<string, string | number | null>> | null = null;
  let randomised = false;
  let results: FormatResults | undefined;

  if (fromField) {
    await assertNobodyLeftUnpaired(adminClient, eventId, doubles);
    let field = entries.filter((e) => e.status === 'registered' || e.status === 'checked_in');
    if (field.length < 2) throw new ExpectedError('Need at least 2 entries to draw this stage.');
    await assertDrawFieldEventWaiverSigned(adminClient, event.tournament_id, field.map((e) => e.id), doubles);

    const order = stage.entrants.from === 'field' ? stage.entrants.order : 'elo';
    if (order === 'random') {
      field = shuffleWithRng(inIdOrder(field), makeDrawRng(drawSeed));
      randomised = true;
    } else if (order === 'manual') {
      field = [...field].sort((x, y) => (x.seed ?? Infinity) - (y.seed ?? Infinity) || y.elo - x.elo);
    } else {
      field = [...field].sort((x, y) => y.elo - x.elo || (x.id < y.id ? -1 : 1));
    }
    // The seeding this draw used, stored, unless the organiser set it by hand.
    if (order !== 'manual') {
      const moved = field.map((e, i) => ({ e, seed: i + 1 })).filter(({ e, seed }) => e.seed !== seed);
      const table = doubles ? 'tournament_pairs' : 'tournament_participants';
      const { failures } = await settleWrites(
        moved.map(({ e, seed }) => [
          `${table}.seed_number for ${e.id}`,
          adminClient.from(table).update({ seed_number: seed }).eq('id', e.id),
        ] as const),
      );
      assertWritesSucceeded('Seeding the stage', failures);
      for (const { e, seed } of moved) e.seed = seed;
    }
    entrants = field.map((e) => ({ id: e.id, category: e.category }));
    drawnIds = field.map((e) => e.id);
    digests = field.map((e) => ({ ...e.identity, seed: e.seed, grp: e.grp }));
  } else {
    const played = formatResults(cfg, entries, matches);
    results = played;
    if (!stageReady(cfg, stageKey, played)) {
      const waiting = sourceStages(cfg, stageKey).filter((key) => !stageComplete(played, key))
        .map((key) => cfg.stages.find((s) => s.key === key)?.name ?? key);
      throw new ExpectedError(
        `${waiting.map((n) => `"${n}"`).join(' and ')} ${waiting.length === 1 ? 'is' : 'are'} not finished yet. `
        + `Every match there must be played before "${stage.name}" can be drawn.`,
      );
    }
    if (stage.kind === 'matches') {
      entrants = entries.map((e) => ({ id: e.id, category: e.category }));
      drawnIds = [];
    } else {
      const order = reseededEntrants(cfg, stageKey, played);
      if (!order) {
        const pending = resolveSlots(cfg, stageKey, played).find((s) => s.entry == null);
        throw new ExpectedError(pending?.pendingReason ?? `"${stage.name}" cannot be filled yet.`);
      }
      const categories = new Map(entries.map((e) => [e.id, e.category]));
      entrants = order.map((id) => ({ id, category: categories.get(id) ?? null }));
      drawnIds = order;
    }
  }

  // A slot that names a match result (the winner of a semi-final) is filled
  // whoever won it, so somebody who has since withdrawn could be drawn into the
  // next stage. Said here, with the slot named, rather than left for the
  // publish to refuse on every attempt as if they had left mid-draw.
  if (results) {
    const out = new Set(results.out ?? []);
    const gone = (id: string | null) => id != null && out.has(id);
    if (stage.kind === 'matches') {
      const resolved = resolveStageMatches(cfg, stageKey, results);
      stage.matches.forEach((def, i) => {
        const m = resolved[i];
        const side = m && gone(m.a.entry) ? def.a : m && gone(m.b.entry) ? def.b : null;
        if (side) {
          throw new ExpectedError(
            `${def.name}: the ${slotRefLabel(side, cfg).toLowerCase()} has withdrawn or been disqualified, so this stage cannot be drawn as set out. `
            + 'Change the stage in the event settings so that place is filled another way.',
          );
        }
      });
    } else if (drawnIds.some(gone)) {
      throw new ExpectedError(`An entrant of "${stage.name}" has withdrawn or been disqualified. Change the stage in the event settings so that place is filled another way.`);
    }
  }

  const firstMatchNumber = matches.filter((m) => m.stage < k)
    .reduce((n, m) => Math.max(n, m.match_number ?? 0), 0) + 1;
  // Built BEFORE the teardown, so a stage that cannot be drawn (too few for its
  // groups, a side still unknown) refuses with the old draw untouched.
  const rows = buildStageRows(cfg, stageKey, entrants, '', {
    rng: makeDrawRng(drawSeed),
    results,
    firstMatchNumber,
  });
  if (stage.kind === 'matches') drawnIds = [...new Set(rows.flatMap((r) => [r.a, r.b]).filter((id): id is string => !!id))];

  // The stage's court labels against the tournament's courts (00273), also
  // before the teardown: a label the tournament does not have refuses the draw
  // with the old one untouched. No courts listed keeps the labels as text.
  const courts = await readTournamentCourts(adminClient, event.tournament_id);
  const { courtIds, unknown: unknownCourts } = resolveStageCourts(courts, rows);
  if (unknownCourts.length > 0) throw new ExpectedError(unknownStageCourtsMessage(unknownCourts));

  const { data: torn, error: tearError } = await adminClient.rpc('delete_stage_matches', { p_event_id: eventId, p_stage: k });
  if (tearError) {
    if (isSchemaMissing(tearError)) throw new ExpectedError(MIGRATION_MISSING);
    if (tearError.code === '23514') throw new ExpectedError(tearError.message);
    Sentry.captureException(tearError);
    throw new Error(`The old stage could not be cleared, so it was left alone: ${tearError.message}`);
  }
  const generation = (torn as { generation?: unknown } | null)?.generation;
  if (typeof generation !== 'string') throw new Error('The stage teardown did not return a generation, so this draw cannot be fenced.');
  for (const r of rows) r.draw_generation_id = generation;

  await mustWrite(
    `Inserting the ${rows.length} matches of "${stage.name}"`,
    adminClient.from('tournament_matches').insert(rows.map((r) => rowForInsert(eventId, r, doubles, courtIds)) as never).select('id'),
  );

  if (fromField) await assertFieldDidNotGrow(adminClient, eventId, doubles, drawnIds.length);
  await publishStage(adminClient, eventId, k, generation, doubles, drawnIds, digests, fromField ? null : sourceFingerprint);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'bracket_generated',
    performed_by: admin.id,
    details: {
      staged: true,
      stage: k,
      stage_key: stageKey,
      stage_kind: stage.kind,
      redraw: mode === 'redraw',
      entrants: drawnIds.length,
      matches: rows.length,
      courts_assigned: courtIds ? rows.filter((r) => r.court && courtIds.has(r.court)).length : 0,
      draw_seed: randomised || (stage.kind === 'groups' && stage.assignment === 'random') ? drawSeed : null,
      redrawn_live: event.status === 'live',
    },
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// Returned as values, like the legacy generators: Next sanitises anything a
// Server Action throws, and the refusals here are the point of the guards.
export async function drawStage(eventId: string, stageKey: string): Promise<ActionResult<void>> {
  return runAction(async () => { await drawStageImpl(eventId, stageKey, 'draw'); });
}

export async function redrawStage(eventId: string, stageKey: string): Promise<ActionResult<void>> {
  return runAction(async () => { await drawStageImpl(eventId, stageKey, 'redraw'); });
}

// ---------------------------------------------------------------------------
// Growing a drawn groups stage
// ---------------------------------------------------------------------------
//
// A round added to a stage is inserted under the generation the stage was drawn
// with, so the 00197 fence still refuses it if somebody redraws in between. It
// is never torn down or republished: the rows already there, and any result on
// them, stay exactly as they are.

const STAGE_CHANGED = 'This stage changed while the round was being added. Reload and try again.';

async function loadExtendableStage(eventId: string, stageKey: string) {
  const admin = await requireCapability('tournaments.draw.generate.write');
  const adminClient = createAdminClient();
  await assertStagedSchema(adminClient, eventId);

  const { data: event, error: eventError } = await adminClient.from('tournament_events').select('*').eq('id', eventId).maybeSingle();
  if (eventError) throw new Error(`Could not read the event: ${eventError.message}`);
  if (!event) throw new Error('Event not found');
  if (event.format !== 'staged') throw new ExpectedError('This event is not played in stages.');
  const cfg = parseFormatConfig(event.format_config);
  if (!cfg) throw new ExpectedError('This event\'s stages are not set out correctly. Fix them in the event settings first.');
  const k = stageNumber(cfg, stageKey);
  const found = cfg.stages.find((s) => s.key === stageKey);
  if (k == null || !found) throw new ExpectedError(`This event has no stage "${stageKey}".`);
  if (found.kind !== 'groups') throw new ExpectedError(`"${found.name}" is not a groups stage.`);
  const stage: GroupsStage = found;
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before changing a stage.');
  if (event.status === 'completed') throw new ExpectedError('This event has been finalised, so its stages cannot be changed.');
  if (event.status !== 'bracket_generated' && event.status !== 'live') {
    throw new ExpectedError(`Draw "${stage.name}" before adding to it.`);
  }
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const doubles = isDoublesEvent(event.event_type);
  const matches = await readStagedMatches(adminClient, eventId, doubles);
  const own = matches.filter((m) => m.stage === k);
  if (own.length === 0) throw new ExpectedError(`"${stage.name}" has not been drawn yet.`);
  if (matches.some((m) => m.stage > k)) throw new ExpectedError('A later stage has been drawn from this stage, so it cannot be changed.');
  // The generation the stage was drawn under. Null means no draw ever claimed
  // one, so a row stamped with anything would be refused by the fence.
  const generation = event.draw_generation_id;
  if (typeof generation !== 'string') throw new Error('This event has no draw generation, so a round cannot be added under it.');

  const entries = await readEntries(adminClient, eventId, doubles);
  const results = formatResults(cfg, entries, matches);
  const active = new Set(entries.filter((e) => e.status === 'registered' || e.status === 'checked_in').map((e) => e.id));
  // Slots are counted across the whole stage, not per pool, because round_number
  // is the slot and the unique index spans every pool of the stage.
  const firstSlot = own.reduce((n, m) => Math.max(n, m.round_number), 0) + 1;
  const firstMatchNumber = matches.reduce((n, m) => Math.max(n, m.match_number ?? 0), 0) + 1;
  return { admin, adminClient, event, cfg, stage, k, doubles, entries, results, active, firstSlot, firstMatchNumber, generation };
}

async function insertStageExtension(
  adminClient: AdminClient,
  eventId: string,
  tournamentId: string,
  stageName: string,
  rows: ReturnType<typeof buildAddedRoundRows>['rows'],
  doubles: boolean,
): Promise<{ courtsAssigned: number }> {
  const courts = await readTournamentCourts(adminClient, tournamentId);
  const { courtIds, unknown: unknownCourts } = resolveStageCourts(courts, rows);
  if (unknownCourts.length > 0) throw new ExpectedError(unknownStageCourtsMessage(unknownCourts));

  // Not mustWrite: it drops the error code, and the two codes below are how a
  // double click or a redraw in between arrives. Both mean nothing was saved.
  const { data, error } = await adminClient.from('tournament_matches')
    .insert(rows.map((r) => rowForInsert(eventId, r, doubles, courtIds)) as never)
    .select('id');
  if (error) {
    if (error.code === '23505' || error.code === '23514') throw new ExpectedError(STAGE_CHANGED);
    if (isSchemaMissing(error)) throw new ExpectedError(MIGRATION_MISSING);
    throw new Error(`Inserting the ${rows.length} matches of "${stageName}" failed: ${error.message}`);
  }
  if (!Array.isArray(data) || data.length !== rows.length) {
    throw new Error(`Inserting the ${rows.length} matches of "${stageName}" saved ${Array.isArray(data) ? data.length : 0}.`);
  }
  return { courtsAssigned: courtIds ? rows.filter((r) => r.court && courtIds.has(r.court)).length : 0 };
}

async function addStageRoundImpl(eventId: string, stageKey: string): Promise<{ matches: number; repeats: number }> {
  const loaded = await loadExtendableStage(eventId, stageKey);
  const { admin, adminClient, event, cfg, stage, k, doubles, entries, results, active } = loaded;

  const categories = new Map(entries.map((e) => [e.id, e.category]));
  const { rows, groups } = buildAddedRoundRows(cfg, stageKey, results, active, categories, loaded.generation, {
    firstSlot: loaded.firstSlot,
    firstMatchNumber: loaded.firstMatchNumber,
  });
  if (rows.length === 0) throw new ExpectedError(`No group in "${stage.name}" has two teams still in it, so there is no round to add.`);

  const { courtsAssigned } = await insertStageExtension(adminClient, eventId, event.tournament_id, stage.name, rows, doubles);
  const repeats = groups.reduce((n, g) => n + g.repeats, 0);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'bracket_generated',
    performed_by: admin.id,
    details: {
      staged: true,
      stage: k,
      stage_key: stageKey,
      extension: 'added_round',
      matches: rows.length,
      repeats,
      courts_assigned: courtsAssigned,
      generation: loaded.generation,
    },
  });

  revalidateEventPaths(event.tournament_id, eventId);
  return { matches: rows.length, repeats };
}

/** One more round for every group of a drawn groups stage. */
export async function addStageRound(eventId: string, stageKey: string): Promise<ActionResult<{ matches: number; repeats: number }>> {
  return runAction(() => addStageRoundImpl(eventId, stageKey));
}

// A LATE ENTRANT (00308) joins one group of the first stage and plays only the
// matches that even that group out. The entry itself arrives through the usual
// add paths, which 00308 opens while no later stage is drawn; this places it.
async function placeLateEntrantImpl(eventId: string, stageKey: string, entryId: string): Promise<{ matches: number }> {
  const loaded = await loadExtendableStage(eventId, stageKey);
  const { admin, adminClient, event, cfg, stage, k, doubles, entries, results, active } = loaded;
  if (k !== 1 || stage.entrants.from !== 'field') {
    throw new ExpectedError('A late entry joins the first stage, drawn from the field, only.');
  }
  // In doubles the entries read are pairs, so a loose player in the pool is
  // never one of them: they have to be paired first.
  if (!entries.some((e) => e.id === entryId)) {
    throw new ExpectedError(doubles ? 'Pair this player first: a team joins a group, not one player.' : 'That entry is not in this event.');
  }
  if (!active.has(entryId)) throw new ExpectedError('That entry has left the event.');
  await assertDrawFieldEventWaiverSigned(adminClient, event.tournament_id, [entryId], doubles);

  const plan = planLateEntrant(stage, results, active, entryId);
  if (!plan) throw new ExpectedError(`That entry is already in a group of "${stage.name}".`);
  const categories = new Map(entries.map((e) => [e.id, e.category]));
  const rows = buildLateEntrantRows(cfg, stageKey, plan, entryId, categories, loaded.generation, {
    firstSlot: loaded.firstSlot,
    firstMatchNumber: loaded.firstMatchNumber,
  });
  if (rows.length === 0) throw new ExpectedError('That group has nobody left in it to play.');

  const { courtsAssigned } = await insertStageExtension(adminClient, eventId, event.tournament_id, stage.name, rows, doubles);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'bracket_generated',
    performed_by: admin.id,
    details: {
      staged: true,
      stage: k,
      stage_key: stageKey,
      extension: 'late_entrant',
      entry_id: entryId,
      pool: plan.pool,
      group: plan.group,
      level: plan.level,
      matches: rows.length,
      courts_assigned: courtsAssigned,
      generation: loaded.generation,
    },
  });

  revalidateEventPaths(event.tournament_id, eventId);
  return { matches: rows.length };
}

/** Put an entry that arrived after the draw into a group of the first stage. */
export async function placeLateEntrant(eventId: string, stageKey: string, entryId: string): Promise<ActionResult<{ matches: number }>> {
  return runAction(() => placeLateEntrantImpl(eventId, stageKey, entryId));
}
