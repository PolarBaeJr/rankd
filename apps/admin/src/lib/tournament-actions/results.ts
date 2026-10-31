'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
// Void / no-show / restore reasons are exec-only free text and no longer live
// on the match row — 00118. See lib/private-notes.ts.
import { TOURNAMENT_MATCH_NOTES, fetchPrivateNotes, writePrivateNote } from '../private-notes';
import { runAction, type ActionResult } from '../action-result';
import { recomputeEventStandings } from './finalize';
import {
  isDoublesEvent,
  getEventRules,
  describeMatchShape,
  isLegalGameScore,
  isLegalGameCount,
  ExpectedError,
  eventIsPlaying,
  resolveMatchShape,
  eventRecordFor,
  parseFormatConfig,
  stagedMatchRules,
  validateMatch,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentMatchFormat,
  EventMatchShape,
  MatchShapeOverride,
  EventRecordMatch,
  MatchRules,
} from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  notifyPlayers,
  applyTournamentMatchElo,
  reverseEloSnapshot,
  assertTournamentNotSuspended,
  advanceWinner,
  advanceLoser,
  recordWalkover,
  DESK_WALKOVER_REASON,
  undoDecidedResult,
  entrySideField,
  routeOf,
  routedEntryId,
  MATCH_ROUTES,
  refreshStagedHandicaps,
  currentStagedHeadStarts,
  type MatchRoute,
} from './_internal';
import { fillFreeCourts, type AutoCallEvent, type AutoCallReport } from './auto-call';

// ============================================================
// Score Entry & Advancement
// ============================================================

// Pull `entryId` back out of a slot this match feeds and demote the
// downstream match back to 'pending' — 'ready' and 'live' both assert both
// sides are known, and one of them just stopped being known.
//
// The write is conditional on the slot actually still holding this match's
// entry. A slot can also be set by hand (setMatchEntry) or by a neighbouring
// match, and blindly nulling it would silently undo somebody else's correction.
// Returns whether anything was cleared, for the audit trail.
async function clearRoutedEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  entryId: string,
  doubles: boolean,
  route: MatchRoute,
): Promise<boolean> {
  const target = routeOf(match, route);
  if (!target) return false;

  const field = entrySideField(target.side, doubles);

  const { data: next } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('id', target.nextId)
    .single();
  if (!next) return false;

  const nextRow = next as Record<string, unknown>;
  if (nextRow[field] !== entryId) return false;

  // The `.eq(field, entryId)` is the condition, not the read above it. The read
  // decides whether to attempt the clear; this filter is what makes the clear
  // itself safe, because another desk can fill that slot between the two. Without
  // it a void racing a manual setMatchEntry would null out the entry somebody had
  // just placed by hand, and the count would still report success.
  const { count } = await adminClient.from('tournament_matches')
    .update({
      [field]: null,
      status: nextRow.status === 'ready' || nextRow.status === 'live' ? 'pending' : (nextRow.status as string),
      updated_at: new Date().toISOString(),
    }, { count: 'exact' })
    .eq('id', target.nextId)
    .eq(field, entryId);

  // A staged row with a side gone starts level again until it is refilled.
  if ((count ?? 0) > 0 && nextRow.stage != null) await refreshStagedHandicaps(adminClient, target.nextId, doubles);

  // PostgREST reports "matched no rows" as success, so the count is the only way
  // to tell a clear that fired from one that was overtaken. Reported rather than
  // thrown: the caller's own action (the void, the undo) has already happened and
  // is correct; what is not true any more is that a slot was cleared, and the
  // audit row should not claim it was.
  return (count ?? 0) > 0;
}

// Take this match's winner out of the next round AND its loser out of the
// third-place playoff (00080). Both, always: a semi-final that is being erased
// has put two entries somewhere, and clearing only the winner is how the
// playoff ends up advertising a semi-finalist whose semi-final no longer
// happened.
async function clearAdvancedEntries(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
): Promise<{ winner: boolean; loser: boolean }> {
  const cleared = { winner: false, loser: false };
  for (const route of MATCH_ROUTES) {
    const entryId = routedEntryId(match, route, doubles);
    if (!entryId) continue;
    cleared[route] = await clearRoutedEntry(adminClient, match, entryId, doubles, route);
  }
  return cleared;
}

// Refuse when a match this one feeds has already been decided. Rewinding an
// earlier round underneath a played later round would leave a recorded result
// for an entry that is no longer in that half of the draw.
//
// BOTH routes are checked. A semi-final feeds the final with its winner and —
// once an event has a third-place playoff — feeds that playoff with its loser.
// The playoff is not a lesser match: it has a real result and a real Elo delta,
// and rewriting the semi-final underneath it would leave that result attributed
// to somebody who is no longer a semi-final loser. Checking only
// winner_to_match_id would have let exactly that through.
async function assertDownstreamUndecided(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  what: string,
) {
  for (const route of MATCH_ROUTES) {
    const target = routeOf(match, route);
    if (!target) continue;

    const { data: nextMatch, error } = await adminClient.from('tournament_matches')
      .select('status, is_third_place')
      .eq('id', target.nextId)
      .single();

    // A FAILED READ is not "no downstream result". The error was being dropped,
    // which left `nextMatch` null and the guard silently satisfied — so a
    // transient read failure was a way past the one check standing between a
    // correction and a played final. Refuse instead; the caller can retry.
    if (error) {
      throw new Error(
        `Could not check whether the next match already has a result (${error.message}), ` +
        `so it is not safe to ${what}. Try again.`,
      );
    }

    if (nextMatch && (nextMatch.status === 'completed' || nextMatch.status === 'walkover')) {
      throw new ExpectedError(
        nextMatch.is_third_place
          ? `Cannot ${what} — the third-place match already has a result. Undo that one first.`
          : `Cannot ${what} — the next match already has a result. Undo that one first.`,
      );
    }
  }
}

// Refuse a result whose declared winner is not the side that actually won more
// games.
//
// The dialog derives winnerSide from the scores it collected, so the UI could
// never produce a disagreement — but the server action is the integrity
// boundary, and it is directly invocable. Without this, scores of
// [21-10, 21-12] with winnerSide 'b' stored side B as the winner, handed B the
// WINNER's Elo delta, and advanced B in the bracket having lost 2-0.
//
// The tie case lives here rather than in the caller so both entry points get it:
// enterMatchResult also rejects ties via isLegalGameCount, but editMatchResult
// runs no score legality checks at all.
//
// Same refusal apply_match_result raises for challenges ('winner_side does not
// match game scores'), so the two rating engines report it identically.
// Not exported: this is a 'use server' module, where every export must be an
// async server action. Both call sites are in this file.
function assertWinnerMatchesScores(
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b',
): void {
  // No games at all is a walkover, whose winner is decided by the forfeit and
  // not by a scoreline. editMatchResult can legitimately re-rate one, so
  // rejecting an empty score list here as a 0-0 tie would take away the only
  // way to correct it. enterMatchResult never reaches this case: isLegalGameCount
  // rejects 0-0 before the call, because the winner must reach the clinch.
  if (scores.length === 0) return;

  const aGames = scores.filter((g) => g.a > g.b).length;
  const bGames = scores.filter((g) => g.b > g.a).length;

  if (aGames === bGames) {
    throw new ExpectedError(
      `Games won are tied at ${aGames}-${bGames} — there is no winner to record.`,
    );
  }

  const derived: 'a' | 'b' = aGames > bGames ? 'a' : 'b';
  if (derived !== winnerSide) {
    throw new ExpectedError(
      `Side ${derived.toUpperCase()} won ${Math.max(aGames, bGames)}-${Math.min(aGames, bGames)}, ` +
      `so the result cannot be recorded for side ${winnerSide.toUpperCase()} — ` +
      `winner_side does not match game scores.`,
    );
  }
}

/**
 * Pin an in-flight match update to the occupants this request READ.
 *
 * The status alone is not enough. Another desk can clear a slot (ready ->
 * pending), put a different entry in it (pending -> ready), and the status is
 * back to what we read — so a stale write lands and stamps a winner who is no
 * longer in the match. The bracket then holds one pair of names while the result
 * holds another, and finalizeEvent trusts the result fields without ever reading
 * the slots.
 *
 * A NULL slot is SKIPPED rather than matched. PostgREST renders `.eq(col, null)`
 * as `col=eq.null`, and in SQL `NULL = NULL` is unknown, so including it would
 * match zero rows and report every edit of an unopposed walkover — which
 * legitimately has one empty side — as "another desk got there first". Nothing
 * is lost by skipping: filling an empty slot moves the status, which the status
 * condition already catches.
 */
function matchSlotFilter<T extends { eq(column: string, value: string): T }>(
  update: T,
  match: Record<string, unknown>,
  doubles: boolean,
): T {
  const sides = doubles
    ? ([['pair_a_id', match.pair_a_id], ['pair_b_id', match.pair_b_id]] as const)
    : ([['participant_a_id', match.participant_a_id], ['participant_b_id', match.participant_b_id]] as const);
  let out = update;
  for (const [column, value] of sides) {
    if (typeof value === 'string') out = out.eq(column, value);
  }
  return out;
}

// Gate shared by the corrective actions (void / restore / slot editing). Results
// can only be changed once the event is genuinely under way; 'completed' is
// allowed too so a finished event can still be fixed.
function assertEventResultsMutable(event: Record<string, unknown>, action: string) {
  // eventIsPlaying, not `=== 'live'` (00107). A pool_to_bracket event plays its
  // round robin at `pool_live`, and every corrective action — void, restore,
  // slot editing — has to reach those matches on the day exactly as it reaches
  // a knockout's. For the other two formats eventIsPlaying IS `=== 'live'`.
  if (!eventIsPlaying(event.status as string) && event.status !== 'completed') {
    throw new ExpectedError(`Start the event before ${action}.`);
  }
}

