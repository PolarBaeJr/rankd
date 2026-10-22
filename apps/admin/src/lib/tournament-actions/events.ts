'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { runAction, type ActionResult } from '../action-result';
import { scheduleManagedFormSync } from '../managed-forms';
import {
  CUSTOM_FORMAT_BOUNDS,
  ExpectedError,
  isPoolToBracket,
  playsRoundRobin,
  statusStepsFor,
  currentPhase,
  endsInKnockout,
  SEED_SKIP_BOUNDS,
  ELO_MULTIPLIER_BOUNDS,
  anyStageRated,
  checkFormatConfig,
  parseFormatConfig,
  stagedConfigEditRefusal,
  withEveryStageUnrated,
  normalizePointsConfig,
  effectiveWindows,
  validateEffectiveWindows,
  windowColumnsFromWallClock,
  type WindowColumns,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentEventFormat,
  TournamentMatchFormat,
  TournamentSeedingMethod,
  TournamentEventStatus,
  SeedBy,
  FormatConfig,
} from '@badminton/shared';
import { isDoublesEvent } from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  assertTournamentNotSuspended,
  forfeitOutOfEventEntries,
  fillFromWaitlistAfterFree,
  settleWaitlistPromotions,
  isWaitlistMissing,
  type WaitlistFillResult,
} from './_internal';

// ============================================================
// Event Management
// ============================================================

