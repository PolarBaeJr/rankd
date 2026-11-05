// Withdrawing once a draw exists.
//
// Bracket generation reads entry status ONCE, at the moment it runs. Every
// withdrawal after that is invisible to it: the entry stays seeded, the match
// it sits in stays playable, and the bye it may have been handed stays on the
// record. The rules below are the decisions that make a late withdrawal
// coherent again, and they live here because the player app (which refuses the
// withdrawal) and the admin app (which performs it) must not drift apart on
// where the cut-off is.

// A draw exists from the moment the bracket is generated — one step BEFORE the
// event goes live. 'bracket_generated' is deliberately on this list: the draw
// is published and players have already been told who they play.
//
// THE POOL HALF COUNTS TOO (00107). A pool_to_bracket event publishes its
// round-robin fixtures at 'pool_generated', and from that moment every word
// above is true of it — people have been told who they play and when. Left off
// this list, a member could withdraw out of a running pool through the player
// app and the fixtures would silently keep their name in them. The two statuses
// appear on no other format, so nothing else changes meaning.
const DRAWN_EVENT_STATUSES = new Set<string>([
  'pool_generated', 'pool_live', 'bracket_generated', 'live', 'completed',
]);

export function eventHasDraw(eventStatus: string | null | undefined): boolean {
  return !!eventStatus && DRAWN_EVENT_STATUSES.has(eventStatus);
}

// The two statuses that take an entry OUT of the event. 'no_show' is not one of
// them: one marked at check-in is simply left out of the draw, and one marked
// after it (Did not come) is still ranked and placed, below everyone who came
// (FormatResults.absent).
const OUT_OF_EVENT_STATUSES = new Set<string>(['withdrawn', 'disqualified']);

export function isOutOfEvent(entryStatus: string | null | undefined): boolean {
  return !!entryStatus && OUT_OF_EVENT_STATUSES.has(entryStatus);
}

// Match statuses that still resolve to something someone could turn up and
// play. Anything else already has a result (or was voided) and is history —
// a late withdrawal must never rewrite it.
export const OPEN_MATCH_STATUSES = ['pending', 'ready', 'live'] as const;

export function isOpenMatch(matchStatus: string | null | undefined): boolean {
  return (OPEN_MATCH_STATUSES as readonly string[]).includes(matchStatus ?? '');
}

// ------------------------------------------------------------
// "SOMETHING HAS BEEN PLAYED HERE" — ONE DEFINITION, TWO CALLERS
// ------------------------------------------------------------
//
// NOT the complement of OPEN_MATCH_STATUSES. 'voided' is neither: a voided
// match has had its result and its Elo taken back off, so it is history that
// no longer counts, and it must not block a redraw.
//
// It lives in shared because two places now have to agree on it and they are in
// different processes. The server guard (admin tournament-actions/brackets.ts,
// assertDrawIsRebuildable) refuses to rebuild a draw over a result; the event
// page counts the same thing to decide whether to grey the Regenerate button
// and say why. If those two definitions drift, the console either offers a
// button that always refuses or greys one that would have worked.
//
// AND THE COUNT ON THE PAGE IS NOT THE ONE ALREADY THERE. EventControlCenter's
// `completedMatches` is `status === 'completed' || status === 'walkover' ||
// is_bye` — the progress figure, which counts a bye because a bye is a slot
// that no longer needs a court. Gating the redraw on that number would have
// reproduced, in the client, the exact bye defect the server guard was fixed
// for: every draw whose field is not a power of two would show the button
// greyed for matches nobody played.
export const RESULT_MATCH_STATUSES = ['completed', 'walkover', 'disputed'] as const;

export interface PlayableMatch {
  status?: string | null;
  is_bye?: boolean | null;
}

/**
 * Has this match been decided by something that happened?
 *
 * A BYE IS NOT A RESULT. Generation writes `status: 'completed'` onto a bye
 * because it has already been decided — its winner advances with nothing to
 * play — so the status alone cannot be trusted. There is no score, no Elo and
 * no opponent, and nothing about a bye is evidence that anybody turned up.
 *
 * A WALKOVER IS. It is rated (recordWalkover -> applyTournamentMatchElo), and
 * going live records real ones for anybody who withdrew after the draw was
 * published, so it carries exactly the consequences a played match carries.
 */
export function isPlayedMatch(match: PlayableMatch): boolean {
  if (match.is_bye === true) return false;
  return (RESULT_MATCH_STATUSES as readonly string[]).includes(match.status ?? '');
}

