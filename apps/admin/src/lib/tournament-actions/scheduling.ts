'use server';

// ---------------------------------------------------------------------------
// RUNNING THE DESK — the two things an exec does to a match that are not a
// result: telling both sides which court to go to, and recording that somebody
// is standing in front of them.
//
// A DOMAIN FILE OF ITS OWN rather than three more exports in results.ts. Neither
// of these touches a score, a rating, an advancement or a standing, which is
// what every function in that file is about; and both happen at a point in the
// event where results.ts's guards (assertEventResultsMutable, the
// completed/walkover refusals) would be answering a different question. The
// barrel re-exports it beside the rest — see ../tournament-actions.ts.
// ---------------------------------------------------------------------------

import * as Sentry from '@sentry/nextjs';
import {
  ExpectedError,
  allowedCourtsSentence,
  allowedTournamentCourts,
  courtInLabels,
  courtLabel,
  parseFormatConfig,
  resolveCourtLabels,
  stageCourtLabels,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { readTournamentCourts } from '../tournament-courts';
import { runAction, type ActionResult } from '../action-result';
import {
  requireCapability,
  revalidateEventPaths,
  assertTournamentNotSuspended,
} from './_internal';

/**
 * The same length the database enforces (00135's tournament_matches_court_len).
 *
 * TRIMMED AND CHECKED HERE TOO, and not because the CHECK might fail — it is
 * NOT VALID, so it binds this write and would refuse it. It is checked here so
 * the refusal is a sentence an exec can act on instead of a raw Postgres
 * constraint name, which is the whole point of the ExpectedError channel.
 */
const COURT_MAX = 32;

/**
 * WHAT AN EXEC IS TOLD WHEN THE ROW MOVED UNDERNEATH THEM.
 *
 * Every write in this file reads the match first, reasons about what it read, and
 * then updates it — and between those two statements is a whole second desk. Two
 * execs share the Court Management tab at a live event by design, so this is the
 * ordinary case rather than the exotic one: one presses Start while the other
 * submits that match's score, and an UPDATE keyed on the id alone puts a
 * completed match back on court with its result and its bracket advancement
 * still applied.
 *
 * The fix is to carry the guard's premise INTO the write as a predicate, so the
 * update either lands on the row the guard actually inspected or lands on
 * nothing. PostgREST does not treat "matched no row" as an error, so the write
 * asks for the affected rows back and an empty result IS the lost race.
 *
 * REFUSED OUT LOUD, and specifically not "succeeded quietly". The loser of the
 * race is a person standing at a desk who believes they changed something; the
 * only useful outcome is a sentence telling them to look again. It is also what
 * keeps the audit trail true — the log entry is written only after a write that
 * provably landed, so it can no longer assert a transition out of a state the
 * match had already left.
 */
function staleRowRefusal(what: string): ExpectedError {
  return new ExpectedError(
    `This match changed while you were looking at it — someone else ${what} first. Reload the tab and check before trying again.`,
  );
}

/**
 * WHICH COURT THIS MATCH IS ON.
 *
 * "give us a location setter ... so we can tell them where to play through the
 * app" — the club owner. The member's phone learns it over the Realtime channel
 * both apps already hold open on tournament_matches (00113), so this action's
 * whole job is the write and the audit trail.
 *
 * FREE TEXT where the tournament has no courts of its own (00135). Where it has
 * them (00273) the text must name one, and the match is linked to it by court_id
 * so the database can refuse two live matches on one court. Empty string clears it back to NULL,
 * which the player app renders as "Court TBC" rather than as a blank, because
 * "not assigned yet" is a real state at a live event and has to look like one.
 */
export async function setMatchCourt(matchId: string, court: string): Promise<ActionResult<void>> {
  return runAction(async () => { await setMatchCourtImpl(matchId, court); });
}

async function setMatchCourtImpl(matchId: string, court: string) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const trimmed = court.trim();
  if (trimmed.length > COURT_MAX) {
    throw new ExpectedError(`A court label is at most ${COURT_MAX} characters — this is a place to walk to, not a note.`);
  }

  const { data: match } = await adminClient
    .from('tournament_matches')
    .select('id, court, event_id, stage, pool_number, event:tournament_events(tournament_id, format, format_config)')
    .eq('id', matchId)
    .maybeSingle();
  if (!match) throw new ExpectedError('Match not found');

  type MatchEvent = { tournament_id?: string; format?: string | null; format_config?: unknown };
  const embed = match.event as MatchEvent | MatchEvent[] | null;
  const event = (Array.isArray(embed) ? embed[0] : embed) ?? null;
  const tournamentId = event?.tournament_id ?? null;
  if (!tournamentId) throw new Error('Match is not attached to a tournament');

  // A suspended tournament is not being played, so nobody should be directed
  // anywhere. This is the plain case for the suspension gate — unlike void /
  // undo / edit, which skip it precisely because they are how a suspended
  // tournament gets repaired.
  await assertTournamentNotSuspended(adminClient, tournamentId);

  // A TOURNAMENT WITH ITS OWN COURTS (00273) takes only those, and the match is
  // linked by court_id as well as labelled. Without courts (or before 00273)
  // this is the free text it always was.
  const courts = await readTournamentCourts(adminClient, tournamentId);
  const managed = !!courts && courts.length > 0;

  // A STAGED MATCH stays on its stage's courts (its pool's, for a groups
  // stage) after the draw too. Clearing is always allowed.
  const cfg = event?.format === 'staged' ? parseFormatConfig(event.format_config) : null;
  const stageMatch = { stage: match.stage as number | null, pool_number: match.pool_number as number | null };
  const stageLabels = trimmed === '' ? null : stageCourtLabels(cfg, stageMatch);
  const stageRefusal = (label: string, labels: readonly string[]) => {
    const whose = cfg?.stages[(stageMatch.stage ?? 1) - 1]?.kind === 'groups' ? "group's" : "stage's";
    return new ExpectedError(`${courtLabel(label)} is not one of this ${whose} courts. Use ${allowedCourtsSentence(labels)}.`);
  };

  const previous = (match.court as string | null) ?? null;
  let next = trimmed === '' ? null : trimmed;
  let nextCourtId: string | null = null;
  let previousCourtId: string | null = null;
  if (!managed && next !== null && stageLabels && !courtInLabels(next, stageLabels)) {
    throw stageRefusal(next, stageLabels);
  }
  if (managed) {
    if (next !== null) {
      const court = resolveCourtLabels(courts, [next]).byLabel.get(next);
      if (!court) {
        throw new ExpectedError(`${courtLabel(next)} is not one of this tournament's courts. Add it on the tournament page.`);
      }
      const allowed = allowedTournamentCourts(courts, stageLabels);
      if (allowed && !allowed.some((c) => c.id === court.id)) throw stageRefusal(next, stageLabels!);
      next = court.label;
      nextCourtId = court.id;
    }
    const { data: linked, error: linkedError } = await adminClient
      .from('tournament_matches')
      .select('court_id')
      .eq('id', matchId)
      .maybeSingle();
    if (linkedError) throw new Error(linkedError.message);
    previousCourtId = (linked?.court_id as string | null | undefined) ?? null;
  }
  // Nothing to say, and nothing to wake twenty phones for: a no-op write would
  // still hit the WAL and nudge every subscriber of this event.
  if (previous === next && previousCourtId === nextCourtId) return;

  // ONLY WHILE THE COURT IS STILL THE ONE WE READ. Without this the second exec
  // to type into the same row overwrites the first, and the audit entry below
  // records a `previous_court` that had already been replaced.
  //
  // `.is()` rather than `.eq()` when there was no court, and the difference is
  // total: `.eq('court', null)` compiles to `court=eq.null`, which matches NO
  // row in Postgres — so writing it that way would refuse every first-time court
  // assignment, which is the common case. `.is('court', null)` is the IS NULL
  // this actually means.
  const write = adminClient
    .from('tournament_matches')
    .update({
      court: next,
      // Only where the column exists: a database before 00273 has no court_id.
      ...(managed ? { court_id: nextCourtId } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', matchId);
  const guarded = previous === null ? write.is('court', null) : write.eq('court', previous);
  // Matching no row is not an error in PostgREST, so the returned rows are the
  // only thing that can detect the lost race.
  const { data: updated, error } = await guarded.select('id').maybeSingle();
  // A live match moved onto a court another live match is on: the
  // one-live-per-court index (00273) refuses it.
  if (error?.code === '23505' && next !== null) {
    throw new ExpectedError(`${courtLabel(next)} already has a match on it. Finish or take that match off court first.`);
  }
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (!updated) throw staleRowRefusal('moved this match');

  // AUDITED INCLUDING THE PREVIOUS VALUE. A court that changes mid-event is the
  // case that strands somebody at the wrong net, so "who moved it, and from
  // what" is the question that gets asked afterwards.
  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: match.event_id as string,
    match_id: matchId,
    action: next === null ? 'match_court_cleared' : 'match_court_set',
    performed_by: admin.id,
    details: {
      previous_court: previous,
      court: next,
      ...(managed ? { previous_court_id: previousCourtId, court_id: nextCourtId } : {}),
    },
  });

  revalidateEventPaths(tournamentId, match.event_id as string);
}

/**
 * THE DESK MARKING SOMEBODY PRESENT — "they are standing right here and they
 * have not touched their phone."
 *
 * GATED ON tournaments.draw.checkin.mark.write, which is the key that already
 * says "you may record that this person has turned up". No new capability: this
 * is that act at match granularity instead of event granularity, and the same
 * person at the same table does both.
 *
 * AUDITED, unlike the member's own tap (apps/player/src/lib/tournament-actions.ts
 * setMyMatchReady). One person asserting something about another is exactly the
 * distinction tournament_audit_log exists to record; a member toggling their own
 * flag on a busy Saturday would write a few hundred rows saying nothing.
 */
export async function setMatchReadyForPlayer(
  matchId: string,
  playerId: string,
  ready: boolean,
): Promise<ActionResult<void>> {
  return runAction(async () => { await setMatchReadyForPlayerImpl(matchId, playerId, ready); });
}

async function setMatchReadyForPlayerImpl(matchId: string, playerId: string, ready: boolean) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient
    .from('tournament_matches')
    .select('id, event_id, event:tournament_events(tournament_id)')
    .eq('id', matchId)
    .maybeSingle();
  if (!match) throw new ExpectedError('Match not found');

  const event = match.event as { tournament_id?: string } | Array<{ tournament_id?: string }> | null;
  const tournamentId = (Array.isArray(event) ? event[0]?.tournament_id : event?.tournament_id) ?? null;
  if (!tournamentId) throw new Error('Match is not attached to a tournament');
  await assertTournamentNotSuspended(adminClient, tournamentId);

  // The RPC, not an .update(): it is the only writer of this column and it holds
  // the row lock across the read and the write, so a member tapping their own
  // control at the same instant cannot be erased by the desk's write. It also
  // re-checks that the player is actually in this match — an invariant that has
  // to be in the database, because a stray id in that array is data nobody can
  // see in order to fix. See 00135.
  const { error } = await adminClient.rpc('set_match_ready', {
    p_match_id: matchId,
    p_player_id: playerId,
    p_ready: ready,
  });
  if (error) {
    Sentry.captureException(error);
    throw new ExpectedError(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: match.event_id as string,
    match_id: matchId,
    action: ready ? 'match_ready_marked' : 'match_ready_cleared',
    performed_by: admin.id,
    details: { player_id: playerId },
  });

  revalidateEventPaths(tournamentId, match.event_id as string);
}