// Typed match format (00046). The CHECK constraint is the real enforcement;
// this exists so a typo comes back as a sentence instead of a Postgres
// constraint name, and so a half-filled pair is caught here rather than
// silently meaning "custom points, preset games".
function normalizeTypedFormat(games?: number | null, points?: number | null): { games_per_match: number | null; points_per_game: number | null } {
  const g = games == null || Number.isNaN(games) ? null : Math.trunc(games);
  const p = points == null || Number.isNaN(points) ? null : Math.trunc(points);
  const { minGames, maxGames, minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;
  if (g !== null && (g < minGames || g > maxGames || g % 2 === 0)) {
    throw new ExpectedError(`Games per match must be an odd number between ${minGames} and ${maxGames} — an even best-of cannot be decided.`);
  }
  if (p !== null && (p < minPoints || p > maxPoints)) {
    throw new ExpectedError(`Points per game must be between ${minPoints} and ${maxPoints}.`);
  }
  return { games_per_match: g, points_per_game: p };
}

// The group shape (00106). The CHECK constraints are the real enforcement, same
// as the typed format above; this turns a violation into a sentence and pins
// the two rules the database cannot see:
//
//   * A KNOCKOUT HAS NO GROUPS. 00106 has a row-level CHECK for this, but
//     Postgres would report it as a constraint name — and the exec who hit it
//     picked "Single Elimination" three fields higher up.
//   * QUALIFIERS CANNOT EXCEED THE GROUP. Asking three out of a group of two is
//     not a format, and it is the kind of typo that only shows up as a bracket
//     with byes in it a week later. The group SIZE is not known yet at creation
//     time — nobody has entered — so this can only bound it against the ceiling
//     the schema allows, and the generator's own "fewer than 2 entries" refusal
//     catches the rest on the day.
function normalizeGroupShape(
  format: TournamentEventFormat | string | undefined,
  groupCount?: number | null,
  qualifiersPerGroup?: number | null,
): { group_count: number | null; qualifiers_per_group: number | null } {
  const g = groupCount == null || Number.isNaN(groupCount) ? null : Math.trunc(groupCount);
  const q = qualifiersPerGroup == null || Number.isNaN(qualifiersPerGroup) ? null : Math.trunc(qualifiersPerGroup);

  if (g !== null && (g < 1 || g > 32)) {
    throw new ExpectedError('Group count must be between 1 and 32. Leave it blank for an ordinary round robin.');
  }
  if (q !== null && (q < 1 || q > 16)) {
    throw new ExpectedError('Qualifiers per group must be between 1 and 16.');
  }
  if (g !== null && g > 1 && !playsRoundRobin(format)) {
    throw new ExpectedError('Only a round robin can be split into groups. A single-elimination event is one bracket.');
  }
  // Stored only when it means something, exactly as seed_by is: a
  // qualifiers-per-group left behind on a flat round robin is a stale choice
  // waiting to be read the day somebody sets a group count.
  //
  // A POOL-TO-BRACKET EVENT ALWAYS MEANS SOMETHING BY IT (00107), including
  // with no groups at all: its bracket phase is seeded out of its own pool, so
  // "how many qualify" has to be recorded whether the pool is flat or split.
  // A flat pool IS one group, so the same column says it — there is no second
  // column that could disagree, which is the whole reason not to add one.
  // The default differs because the question differs: 2 out of each of several
  // groups is the usual group stage, whereas 2 out of one flat pool is a final
  // and nothing else, so a flat pool defaults to a 4-strong knockout.
  if (isPoolToBracket(format)) {
    return { group_count: g, qualifiers_per_group: q ?? (g !== null && g > 1 ? 2 : 4) };
  }
  return { group_count: g, qualifiers_per_group: g !== null && g > 1 ? (q ?? 2) : null };
}

// How many top seeds must skip the first round (00124).
//
// THE FIELD-DEPENDENT CEILING IS NOT CHECKED HERE, DELIBERATELY, and it is the
// same call normalizeGroupShape makes two functions up. The real ceiling is
// maxFirstRoundByes(entrants) — a field of 20 sits in a 32-draw and can give 12
// seeds a bye, a field of 16 can give none at all — and at creation time nobody
// has entered, so bounding against the current headcount would refuse an exec
// who sets 4 with three people registered and sixty expected. The CHECK in
// 00124 bounds what can be STORED; generateSingleEliminationBracket refuses what
// the field cannot deliver, on the day, when the number is real.
//
// The round-robin refusal IS checked here, because it does not depend on the
// field: a round robin has no first round to skip. 00124 has a row-level CHECK
// for it, but Postgres would report a constraint name to an exec who picked the
// format several fields higher up.
function normalizeSeedSkip(
  format: TournamentEventFormat | string | undefined,
  seedSkipCount?: number | null,
): { seed_skip_count: number } {
  const n = seedSkipCount == null || Number.isNaN(seedSkipCount) ? 0 : Math.trunc(seedSkipCount);
  const { min, max } = SEED_SKIP_BOUNDS;
  if (n < min || n > max) {
    throw new ExpectedError(
      `The number of seeds that skip the first round must be between ${min} and ${max}. Leave it at 0 for an ordinary draw.`,
    );
  }
  if (n > 0 && !endsInKnockout(format)) {
    throw new ExpectedError(
      'A round robin has no first round to skip — everybody plays everybody. Only an event that ends in a bracket can give its top seeds a bye.',
    );
  }
  return { seed_skip_count: n };
}

// How hard this event moves ratings, relative to a rated challenge.
//
// THE COLUMN HAS NO CHECK CONSTRAINT, which is why this exists at all: the
// number reaches apply_tournament_match_rating through eventEloMultiplier()
// (`Number(raw) || 1.25`), and that coercion is deliberately faithful to the
// rating path rather than defensive. A negative therefore inverts the whole
// event, a 0 silently becomes 1.25, and a slipped decimal point multiplies
// every delta in the draw by a hundred. See ELO_MULTIPLIER_BOUNDS for the
// argument behind each end of the range.
//
// Rounded to the column's own scale rather than refused for having three
// decimals: DECIMAL(4,2) would round 1.259 to 1.26 on the way in, so refusing
// would be pedantry about a value the database is happy to store, but rounding
// HERE means the number the exec is told about is the number that lands.
function normalizeEloMultiplier(raw?: number | null): number | undefined {
  if (raw == null) return undefined;
  const { min, max } = ELO_MULTIPLIER_BOUNDS;
  if (!Number.isFinite(raw)) {
    throw new ExpectedError('The Elo multiplier has to be a number.');
  }
  if (raw === 0) {
    // Named separately from the range refusal because 0 is the one value an
    // exec reaches for ON PURPOSE, meaning something the field cannot express —
    // and the only one whose behaviour is the opposite of how it reads.
    throw new ExpectedError(
      'An Elo multiplier of 0 does not make an event unrated — the rating path reads 0 as "not set" and uses 1.25 instead. '
      + `Set it to ${min} if this event should barely count towards ratings.`,
    );
  }
  if (raw < 0) {
    // Also worth its own sentence: the range message below would read as a
    // formatting complaint, when what a negative actually does is hand every
    // loser in the draw rating and take it off every winner.
    throw new ExpectedError(
      'An Elo multiplier cannot be negative — it would reverse every rating change in the event, '
      + 'so winners would lose rating and losers would gain it.',
    );
  }
  if (raw < min || raw > max) {
    throw new ExpectedError(
      `The Elo multiplier must be between ${min} and ${max}. A rated challenge is 1.00 and the usual tournament is 1.25.`,
    );
  }
  return Math.round(raw * 100) / 100;
}

// A seeding link is only meaningful within one tournament, and the self-seed
// case would deadlock generation on standings it is supposed to produce.
async function assertSeedSourceUsable(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  eventId: string | null,
  sourceId: string,
) {
  if (eventId && sourceId === eventId) throw new ExpectedError('An event cannot seed from itself.');
  const { data: source } = await adminClient.from('tournament_events')
    .select('id, tournament_id, seeded_from_event_id')
    .eq('id', sourceId)
    .maybeSingle();
  if (!source) throw new ExpectedError('That pool event does not exist.');
  if (source.tournament_id !== tournamentId) throw new ExpectedError('A pool must belong to the same tournament.');
  // One hop is all the model supports; a source that itself seeds from
  // somewhere could be pointed back at this event and make a cycle.
  if (eventId && source.seeded_from_event_id === eventId) {
    throw new ExpectedError('Those two events would seed from each other.');
  }
}

// A staged event's stages (00272), checked with the same schema the form
// checks with, and every refusal said in words. An external event never moves
// ratings, so its stages are stored unrated whatever the form sent.
function normalizeFormatConfig(raw: unknown, external: boolean): FormatConfig {
  const checked = checkFormatConfig(raw);
  if (!checked.ok) {
    throw new ExpectedError(`The stages are not set out correctly. ${checked.errors.join(' ')}`);
  }
  return external ? withEveryStageUnrated(checked.config) : checked.config;
}

const STAGED_MIGRATION_MISSING = 'Run migration 00272 first';
const POINTS_MIGRATION_MISSING = 'Run migration 00275 first';

// A column this code writes that the database does not have yet.
function isColumnMissing(error: { code?: string; message?: string } | null): boolean {
  return !!error && ['42703', 'PGRST204'].includes(error.code ?? '');
}

// ...or, for a staged event, the format CHECK from before 'staged' existed.
function isStagedSchemaMissing(error: { code?: string; message?: string } | null): boolean {
  return isColumnMissing(error)
    || (!!error && error.code === '23514' && /format_check/.test(error.message ?? ''));
}

// A legacy event's points table (00275), checked and stored only when it
// differs from the format's default. A staged event keeps its table in its
// stages, so one sent here is refused rather than dropped.
function normalizeEventPoints(format: string, raw: unknown) {
  if (format === 'staged') {
    if (raw != null) throw new ExpectedError('Set points in the stages editor.');
    return null;
  }
  const res = normalizePointsConfig(format, raw);
  if (!res.ok) throw new ExpectedError(res.error);
  return res.table;
}

async function createTournamentEventImpl(
  tournamentId: string,
  config: {
    event_type: TournamentEventType;
    format: TournamentEventFormat;
    match_format?: TournamentMatchFormat;
    games_per_match?: number | null;
    points_per_game?: number | null;
    seeded_from_event_id?: string | null;
    seed_by?: SeedBy | null;
    group_count?: number | null;
    qualifiers_per_group?: number | null;
    seed_skip_count?: number | null;
    max_participants?: number;
    seeding_method?: TournamentSeedingMethod;
    elo_multiplier?: number;
    placement_bonus_enabled?: boolean;
    external_event?: boolean;
    /** Required for, and only for, a staged event. */
    format_config?: unknown;
    /** A legacy event's points table (00275). Absent or the default stores nothing. */
    points_config?: unknown;
  }
) {
  const admin = await requireCapability('tournaments.manage.event.create.write');
  const adminClient = createAdminClient();

  const typedFormat = normalizeTypedFormat(config.games_per_match, config.points_per_game);
  const groupShape = normalizeGroupShape(config.format, config.group_count, config.qualifiers_per_group);
  const seedSkip = normalizeSeedSkip(config.format, config.seed_skip_count);
  const eloMultiplier = normalizeEloMultiplier(config.elo_multiplier);
  // A pool_to_bracket event seeds from ITSELF — that is the format — so an
  // external source would be a second, contradictory field for the same
  // bracket. Refused rather than ignored: silently dropping a link the exec set
  // is how an event ends up drawn from a pool nobody expected.
  if (config.seeded_from_event_id && isPoolToBracket(config.format)) {
    throw new ExpectedError(
      'A Round Robin + Knockout event already plays its own pool, so it cannot also be seeded from another one. '
      + 'Use Single Elimination if the field is meant to come from a separate pool event.',
    );
  }
  if (config.seeded_from_event_id) {
    await assertSeedSourceUsable(adminClient, tournamentId, null, config.seeded_from_event_id);
  }
  // EXTERNAL TEAMS (00269): a round robin of doubles, unrated, with no placement
  // bonus and no pool link. The CHECK in 00269 says the same; this says it first.
  //
  // A staged event (00272) may be external too: its stages are stored unrated.
  const external = config.external_event === true;
  if (external && ((config.format !== 'round_robin' && config.format !== 'staged') || !isDoublesEvent(config.event_type) || config.seeded_from_event_id)) {
    throw new ExpectedError('An external event must be a doubles Round Robin or Stages event, not seeded from another event.');
  }
  const staged = config.format === 'staged';
  if (!staged && config.format_config != null) {
    throw new ExpectedError('Only an event played in stages has stage settings.');
  }
  if (staged && config.seeded_from_event_id) {
    throw new ExpectedError('An event played in stages draws its own field, so it cannot be seeded from another event.');
  }
  const formatConfig = staged ? normalizeFormatConfig(config.format_config, external) : null;
  const pointsConfig = normalizeEventPoints(config.format, config.points_config);
  // A placement bonus is paid into ratings, so an event none of whose stages
  // is rated pays none.
  const bonusAllowed = !external && (!formatConfig || anyStageRated(formatConfig));

  const { data, error } = await adminClient.from('tournament_events').insert({
    tournament_id: tournamentId,
    event_type: config.event_type,
    format: config.format,
    match_format: config.match_format ?? 'best_of_3_to_21',
    ...typedFormat,
    seeded_from_event_id: config.seeded_from_event_id ?? null,
    // seed_by is only read when a source is set; storing it without one would
    // leave a stale choice behind if a source is added later.
    //
    // A POOL-TO-BRACKET EVENT SETS IT AT CREATION (00107), because that format
    // reads it against its OWN pool: brackets.ts picks the qualifiers by it and
    // finalize.ts ranks the non-qualifiers by it, so the column has to exist.
    //
    // WHAT THE "seed_by TRAP" ACTUALLY IS, since it was recorded for a long time
    // in a stronger form than the code supports. The worry was that
    // assignPositionsAndPoints ranks a round robin with no seedBy — defaulting
    // to 'wins' — while a bracket is seeded by seed_by, so final_position (which
    // drives the placement-bonus ledger) could come from a different order than
    // the draw. Within ONE event that was real, and it is closed: both readers
    // take this column.
    //
    // ACROSS TWO EVENTS IT IS NOT A CONFLICT AND CANNOT BE MADE ONE. seed_by
    // belongs to the event being DRAWN, not to the pool being read: N brackets
    // may seed off one pool, each with its own value, and the pool's positions
    // exist before any of them is created. There is no function from the pool's
    // row to a single ranking criterion, so its final_position cannot be derived
    // from seed_by at all — 'wins' is the only well-defined answer, and that is
    // why the round-robin path in finalize.ts is left alone rather than "fixed".
    seed_by: (config.seeded_from_event_id || isPoolToBracket(config.format))
      ? (config.seed_by ?? 'wins')
      : null,
    ...groupShape,
    ...seedSkip,
    max_participants: config.max_participants ?? null,
    seeding_method: config.seeding_method ?? 'elo',
    elo_multiplier: eloMultiplier ?? 1.25,
    placement_bonus_enabled: bonusAllowed ? (config.placement_bonus_enabled ?? true) : false,
    external_event: external,
    // Only named on a staged event, so a database without 00272 still takes
    // every other format.
    ...(formatConfig ? { format_config: formatConfig as never, rated: !external } : {}),
    // Likewise only named when it differs from the default (00275).
    ...(pointsConfig ? { points_config: pointsConfig as never } : {}),
  }).select().single();

  if (error) {
    if (staged && isStagedSchemaMissing(error)) throw new ExpectedError(STAGED_MIGRATION_MISSING);
    if (pointsConfig && isColumnMissing(error)) throw new ExpectedError(POINTS_MIGRATION_MISSING);
    if (error.code === '23514') throw new ExpectedError(error.message);
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: data.id,
    action: 'event_created',
    performed_by: admin.id,
    details: config as Record<string, unknown>,
  });

  revalidatePath(`/tournaments/${tournamentId}`);
  // A new event is a new choice on the tournament's made Form (00296).
  scheduleManagedFormSync('tournament', tournamentId);
  return data;
}

