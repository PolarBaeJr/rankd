'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { queueDrawSocialPosts } from '../social-posts/queue';
import { runAction, type ActionResult } from '../action-result';
import {
  isDoublesEvent,
  nextPowerOf2,
  getRoundName,
  ExpectedError,
  summariseRedrawBlockers,
  hasRedrawBlockers,
  isPoolToBracket,
  phaseValueFor,
  knockoutLadder,
  POOL_LADDER_SHAPE,
  circleMethodRounds,
  isPlayedMatch,
  CUSTOM_FORMAT_BOUNDS,
  maxFirstRoundByes,
  shuffleWithRng,
  groupLabel,
  poolQualifierCount,
} from '@badminton/shared';
import type { SeedBy, TournamentMatchPhase } from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  notifyPlayers,
  getStandardSeedPositions,
  assertTournamentNotSuspended,
  assertDrawFieldEventWaiverSigned,
  assertNobodyLeftUnpaired,
  computeRoundRobinStandings,
  settleWrites,
  assertWritesSucceeded,
  mustWrite,
  drawWithinTiers,
  makeDrawRng,
  newDrawSeed,
  inIdOrder,
  planGroupAssignment,
  drawAvoidingSameGroupRound1,
  assertFieldDidNotGrow,
} from './_internal';

// Block (re)generating a draw once any match has a recorded result —
// regeneration deletes all matches for the event and would erase entered
// scores/Elo. Void those matches first to reset.
/**
 * A finished event's draw is not regenerable, full stop.
 *
 * assertDrawIsRebuildable only looks for results that still stand, and `voided`
 * is not one — so voiding every match of a COMPLETED event unlocked regeneration while
 * the finalisation survived untouched: final_position, tournament points and the
 * placement-bonus ledger all still sat on the old players. The new draw would
 * then finalise on top of them, and the ledger would skip the people it had
 * already paid even though they now finished somewhere else.
 *
 * Nothing in the console can unwind a finalisation, so there is no safe version
 * of this. Refuse it.
 */
function assertNotFinalised(event: Record<string, unknown>, action: string) {
  if (event.status === 'completed') {
    throw new ExpectedError(
      `This event has been finalised, so its draw cannot be ${action}. ` +
      'Final positions, tournament points and any placement bonuses were awarded from the current draw and nothing here can take them back.',
    );
  }
}

/**
 * A BYE IS NOT A RESULT, and counting it as one made the draw unregenerable the
 * instant it was drawn.
 *
 * Generation writes `status: 'completed'` onto every bye it creates (see the
 * round-one loop below) because a bye has already been decided — its winner
 * advances with nothing to play. The guard then read those rows back as entered
 * results, so ANY field that is not a power of two produced a draw that answered
 * "Results have already been entered — void those matches first" about matches
 * that have no score, no Elo and no opponent to void.
 *
 * It went unnoticed because generation was reachable exactly once: the button
 * lived at `checkin` and the first press moved the event to `bracket_generated`,
 * out of the button's reach. Three of the four staging events sitting at
 * `bracket_generated` today have byes and no other completed match, so a
 * Regenerate control would have refused on three out of four.
 *
 * `NOT (is_bye IS TRUE)` and not `is_bye <> true`, because the column is
 * nullable (00001: `BOOLEAN DEFAULT false`) and under SQL's three-valued logic
 * `<>` is UNKNOWN against NULL — a `.neq` would have dropped every NULL row as
 * well, quietly excluding real matches and leaving the guard permanently
 * satisfied. `IS TRUE` is null-safe: true -> false, false -> true, null -> true.
 *
 * A walkover is still a result and still blocks: it is rated, and the go-live
 * sweep records real ones (setEventStatus -> forfeitOutOfEventEntries).
 *
 * (The `IS TRUE` half is now expressed by isPlayedMatch in packages/shared
 * rather than by a PostgREST filter, but the reasoning is unchanged and the
 * SQL side of it lives on in 00144, which has to spell it out again.)
 *
 * ------------------------------------------------------------
 * THIS IS THE EARLY, FRIENDLY REFUSAL. IT IS NOT THE GUARANTEE.
 * ------------------------------------------------------------
 *
 * It runs before generation does any work, so an exec who cannot redraw is told
 * so in one round trip instead of after 40. But it is a READ, and the DELETE it
 * protects is issued dozens of round trips later — on a 32-entry draw, several
 * seconds later. Anything that lands in that window is invisible to it.
 *
 * The guarantee lives in the database: delete_phase_matches (00144) re-asks
 * these same three questions of the rows the DELETE actually removed, in the
 * same statement, and rolls the delete back. That is what makes a redraw safe.
 * This function makes it POLITE. If the two ever disagree, the RPC is right.
 *
 * THREE THINGS BLOCK A REDRAW and they are not one condition — see
 * summariseRedrawBlockers in packages/shared for the reasoning behind each.
 * Briefly: a result cannot be rebuilt over; an unreversed rating on the row is
 * the only record of what it did to the ladder; and a live match has people on
 * court.
 */