/**
 * Redo the placings a post-finalisation edit just invalidated.
 *
 * The counterpart to the gate above. `assertEventResultsMutable` deliberately
 * lets the corrective actions reach a COMPLETED event, and a completed event
 * has standings — so any of them can leave `final_position` and `points`
 * describing a bracket that no longer exists. Voiding the final is the sharp
 * case: the void drops that match out of the bracket read
 * (assignPositionsAndPoints selects `status in ('completed','walkover')`), so
 * the champion it crowned is no longer derivable from anything, yet the placing
 * sits there unless something recomputes.
 *
 * That is not hypothetical and needs no race: complete an event, void the
 * final, and the voided winner keeps first place, the points and the trophy.
 * Recomputing is only HALF the answer there, though, and the sharper half is
 * inside recomputeEventStandings: with the final's result gone, the champion is
 * read off the round BELOW it, so a plain recompute would crown the semi-final
 * winner. It clears the event's standings instead and says so, which is what
 * `championUndetermined` reports back here.
 * The correction path (editMatchResultImpl) already learned this lesson and
 * fixed it for itself; void, restore, undo and slot editing were left with the
 * same hole. This is that fix, shared, so the set stays closed —
 * results-recompute-coverage.test.ts asserts every caller of the gate is also a
 * caller of this.
 *
 * No-ops on an event that is not completed: recomputeEventStandings returns an
 * empty result unless `status === 'completed'`, so the live-event paths pay one
 * cheap read and change nothing.
 *
 * Call it AFTER the audit row, never before, so the corrective action is on
 * record even when this throws.
 *
 * AND CALL IT IN A `try`, WITH revalidateEventPaths IN THE `finally`. Every
 * caller runs this after its own corrective write has already committed, so a
 * throw here is a report, not a rollback.
 *
 * THE TWO ExpectedErrors BELOW ARE NOT WHAT THE `finally` IS FOR. Both require
 * `moved.length > 0`, so recomputeEventStandings has already returned by the
 * time either is raised, and it calls revalidateEventPaths itself on the line
 * before that return: the champion-undetermined and bonuses-already-paid
 * branches always refreshed the page. What the `finally` closes is every throw
 * EARLIER inside recomputeEventStandings (finalize.ts), all of which sit above
 * that line and so never reach it: the capability check, the event read, the
 * placings read, the results fingerprint, the field fence refusing, and
 * anything championIsUndetermined or assignPositionsAndPoints raises. On those
 * the corrective write HAS landed, the exec gets an error toast, and the page
 * behind the dialog still shows the pre-correction bracket.
 *
 * revalidateEventPaths only marks paths stale, so the duplicate call on the
 * branches that already refreshed costs nothing. Note this is a screen-freshness
 * fix only: a second result entered off a stale page is refused by the
 * compare-and-swap in enterMatchResultImpl regardless.
 */
async function recomputeStandingsAfterCorrection(eventId: string, lead: string): Promise<void> {
  const standings = await recomputeEventStandings(eventId);
  if (standings.moved.length === 0) return;

  // ONE THROW, NOT TWO. Both of these are reports, not failures — the
  // corrective action and the placement writes have already landed — so a
  // second ExpectedError after the first would simply never be seen. The two
  // sentences are composed instead.
  const bonusNote = standings.bonusesAlreadyPaid
    ? ' Placement bonuses for this event were already paid; they went straight into the players\' ratings and nothing here can take them back — adjust them from Ratings if they matter.'
    : '';

  if (standings.championUndetermined) {
    throw new ExpectedError(
      `${lead}, and it was the match that decided this event — so the final positions and points have been cleared. ` +
      'Nobody holds a placing for this event until it is finalised again.' + bonusNote,
    );
  }

  if (standings.bonusesAlreadyPaid) {
    // Positions and points are already fixed at this point — this is not a
    // failure, it is the one part a human still has to settle. Same policy the
    // correction path has always had; deliberately NOT a second one.
    throw new ExpectedError(
      `${lead} and the final positions and points have been recalculated, but ${standings.moved.length} placing changed on an event whose placement bonuses were already paid. ` +
      'Those bonuses went straight into the players\' ratings and nothing here can take them back — adjust them from Ratings if they matter.',
    );
  }
}

/** The legacy formats' score checks, as enterMatchResult has always applied them. */
function assertLegacyScoreline(
  match: Record<string, unknown>,
  event: Record<string, unknown>,
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b',
  timeExceeded: boolean,
): void {
  // The event's typed shape wins over the match_format enum when it has one
  // (00046) — a pool run at 1 game to 15 must reject a 21-19 that the enum
  // fallback would have waved through.
  //
  // AND THE MATCH'S OWN SHAPE WINS OVER THE EVENT'S (00108). A draw played
  // 11s / 15s / 21s / best-of-3 as it narrows has a different legal-score rule
  // in every round, and this is the call site that decides. ScoreEntryDialog
  // resolves the same way from the same function, so the dialog and the server
  // cannot disagree about whether 21-19 is a possible first-round game.
  const shape = resolveMatchShape(match as MatchShapeOverride, event as unknown as EventMatchShape);
  const matchFormat = shape.match_format as TournamentMatchFormat;
  const games = shape.games_per_match ?? null;
  const points = shape.points_per_game ?? null;
  const shapeLabel = describeMatchShape(shape);
  const maxGames = getEventRules(shape).bestOf;
  if (scores.length > maxGames) {
    throw new ExpectedError(`Too many games for ${shapeLabel}. Max: ${maxGames}`);
  }

  // Same scoring rules challenges get (00030): a game is won by reaching the
  // target with a two-point margin or by taking the cap, and a best-of-N stops
  // the moment someone clinches. Previously tournaments only checked the number
  // of games, so an impossible 21-20 — or a 3-0 best-of-3 — was accepted here
  // even though the identical result was rejected on the challenge path.
  //
  // timeExceeded relaxes the first of those rules only (00047): the exec called
  // time on a game that had not finished, so it owes nothing to the target or
  // the margin — but it still needs a winner and still cannot exceed the cap.
  // This check, not the dialog's toggle, is what enforces it: the toggle is a
  // client-supplied boolean like the scores themselves, so it decides which
  // rules apply here rather than deciding anything on its own.
  for (const g of scores) {
    // Typed format (games/points) decides the rules; timeExceeded decides
    // WHICH rules — a match cut short is bounded by the cap alone.
    if (!isLegalGameScore(g.a, g.b, matchFormat, games, points, timeExceeded)) {
      throw new ExpectedError(
        timeExceeded
          ? `Not a possible score even for a match cut short: ${g.a}-${g.b}`
          : `Not a possible score for ${shapeLabel}: ${g.a}-${g.b}. If the clock ran out mid-game, mark the match time exceeded.`,
      );
    }
  }
  // The clinch rule is untouched by the clock. A best-of-3 called at 1-0 has no
  // winner to record, however the games themselves ended.
  const aGames = scores.filter((g) => g.a > g.b).length;
  const bGames = scores.filter((g) => g.b > g.a).length;
  if (!isLegalGameCount(Math.max(aGames, bGames), Math.min(aGames, bGames), matchFormat, games)) {
    throw new ExpectedError(
      `${aGames}-${bGames} is not a possible result for ${shapeLabel} — the match ends once a side clinches.`
    );
  }

  // ...and the declared winner has to be the side that won those games. The
  // count check above passes for a legal 2-0 no matter WHO the caller then names
  // as the winner.
  assertWinnerMatchesScores(scores, winnerSide);
}

/** The rules a staged match is judged by, or a refusal when its stage has gone from the config. */
function stagedRulesFor(match: Record<string, unknown>, event: Record<string, unknown>): MatchRules {
  const rules = stagedMatchRules(
    parseFormatConfig(event.format_config),
    match as { stage?: number | null; handicap_a?: number | null; handicap_b?: number | null },
  );
  if (!rules) {
    throw new ExpectedError('This match\'s stage is not in the event\'s stages any more, so its score cannot be checked.');
  }
  return rules;
}

/**
 * A staged scoreline: every game legal under the stage's rules from the row's
 * head starts (cut short when the clock ran out), the match clinched, and the
 * declared winner the side that won it.
 */
function assertStagedScoreline(
  rules: MatchRules,
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b',
  timeExceeded: boolean,
): void {
  const verdict = validateMatch(scores, rules, { cutShort: timeExceeded });
  if (!verdict.ok) throw new ExpectedError(verdict.error);
  assertWinnerMatchesScores(scores, winnerSide);
}

