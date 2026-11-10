'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import {
  isDoublesEvent,
  placementBonusFor,
  ExpectedError,
  endsInKnockout,
  isPoolToBracket,
  phaseValueFor,
  isRealIncompleteMatch,
  isOutOfEvent,
  anyStageRated,
  finalPlacings,
  formatResultsFrom,
  isTalliedStatus,
  matchSides,
  parseFormatConfig,
  pointsFor,
  parsePointsTable,
  defaultPointsTable,
  pointsForPlace,
  applyTournamentBonusOverride,
} from '@badminton/shared';
import type { SeedBy } from '@badminton/shared';
import { getTournamentBonusSettings, type TournamentBonusSettings } from '../platform-settings';
import { closesWithFinalEvent } from '../tournament-close';
import { releaseFlagOn } from '../release-flags';
import {
  requireCapability,
  revalidateEventPaths,
  notifyPlayers,
  computeRoundRobinStandings,
  assertTournamentNotSuspended,
  settleWrites,
  assertWritesSucceeded,
  fencedRefusal,
  type LabelledWrite,
  type FencedFieldResult,
} from './_internal';

// ============================================================
// Placement Bonuses & Finalize
// ============================================================

// The audit action for a bonus run. It USED to double as the ledger, and no
// longer does — `tournament_bonus_grants` is the ledger, written inside each
// payment's own transaction. This row is now what it always looked like: a
// record for a human reading the history, written best-effort afterwards.
const BONUS_APPLIED_ACTION = 'placement_bonuses_applied';

interface BonusLedger {
  /** player_ids whose rating has already had its bonus added. */
  ratedPlayers: Set<string>;
  /** tournament_participants ids whose elo_change has already been credited. */
  creditedParticipants: Set<string>;
  /**
   * This event carries a legacy marker: it was paid by a version that kept no
   * per-player record, so WHO was paid is unknowable but THAT it was paid is
   * not. Separate from the two sets because it answers a different question,
   * and the two callers want opposite things from it.
   */
  legacyPaid: boolean;
}

/**
 * What a previous bonus run actually managed to write for this event.
 *
 * applyPlacementBonuses reads a rating and writes `current + bonus`, which is
 * not idempotent: run it twice and everyone is awarded twice. That was
 * unreachable only because finalizeEvent could never run a second time — and
 * "unrepairable" is not the same as "safe". Now that a partial failure is
 * raised rather than swallowed, a retry has to be able to finish the job
 * without redoing the part that landed.
 *
 * READ FROM THE GRANTS, NOT FROM THE AUDIT LOG. It used to select
 * `tournament_audit_log.details`, which was the right call before `00188`
 * existed and the wrong one after: the audit row is written AFTER the bonus
 * RPCs commit, and it is best-effort, so the window between the payment
 * landing and the log row appearing reported an empty ledger for a payment
 * that had already happened. `tournament_bonus_grants` is written INSIDE the
 * same transaction as each payment — claim-before-pay — so it cannot lag
 * behind what was actually paid, and its UNIQUE (event_id, kind, subject_id)
 * is the guarantee this read was only ever a hint about.
 *
 * The audit log also carries NULL `details` on every row written before
 * `00188`, which is why `00189`/`00190`/`00191` had to mark those events
 * separately — this read could not see them at all.
 *
 * Singles has TWO non-idempotent writes per player — ratings.singles_elo and
 * tournament_participants.elo_change — and they can fail independently, so the
 * ledger tracks them separately.
 */
async function readBonusLedger(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
): Promise<BonusLedger> {
  const { data, error } = await adminClient.from('tournament_bonus_grants')
    .select('kind, subject_id')
    .eq('event_id', eventId);
  // Without the ledger there is no way to tell a first run from a second, and
  // guessing wrong doubles every bonus on the event. Refuse.
  if (error) {
    throw new Error(
      `Could not read the placement-bonus history for this event (${error.message}). ` +
      `Refusing to apply bonuses — a repeat application would double every rating.`
    );
  }

  // THREE KINDS, AND `kind` IS THE ONLY DISCRIMINATOR. `discipline` does not
  // separate them (it is NULL for participant credits as well as for
  // markers), and neither does `applied_delta` (a rating grant clamped at the
  // ceiling legitimately applies 0 — 00189:49-53). A marker addresses its own
  // event, `subject_id = event_id`, which both marker migrations assert as a
  // failure condition; that invariant is what makes the third branch safe to
  // read as "this event", not "this subject".
  const ledger: BonusLedger = { ratedPlayers: new Set(), creditedParticipants: new Set(), legacyPaid: false };
  for (const row of data ?? []) {
    const subject = row.subject_id as string | null;
    if (typeof subject !== 'string') continue;
    if (row.kind === 'rating') ledger.ratedPlayers.add(subject);
    else if (row.kind === 'participant_credit') ledger.creditedParticipants.add(subject);
    else if (row.kind === 'event_legacy_paid') ledger.legacyPaid = true;
  }
  return ledger;
}