async function assertDrawIsRebuildable(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  // WHICH HALF IS BEING REBUILT (00107). null for the two single-phase formats,
  // where it is the whole event exactly as before.
  //
  // THIS IS THE FILTER THAT WOULD OTHERWISE MAKE THE FORMAT UNUSABLE. A
  // pool-to-bracket event reaches its knockout with a full pool of RESULTS
  // sitting in this same table, so an unfiltered count would refuse to generate
  // the bracket — "9 matches in this event have a result" — and offer the exec
  // the one remedy that destroys the pool they just played. The bracket phase
  // is empty at that moment; only its own results may block rebuilding it.
  phase: TournamentMatchPhase | null,
) {
  // THE ROWS, NOT A COUNT. It used to be `head: true` with `.in('status', ...)`
  // pushed into the filter, which cannot answer three questions at once — and
  // `elo_snapshot` in particular is not a status. A phase is at most 128 rows of
  // four small columns; classifying them here keeps ONE definition of each
  // question (packages/shared) instead of transcribing it into PostgREST
  // filters and hoping the transcription stays right.
  //
  // elo_snapshot is SELECTED EXPLICITLY. carriesAppliedRating reads an absent
  // column as "unrated", so leaving it out of the projection would silently
  // disable the clause this guard exists for.
  let q = adminClient
    .from('tournament_matches')
    .select('status, is_bye, elo_snapshot')
    .eq('event_id', eventId);
  if (phase) q = q.eq('phase', phase);
  const { data, error } = await q;
  // THE ERROR WAS DISCARDED, AND THIS GUARD FAILS OPEN WITHOUT IT. supabase-js
  // resolves rather than rejects on a PostgREST error and leaves `data` null,
  // so an empty-list default reads a failed read as "nothing here" and
  // generation walks straight on towards the delete. A guard whose failure mode
  // is the exact destruction it exists to prevent has to say so out loud.
  // (The RPC would still refuse — but after the seeding writes have landed.)
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not check whether this event has results yet, so the draw was left alone: ${error.message}`);
  }
  const blockers = summariseRedrawBlockers(data ?? []);
  if (!hasRedrawBlockers(blockers)) return;
  // NAMES THE NUMBER, because the refusal is now reachable from a live event
  // where the exec cannot see at a glance what has been played. "Results have
  // already been entered" on a 128-match draw is not something anybody can act
  // on; "3 matches have a result" is.
  //
  // Each message names a remedy the exec can actually reach. "Void it first" is
  // a dead end for a row that is ALREADY voided and still rated, so that case
  // gets its own sentence rather than being folded into the first. The wording
  // is kept in step with delete_phase_matches' own RAISEs (00144).
  const { played, rated, inProgress } = blockers;
  if (played > 0) {
    throw new ExpectedError(
      `${played} match${played === 1 ? '' : 'es'} in this event ${played === 1 ? 'has' : 'have'} a result, and rebuilding the draw deletes every match — including ${played === 1 ? 'that one' : 'those'}. ` +
      `Void or undo ${played === 1 ? 'it' : 'them'} first if the draw really has to be rebuilt. Byes do not count towards this.`,
    );
  }
  if (rated > 0) {
    throw new ExpectedError(
      `${rated} match${rated === 1 ? '' : 'es'} in this event still carr${rated === 1 ? 'ies' : 'y'} an applied rating that was never reversed, and deleting ${rated === 1 ? 'it' : 'them'} would leave that rating on the ladder with no way to take it back. ` +
      `Unvoid then undo ${rated === 1 ? 'it' : 'them'} first.`,
    );
  }
  if (inProgress > 0) {
    throw new ExpectedError(
      `${inProgress} match${inProgress === 1 ? '' : 'es'} in this event ${inProgress === 1 ? 'is' : 'are'} being played right now. ` +
      `Rebuilding the draw would delete ${inProgress === 1 ? 'it' : 'them'} mid-game. Undo the start on the Court Management tab first, or wait for the result.`,
    );
  }
}

/**
 * WHAT STATUS AN EVENT IS LEFT IN BY A (RE)DRAW.
 *
 * THIS IS THE CHANGE THAT LETS THE BUTTON BE OFFERED AT `live`, not the status
 * check in participant-controls.ts. Both generators ended with an unconditional
 *
 *     .update({ status: 'bracket_generated', ... })
 *
 * which was invisible while the only caller was the check-in press — the event
 * was AT check-in, so writing `bracket_generated` was the forward step. The
 * moment a redraw is reachable from a running event it stops being a forward
 * step and becomes the only write in the whole console that sends an event
 * BACKWARDS: the header's primary button would revert from "Finalize
 * Tournament" to "Start Tournament", the players' app would stop showing the
 * event as under way, and pressing Start again would re-run the go-live
 * forfeit sweep. setEventStatus's transition table is deliberately forward-only
 * (registration -> checkin -> bracket_generated -> live -> completed) precisely
 * so that cannot happen, and this would have gone around it silently.
 *
 * REDRAWING IS NOT A STATUS CHANGE. It replaces the matches; it does not
 * un-start the event. A live event stays live.
 *
 * `completed` is not handled here because assertNotFinalised has already
 * refused it, and no other status can reach a generator with a draw to replace.
 */
/**
 * THE POOL HALF HAS ITS OWN PAIR OF STATES (00107), and the rule above applies
 * to it unchanged: generating the pool of an event whose pool is already
 * RUNNING must not un-start it. `pool_generated` and `pool_live` are written on
 * no other format, so the two-format behaviour here is the untouched branch.
 */
function statusAfterDraw(
  event: Record<string, unknown>,
  phase: TournamentMatchPhase | null,
): 'live' | 'bracket_generated' | 'pool_live' | 'pool_generated' {
  if (phase === 'pool') return event.status === 'pool_live' ? 'pool_live' : 'pool_generated';
  return event.status === 'live' ? 'live' : 'bracket_generated';
}

/**
 * Publish a generated draw: re-count the field and flip the status together.
 *
 * The reason this is not just another mustWrite is that the two halves have to
 * be one statement. Everything else in generation is recoverable by re-running
 * it; a draw published over a field that grew is not, because the entry it
 * missed has no fixture and nothing says so.
 */
async function publishDraw(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  newStatus: 'live' | 'bracket_generated' | 'pool_live' | 'pool_generated',
  doubles: boolean,
  // THE IDS THIS DRAW WAS BUILT FROM, not how many there were (00200). A count
  // cannot see a swap: one entrant withdraws and another enters while the draw
  // is being generated, the total is unchanged, and publication succeeds on a
  // bracket that has a fixture for somebody who left and none for somebody who
  // is in the event.
  entrants: string[],
  // POSITIONALLY ALIGNED WITH `entrants` (00202). An id set cannot see a swap:
  // swapping a pair's member keeps the pair id, so the set is unchanged while
  // the team, and the combined_elo the draw was seeded by, are not. These carry
  // what each entrant contained so publication can compare that too.
  digests: Array<Record<string, string | number | null>>,
  // True when `entrants` is supposed to BE the field. False for a pool-seeded
  // draw, whose entrants are the qualifiers — the members who did not qualify
  // are still registered, so "somebody is in the event and not in the draw" is
  // the normal state there rather than a fault. The other direction is checked
  // on both paths.
  wholeField: boolean,
  phase: TournamentMatchPhase | null,
  generation: string,
): Promise<void> {
  const { data, error } = await adminClient.rpc('publish_event_draw', {
    p_event_id: eventId,
    p_new_status: newStatus,
    p_doubles: doubles,
    p_entrants: entrants,
    p_whole_field: wholeField,
    p_phase: phase,
    p_generation: generation,
    p_digests: digests,
  });
  if (error) throw new Error(`Publishing the draw failed: ${error.message}`);
  if (!data) throw new Error('Publishing the draw returned nothing.');
  if (!data.ok) {
    if (data.reason === 'field_grew') {
      const arrived = Number(data.now ?? 0) - Number(data.expected ?? 0);
      throw new ExpectedError(
        `${arrived} ${arrived === 1 ? 'entry' : 'entries'} arrived while this draw was being built, so it would have left `
        + `${arrived === 1 ? 'somebody' : 'people'} out. Nothing was published — press Generate again to include `
        + `${arrived === 1 ? 'them' : 'everyone'}.`,
      );
    }
    // SOMEBODY IN THIS DRAW IS NO LONGER IN THE EVENT (00200) — a withdrawal
    // landed while the draw was being built, so a fixture here belongs to
    // somebody who has left. This is the cost of comparing the set instead of
    // the total, and it is only acceptable because the remedy is one press of
    // the button they just pressed. The sentence therefore says exactly that
    // and does not ask them to work out what changed.
    if (data.reason === 'entrant_left') {
      const gone = Number(data.count ?? 0);
      throw new ExpectedError(
        `${gone === 1 ? 'Somebody' : `${gone} people`} in this draw left the event while it was being built, `
        + `so ${gone === 1 ? 'their match' : 'their matches'} would have had nobody to play. Nothing was published — `
        + 'press Generate again to rebuild it without them.',
      );
    }
    // SOMEBODY ELSE REBUILT THIS DRAW while this one was being built (00197).
    // Nothing of this generation's is in the table — the trigger refused it —
    // so there is nothing to undo and the remedy is to look at what is there.
    // AN ENTRANT IS STILL HERE BUT IS NOT WHAT IT WAS (00202) — the usual cause
    // is a pair whose member was swapped while the draw was being built, which
    // leaves the pair id, and therefore the entrant set, completely unchanged.
    // Same remedy as entrant_left, and the same reason it is acceptable.
    if (data.reason === 'entrant_changed') {
      const changed = Number(data.count ?? 0);
      throw new ExpectedError(
        `${changed === 1 ? 'An entry' : `${changed} entries`} in this draw changed while it was being built — `
        + `${changed === 1 ? 'a team member was swapped, or a seed was edited' : 'team members were swapped, or seeds were edited'}. `
        + 'Nothing was published — press Generate again to rebuild it as the event now stands.',
      );
    }
    if (data.reason === 'superseded') {
      throw new ExpectedError(
        'This draw was rebuilt by somebody else while it was being generated, so nothing here was saved. '
        + 'Reload the event to see the draw that was published, and press Generate again if it is not the one you wanted.',
      );
    }
    // Both of these are unreachable while the trigger and the inserts above
    // hold, which is why they are worth reporting as faults rather than as
    // something the exec did.
    if (data.reason === 'foreign_matches') {
      Sentry.captureMessage('publish_event_draw: foreign matches in the phase', {
        level: 'error',
        tags: { eventId, count: String(data.count ?? '') },
      });
      throw new Error('This draw contains matches from another generation and was not published.');
    }
    if (data.reason === 'no_matches') {
      Sentry.captureMessage('publish_event_draw: nothing was built', { level: 'error', tags: { eventId } });
      throw new Error('No matches were created for this draw, so it was not published.');
    }
    if (data.reason === 'event_not_found') throw new Error('Event not found');
    throw new Error('Could not publish the draw — please try again.');
  }
}

/**
 * Delete the matches of ONE phase, leaving the other half alone.
 *
 * The single most destructive line in this module used to be
 * `.delete().eq('event_id', eventId)`, and it was correct while an event had
 * one draw. On a pool-to-bracket event it would take the played-out pool with
 * it every time the knockout was regenerated. `.is('phase', null)` is not used
 * for the other two formats: their matches all carry NULL, so the unfiltered
 * delete is already exactly right and adding a filter would only create a way
 * for a stray row to survive a rebuild — which is why `p_phase` is passed as
 * NULL for them and 00144 reads NULL as "no filter" rather than "phase IS NULL".
 *
 * ------------------------------------------------------------
 * WHY THIS IS AN RPC AND NOT A DELETE
 * ------------------------------------------------------------
 * Because the DELETE and the check that it was allowed have to be the SAME
 * STATEMENT, and from here they cannot be.
 *
 * assertDrawIsRebuildable runs 40+ sequential PostgREST round trips before this
 * line — the field read, buildFieldFromPool, the seeding computation, one
 * seed_number UPDATE per entrant. A result entered by another exec anywhere in
 * that window is invisible to the guard and fully visible to the delete, and
 * this delete has NO PREDICATE: it takes the match row, and with it the
 * `elo_snapshot` that is the ONLY record of the deltas that match put on the
 * ladder. reverse_tournament_match_rating reads that column; once the row is
 * gone the rating cannot be taken back by any path, and nothing anywhere
 * reports a problem. Exec B is told the result saved. Exec A is told the draw
 * regenerated. Both are true.
 *
 * A PREDICATE ON THE DELETE CANNOT FIX IT: leaving the played match behind and
 * deleting the rest produces an incoherent half-draw. The operation is
 * all-or-nothing, so the invariant is "refuse the whole thing", and that is not
 * something a WHERE clause can say.
 *
 * NOR CAN MOVING THE COUNT INTO THE SAME TRANSACTION. Under READ COMMITTED each
 * statement takes its own snapshot, so a count-then-delete function body loses
 * the same race — narrower, not closed. delete_phase_matches (00144) instead
 * deletes and counts what it deleted in ONE data-modifying CTE and RAISEs,
 * rolling the delete back, if anything in it had a result, carried an unreversed
 * rating, or was being played. Verified by reproducing the loss both ways in a
 * container before the fix and showing it prevented after.
 *
 * The refusals are ExpectedError, not faults: an exec who cannot redraw is the
 * system working. 23514 is the SQLSTATE 00144 raises them under, matching how
 * addPairToEventImpl reads 00102's refusals.
 */
async function deletePhaseMatches(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  phase: TournamentMatchPhase | null,
): Promise<string> {
  // SCHEMA FENCE, AND IT HAS TO BE BEFORE THE TEARDOWN (00197).
  //
  // delete_phase_matches commits its DELETE in its own round trip. If this
  // image is running against a database where 00197 has not been applied yet,
  // the RPC is still 00144's integer-returning version: the delete lands, and
  // then the generation check below throws over a phase that no longer exists
  // and cannot be rebuilt until the migration runs. Deploying the image before
  // the migration is the DEFAULT order here — images auto-update from CI while
  // migrations are run by hand — so this is the likely sequence, not the exotic
  // one.
  //
  // Asking for the column 00197 adds is the cheapest way to date the schema:
  // on an old database PostgREST answers 42703 and nothing has been destroyed
  // yet. One extra round trip on an operation an exec performs by hand.
  const { error: fenceError } = await adminClient
    .from('tournament_events')
    .select('draw_generation_id')
    .eq('id', eventId)
    .maybeSingle();
  if (fenceError) {
    Sentry.captureException(fenceError);
    throw new Error(
      'This draw cannot be fenced against a competing rebuild, so it was left alone. ' +
        'The database is likely older than this version of the app; no matches were deleted.',
    );
  }

  const { data, error } = await adminClient.rpc('delete_phase_matches', {
    p_event_id: eventId,
    p_phase: phase,
  });
  if (!error) {
    // THE GENERATION THIS TEARDOWN CLAIMED (00197). Every match inserted below
    // carries it, publish_event_draw refuses a claim that has moved on, and a
    // BEFORE INSERT trigger refuses a stamped row from a superseded one. It is
    // returned rather than re-read because re-reading it would be a second
    // round trip that could see somebody else's claim and stamp the whole draw
    // with it — which is the failure this is built to prevent, arrived at by a
    // different route.
    const generation = (data as { generation?: unknown } | null)?.generation;
    if (typeof generation !== 'string') {
      throw new Error('The draw teardown did not return a generation, so this draw cannot be fenced.');
    }
    return generation;
  }
  // The function raises its own refusals with messages written for the desk —
  // which matches to void, which to unvoid, which are on court — so they are
  // passed through rather than replaced with something vaguer.
  if (error.code === '23514') throw new ExpectedError(error.message);
  Sentry.captureException(error);
  // NAMED, because the alternative failure here is silent. If this throw is
  // ever softened into a warning the caller will carry on and INSERT a second
  // draw over the first.
  throw new Error(`The old draw could not be cleared, so it was left alone: ${error.message}`);
}

// ============================================================
// Pool -> bracket seeding
// ============================================================

/**
 * THE RAW COLUMNS PUBLICATION COMPARES, minus the two the generator writes
 * itself (00202). Raw, not derived: the generators coalesce combined_elo to 400
 * and choose between elo_after and elo_before depending on which path built the
 * field, and putting that derived number here would oblige publish_event_draw
 * to reproduce the same choice in SQL. A divergence between the two would be a
 * silent false accept, so the comparison is column-to-column and the fallback
 * logic stays in exactly one place.
 *
 * Keys are short because they travel per entrant and are matched by
 * jsonb_build_object in publish_event_draw — they must stay in step with it.
 */
type EntrantIdentity = Record<string, string | number | null>;

function doublesIdentity(
  r: { player1_id: string; player2_id: string; combined_elo: number | null },
): EntrantIdentity {
  return { p1: r.player1_id, p2: r.player2_id, ce: r.combined_elo ?? null };
}

function singlesIdentity(
  r: { player_id: string; elo_before: number | null; elo_after: number | null },
): EntrantIdentity {
  return { p: r.player_id, eb: r.elo_before ?? null, ea: r.elo_after ?? null };
}

/**
 * What this generator asserts each entrant IS, at the moment it publishes.
 *
 * seed and grp are the generator's INTENDED values rather than snapshot ones,
 * because the generator writes both columns itself — seed_number on all four
 * draw paths and group_number on the round-robin one. The digest is therefore
 * "the row as this draw requires it to be", and publication refuses if the
 * table disagrees. That covers both a concurrent writer changing a seed and the
 * generator's own seed write having silently failed to land.
 */
function entrantDigest(e: FieldEntry): Record<string, string | number | null> {
  return { ...e.identity, seed: e.seed, grp: e.dbGroup };
}

type FieldEntry = {
  id: string;
  seed: number | null;
  elo: number;
  /** The identity/rating columns as read when this entrant was snapshotted. */
  identity: EntrantIdentity;
  /**
   * This event's own tournament_pairs/tournament_participants.group_number.
   *
   * NOT the same thing as `group` below, and the difference is why it exists:
   * on a pool-seeded draw `group` is the group the entrant qualified OUT OF in
   * the SOURCE event, which has nothing to do with this row's column.
   */
  dbGroup: number | null;
  /**
   * The group this entrant qualified out of, and where they finished in it.
   * Both null outside a group-seeded field — an ordinary or single-pool draw
   * has neither, and the draw code checks for null rather than assuming.
   */
  group?: number | null;
  groupRank?: number | null;
};

// A pair may be entered with the two players in either order, so the key has to
// be order-independent or the same pair in the pool and in the bracket would
// look like two different teams.
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/**
 * Build the bracket's field from a finished pool's standings (00046).
 *
 * The point of pool-then-bracket is that the exec does not enter the field
 * twice: whoever finished top N of the pool IS the draw. So this promotes the
 * qualifiers into this event — reusing their existing entry when they are
 * already registered here, creating one when they are not — and returns them
 * already seeded in finishing order.
 *
 * N is max_participants, the event's own capacity. A pool with fewer finishers
 * than that is not an error: the field is simply shorter and the draw gets the
 * byes it would get for any undersized entry list.
 *
 * A GROUP STAGE CAPS IT FURTHER (00106). When the source is split into groups
 * the number of qualifiers is decided by the FORMAT — qualifiers_per_group out
 * of each group — and not by how many slots this event happens to have. The two
 * caps compose: the smaller wins, so an exec who sets a 16-slot bracket over 4
 * groups of 2 still gets 8 qualifiers, and one who sets a 4-slot bracket over
 * the same groups gets the best 4 of those 8.
 */
async function buildFieldFromPool(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  doubles: boolean,
  adminId: string,
): Promise<{ entries: FieldEntry[]; promoted: number; skipped: number; groupCount: number }> {
  const eventId = event.id as string;
  const sourceId = event.seeded_from_event_id as string;
  const seedBy = ((event.seed_by as SeedBy | null) ?? 'wins') as SeedBy;

  const { data: source } = await adminClient.from('tournament_events')
    .select('id, tournament_id, event_type, group_count, qualifiers_per_group')
    .eq('id', sourceId)
    .maybeSingle();
  // The FK is ON DELETE SET NULL, so a missing source means the row was read
  // before the delete landed — either way there is nothing to seed from.
  if (!source) throw new ExpectedError('The pool this event seeds from no longer exists. Pick another pool, or clear the link.');
  if (source.tournament_id !== event.tournament_id) {
    throw new ExpectedError('That pool belongs to a different tournament.');
  }
  // Singles standings are participant rows and doubles standings are pair rows;
  // there is no sensible way to carry one into the other.
  if (isDoublesEvent(source.event_type) !== doubles) {
    throw new ExpectedError('A doubles event cannot be seeded from a singles pool, or the other way round.');
  }

  // Same definition of "played out" that finalizeEvent uses, so an exec cannot
  // be told the pool is finished by one screen and unfinished by another.
  // Empty bracket slots and byes are not real matches and never complete.
  const { data: poolMatches } = await adminClient.from('tournament_matches')
    .select('status, is_bye, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', sourceId);
  if (!poolMatches || poolMatches.length === 0) {
    throw new ExpectedError('That pool has no matches yet, so there is nothing to seed from.');
  }
  const unplayed = poolMatches.filter((m) => {
    if (['completed', 'walkover', 'voided'].includes(m.status as string) || m.is_bye) return false;
    return doubles ? (m.pair_a_id || m.pair_b_id) : (m.participant_a_id || m.participant_b_id);
  });
  if (unplayed.length > 0) {
    throw new ExpectedError(
      `${unplayed.length} pool match(es) have not been played. Seeding off a half-finished pool would produce the wrong draw — finish the pool first.`
    );
  }

  const standings = await computeRoundRobinStandings(sourceId, seedBy);
  if (standings.length === 0) throw new ExpectedError('That pool has no finishers to seed from.');

  // Source rows carry the identity (which player) and the rating to inherit;
  // the standings carry only the order.
  const sourceKeys = new Map<string, { key: string; elo: number; name: string | null; players: string[] }>();
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, pair_name, combined_elo')
      .eq('event_id', sourceId);
    for (const p of pairs ?? []) {
      sourceKeys.set(p.id, {
        key: pairKey(p.player1_id, p.player2_id),
        elo: p.combined_elo ?? 400,
        name: p.pair_name,
        players: [p.player1_id, p.player2_id],
      });
    }
  } else {
    const { data: parts } = await adminClient.from('tournament_participants')
      .select('id, player_id, elo_before, elo_after')
      .eq('event_id', sourceId);
    for (const p of parts ?? []) {
      // elo_after is where the pool left them; it is what the bracket should
      // inherit, with elo_before as the fallback for a player who never played.
      sourceKeys.set(p.id, { key: p.player_id, elo: p.elo_after ?? p.elo_before ?? 400, name: null, players: [p.player_id] });
    }
  }

  // Anyone already entered here — including withdrawals, which must be seen so
  // a withdrawal is skipped rather than re-created by the promotion insert.
  // group_number and the rating columns come back too — 00202. This read IS the
  // snapshot for anyone already entered here, so it is where their digest has to
  // be taken from; re-reading them later would reopen the window the digest
  // exists to close.
  const existing = new Map<string, {
    id: string; status: string; identity: EntrantIdentity; dbGroup: number | null;
  }>();
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, combined_elo, group_number, status')
      .eq('event_id', eventId);
    for (const p of pairs ?? []) existing.set(pairKey(p.player1_id, p.player2_id), {
      id: p.id, status: p.status, identity: doublesIdentity(p),
      dbGroup: (p as { group_number?: number | null }).group_number ?? null,
    });
  } else {
    const { data: parts } = await adminClient.from('tournament_participants')
      .select('id, player_id, elo_before, elo_after, group_number, status')
      .eq('event_id', eventId);
    for (const p of parts ?? []) existing.set(p.player_id, {
      id: p.id, status: p.status, identity: singlesIdentity(p),
      dbGroup: (p as { group_number?: number | null }).group_number ?? null,
    });
  }

  const srcGroupCount = (source as { group_count?: number | null }).group_count ?? 1;
  const perGroup = (source as { qualifiers_per_group?: number | null }).qualifiers_per_group ?? 2;
  // Math.min over both caps rather than a branch, so a group stage whose
  // qualifier count exceeds the bracket still respects the bracket, and a
  // bracket with no cap still respects the format.
  const capacity = Math.min(
    (event.max_participants as number | null) ?? standings.length,
    srcGroupCount >= 2 ? srcGroupCount * perGroup : standings.length,
  );
  // Promoted qualifiers arrive checked in: they have just finished playing the
  // pool, so they are demonstrably present. The status and the checking-in
  // admin are written by promote_pool_qualifier itself (00198); the TIMESTAMP
  // is stamped here so one promotion run shares a single instant rather than
  // drifting a few milliseconds per round trip. It is carried separately from
  // the status because the attendance list keys on the timestamp, not the
  // enum — status is overwritten by a later withdrawal, the timestamp is not.
  const promotedCheckedInAt = new Date().toISOString();
  const entries: FieldEntry[] = [];
  let promoted = 0;
  let skipped = 0;

  for (const standing of standings) {
    if (entries.length >= capacity) break;
    const src = sourceKeys.get(standing.id);
    if (!src) continue;

    const already = existing.get(src.key);
    // A qualifier who has withdrawn from the bracket does not take a slot, and
    // is not resurrected by re-inserting them — the next finisher moves up.
    if (already && (already.status === 'withdrawn' || already.status === 'disqualified')) {
      skipped++;
      continue;
    }

    const seed = entries.length + 1;
    // Carried from the STANDING, not from the promoted row: the bracket entry is
    // a different row in a different event and has no group of its own. This is
    // what the draw uses to keep group-mates out of round one.
    const from = {
      group: (standing as { group?: number | null }).group ?? null,
      groupRank: (standing as { groupRank?: number | null }).groupRank ?? null,
    };
    if (already) {
      entries.push({
        id: already.id, seed, elo: src.elo,
        identity: already.identity, dbGroup: already.dbGroup, ...from,
      });
      continue;
    }

    // THE INSERT GOES THROUGH AN RPC (00198), not straight at the two tables.
    // enter_tournament_event takes the field advisory lock before it decides
    // that nobody here is spoken for; this promotion writes the SAME field, and
    // until now it did so without taking that lock. The two could interleave
    // and leave one member both a participant and half a pair — the original
    // duplicate-entry corruption. pg_advisory_xact_lock lives for one
    // transaction and a PostgREST call IS the transaction, so the check and the
    // insert cannot be split across two round trips; they move into the RPC
    // together. The RPC also picks the table and the row shape, which removes
    // the two-call split this used to need to type cleanly.
    const { data: promotedRow, error } = await adminClient.rpc('promote_pool_qualifier', {
      p_event_id: eventId,
      // THE EVENT THIS QUALIFIER CAME FROM — 00218. `standings` is a snapshot
      // taken once, before this loop, and nothing holds the pool event still
      // afterwards; a member withdrawn from it after the snapshot frees a cap
      // slot they may already have spent elsewhere. The RPC re-asks whether
      // their pool entry is still there, under the tournament row lock that
      // makes the answer hold until the insert commits.
      p_source_event_id: sourceId,
      p_doubles: doubles,
      p_player1_id: src.players[0],
      p_player2_id: doubles ? src.players[1] : null,
      p_pair_name: doubles ? src.name : null,
      p_elo: src.elo,
      p_seed: seed,
      p_admin_id: adminId,
      p_checked_in_at: promotedCheckedInAt,
    });
    if (error) {
      Sentry.captureException(error);
      throw new Error(`Could not enter a pool qualifier into the bracket: ${error.message}`);
    }
    const result = promotedRow as
      | { ok: boolean; id?: string; reason?: string; conflict?: string }
      | null;
    if (!result?.ok) {
      // THE POOL ENTRY WENT AWAY UNDER THE SNAPSHOT — 00218. This is the same
      // answer as the withdrawal branch above, arrived at from the source side
      // instead of the target side: they are not in the pool any more, so they
      // do not take a bracket slot and the next finisher moves up.
      if (result?.reason === 'source_entry_left') {
        skipped++;
        continue;
      }
      // A collision is NOT a skip. `skipped` means the exec withdrew somebody
      // and the next finisher moves up, which is correct; this means the field
      // changed underneath the promotion, and promoting around it would build a
      // bracket that disagrees with the pool everyone just played. Refuse the
      // generation — no matches exist yet at this point, so pressing Generate
      // again re-reads the field and is the whole remedy.
      if (result?.reason === 'already_in_field') {
        throw new ExpectedError(
          'Somebody was entered into this bracket while it was being built from the pool standings, so the draw was not created. Press Generate again to build it from the current field.'
        );
      }
      throw new Error(
        `Could not enter a pool qualifier into the bracket: ${result?.reason ?? 'unknown error'}`
      );
    }
    promoted++;
    // THE DIGEST OF A ROW THIS GENERATOR JUST CREATED — 00202. Not a re-read:
    // promote_pool_qualifier inserts exactly the arguments passed to it above,
    // leaving group_number and (for singles) elo_after at their defaults, so
    // the inserted row is known without asking for it back.
    entries.push({
      id: result.id as string, seed, elo: src.elo,
      identity: doubles
        ? { p1: src.players[0] ?? null, p2: src.players[1] ?? null, ce: src.elo }
        : { p: src.players[0] ?? null, eb: src.elo, ea: null },
      dbGroup: null,
      ...from,
    });
  }

  if (entries.length < 2) {
    throw new ExpectedError('The pool produced fewer than 2 available finishers, which is not a bracket.');
  }

  // Persist the pool order onto the entries that were already here — the ones
  // just created were inserted with their seed. Independent rows, no contention.
  //
  // A seed that failed to persist is not cosmetic: the pool's finishing order
  // IS the draw here, so half-written seeds produce a bracket that disagrees
  // with the pool everyone just played. Fail the generation instead — no
  // matches exist yet, so re-running it is the whole remedy.
  const { failures } = await settleWrites(
    entries.map(e => [
      `${doubles ? 'tournament_pairs' : 'tournament_participants'}.seed_number for ${e.id}`,
      adminClient.from(doubles ? 'tournament_pairs' : 'tournament_participants')
        .update({ seed_number: e.seed })
        .eq('id', e.id),
    ] as const)
  );
  assertWritesSucceeded('Seeding the bracket from the pool standings', failures);

  return { entries, promoted, skipped, groupCount: srcGroupCount };
}

/**
 * How many entries get out of this event's OWN pool (00107).
 *
 * A flat pool is one group, so `qualifiers_per_group` says it either way and
 * there is no second column to disagree with. Defaults mirror
 * normalizeGroupShape in events.ts: 2 out of each of several groups, 4 out of a
 * single flat pool.
 */
function ownPoolCapacity(event: Record<string, unknown>): number {
  return poolQualifierCount(event.group_count as number | null, event.qualifiers_per_group as number | null);
}

/**
 * Build the knockout's field from THIS EVENT'S OWN pool (00107).
 *
 * THIS IS WHERE THE ONE-EVENT FORMAT IS GENUINELY SIMPLER THAN THE TWO-EVENT
 * ONE, and it is worth being explicit about what disappears. buildFieldFromPool
 * above has to PROMOTE: read the source event, check it belongs to the same
 * tournament, check it is the same discipline, look every finisher up by an
 * order-independent player key, reuse an existing entry or INSERT a new one,
 * carry the rating across, and skip anyone who withdrew from the destination.
 * Every one of those steps exists because the qualifier's row in the bracket is
 * a DIFFERENT ROW from their row in the pool.
 *
 * Here it is the same row. tournament_participants / tournament_pairs are not
 * per-phase; they are per-event, and both phases are this event. So qualifying
 * is writing a seed number onto rows that are already there:
 *
 *   * nothing is inserted, so there is no duplicate-entry failure mode;
 *   * there is no second event, so there is no cross-discipline and no
 *     cross-tournament check to get wrong;
 *   * CHECK-IN HAPPENS ONCE. The two-event path had to stamp checked_in_at onto
 *     the rows it created, because they were new rows that had never checked in
 *     — which is precisely the thing the club owner objected to. Here the
 *     entrant checked in this morning and has been playing ever since.
 *
 * The ORDER is qualificationOrder's when the pool has groups and sortStandings'
 * when it is flat — computeRoundRobinStandings already picks between them — so
 * the seeding tiers the draw shuffles within are the ones 00106 built.
 */
async function buildFieldFromOwnPool(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  doubles: boolean,
): Promise<{ entries: FieldEntry[]; groupCount: number; poolSize: number }> {
  const eventId = event.id as string;
  // ONE COLUMN, READ TWICE — that is what closes the documented seed_by trap.
  // The order that decides who qualifies (here) and the order finalizeEvent
  // ranks the non-qualifiers by are the same value on the same row, so they
  // cannot disagree whatever it is set to. Frozen too: updateTournamentEvent
  // refuses any format change once matches exist, so seed_by cannot move
  // between the draw and the finalise.
  //
  // THE COLUMN IS NOT ALWAYS POPULATED, whatever the comment that used to sit
  // here said. createTournamentEvent does populate it on this format, but the
  // settings dialog sends seeded_from_event_id: null for a pool_to_bracket
  // event — it has no external pool — and updateTournamentEvent nulls seed_by
  // alongside it. So a NULL row is reachable and normal.
  //
  // It is also harmless, at two layers: 00046 defines NULL as 'wins', the `??`
  // below says so, and sortStandings/compareAcrossGroups independently ask
  // `seedBy === 'points'` rather than assuming a value, so a null that got past
  // here would still order by wins. The `??` is belt-and-braces rather than the
  // thing holding it up — worth keeping, not worth relying on alone.
  const seedBy = ((event.seed_by as SeedBy | null) ?? 'wins') as SeedBy;

  // Same definition of "played out" the two-event path uses, so an exec cannot
  // be told the pool is finished by one screen and unfinished by another.
  const { data: poolMatches } = await adminClient.from('tournament_matches')
    .select('status, is_bye, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', eventId)
    .eq('phase', 'pool');
  if (!poolMatches || poolMatches.length === 0) {
    throw new ExpectedError('The round robin has not been generated yet, so there is nothing to seed the knockout from.');
  }
  const unplayed = poolMatches.filter((m) => {
    if (['completed', 'walkover', 'voided'].includes(m.status as string) || m.is_bye) return false;
    return doubles ? (m.pair_a_id || m.pair_b_id) : (m.participant_a_id || m.participant_b_id);
  });
  if (unplayed.length > 0) {
    throw new ExpectedError(
      `${unplayed.length} round-robin match(es) have not been played. Seeding the knockout off a half-finished pool would `
      + 'produce the wrong draw — finish the round robin first.',
    );
  }

  const standings = await computeRoundRobinStandings(eventId, seedBy);
  if (standings.length === 0) throw new ExpectedError('The round robin has no finishers to seed the knockout from.');

  // The rating each entry carries into the knockout. Read rather than defaulted
  // because a doubles pair's combined_elo and a singles entry's elo_after are
  // what an unseeded draw would sort by, and because the audit row is more
  // useful when the field it describes is the real one.
  const eloOf = new Map<string, number>();
  // The same read produces the digest — 00202. See buildFieldFromPool.
  const digestOf = new Map<string, { identity: EntrantIdentity; dbGroup: number | null }>();
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, combined_elo, group_number').eq('event_id', eventId);
    for (const p of pairs ?? []) {
      eloOf.set(p.id, p.combined_elo ?? 400);
      digestOf.set(p.id, {
        identity: doublesIdentity(p),
        dbGroup: (p as { group_number?: number | null }).group_number ?? null,
      });
    }
  } else {
    const { data: parts } = await adminClient.from('tournament_participants')
      .select('id, player_id, elo_before, elo_after, group_number').eq('event_id', eventId);
    // elo_after is where the pool left them, with elo_before as the fallback for
    // an entry that somehow played nothing.
    for (const p of parts ?? []) {
      eloOf.set(p.id, p.elo_after ?? p.elo_before ?? 400);
      digestOf.set(p.id, {
        identity: singlesIdentity(p),
        dbGroup: (p as { group_number?: number | null }).group_number ?? null,
      });
    }
  }

  const capacity = Math.min(ownPoolCapacity(event), standings.length);
  const entries: FieldEntry[] = standings.slice(0, capacity).map((standing, i) => {
    // A standing whose entry row is not in the read above cannot be given a
    // digest, and an empty one would be refused by publish_event_draw every
    // single time with 'entrant_changed' — a permanent, unexplained failure.
    // Say what actually went wrong instead. Unlike elo, where 400 is a
    // legitimate default, there is no honest fallback identity.
    const digest = digestOf.get(standing.id);
    if (!digest) {
      throw new ExpectedError('A round-robin finisher no longer has an entry in this event. Reload and try again.');
    }
    return {
      id: standing.id,
      seed: i + 1,
      elo: eloOf.get(standing.id) ?? 400,
      identity: digest.identity,
      dbGroup: digest.dbGroup,
      group: (standing as { group?: number | null }).group ?? null,
      groupRank: (standing as { groupRank?: number | null }).groupRank ?? null,
    };
  });

  if (entries.length < 2) {
    throw new ExpectedError('The round robin produced fewer than 2 available finishers, which is not a knockout.');
  }

  // Persist the qualification order as the seed numbers. Same reasoning as the
  // two-event path: the in-memory order is what builds the bracket, so a seed
  // that never reached the table leaves the stored seeding disagreeing with the
  // draw it produced. Nothing has been created yet, so throwing costs a re-press.
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { failures } = await settleWrites(
    entries.map(e => [
      `${table}.seed_number for ${e.id}`,
      adminClient.from(table).update({ seed_number: e.seed }).eq('id', e.id),
    ] as const),
  );
  assertWritesSucceeded('Seeding the knockout from the round-robin standings', failures);

  return {
    entries,
    groupCount: (event.group_count as number | null) ?? 1,
    poolSize: standings.length,
  };
}

// ============================================================
// Bracket Generation — Single Elimination
// ============================================================

// ============================================================
// Third-place playoff
// ============================================================
//
// OPT-IN, not automatic, and the choice is made at generation.
//
// Automatic was the tempting default — it is a bracket property, so why ask?
// Because the thing being spent is court time, and the club does not always
// have it. Three reasons it has to be the exec's call:
//
//   * A 4-entry draw's "semi-finals" are round one. The third-place match is
//     then an immediate rematch between two people who have played exactly one
//     match each, on the same evening, for a placing nobody asked about. Some
//     events want that; a Tuesday social does not.
//   * A draw with byes may not produce two real semi-final losers — a bye has
//     no losing side. Generating the match regardless is right (see
//     advanceLoser), but committing every event to it regardless is not.
//   * Doing it automatically would change the shape of every event that already
//     exists the next time its draw was regenerated, silently.
//
// The choice is NOT stored on tournament_events. The generated match IS the
// record — is_third_place is what finalizeEvent and the bracket read — and a
// second column claiming an event "has" a third-place match could disagree with
// whether one exists. This module's whole defect history is a stored summary
// disagreeing with the rows underneath it.
//
// RATED, like every other match, and that took no code at all: the rating path
// keys off the result, not the round. That is the argument for it. Leaving it
// rated means the players' Elo reflects a real match with a real result, and
// exempting it would mean carving a round-shaped exception into
// applyTournamentMatchElo — which is precisely how a match ends up silently not
// counting.
const THIRD_PLACE_ROUND_NAME = '3rd Place Playoff';

/**
 * Create the third-place match and point both semi-finals' losers at it.
 *
 * Returns the match id, or null when the draw has no semi-final round to feed
 * it — a 2-entry draw is a final and nothing else. That case is skipped rather
 * than refused: the exec ticked a box, and failing the whole generation over a
 * playoff that cannot exist would be a worse answer than generating the draw
 * they actually need. The audit row records the skip.
 */
async function createThirdPlaceMatch(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  totalRounds: number,
  semiFinalIds: string[],
  phase: TournamentMatchPhase | null,
  // THE PLAYOFF NEEDS ITS OWN ANSWER (00108). It shares round_number with the
  // final and is held out of the round sequence by every index and every
  // reader, so a plan keyed by round number would have had no key for it and it
  // would have fallen back to the event default — the wrong shape, silently.
  // The shape lives on the row, so it is simply passed in, and it is the
  // final's: "third place games best to 3 21s".
  shape: { games_per_match: number; points_per_game: number } | null,
  generation: string,
): Promise<string | null> {
  if (totalRounds < 2 || semiFinalIds.length !== 2) return null;

  // Same round_number as the final, so it is scheduled alongside it — which is
  // what was asked for — and a second bracket_position so the two never collide.
  // The bracket UI lifts it out of the round columns entirely rather than
  // rendering it as a sibling of the final, because a card sitting in the final's
  // column with a connector into it would say it feeds the final. It feeds
  // nothing: winner_to_match_id stays null.
  const { data: created, error } = await adminClient.from('tournament_matches').insert({
    event_id: eventId,
    phase,
    draw_generation_id: generation,
    round_number: totalRounds,
    round_name: THIRD_PLACE_ROUND_NAME,
    bracket_position: 1,
    is_third_place: true,
    winner_to_match_id: null,
    winner_to_position: null,
    status: 'pending',
    ...(shape ?? {}),
  }).select('id').single();

  if (error || !created) {
    Sentry.captureException(error);
    throw new Error(`Failed to create the third-place match: ${error?.message ?? 'unknown error'}`);
  }

  // Both semi-finals, or neither. A half-routed playoff would take one loser and
  // wait forever for a second that nothing sends — and would look, in the
  // bracket, exactly like a playoff whose other semi-final has not finished.
  // Nothing has been played at this point, so throwing costs only a re-run.
  const { failures } = await settleWrites(
    semiFinalIds.map((id, i) => [
      `tournament_matches.loser_to_match_id for semi-final ${id}`,
      adminClient.from('tournament_matches')
        .update({ loser_to_match_id: created.id, loser_to_position: i === 0 ? 'a' : 'b' })
        .eq('id', id),
    ] as const)
  );
  assertWritesSucceeded('Routing the semi-final losers into the third-place match', failures);

  return created.id;
}

/**
 * @param drawSeed The seed the draw is made from. Defaulted rather than
 * required so every caller gets a fresh draw without having to think about it;
 * a caller that passes one gets that exact bracket back, which is what makes a
 * draw reproducible from its audit row.
 */
async function generateSingleEliminationBracketImpl(
  eventId: string,
  includeThirdPlace: boolean,
  drawSeed: number = newDrawSeed(),
) {
  const admin = await requireCapability('tournaments.draw.generate.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.format === 'staged') {
    throw new ExpectedError('This event is played in stages, so it is drawn one stage at a time from its Stages tab.');
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before generating bracket.');
  // The knockout half of the finalisation block, which only ever reached the
  // round-robin path (1922133 wired it into one of the two generators). The
  // reasoning applies here at least as hard: finalizeEvent reads final_position
  // off the BRACKET, so a completed knockout event whose matches were all voided
  // could be redrawn on top of a ledger that had already paid the old finishers.
  assertNotFinalised(event, 'regenerated');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // WHICH HALF THIS BUILDS. null on the two single-phase formats, where every
  // filter keyed off it below is a no-op and the behaviour is the untouched one.
  const phase = phaseValueFor(event.format as string, 'bracket');
  const ownPool = isPoolToBracket(event.format as string);
  // The knockout may not be drawn before the pool has been played. The field
  // check inside buildFieldFromOwnPool says so precisely; this says so early,
  // and stops an exec at `checkin` being told about pool matches that do not
  // exist yet.
  if (ownPool && (event.status === 'registration' || event.status === 'checkin')) {
    throw new ExpectedError(
      'This event plays a round robin first. Generate the round robin and play it out, then the knockout is drawn from its standings.',
    );
  }
  await assertDrawIsRebuildable(adminClient, eventId, phase);

  const doubles = isDoublesEvent(event.event_type);

  // NOBODY LEFT WAITING FOR A PARTNER. Checked before the field is read, and
  // for the pool-seeded path as well as the ordinary one: the field below comes
  // from tournament_pairs only, so anyone still unpaired in THIS event would be
  // dropped from the draw without a word. See assertNobodyLeftUnpaired.
  await assertNobodyLeftUnpaired(adminClient, eventId, doubles);

  // Fetch eligible participants/pairs
  let entries: FieldEntry[] = [];
  // A pool-seeded event takes its field and its order from the pool, so the
  // Elo/seed_number path below must not run — it would re-sort the draw by
  // rating and throw away the result everyone just played for.
  //
  // TRUE FOR BOTH POOL SHAPES. A pool_to_bracket event takes its field and its
  // order from its OWN pool, and everything downstream that keys off "the field
  // came from a pool" — do not re-seed by rating, draw within qualification
  // tiers rather than seeding bands, notify the drawn field only — is the same
  // question for both. The difference between them is only WHERE the standings
  // come from, which is the branch immediately below and nowhere else.
  const seededFromPool = Boolean(event.seeded_from_event_id) || ownPool;
  let poolPromoted = 0;
  let poolSkipped = 0;
  let poolGroupCount = 1;
  let ownPoolSize = 0;

  if (ownPool) {
    const field = await buildFieldFromOwnPool(adminClient, event, doubles);
    entries = field.entries;
    poolGroupCount = field.groupCount;
    ownPoolSize = field.poolSize;
  } else if (event.seeded_from_event_id) {
    const field = await buildFieldFromPool(adminClient, event, doubles, admin.id);
    entries = field.entries;
    poolPromoted = field.promoted;
    poolSkipped = field.skipped;
    poolGroupCount = field.groupCount;
  } else if (doubles) {
    // The member and group columns come back for the digest — 00202. This read
    // is the snapshot the draw is built from, so it is the only correct place
    // to take it from.
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, seed_number, combined_elo, group_number, player1_id, player2_id, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (pairs ?? []).map(p => ({
      id: p.id, seed: p.seed_number, elo: p.combined_elo ?? 400,
      identity: doublesIdentity(p),
      dbGroup: (p as { group_number?: number | null }).group_number ?? null,
    }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, seed_number, elo_before, elo_after, group_number, player_id, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (participants ?? []).map(p => ({
      id: p.id, seed: p.seed_number, elo: p.elo_before ?? 400,
      identity: singlesIdentity(p),
      dbGroup: (p as { group_number?: number | null }).group_number ?? null,
    }));
  }

  const N = entries.length;
  if (N < 2) throw new ExpectedError('Need at least 2 participants to generate a bracket');

  // ------------------------------------------------------------
  // THE SEEDS THAT WERE PROMISED A SKIP (00124)
  // ------------------------------------------------------------
  //
  // seed_skip_count is a FLOOR. It does not place a single bye — the byes are
  // already where it wants them. A field of N sits in a bracket of
  // nextPowerOf2(N); the empty slots are the tail ranks; getStandardSeedPositions
  // pairs rank r against rank B+1-r, so the empty tail falls opposite the TOP
  // RANKS and hands them the byes. See 00124's header for the full argument.
  //
  // RANKS, NOT SEEDS, AND THE GAP IS WHY THIS NUMBER IS ALSO PASSED TO THE
  // DRAW. The byes land on ranks 1..B-N; the draw shuffles entrants within
  // their seeding tier, so the entrant AT rank r is only guaranteed to be seed
  // r when the tier boundaries line up with the prefix. They do not in general:
  // a promise of 3 on a 5-strong field sits inside the [3,4] band, and a
  // promise of 9 on a 20-strong field sits inside [9,16] with the bye line at
  // 12 — so seeds 13-16 could take the last four byes while seeds 9-12 played
  // round one. Checking the COUNT of byes here and leaving the draw alone would
  // therefore validate a promise the draw was free to break.
  //
  // So the number goes to the shuffle as well, where it becomes a tier boundary
  // of its own (seedTierBandsReserving), and the check below stays a pure
  // count. One number, read once, enforced in the one place that can enforce
  // it — rather than a second post-draw validator that could disagree with the
  // first.
  //
  // So the number of byes is a function of N alone and nobody can choose it.
  // What an exec CAN do is state how many seeds they promised a skip to, and
  // this refuses to build a draw that would break the promise. It cannot be
  // checked when the number is set — nobody has entered yet — so it is checked
  // here, where N is real.
  //
  // BEFORE ANY WRITE, deliberately. Auto-seeding persists seed numbers a few
  // lines below and deletePhaseMatches tears down the old draw further down; a
  // refusal that lands after either leaves an exec with a half-changed event and
  // an error message. Refusing here costs a re-press and nothing else.
  //
  // The refusal never fires for a field that forces MORE byes than promised.
  // Those go to seeds N+1, N+2, ... as they always have — a floor, not a cap.
  const seedSkip = ((event as { seed_skip_count?: number | null }).seed_skip_count ?? 0);
  if (seedSkip > 0) {
    const availableByes = maxFirstRoundByes(N);
    if (seedSkip > availableByes) {
      throw new ExpectedError(
        `This event promises the top ${seedSkip} seed${seedSkip === 1 ? '' : 's'} a first-round bye, but a field of ${N} `
        + `sits in a ${nextPowerOf2(N)}-slot draw, which has ${availableByes === 0 ? 'no byes at all' : `only ${availableByes}`}. `
        + `The number of byes is fixed by the size of the field — a bracket holds a power of two, and the spare slots are what a bye is — `
        + `so there is no draw that can deliver more. `
        + (availableByes === 0
          ? 'Lower "Seeds Skipping Round One" to 0, or change the field size: a field of exactly 2, 4, 8, 16 … fills its bracket and leaves nobody a bye.'
          : `Lower "Seeds Skipping Round One" to ${availableByes} or fewer.`),
      );
    }
  }

  // THE SECOND HARD BLOCK. The field above is drawn from
  // status IN ('registered','checked_in') — no check-in required — so without
  // this an unsigned entrant an exec added is handed an opponent and a court
  // having passed no gate at all.
  await assertDrawFieldEventWaiverSigned(
    adminClient, event.tournament_id, entries.map(e => e.id), doubles,
  );

  // seeding_method = 'random' is a full shuffle of the field, hand seeds
  // discarded, made from drawSeed so the audit row reproduces it. The field is
  // put in id order first: it was read in seed order, which is arbitrary among
  // NULLs and is rewritten by the previous random draw.
  const randomSeeding = !seededFromPool && event.seeding_method === 'random';
  // If not yet seeded, auto-seed by Elo
  const needsSeeding = !seededFromPool && (randomSeeding || entries.some(e => e.seed === null));
  if (needsSeeding) {
    if (randomSeeding) entries = shuffleWithRng(inIdOrder(entries), makeDrawRng(drawSeed));
    else entries.sort((a, b) => b.elo - a.elo);
    entries.forEach((e, i) => { e.seed = i + 1; });
    // Persist seeds in parallel — independent rows, no contention. Same
    // reasoning as the pool path: the in-memory `entries` order is what builds
    // the bracket below, so a seed that never reached the table leaves the
    // stored seeding disagreeing with the draw it produced. Nothing has been
    // created yet, so throwing here costs only a re-run.
    const seedTable = doubles ? 'tournament_pairs' : 'tournament_participants';
    const { failures } = await settleWrites(
      entries.map(e => [
        `${seedTable}.seed_number for ${e.id}`,
        adminClient.from(seedTable).update({ seed_number: e.seed }).eq('id', e.id),
      ] as const)
    );
    assertWritesSucceeded(randomSeeding ? 'Seeding the draw at random' : 'Auto-seeding the draw by rating', failures);
  } else {
    entries.sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999));
  }

  // ------------------------------------------------------------
  // MAKE THE DRAW. Seeding put the field in order; this decides the bracket.
  // ------------------------------------------------------------
  //
  // SEEDING AND DRAWING ARE TWO STEPS, and only now are they written as two.
  // The seed numbers persisted above are the SEEDING — the rating order, the
  // exec's hand-set order, the pool's finishing order — and they are left
  // exactly as they were. What follows shuffles the entrants within their
  // seeding tiers to produce this particular bracket, which is why pressing
  // Regenerate now yields a different draw off an unchanged field.
  //
  // TWO FIELDS ARE NOT DRAWN, and both are somebody having already said where
  // people go:
  //
  //   * seeding_method = 'manual'. An exec who hand-set every seed asked for
  //     the draw those seeds describe, and has to keep getting it. This is the
  //     opt-out, and it is the only one.
  //   * A SINGLE-POOL-seeded event. buildFieldFromPool refuses a half-played
  //     pool precisely so the bracket matches what everyone just played for;
  //     re-drawing the qualifiers would put the pool's third finisher into the
  //     second seed's half on a coin flip, which is the outcome pool seeding
  //     exists to prevent. seeding_method is not even consulted on that path,
  //     so there would be no opt-out to offer.
  //
  // A GROUP-SEEDED EVENT IS THE THIRD CASE, AND IT IS DRAWN (00106).
  //
  // The argument above does not survive the move from one pool to several, and
  // it is worth saying exactly where it breaks. With ONE pool, the finishing
  // order is a total order that everybody played for: 3rd beat 4th, or beat the
  // people 4th lost to, and swapping them would overturn a result. With SEVERAL
  // groups there is no such order between groups. "Winner of A plays runner-up
  // of B" is fixed by the format, but WHICH B is a question the group stage
  // never asked and cannot answer — the groups played disjoint fixtures. Fixing
  // it to whichever group happens to be numbered lowest is not respecting a
  // result, it is inventing one, and it makes the bracket a pure function of
  // the group numbering, which is the "REGENERATE DOESN'T CHANGE ANYTHING"
  // defect wearing a different hat.
  //
  // So it is drawn — but WITHIN QUALIFICATION TIERS, not within seeding bands.
  // See drawAvoidingSameGroupRound1 for why drawWithinTiers is the wrong
  // shuffle here (its bands straddle the winner/runner-up boundary whenever the
  // group count is not a power of two) and for how the same-group round-one
  // constraint is enforced.
  //
  // `manual` still opts out, and now it opts out of this too: an exec who
  // hand-set the seeds after the groups finished has said where people go.
  const groupSeeded = seededFromPool && poolGroupCount >= 2;
  const drawIsRandomised = event.seeding_method !== 'manual' && (!seededFromPool || groupSeeded);
  let drawAttempts = 0;
  let sameGroupR1: 'avoided' | 'unavoidable' | 'not_applicable' = 'not_applicable';

  if (drawIsRandomised && groupSeeded) {
    const drawn = drawAvoidingSameGroupRound1(entries, {
      bracketSize: nextPowerOf2(N),
      // A qualifier whose groupRank somehow did not survive promotion is put in
      // a tier of its own at the end rather than silently joining the winners.
      tierOf: (e) => e.groupRank ?? Number.MAX_SAFE_INTEGER,
      groupOf: (e) => e.group ?? null,
      seed: drawSeed,
      reserveTop: seedSkip,
    });
    entries = drawn.entries;
    drawAttempts = drawn.attempts;
    sameGroupR1 = drawn.conflicts === 0 ? 'avoided' : 'unavoidable';
  } else if (drawIsRandomised && !randomSeeding) {
    // A random field is already shuffled whole above; tier bands would only
    // shuffle it again.
    entries = drawWithinTiers(entries, makeDrawRng(drawSeed), seedSkip);
  }

  const bracketSize = nextPowerOf2(N);
  const totalRounds = Math.log2(bracketSize);
  const numByes = bracketSize - N;

  // Get standard seeding positions
  const seedPositions = getStandardSeedPositions(bracketSize);

  // ------------------------------------------------------------
  // PLACE BY RANK, NOT BY THE STORED SEED NUMBER
  // ------------------------------------------------------------
  //
  // THIS SILENTLY DROPPED PEOPLE OUT OF THE DRAW, and a redraw is exactly how
  // you reached it. The line was
  //
  //     const entry = entries.find(e => e.seed === seedPositions[pos])
  //
  // and getStandardSeedPositions returns a permutation of 1..bracketSize — so
  // it only ever looked up seeds 1..bracketSize. Stored seed numbers are NOT
  // renumbered when somebody leaves: withdraw the top seed of a 5-entry event
  // and the four who remain are seeds 2,3,4,5 in a 4-slot draw, so seed 5 was
  // never looked up and that player vanished from their own event, while seed 1
  // was looked up, found nothing, and left a phantom bye in their place. The
  // existing regression test happened to withdraw the LAST seed, which is the
  // one case where the numbers stay in range.
  //
  // It survived because generation used to be reachable once, from a field
  // that had just been auto-seeded 1..N contiguously. Every way of reaching it
  // a second time — the Regenerate button, and now a redraw at `live` — starts
  // from a field whose seeds have holes in them.
  //
  // Duplicate seeds had the mirror defect: `.find` returns the first match
  // twice, seating one entrant in two slots and dropping another. Nothing
  // stops two entries sharing a seed — there is no unique index on
  // seed_number in either table, and the seed cell is hand-editable.
  //
  // `entries` is already in the order the draw wants — sorted by seed, or by
  // rating when auto-seeding, and then drawn within its tiers just above — so
  // the rank IS the index. `seed` on the slot is therefore the DRAW rank the
  // entrant was placed at, not the seed number stored against them; nothing
  // downstream reads it, and it is kept only because the slot's shape is what
  // the round-one loop below matches on.
  const bracketSlots: Array<{ id: string; seed: number } | null> = new Array(bracketSize).fill(null);
  for (let pos = 0; pos < bracketSize; pos++) {
    const rank = seedPositions[pos]!;
    const entry = entries[rank - 1];
    if (entry) {
      bracketSlots[pos] = { id: entry.id, seed: rank };
    }
  }

  // Delete the existing matches OF THIS PHASE. On a pool_to_bracket event the
  // played-out pool sits in the same table and must survive a redraw of the
  // knockout — see deletePhaseMatches.
  const generation = await deletePhaseMatches(adminClient, eventId, phase);

  // THE ROUND LADDER (00108). Stamped onto the rows as they are created rather
  // than stored as a plan on the event, so there is nothing that can disagree
  // with the matches — see the migration header. Applied to the pool_to_bracket
  // format only: giving every existing single_elimination event a ladder the
  // next time its draw was regenerated would silently change the shape of
  // matches an exec never asked to change. The per-round control (see
  // setRoundMatchShape) is offered on every knockout, so this is a default, not
  // a restriction.
  const ladder = ownPool ? knockoutLadder(totalRounds) : null;

  // Create all match shells from final backwards to round 1
  // matchesByRound[roundNumber] = array of match IDs in bracket_position order
  const matchesByRound: string[][] = [];

  for (let round = totalRounds; round >= 1; round--) {
    const matchCount = bracketSize / Math.pow(2, round);
    const roundName = getRoundName(round, totalRounds);
    const roundMatches: string[] = [];

    for (let pos = 0; pos < matchCount; pos++) {
      // The next round (closer to the final) was built in the previous loop
      // iteration since we count down from totalRounds, so index [round + 1].
      // Using [round] read the not-yet-populated current round -> every
      // winner_to_match_id was null and the bracket never advanced.
      const nextMatchId = round < totalRounds ? matchesByRound[round + 1]?.[Math.floor(pos / 2)] ?? null : null;
      const nextMatchPosition = round < totalRounds ? (pos % 2 === 0 ? 'a' : 'b') : null;

      const { data: match, error } = await adminClient.from('tournament_matches').insert({
        event_id: eventId,
        phase,
        draw_generation_id: generation,
        round_number: round,
        round_name: roundName,
        bracket_position: pos,
        match_number: null, // will assign later
        winner_to_match_id: nextMatchId,
        winner_to_position: nextMatchPosition,
        status: 'pending',
        // The round's own shape when there is a ladder; nothing at all when
        // there is not, so the columns stay NULL and the event decides exactly
        // as it always has.
        ...(ladder?.byRound.get(round) ?? {}),
      }).select('id').single();

      if (error) {
        Sentry.captureException(error);
        throw new Error(`Failed to create match: ${error.message}`);
      }

      roundMatches.push(match!.id);
    }

    matchesByRound[round] = roundMatches;
  }

  // Populate Round 1 matches with participants from bracket slots
  const round1Matches = matchesByRound[1] ?? [];
  let matchNumber = 1;

  for (let matchIdx = 0; matchIdx < round1Matches.length; matchIdx++) {
    const matchId = round1Matches[matchIdx];
    const slotA = bracketSlots[matchIdx * 2];
    const slotB = bracketSlots[matchIdx * 2 + 1];

    const updateData: Record<string, unknown> = {
      match_number: matchNumber++,
    };

    if (doubles) {
      updateData.pair_a_id = slotA?.id ?? null;
      updateData.pair_b_id = slotB?.id ?? null;
    } else {
      updateData.participant_a_id = slotA?.id ?? null;
      updateData.participant_b_id = slotB?.id ?? null;
    }

    // Determine if this is a bye
    const isBye = (slotA !== null && slotB === null) || (slotA === null && slotB !== null);

    if (isBye) {
      const winner = slotA ?? slotB;
      updateData.is_bye = true;
      updateData.status = 'completed';
      if (doubles) {
        updateData.winner_pair_id = winner!.id;
      } else {
        updateData.winner_participant_id = winner!.id;
      }
    } else if (slotA !== null && slotB !== null) {
      updateData.status = 'ready';
    }

    await mustWrite(
      `Seeding round-1 match ${matchId}`,
      adminClient.from('tournament_matches').update(updateData).eq('id', matchId).select('id'),
    );

    // If bye, advance winner to next match
    if (isBye) {
      const { data: currentMatch, error: routeErr } = await adminClient.from('tournament_matches')
        .select('winner_to_match_id, winner_to_position')
        .eq('id', matchId)
        .single();
      // A failed read here reads as "this match routes nowhere", which for a
      // bye means the player who received it is never advanced — a bracket
      // with a missing entrant in round 2, published as complete.
      if (routeErr) {
        throw new Error(`Reading the winner route for match ${matchId} failed: ${routeErr.message}`);
      }

      if (currentMatch?.winner_to_match_id) {
        const advanceField = doubles
          ? (currentMatch.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
          : (currentMatch.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

        await mustWrite(
          `Advancing the bye from match ${matchId} into ${currentMatch.winner_to_match_id}`,
          adminClient.from('tournament_matches')
            .update({ [advanceField]: (slotA ?? slotB)!.id })
            .eq('id', currentMatch.winner_to_match_id)
            .select('id'),
        );

        // Check if next match now has both participants → set to ready
        const { data: nextMatch, error: nextErr } = await adminClient.from('tournament_matches')
          .select('*')
          .eq('id', currentMatch.winner_to_match_id)
          .single();
        if (nextErr) {
          throw new Error(`Reading match ${currentMatch.winner_to_match_id} failed: ${nextErr.message}`);
        }

        if (nextMatch) {
          const hasBoth = doubles
            ? (nextMatch.pair_a_id && nextMatch.pair_b_id)
            : (nextMatch.participant_a_id && nextMatch.participant_b_id);
          if (hasBoth) {
            await mustWrite(
              `Marking match ${currentMatch.winner_to_match_id} ready`,
              adminClient.from('tournament_matches')
                .update({ status: 'ready' })
                .eq('id', currentMatch.winner_to_match_id)
                .select('id'),
            );
          }
        }
      }
    }
  }

  // Created after round 1 is populated, so a failure here leaves a draw that is
  // already playable rather than one with a dangling playoff. matchesByRound
  // holds only the main draw, so the semi-final round is unambiguous.
  const thirdPlaceId = includeThirdPlace
    ? await createThirdPlaceMatch(
        adminClient, eventId, totalRounds, matchesByRound[totalRounds - 1] ?? [],
        phase, ladder?.thirdPlace ?? null, generation,
      )
    : null;

  // Assign match numbers for remaining rounds — collect all (id, number) pairs
  // and issue UPDATEs in parallel.
  const matchNumberAssignments: Array<{ id: string; number: number }> = [];
  for (let round = 2; round <= totalRounds; round++) {
    for (const mId of matchesByRound[round] ?? []) {
      matchNumberAssignments.push({ id: mId, number: matchNumber++ });
    }
  }
  // Numbered last, so the playoff carries the highest match number on the card
  // and the final keeps the number it would have had without this feature.
  // An exec reading a scoresheet expects M7 to be the final of an 8-draw.
  if (thirdPlaceId) matchNumberAssignments.push({ id: thirdPlaceId, number: matchNumber++ });
  if (matchNumberAssignments.length > 0) {
    const { failures } = await settleWrites(
      matchNumberAssignments.map(a => [
        `tournament_matches.match_number for ${a.id}`,
        adminClient.from('tournament_matches').update({ match_number: a.number }).eq('id', a.id),
      ] as const)
    );
    // Thrown before the event flips to bracket_generated, which is what makes
    // this recoverable: the event stays in check-in, no result can have been
    // entered yet, and re-running generation deletes these matches and starts
    // over. A bracket with holes in its numbering is not something the exec
    // should have to notice on the day.
    assertWritesSucceeded('Numbering the bracket matches', failures);
  }

  // Audit F-004, the draw half: a member who entered while this draw was being
  // built is in the event and would be in no match. Checked BEFORE the publish,
  // so nothing has been advertised and the matches inserted above are simply
  // replaced by the next Generate. Pool-seeded events are exempt — their field
  // comes from another event's standings, so a new entry here was never going
  // to be in it.
  if (!seededFromPool) await assertFieldDidNotGrow(adminClient, eventId, doubles, N);

  // Update event status.
  //
  // THE LAST WRITE IS THE ONE THAT PUBLISHES THE DRAW, so it is the one that
  // must never succeed quietly on top of a failure. Everything above now
  // throws rather than continuing, which means reaching this line is the
  // assertion that the whole draw landed; letting this one write fail silently
  // would leave the event advertising a bracket it does not have.
  // THE RE-COUNT AND THE FLIP UNDER ONE LOCK (00193). assertFieldDidNotGrow
  // above re-counts the field, but "immediately before the flip" is not
  // "atomically with it": an entry landing in that gap is admitted by
  // enter_tournament_event — correctly, the event is still open — and is not in
  // this bracket. publish_event_draw takes the event row, which is the same row
  // an entry must take, so only two orderings exist: the entry commits first
  // and this refuses, or this commits first and the entry is closed out.
  // NO LONGER A COUNT, AND NO LONGER EXEMPT (00200). The count was `null` for a
  // pool-seeded draw because the entrants are the qualifiers, not everyone
  // registered, so a live total of the participant table is not the number this
  // draw was built from and would have refused every pool-to-bracket
  // publication. Passing the ids splits that into two questions, and only the
  // second one is about the whole field — so the first, "is everybody in this
  // draw still in the event", is now asked on the pool path too.
  // `entries` is the field this bracket was built from, whatever produced it —
  // the pool builders return the same shape as the two direct reads. So the
  // pool-seeded path is no longer exempt from the check: it passes its
  // qualifiers and asks only that they all still be in the event, which is the
  // half a live count of the participant table could never express.
  await publishDraw(
    adminClient, eventId, statusAfterDraw(event, phase), doubles,
    entries.map(e => e.id), entries.map(entrantDigest), !seededFromPool, phase, generation,
  );

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'bracket_generated',
    performed_by: admin.id,
    details: {
      bracket_size: bracketSize,
      participants: N,
      byes: numByes,
      // The promise this draw was checked against (00124), recorded next to the
      // byes it was checked against so the pair can be read together. It is
      // always <= byes here — generation refused otherwise — and 0 means no
      // promise was made rather than "a promise of nothing".
      seed_skip_promised: seedSkip,
      // Recorded as three distinguishable states, not a boolean: "asked for and
      // created", "asked for and impossible" (a 2-entry draw has no semi-finals)
      // and "not asked for". The middle one is the only silent outcome in this
      // function, so it is the one the audit trail owes an explanation for.
      third_place_match: includeThirdPlace ? (thirdPlaceId ? 'created' : 'skipped_no_semi_finals') : 'not_requested',
      // A redraw of a RUNNING event is the one worth being able to find again
      // in the audit trail months later — it is the only case where the matches
      // this deleted had already been published to the people playing them.
      redrawn_live: event.status === 'live',
      // THE SEED THIS BRACKET WAS DRAWN FROM, and the reason the feature needed
      // no schema change. A draw that cannot be explained is a draw an exec
      // cannot defend when a player asks why they got that half — so the seed
      // goes in the audit trail, where re-running generation with it reproduces
      // the identical bracket from the identical field. `null` when the draw was
      // not randomised, which says so rather than implying a seed nobody used.
      draw_seed: drawIsRandomised ? drawSeed : null,
      draw_randomised: drawIsRandomised,
      // WHETHER THE GROUP CONSTRAINT HELD, in three states rather than a
      // boolean, for the same reason third_place_match is: "unavoidable" is the
      // only silent outcome here, and it is the one an exec will be asked about
      // when two group-mates find themselves playing again in round one.
      // `draw_attempts` says how hard it tried, which is what distinguishes a
      // genuinely impossible field from a run of bad luck.
      ...(groupSeeded
        ? { same_group_round_1: sameGroupR1, draw_attempts: drawAttempts, source_group_count: poolGroupCount }
        : {}),
      // Recorded because a pool-seeded draw is not reproducible from the event
      // row alone — the pool can be edited afterwards.
      ...(ownPool
        ? {
            // No seeded_from_event_id and no promotion counts, because there is
            // no second event and nothing was promoted — the qualifiers are the
            // same rows that played the pool. What is worth recording is how
            // many finished and how many got out.
            phase: 'bracket',
            seeded_from_own_pool: true,
            seed_by: event.seed_by ?? 'wins',
            pool_finishers: ownPoolSize,
            qualified: N,
            round_ladder: ladder
              ? [...ladder.byRound.entries()].map(([round, sh]) => ({ round, ...sh }))
              : null,
          }
        : event.seeded_from_event_id
          ? {
              seeded_from_event_id: event.seeded_from_event_id,
              seed_by: event.seed_by ?? 'wins',
              promoted_from_pool: poolPromoted,
              qualifiers_skipped: poolSkipped,
            }
          : {}),
    },
  });

  // Draw slides for the Marketing holders (social_posts, 00333). Never fails the draw.
  try {
    await queueDrawSocialPosts(adminClient, eventId);
  } catch (err) {
    Sentry.captureException(err);
  }

  // Notify all participants that bracket is published. A pool-seeded event may
  // hold entries who did not make the cut, so it notifies the drawn field only
  // — telling someone their bracket is published when they are not in it is
  // worse than telling them nothing.
  const bracketPlayerIds: string[] = [];
  const fieldIds = entries.map(e => e.id);
  if (doubles) {
    let q = adminClient.from('tournament_pairs')
      .select('player1_id, player2_id').eq('event_id', eventId).in('status', ['registered', 'checked_in']);
    if (seededFromPool) q = q.in('id', fieldIds);
    const { data: allPairs } = await q;
    for (const p of allPairs ?? []) { bracketPlayerIds.push(p.player1_id, p.player2_id); }
  } else {
    let q = adminClient.from('tournament_participants')
      .select('player_id').eq('event_id', eventId).in('status', ['registered', 'checked_in']);
    if (seededFromPool) q = q.in('id', fieldIds);
    const { data: allParts } = await q;
    for (const p of allParts ?? []) { bracketPlayerIds.push(p.player_id); }
  }
  const { data: tournamentInfo } = await adminClient.from('tournaments').select('name').eq('id', event.tournament_id).single();
  await notifyPlayers(adminClient, bracketPlayerIds,
    'Bracket Published',
    `The bracket for ${tournamentInfo?.name ?? 'your tournament'} has been published. Check your matches!`,
    { event_id: eventId, tournament_id: event.tournament_id },
    'tournament_bracket_published'
  );

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Bracket Generation — Round Robin
// ============================================================
//
// DELIBERATELY NOT RANDOMISED, and this is the note saying so rather than an
// omission. The circle method emits the COMPLETE set of pairings: everybody
// plays everybody, so there is no draw to make and nothing a shuffle could
// change about who meets whom. All it could reorder is the round each fixture
// falls in, which is a scheduling question (courts, rest between matches), not
// a fairness one — and re-rolling the order of an event that is already live
// would move people's matches around for no gain. A round robin's "Regenerate"
// producing the same fixture list is the correct answer, not the bug the
// knockout path had.
//
// STILL TRUE WITH GROUPS (00106). The randomness a group stage needs is in the
// ASSIGNMENT — who is in which group — and that is decided by seed, not by
// chance, precisely so the groups come out balanced. Inside a group the circle
// method is complete again, so there is still no draw to make.
//
// The one exception is seeding_method = 'random', where the exec asked for
// chance over balance: the field is shuffled before it is dealt into groups.
// See planGroupAssignment.

async function generateRoundRobinMatchesImpl(eventId: string) {
  const admin = await requireCapability('tournaments.draw.generate.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.format === 'staged') {
    throw new ExpectedError('This event is played in stages, so it is drawn one stage at a time from its Stages tab.');
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before generating matches.');
  assertNotFinalised(event, 'regenerated');

  // THE POOL HALF OF A POOL-TO-BRACKET EVENT (00107). Same generator, same
  // circle method, same group handling — what differs is that its matches are
  // labelled, its own results are the only ones that can block a rebuild, and
  // it leaves the event in the pool pair of states rather than the knockout's.
  const phase = phaseValueFor(event.format as string, 'pool');
  // ONCE THE KNOCKOUT IS DRAWN THE POOL IS HISTORY. Rebuilding it then would
  // delete the fixtures the bracket's seeding was read off and leave the two
  // halves describing different events — and the bracket cannot be un-drawn to
  // repair it, because it may already have results. Refused rather than
  // repaired.
  if (phase && ['bracket_generated', 'live', 'completed'].includes(event.status as string)) {
    throw new ExpectedError(
      'The knockout has already been drawn from this round robin, so the round robin can no longer be rebuilt. '
      + 'Void the knockout matches and regenerate the knockout if the standings have changed.',
    );
  }
  await assertDrawIsRebuildable(adminClient, eventId, phase);
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const doubles = isDoublesEvent(event.event_type);

  // Same block as the knockout path. A round robin gives every entrant a match,
  // so a member still waiting for a partner would be left out of the whole
  // event rather than out of one draw.
  await assertNobodyLeftUnpaired(adminClient, eventId, doubles);

  // group_number and the rating come back too, because a group stage assigns
  // any entry that does not yet have a group and needs the same ordering the
  // Assign Groups button uses to do it.
  let entries: Array<{
    id: string; seed: number | null; elo: number; group: number | null;
    identity: EntrantIdentity; dbGroup: number | null;
  }> = [];

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, seed_number, combined_elo, group_number, player1_id, player2_id, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (pairs ?? []).map(p => ({
      id: p.id,
      seed: p.seed_number,
      elo: p.combined_elo ?? 400,
      identity: doublesIdentity(p),
      dbGroup: (p as { group_number?: number | null }).group_number ?? null,
      group: (p as { group_number?: number | null }).group_number ?? null,
    }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, seed_number, elo_before, elo_after, group_number, player_id, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (participants ?? []).map(p => ({
      id: p.id,
      seed: p.seed_number,
      elo: p.elo_before ?? 400,
      identity: singlesIdentity(p),
      dbGroup: (p as { group_number?: number | null }).group_number ?? null,
      group: (p as { group_number?: number | null }).group_number ?? null,
    }));
  }

  const N = entries.length;
  if (N < 3) throw new ExpectedError('Need at least 3 participants for round robin');

  // Same block as the knockout path, for the same reason — a round robin gives
  // every entrant a match, so an unsigned one plays the whole field.
  await assertDrawFieldEventWaiverSigned(
    adminClient, event.tournament_id, entries.map(e => e.id), doubles,
  );

  // ------------------------------------------------------------
  // GROUPS (00106). One event, several round robins inside it.
  // ------------------------------------------------------------
  //
  // group_count NULL or 1 takes the single-group path below with a group of
  // everybody, which is byte-for-byte the fixture list this function has always
  // produced — the flat behaviour is not reimplemented on top of the group one,
  // it IS the group one with one group.
  const groupCount = (event as { group_count?: number | null }).group_count ?? 1;
  // seeding_method = 'random' deals a shuffled field into the groups instead of
  // a seeded one. The seed goes in the audit row so the deal can be explained.
  const randomSeeding = event.seeding_method === 'random';
  const drawSeed = newDrawSeed();

  if (groupCount >= 2) {
    // FILL THE GAPS, DO NOT RE-DEAL. An exec who moved somebody between groups
    // before pressing Generate meant it, and a generator that re-dealt the
    // field would throw that away without saying so. planGroupAssignment keeps
    // every valid existing group and only places the entries that have none —
    // which is the whole field the first time, and just the late entrant the
    // second time.
    const plan = planGroupAssignment(entries, groupCount, randomSeeding ? { rng: makeDrawRng(drawSeed) } : undefined);

    // CHECKED BEFORE ANYTHING IS WRITTEN, and the order is the point. A group of
    // one has nobody to play, so the event would hand that entrant no matches at
    // all and then rank them first on a record of nothing. Refusing AFTER the
    // group_number writes would leave the event carrying a half-applied
    // assignment it never asked for — a refusal has to leave the row exactly as
    // it found it. The plan is enough to count sizes; no write is needed to know.
    const planned = new Array<number>(groupCount).fill(0);
    for (const g of plan.values()) planned[g - 1]!++;
    const short = planned
      .map((size, i) => ({ size, number: i + 1 }))
      .filter(g => g.size < 2);
    if (short.length > 0) {
      throw new ExpectedError(
        `Group ${short.map(g => groupLabel(g.number)).join(', ')} ` +
        `${short.length === 1 ? 'has' : 'have'} fewer than 2 entries, so nobody there would have a match. ` +
        'Lower the group count or move somebody across.',
      );
    }

    const newlyAssigned = entries.filter(e => e.group !== plan.get(e.id));
    if (newlyAssigned.length > 0) {
      const table = doubles ? 'tournament_pairs' : 'tournament_participants';
      const { failures } = await settleWrites(
        newlyAssigned.map(e => [
          `${table}.group_number for ${e.id}`,
          adminClient.from(table).update({ group_number: plan.get(e.id)! }).eq('id', e.id),
        ] as const),
      );
      // The in-memory plan is what the fixtures below are built from, so a
      // group that never reached the table would leave the standings
      // partitioning one way and the schedule another. Nothing has been created
      // yet — the delete is still ahead — so refusing costs only a re-press.
      assertWritesSucceeded('Assigning the groups for this round robin', failures);
    }
    // dbGroup MOVES WITH IT — 00202. This generator writes group_number itself,
    // so the digest's grp has to be the value it just wrote; leaving it at the
    // snapshot's would make publication refuse this draw's own legitimate write.
    // On the round-robin path the two are the same number, which is exactly why
    // they are kept as separate fields: on a pool-seeded knockout `group` is the
    // group somebody qualified out of in ANOTHER event.
    for (const e of entries) { e.group = plan.get(e.id)!; e.dbGroup = plan.get(e.id)!; }
  } else {
    for (const e of entries) e.group = 1;
  }

  const groups: Array<{ number: number; entries: typeof entries }> = [];
  for (let g = 1; g <= Math.max(1, groupCount); g++) {
    groups.push({ number: g, entries: entries.filter(e => e.group === g) });
  }

  // Delete any existing matches OF THIS PHASE — see deletePhaseMatches.
  const generation = await deletePhaseMatches(adminClient, eventId, phase);

  // ONE SHARED ROUND NUMBERING ACROSS THE GROUPS, and one shared
  // bracket_position within each round. 00081 put a UNIQUE index on
  // (event_id, round_number, bracket_position) WHERE NOT is_third_place, so
  // running the circle method per group and letting each start its positions at
  // 0 would collide on the second group's very first fixture. Positions are
  // therefore handed out by a per-round counter that spans every group.
  //
  // Rounds are shared rather than offset because Round 1 of group A and Round 1
  // of group B genuinely are the same round — they are played at the same time,
  // on different courts — and because the event page already groups its match
  // list by round_number. Groups of different sizes simply stop contributing
  // once their own circle runs out.
  const positionInRound = new Map<number, number>();
  const roundsByGroup = groups.map(g => ({ number: g.number, rounds: circleMethodRounds(g.entries) }));
  const numRounds = roundsByGroup.reduce((max, g) => Math.max(max, g.rounds.length), 0);
  let matchNumber = 1;

  for (let round = 0; round < numRounds; round++) {
    for (const group of roundsByGroup) {
      for (const [home, away] of group.rounds[round] ?? []) {
        const pos = positionInRound.get(round) ?? 0;
        positionInRound.set(round, pos + 1);

        const insertData: Record<string, unknown> = {
          event_id: eventId,
          phase,
          draw_generation_id: generation,
          // THE POOL IS PLAYED TO 11 (00108) — "we play round robin 11s". Only
          // on the pool_to_bracket format, for the same reason the knockout
          // ladder is: an ordinary round robin that has always been played at
          // its event shape must keep being played at it.
          ...(phase === 'pool' ? POOL_LADDER_SHAPE : {}),
          round_number: round + 1,
          // The group is on the entries, not in the name, so RoundRobinTab's
          // existing "one heading per round_number" rendering keeps working and
          // the group is shown per fixture instead.
          round_name: `Round ${round + 1}`,
          bracket_position: pos,
          match_number: matchNumber++,
          status: 'pending',
        };

        if (doubles) {
          insertData.pair_a_id = home.id;
          insertData.pair_b_id = away.id;
        } else {
          insertData.participant_a_id = home.id;
          insertData.participant_b_id = away.id;
        }

        // A round-robin fixture that fails to insert used to leave a hole in
        // the published schedule: two players who never find their match on
        // the board, discovered on the day.
        await mustWrite(
          `Inserting round-robin fixture ${insertData.match_number ?? ''}`.trim(),
          adminClient.from('tournament_matches').insert(insertData).select('id'),
        );
      }
    }
  }

  // Audit F-004, the draw half: a member who entered while this draw was being
  // built is in the event and would be in no match. Checked BEFORE the publish,
  // so nothing has been advertised and the matches inserted above are simply
  // replaced by the next Generate. Pool-seeded events are exempt — their field
  // comes from another event's standings, so a new entry here was never going
  // to be in it.
  await assertFieldDidNotGrow(adminClient, eventId, doubles, N);

  // Update event status.
  //
  // THE LAST WRITE IS THE ONE THAT PUBLISHES THE DRAW, so it is the one that
  // must never succeed quietly on top of a failure. Everything above now
  // throws rather than continuing, which means reaching this line is the
  // assertion that the whole draw landed; letting this one write fail silently
  // would leave the event advertising a bracket it does not have.
  // THE RE-COUNT AND THE FLIP UNDER ONE LOCK (00193). assertFieldDidNotGrow
  // above re-counts the field, but "immediately before the flip" is not
  // "atomically with it": an entry landing in that gap is admitted by
  // enter_tournament_event — correctly, the event is still open — and is not in
  // this bracket. publish_event_draw takes the event row, which is the same row
  // an entry must take, so only two orderings exist: the entry commits first
  // and this refuses, or this commits first and the entry is closed out.
  await publishDraw(
    adminClient, eventId, statusAfterDraw(event, phase), doubles,
    entries.map(e => e.id), entries.map(entrantDigest), true, phase, generation,
  );

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'round_robin_generated',
    performed_by: admin.id,
    details: {
      participants: N,
      rounds: numRounds,
      redrawn_live: event.status === 'live' || event.status === 'pool_live',
      ...(phase ? { phase } : {}),
      // Recorded even when it is 1, so a fixture list can always be explained
      // from its own audit row without re-reading an event that may since have
      // been edited.
      group_count: groupCount,
      ...(groupCount >= 2
        ? { group_sizes: groups.map(g => g.entries.length), matches: matchNumber - 1 }
        : {}),
      ...(groupCount >= 2 && randomSeeding ? { draw_seed: drawSeed } : {}),
    },
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Public entry points
// ============================================================
// Same reasoning as the result actions: Next.js sanitises anything thrown out
// of a Server Action in a production build, so a guard that throws is invisible
// exactly where it matters. Generation now returns its refusal as a value —
// "3 pool matches have not been played" is the whole point of the guard — and
// runAction keeps those refusals out of Sentry, which only wants real faults.

// includeThirdPlace defaults to false so an existing caller — and a stale client
// bundle mid-deploy — generates exactly the draw it generated before.
export async function generateSingleEliminationBracket(
  eventId: string,
  includeThirdPlace = false,
): Promise<ActionResult<void>> {
  return runAction(async () => { await generateSingleEliminationBracketImpl(eventId, includeThirdPlace); });
}

export async function generateRoundRobinMatches(eventId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await generateRoundRobinMatchesImpl(eventId); });
}

// ============================================================
// Draw Lock/Unlock
// ============================================================

export async function lockDraw(eventId: string) {
  const admin = await requireCapability('tournaments.draw.lock.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  const { error } = await adminClient.from('tournament_events')
    .update({ draw_locked: true, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'draw_locked',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

export async function unlockDraw(eventId: string) {
  const admin = await requireCapability('tournaments.draw.unlock.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  const { error } = await adminClient.from('tournament_events')
    .update({ draw_locked: false, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'draw_unlocked',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// The shape one ROUND is played to (00108)
// ============================================================
//
// "we play round robin 11s then play single elim first round 11s, quarter 15s
// semis 21s finals and third place games best to 3 21s".
//
// PER ROUND, NOT PER MATCH, because that is the unit the club thinks in — "the
// quarter-finals" is a thing an exec says, "match 6" is not — and because a
// draw in which two quarter-finals were played to different lengths is not a
// format, it is a mistake. The round is addressed by its NUMBER within a phase,
// with the third-place playoff addressed separately (it shares round_number
// with the final and is not part of the round sequence; see 00080).
//
// AFTER GENERATION, NOT AT CREATION. A round has no identity until the draw
// exists: whether round 2 is the quarter-final or the semi-final depends on how
// many entries turned up, and the club names rounds by what they are ("quarter
// final"), not by their index. The default ladder is applied at generation for
// exactly this reason — it is anchored from the final backwards, which is only
// knowable once the size is — and this action is how any of it is changed.
//
// A ROUND WITH A RESULT IN IT IS REFUSED, NOT SILENTLY RE-JUDGED. Changing the
// shape under a recorded score would re-decide whether that score was ever
// legal, and would change the Elo weight the match was rated at without
// reversing the delta already applied. Both are silent. isPlayedMatch is the
// same definition assertDrawIsRebuildable uses, so byes do not block.

/** Clearing every override on a round: back to whatever the event says. */
export type RoundShapeInput = {
  games_per_match: number;
  points_per_game: number;
} | null;

async function setRoundMatchShapeImpl(
  eventId: string,
  target: { phase: TournamentMatchPhase | null; roundNumber: number | null; thirdPlace: boolean },
  shape: RoundShapeInput,
) {
  // NO NEW CAPABILITY. This is the event's match format, addressed one round at
  // a time, so it is governed by the capability that already owns the event's
  // format.
  const admin = await requireCapability('tournaments.manage.event.update.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  // A staged event's scoring is its stage's, set in the event's stages.
  if (event.format === 'staged') throw new ExpectedError('This event is played in stages: change a stage\'s scoring in its stages instead.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);
  assertNotFinalised(event, 'changed');

  if (shape) {
    const { minGames, maxGames, minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;
    // The same sentences normalizeTypedFormat gives for the event-level fields,
    // so a bad number reads the same wherever it is typed. The CHECK constraint
    // in 00108 is the real enforcement; this is what the exec sees.
    if (!Number.isInteger(shape.games_per_match) || shape.games_per_match < minGames
      || shape.games_per_match > maxGames || shape.games_per_match % 2 === 0) {
      throw new ExpectedError(`Games per match must be an odd number between ${minGames} and ${maxGames} — an even best-of cannot be decided.`);
    }
    if (!Number.isInteger(shape.points_per_game) || shape.points_per_game < minPoints || shape.points_per_game > maxPoints) {
      throw new ExpectedError(`Points per game must be between ${minPoints} and ${maxPoints}.`);
    }
  }

  // Which rows. The third-place playoff is addressed on its own because it
  // shares round_number with the final — matching on the number alone would
  // sweep it into the final's change, which is right by default and wrong the
  // moment somebody wants them different.
  let q = adminClient.from('tournament_matches')
    .select('id, status, is_bye, round_name')
    .eq('event_id', eventId);
  if (target.phase) q = q.eq('phase', target.phase);
  else q = q.is('phase', null);
  // `.not('is_third_place','is',true)` rather than `.eq(false)`, matching
  // assertDrawIsRebuildable's treatment of is_bye: the negative form is
  // null-safe, and a row written before 00080 added the column with a default
  // must not silently drop out of its own round.
  if (target.thirdPlace) q = q.eq('is_third_place', true);
  else q = q.not('is_third_place', 'is', true).eq('round_number', target.roundNumber!);

  const { data: matches, error: readError } = await q;
  // The error is not discarded, for the same reason assertDrawIsRebuildable does
  // not discard its own: supabase-js resolves rather than rejects on a
  // PostgREST error, so a failed read would look like "this round has no
  // matches" and the update below would silently do nothing while reporting
  // success.
  if (readError) {
    Sentry.captureException(readError);
    throw new Error(`Could not read this round's matches, so nothing was changed: ${readError.message}`);
  }
  if (!matches || matches.length === 0) {
    throw new ExpectedError('That round has no matches. Generate the draw first.');
  }

  const played = matches.filter(m => isPlayedMatch(m as { status?: string | null; is_bye?: boolean | null }));
  if (played.length > 0) {
    const n = played.length;
    throw new ExpectedError(
      `${n} match${n === 1 ? '' : 'es'} in this round already ${n === 1 ? 'has' : 'have'} a result, `
      + 'and changing what the round is played to would re-judge scores that are already recorded and re-weight the ratings they earned. '
      + `Void ${n === 1 ? 'it' : 'them'} first if the round really has to change. Byes do not count towards this.`,
    );
  }

  const patch = shape
    ? { games_per_match: shape.games_per_match, points_per_game: shape.points_per_game }
    // NULL rather than the event's current numbers, so "use the event default"
    // keeps meaning that afterwards: written out as values, the round would
    // silently stop following an event whose format was later changed.
    : { games_per_match: null, points_per_game: null };

  const { failures } = await settleWrites(
    matches.map(m => [
      `tournament_matches shape for ${m.id}`,
      adminClient.from('tournament_matches').update(patch).eq('id', m.id),
    ] as const),
  );
  // A HALF-APPLIED ROUND IS THE ONE OUTCOME THAT MUST NOT BE QUIET: two
  // quarter-finals to 15 and two to 21 is a draw nobody can referee, and
  // nothing on the page would show it. Re-running is the whole remedy — the
  // write is absolute and no result can exist in this round.
  assertWritesSucceeded('Setting the shape of this round', failures);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'round_shape_set',
    performed_by: admin.id,
    details: {
      phase: target.phase,
      round_number: target.thirdPlace ? null : target.roundNumber,
      third_place: target.thirdPlace,
      round_name: matches[0]?.round_name ?? null,
      matches: matches.length,
      ...(shape ?? { cleared: true }),
    },
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

/**
 * Set (or clear) what one round of a draw is played to.
 *
 * @param roundNumber the round within `phase`, or null when `thirdPlace` is set
 * @param shape null clears the override so the round follows the event again
 */
export async function setRoundMatchShape(
  eventId: string,
  target: { phase: TournamentMatchPhase | null; roundNumber: number | null; thirdPlace?: boolean },
  shape: RoundShapeInput,
): Promise<ActionResult<void>> {
  return runAction(async () => {
    await setRoundMatchShapeImpl(
      eventId,
      { phase: target.phase, roundNumber: target.roundNumber, thirdPlace: target.thirdPlace === true },
      shape,
    );
  });
}