async function updateTournamentEventImpl(
  eventId: string,
  updates: {
    match_format?: TournamentMatchFormat;
    games_per_match?: number | null;
    points_per_game?: number | null;
    seeded_from_event_id?: string | null;
    seed_by?: SeedBy | null;
    group_count?: number | null;
    qualifiers_per_group?: number | null;
    seed_skip_count?: number | null;
    max_participants?: number | null;
    seeding_method?: TournamentSeedingMethod;
    elo_multiplier?: number;
    placement_bonus_enabled?: boolean;
    /** A staged event's stages. Sent on its own once a stage is drawn. */
    format_config?: unknown;
    /** A legacy event's points table (00275). Sent on its own once the event is drawn. */
    points_config?: unknown;
  }
) {
  const admin = await requireCapability('tournaments.manage.event.update.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  /**
   * THE SEEDING METHOD IS NOT A FORMAT, and gating it like one made the draw's
   * only opt-out unreachable at the exact moment an exec wants it.
   *
   * Since the draw is made at random within the seeding tiers, `manual` is what
   * an exec picks when they have hand-set every seed and want the bracket those
   * numbers describe, redraw after redraw. They discover they want it by
   * pressing Regenerate and seeing a draw move — which is to say, AFTER a draw
   * exists, at which point both gates below refuse and the remedy on offer
   * ("void the matches first") is the very thing they were trying to avoid
   * doing twice.
   *
   * It is safe to let through because it changes nothing about the matches that
   * exist: unlike the match format or the pool it seeds from, it is read once,
   * by the NEXT generation, and generation has its own guards (a finalised
   * event refuses, an event with results refuses). Only on its own, though —
   * bundled with a format change it would carry that change past the gate.
   */
  const seedingMethodOnly = Object.keys(updates).length === 1 && 'seeding_method' in updates;
  // A STAGED EVENT'S STAGES ARE THE OTHER CARVE-OUT (00272). Its later stages
  // are drawn while the event is live, so the stages not yet drawn stay
  // editable after the first is; stagedConfigEditRefusal below keeps every
  // drawn stage, and the categories and head starts, exactly as they were.
  // Only on its own, for the seeding method's reason.
  const stagedConfigOnly = event.format === 'staged'
    && Object.keys(updates).length === 1 && 'format_config' in updates;
  // THE POINTS TABLE IS THE THIRD (00275). It is read once, when the event is
  // finalised, and nothing about the draw or a result depends on it, so it
  // stays editable until then. Refused on a staged event before this can let
  // it through: that table lives in the stages.
  if ('points_config' in updates && event.format === 'staged' && updates.points_config != null) {
    throw new ExpectedError('Set points in the stages editor.');
  }
  const pointsOnly = Object.keys(updates).length === 1 && 'points_config' in updates;

  // The old gate was status === 'registration', which locked the match format
  // the moment check-in opened — the exact point at which an exec discovers the
  // day is running late and wants to shorten the games. What actually must not
  // change is a format the draw has already been played under, so the gate is
  // now the existence of matches: no bracket, still editable.
  if (stagedConfigOnly) {
    if (event.status === 'completed') {
      throw new ExpectedError('This event has been finalised, so its stages can no longer be changed.');
    }
  } else if (pointsOnly) {
    if (event.status === 'completed') {
      throw new ExpectedError('This event has been finalised, so its points can no longer be changed.');
    }
  } else if (!seedingMethodOnly) {
    const { count: matchCount } = await adminClient.from('tournament_matches')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId);
    if ((matchCount ?? 0) > 0) {
      throw new ExpectedError('This event already has a draw. Regenerate it after voiding the matches if the format really has to change.');
    }
    if (event.status !== 'registration' && event.status !== 'checkin') {
      throw new ExpectedError('Can only update events before the draw is made');
    }
  } else if (event.status === 'completed') {
    // A finalised event's draw can never be rebuilt (assertNotFinalised), so
    // changing how the next one would be made is a setting with no next one.
    throw new ExpectedError('This event has been finalised, so how its draw is made can no longer be changed.');
  }

  const patch: Record<string, unknown> = { ...updates };
  // Set at creation only (00269); the trigger refuses a flip once anybody is in.
  delete patch.external_event;
  // The waitlist has its own action, which takes the field lock (00278).
  delete patch.waitlist_enabled;
  delete patch.waitlist_auto_promote;

  if ('format_config' in updates) {
    if (event.format !== 'staged') throw new ExpectedError('Only an event played in stages has stage settings.');
    const cfg = normalizeFormatConfig(updates.format_config, event.external_event === true);
    const { data: drawnRows, error: drawnError } = await adminClient.from('tournament_matches')
      .select('stage')
      .eq('event_id', eventId)
      .not('stage', 'is', null);
    if (isStagedSchemaMissing(drawnError)) throw new ExpectedError(STAGED_MIGRATION_MISSING);
    if (drawnError) throw new Error(`Could not read which stages are drawn: ${drawnError.message}`);
    const drawn = new Set((drawnRows ?? []).map((r) => r.stage as number));
    const refusal = stagedConfigEditRefusal(parseFormatConfig(event.format_config), cfg, drawn);
    if (refusal) throw new ExpectedError(refusal);
    patch.format_config = cfg;
    if (!anyStageRated(cfg)) patch.placement_bonus_enabled = false;
  }

  if ('points_config' in updates) {
    const table = normalizeEventPoints(event.format as string, updates.points_config);
    // select('*') names every column the database has, so a row without the
    // key is a database without 00275. Back to the default there is nothing to
    // write; anything else cannot be stored yet.
    const hasColumn = 'points_config' in event;
    if (table && !hasColumn) throw new ExpectedError(POINTS_MIGRATION_MISSING);
    if (hasColumn) patch.points_config = table;
    else delete patch.points_config;
  }

  if ('games_per_match' in updates || 'points_per_game' in updates) {
    Object.assign(patch, normalizeTypedFormat(updates.games_per_match, updates.points_per_game));
  }

  // NO seeding_method-style carve-out for the group shape, deliberately. That
  // exemption exists because the seeding method is read once, by the next
  // generation, and changes nothing about the matches that already exist. The
  // group count is the opposite: the fixtures ARE the groups, so lowering it
  // would leave people playing a group the event says does not exist and the
  // standings partitioning differently from the schedule. The unmodified gate
  // above — no draw, still editable — is the right one, and its remedy
  // (regenerate the round robin) is the honest one here.
  if ('group_count' in updates || 'qualifiers_per_group' in updates) {
    Object.assign(patch, normalizeGroupShape(
      event.format as TournamentEventFormat,
      'group_count' in updates ? updates.group_count : (event as { group_count?: number | null }).group_count,
      'qualifiers_per_group' in updates ? updates.qualifiers_per_group : (event as { qualifiers_per_group?: number | null }).qualifiers_per_group,
    ));
  }

  // NO seeding_method-style carve-out here either, and for the group shape's
  // reason rather than the seeding method's. The seeding method is exempt
  // because it is read once, by the NEXT generation, and changes nothing about
  // matches that already exist. This number is read by the next generation too
  // — but the only draw it could describe is one that already exists, and that
  // draw's byes are already dealt. Letting it through would record a promise
  // about a bracket nobody can rebuild, which is a setting that reads as broken
  // rather than one that does nothing. The unmodified gate above (no draw, still
  // editable) refuses it with a sentence naming the reason.
  //
  // The FORMAT is the event's own, not the patch's: format is not updatable, so
  // there is no version of this call in which the two could differ.
  if ('seed_skip_count' in updates) {
    Object.assign(patch, normalizeSeedSkip(event.format as TournamentEventFormat, updates.seed_skip_count));
  }

  /**
   * THE ELO MULTIPLIER, AND WHY IT GETS NO seeding_method-STYLE CARVE-OUT.
   *
   * The number was reachable only at creation until now — createTournamentEvent
   * took it, this function took it, and no form on either dialog sent it — so an
   * event set up at the wrong weight stayed at the wrong weight for its whole
   * life. Event Settings now sends it, which is the whole of the fix.
   *
   * It is tempting to exempt it from the "no draw, still editable" gate above,
   * because unlike the match format it is not baked into the draw: it is read
   * once per RESULT, by applyTournamentMatchElo, off the event row as it stands
   * at that moment. An event that has been drawn but not played would take a new
   * value perfectly consistently.
   *
   * IT IS NOT EXEMPTED, because the same property is what makes it dangerous one
   * match later. Change it after round one has been rated and the event's early
   * rounds were rated at the old weight while its later ones take the new — and
   * nothing anywhere records which was which. `elo_snapshot` stores
   * `{discipline, entries[{before, after, delta, won, …}]}` and NOT the
   * multiplier that produced the delta, so the split is unreconstructible after
   * the fact. Meanwhile the console now PRINTS the weight per round (the bracket
   * tab's "Played to" strip and this dialog's ladder, both via
   * eloWeightBreakdown), and both read the event's current value — so every
   * already-rated round would start displaying a figure that was never applied
   * to it. That is the "silently restate history" case, and the honest options
   * are to refuse it or to record what each match was rated under. Recording it
   * needs a column, and this branch is not taking a migration.
   *
   * So the unmodified gate — no matches, still editable — is the right one here
   * too, and it is STRICTLY SAFER than "no rated matches": it refuses at the
   * draw rather than at the first result, with a sentence that names the reason.
   * Once a column exists to stamp the applied multiplier on each match, this is
   * the comment to revisit.
   */
  if ('elo_multiplier' in updates) {
    const eloMultiplier = normalizeEloMultiplier(updates.elo_multiplier);
    if (eloMultiplier === undefined) {
      // Sent as null/absent by a caller that has the key but no value. Dropped
      // rather than written, so a blank box cannot reset a configured weight to
      // the default behind the exec's back.
      delete patch.elo_multiplier;
    } else {
      patch.elo_multiplier = eloMultiplier;
    }
  }

  if ('seeded_from_event_id' in updates) {
    const sourceId = updates.seeded_from_event_id;
    if (sourceId) {
      await assertSeedSourceUsable(adminClient, event.tournament_id, eventId, sourceId);
      patch.seed_by = updates.seed_by ?? 'wins';
    } else {
      // A POOL_TO_BRACKET EVENT COMES THROUGH HERE, and it is the reason this
      // branch is no longer a flat `seed_by = null`.
      //
      // The settings dialog blanks the pool picker on any round-robin format —
      // that format has no EXTERNAL pool, and createTournamentEvent refuses the
      // combination outright — so it always sends seeded_from_event_id: null.
      // Nulling seed_by alongside it was previously described as harmless, on
      // the grounds that 00046 defines NULL as 'wins' and every reader
      // coalesces. That reasoning holds only while 'wins' is the ONLY value an
      // exec can choose. It no longer is: the form can now express 'points' on
      // this format, and a save that quietly rewrote it to NULL would send the
      // exec back to 'wins' with a success toast on screen — the choice would
      // appear to be taken and then not be.
      //
      // So the link is cleared and the criterion is KEPT, which is exactly what
      // createTournamentEvent does for the same format (`seeded_from_event_id ||
      // isPoolToBracket(format)`). The two writers now agree about when this
      // column means something. Still coalesced to 'wins' rather than left
      // undefined, so a caller that omits seed_by cannot blank a stored choice.
      patch.seeded_from_event_id = null;
      patch.seed_by = isPoolToBracket(event.format as string)
        ? (updates.seed_by ?? 'wins')
        // Every other format reaching this branch genuinely has no pool to rank:
        // a plain round robin PRODUCES standings (finalize.ts ranks it by wins,
        // because N brackets may seed off it with different criteria), and an
        // unlinked knockout seeds by Elo or by hand. A stale criterion left
        // behind would be read as a choice nobody made if a link were added
        // later.
        : null;
    }
  }

  const { error } = await adminClient.from('tournament_events')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    if ('format_config' in updates && isStagedSchemaMissing(error)) throw new ExpectedError(STAGED_MIGRATION_MISSING);
    if ('points_config' in patch && isColumnMissing(error)) throw new ExpectedError(POINTS_MIGRATION_MISSING);
    // 23514: e.g. the placement bonus switched on for an external event (00269).
    if (error.code === '23514') throw new ExpectedError(error.message);
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'event_updated',
    performed_by: admin.id,
    details: patch,
  });

  // A raised or cleared limit may have room for the waitlist (00278). Never throws.
  if ('max_participants' in patch) await fillFromWaitlistAfterFree(adminClient, eventId, admin.id);

  revalidateEventPaths(event.tournament_id, eventId);
  if ('max_participants' in patch) scheduleManagedFormSync('tournament', event.tournament_id);
}