async function enterMatchResultImpl(
  matchId: string,
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b',
  timeExceeded: boolean
): Promise<{ autoCall: AutoCallReport } | undefined> {
  const admin = await requireCapability('tournaments.results.enter.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'pending' && match.status !== 'ready' && match.status !== 'live') {
    throw new Error('Match is not in a playable state');
  }

  const event = match.event as Record<string, unknown>;
  await assertTournamentNotSuspended(adminClient, event.tournament_id as string);
  // The event must actually be under way. match.status alone does not say so:
  // a match is created 'pending' the moment the bracket is generated, which is
  // one step BEFORE the event goes live (registration -> checkin ->
  // bracket_generated -> live). Without this, results could be recorded — and
  // Elo applied — for a tournament that had not started.
  //
  // eventIsPlaying, NOT `=== 'live'` (00107). THIS IS THE ONE-WORD CONDITION
  // THAT WOULD HAVE KILLED THE POOL-TO-BRACKET FORMAT END TO END: its round
  // robin is played at `pool_live`, so left as it was, every pool score anybody
  // tried to enter would have come back "Start the event before entering
  // results" on an event that was visibly running. No type check and no test of
  // the generators would have caught it. For the other two formats
  // eventIsPlaying is exactly `=== 'live'`.
  if (!eventIsPlaying(event.status as string)) {
    throw new ExpectedError(
      event.status === 'completed'
        ? 'This event is finished. Edit the result instead of entering a new one.'
        : 'Start the event before entering results.',
    );
  }

  // A STAGED MATCH (00272) is judged by its stage's scoring and the head starts
  // snapshotted on the row, through the same shared validateMatch the dialog
  // uses. Not on top of the legacy checks: a group game to 15 without win by
  // two ends 15-14, which the legacy shape refuses.
  if (match.stage != null) {
    assertStagedScoreline(stagedRulesFor(match, event), scores, winnerSide, timeExceeded);
  } else {
    assertLegacyScoreline(match, event, scores, winnerSide, timeExceeded);
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Determine winner and loser IDs
  let winnerIdField: string;
  let loserIdField: string;
  let winnerId: string;
  let loserId: string;

  if (doubles) {
    winnerId = winnerSide === 'a' ? match.pair_a_id : match.pair_b_id;
    loserId = winnerSide === 'a' ? match.pair_b_id : match.pair_a_id;
    winnerIdField = 'winner_pair_id';
    loserIdField = 'loser_pair_id';
  } else {
    winnerId = winnerSide === 'a' ? match.participant_a_id : match.participant_b_id;
    loserId = winnerSide === 'a' ? match.participant_b_id : match.participant_a_id;
    winnerIdField = 'winner_participant_id';
    loserIdField = 'loser_participant_id';
  }

  // Update match
  // time_exceeded rides along with the scores it explains (00047) — without it
  // on the row, a later reader cannot tell a called-for-time 15-2 from a typo.
  //
  // Conditional on the status this request READ, which makes the write a
  // compare-and-swap rather than a blind overwrite. Two desks entering the same
  // match at once both passed the playable-status check above against the same
  // row; without this, both write a result and both go on to rate it, and the
  // loser of that race only finds out inside the rating RPC — with a result
  // already stamped over the winner's. The count is how the loser finds out
  // here instead, because PostgREST reports "matched no rows" as success.
  const update = adminClient.from('tournament_matches').update({
    scores,
    time_exceeded: timeExceeded,
    [winnerIdField]: winnerId,
    [loserIdField]: loserId,
    status: 'completed',
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status)
    // The OCCUPANTS as well as the status, because status alone admits an ABA.
    // Another desk can clear a slot (ready -> pending), put a different entry in
    // it (pending -> ready), and the status this request read is true again — so
    // the stale write lands, stamping a winner who is no longer in the match.
    // The bracket then holds one pair of names and the result holds another, and
    // finalizeEvent trusts the result fields without ever reading the slots.
    ;
  const { error, count } = await matchSlotFilter(update, match, doubles);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (count === 0) {
    throw new ExpectedError(
      'This match changed while you were entering the result — most likely another desk got there first. Reload and check before entering it again.',
    );
  }

  // Apply Elo before advancing — advancing can settle the next match too (if
  // the opponent waiting there has since withdrawn), and those ratings must
  // build on this one.
  //
  // The result row above is already written, because rating reads the winner and
  // loser off it. If rating then fails — a missing ratings row is the case that
  // actually happens — the match would be left completed and unrated, and the
  // guard at the top of this function refuses anything that is not
  // pending/ready/live, so no retry could reach it. undoDecidedResult takes the
  // result back off and rethrows, leaving a match the desk can simply re-enter.
  // Nothing has advanced yet, so there is nothing downstream to unwind.
  try {
    await applyTournamentMatchElo(matchId);
  } catch (err) {
    await undoDecidedResult(adminClient, matchId, match, err);
  }

  // Advance winner to next match (single elimination only). Advancing can also
  // settle that match outright — the opponent waiting there may have withdrawn
  // since the draw was published.
  await advanceWinner(adminClient, match, doubles, winnerId, admin.id);

  // ...and the loser into the third-place playoff, if this is a semi-final in an
  // event that has one. A no-op everywhere else — loser_to_match_id is null.
  await advanceLoser(adminClient, match, doubles, loserId, admin.id);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_entered',
    performed_by: admin.id,
    details: { scores, winner_side: winnerSide, time_exceeded: timeExceeded },
  });

  // Notify both players of match result
  const matchPlayerIds: string[] = [];
  if (doubles) {
    for (const pairId of [match.pair_a_id, match.pair_b_id].filter(Boolean)) {
      const { data: pair } = await adminClient.from('tournament_pairs').select('player1_id, player2_id').eq('id', pairId).single();
      if (pair) { matchPlayerIds.push(pair.player1_id, pair.player2_id); }
    }
  } else {
    for (const pid of [match.participant_a_id, match.participant_b_id].filter(Boolean)) {
      const { data: p } = await adminClient.from('tournament_participants').select('player_id').eq('id', pid).single();
      if (p) matchPlayerIds.push(p.player_id);
    }
  }
  await notifyPlayers(adminClient, matchPlayerIds,
    'Match Result Confirmed',
    `Your match result has been recorded. Score: ${scores.map((s: { a: number; b: number }) => `${s.a}-${s.b}`).join(', ')}`,
    // The parent id as well as the event and the match. A notification route in
    // the members' app is /tournaments/<tournament>/events/<event>, so a payload
    // without it cannot be turned into a link. This was the ONE producer that
    // omitted it — brackets.ts and finalize.ts have always written both — which
    // is why /notifications still carries a back-fill query for the rows written
    // before this line existed. The value was already to hand: it is what
    // logAudit is given twenty lines above and revalidateEventPaths four below.
    { tournament_id: event.tournament_id as string, match_id: matchId, event_id: match.event_id },
    'tournament_match_result'
  );

  // A staged result puts the next match on every free court, the freed one
  // first, after advancing so a semi-final it just filled can be called too.
  // The result is saved whatever happens here; a failure is reported back.
  let autoCall: AutoCallReport | undefined;
  if (match.stage != null && event.format === 'staged') {
    try {
      autoCall = (await fillFreeCourts(adminClient, {
        event: event as unknown as AutoCallEvent,
        actorId: admin.id,
        trigger: 'result',
        preferCourtId: (match.court_id as string | null) ?? null,
      })) ?? undefined;
    } catch (err) {
      Sentry.captureException(err);
      autoCall = { called: [], failed: [{ court: null, reason: err instanceof Error ? err.message : 'Unknown error' }] };
    }
  }

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
  return autoCall ? { autoCall } : undefined;
}