// NO OVERRIDE PARAMETER, DELIBERATELY. This module is 'use server', so every
// exported function is a Server Action and every parameter is an input the
// client supplies. An `opts: { allowLegacyRepay?: boolean }` here was not a
// test-only escape hatch however carefully the UI avoided it — it was a POST
// body field that any holder of tournaments.results.bonuses.write could set to
// walk straight through the guard below, which is the one population the guard
// exists to constrain. The remedy for a genuinely-unpaid marked event is the
// deliberate one-row DELETE documented in 00190's header, performed by someone
// who has read the ratings against the final standings first.
export async function applyPlacementBonuses(eventId: string) {
  const admin = await requireCapability('tournaments.results.bonuses.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'completed') throw new ExpectedError('Event must be completed first');
  if (!event.placement_bonus_enabled) throw new ExpectedError('Placement bonuses not enabled for this event');
  // A bonus is paid into ratings, so an event that moves no rating pays none.
  if (event.rated === false
    || (event.format === 'staged' && !anyStageRated(parseFormatConfig(event.format_config) ?? { stages: [] }))) {
    throw new ExpectedError('This event is unrated, so it pays no placement bonus.');
  }
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // Two gates, both must allow it: the global master switch in
  // platform_settings.tournament_bonuses.enabled, and the per-event column
  // checked above. The global flag existed in the settings panel but was read
  // by nothing, so the panel could say "off" while every finalise awarded
  // bonuses. Callers reaching this action directly (the admin button) get a
  // clear error; finalizeEvent checks the same flag up front so it never
  // half-finalises — see the guard there.
  const clubSettings = await getTournamentBonusSettings(adminClient);
  if (!clubSettings.enabled) {
    throw new ExpectedError('Placement bonuses are disabled platform-wide (Settings → Tournament Bonuses)');
  }
  // THE TOURNAMENT'S OWN AMOUNTS (00275), laid over the club's. Read with
  // select('*') so a database without the column pays the club's amounts; a
  // failed read throws, for the reason the settings read above does: paying
  // the club's amounts on a tournament that set its own is a wrong payment
  // with no unpay.
  const { data: tournamentRow, error: tournamentErr } = await adminClient
    .from('tournaments').select('*').eq('id', event.tournament_id).single();
  if (tournamentErr) {
    throw new Error(`This tournament's bonus amounts could not be read (${tournamentErr.message}), so no bonuses were paid.`);
  }
  const bonusSettings = applyTournamentBonusOverride(
    clubSettings,
    (tournamentRow as { placement_bonus_amounts?: unknown } | null)?.placement_bonus_amounts,
  );

  const doubles = isDoublesEvent(event.event_type);
  const bonuses = doubles ? bonusSettings.doubles : bonusSettings.singles;

  // Pure helper — pull bonus from final_position so the batched paths below stay tidy.
  const bonusFor = (pos: number | null | undefined): number => placementBonusFor(pos, bonuses);


  // THE ONE CASE THE PER-SUBJECT CLAIM CANNOT COVER (00189). Events paid
  // before 00188 have no grant rows at all — the per-player backfill read
  // details -> 'rated_players' from the audit log, and those details are NULL
  // on every historical row, so it inserted nothing. For such an event the
  // unique index excludes nobody and a second run would pay it in full again.
  // 00189 marks those events, and this refuses them: the per-subject facts are
  // gone, so a human has to look at the ratings and decide.
  //
  // 00190 widened WHICH events get that marker, because 00189 still asked the
  // audit log and the audit log is best-effort: a pre-ledger payment whose
  // audit insert failed left no row for 00189 to find. 00190 asks the event
  // instead — completed, bonus-enabled and no grant rows at all means "cannot
  // prove this was not paid", which for an irreversible rating movement is the
  // same answer as "assume it was". It inserted zero extra rows on both hosts,
  // so this is the same set of events as before; the difference is that it is
  // now closed by construction rather than by that set happening to be empty.
  const { data: legacyPaid, error: legacyErr } = await adminClient
    .rpc('event_has_legacy_bonus_payment', { p_event_id: eventId });
  // Fail closed for the same reason readBonusLedger does — not knowing whether
  // this event was already paid is exactly the state where paying is unsafe.
  if (legacyErr) {
    throw new Error(
      `Could not check whether this event was already paid before the bonus ledger existed (${legacyErr.message}). ` +
      `Refusing to apply bonuses — a repeat application would double every rating.`
    );
  }
  if (legacyPaid) {
    throw new ExpectedError(
      'This event was already awarded placement bonuses by an older version that kept no per-player record, ' +
      'so there is no way to tell which players were paid. Re-running would double every bonus on the event. ' +
      'Check the ratings against the final standings first; if they are genuinely unpaid, the marker has to be removed in the database by hand.'
    );
  }

  // A HINT NOW, NOT THE GUARANTEE (00188). Both bonus writes claim a row in
  // tournament_bonus_grants before they pay, so a repeat is refused by a unique
  // index inside the same transaction as the payment rather than by this read.
  // It is still worth doing: it skips the round trip for players a previous run
  // already settled, and it is what lets a retry report the same set as before.
  const ledger = await readBonusLedger(adminClient, eventId);
  // NO CLAMP HERE ANY MORE. Both writes clamp inside SQL against
  // rating_bounds(), which reads the live min_elo/max_elo settings — clampElo's
  // 1500 fallback would have pushed anyone above it DOWN for winning the event.
  // One engine, one ceiling.

  // Filled by whichever branch runs, then recorded in the ledger before any
  // failure is raised.
  const ratedPlayers: string[] = [];
  const creditedParticipants: string[] = [];
  let writeFailures: Awaited<ReturnType<typeof settleWrites>>['failures'] = [];

  if (doubles) {
    const { data: pairs, error: pairsErr } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, final_position, status')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);
    // A failed read arrives as `pairs == null`, which reads as "nobody placed"
    // and finalises the event having paid nobody.
    if (pairsErr) throw new Error(`Could not read placements: ${pairsErr.message}`);

    // Build playerId → bonus map (a player may appear in multiple pairs, sum bonuses).
    const playerBonus = new Map<string, number>();
    for (const pair of pairs ?? []) {
      // BELT AND BRACES over the placing clear in assignPositionsAndPoints.
      // This query asks only for a non-null final_position, so before that
      // clear existed a stale placing left on a disqualified entry was paid a
      // podium bonus. Money is the one place worth checking twice, and the
      // check is a status the row already carries.
      if (isOutOfEvent(pair.status as string | null)) continue;
      const bonus = bonusFor(pair.final_position);
      if (bonus <= 0) continue;
      for (const pid of [pair.player1_id, pair.player2_id]) {
        playerBonus.set(pid, (playerBonus.get(pid) ?? 0) + bonus);
      }
    }
    // Anyone a previous run already paid is skipped, so a retry finishes the
    // job rather than paying them twice.
    for (const pid of ledger.ratedPlayers) playerBonus.delete(pid);

    if (playerBonus.size > 0) {
      // ONE LOCKED READ-ADD-CLAMP PER PLAYER, IN THE DATABASE (00179).
      //
      // This used to batch-read every medallist's rating, add the bonus here,
      // and write the sums back — so anything that moved a player between the
      // read and the write was erased, and the window was the whole batch. A
      // player missing from the batched read was treated as 400 and had the
      // bonus added to that, silently resetting them.
      const targets = [...playerBonus.entries()];
      const { failures, landed } = await settleWrites(
        targets.map(([pid, bonus]) => [
          `ratings.doubles_elo for player ${pid}`,
          adminClient.rpc('apply_placement_bonus', {
            p_event_id: eventId,
            p_player_id: pid,
            p_discipline: 'doubles',
            p_bonus: bonus,
          }),
        ] as const)
      );
      writeFailures = failures;
      targets.forEach(([pid], i) => { if (landed[i]) ratedPlayers.push(pid); });
    }
  } else {
    const { data: participants, error: participantsErr } = await adminClient.from('tournament_participants')
      .select('id, player_id, final_position, elo_change, elo_after, status')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);
    // Same as the doubles branch: a failed read looks exactly like an event
    // where nobody placed.
    if (participantsErr) throw new Error(`Could not read placements: ${participantsErr.message}`);

    const eligible = (participants ?? [])
      // Same belt and braces as the pairs branch above.
      .filter(p => !isOutOfEvent((p as { status?: string | null }).status))
      .map(p => ({ ...p, bonus: bonusFor(p.final_position) }))
      .filter(p => p.bonus > 0);

    if (eligible.length > 0) {
      // Parallel: rating UPDATE + participant elo_change UPDATE for each row.
      // The two are ledgered separately because they can fail independently —
      // elo_change is read-modify-write just like the rating is, so a retry
      // that redid the credited half would inflate the participant's recorded
      // change while the rating stayed put.
      const writes: LabelledWrite[] = [];
      const ratingTargets: string[] = [];
      const participantTargets: string[] = [];
      for (const p of eligible) {
        if (!ledger.ratedPlayers.has(p.player_id)) {
          ratingTargets.push(p.player_id);
          // Locked read-add-clamp in the database (00179) — see the doubles
          // branch for why the batched-read-then-write shape had to go.
          writes.push([
            `ratings.singles_elo for player ${p.player_id}`,
            adminClient.rpc('apply_placement_bonus', {
              p_event_id: eventId,
              p_player_id: p.player_id,
              p_discipline: 'singles',
              p_bonus: p.bonus,
            }),
          ]);
        }
        if (!ledger.creditedParticipants.has(p.id)) {
          participantTargets.push(p.id);
          // elo_after MOVES WITH elo_change, and it did not before. The bonus
          // was credited to the rating and to elo_change but never to the
          // snapshot, so the results table showed a player's rating BEFORE
          // their bonus while reporting a change that included it: "1114 ->
          // 1190 (+108)" for somebody actually sitting on 1222. The ladder was
          // right; the row describing it was not.
          //
          // BOTH HALVES ARE READ-MODIFY-WRITE IN THE DATABASE NOW (00188).
          // This one used to read elo_change and elo_after out of the batched
          // participants SELECT above and write `previous + bonus` back, so it
          // carried the whole batch as its race window — the same shape the
          // rating write had before 00179, and the same fix: one locked
          // read-add-clamp behind a grant row that can only be inserted once.
          // The clamp and the "null elo_after stays null" rule moved with it.
          writes.push([
            `tournament_participants.elo_change for ${p.id}`,
            adminClient.rpc('credit_participant_placement_bonus', {
              p_event_id: eventId,
              p_participant_id: p.id,
              p_bonus: p.bonus,
            }),
          ]);
        }
      }

      const { failures, landed } = await settleWrites(writes);
      writeFailures = failures;
      // `writes` interleaves the two kinds, so walk it once and sort the
      // landed ones back into the two ledgers by the order they were pushed.
      let ratingIdx = 0;
      let participantIdx = 0;
      writes.forEach(([label], i) => {
        const isRating = label.startsWith('ratings.');
        const id = isRating ? ratingTargets[ratingIdx++] : participantTargets[participantIdx++];
        if (!landed[i] || !id) return;
        (isRating ? ratedPlayers : creditedParticipants).push(id);
      });
    }
  }

  // The ledger row goes in BEFORE any failure is raised, and its write is
  // checked rather than best-effort: it is the only record of which bonuses
  // landed, so losing it is what makes a retry dangerous. logAudit swallows its
  // own errors by design, which is right for an audit trail and wrong for this.
  const { error: ledgerError } = await adminClient.from('tournament_audit_log').insert({
    tournament_id: event.tournament_id,
    event_id: eventId,
    match_id: null,
    action: BONUS_APPLIED_ACTION,
    performed_by: admin.id,
    details: {
      rated_players: ratedPlayers,
      credited_participants: creditedParticipants,
      failed_writes: writeFailures.length,
    },
  });
  if (ledgerError) {
    throw new Error(
      `Placement bonuses were applied to ${ratedPlayers.length} rating(s) but the record of it could not be saved ` +
      `(${ledgerError.message}). Do NOT re-run placement bonuses for this event — they would be applied twice.`
    );
  }

  assertWritesSucceeded('Applying placement bonuses', writeFailures);

  revalidateEventPaths(event.tournament_id, eventId);
}

/**
 * Work out final positions and tournament points from the draw as it stands,
 * and write them.
 *
 * Extracted from finalizeEvent so a CORRECTION can redo it. Correcting a
 * finalised event fixes the match and the ratings, and used to leave the
 * standings frozen at whatever finalisation computed — the old champion kept
 * first place, 100 points and the trophy while the bracket named someone else.
 * The dialog's advice was to "adjust those by hand", which is not a thing the
 * console can do: there is no editor for final_position or points.
 *
 * Both writes are absolute and derived entirely from the finished bracket, so
 * running this again is idempotent — that is what makes it safe to re-run on a
 * completed event.
 *
 * Placement BONUSES are deliberately not touched here. They were paid into the
 * players' ratings and there is no reversal for them, so redoing placements
 * cannot quietly redo the money; recomputeEventStandings reports when a
 * placement moved under a paid bonus and leaves that for a human.
 */
/**
 * A staged event's placings and points (00272), from the shared engine:
 * finalPlacings for the order, pointsFor for the points. Withdrawn and
 * disqualified entries are not placed. Computes only, like its caller.
 */