// Public entry points. The format validation these two now carry is only
// useful if the exec can read it, and Next.js replaces anything thrown out of a
// Server Action in production with a generic message — so the refusal comes
// back as a value, and runAction keeps it out of Sentry.
export async function createTournamentEvent(
  tournamentId: string,
  config: Parameters<typeof createTournamentEventImpl>[1],
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const created = await createTournamentEventImpl(tournamentId, config);
    return { id: created.id as string };
  });
}

export async function updateTournamentEvent(
  eventId: string,
  updates: Parameters<typeof updateTournamentEventImpl>[1],
): Promise<ActionResult<void>> {
  return runAction(async () => { await updateTournamentEventImpl(eventId, updates); });
}

const WINDOWS_MIGRATION_MISSING = 'Run migration 00276 first';

/**
 * An event's own registration and check-in windows (00276), as club wall-clock
 * strings from the form. Blank clears a bound, so the tournament's applies.
 * These gate only the member's own entry and check-in: an exec still opens
 * and closes the statuses by hand, and still adds and checks people in.
 */
async function setEventWindowsImpl(
  eventId: string,
  windows: Partial<Record<keyof WindowColumns, string | null>>,
) {
  const admin = await requireCapability('tournaments.manage.event.update.write');
  const adminClient = createAdminClient();
  const patch = windowColumnsFromWallClock(windows);

  const { data: event, error: eventError } = await adminClient
    .from('tournament_events').select('*').eq('id', eventId).single();
  if (eventError || !event) throw new Error(eventError?.message ?? 'Event not found');
  if (!('registration_opens_at' in event)) throw new ExpectedError(WINDOWS_MIGRATION_MISSING);
  if (event.status === 'completed') throw new ExpectedError('This event is finished, so its windows are fixed.');

  const { data: tournament, error: tournamentError } = await adminClient
    .from('tournaments').select('*').eq('id', event.tournament_id).single();
  if (tournamentError || !tournament) throw new Error(tournamentError?.message ?? 'Tournament not found');

  const refusal = validateEffectiveWindows(effectiveWindows({ event: { ...event, ...patch }, tournament }));
  if (refusal) throw new ExpectedError(refusal);

  const { error } = await adminClient
    .from('tournament_events')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', eventId);
  if (error) {
    if (isColumnMissing(error)) throw new ExpectedError(WINDOWS_MIGRATION_MISSING);
    if (error.code === '23514') throw new ExpectedError(error.message);
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'event_windows_updated',
    performed_by: admin.id,
    details: { ...patch },
  });

  revalidateEventPaths(event.tournament_id, eventId);
  scheduleManagedFormSync('tournament', event.tournament_id);
}