async function enterWalkoverImpl(
  matchId: string,
  winnerPosition: 'a' | 'b',
  reason: string
) {
  const admin = await requireCapability('tournaments.results.walkover.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  // Same guard as enterMatchResult — without it, re-running a walkover on an
  // already-decided match applies a second Elo delta and overwrites the
  // elo_snapshot, making the first delta permanently irreversible.
  if (match.status !== 'pending' && match.status !== 'ready' && match.status !== 'live') {
    throw new Error('Match is not in a playable state');
  }

  const event = match.event as Record<string, unknown>;
  await assertTournamentNotSuspended(adminClient, event.tournament_id as string);
  // The event must actually be under way. match.status alone does not say so:
  // a match is created 'pending' the moment the bracket is generated, which is
  // one step BEFORE the event goes live (registration -> checkin ->
  // bracket_generated -> live). Without this, results could be recorded — and
  // Elo applied — for a tournament that had not started.
  //
  // eventIsPlaying, NOT `=== 'live'` (00107). THIS IS THE ONE-WORD CONDITION
  // THAT WOULD HAVE KILLED THE POOL-TO-BRACKET FORMAT END TO END: its round
  // robin is played at `pool_live`, so left as it was, every pool score anybody
  // tried to enter would have come back "Start the event before entering
  // results" on an event that was visibly running. No type check and no test of
  // the generators would have caught it. For the other two formats
  // eventIsPlaying is exactly `=== 'live'`.
  if (!eventIsPlaying(event.status as string)) {
    throw new ExpectedError(
      event.status === 'completed'
        ? 'This event is finished. Edit the result instead of entering a new one.'
        : 'Start the event before entering results.',
    );
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Computed here only to validate the target before delegating. A half-filled
  // match is a legitimate walkover target — it is how an admin pushes a lone
  // semi-finalist forward when the other side of the draw died (voided
  // quarter-final, both-skip branch). So an EMPTY OPPOSITE side is fine; an
  // empty WINNING side is not, and used to write a null winner and then
  // "advance" that null into the next round.
  //
  // An unopposed walkover stays unrated on purpose: applyTournamentMatchElo
  // bails when either side is missing, so no delta and no elo_snapshot is
  // written. Rating someone for a match nobody turned up to would be free Elo.
  const winnerId = (doubles
    ? (winnerPosition === 'a' ? match.pair_a_id : match.pair_b_id)
    : (winnerPosition === 'a' ? match.participant_a_id : match.participant_b_id)) as string | null;

  if (!winnerId) {
    throw new ExpectedError('That side of the match is empty — there is nobody to award the walkover to.');
  }

  // The row write, Elo and advancement all live in recordWalkover so that a
  // withdrawal-driven forfeit and a manually entered walkover cannot drift
  // apart — they are the same event with different triggers.
  //
  // A BOUNDED PHRASE ON THE ROW, THE EXEC'S SENTENCE IN THE PRIVATE TABLE.
  // `tournament_matches` is published to supabase_realtime and replication
  // ignores column grants, so anything passed here reaches every phone watching
  // the bracket. See PUBLIC_WALKOVER_REASONS.
  await recordWalkover(adminClient, match, doubles, winnerPosition, DESK_WALKOVER_REASON, admin.id);

  // AFTER THE WALKOVER, BEFORE THE AUDIT, AND IT DOES NOT THROW — the same
  // order and the same reasoning as voidMatchImpl above. By this line the match
  // is stamped, rated and the winner advanced; throwing on an annotation would
  // skip logAudit and leave an unaudited walkover.
  const note = await writePrivateNote(
    adminClient, TOURNAMENT_MATCH_NOTES, matchId, reason, admin.id,
  );
  if (note.error) {
    Sentry.captureException(new Error(`Walkover note not recorded: ${note.error}`), {
      extra: { matchId, action: 'enter_walkover' },
    });
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'walkover_entered',
    performed_by: admin.id,
    // `reason` stays in the audit row regardless, so a note that did not land
    // (a database without 00118) is degraded rather than lost.
    details: { winner_position: winnerPosition, reason, note_recorded: note.recorded },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

/**
 * The void was overtaken. Say by WHAT, then refuse.
 *
 * One extra read on a path that only runs when a guarded write matched nothing,
 * bought because "this changed, reload" is not a message the desk can act on and
 * the three things that can have changed have three different remedies. Undoing
 * a result, re-voiding, and simply reloading are not interchangeable at 9pm with
 * a queue of matches waiting for a court.
 *
 * Not exported: this is a 'use server' module, where every export must be an
 * async server action.
 */
async function refuseOvertakenVoid(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  reversedElo: boolean,
): Promise<never> {
  // A failed read here must not turn a refusal into anything else, so `now` is
  // simply absent and the generic refusal below stands.
  const { data: now } = await adminClient.from('tournament_matches')
    .select('status, elo_snapshot')
    .eq('id', matchId)
    .maybeSingle();

  // THE ONE THAT IS A FAULT, not a refusal, and it is the same trade
  // editMatchResult makes and reports in the same words. We found a snapshot,
  // reversed it, and then could not void: the delta is off the ladder for a match
  // that still reads as decided. Nothing here can put it back — reversal is
  // idempotent per snapshot, not undoable — so this goes to Sentry as a plain
  // Error and names the row for the human who has to look at it.
  //
  // DEFENSIVE, and deliberately kept after being traced. No action in this
  // module can reach it today: getting here needs the row to still read
  // completed/walkover with a null snapshot after our reversal, and every
  // action that could move a settled match's status either refuses it
  // (enterWalkover, setMatchEntry) or writes a fresh snapshot in the same
  // breath (editMatchResult), which lands on the branch below instead. It
  // becomes live the moment a status write and its rating stop being one unit —
  // a re-rating RPC that fails after the status lands, which is a shape this
  // file's tests already model. Pinned by "reports the one outcome that is a
  // FAULT, not a refusal" in tournament-recovery.test.ts, whose comment says
  // why that test hand-writes the state instead of driving an action to it.
  if (
    reversedElo && now && now.elo_snapshot == null
    && (now.status === 'completed' || now.status === 'walkover')
  ) {
    throw new Error(
      `Match ${matchId} changed while it was being voided, so it was NOT voided — but its rating ` +
      `WAS already reversed. It now reads as decided and unrated. Reload the bracket and check it by hand.`,
    );
  }

  if (now?.elo_snapshot != null) {
    throw new ExpectedError(
      'A result was entered for this match while you were voiding it, and its rating is already on the ' +
      'ladder. Reload the bracket, undo that result, then void it.',
    );
  }
  if (now?.status === 'voided') {
    throw new ExpectedError('Another desk voided this match first — it is already voided.');
  }
  throw new ExpectedError(
    'This match changed while you were voiding it — its result or the entries in it are not what the ' +
    'bracket showed you. Reload and check it before voiding again.',
  );
}

async function voidMatchImpl(matchId: string, reason: string) {
  const admin = await requireCapability('tournaments.results.void.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  const event = match.event as Record<string, unknown>;

  // Same gate as entering a result or a walkover. Voiding a match in an event
  // that has not started is meaningless — there is nothing to undo — and it
  // was the one action in this module that skipped the check.
  assertEventResultsMutable(event, 'voiding matches');

  if (match.status === 'voided') {
    throw new ExpectedError('This match is already voided. Restore it if it needs to be played.');
  }
  // A bye is a bracket artefact, not a played match: it has no losing side and
  // its winner was placed there by the generator. Voiding one would strand that
  // entry with no route back into the draw.
  if (match.is_bye) {
    throw new ExpectedError('A bye is not a played match. Edit the next round\'s slots instead.');
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  await assertDownstreamUndecided(adminClient, match, 'void');

  // A voided match is unrated by definition — applyTournamentMatchElo refuses to
  // rate one. But voiding used to leave an already-applied delta sitting on the
  // players' ratings along with the elo_snapshot that produced it, so a voided
  // match still moved Elo and (for round robin, where nothing else notices) did
  // so invisibly. Reverse it here.
  //
  // Reversing is also what makes restore-and-replay safe: reverseEloSnapshot
  // clears elo_snapshot, and applyTournamentMatchElo returns early whenever a
  // snapshot is present, so a replayed match applies exactly one delta.
  const reversedElo = Boolean(match.elo_snapshot);
  if (reversedElo) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // Take the voided match's winner back out of the next round, and its loser
  // back out of the third-place playoff. Leaving either parked is how a bracket
  // ends up advertising a match between a real player and a result that has
  // been erased.
  const cleared = await clearAdvancedEntries(adminClient, match, doubles);

  // Scores and winner/loser are deliberately kept: a voided match is excluded
  // from standings, finalisation and Elo by status alone, and keeping the row
  // intact means the audit trail and the bracket still show what was erased.
  // `notes` is deliberately NOT set here any more — it moved to
  // tournament_match_notes (00118). 00113 published `tournament_matches`, so
  // this reason used to stream verbatim to every subscriber of the live
  // bracket, on top of being readable off the row by any signed-in member.
  //
  // THREE CONDITIONS, NOT ONE, AND THE COUNT IS HOW WE FIND OUT. This write used
  // to name the id alone, and PostgREST reports "matched no rows" as SUCCESS
  // while supabase-js RESOLVES rather than rejects — so the loser of a race
  // walked straight on and wrote an audit row claiming things it had not done.
  //
  //   .eq('status', …)         The status this request READ. Another desk
  //                            entering a result on a match we read as `ready`
  //                            left it `completed`, rated and advanced; the
  //                            void then stamped `voided` over the top, and the
  //                            audit row truthfully reported reversed_elo:false
  //                            while the delta sat on the ladder and the winner
  //                            sat in the next round. tournament-withdrawal.ts
  //                            documents that exact row shape as a redraw
  //                            blocker — this is where it came from.
  //
  //   .is('elo_snapshot', …)   NO RATING ON THE LADDER, and it is unconditional
  //                            because it means the same thing in both
  //                            directions. Read a null snapshot: assert none
  //                            appeared under us. Read one and reversed it:
  //                            reverse_tournament_match_rating (00078) nulls it
  //                            in the same transaction, so asserting null asserts
  //                            OUR reversal is still the last word. The status
  //                            alone cannot catch the second case —
  //                            editMatchResult reverses, re-rates and leaves the
  //                            status on `completed`, so a void of a
  //                            completed-but-unrated match would pass a status
  //                            check and still void a rated row.
  //
  //   matchSlotFilter          The occupants, because status alone admits an ABA
  //                            (see the helper). Voiding "Alice v Bob" after it
  //                            has quietly become "Alice v Carol" erases a
  //                            fixture nobody looked at.
  //
  // NOT MOVED ABOVE THE REVERSAL, which is the obvious alternative and is wrong
  // here. Claiming the row first would mean a failed reversal leaves a match
  // reading `voided` with its delta still applied — the very row shape above —
  // and two existing tests pin the current order as deliberate: "leaves every
  // rating and the snapshot untouched when the reversal fails" asserts the match
  // is still `completed` afterwards, and "reverses exactly once when the void is
  // retried" depends on that, since a voided match refuses a second void. The
  // ordering costs nothing in the race this closes: when the snapshot we read is
  // null, `reversedElo` is false and NOTHING irreversible has run by this line.
  // clearAdvancedEntries has, but each of its writes is individually conditional
  // on the slot still holding this match's entry, and it reports what it cleared.
  const voidUpdate = adminClient.from('tournament_matches').update({
    status: 'voided',
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status)
    .is('elo_snapshot', null);
  const { error: voidError, count: voidCount } = await matchSlotFilter(voidUpdate, match, doubles);

  if (voidError) {
    Sentry.captureException(voidError);
    throw new Error(voidError.message);
  }
  if (voidCount === 0) {
    await refuseOvertakenVoid(adminClient, matchId, reversedElo);
  }

  // AFTER THE VOID, BEFORE THE AUDIT, AND IT DOES NOT THROW — the order is the
  // point. The match is already voided and the Elo already reversed by the time
  // this runs, so throwing on a note failure would skip logAudit and
  // revalidateEventPaths and leave an UNAUDITED VOID: no record of who did it
  // or why, and a bracket still showing the match as it was.
  const note = await writePrivateNote(
    adminClient, TOURNAMENT_MATCH_NOTES, matchId, reason, admin.id,
  );
  if (note.error) {
    Sentry.captureException(new Error(`Void note not recorded: ${note.error}`), {
      extra: { matchId, action: 'void_match' },
    });
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'match_voided',
    performed_by: admin.id,
    details: {
      // Recorded here regardless, so a note that did not land is degraded
      // rather than lost.
      reason,
      // WHAT ACTUALLY HAPPENED: false means 00118 is not applied here yet.
      note_recorded: note.recorded,
      reversed_elo: reversedElo,
      cleared_next_slot: cleared.winner,
      cleared_third_place_slot: cleared.loser,
    },
  });


  // Redo the placings this just invalidated. No-ops unless the event is
  // completed; see recomputeStandingsAfterCorrection.
  try {
    await recomputeStandingsAfterCorrection(match.event_id as string, 'The match was voided');
  } finally {
    revalidateEventPaths(event.tournament_id as string, match.event_id as string);
  }
}

// ============================================================
// Double no-show — nobody turned up
// ============================================================
//
// enterWalkover is typed `winnerPosition: 'a' | 'b'`, so it cannot express
// "neither side came". Before this, the desk had to do three separate things in
// the right order — mark both participants no_show, void the match, then walk
// the survivor of the OTHER half into the next round — and stopping halfway
// left both players flagged while the match still advertised READY.
//
// Doing it as one action also lets the audit row say what actually happened.
// A voided match records only "voided": nothing distinguishes "nobody came"
// from "the score was entered against the wrong pair".
async function recordDoubleNoShowImpl(matchId: string, reason: string) {
  const admin = await requireCapability('tournaments.results.doublenoshow.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();
  if (!match) throw new ExpectedError('Match not found');

  const event = match.event as Record<string, unknown>;
  assertEventResultsMutable(event, 'recording a no-show');

  if (match.status === 'completed' || match.status === 'walkover') {
    throw new ExpectedError('This match already has a result. Undo it first.');
  }
  if (match.status === 'voided') {
    throw new ExpectedError('This match is already voided.');
  }
  // A bye has one real side by construction; "nobody came" cannot describe it.
  if (match.is_bye) {
    throw new ExpectedError('A bye is not a played match.');
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) as string | null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) as string | null;

  // Both sides must actually be known. One empty side is not a double no-show —
  // it is an unopposed walkover, and routing it here would mark a phantom
  // entry absent and deny the present player their advance.
  if (!aId || !bId) {
    throw new ExpectedError(
      'Only one side is filled — award the walkover to whoever turned up instead.',
    );
  }

  await assertDownstreamUndecided(adminClient, match, 'record a no-show');

  // Unplayed, so unrated. If a result had already been applied, its delta is
  // still sitting on the players' ratings — reverse it for the same reason
  // voiding does, or the match keeps moving Elo after being erased.
  const reversedElo = Boolean(match.elo_snapshot);
  if (reversedElo) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // `notes` moved to tournament_match_notes (00118) — see voidMatchImpl above.
  //
  // CLAIMED BEFORE ANYBODY IS MARKED ABSENT, which is where this differs from
  // voidMatchImpl's ordering. The two writes below are not bookkeeping: marking
  // both entries `no_show` is the half that feeds check_noshow_threshold, which
  // auto-flags a member at 3 and auto-suspends at 5. Running them first meant a
  // no-show that was then REFUSED still pushed two members a third of the way to
  // a suspension for a match they were never recorded as missing. Reversing the
  // order costs nothing: everything after this line is conditional on having won
  // the row.
  //
  // CONDITIONED EXACTLY AS voidMatchImpl'S WRITE IS, and for the same reason:
  // this is the same erasure by another name. It read the status, reversed the
  // rating if there was a snapshot, and then wrote on the id alone — so a
  // result entered by another desk in between was voided anyway, with
  // `reversed_elo` in the audit row reporting on a snapshot that no longer
  // described the match. The three conditions are argued in full above
  // voidMatchImpl's write; the short version is that the status catches the
  // concurrent second erasure, `elo_snapshot IS NULL` catches editMatchResult
  // re-rating underneath (which leaves the status on `completed` and so is
  // invisible to a status check), and matchSlotFilter catches the A-B-A where
  // the occupants changed and the status came back to where it started.
  const noShowUpdate = adminClient.from('tournament_matches').update({
    status: 'voided',
    winner_participant_id: null,
    winner_pair_id: null,
    loser_participant_id: null,
    loser_pair_id: null,
    scores: null,
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status)
    .is('elo_snapshot', null);
  const { error: noShowError, count: noShowCount } = await matchSlotFilter(noShowUpdate, match, doubles);

  if (noShowError) {
    Sentry.captureException(noShowError);
    throw new Error(noShowError.message);
  }
  // Shares voidMatchImpl's refusal wording. It says "voiding", which is what a
  // double no-show does to the match — and the remedies it distinguishes
  // ("undo that result first", "already voided", "reload") are the same three.
  if (noShowCount === 0) {
    await refuseOvertakenVoid(adminClient, matchId, reversedElo);
  }

  // Nobody advances. Anyone previously parked in the next round — or in the
  // third-place playoff — on the strength of this match comes back out.
  const cleared = await clearAdvancedEntries(adminClient, match, doubles);

  // Mark both entries absent. This is the half that feeds reliability —
  // check_noshow_threshold auto-flags at 3 and auto-suspends at 5 — and it is
  // the half most easily forgotten when doing this by hand.
  // FENCED — 00201. Still ONE statement covering both entries: the RPC updates
  // them together inside the field lock, so this cannot leave one side marked
  // and the other not. That matters more here than it looks — the no-show count
  // feeds check_noshow_threshold, which auto-flags at 3 and auto-suspends at 5.
  const { data: marked, error: entryErr } = await adminClient.rpc('mark_field_entries_no_show', {
    p_entry_ids: [aId, bId],
    p_is_pair: doubles,
  });
  if (entryErr) throw new Error(entryErr.message);
  const markedResult = marked as { ok: boolean; reason?: string } | null;
  if (!markedResult?.ok) {
    throw new Error(
      `Both entries could not be marked absent (${markedResult?.reason ?? 'unknown'}). The match was voided — reload and mark them from the draw.`,
    );
  }


  // After the match write, before the audit, and it does not throw. Same
  // reasoning as voidMatchImpl: both entries are already marked absent and the
  // Elo already reversed, so a note failure must not cost the audit row.
  const note = await writePrivateNote(
    adminClient, TOURNAMENT_MATCH_NOTES, matchId, reason, admin.id,
  );
  if (note.error) {
    Sentry.captureException(new Error(`No-show note not recorded: ${note.error}`), {
      extra: { matchId, action: 'double_no_show' },
    });
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    // Distinct from 'match_voided' on purpose — six months on, this is the only
    // thing that says the court was empty rather than the entry being wrong.
    action: 'match_double_no_show',
    performed_by: admin.id,
    details: {
      reason,
      note_recorded: note.recorded,
      reversed_elo: reversedElo,
      cleared_next_slot: cleared.winner,
      cleared_third_place_slot: cleared.loser,
      entries: [aId, bId],
    },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Recovery — restoring a voided match, editing draw slots
// ============================================================
//
// Voiding used to be a one-way door. A voided quarter-final can never be
// replayed (enterMatchResult only accepts pending/ready/live) and never
// advances anybody, so the semi-final it feeds sits on "TBD" forever and the
// event can never be finalised — finalizeEvent ignores voided matches but still
// counts the half-filled semi-final as incomplete. The two actions below are
// the way out: put the match back, or fill the orphaned slot by hand.

async function unvoidMatchImpl(matchId: string, reason: string) {
  const admin = await requireCapability('tournaments.results.unvoid.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'voided') {
    throw new ExpectedError('Only a voided match can be restored.');
  }

  const event = match.event as Record<string, unknown>;
  assertEventResultsMutable(event, 'restoring matches');

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) as string | null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) as string | null;

  // THE REASON THIS MATCH WAS VOIDED, READ BEFORE ANYTHING IS CHANGED.
  //
  // The restore below overwrites it with the restore reason — that is what the
  // single column did and what the single note row still does — so this is the
  // last moment it can be captured for the audit row, which is the only place
  // it survives afterwards.
  //
  // READ FIRST, BEFORE reverseEloSnapshot, deliberately. fetchPrivateNotes
  // throws on a genuine failure (it swallows only "no such table"), and every
  // line below this one mutates something. Doing it here means a failed read
  // costs the restore and nothing else; doing it lower would risk a reversed
  // Elo snapshot with no audit row to explain it.
  //
  // FALLS BACK TO THE LEGACY COLUMN, which 00118 copies but does not drop. That
  // covers a match voided by a build that predates this one, and it is why the
  // restore panel keeps quoting the right text in either deploy order. Remove
  // the fallback with the migration that drops tournament_matches.notes.
  const priorNotes = await fetchPrivateNotes(adminClient, TOURNAMENT_MATCH_NOTES, [matchId]);
  const voidReason = priorNotes.get(matchId) ?? (match.notes as string | null) ?? null;

  // Belt and braces for rows voided before voidMatch learned to reverse Elo:
  // their delta is still on the players' ratings and their snapshot is still on
  // the row. Reversing here is what stops the replay from counting the same
  // match a second time — applyTournamentMatchElo would otherwise refuse to run
  // at all (snapshot present), silently leaving the stale delta in place.
  const reversedElo = Boolean(match.elo_snapshot);
  if (reversedElo) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // Restore to a clean playable state rather than to the old result: an admin
  // restoring a void wants to play the match, and a half-restored row carrying
  // a stale winner would advance that winner again on the next edit.
  const resetData: Record<string, unknown> = {
    scores: null,
    // 'ready' asserts both sides are known. A match voided because one half of
    // the draw collapsed may still be missing a side.
    status: aId && bId ? 'ready' : 'pending',
    walkover_winner: null,
    walkover_reason: null,
    result_entered_by: null,
    result_entered_at: null,
    // `notes` moved to tournament_match_notes (00118) — written below, after
    // this update lands.
    updated_at: new Date().toISOString(),
  };

  if (doubles) {
    resetData.winner_pair_id = null;
    resetData.loser_pair_id = null;
  } else {
    resetData.winner_participant_id = null;
    resetData.loser_participant_id = null;
  }

  // STILL VOIDED. The check at the top of this function read the status; this
  // write did not name it, so between the two another desk could restore the
  // match and enter a result on it — and this reset would then stomp a
  // `completed` match back to `ready` with its winner and scores wiped, which is
  // item 20's failure by a different route. Only the status is pinned, not the
  // slots or the snapshot: a restore does not read the occupants, and a voided
  // row's snapshot is already null.
  const { error, count } = await adminClient.from('tournament_matches')
    .update(resetData, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', 'voided');

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (count === 0) {
    throw new ExpectedError(
      'This match is no longer voided — another desk restored it while you were restoring it. Reload the bracket.',
    );
  }

  // An empty restore reason CLEARS the note rather than storing '', which is
  // what `notes: reason || null` did on the column. The match is already back
  // in play by now, so this does not throw — same reasoning as voidMatchImpl.
  const note = await writePrivateNote(
    adminClient, TOURNAMENT_MATCH_NOTES, matchId, reason, admin.id,
  );
  if (note.error) {
    Sentry.captureException(new Error(`Restore note not recorded: ${note.error}`), {
      extra: { matchId, action: 'unvoid_match' },
    });
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'match_unvoided',
    performed_by: admin.id,
    details: {
      reason: reason || null,
      // Captured before the restore overwrote it, from the private table where
      // it now lives, falling back to the legacy column for older rows.
      void_reason: voidReason,
      note_recorded: note.recorded,
      // The discarded result only survives here, so record it.
      discarded_scores: match.scores,
      reversed_elo: reversedElo,
    },
  });


  // Redo the placings this just invalidated. No-ops unless the event is
  // completed; see recomputeStandingsAfterCorrection.
  try {
    await recomputeStandingsAfterCorrection(match.event_id as string, 'The match was restored');
  } finally {
    revalidateEventPaths(event.tournament_id as string, match.event_id as string);
  }
}

async function setMatchEntryImpl(
  matchId: string,
  side: 'a' | 'b',
  entryId: string | null,
  reason: string,
) {
  const admin = await requireCapability('tournaments.results.entry.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  const event = match.event as Record<string, unknown>;
  assertEventResultsMutable(event, 'editing the draw');

  // A decided match carries an elo_snapshot keyed to the entries that played
  // it. Swapping a side out from under that snapshot makes the recorded delta
  // unattributable, so the result has to come off first.
  if (match.status === 'completed' || match.status === 'walkover') {
    throw new ExpectedError('This match already has a result. Undo it before changing who is in it.');
  }
  if (match.status === 'voided') {
    throw new ExpectedError('This match is voided. Restore it before changing who is in it.');
  }
  if (match.is_bye) {
    throw new ExpectedError('A bye is filled by the draw, not by hand.');
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const field = entrySideField(side, doubles);
  const otherField = entrySideField(side === 'a' ? 'b' : 'a', doubles);
  const current = (match as Record<string, unknown>)[field] as string | null;
  const other = (match as Record<string, unknown>)[otherField] as string | null;

  if (entryId) {
    // Overwriting an occupied slot would quietly evict whoever earned it, so
    // make the removal an explicit second step.
    if (current && current !== entryId) {
      throw new ExpectedError('That slot is already filled. Clear it first, then set the new entry.');
    }
    if (entryId === other) {
      throw new ExpectedError('An entry cannot play itself.');
    }

    // The client sends an id from a list it rendered; re-check it here because
    // a stale page could offer an entry that has since left the event.
    const table = doubles ? 'tournament_pairs' : 'tournament_participants';
    const { data: entry } = await adminClient.from(table)
      .select('id, event_id, status')
      .eq('id', entryId)
      .maybeSingle();

    if (!entry || entry.event_id !== match.event_id) {
      throw new ExpectedError('That entry is not in this event.');
    }
    if (entry.status === 'withdrawn' || entry.status === 'disqualified') {
      throw new ExpectedError('That entry has withdrawn or been disqualified and cannot be placed in the draw.');
    }
  } else if (!current) {
    throw new ExpectedError('That slot is already empty.');
  }

  // CONDITIONAL ON THE STATUS AND ON BOTH SLOTS THIS REQUEST READ, and the count
  // is how the loser of a race finds out — PostgREST reports "matched no rows"
  // as SUCCESS and supabase-js resolves rather than rejects.
  //
  // The status condition is the one that matters most. Every guard above was
  // checked against a row that was read and then let go of, so a desk entering
  // the result of a match this request read as `ready` left it `completed`,
  // rated and advanced — and this write then stamped `ready` back over it with
  // the winner, the scores and the elo_snapshot all still on the row. The match
  // reads as unplayed to everything that counts it, so finalizeEvent's
  // "N match(es) still incomplete" refuses the event outright, and the only
  // record that a delta was applied is a column nothing looks at any more.
  //
  // BOTH SLOTS ARE PINNED NULL-AWARE rather than through matchSlotFilter, and
  // this is the one write where that difference is load-bearing. matchSlotFilter
  // SKIPS a null slot on the argument that filling an empty one moves the status
  // — true everywhere else, and false precisely here, because this action is
  // what computes the status FROM the slots: with the opposite side empty,
  // pending -> pending either way. So two desks filling the SAME empty slot both
  // read `pending`, both pass the "that slot is already filled" guard, and the
  // second silently evicts the first. `.is(col, null)` expresses "still empty",
  // which `.eq(col, null)` cannot — PostgREST renders that as `col=eq.null` and
  // SQL's NULL = NULL is unknown, so it would match nothing and report every
  // fill as a lost race.
  const pinSlot = <T extends { eq(c: string, v: string): T; is(c: string, v: null): T }>(
    q: T, column: string, value: string | null,
  ): T => (value == null ? q.is(column, null) : q.eq(column, value));

  const entryUpdate = adminClient.from('tournament_matches').update({
    [field]: entryId,
    // 'ready' is what the bracket reads to offer score entry, so it has to
    // track whether both sides are actually known.
    status: entryId && other ? 'ready' : 'pending',
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status);

  const { error, count } = await pinSlot(pinSlot(entryUpdate, field, current), otherField, other);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (count === 0) {
    throw new ExpectedError(
      'This match changed while you were editing the draw — a result was entered, or somebody else ' +
      'moved an entry into it. Reload the bracket and check it before editing again.',
    );
  }
  // A staged row's head starts belong to whoever is in it now (00272).
  if (match.stage != null) await refreshStagedHandicaps(adminClient, matchId, doubles);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: entryId ? 'match_entry_set' : 'match_entry_cleared',
    performed_by: admin.id,
    details: { side, previous_entry_id: current, entry_id: entryId, reason: reason || null },
  });


  // Redo the placings this just invalidated. No-ops unless the event is
  // completed; see recomputeStandingsAfterCorrection.
  try {
    await recomputeStandingsAfterCorrection(match.event_id as string, 'The draw was edited');
  } finally {
    revalidateEventPaths(event.tournament_id as string, match.event_id as string);
  }
}

// ============================================================
// Admin override — change a result that has already been resolved
// ============================================================
//
// WHAT WAS ACTUALLY BLOCKING THIS: nothing on the server. This function has
// existed since the schema did, it is exported from the tournament-actions
// barrel, and it was called by ZERO client code. The bracket's MatchCard gates
// both of its buttons on `!isCompleted`, so a completed or walkover match
// rendered a "Final" / "WALKOVER" label and no control at all. The only route to
// a correction was void → restore → re-enter, which throws the original result
// away and re-rates from scratch.
//
// So the fix is an affordance, not a relaxed rule. NO EXISTING GUARD IS
// WEAKENED. Two are TIGHTENED, because the new button makes reachable what was
// previously only reachable from a test:
//
//   * The downstream check is now assertDownstreamUndecided, the same one void
//     and undo use. The hand-rolled copy that lived here checked only
//     `status === 'completed'`, so a downstream WALKOVER — the shape a late
//     withdrawal produces — waved the edit straight through, and a semi-final
//     could be rewritten underneath a final that had already been forfeited and
//     rated. It also looked at winner_to_match_id alone, which since 00080
//     misses the third-place playoff entirely.
//
//   * The match must actually HAVE a result. This wrote winner/loser onto the
//     row unconditionally and then re-rated only if the status was already
//     decided — so "editing" a pending match stamped a winner on it, skipped the
//     rating, and left a match that reads as decided to every downstream reader
//     while enterMatchResult still considered it playable and would rate it.
//
// RATING REVERSAL GOES THROUGH reverse_tournament_match_rating (00078) AND
// NOWHERE ELSE. That is the one thing this function must never grow a shortcut
// for: reverseEloSnapshot is a thin wrapper over that RPC, the RPC clears the
// snapshot inside the same transaction as the deltas it subtracts, and a second
// hand-rolled reversal path is exactly how the double-reverse defect 00078
// documents came about. Reverse, then re-apply — never adjust in place.
//
// EXEC OR ADMIN, not admin-only, and that is a deliberate deviation worth
// stating. Every other corrective action in this module — void, undo, restore,
// slot editing, double no-show — sits in EXEC_ASSIGNABLE and in
// ROLE_DEFAULTS.tournaments, and the tournament desk runs as exec, not admin.
// (They were in EXEC_BASELINE, held by every officer, until that list narrowed
// to reads; the desk now needs the Tournaments job assigned, which is the same
// authority named rather than assumed.) An admin-only override would mean the person
// standing at the desk at 9pm with a wrong scoreline on the board cannot fix it,
// which is the situation this was asked for. What makes the override safe is not
// a narrower role but that it is EXPLICIT and AUDITED: it demands a typed
// reason, and the audit row carries the old AND new winner, the old AND new
// scores, and whether the rating was reversed and re-applied.
async function editMatchResultImpl(
  matchId: string,
  newScores: Array<{ a: number; b: number }>,
  newWinnerSide: 'a' | 'b',
  reason: string,
  opts?: { applyCurrentHeadStart?: boolean },
) {
  const admin = await requireCapability('tournaments.results.edit.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new ExpectedError('Match not found');

  const event = match.event as Record<string, unknown>;

  // Same gate the other corrective actions use. 'completed' is allowed, which is
  // the point — a finished event is exactly where a wrong result gets noticed.
  assertEventResultsMutable(event, 'changing a result');

  // There has to BE a result to change. A voided match has deliberately had its
  // result taken off and is restored, not edited; a pending one never had a
  // result at all, and stamping one here would bypass every score-legality check
  // enterMatchResult applies.
  if (match.status !== 'completed' && match.status !== 'walkover') {
    throw new ExpectedError(
      match.status === 'voided'
        ? 'This match is voided. Restore it and enter the result, rather than editing one that was erased.'
        : 'This match has no result yet — enter it rather than changing it.',
    );
  }

  // A BYE is status 'completed' with a winner the generator placed there and an
  // empty opposite side, so the status check above lets it straight through —
  // and "correcting" it would write a scoreline and a loser for a match nobody
  // played, then rate it. voidMatch and setMatchEntry both refuse a bye for the
  // same reason and point at the same remedy.
  if (match.is_bye) {
    throw new ExpectedError('A bye is not a played match. Edit the next round\'s slots instead.');
  }

  // The override is explicit by construction: it cannot be performed without
  // saying why, and the reason lands in the audit row below.
  if (!reason.trim()) {
    throw new ExpectedError('Give a reason — changing a result that is already recorded has to say why.');
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // "APPLY THE CURRENT HEAD START" (00279). A team whose category was changed
  // after it played keeps its recorded scores, judged by the starts the old
  // category gave. This re-snapshots ONE completed match's starts from the two
  // teams' categories now, and checks the corrected score against them. Only
  // `true` turns it on: a stray truthy value from the client is not a request.
  // Every refusal here comes before the downstream check and before anything
  // is reversed.
  let headStart: { handicap_a: number; handicap_b: number } | null = null;
  if (opts?.applyCurrentHeadStart === true) {
    if (match.stage == null) {
      throw new ExpectedError('Only a match in a staged event has a head start to apply.');
    }
    const stage = parseFormatConfig(event.format_config)?.stages[(match.stage as number) - 1];
    if (stage?.scoring.handicap !== true) {
      throw new ExpectedError('This match\'s stage is played without head starts.');
    }
    if (newScores.length === 0) {
      throw new ExpectedError('A walkover has no score for a head start to apply to.');
    }
    headStart = await currentStagedHeadStarts(adminClient, match, doubles);
    if (!headStart) {
      throw new ExpectedError('This match\'s two sides could not be read, so it has no current head start to apply.');
    }
  }

  // The integrity guard that STAYS. Rewriting a match underneath a later round
  // that has already been played would leave that later result recorded for an
  // entry which is no longer in this half of the draw — and, since 00080, would
  // do the same to a third-place playoff that has already been contested and
  // rated. The remedy is the one the message gives: undo the later match first.
  await assertDownstreamUndecided(adminClient, match, 'change this result');

  // Same integrity boundary as entering a result: correcting a match must not
  // be a way to award it to the side that lost every game. Only the winner /
  // score agreement is enforced here — the full legality checks stay off the
  // correction path on purpose, because this is the action an admin uses to
  // repair data that is already odd.
  //
  // A STAGED MATCH (00272) is the exception: its rules are the organiser's own
  // per stage, and a correction is checked against them like an entry is, with
  // the clock as the row recorded it. No scores is a walkover, which keeps its
  // forfeit and writes no scoreline.
  //
  // With the current head start applied, the score is checked against the
  // starts it is about to be recorded with, not the ones it replaces.
  if (match.stage != null && newScores.length > 0) {
    const judged = headStart ? { ...match, ...headStart } : match;
    assertStagedScoreline(stagedRulesFor(judged, event), newScores, newWinnerSide, match.time_exceeded === true);
  } else {
    assertWinnerMatchesScores(newScores, newWinnerSide);
  }

  const winnerId = doubles
    ? (newWinnerSide === 'a' ? match.pair_a_id : match.pair_b_id)
    : (newWinnerSide === 'a' ? match.participant_a_id : match.participant_b_id);
  const loserId = doubles
    ? (newWinnerSide === 'a' ? match.pair_b_id : match.pair_a_id)
    : (newWinnerSide === 'a' ? match.participant_b_id : match.participant_a_id);

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  // Read before anything moves, so the audit row can say what was replaced. The
  // match row is overwritten below, so this is the only moment the previous
  // winner and loser exist to be recorded.
  const priorWinnerId = routedEntryId(match, 'winner', doubles);
  const priorLoserId = routedEntryId(match, 'loser', doubles);

  // Reverse any prior Elo changes so we can recompute with the corrected winner.
  // reverseEloSnapshot is reverse_tournament_match_rating (00078) and nothing
  // else — one transaction, snapshot cleared alongside the deltas it subtracts,
  // idempotent on a retry. Never subtract by hand here.
  const reversedElo = Boolean(match.elo_snapshot);
  if (reversedElo) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // count: 'exact' because PostgREST reports "matched no rows" as SUCCESS, and
  // the filter on the status this request read makes the write a
  // compare-and-swap. The rating has already been reversed by this point, so a
  // write that silently matched nothing would leave the match carrying its
  // ORIGINAL scoreline with that scoreline's rating stripped off the ladder —
  // and the caller would be told the correction saved.
  // Correcting a WALKOVER with a real scoreline makes it a played match, and the
  // walkover fields have to go with it. Left alone, the row said status
  // 'walkover' with walkover_winner 'a' while winner_participant_id had just
  // become B — three fields disagreeing about who won, and the bracket renders
  // "⚠ WALKOVER" over a scoreline. Going the other way (clearing the scores to
  // hand the walkover to the other side) keeps the status and moves the
  // walkover_winner, which is the same correction expressed the other way round.
  const becomesPlayed = match.status === 'walkover' && newScores.length > 0;
  const staysWalkover = match.status === 'walkover' && newScores.length === 0;

  const update = adminClient.from('tournament_matches').update({
    scores: newScores.length > 0 ? newScores : null,
    [winnerField]: winnerId,
    [loserField]: loserId,
    ...(becomesPlayed
      ? { status: 'completed', walkover_winner: null, walkover_reason: null }
      : {}),
    ...(staysWalkover ? { walkover_winner: newWinnerSide } : {}),
    ...(headStart ?? {}),
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status)
    // The OCCUPANTS as well as the status, because status alone admits an ABA.
    // Another desk can clear a slot (ready -> pending), put a different entry in
    // it (pending -> ready), and the status this request read is true again — so
    // the stale write lands, stamping a winner who is no longer in the match.
    // The bracket then holds one pair of names and the result holds another, and
    // finalizeEvent trusts the result fields without ever reading the slots.
    ;
  const { error, count } = await matchSlotFilter(update, match, doubles);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (count === 0) {
    throw new Error(
      `Match ${matchId} changed while the correction was being saved, so nothing was written — but its ` +
      `previous rating WAS already reversed. Reload the bracket and check the result before saving again.`,
    );
  }

  // Re-route both sides. assertDownstreamUndecided has just guaranteed neither
  // destination has a result, so overwriting the slots outright is safe and is
  // what makes a flipped winner actually reach the next round. The loser half is
  // new with 00080: flipping a semi-final's winner also flips which entry belongs
  // in the third-place playoff, and leaving that slot alone would send the wrong
  // player out to play for third.
  for (const route of MATCH_ROUTES) {
    const target = routeOf(match, route);
    if (!target) continue;
    const entryId = route === 'winner' ? winnerId : loserId;
    if (!entryId) continue;
    await adminClient.from('tournament_matches')
      .update({ [entrySideField(target.side, doubles)]: entryId })
      .eq('id', target.nextId);
    await refreshStagedHandicaps(adminClient, target.nextId, doubles);
  }

  // Reapply Elo with the corrected winner. Walkovers count too — enterWalkover
  // applies Elo, so omitting them here reversed the delta above and never
  // restored it, permanently zeroing both sides' rating change. Voided matches
  // are refused outright by the status guard at the top, so the branch that used
  // to guard this call is gone rather than removed.
  //
  // A failure here cannot be compensated the way enterMatchResult's is. By this
  // point the OLD rating has already been reversed and the old scoreline it was
  // computed from has been overwritten, so there is nothing to put back — the
  // only route forward is forward. That is safe, and this is the one place worth
  // saying so out loud: the snapshot is null, so simply running the correction
  // again re-rates the match and cannot count it twice, and the status guard
  // above still accepts the retry because the match is still completed. Without
  // this message the exec is told "the rating failed" and left to guess whether
  // pressing Save again would double the delta.
  try {
    await applyTournamentMatchElo(matchId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${detail} — the corrected result for match ${matchId} WAS saved but is not yet rated. ` +
      `Save the same correction again to rate it; the previous rating is already reversed, ` +
      `so it cannot be counted twice.`,
    );
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_edited',
    performed_by: admin.id,
    // Old AND new, for every field this action can move. A correction that
    // changes who won is the most consequential thing in the console — it moves
    // two players' Elo, their win/loss record, their streak and their place in
    // the draw — and six months on this row is the only record that the board
    // ever said anything else.
    details: {
      reason,
      old_scores: match.scores,
      new_scores: newScores,
      old_winner_entry_id: priorWinnerId,
      new_winner_entry_id: winnerId,
      old_loser_entry_id: priorLoserId,
      new_loser_entry_id: loserId,
      new_winner_side: newWinnerSide,
      winner_changed: priorWinnerId !== winnerId,
      old_match_status: match.status,
      new_match_status: becomesPlayed ? 'completed' : match.status,
      reversed_elo: reversedElo,
      // Positions and points ARE redone now (see below); placement bonuses are
      // not, because they were added straight into the players' ratings and
      // there is no reversal for them.
      standings_recomputed: event.status === 'completed',
      event_was_finalised: event.status === 'completed',
      head_start_applied: headStart != null,
      ...(headStart
        ? {
            old_handicap: { a: match.handicap_a ?? 0, b: match.handicap_b ?? 0 },
            new_handicap: { a: headStart.handicap_a, b: headStart.handicap_b },
          }
        : {}),
    },
  });

  // Redo the standings the correction just invalidated.
  //
  // This used to be recorded as `standings_recomputed: false` and left there,
  // with the dialog telling the exec to "adjust those by hand" — which the
  // console cannot do: there is no editor for final_position or points. So a
  // corrected final left the old champion holding first place, 100 points and
  // the trophy while the bracket named somebody else.
  //
  // No-ops on an event that is not completed. Deliberately AFTER the audit row,
  // so the correction is on record even if this throws.
  try {
    await recomputeStandingsAfterCorrection(match.event_id as string, 'The result was corrected');
  } finally {
    revalidateEventPaths(event.tournament_id as string, match.event_id as string);
  }
}

// ============================================================
// Undo Match Result
// ============================================================

async function undoMatchResultImpl(matchId: string) {
  const admin = await requireCapability('tournaments.results.undo.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'completed' && match.status !== 'walkover') {
    throw new Error('Match has no result to undo');
  }

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Check no downstream matches have results
  await assertDownstreamUndecided(adminClient, match, 'undo');

  // Reverse Elo changes (both singles and doubles) from the snapshot persisted
  // at apply time. The snapshot is the ONLY reversal evidence, and that is a
  // complete answer rather than a gap: apply_tournament_match_rating writes the
  // snapshot in the SAME transaction as the ladder move (00070, and every
  // revision since), so a decided match with no snapshot is a match that was
  // never rated, and doing nothing here is exactly right.
  //
  // There used to be a fallback for "singles matches that pre-date the snapshot
  // column", which rewound both players to tournament_participants.elo_before.
  // It is gone, and could not have been kept:
  //
  //   * There is no such match. elo_snapshot is part of the baseline schema
  //     (00001_schema.sql), so no row in this database has ever been rated
  //     without one. Confirmed against production: zero decided singles matches
  //     with a null snapshot and both sides set.
  //   * elo_before is stamped at REGISTRATION. Rewinding to it does not undo
  //     this match, it undoes the player's whole event — every earlier round
  //     they won on the way here, erased, along with any club match rated in
  //     between. That is the defect, not a rough edge of it.
  //   * Since 00083 elo_after/elo_change are EVENT-level accumulators, so the
  //     `elo_after: null, elo_change: null` that went with it discarded the
  //     recorded swing of the event's other matches too.
  //
  // The branch was also unreachable in the one case it claimed to serve and
  // dangerous in one it did not: it fired on ANY snapshot-less decided singles
  // match, including one whose sibling round-robin match had legitimately moved
  // the ladder, and rewound the player for a match that never touched it.
  if (match.elo_snapshot) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // Remove the winner from the next match, and the loser from the third-place
  // playoff. Both, for the same reason voiding clears both: this match no longer
  // has a result, so neither entry has any claim on the slot it was routed into.
  await clearAdvancedEntries(adminClient, match, doubles);

  // Reset match itself
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) as string | null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) as string | null;
  const resetData: Record<string, unknown> = {
    scores: null,
    // Cleared with the scores it described — a match with no result cannot
    // still be claiming the clock ended it.
    time_exceeded: false,
    // 'ready' asserts both sides are known — not true when the undone result
    // was an unopposed walkover.
    status: aId && bId ? 'ready' : 'pending',
    walkover_winner: null,
    walkover_reason: null,
    result_entered_by: null,
    result_entered_at: null,
    updated_at: new Date().toISOString(),
  };

  if (doubles) {
    resetData.winner_pair_id = null;
    resetData.loser_pair_id = null;
  } else {
    resetData.winner_participant_id = null;
    resetData.loser_participant_id = null;
  }

  const { error } = await adminClient.from('tournament_matches')
    .update(resetData)
    .eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_undone',
    performed_by: admin.id,
    details: { previous_scores: match.scores },
  });


  // Redo the placings this just invalidated. No-ops unless the event is
  // completed; see recomputeStandingsAfterCorrection.
  try {
    await recomputeStandingsAfterCorrection(match.event_id as string, 'The result was undone');
  } finally {
    revalidateEventPaths(event.tournament_id as string, match.event_id as string);
  }
}

// ============================================================
// Public entry points
// ============================================================
// These return ActionResult rather than throwing. Next.js SANITISES errors
// thrown out of a Server Action in a production build — the client gets
// "An error occurred in the Server Components render", never the message. This
// module threw for everything, so every guard in it was invisible in prod: a
// user entering a score before the event went live saw an opaque red banner
// instead of "Start the event before entering results."
//
// runAction also keeps ExpectedError out of Sentry, so a refused-but-normal
// action stops being filed as a fault.
export async function enterMatchResult(
  matchId: string,
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b',
  // Defaults to false so the strict rules stay the default everywhere — an
  // older caller, or one that simply forgets, gets the pre-00047 behaviour.
  timeExceeded = false,
): Promise<ActionResult<{ autoCall: AutoCallReport } | undefined>> {
  return runAction(() => enterMatchResultImpl(matchId, scores, winnerSide, timeExceeded));
}

export async function enterWalkover(
  matchId: string,
  winnerPosition: 'a' | 'b',
  reason: string,
): Promise<ActionResult<void>> {
  return runAction(async () => { await enterWalkoverImpl(matchId, winnerPosition, reason); });
}

export async function voidMatch(matchId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(async () => { await voidMatchImpl(matchId, reason); });
}

export async function undoMatchResult(matchId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await undoMatchResultImpl(matchId); });
}

// Change a result that is already recorded, without voiding it first.
//
// Wrapped in runAction like everything else in this module, and that is not
// cosmetic here: this action's guards are the ones an exec most needs to READ.
// Next.js sanitises anything thrown out of a Server Action in a production
// build, so while editMatchResult threw, "the third-place match already has a
// result, undo that one first" reached the browser as "An error occurred in the
// Server Components render" — a refusal indistinguishable from a crash, on the
// one path where knowing which is which decides what the exec does next.
export async function editMatchResult(
  matchId: string,
  newScores: Array<{ a: number; b: number }>,
  newWinnerSide: 'a' | 'b',
  reason: string,
  opts?: { applyCurrentHeadStart?: boolean },
): Promise<ActionResult<void>> {
  return runAction(async () => { await editMatchResultImpl(matchId, newScores, newWinnerSide, reason, opts); });
}

// Put a voided match back into play. Pairs with voidMatch: both reverse any Elo
// the match applied, so a void → restore → replay cycle counts the match once.
export async function recordDoubleNoShow(matchId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(async () => { await recordDoubleNoShowImpl(matchId, reason); });
}

export async function unvoidMatch(matchId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(async () => { await unvoidMatchImpl(matchId, reason); });
}

// ============================================================
// What the result did to the two entrants — READ ONLY
// ============================================================
//
// "once a game is scored, show a summary". The figures are THIS EVENT's, not a
// career: tournament_participants carries elo_before / elo_after / elo_change /
// points / final_position per entrant per event, and elo_change accumulates
// across the event's rounds (00083) while elo_after tracks the ladder, so the
// pair of them is a true "where they started, where they are now" for the day.
//
// A SEPARATE ACTION rather than a wider return from enterMatchResult. Those
// signatures are ActionResult<void> and are asserted against by a great deal of
// test, and the summary is a READ — it has no business sharing a transaction
// with the write, and it must run AFTER the write has landed to report anything
// true. Gated on `tournaments.page`, the same capability that renders the event
// page: the Results and Leaderboard tabs already show these columns to anyone
// who can open it, so this exposes nothing new.
//
// DOUBLES IS THINNER, AND SAYS SO. tournament_pairs has combined_elo, points and
// final_position and no per-event rating columns at all — there is no pair row
// for a rating to move on, and the deltas go to the two players' ladders
// individually. So a doubles summary reports the record and the points and
// leaves the rating line off rather than printing a blank one.
export interface EntryEventSummary {
  entryId: string;
  name: string;
  isWinner: boolean;
  /** Decided matches this entry has played in this event, byes excluded. */
  played: number;
  won: number;
  points: number | null;
  finalPosition: number | null;
  /** Singles only — a pair has no rating row of its own. */
  eloBefore: number | null;
  eloAfter: number | null;
  eloChange: number | null;
}

export interface MatchOutcomeSummary {
  doubles: boolean;
  roundName: string | null;
  scores: Array<{ a: number; b: number }> | null;
  status: string;
  /** Placings and points are only written when the event is finalised. */
  eventFinalised: boolean;
  a: EntryEventSummary | null;
  b: EntryEventSummary | null;
}

async function getMatchOutcomeSummaryImpl(matchId: string): Promise<MatchOutcomeSummary> {
  await requireCapability('tournaments.page');
  const adminClient = createAdminClient();

  const { data: match, error } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(id, event_type, status)')
    .eq('id', matchId)
    .single();
  if (error || !match) throw new ExpectedError('That match could not be read back.');

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const eventId = match.event_id as string;
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) as string | null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) as string | null;
  const winnerId = (doubles ? match.winner_pair_id : match.winner_participant_id) as string | null;

  // Every match in the event, so the record is counted the same way for both
  // sides in one round trip. An event holds at most a few hundred rows. Counted
  // by the shared eventRecordFor, the same rule the member's own page uses.
  const { data: all } = await adminClient.from('tournament_matches')
    .select('id, status, is_bye, scores, round_number, bracket_position, phase, round_name, participant_a_id, participant_b_id, winner_participant_id, pair_a_id, pair_b_id, winner_pair_id')
    .eq('event_id', eventId);
  const flat: EventRecordMatch[] = (all ?? []).map((m) => ({
    id: m.id,
    status: m.status,
    is_bye: !!m.is_bye,
    scores: (m.scores as Array<{ a: number; b: number }> | null) ?? null,
    round_number: m.round_number,
    bracket_position: m.bracket_position,
    phase: m.phase,
    round_name: m.round_name,
    aId: doubles ? m.pair_a_id : m.participant_a_id,
    bId: doubles ? m.pair_b_id : m.participant_b_id,
    winnerId: doubles ? m.winner_pair_id : m.winner_participant_id,
  }));

  const record = (entryId: string) => {
    const { played, won } = eventRecordFor(flat, entryId);
    return { played, won };
  };

  const entries = new Map<string, EntryEventSummary>();
  const ids = [aId, bId].filter((x): x is string => !!x);

  if (ids.length > 0 && doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, pair_name, points, final_position, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
      .in('id', ids);
    for (const p of pairs ?? []) {
      const p1 = (p.player1 as { full_name?: string } | null)?.full_name;
      const p2 = (p.player2 as { full_name?: string } | null)?.full_name;
      entries.set(p.id as string, {
        entryId: p.id as string,
        // `[a,b].filter(Boolean).join(' / ')` is '' rather than null when both
        // players are missing, so a trailing ?? would never fire — the fallback
        // is spelled with || deliberately.
        name: (p.pair_name as string | null) || [p1, p2].filter(Boolean).join(' / ') || 'Unknown',
        isWinner: p.id === winnerId,
        ...record(p.id as string),
        points: (p.points as number | null) ?? null,
        finalPosition: (p.final_position as number | null) ?? null,
        eloBefore: null, eloAfter: null, eloChange: null,
      });
    }
  } else if (ids.length > 0) {
    const { data: parts } = await adminClient.from('tournament_participants')
      .select('id, points, final_position, elo_before, elo_after, elo_change, player:players!player_id(full_name)')
      .in('id', ids);
    for (const p of parts ?? []) {
      entries.set(p.id as string, {
        entryId: p.id as string,
        name: ((p.player as { full_name?: string } | null)?.full_name) ?? 'Unknown',
        isWinner: p.id === winnerId,
        ...record(p.id as string),
        points: (p.points as number | null) ?? null,
        finalPosition: (p.final_position as number | null) ?? null,
        eloBefore: (p.elo_before as number | null) ?? null,
        eloAfter: (p.elo_after as number | null) ?? null,
        eloChange: (p.elo_change as number | null) ?? null,
      });
    }
  }

  return {
    doubles,
    roundName: (match.round_name as string | null) ?? null,
    scores: (match.scores as Array<{ a: number; b: number }> | null) ?? null,
    status: match.status as string,
    eventFinalised: event.status === 'completed',
    a: aId ? entries.get(aId) ?? null : null,
    b: bId ? entries.get(bId) ?? null : null,
  };
}

export async function getMatchOutcomeSummary(matchId: string): Promise<ActionResult<MatchOutcomeSummary>> {
  return runAction(async () => getMatchOutcomeSummaryImpl(matchId));
}

// ============================================================
// The head start a played match would get now: READ ONLY (00279)
// ============================================================
//
// What the correction dialog's "Apply the current head start" switch shows
// before anything is saved: the starts recorded on the row, and the ones the
// two teams' categories give today. `applicable` is whether editMatchResult
// would accept the switch at all, so the dialog can say why it stays off.
// Gated on `tournaments.page`, like getMatchOutcomeSummary: both starts are
// already on screen to anybody who can open the event.
export interface CurrentHeadStarts {
  recorded: { a: number; b: number };
  current: { a: number; b: number } | null;
  applicable: boolean;
}

async function getCurrentHeadStartsImpl(matchId: string): Promise<CurrentHeadStarts> {
  await requireCapability('tournaments.page');
  const adminClient = createAdminClient();

  const { data: match, error } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(id, event_type, format_config)')
    .eq('id', matchId)
    .single();
  if (error || !match) throw new ExpectedError('That match could not be read back.');

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const recorded = { a: (match.handicap_a as number | null) ?? 0, b: (match.handicap_b as number | null) ?? 0 };
  const stage = match.stage != null
    ? parseFormatConfig(event.format_config)?.stages[(match.stage as number) - 1]
    : undefined;
  const next = stage?.scoring.handicap === true
    ? await currentStagedHeadStarts(adminClient, match, doubles)
    : null;
  const scored = Array.isArray(match.scores) && match.scores.length > 0;
  return {
    recorded,
    current: next ? { a: next.handicap_a, b: next.handicap_b } : null,
    applicable: next != null && scored && match.status === 'completed' && !match.is_bye,
  };
}

export async function getCurrentHeadStarts(matchId: string): Promise<ActionResult<CurrentHeadStarts>> {
  return runAction(async () => getCurrentHeadStartsImpl(matchId));
}

// Place or clear one side of an undecided match by hand. The escape hatch for a
// next-round slot that will never be filled by advancement — because the match
// feeding it was voided, or was a branch of nothing but byes.
export async function setMatchEntry(
  matchId: string,
  side: 'a' | 'b',
  entryId: string | null,
  reason: string,
): Promise<ActionResult<void>> {
  return runAction(async () => { await setMatchEntryImpl(matchId, side, entryId, reason); });
}