/**
 * PUTTING A MATCH ON COURT, AND TAKING IT BACK OFF.
 *
 * "this should show 'active match'" — the club owner. It could not, and no amount
 * of reading harder would have fixed it: `tournament_matches.status` has admitted
 * 'live' since 00001 and NOTHING HAS EVER WRITTEN IT. Every UPDATE of that column
 * in both apps produces 'ready', 'pending', 'completed', 'walkover' or 'voided'
 * and that is the entire set. results.ts:86 READS 'live' when undoing a result,
 * which is the giveaway — the undo path was written to cope with a state the rest
 * of the app cannot create. The console said so in its own copy, and 00135 quoted
 * it while fixing only the court half of the sentence. 00136 documents the rest.
 *
 * So "active" is not a display problem, it is a missing transition, and the desk
 * is the only place that knows. An exec calls two names, watches them walk to
 * court 3, and presses this.
 *
 * WHAT IT BUYS BEYOND A BADGE ON THIS TAB. The player event page already maps
 * 'live' to "On court now" — a label no member has ever been shown, because
 * nothing could produce the state behind it. This is what turns that dead string
 * into the thing an entrant's phone says while they play.
 *
 * SAME DESK CAPABILITY, NOT THE SCORE ONE. Calling a match onto court is the last
 * act of running the door: check them in, tell them the court, confirm they are
 * standing there, send them on. Recording what happened afterwards is a different
 * job with a different key, and this tab offers both at their own gates rather
 * than widening either.
 *
 * `stop` IS A CORRECTION, NOT AN OUTCOME. It exists because the other way out of
 * 'live' is entering a result, and an exec who pressed Start on the wrong row
 * would otherwise have to fake one. It returns the match to 'ready', which is
 * where it came from — never to 'pending', because both sides are known by
 * definition if it was startable.
 */