export async function setEventWindows(
  eventId: string,
  windows: Parameters<typeof setEventWindowsImpl>[1],
): Promise<ActionResult<void>> {
  return runAction(async () => { await setEventWindowsImpl(eventId, windows); });
}

const WAITLIST_MIGRATION_MISSING = 'Run migration 00278 first';

/**
 * Switch an event's waitlist on or off, and choose whether a freed place goes
 * to the head of the queue automatically (00278). Switching to automatic with
 * people already waiting hands out any free place straight away.
 */
async function setEventWaitlistImpl(
  eventId: string,
  settings: { enabled: boolean; autoPromote: boolean },
): Promise<{ promoted: number }> {
  const admin = await requireCapability('tournaments.manage.event.update.write');
  const adminClient = createAdminClient();

  const { data: event, error: eventError } = await adminClient
    .from('tournament_events').select('*').eq('id', eventId).single();
  if (eventError || !event) throw new Error(eventError?.message ?? 'Event not found');
  if (!('waitlist_enabled' in event)) throw new ExpectedError(WAITLIST_MIGRATION_MISSING);
  if (event.external_event === true) {
    throw new ExpectedError('An external event has no waitlist: its teams are entered by name.');
  }
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new ExpectedError('The waitlist can only be changed while the event is taking entries or checking in.');
  }

  const { data, error } = await adminClient.rpc('set_event_waitlist', {
    p_event_id: eventId,
    p_enabled: settings.enabled,
    p_auto: settings.autoPromote,
    p_actor: admin.id,
  });
  if (error) {
    if (isWaitlistMissing(error)) throw new ExpectedError(WAITLIST_MIGRATION_MISSING);
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as WaitlistFillResult | null;
  if (!result?.ok) {
    switch (result?.reason) {
      case 'waitlist_not_empty':
        throw new ExpectedError('People are still waiting. Promote or remove them before switching the waitlist off.');
      case 'external_event':
        throw new ExpectedError('An external event has no waitlist: its teams are entered by name.');
      case 'event_status':
        throw new ExpectedError('The waitlist can only be changed while the event is taking entries or checking in.');
      default:
        throw new ExpectedError('The waitlist could not be changed. Reload the page and try again.');
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'event_waitlist_updated',
    performed_by: admin.id,
    details: { enabled: settings.enabled, auto_promote: settings.autoPromote },
  });
  const promoted = await settleWaitlistPromotions(adminClient, result, admin.id, true);

  revalidateEventPaths(event.tournament_id, eventId);
  return { promoted };
}