// ------------------------------------------------------------
// "WHAT WOULD A REDRAW DESTROY" — A WIDER QUESTION THAN isPlayedMatch
// ------------------------------------------------------------
//
// isPlayedMatch is right for what it says: has this match been decided by
// something that happened. Regenerating a draw asks a DIFFERENT question —
// would deleting every match in this phase take something with it that cannot
// be got back — and the two answers differ in exactly two places. Both cost the
// club something real, so they are named here rather than folded into
// isPlayedMatch, whose meaning is depended on elsewhere.
//
// 1. A MATCH ON COURT. 'live' is not in RESULT_MATCH_STATUSES and should not be:
//    a live match genuinely has no result and no Elo. But it has PEOPLE ON IT.
//    Regenerating replaces the board while three rallies are in progress and
//    the desk is told nothing. This needs no race at all — just an exec who
//    does not know 'live' is not counted.
//
// 2. AN APPLIED RATING THAT WAS NEVER REVERSED. elo_snapshot is the only record
//    of the deltas a rated match put on the ladder (00078); delete the row and
//    reverse_tournament_match_rating has nothing to read and the ladder is
//    permanently wrong. Normally a rated match is also `completed`, so (1)
//    would catch it — but rows in exactly that shape EXIST ON PRODUCTION, left
//    by a void racing a result entry back when voidMatchImpl wrote status on
//    the id alone. That race is closed now (the write is conditional on the
//    status, a null snapshot and the occupants), so no NEW row can reach this
//    shape — but the old ones are still there and this guard is the only thing
//    standing between them and a redraw. It stays. A properly voided match has
//    had its snapshot nulled by the reversal, so it does NOT count here and
//    void-then-redraw still works.
//
// THE SERVER IS THE AUTHORITY, NOT THIS. These counts grey the button and say
// why; migration 00144's delete_phase_matches re-checks the same three
// conditions on the rows it actually deleted, inside one statement, and rolls
// the delete back. This is the courtesy; that is the guarantee.

export interface RedrawableMatch extends PlayableMatch {
  /** jsonb on the row. Only its presence is read here, never its shape. */
  elo_snapshot?: unknown;
}

/** Somebody is on court for this one right now. */
export function isInProgressMatch(match: PlayableMatch): boolean {
  if (match.is_bye === true) return false;
  return match.status === 'live';
}

/**
 * This row is the only record of a rating that is currently on the ladder.
 *
 * `!= null` and not `!== null`: PostgREST gives an absent jsonb column as
 * `null`, a caller that did not select it as `undefined`, and both mean "no
 * snapshot here". Note that a caller who did not select the column reads as
 * unrated — which is why the server guard selects it explicitly.
 */
export function carriesAppliedRating(match: RedrawableMatch): boolean {
  return match.elo_snapshot != null;
}

export interface RedrawBlockers {
  /** Matches with a real result. Byes excluded. */
  played: number;
  /**
   * Matches that carry an applied rating AND are not already counted in
   * `played`. Kept separate so the same match is never reported twice, and
   * because the remedy differs: a played match is voided, whereas this one is
   * already voided and has to be unvoided before it can be undone.
   */
  rated: number;
  /** Matches being played right now. */
  inProgress: number;
}

export function summariseRedrawBlockers(matches: RedrawableMatch[]): RedrawBlockers {
  let played = 0;
  let rated = 0;
  let inProgress = 0;
  for (const m of matches) {
    if (isPlayedMatch(m)) { played += 1; continue; }
    if (carriesAppliedRating(m)) { rated += 1; continue; }
    if (isInProgressMatch(m)) inProgress += 1;
  }
  return { played, rated, inProgress };
}

export function hasRedrawBlockers(b: RedrawBlockers): boolean {
  return b.played > 0 || b.rated > 0 || b.inProgress > 0;
}

// ------------------------------------------------------------
// "IS THIS EVENT FINISHED" — THE SAME COUNT finalizeEvent TAKES
// ------------------------------------------------------------
//
// A VERBATIM EXTRACTION of the check at the top of finalizeEvent (admin
// tournament-actions/finalize.ts), moved here so exactly one function owns it.
// The console now offers "complete the tournament", which has to say in advance
// what will happen to each event, and that answer is only worth anything if it
// is the same arithmetic the finalise itself performs.
//
// THE FAILURE THIS PREVENTS is a classifier that says "finalisable" and a
// finalizeEvent that then throws "N match(es) still incomplete" halfway through
// the cascade. The exec reads that as the console being broken — it has just
// told them the event was ready — rather than as a refusal, and by then some
// earlier event in the same run has already been finalised and rated. One
// definition, two callers, no drift.
export interface CompletableMatch extends RedrawableMatch {
  participant_a_id?: string | null;
  participant_b_id?: string | null;
  pair_a_id?: string | null;
  pair_b_id?: string | null;
}