export async function setMatchLive(matchId: string, live: boolean): Promise<ActionResult<void>> {
  return runAction(async () => { await setMatchLiveImpl(matchId, live); });
}

async function setMatchLiveImpl(matchId: string, live: boolean) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient
    .from('tournament_matches')
    .select('id, status, is_bye, court, event_id, participant_a_id, participant_b_id, pair_a_id, pair_b_id, event:tournament_events(tournament_id)')
    .eq('id', matchId)
    .maybeSingle();
  if (!match) throw new ExpectedError('Match not found');

  const event = match.event as { tournament_id?: string } | Array<{ tournament_id?: string }> | null;
  const tournamentId = (Array.isArray(event) ? event[0]?.tournament_id : event?.tournament_id) ?? null;
  if (!tournamentId) throw new Error('Match is not attached to a tournament');
  await assertTournamentNotSuspended(adminClient, tournamentId);

  const status = match.status as string;

  if (live) {
    // A BYE IS NOT PLAYED BY ANYBODY, so it cannot go on court. Refused rather
    // than hidden, for the reason every guard in this file is doubled: the UI is
    // a courtesy and this is the boundary.
    if (match.is_bye) throw new ExpectedError('A skipped match is not played, so it cannot be started.');
    // ONLY FROM A STARTABLE STATE. 'completed', 'walkover' and 'voided' are
    // outcomes and starting one would silently discard a recorded result;
    // 'disputed' is somebody else's open question. The refusals name the state so
    // an exec can tell which row they hit.
    if (status === 'live') return; // Idempotent: pressing Start twice is not an error.
    if (status !== 'ready' && status !== 'pending') {
      throw new ExpectedError(`This match is ${status} — only a match waiting to be called can be started.`);
    }
    // BOTH SIDES KNOWN, which 'ready' already implies but 'pending' does not.
    // A round-of-64 slot whose feeders have not been played shows TBD on the
    // tab; starting it would put a name-less fixture on court.
    const aKnown = !!(match.participant_a_id ?? match.pair_a_id);
    const bKnown = !!(match.participant_b_id ?? match.pair_b_id);
    if (!aKnown || !bKnown) {
      throw new ExpectedError('Both entrants have to be known before this match can go on court.');
    }
  } else {
    if (status !== 'live') return; // Idempotent in this direction too.
  }

  // THE GUARD ABOVE, CARRIED INTO THE WRITE. Everything the block just decided
  // was decided about `status` as it was read — and the read is over. The other
  // exec on this tab submitting a score turns that row 'completed' in the
  // meantime, and an UPDATE keyed on the id alone would put it back on court
  // while the score rows and the next round's entrants stay exactly where the
  // result put them.
  //
  // `.eq('status', status)` is not a second copy of the refusals; it is what
  // makes them TRUE rather than advisory. It also fixes the audit entry by
  // construction: if the row matched, then `status` provably WAS the previous
  // value, so `previous_status` below can no longer name a transition that did
  // not happen.
  const { data: updated, error } = await adminClient
    .from('tournament_matches')
    .update({ status: live ? 'live' : 'ready', updated_at: new Date().toISOString() })
    .eq('id', matchId)
    .eq('status', status)
    // Matching no row is not an error in PostgREST, so the affected rows are the
    // only way to tell a lost race from a successful write.
    .select('id')
    .maybeSingle();
  // Another match is already live on this court: the one-live-per-court index
  // (00273) refuses the second. Said with the court named, before the raw throw.
  if (error?.code === '23505') {
    const court = courtLabel(match.court as string | null) ?? 'This court';
    throw new ExpectedError(`${court} already has a match on it. Finish or take that match off court first.`);
  }
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (!updated) throw staleRowRefusal('changed this match');

  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: match.event_id as string,
    match_id: matchId,
    action: live ? 'match_started' : 'match_start_undone',
    performed_by: admin.id,
    details: { previous_status: status },
  });

  revalidateEventPaths(tournamentId, match.event_id as string);
}