async function stagedPositionsAndPoints(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  eventId: string,
  doubles: boolean,
  table: string,
): Promise<{ positions: Map<string, number>; points: Map<string, number> }> {
  const cfg = parseFormatConfig(event.format_config);
  if (!cfg) {
    throw new ExpectedError('This event\'s stages are not set out correctly, so its placings cannot be worked out. Fix them in the event settings first.');
  }
  const [entriesRes, matchesRes] = await Promise.all([
    adminClient.from(table as 'tournament_pairs').select('id, seed_number, status').eq('event_id', eventId),
    adminClient.from('tournament_matches')
      .select('stage, status, pool_number, group_number, round_number, match_label, is_third_place, scores, participant_a_id, participant_b_id, pair_a_id, pair_b_id, winner_participant_id, winner_pair_id')
      .eq('event_id', eventId)
      .not('stage', 'is', null),
  ]);
  // Thrown for the reason the other branches throw: an empty read would place
  // nobody and still let the event complete.
  if (entriesRes.error) throw new Error(`This event's entries could not be read, so no placings were worked out: ${entriesRes.error.message}`);
  if (matchesRes.error) throw new Error(`This event's matches could not be read, so no placings were worked out: ${matchesRes.error.message}`);

  const rows = (matchesRes.data ?? []).map((m) => ({ ...m, ...matchSides(m, doubles) }));
  const results = formatResultsFrom(
    cfg,
    (entriesRes.data ?? []).map((e) => ({ id: e.id as string, seed: e.seed_number as number | null, status: e.status as string })),
    rows,
  );
  // Kill switch placings_skip_never_played: off, an entry never drawn is placed
  // at the bottom by seed again.
  const positions = finalPlacings(cfg, results, {
    placeNeverDrawn: !(await releaseFlagOn('placings_skip_never_played')),
  });
  const wins = new Map<string, number>();
  for (const m of results.matches) {
    if (isTalliedStatus(m.status) && m.winner && m.a && m.b) wins.set(m.winner, (wins.get(m.winner) ?? 0) + 1);
  }
  const points = new Map<string, number>();
  for (const [id, place] of positions) points.set(id, pointsFor(cfg, place, wins.get(id) ?? 0));
  return { positions, points };
}

/**
 * Has every stage of a staged event been drawn? finalizeEvent already refuses
 * an unplayed match; this refuses a stage with no matches at all, which would
 * otherwise read as finished.
 */
async function assertEveryStageDrawn(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  eventId: string,
): Promise<void> {
  const cfg = parseFormatConfig(event.format_config);
  if (!cfg) {
    throw new ExpectedError('This event\'s stages are not set out correctly. Fix them in the event settings before finalising.');
  }
  const { data, error } = await adminClient.from('tournament_matches')
    .select('stage')
    .eq('event_id', eventId)
    .not('stage', 'is', null);
  if (error) throw new Error(`Could not read which stages are drawn: ${error.message}`);
  const drawn = new Set((data ?? []).map((r) => r.stage as number));
  const missing = cfg.stages.filter((_, i) => !drawn.has(i + 1)).map((s) => `"${s.name}"`);
  if (missing.length > 0) {
    throw new ExpectedError(
      `${missing.join(' and ')} ${missing.length === 1 ? 'has' : 'have'} not been drawn yet. Draw and play every stage before finalising.`,
    );
  }
}