// Exactly finalize.ts's list. `disputed` is deliberately absent — a disputed
// match has no settled result and must block.
const SETTLED_MATCH_STATUSES = ['completed', 'walkover', 'voided', 'bye'] as const;

/**
 * Is this a match somebody is still waiting to play?
 *
 * The empty-slot clause is the whole subtlety. A single-elimination draw is
 * generated to the next power of two, so every field that is not one leaves
 * bracket rows with neither side filled — a semi-final whose feeders were byes
 * never gets an entrant written into it. Counting those as incomplete would
 * make every such event permanently unfinishable.
 */
export function isRealIncompleteMatch(match: CompletableMatch, doubles: boolean): boolean {
  if (match.is_bye === true) return false;
  if ((SETTLED_MATCH_STATUSES as readonly string[]).includes(match.status ?? '')) return false;
  // An unused bracket slot has neither side filled and is not a match anybody
  // is waiting to play.
  return doubles
    ? Boolean(match.pair_a_id || match.pair_b_id)
    : Boolean(match.participant_a_id || match.participant_b_id);
}

/**
 * What completing the tournament would do to one event.
 *
 * - 'finalisable'  — hand it to finalizeEvent: positions, points and placement
 *                    bonuses get awarded.
 * - 'unplayed'     — nothing ever happened here; close it, award nothing.
 * - 'part_played'  — something happened and something is unfinished. Refuse,
 *                    unless the exec explicitly forces it.
 */
export type EventCompletionBucket = 'finalisable' | 'unplayed' | 'part_played';

export interface EventCompletionCounts {
  incomplete: number;
  played: number;
  rated: number;
  inProgress: number;
  bucket: EventCompletionBucket;
}

export function classifyEventForCompletion(
  status: string | null | undefined,
  matches: CompletableMatch[],
  doubles: boolean,
): EventCompletionCounts {
  const incomplete = matches.filter((m) => isRealIncompleteMatch(m, doubles)).length;
  const { played, rated, inProgress } = summariseRedrawBlockers(matches);

  // `status === 'live'` IS LOAD-BEARING. finalizeEvent accepts nothing else —
  // it throws 'Event must be live to finalize' before it reads a single match —
  // so pool_generated, pool_live and bracket_generated can never reach the
  // finalise path however clean their matches look. Dropping this test would
  // hand those events to a function guaranteed to refuse them, mid-cascade.
  if (status === 'live' && incomplete === 0) {
    return { incomplete, played, rated, inProgress, bucket: 'finalisable' };
  }

  // `incomplete === 0` HERE IS LOAD-BEARING TOO, and for the opposite reason.
  // It is the only thing separating "a registration nobody entered" from "a
  // full draw nobody has touched yet": both have played === rated ===
  // inProgress === 0. Without it a bracket_generated event with a complete,
  // unplayed bracket would be silently closed as if it had never existed, and
  // every entrant would find their event marked completed with no result.
  if (incomplete === 0 && played === 0 && rated === 0 && inProgress === 0) {
    return { incomplete, played, rated, inProgress, bucket: 'unplayed' };
  }

  return { incomplete, played, rated, inProgress, bucket: 'part_played' };
}

export interface ForfeitableMatch {
  participant_a_id?: string | null;
  participant_b_id?: string | null;
  pair_a_id?: string | null;
  pair_b_id?: string | null;
}

export interface ForfeitOutcome {
  /** Side the forfeiting entry occupies. */
  entrySide: 'a' | 'b';
  /** Side that is awarded the walkover. */
  winnerSide: 'a' | 'b';
  /**
   * Entry awarded the walkover, or null when that slot is still TBD — the
   * feeder match has not finished, so there is nobody to award it to yet.
   */
  winnerId: string | null;
}

/**
 * Work out how `entryId` forfeiting resolves `match`.
 * Returns null when the entry is not in the match at all.
 */
export function forfeitOutcome(
  match: ForfeitableMatch,
  entryId: string,
  doubles: boolean,
): ForfeitOutcome | null {
  const sideA = doubles ? match.pair_a_id : match.participant_a_id;
  const sideB = doubles ? match.pair_b_id : match.participant_b_id;

  if (sideA === entryId) return { entrySide: 'a', winnerSide: 'b', winnerId: sideB ?? null };
  if (sideB === entryId) return { entrySide: 'b', winnerSide: 'a', winnerId: sideA ?? null };
  return null;
}