export async function setEventWaitlist(
  eventId: string,
  settings: Parameters<typeof setEventWaitlistImpl>[1],
): Promise<ActionResult<{ promoted: number }>> {
  return runAction(() => setEventWaitlistImpl(eventId, settings));
}

export async function deleteTournamentEvent(eventId: string) {
  const admin = await requireCapability('tournaments.manage.event.delete.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration') throw new ExpectedError('Can only delete events in registration status');

  const { error } = await adminClient.from('tournament_events').delete().eq('id', eventId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    action: 'event_deleted',
    performed_by: admin.id,
    details: { event_type: event.event_type },
  });

  revalidatePath(`/tournaments/${event.tournament_id}`);
  scheduleManagedFormSync('tournament', event.tournament_id);
}

// EVERY REFUSAL IN HERE IS A SENTENCE THE EXEC HAS TO READ, so this is an Impl
// and the exported action below returns them as values. Next.js replaces
// anything THROWN out of a Server Action in production with a generic message,
// and EventHeader's `catch` renders `err.message` straight into a toast — so on
// the deployed console "Cannot go live — no bracket has been generated for this
// event" arrived as the generic string, and the one press the whole page exists
// for failed with nothing to act on. 599b8a0 / 057f5b3 / 20e8bea did this for
// the actions next door; these two were missed because they are called from a
// component that already checks `res.ok` for the generator calls beside them.
async function setEventStatusImpl(eventId: string, status: TournamentEventStatus) {
  const admin = await requireCapability('tournaments.manage.event.status.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // Validate status transitions.
  //
  // DERIVED FROM statusStepsFor RATHER THAN WRITTEN OUT (00107), so the stepper
  // the exec looks at and the transitions the server allows are the same list.
  // A pool_to_bracket event has two more steps in the middle; every other
  // format's path is character for character what it was.
  //
  // Still forward-only and still one step at a time — that property is what
  // stops a redraw sending a running event backwards, and it now also stops a
  // pool being skipped: `checkin -> live` is not a transition on this format.
  const steps = statusStepsFor(event.format as string);
  const here = steps.indexOf(event.status as TournamentEventStatus);
  if (here < 0 || steps[here + 1] !== status) {
    throw new ExpectedError(`This event cannot go from ${event.status} to ${status} — reload to see where it is.`);
  }

  // Guard: do not start a phase that has no matches.
  //
  // COUNTED WITHIN THE PHASE (00107). A pool_to_bracket event reaching `live`
  // already has a pool's worth of completed matches sitting in the same table,
  // so an unfiltered count would say "a draw exists" for a knockout that was
  // never generated, and the event would go live with nothing to play. The two
  // other formats have one phase and their matches carry phase NULL, so the
  // filter below is a no-op for them.
  const startingPhase = currentPhase(event.format as string, status);
  // `bracket_generated` is on this list for a pool_to_bracket event only, and
  // for a reason the other two formats never have: on them that status is
  // written by the generator itself and is unreachable any other way, whereas
  // here it is also the step AFTER `pool_live`, so calling this action directly
  // could mark an event "bracket generated" with no bracket. The `live` guard
  // would eventually catch it, but an event should not be able to sit in a
  // state that is a lie about its own rows in the meantime.
  const startsAPhase = status === 'live' || status === 'pool_live'
    || (status === 'bracket_generated' && isPoolToBracket(event.format as string));
  if (startsAPhase) {
    let q = adminClient.from('tournament_matches')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId);
    if (startingPhase) q = q.eq('phase', startingPhase);
    const { count: matchCount } = await q;
    if (!matchCount || matchCount === 0) {
      throw new ExpectedError(
        startingPhase === 'pool'
          ? 'Cannot start the pool — no fixtures have been generated for it'
          : 'Cannot go live — no bracket has been generated for this event',
      );
    }
  }

  // CONDITIONAL ON THE STATUS THIS REQUEST READ, modelled on the finalise flip
  // in finalize.ts (the `.eq('status', 'live')` + count block) for the same
  // reason it has one. The transition check above read the row and the write
  // below did not name it, so two Go-Live clicks — one exec double-tapping, or
  // two desks on the same event — both passed `checkin -> live`, both wrote
  // `live`, and both then ran the forfeit sweep and logged
  // `status_changed_to_live`. The audit trail says the event started twice.
  //
  // The comment further down explains why a sweep at pool_live and again at
  // live is safe; it says nothing about the SAME step running twice, which is
  // what this closes. The count has to be checked BEFORE the sweep, because the
  // sweep is the expensive, rating-adjacent half.
  const { error, count } = await adminClient.from('tournament_events')
    .update({ status, updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('id', eventId)
    .eq('status', event.status);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (count === 0) {
    throw new ExpectedError(
      'This event has already moved on — another desk changed it while you were changing it. Reload to see where it is.',
    );
  }

  // Anyone who withdrew while the draw was merely published is still sitting in
  // the bracket — bracket generation only ever saw a point-in-time snapshot of
  // who was in. Going live is the first moment their matches can be forfeited
  // properly (a walkover is rated, and rating anything before the event starts
  // is exactly what the result actions refuse to do), so settle them here
  // rather than let a live event open with matches nobody can play.
  //
  // RUN AT BOTH pool_live AND live ON A POOL-TO-BRACKET EVENT, and that is not
  // a double forfeit. forfeitOpenMatchesForEntry only touches matches that are
  // still OPEN, so by the time the knockout starts every pool match it already
  // settled is completed or walked over and is skipped. What the second run
  // catches is the people who left BETWEEN the pool ending and the knockout
  // starting — they are in the bracket (the field is fixed when it is drawn)
  // and nothing else would ever forfeit them out of it.
  let sweep = { forfeited: 0, unresolved: 0 };
  if (status === 'live' || status === 'pool_live') {
    sweep = await forfeitOutOfEventEntries(
      adminClient,
      eventId,
      isDoublesEvent(event.event_type),
      admin.id,
    );
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: `status_changed_to_${status}`,
    performed_by: admin.id,
    details: sweep.forfeited > 0 || sweep.unresolved > 0 ? sweep : undefined,
  });

  revalidateEventPaths(event.tournament_id, eventId);
  scheduleManagedFormSync('tournament', event.tournament_id);
}

export async function setEventStatus(
  eventId: string,
  status: TournamentEventStatus,
): Promise<ActionResult<void>> {
  return runAction(async () => { await setEventStatusImpl(eventId, status); });
}