async function assignPositionsAndPoints(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  eventId: string,
  doubles: boolean,
  table: string,
): Promise<{
  positionMap: Map<string, number>;
  pointsMap: Map<string, number>;
  wonPositions: string[];
  cleared: string[];
}> {
  // COMPUTES ONLY -- it writes nothing. The caller decides where the writes go,
  // because the two callers need them in different places: finalizeEvent hands
  // them to the completion RPC so they land inside the advisory lock that
  // guards the status flip, while recomputeEventStandings writes them directly
  // (its event is already completed, so the race the lock exists for cannot
  // happen). See writePlacements below for the direct path.
  const positionMap = new Map<string, number>();

  // WHO HOLDS A PLACING BECAUSE THEY WON, hoisted to function scope so it can
  // be returned. The check below refuses if any of them has left the event —
  // but that check is a read with no lock held through to the status flip, so
  // it is the early, better-worded half of the guard. The authoritative half is
  // complete_event_under_field_lock re-reading this same set under the fence
  // (00211); an admin can disqualify between the two.
  //
  // FILLED ON EVERY FORMAT, and the note that used to sit here saying "empty
  // for round robin, which needs no such guard" was a wrong premise. It argued
  // that computeRoundRobinStandings already excludes exited entries from its
  // ordering -- true, and beside the point. The exclusion happens when the
  // standings are COMPUTED; the sequence this guard exists for is an entry
  // leaving AFTER that, while the positions are being written. Round robin was
  // therefore passing an empty set, so the fence skipped its winner check
  // altogether and a leader disqualified mid-finalise kept final_position = 1
  // in a completed event.
  //
  // A round robin's whole table is stale once anybody in it leaves, not just
  // first place: exclude one entry and every win count computed against them
  // moves. So every placed entry goes in, and the fence refuses the
  // finalisation rather than publishing a table nobody would compute again.
  const wonTheirPosition = new Set<string>();

  // WHICH RULE DECIDES THE PLACINGS. A pool_to_bracket event ends in a knockout
  // and is placed by it, exactly as a single_elimination event is — the pool
  // decided who got in, not who won. What it adds is everyone the knockout did
  // not contain; see the non-qualifier pass below.
  const knockout = endsInKnockout(event.format as string);
  const poolToBracket = isPoolToBracket(event.format as string);
  const bracketPhase = phaseValueFor(event.format as string, 'bracket');
  // A STAGED EVENT (00272) is placed by its stages, and every placing in it is
  // earned against the whole field, as a round robin's is.
  let stagedPoints: Map<string, number> | null = null;

  if (event.format === 'staged') {
    const staged = await stagedPositionsAndPoints(adminClient, event, eventId, doubles, table);
    for (const [id, place] of staged.positions) {
      positionMap.set(id, place);
      wonTheirPosition.add(id);
    }
    stagedPoints = staged.points;
  } else if (knockout) {
    // PHASE-FILTERED (00107), and this is not optional. The pool's matches sit
    // in this same table on a pool_to_bracket event, and every one of them has
    // a round_number in the same range as the bracket's. Unfiltered, the
    // `totalRounds = max(round_number)` line below would be computed over a
    // mixture of two draws and the "loser of the final is 2nd" rule would be
    // applied to a round-robin fixture.
    let matchQuery = adminClient.from('tournament_matches')
      // The SLOTS come back too, so the winner can be checked against them
      // below rather than taken on trust.
      .select('id, round_number, is_third_place, winner_pair_id, loser_pair_id, winner_participant_id, loser_participant_id, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
      .eq('event_id', eventId)
      .in('status', ['completed', 'walkover'])
      .order('round_number', { ascending: false });
    if (bracketPhase) matchQuery = matchQuery.eq('phase', bracketPhase);
    const { data: matches, error: matchesError } = await matchQuery;
    // THE WHOLE EVENT IS COMPUTED FROM THIS ONE READ. Discarded, an error
    // becomes `matches ?? []` an empty bracket, which produces an empty
    // positionMap and an empty pointsMap, which the completion RPC accepts as
    // valid JSON (00214) and still flips the event to `completed`. The result is
    // a finished event with no champion, no positions and no points, and not one
    // line of error anywhere -- the same silent-wrong-answer shape as the two
    // reads above.
    //
    // Throwing is safe here: this runs before writePlacements and before the
    // completion RPC, so nothing has been committed yet.
    if (matchesError) {
      throw new Error(`This event's bracket could not be read, so its final positions were not computed: ${matchesError.message}`);
    }

    // Every position, point and placement bonus below is read off winner_* and
    // loser_*, and nothing had ever checked that those two are the players who
    // were actually IN the match. They can disagree: a stale result write can
    // land after another desk swapped a slot, and the draw editor will place any
    // entry from the event into any empty slot — including the third-place
    // match, whose occupants are supposed to be the two beaten semi-finalists.
    // Both produce a row that finalises cleanly and awards someone a placing
    // they did not play for.
    //
    // Refusing is right rather than repairing: this is a bracket that needs a
    // human to look at it, and quietly picking one of the two disagreeing
    // answers is how the wrong name ends up on the trophy.
    for (const m of matches ?? []) {
      const slots = doubles
        ? [m.pair_a_id, m.pair_b_id]
        : [m.participant_a_id, m.participant_b_id];
      const decided = doubles
        ? [m.winner_pair_id, m.loser_pair_id]
        : [m.winner_participant_id, m.loser_participant_id];
      for (const id of decided) {
        // A null side is normal — an unopposed walkover has no loser.
        if (id && !slots.includes(id)) {
          throw new ExpectedError(
            `Match ${m.id} records a result for an entry that is not in either of its slots. ` +
            'The draw disagrees with the result, so the final positions cannot be trusted. ' +
            'Fix that match before finalising.',
          );
        }
      }
    }

    // The third-place playoff shares round_number with the final so the two are
    // scheduled together (00080), and it MUST be held out of the loop below —
    // both of that loop's rules would misread it:
    //
    //   * its loser has roundsFromFinal 0, so the "loser of the final is 2nd"
    //     rule would award 2nd place to the player who came FOURTH;
    //   * its winner is in the final's round, and the champion line uses `set`
    //     rather than first-write-wins, so it would overwrite the actual
    //     champion with the winner of the third-place match.
    //
    // Neither is a hypothetical: they are the direct consequence of the
    // scheduling decision, which is why the split is here and not left implicit.
    const allMatches = matches ?? [];
    const bracketMatches = allMatches.filter(m => !m.is_third_place);
    const thirdPlace = allMatches.find(m => m.is_third_place);

    // Written BEFORE the loop so the first-write-wins rule for losers protects
    // them: without a playoff, both semi-final losers get joint 3rd, and that
    // rule is exactly what must not run for the two entries this match sorted.
    //
    // Each side is written only if it exists. An unopposed playoff — one
    // semi-final was a bye, so only one loser was ever routed in — has a winner
    // and no loser, and inventing a 4th place for nobody would be worse than
    // leaving the position unset.
    // The distinction this set draws is the whole of the check after this
    // block: losing while withdrawn is ordinary (the forfeit cascade is exactly
    // how a withdrawal ends a run), winning while disqualified is not.
    if (thirdPlace) {
      const w = (doubles ? thirdPlace.winner_pair_id : thirdPlace.winner_participant_id) as string | null;
      const l = (doubles ? thirdPlace.loser_pair_id : thirdPlace.loser_participant_id) as string | null;
      if (w) { positionMap.set(w, 3); wonTheirPosition.add(w); }
      if (l) positionMap.set(l, 4);
    }

    // Guarded on the FILTERED list, not on `matches`. An event whose only
    // completed match is the playoff — the final voided, say — would otherwise
    // reach Math.max() of an empty array, which is -Infinity, and every
    // loserPosition computed from it would be garbage rather than absent.
    if (bracketMatches.length > 0) {
      const totalRounds = Math.max(...bracketMatches.map(m => m.round_number));

      for (const m of bracketMatches) {
        const roundsFromFinal = totalRounds - m.round_number;
        const loserPosition = roundsFromFinal === 0 ? 2 : Math.pow(2, roundsFromFinal) + 1;

        const loserId = (doubles ? m.loser_pair_id : m.loser_participant_id) as string | null;
        const winnerId = (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null;

        // First-write-wins for losers (later rounds set position before earlier ones).
        if (loserId && !positionMap.has(loserId)) positionMap.set(loserId, loserPosition);
        if (m.round_number === totalRounds && winnerId) {
          positionMap.set(winnerId, 1);
          wonTheirPosition.add(winnerId);
        }
      }
    }

    // A WITHDRAWN OR DISQUALIFIED ENTRY CANNOT HAVE WON. Every position above
    // is read off winner_*/loser_* and nothing had ever asked what the entry's
    // own status is, so an entry disqualified after its final was recorded was
    // still crowned: it takes final_position 1 a few lines below and 100 points
    // in the knockout points query, which filters on event_id and a non-null
    // final_position and on nothing else.
    //
    // NO RACE IS NEEDED FOR THIS, which is what makes it a placement defect
    // rather than a gap in the field fence. The sequence is entirely ordinary:
    // the final is played and recorded, an admin disqualifies the winner
    // (conduct after the match, an eligibility breach discovered later), and
    // the event is finalised. The disqualification cascade forfeits only the
    // entry's OPEN matches -- a completed final is not open, so the recorded
    // winner is left standing, correctly, and finalisation then reads it as a
    // championship.
    //
    // REFUSING RATHER THAN REPAIRING, for the same reason as the slot check
    // above: promoting the runner-up, leaving first place vacant and voiding
    // the final are three different club decisions with three different
    // outcomes, and picking one here would put a name on a trophy that nobody
    // chose. The admin voids or replays the match, or reinstates the entry.
    //

    // ------------------------------------------------------------
    // EVERYONE THE KNOCKOUT DID NOT CONTAIN (00107)
    // ------------------------------------------------------------
    //
    // On a pool_to_bracket event most of the field never enters the bracket,
    // and without this they would finish the event with final_position NULL —
    // no placing, no tournament points, and invisible to every results screen,
    // having played a full round robin. They are ordered among themselves by
    // the pool table, and they finish BEHIND every qualifier.
    //
    // THE START IS max(assigned) + 1, NOT (number of qualifiers) + 1. Knockout
    // placings are not dense: an 8-slot draw awards 1, 2, 3, 3 and then 5 to
    // all four first-round losers, so the highest number a qualifier holds is
    // bracketSize/2 + 1 and can exceed the size of the field. Starting from the
    // count would place a non-qualifier level with, or ahead of, somebody who
    // won a knockout match.
    //
    // THE ORDER COMES FROM event.seed_by, WHICH IS THE DOCUMENTED TRAP CLOSED.
    // Within one event the worry was real: the bracket half was seeded by
    // seed_by while this half defaulted to 'wins', so final_position — and
    // therefore the placement-bonus ledger — could be computed from a different
    // order than the draw was. Here there is ONE row and buildFieldFromOwnPool
    // reads the same column, so they cannot disagree.
    //
    // The `else` branch below still passes no seedBy, and that is correct
    // rather than an oversight — see the note on it.
    if (poolToBracket) {
      const seedBy = ((event.seed_by as SeedBy | null) ?? 'wins') as SeedBy;
      const poolStandings = await computeRoundRobinStandings(eventId, seedBy);
      let next = positionMap.size > 0 ? Math.max(...positionMap.values()) + 1 : 1;
      for (const s of poolStandings) {
        if (!s || positionMap.has(s.id)) continue;
        positionMap.set(s.id, next++);
        // Non-qualifiers are ordered among themselves by the pool table, which
        // is the same round-robin arithmetic -- so the same staleness applies.
        // Not the sequence codex supplied, but the identical hole one branch
        // over, and leaving it open would only be found later.
        wonTheirPosition.add(s.id);
      }
    }
  } else {
    // Round robin: compute standings and assign positions.
    //
    // NO seedBy, AND THAT IS THE ONLY WELL-DEFINED CHOICE — not a leftover.
    // This branch is reached only by `round_robin` (endsInKnockout covers the
    // other two formats), and a round robin's own seed_by says nothing about
    // its own table: the column means "how to rank the pool THIS event is drawn
    // from", so on a pool it is either NULL or a statement about some other
    // event entirely.
    //
    // Nor could it be made to mean that. A pool may feed several brackets, each
    // carrying its own seed_by, and its positions are assigned when IT is
    // finalised — possibly before any bracket exists. There is no single value
    // to read, so 'wins' (sortStandings' default, and what a pool table is read
    // by) is the answer. The order a bracket seeds that pool by is a property of
    // the bracket's draw, not a second opinion about the pool's result.
    const standings = await computeRoundRobinStandings(eventId);
    standings.forEach((s, i) => {
      positionMap.set(s!.id, i + 1);
      // Every one of them, for the reason given where wonTheirPosition is
      // declared: a round-robin placing is earned against the whole field, so
      // one departure invalidates all of it.
      wonTheirPosition.add(s!.id);
    });
  }

  // WHOEVER HOLDS A PLACING THEY EARNED MUST STILL BE IN THE EVENT.
  //
  // OUTSIDE the format branches, where it used to sit inside `if (knockout)`.
  //
  // MOVING IT IS NOT WHAT FIXES CODEX'S ROUND-19 SEQUENCE -- filling
  // wonTheirPosition on every format is; this is defence in depth, and saying
  // otherwise would be the same overclaim that hid the hole. On a round robin
  // an entry that left BEFORE the standings were computed is already excluded
  // from them (computeRoundRobinStandings' `out` flag), so it holds no placing
  // for this to catch, and the test below pins that.
  //
  // It earns its place on the disagreement: this reads isOutOfEvent and that
  // exclusion reads its own flag, so if the two status lists ever drift, one
  // branch stops placing an entry the other still would.
  //
  // Scoped to entries that earned a placing. A withdrawal in the first round of
  // a knockout holds a loser's placing from the forfeit cascade, which is the
  // ordinary case and must keep finalising -- refusing on it would block most
  // real events.
  //
  // This is the early, better-worded half. It is a READ, so it holds no lock
  // through to the status flip; complete_event_under_field_lock re-checks the
  // same set under the fence (00211) and is the half that is authoritative.
  if (wonTheirPosition.size > 0) {
    const { data: entryRows, error: entryError } = await adminClient.from(table)
      .select('id, status')
      .in('id', [...wonTheirPosition]);
    // Thrown, not swallowed: a failed read here would otherwise read as
    // "nobody left the event" and finalise the very case this is guarding.
    if (entryError) {
      throw new Error(`Could not check entry status before finalising: ${entryError.message}`);
    }
    const exited = (entryRows ?? []).filter(e => isOutOfEvent((e as { status: string }).status));
    if (exited.length > 0) {
      const which = exited
        .map(e => `${(e as { id: string }).id} (${(e as { status: string }).status})`)
        .join(', ');
      throw new ExpectedError(
        `An entry holding a placing it earned has left the event: ${which}. ` +
        'Finalising would award it a placing and tournament points it cannot hold. ' +
        // NOT "or reinstate the entry", which is what this used to offer.
        // set_field_entry_status is the only writer of entry status and it
        // refuses checked_in from an exited status (00201:1040), so there is no
        // reinstatement to reach from the console. Naming a remedy that does not
        // exist sends an officer looking for a control that was never built.
        'Void or replay the affected match before finalising.',
      );
    }
  }

  // ENTRIES THAT NO LONGER PLACE ARE CLEARED, and without this the write is not
  // absolute at all -- it only overwrote rows that stayed in the map.
  //
  // Codex's round-20 sequence, and it runs straight through the guard above
  // rather than around it. A round-robin leader is placed 1st and the positions
  // are written; the leader is then disqualified; the fence correctly refuses,
  // leaving the event live AND the stale final_position = 1 on the row, because
  // disqualifying changes only `status` (00202:1010). The retry recomputes
  // standings WITHOUT them, so they are absent from the new map, nothing
  // rewrites their row, p_won no longer names them, shrinkage is allowed, and
  // the event completes with a disqualified entry still holding first place.
  //
  // That is the residual I had written down as accepted and benign on the
  // grounds that a refused finalisation pays nothing. It is not benign: the
  // refusal is not the end state, the retry is, and applyPlacementBonuses reads
  // placings by `final_position IS NOT NULL` with no status filter -- so the
  // podium bonus lands on the disqualified entry.
  const stale = await adminClient.from(table)
    .select('id, final_position, points')
    .eq('event_id', eventId);
  if (stale.error) {
    throw new Error(`Could not read existing placements: ${stale.error.message}`);
  }
  // Filtered here rather than in the query: the predicate is "holds a placing
  // it should no longer hold", and half of that (`!positionMap.has`) is only
  // known in memory. Splitting it across the wire and JS would read as two
  // rules.
  const toClear = (stale.data ?? [])
    .map(r => r as { id: string; final_position: number | null; points: number | null })
    .filter(r => !positionMap.has(r.id) && (r.final_position !== null || r.points !== null))
    .map(r => r.id);


  // Assign points from the event's points table (00275), then issue one
  // parallel batch of UPDATEs. With no table of its own an event pays its
  // format's default (defaultPointsTable), which is exactly what was written
  // into this function before: 100/75/50/40, 25 to the rest of the last eight
  // and 10 to everyone else on a knockout; 1 to take part and 3 a win on a
  // round robin. An unreadable stored table pays the default too, rather than
  // refusing to finish the event over a setting.
  //
  // A pool_to_bracket event is scored on POSITION, like the knockout it ends
  // in, and not on the round robin's 3-per-win. Everybody in it now has a
  // final_position — the qualifiers from the bracket, the rest from the pool
  // table — so the position ladder covers the whole field, and it is the one
  // that reflects what the event was actually for. It also keeps the pool from
  // outscoring the knockout: five pool wins would be 16 points on the
  // round-robin rule, more than the 10 a beaten quarter-finalist takes.
  const pointsTable = parsePointsTable(event.points_config) ?? defaultPointsTable(event.format as string);
  const pointsMap = new Map<string, number>();
  if (stagedPoints) {
    for (const [id, pts] of stagedPoints) pointsMap.set(id, pts);
  } else if (knockout) {
    // THIRD AND FOURTH ARE NOT THE SAME in the default table, at the club
    // owner's instruction. They used to share 50, which made the third-place
    // play-off (a best of 3 to 21, the same length as the final) decide a
    // label and nothing else. 40 rather than 25: fourth still reached a
    // semi-final and must stay clear of the quarter-final band.
    //
    // Where there was NO play-off the two are genuinely unseparated, but they
    // still hold distinct final_positions (assigned by the tiebreak), so the
    // table splits them anyway. That is the pre-existing behaviour of that
    // tiebreak, and it is why the RESULTS table only says "3rd place" when a
    // play-off was actually played.
    //
    // Read off positionMap rather than back out of the table. It used to
    // re-select every row with a non-null final_position, which only worked
    // because the write above had already landed — the points depended on the
    // positions being IN the database, not merely computed. That coupling is
    // what kept the two writes from moving under one lock. The two are
    // equivalent: the clear below nulls exactly the rows positionMap omits, so
    // the re-read could never return anything positionMap does not hold.
    //
    // A knockout's table pays no per-win figure (normalizePointsConfig clears
    // it), so wins are not counted here.
    for (const [id, pos] of positionMap) pointsMap.set(id, pointsForPlace(pointsTable, pos, 0));
  } else {
    // Round Robin: everyone still in the event takes the participation figure,
    // a placed entry its place's points, and each win the per-win figure.
    const [rrMatchesRes, allEntriesRes] = await Promise.all([
      adminClient.from('tournament_matches')
        .select('winner_pair_id, winner_participant_id')
        .eq('event_id', eventId)
        .in('status', ['completed', 'walkover']),
      adminClient.from(table)
        .select('id')
        .eq('event_id', eventId)
        .not('status', 'in', '("withdrawn","disqualified")'),
    ]);
    // THROWN, NOT `?? []`. Both of these feed pointsMap directly, and this
    // runs BEFORE anything is written — so a refusal here costs a reload and
    // nothing else. Swallowed, they were the quiet way to finalise a round
    // robin in which everybody scored zero: a failed entries read gives an
    // empty pointsMap, a failed matches read drops every win, and the ladder
    // that lands is arithmetically consistent with itself and wrong.
    if (allEntriesRes.error) {
      throw new Error(
        `The round-robin entrants could not be read, so no standings were worked out: ${allEntriesRes.error.message}`
      );
    }
    if (rrMatchesRes.error) {
      throw new Error(
        `The round-robin results could not be read, so no standings were worked out: ${rrMatchesRes.error.message}`
      );
    }
    const wins = new Map<string, number>();
    for (const m of rrMatchesRes.data ?? []) {
      const winnerId = (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null;
      if (winnerId) wins.set(winnerId, (wins.get(winnerId) ?? 0) + 1);
    }
    for (const e of allEntriesRes.data ?? []) {
      pointsMap.set(e.id, pointsForPlace(pointsTable, positionMap.get(e.id) ?? null, wins.get(e.id) ?? 0));
    }
  }

  return { positionMap, pointsMap, wonPositions: [...wonTheirPosition], cleared: toClear };
}

/**
 * Redo a finalised event's standings after its results were corrected.
 *
 * Called automatically by the corrective actions, so nobody has to remember.
 * Positions and points are absolute writes derived from the finished bracket,
 * so this is idempotent and safe to run whenever a completed event changes.
 *
 * Returns the placements that MOVED, and whether any of them had already been
 * paid a placement bonus. Bonuses are not redone: they were added straight into
 * the players' ratings and there is no reversal for them, so quietly paying a
 * new champion (and not unpaying the old one) would be worse than saying so.
 */
/**
 * Has the match that decided this event lost its result?
 *
 * assignPositionsAndPoints reads the champion off `totalRounds =
 * max(round_number)` over matches that STILL HAVE A RESULT. So a final that is
 * voided or undone does not leave first place vacant -- it promotes the round
 * below to "the final" and crowns its winner. The semi-final winner, who LOST
 * the final, becomes the champion, silently, with points and a trophy.
 *
 * That is one of the three club decisions this file already refuses to make on
 * the officers' behalf (see the disqualified-champion guard: "promoting the
 * runner-up, leaving first place vacant and voiding the final are three
 * different club decisions"). So both callers ask this question and neither
 * computes an answer to it:
 *
 *   - recomputeEventStandings CLEARS the standings. The event is already
 *     completed, so refusing would leave the stale champion up; nobody holds a
 *     placing until an officer finalises it again.
 *   - finalizeEvent REFUSES. Nothing has been written yet, so refusing leaves
 *     no bad state at all and the officer is still at the desk.
 *
 * Two policies, one predicate, deliberately -- the two disagreed for as long as
 * they were separate, and `finalizeEvent` is not a place to keep a second copy
 * of this arithmetic.
 *
 * KNOCKOUT ONLY. A round robin has no deciding match: its table is computed
 * from every result at once, and computeRoundRobinStandings copes with a
 * missing one.
 */
async function championIsUndetermined(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  eventId: string,
): Promise<boolean> {
  if (!endsInKnockout(event.format as string)) return false;

  // THE SAME TWO FILTERS assignPositionsAndPoints applies before it takes its
  // max: phase (a pool_to_bracket event's pool matches share the round
  // numbering, 00107) and the third-place playoff (it shares the final's round
  // by design, 00080, and that function splits it out in memory).
  //
  // BYES ARE NOT FILTERED, and that is the counterpart's rule rather than an
  // omission: a bye is written `status: 'completed'` with a winner
  // (brackets.ts), so assignPositionsAndPoints counts it as a result.
  //
  // This filter WAS here, and removing it changes no reachable answer -- byes
  // are only ever created for round 1 (brackets.ts seeds them there and nowhere
  // else), so a top round made only of byes implies a one-round draw, and then
  // the filtered read returns nothing at all and this function returns false on
  // the empty-bracket line below just as the unfiltered read returns false on a
  // decided one. Mutation testing confirms it: restoring the filter fails no
  // test. It is dropped anyway, because the ONLY thing that makes this
  // predicate correct is that it asks the counterpart's question, and a filter
  // the counterpart does not apply is a divergence waiting for the day byes are
  // seeded somewhere other than round 1.
  //
  // STATUS IS NOT FILTERED EITHER, and that is the one deliberate difference.
  // The counterpart takes its max over DECIDED matches only, which is exactly
  // the bug: drop the final's result and its max silently drops a round. This
  // takes the max over the whole bracket -- the real final round, decided or
  // not -- and then asks whether anything there was decided.
  let q = adminClient.from('tournament_matches')
    .select('round_number, status')
    .eq('event_id', eventId)
    .not('is_third_place', 'is', true);
  const bracketPhase = phaseValueFor(event.format as string, 'bracket');
  if (bracketPhase) q = q.eq('phase', bracketPhase);

  const { data: rows, error } = await q;
  // NOT FAIL-OPEN. A failed PostgREST read arrives as `data: null` with an
  // error, never as a rejection, so discarding `error` here would turn any
  // transient failure into an empty bracket, an undetermined-champion of false,
  // and the auto-crown this whole function exists to stop -- silently, and only
  // under the conditions that make it hardest to notice.
  if (error) {
    throw new Error(`Could not read this event's bracket, so its champion could not be established: ${error.message}`);
  }

  const bracket = rows ?? [];
  if (bracket.length === 0) return false;

  const topRound = Math.max(...bracket.map(m => m.round_number as number));
  return !bracket.some(
    m => (m.round_number as number) === topRound
      && ['completed', 'walkover'].includes(m.status as string),
  );
}

export async function recomputeEventStandings(eventId: string): Promise<{
  // A `to` of null means the recompute took the placing AWAY, not that it moved
  // one -- see the build of this list below for why that has to be representable.
  moved: Array<{ id: string; from: number | null; to: number | null }>;
  bonusesAlreadyPaid: boolean;
  // The match that decided the event no longer has a result, so the standings
  // were CLEARED rather than recomputed. See the block that sets it.
  championUndetermined: boolean;
}> {
  // AUTHORISE BEFORE READING OR WRITING ANYTHING. This module is `'use server'`,
  // so every exported function in it is a Server Action -- a POST endpoint whose
  // one parameter is supplied by the caller. This one is only ever called from
  // recomputeStandingsAfterCorrection, but being un-called is not being
  // unreachable.
  //
  // The check used to live at the bottom, inside the audit block, which made it
  // wrong twice over: it ran AFTER writePlacements had already committed the
  // service-role clear, and the `moved.length > 0` guard around that block meant
  // it did not run at all when the clear moved nothing. So an uncapable caller
  // could wipe a completed event's standings and be told "forbidden" afterwards
  // -- or never be told at all.
  //
  // finalizeEvent below has always had this shape; this is the same shape. Its
  // result is held for the audit row rather than fetched a second time.
  const admin = await requireCapability('tournaments.results.standings.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  // Only a finished event has standings to redo. A live one gets them when it
  // is finalised.
  if (event.status !== 'completed') return { moved: [], bonusesAlreadyPaid: false, championUndetermined: false };

  const doubles = isDoublesEvent(event.event_type);
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';

  // `points` comes back too, because the undetermined-champion branch below
  // clears both columns and a row holding only stale points still has to be
  // cleared -- and still has to appear in `moved`.
  const { data: before, error: beforeError } = await adminClient.from(table)
    .select('id, final_position, points')
    .eq('event_id', eventId);
  // THE SECOND FAIL-OPEN, AND THE WORSE ONE. This read is not just the source
  // of `previous` -- it is the list the undetermined-champion branch clears. A
  // discarded error makes it empty, which makes `cleared` empty, which makes
  // writePlacements' `positionMap.size > 0 || toClear.length > 0` guard skip
  // the write entirely, which makes `moved` empty, which makes
  // recomputeStandingsAfterCorrection return without a word. The void lands and
  // the stale champion keeps the trophy, reported as a clean success.
  //
  // Throwing here is safe in a way it would not be further down: nothing has
  // been written yet on this path, and the corrective action that preceded it
  // has already committed, so the officer sees the action land and is told the
  // standings did not.
  if (beforeError) {
    throw new Error(`This event's placings could not be read, so the standings were left as they are: ${beforeError.message}`);
  }
  const previous = new Map<string, number | null>(
    (before ?? []).map(r => [r.id as string, (r.final_position ?? null) as number | null]),
  );

  // THE RESULTS THIS RECOMPUTE IS ABOUT TO BE COMPUTED FROM (00215). Taken here,
  // BEFORE championIsUndetermined and before assignPositionsAndPoints, because
  // both branches below read the matches and both must be fenced against an
  // edit landing underneath them. Taking it after either read would make the
  // snapshot agree with a ladder built from data that had already moved -- a
  // false ACCEPT, which is the direction that restores the wrong champion.
  //
  // Same function on both sides, so there is no digest format for this side to
  // get wrong; it carries the snapshot and never inspects it.
  const { data: resultsSnapshot, error: snapshotError } = await adminClient.rpc('event_results_fingerprint', {
    p_event_id: eventId,
  });
  if (snapshotError) {
    throw new Error(`This event's results could not be read, so the standings were left as they are: ${snapshotError.message}`);
  }

  // The event no longer has a champion -- the standings are CLEARED rather
  // than recomputed, so nobody holds a placing until it is finalised again.
  // See championIsUndetermined for why this is not a computation.
  const championUndetermined = await championIsUndetermined(adminClient, event, eventId);

  let positionMap = new Map<string, number>();
  let pointsMap = new Map<string, number>();
  let cleared: string[];
  if (championUndetermined) {
    // Every row that currently holds anything. writePlacements nulls
    // final_position AND points for each, and an empty positionMap means
    // nothing is written back.
    cleared = (before ?? [])
      .filter(r => r.final_position !== null || r.points !== null)
      .map(r => r.id as string);
  } else {
    ({ positionMap, pointsMap, cleared } = await assignPositionsAndPoints(adminClient, event, eventId, doubles, table));
  }
  // THE WRITE, UNDER THE FIELD FENCE (00215).
  //
  // This used to be three plain PostgREST UPDATEs, with no lock anywhere on the
  // path -- not here, and not in recomputeStandingsAfterCorrection, which runs
  // this AFTER its own corrective mutation has already committed. So two
  // officers correcting the same completed event interleaved freely:
  //
  //   A reads the matches, computes a ladder crowning X
  //     B voids the final and clears the whole field, correctly
  //   A writes its ladder -- X is champion again, on an event whose deciding
  //     match no longer has a result, and nobody is told
  //
  // and a later bonus run pays X, because applyPlacementBonuses reads placings
  // by `final_position IS NOT NULL` with no status filter.
  //
  // The remedy is finalisation's, one path over: the caller passes what it
  // computed FROM, the RPC re-reads that under the event's advisory lock with
  // the match rows held, and writes only if it still matches. The three writes
  // land in one transaction, so a refusal leaves the standings exactly as they
  // were rather than half-rewritten.
  //
  // What this deliberately does NOT re-check under the lock is a placed winner
  // who left -- see the migration header. Refusing there would strand a
  // disqualified entry on first place with no console remedy, because the event
  // is already completed; the read-side guard in assignPositionsAndPoints is
  // where that case belongs and it throws.
  const { data: fenced, error: fenceError } = await adminClient.rpc('rewrite_event_placings_under_field_lock', {
    p_event_id: eventId,
    p_is_pair: doubles,
    p_positions: Object.fromEntries(positionMap),
    p_points: Object.fromEntries(pointsMap),
    p_clear: cleared,
    p_results: resultsSnapshot,
  });
  if (fenceError) {
    throw new Error(`The standings could not be rewritten, and nothing was saved: ${fenceError.message}`);
  }
  const written = fenced as FencedFieldResult | null;
  // THROWN HERE, not folded into an empty `moved`. Returning quietly would put
  // this back into the exact shape the fail-open above was fixed out of: the
  // corrective action lands, the standings silently do not, and the officer is
  // told nothing at all.
  if (!written?.ok) {
    if (written?.reason === 'results_changed') {
      throw new ExpectedError(
        'Another result changed while these standings were being recalculated' +
        (written.matches_moved ? ` (match ${written.matches_moved})` : '') +
        '. Nothing was rewritten, because they were worked out from the old result. Reload to see the current standings.',
      );
    }
    if (written?.reason === 'event_status') {
      throw new ExpectedError(
        'This event is no longer completed, so its standings were not rewritten. Reload to see where it stands.',
      );
    }
    fencedRefusal(written, 'Event not found');
  }

  // `to: number | null` because a recompute can REMOVE a placing, not just move
  // one. Built from positionMap alone this list could only ever grow or shuffle,
  // so an entry the correction dropped out of the standings entirely produced no
  // audit row and -- worse -- no `moved.length > 0` for the bonuses-already-paid
  // warning at results.ts to fire on. That is precisely the case the warning is
  // for: placement bonuses have no reversal, so an officer who clears a champion
  // whose bonus already landed has to be told.
  const moved: Array<{ id: string; from: number | null; to: number | null }> = [];
  for (const [id, to] of positionMap) {
    const from = previous.get(id) ?? null;
    if (from !== to) moved.push({ id, from, to });
  }
  for (const id of cleared) {
    // A cleared id is absent from positionMap by construction, so this cannot
    // duplicate the loop above. `previous` may hold null for it if the row had
    // only stale points -- still a change worth logging, but not a MOVE, so it
    // is filtered on the same from !== to rule.
    const from = previous.get(id) ?? null;
    if (from !== null) moved.push({ id, from, to: null });
  }

  // THE MARKER COUNTS HERE, AND ONLY HERE. This is the warning an officer
  // gets when a correction moves a placing on an event whose bonuses have
  // already been paid — there is no reversal for them, so the question is
  // "was anything paid at all", not "which subjects". A legacy marker is a
  // yes to that question: it exists precisely because an older version paid
  // the event and kept no per-player record.
  //
  // applyPlacementBonuses wants the opposite and gets it, because it never
  // reaches this read on a marked event — event_has_legacy_bonus_payment
  // refuses it several checks earlier.
  const ledger = await readBonusLedger(adminClient, eventId);
  const bonusesAlreadyPaid =
    ledger.legacyPaid || ledger.ratedPlayers.size > 0 || ledger.creditedParticipants.size > 0;

  if (moved.length > 0) {
    await logAudit(adminClient, {
      tournament_id: event.tournament_id,
      event_id: eventId,
      // A DISTINCT ACTION for the cleared case. Both write the same `moved`
      // shape, but "the standings were recomputed" and "the event no longer has
      // a champion" are different things to read back off the log a season
      // later, and the second one is the one an officer has to act on.
      action: championUndetermined ? 'standings_cleared' : 'standings_recomputed',
      performed_by: admin.id,
      details: { moved, bonuses_already_paid: bonusesAlreadyPaid, champion_undetermined: championUndetermined },
    });
  }

  // THE EVENT GOES BACK TO LIVE. The standings are gone, so leaving the event
  // 'completed' is a lie that no path can undo: championUndetermined means the
  // match that decided this event has been voided or corrected away and every
  // final_position and points on the field has just been cleared. A completed
  // event with no placings is not a finished event, it is a stranded one, and
  // the two ways out are both shut against it -- finalizeEvent requires 'live'
  // and enterMatchResult requires an event that is still playing -- so the
  // officer can neither re-enter the deciding result nor finalise it again.
  //
  // AFTER the fence rather than folded into it.
  // rewrite_event_placings_under_field_lock refuses any event whose status is
  // not 'completed' (00215), so the status can only move once the rewrite it
  // guards has landed.
  //
  // Gated on championUndetermined alone, NOT on moved.length: an event whose
  // rows already held null placings produces an empty `moved` and no audit row,
  // and it is stranded in exactly the same way.
  if (championUndetermined) {
    const { error: reopenError } = await adminClient
      .from('tournament_events')
      .update({ status: 'live' })
      .eq('id', eventId)
      // Only from 'completed'. Matching zero rows is not an error in PostgREST,
      // and that is the right reading here: the only way this matches nothing is
      // that another writer already moved the event off 'completed', which is
      // this same outcome reached by another route.
      .eq('status', 'completed');
    // Raised, not swallowed. Cleared standings on an event still marked
    // completed is precisely the stranded state these lines exist to prevent,
    // and the audit row above has already recorded the clearing either way.
    if (reopenError) throw new Error(reopenError.message);
  }

  revalidateEventPaths(event.tournament_id, eventId);
  return { moved, bonusesAlreadyPaid, championUndetermined };
}

/**
 * finalizeEvent for the console's button: a refusal comes back as a value, so
 * its message reaches the toast in production instead of being sanitised.
 * finalizeEvent itself still throws, for the cascade that calls it.
 */
export async function finalizeEventAction(eventId: string): Promise<ActionResult<void>> {
  return runAction(async () => {
    try {
      await finalizeEvent(eventId);
    } finally {
      // In finally: a finalise that completed the event and then reported a
      // held follow-up failure has still finished it.
      await closeTournamentAfterFinalEvent(eventId);
    }
  });
}

/**
 * Finalising the last open event finishes the tournament, through the same
 * guarded status write and audit row as Mark Completed. Here and not in
 * finalizeEvent, so completeTournamentWithEvents, which finalises event after
 * event and closes the tournament itself, never races it. Never throws: the
 * finalise has already happened, and an actor without the tournament status
 * key is refused by that write and the tournament simply stays open.
 */
async function closeTournamentAfterFinalEvent(eventId: string): Promise<void> {
  try {
    // Kill switch auto_close_tournament: off, the tournament stays open until
    // somebody presses Mark Completed, as before.
    if (!(await releaseFlagOn('auto_close_tournament'))) return;
    const adminClient = createAdminClient();
    const { data: event, error: eventError } = await adminClient.from('tournament_events')
      .select('tournament_id, status').eq('id', eventId).maybeSingle();
    if (eventError) throw new Error(eventError.message);
    if (!event || event.status !== 'completed') return;
    const [tournamentRes, eventsRes] = await Promise.all([
      adminClient.from('tournaments').select('status').eq('id', event.tournament_id).maybeSingle(),
      adminClient.from('tournament_events').select('status').eq('tournament_id', event.tournament_id),
    ]);
    if (tournamentRes.error) throw new Error(tournamentRes.error.message);
    if (eventsRes.error) throw new Error(eventsRes.error.message);
    if (!closesWithFinalEvent(tournamentRes.data?.status, (eventsRes.data ?? []).map((e) => e.status as string))) return;
    const { updateTournamentStatus } = await import('../actions/tournaments');
    await updateTournamentStatus(event.tournament_id, 'completed');
  } catch (err) {
    Sentry.captureException(err);
  }
}

export async function finalizeEvent(eventId: string) {
  const admin = await requireCapability('tournaments.results.finalize.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'live') throw new ExpectedError('Event must be live to finalize');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const doubles = isDoublesEvent(event.event_type);

  // Check all matches are complete — single query selects all incomplete rows
  // with the participant fields we need to filter unused bracket slots in memory.
  const { data: incompleteMatches } = await adminClient.from('tournament_matches')
    .select('id, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', eventId)
    .not('status', 'in', '("completed","walkover","voided","bye")')
    .not('is_bye', 'eq', true);

  // THE SAME PREDICATE THE COMPLETION CLASSIFIER USES
  // (classifyEventForCompletion, shared/utils/tournament-withdrawal.ts), so the
  // console's "this event is ready to finalise" and this refusal are one piece
  // of arithmetic rather than two that agree today.
  //
  // A BEHAVIOURAL NO-OP HERE, and deliberately so. The projection above selects
  // neither `status` nor `is_bye`, so both of the predicate's first two clauses
  // read `undefined` and are inert on this call site — the query already
  // filtered the settled statuses and the byes server-side, and what is left is
  // character for character the participant/pair test this line always was.
  // The fetch was NOT widened: `.not('is_bye', 'eq', true)` drops rows where
  // is_bye IS NULL (NOT (NULL = true) is NULL) whereas the TS predicate's
  // `is_bye === true` keeps them, so the shared side counts MORE rows as
  // incomplete than the query does. That divergence pushes towards refusing to
  // finalise, never towards finalising something unfinished, and widening the
  // fetch in the highest-risk function in the codebase buys nothing.
  const realIncomplete = (incompleteMatches ?? []).filter(m => isRealIncompleteMatch(m, doubles));

  if (realIncomplete.length > 0) {
    throw new Error(`${realIncomplete.length} match(es) still incomplete`);
  }
  if (event.format === 'staged') await assertEveryStageDrawn(adminClient, event, eventId);

  // A VOIDED FINAL IS NOT AN INCOMPLETE ONE, and the query above says so
  // explicitly -- "voided" is one of the four statuses it excludes. So an event
  // whose final was voided passes the completeness check, and
  // assignPositionsAndPoints below would then crown the semi-final winner,
  // exactly as it did on the corrective paths before championIsUndetermined
  // existed. Same defect, reached through finalisation rather than through a
  // correction.
  //
  // REFUSING HERE RATHER THAN CLEARING. The corrective paths clear because the
  // event is already completed and a refusal would leave a stale champion
  // standing. Nothing has been written yet at this point, so there is no bad
  // state for a refusal to leave -- and the officer is at the desk, able to
  // replay or restore the match. This is the same shape as the two refusals
  // above it.
  if (await championIsUndetermined(adminClient, event, eventId)) {
    throw new ExpectedError(
      'The match that decides this event has no result — it was voided, and a voided match is not an incomplete one, so nothing above stopped this. ' +
      'Finalising now would award first place to whoever won the round below. ' +
      'Replay or restore that match before finalising.',
    );
  }

  const table = doubles ? 'tournament_pairs' : 'tournament_participants';

  // THE FIELD THE POSITIONS WERE COMPUTED AGAINST, read immediately before the
  // work that consumes it. It travels with the flip below so the fence can
  // tell whether it is still the field. See the block on that call.
  const { data: fieldRows, error: fieldError } = await adminClient.from(table)
    .select('id')
    .eq('event_id', eventId)
    .not('status', 'in', '("withdrawn","disqualified")');
  if (fieldError) {
    throw new Error(`Could not read this event's entries, so it was not finalised: ${fieldError.message}`);
  }
  const field = (fieldRows ?? []).map(r => r.id as string);

  // THE RESULTS THE PLACINGS ARE ABOUT TO BE COMPUTED FROM (00213). Taken
  // BEFORE the computation, not after, and that ordering is the whole safety
  // margin: a correction landing between this snapshot and the compute makes
  // the snapshot stale, so the fence refuses a finalisation that was in fact
  // fine. Taking it afterwards would make the snapshot agree with a ladder
  // computed from data that had already moved — a false ACCEPT rather than a
  // false refusal, which is the direction that crowns the wrong player.
  //
  // The digest is built by the database, and the same function rebuilds it
  // under the lock, so there is no format for this side to get wrong. This
  // carries it; it never inspects it.
  const { data: results, error: resultsError } = await adminClient.rpc('event_results_fingerprint', {
    p_event_id: eventId,
  });
  if (resultsError) {
    throw new Error(`Could not read this event's results, so it was not finalised: ${resultsError.message}`);
  }

  const { positionMap, pointsMap, wonPositions, cleared } = await assignPositionsAndPoints(adminClient, event, eventId, doubles, table);

  // THE FLIP, UNDER THE FIELD FENCE (00209 — R1).
  //
  // This used to be a conditional UPDATE ... WHERE status = 'live'. That
  // condition makes two concurrent FINALISATIONS safe and the RPC keeps it —
  // it asserts the status under the lock and names what it lost to, instead of
  // returning a zero row count the caller has to interpret. What it never
  // addressed is the other order:
  //
  //   promote_pool_qualifier commits a new entrant (it holds the field lock,
  //   correctly)                                                    |
  //   the positions above were computed without them                |
  //   this flip still sees status = 'live' and completes the event  <
  //
  // The promoted entrant then sits in a completed event with no placing and no
  // points, invisible to every results screen, and finalizeEvent refuses to run
  // again because the event is no longer live.
  //
  // So finalisation joins the protocol the way publish_event_draw already does
  // — the caller passes the field it worked from, and the flip happens only if
  // that is still the field. Growth is refused; a withdrawal in between is not,
  // because a withdrawn entry needs no placing.
  //
  // WHAT IS NOT DONE, AND WHY. Making the lock span the READ would mean moving
  // assignPositionsAndPoints into plpgsql: bracket arithmetic, the third-place
  // playoff split, pool standings and the slot-versus-result cross-check. That
  // is a rewrite of the highest-risk function here, not a fence, and it is
  // still not done. Making it span the WRITE is a different proposition and IS
  // done (00212): the computation stays here, its result travels as data, and
  // the RPC performs the three writes in the transaction that flips the status.
  // So two concurrent finalisations can no longer interleave into a ladder made
  // of halves — either everything this call computed lands, or none of it
  // does.
  const { data: fenced, error: completeError } = await adminClient.rpc('complete_event_under_field_lock', {
    p_event_id: eventId,
    p_is_pair: doubles,
    p_field: field,
    // THE WON PLACINGS, RE-CHECKED UNDER THE LOCK (00211). The JS guard inside
    // assignPositionsAndPoints reads these entries' status, but holds no lock
    // through to here, so an admin disqualifying a champion in between still
    // landed a completed event with a disqualified winner. Shrinkage is
    // deliberately allowed by the field check above it — a withdrawn entry
    // needs no placing — and that is exactly why it cannot catch this: the
    // entry that left is one that WON.
    p_won: wonPositions,
    // THE PLACINGS THEMSELVES (00212). Sent as data rather than written from
    // here, so they land inside the same lock as the flip. Object keys are
    // entry ids; the RPC refuses any that does not belong to this event, and
    // rolls the whole call back rather than completing a half-written ladder.
    p_positions: Object.fromEntries(positionMap),
    p_points: Object.fromEntries(pointsMap),
    p_clear: cleared,
    // THE RESULTS, RE-READ UNDER THE LOCK (00213). Every check above this one
    // asks about the ENTRIES — who is in the field, who won and is still here.
    // The placings come from the MATCHES, and a match can be corrected or
    // voided without any entry moving at all. A corrected match stays
    // 'completed' and a voided one counts as settled, so neither the field
    // check nor the open-match count can see it.
    p_results: results,
  });
  if (completeError) {
    throw new Error(`The event could not be finalised, and nothing was saved: ${completeError.message}`);
  }
  const completed = fenced as FencedFieldResult | null;
  if (!completed?.ok) {
    // Nothing was written: the placings travel WITH this call now, so a refusal
    // leaves the event exactly as it was rather than carrying the losing
    // caller's ladder. The bonus must still not be paid twice, and an event
    // that gained an entrant must be finalised again rather than half-placed.
    // The same defect the guard in assignPositionsAndPoints refuses, caught on
    // the other side of the window that guard cannot cover (00211).
    if (completed?.reason === 'winner_exited') {
      throw new ExpectedError(
        `An entry that won its place left the event while this was being finalised: ${completed.winners ?? 'see the draw'}. ` +
        'Nothing was completed. Void or replay that match before finalising.',
      );
    }
    if (completed?.reason === 'results_changed') {
      throw new ExpectedError(
        'A match result changed while this event was being finalised' +
        (completed.matches_moved ? ` (match ${completed.matches_moved})` : '') +
        '. Nothing was completed, because the standings were worked out from the old result. Reload and finalise again.',
      );
    }
    if (completed?.reason === 'event_status') {
      throw new ExpectedError(
        'This event was finalised while you were finalising it — most likely another desk got there first. Reload to see the results.',
      );
    }
    fencedRefusal(completed, 'Event not found');
  }

  // WHY EVERY FAILURE BELOW IS HELD RATHER THAN THROWN. From here down the
  // event is already `completed` in the database. Throwing at the first
  // problem would skip the audit row and the "results are up" notification,
  // which are owed to everyone regardless of what else went wrong — that is
  // how a finalise which actually succeeded comes to look broken. So each
  // step records its failure and the whole set is raised at the end, where
  // the exec sees all of them rather than only the first.
  //
  // Held is not swallowed, and it is not fail-open either: a step that
  // cannot read what it needs does not then proceed on a guess. An
  // unreadable bonus setting pays no bonus; an unreadable recipient list
  // sends no notification.
  const deferred: Array<{ label: string; err: unknown }> = [];

  // Apply placement bonuses only if BOTH the global master switch and the
  // per-event column allow it. The global check has to happen here rather than
  // being left to applyPlacementBonuses' throw: by this point the event is
  // already marked completed, and throwing would skip the audit log and the
  // participant notifications below.
  //
  // Disabled bonuses are a configuration, not an error. An UNREADABLE setting
  // is neither: it is an unknown, and the only safe reading of an unknown
  // master switch is "do not pay". A placement bonus goes straight into a
  // rating and there is no unpay, so the read that failed used to be the
  // cheapest way in the codebase to award a tournament's worth of bonuses
  // nobody had switched on.
  let bonusSettings: TournamentBonusSettings | null = null;
  try {
    bonusSettings = await getTournamentBonusSettings(adminClient);
  } catch (err) {
    deferred.push({ label: 'the placement bonuses were not applied', err });
  }
  if (bonusSettings && event.placement_bonus_enabled && bonusSettings.enabled) {
    try {
      await applyPlacementBonuses(eventId);
    } catch (err) {
      deferred.push({ label: 'the placement bonuses were not applied', err });
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'event_finalized',
    performed_by: admin.id,
  });

  // Notify all participants that the event is completed.
  //
  // A FAILED RECIPIENT READ NOW SENDS NOTHING, AND SAYS SO. It used to end in
  // `?? []`, which turned "the roster could not be read" into "this event has
  // no entrants" — the completion notice went to nobody and the finalise
  // reported success. Nothing is unwound for it, because the event really is
  // finished; it is reported instead, since the alternative is a club that
  // never hears its results are up and an exec who was told it all went
  // through.
  const finalPlayerIds: string[] = [];
  let recipientsRead = true;
  if (doubles) {
    const { data: allPairs, error: pairsError } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    if (pairsError) {
      recipientsRead = false;
      deferred.push({
        label: 'the completion notification was not sent',
        err: new Error(`the entrant list could not be read: ${pairsError.message}`),
      });
    } else {
      for (const pair of allPairs ?? []) {
        finalPlayerIds.push(pair.player1_id, pair.player2_id);
      }
    }
  } else {
    const { data: allParts, error: partsError } = await adminClient.from('tournament_participants')
      .select('player_id')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    if (partsError) {
      recipientsRead = false;
      deferred.push({
        label: 'the completion notification was not sent',
        err: new Error(`the entrant list could not be read: ${partsError.message}`),
      });
    } else {
      for (const p of allParts ?? []) {
        finalPlayerIds.push(p.player_id);
      }
    }
  }

  if (recipientsRead) {
    // The tournament's NAME is cosmetic, so this one degrades rather than
    // cancelling — a completion notice without the name still tells the club
    // the results are up. It is still reported, because `?? 'Tournament'` on
    // its own is indistinguishable from a read that worked.
    const { data: tInfo, error: tInfoError } = await adminClient
      .from('tournaments').select('name').eq('id', event.tournament_id).single();
    if (tInfoError) {
      deferred.push({
        label: 'the completion notification went out without the tournament name',
        err: new Error(tInfoError.message),
      });
    }
    await notifyPlayers(adminClient, finalPlayerIds,
      'Tournament Completed',
      `${tInfo?.name ?? 'Tournament'} has been finalized. Check the results and your updated Elo rating!`,
      { event_id: eventId, tournament_id: event.tournament_id },
      'tournament_event_completed'
    );
  }

  revalidateEventPaths(event.tournament_id, eventId);

  // One failure is re-raised AS ITSELF, so an ExpectedError from the bonus
  // path still reaches the UI as the tidy message it was written to be. Only
  // a genuine pile-up gets flattened into a summary, and then it names every
  // part rather than picking one.
  const only = deferred.length === 1 ? deferred[0] : undefined;
  if (only) throw only.err;
  if (deferred.length > 1) {
    throw new Error(
      `The event was finalised, but ${deferred.length} follow-up steps did not complete: ` +
      deferred.map(d => `${d.label} (${d.err instanceof Error ? d.err.message : String(d.err)})`).join('; ')
    );
  }
}
