'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  adminMatchCreateSchema,
  isLegalCustomGames,
  isLegalCustomPoints,
  CUSTOM_FORMAT_BOUNDS,
  ExpectedError,
  requireActiveSeasonId,
  getRulesFor,
  validateGamesForRules,
  type MatchFormat,
} from '@badminton/shared';
import { requireCapability } from './_shared';
import { runAction, type ActionResult } from '../action-result';
import { MATCH_ADMIN_NOTE_TABLE, isMissingNoteTableError } from '../match-note';
import { REASON_MIN } from '../audit-reason';

// ============================================================
// Match Management
// ============================================================

/**
 * Record an exec's free text about a match, in the private table that holds it.
 *
 * ONE CALLER LEFT: adminCreateMatch. Void and Convert used to come through
 * here too; since 00203 they are single transactions in SQL that write their
 * own note, because in one transaction a failed note write can take the whole
 * mutation with it and there is no partial state to report. What follows is
 * why this shape is still right for the caller that remains.
 *
 * A SEPARATE STATEMENT, NEVER FOLDED INTO THE MATCH WRITE. `match_admin_notes`
 * arrives with migration 00117, which the owner applies by hand — so this
 * console can be, and routinely is, deployed against a database that has never
 * heard of the table. Written as part of the `matches` insert, an absent table
 * would fail the WHOLE statement and `if (error) throw` would turn recording a
 * match into a red toast for the sake of an annotation nobody asked about.
 * Isolated here, the match is still recorded and the note is a silent no-op
 * until the SQL lands.
 *
 * This is the same shape as the `require_scan_to_check_in` write in
 * lib/actions/sessions.ts (00116), with one difference worth naming: there the
 * pre-migration failure is a missing COLUMN (PGRST204 / 42703), here it is a
 * missing TABLE (PGRST205 / 42P01). isMissingNoteTableError knows the
 * difference; the sessions predicate would not have caught it.
 *
 * IT NEVER THROWS, AND IT DISTINGUISHES THREE OUTCOMES rather than two. The
 * two-way version — "null means fine" — collapses "written" and "the table is
 * not there yet" into one answer, and the caller needs them apart: the audit
 * row must not claim a note it does not have, and the exec must not be nagged
 * about a migration they cannot run from the console.
 *
 *   recorded: true            the row is in the database.
 *   recorded: false, no error 00117 has not been applied here. Silent: the
 *                             reason is not LOST — logAdminAudit writes the
 *                             same text to audit_logs.reason — and there is
 *                             nothing the person clicking Confirm could do
 *                             about it.
 *   error                     a real failure. Loud, always, because after
 *                             00117 is applied a swallowed failure would end
 *                             in a green toast and the exec would walk away
 *                             believing a reason was recorded that was not.
 *
 * UPSERT, because one match has one note — `match_id` is the primary key.
 */
async function writeMatchNote(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  note: string,
  authorId: string,
): Promise<{ recorded: boolean; error: string | null }> {
  const { error } = await adminClient
    .from(MATCH_ADMIN_NOTE_TABLE)
    .upsert(
      {
        match_id: matchId,
        note,
        author_id: authorId,
        // Sent explicitly as well as by trigger: the trigger fires on UPDATE,
        // and the INSERT half of an upsert would otherwise keep the default.
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'match_id' },
    );

  if (!error) return { recorded: true, error: null };
  if (isMissingNoteTableError(error)) return { recorded: false, error: null };
  return { recorded: false, error: error.message ?? 'The note could not be saved.' };
}

/**
 * `noteRecorded` is kept in the payload, and is now always true.
 *
 * It used to carry a real distinction: the note went to `match_admin_notes`
 * (00117) in a statement of its own, so on a database the owner had not yet
 * migrated the void succeeded and the note silently did not. Since 00203 the
 * whole void is one `void_club_match` transaction — the match mutation, the
 * note and the audit row commit together or not at all — so there is no state
 * in which this returns and the note is missing. The field stays because
 * MatchActions and the walkover pair still read it and the shape should not
 * fork; the quieter-toast branch there is now unreachable rather than wrong.
 */
export async function voidMatch(
  matchId: string,
  reason: string,
): Promise<ActionResult<{ noteRecorded: boolean }>> {
  return runAction(() => voidMatchImpl(matchId, reason));
}

async function voidMatchImpl(matchId: string, reason: string) {
  // The authorisation boundary stays HERE. void_club_match is service_role-only
  // and enforces no capability of its own — it takes the actor as a parameter
  // and trusts it, exactly as reverse_match_result always did.
  const admin = await requireCapability('matches.void.write');
  const adminClient = createAdminClient();

  // ONE ROUND TRIP, AND THAT IS THE POINT. This used to be four: read the
  // status, reverse the Elo, mark the match voided, write the note, write the
  // audit row. Every gap between them was a place the request could die, and
  // the worst of those left a match voided with NO audit row saying who did it
  // or why — the one thing the console cannot reconstruct afterwards. That is
  // why the note write here could not throw, and why the audit row had to
  // report honestly whether it had landed.
  //
  // Inside a single transaction that reasoning inverts. There is no partial
  // state left to be honest about: a failure anywhere takes the void with it.
  const { error } = await adminClient.rpc('void_club_match', {
    p_match_id: matchId,
    p_actor_id: admin.id,
    p_reason: reason,
  });
  if (error) {
    // Context on the scope, not a second captureException — runAction already
    // reports whatever this throws, and capturing here filed every failure
    // twice. Same convention as resolveDispute.
    Sentry.getCurrentScope().setExtras({ matchId, action: 'void_match' });
    throw new Error(error.message);
  }

  revalidatePath('/matches');
  return { noteRecorded: true };
}

/** See voidMatch for what `noteRecorded` means and why it is always true. */
export async function convertMatchToCasual(
  matchId: string,
  reason: string,
): Promise<ActionResult<{ noteRecorded: boolean }>> {
  return runAction(() => convertMatchToCasualImpl(matchId, reason));
}

async function convertMatchToCasualImpl(matchId: string, reason: string) {
  const admin = await requireCapability('matches.convert.write');
  const adminClient = createAdminClient();

  // THE FOUR ARMS MOVED, THEY DID NOT GO AWAY. convert_club_match_to_casual
  // still branches on how much of the conversion has already landed rather
  // than on `result_status` alone — fully converted, voided-but-unclassified,
  // confirmed-and-still-rated, never-confirmed — because prod holds rows in
  // every one of those states and this transaction cannot retroactively fix
  // them. What the transaction removes is the ability to create NEW ones.
  //
  // The arms are covered by a staging harness that walks a real match through
  // each of the four, including the two a rewrite silently collapses: a fully
  // converted match must fall through to the note and audit row rather than
  // return early, and a match that was ALWAYS casual and is only now disputed
  // must reach the confirming arm rather than be mistaken for a finished one.
  const { error } = await adminClient.rpc('convert_club_match_to_casual', {
    p_match_id: matchId,
    p_actor_id: admin.id,
    p_reason: reason,
  });
  if (error) {
    Sentry.getCurrentScope().setExtras({ matchId, action: 'convert_to_casual' });
    throw new Error(error.message);
  }

  revalidatePath('/matches');
  return { noteRecorded: true };
}

// ============================================================
// Repeat challenges (00268)
// ============================================================

/** True for a number with at most two decimals. 1.15 * 100 is not 115. */
function isTwoDecimals(value: number): boolean {
  return Number(value.toFixed(2)) === value;
}

/**
 * Scale the rating change one confirmed match already applied, by more than 1
 * and at most 2. boost_match_rating does the whole thing in one transaction,
 * audit row included, so this reads and writes nothing of its own: the same
 * shape as voidMatch, and the same capability, because both correct one
 * applied delta and a later void unwinds the boost with it.
 *
 * Every parameter is a POST field, so each is checked for its type here and
 * again by the SQL.
 */
export async function boostMatchRating(
  matchId: string,
  boost: number,
  reason: string,
): Promise<ActionResult<{ alreadyBoosted: boolean }>> {
  return runAction(() => boostMatchRatingImpl(matchId, boost, reason));
}

async function boostMatchRatingImpl(matchId: string, boost: number, reason: string) {
  const admin = await requireCapability('matches.void.write');

  if (typeof matchId !== 'string' || matchId.length === 0) {
    throw new ExpectedError('No match was given.');
  }
  if (typeof boost !== 'number' || !Number.isFinite(boost) || boost <= 1 || boost > 2 || !isTwoDecimals(boost)) {
    throw new ExpectedError('A boost must be above 1 and at most 2, to two decimals.');
  }
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < REASON_MIN) {
    throw new ExpectedError(`Boosting a match needs a reason of at least ${REASON_MIN} characters.`);
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc('boost_match_rating', {
    p_match_id: matchId,
    p_actor_id: admin.id,
    p_boost: boost,
    p_reason: why,
  });
  if (error) {
    Sentry.getCurrentScope().setExtras({ matchId, boost, action: 'boost_match_rating' });
    throw new Error(error.message);
  }

  revalidatePath('/matches');
  const result = (data ?? {}) as { already_boosted?: boolean };
  return { alreadyBoosted: result.already_boosted === true };
}

export interface RepeatChallengeSettings {
  decayPct: number;
  windowDays: number;
  minFactor: number;
}

/**
 * The exec's door to three keys of rating_defaults, and only those three.
 *
 * updatePlatformSettings is the general writer and stays admin-only
 * (platform.settings.write). The repeat rule is meant to be an exec call, so
 * this action takes typed values rather than a blob, overlays them on the
 * stored row, and cannot touch any other key: a hand-rolled POST can move the
 * decay, the window and the floor, and nothing else.
 *
 * COMPARE-AND-SWAP ON updated_at. The write replaces the whole JSONB value, so
 * a /ratings save landing between the read and the write here would be
 * silently reverted. The update only matches the row as it was read; if it
 * matches nothing, the officer is asked to reload.
 */
export async function updateRepeatChallengeSettings(
  input: RepeatChallengeSettings,
  reason: string,
): Promise<ActionResult<RepeatChallengeSettings>> {
  return runAction(() => updateRepeatChallengeSettingsImpl(input, reason));
}

async function updateRepeatChallengeSettingsImpl(input: RepeatChallengeSettings, reason: string) {
  const admin = await requireCapability('matches.void.write');

  const decayPct: unknown = input?.decayPct;
  const windowDays: unknown = input?.windowDays;
  const minFactor: unknown = input?.minFactor;
  if (typeof decayPct !== 'number' || !Number.isInteger(decayPct) || decayPct < 0 || decayPct > 90) {
    throw new ExpectedError('The reduction must be a whole percentage from 0 to 90.');
  }
  if (typeof windowDays !== 'number' || !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
    throw new ExpectedError('The window must be a whole number of days from 1 to 365.');
  }
  if (
    typeof minFactor !== 'number' || !Number.isFinite(minFactor)
    || minFactor < 0 || minFactor > 1 || !isTwoDecimals(minFactor)
  ) {
    throw new ExpectedError('The floor must be from 0.00 to 1.00, to two decimals.');
  }
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < REASON_MIN) {
    throw new ExpectedError(`Changing the repeat challenge rules needs a reason of at least ${REASON_MIN} characters.`);
  }

  const adminClient = createAdminClient();
  const { data: row, error: readError } = await adminClient
    .from('platform_settings')
    .select('value, updated_at')
    .eq('key', 'rating_defaults')
    .single();
  if (readError || !row) {
    throw new Error(`Could not read the rating settings: ${readError?.message ?? 'no rating_defaults row'}`);
  }

  const stored = (row.value ?? {}) as Record<string, unknown>;
  const next = {
    ...stored,
    repeat_decay_pct: decayPct,
    repeat_window_days: windowDays,
    repeat_min_factor: minFactor,
  };

  const { data: written, error: writeError } = await adminClient
    .from('platform_settings')
    // Club changes (00286) draft a line only from a write that sets updated_by
    // and moves updated_at. Keep both.
    .update({ value: next, updated_by: admin.id, updated_at: new Date().toISOString() })
    .eq('key', 'rating_defaults')
    .eq('updated_at', row.updated_at)
    .select('key');
  if (writeError) throw new Error(`Failed to update rating_defaults: ${writeError.message}`);
  if (!written || written.length === 0) {
    throw new ExpectedError('The rating settings changed since this page loaded. Reload the page and try again.');
  }

  // The same action and the same reason shape as updatePlatformSettings, so
  // /ratings finds this change when it reads back the last one. Its
  // splitAuditReason splits on a spaced em dash, written as an escape here.
  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'platform_setting_updated',
    target_type: 'platform_setting',
    target_id: null,
    old_value: stored,
    new_value: next,
    reason: `rating_defaults \u2014 ${why}`,
  });

  revalidatePath('/matches');
  revalidatePath('/ratings');
  return { decayPct, windowDays, minFactor };
}

// ============================================================
// Admin Match Entry
// ============================================================

export async function adminCreateMatch(data: {
  match_type: string;
  format: string;
  // "Best of X games to Y points", typed in the form. The enum above stays as
  // the fallback the DB coalesces to; these win when present (migration 00031).
  games_per_match?: number;
  points_per_game?: number;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  winner_side: string;
  games: { game_number: number; side_a_score: number; side_b_score: number }[];
  admin_note?: string;
}): Promise<ActionResult<string>> {
  return runAction(() => adminCreateMatchImpl(data));
}

/**
 * Undo a half-built admin match and re-raise. Always throws.
 *
 * PostgREST gives the action no transaction, so the `matches` row is already
 * committed by the time the participant or game insert can fail. Of the two
 * possible half-states, "no match at all" is the one somebody can act on — the
 * admin sees the failure and enters the match again — and "a completed match
 * with a winner and no participants" is the one nobody can even see. So we
 * delete the shell we just created.
 *
 * Checked against the live schema on 2026-08-06 rather than read off 00001,
 * because the delete is only safe if nothing REFERENCES matches with NO ACTION
 * (Postgres's silent default), which would make this branch fail every single
 * time. Every child is CASCADE — match_participants, match_games, disputes —
 * except walkovers, which is SET NULL; a walkover cannot exist for a match this
 * action created a moment ago. The only triggers on the table fire BEFORE
 * INSERT and AFTER UPDATE OF result_status, so nothing runs on the delete.
 *
 * If the delete ALSO fails the orphan is real, and the only useful thing left
 * is to name it: the message and the Sentry event carry the match id so it can
 * be voided by hand instead of sitting in the results list looking legitimate.
 *
 * 00119 adds a trigger to match_participants (AFTER INSERT, statement-level) and
 * that is deliberately NOT a trigger on `matches`, so the sentence above still
 * holds: nothing runs on this delete. The cascade removes the participant rows
 * without firing it, because it fires on INSERT and this is a DELETE. And the
 * `expectedStatus` scoping is what keeps the two apart in the first place — see
 * the note on initialStatus in adminCreateMatchImpl.
 */
async function discardIncompleteMatch(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  expectedStatus: string,
  cause: string,
): Promise<never> {
  // Scoped to the row as we wrote it, not to the id alone. The shell is
  // committed and visible on /matches for as long as this takes, so another
  // admin can void it in the meantime — and a blind delete would then destroy
  // somebody else's decision (and cascade away any dispute raised against it)
  // while reporting the original failure. If the status has moved, the row is
  // no longer ours to remove.
  const { data: deleted, error: deleteError } = await adminClient
    .from('matches')
    .delete()
    .eq('id', matchId)
    .eq('result_status', expectedStatus)
    .select('id');

  if (deleteError || !deleted?.length) {
    const detail = deleteError ? deleteError.message : 'the match was changed by someone else';
    Sentry.captureException(
      new Error(`Orphaned admin match left behind: ${cause} (cleanup: ${detail})`),
      { extra: { matchId, action: 'admin_create_match' } },
    );
    throw new Error(
      `The match could not be saved (${cause}), and the incomplete match ${matchId} could not be removed. ` +
      'Void it from the Matches list before entering it again.',
    );
  }
  throw new Error(`The match could not be saved and was discarded: ${cause}`);
}

async function adminCreateMatchImpl(data: {
  match_type: string;
  format: string;
  // "Best of X games to Y points", typed in the form. The enum above stays as
  // the fallback the DB coalesces to; these win when present (migration 00031).
  games_per_match?: number;
  points_per_game?: number;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  winner_side: string;
  games: { game_number: number; side_a_score: number; side_b_score: number }[];
  admin_note?: string;
}) {
  parseOrThrow(adminMatchCreateSchema, data);
  // The schema bounds scores only by the highest cap; judge each game against
  // this match's own target and best-of.
  const check = validateGamesForRules(
    data.games,
    getRulesFor(data.format as MatchFormat, data.games_per_match, data.points_per_game),
  );
  if (!check.ok) throw new ExpectedError(check.message);
  const admin = await requireCapability('matches.create.write');
  const adminClient = createAdminClient();
  const { getFormatWeight, derivedFormatWeight } = await import('@badminton/shared');

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).maybeSingle();
  // Refuse rather than stamp NULL — see requireActiveSeasonId. A row with no
  // season is invisible to every season total and there is no page that lists
  // the orphans. maybeSingle() so TWO active seasons surface as an error here
  // rather than as a silent "no active season".
  const seasonId = requireActiveSeasonId(activeSeason.data?.id, 'match');
  // A custom shape has no hand-picked weight, so derive it exactly as
  // derived_format_weight (00031) does — otherwise the same "best of 5 to 15"
  // would be worth one thing entered by an admin and another played through a
  // challenge. trigger_set_match_weights recomputes this on insert anyway; we
  // send the matching value rather than a stale preset weight.
  const formatWeight = data.points_per_game
    ? derivedFormatWeight(data.games_per_match ?? 1, data.points_per_game)
    : getFormatWeight(data.format as import('@badminton/shared').MatchFormat);

  const scoreSummary = data.games.map(g => `${g.side_a_score}-${g.side_b_score}`).join(', ');

  // NO ADMIN MATCH IS EVER BORN 'confirmed' ANY MORE, and the unrated one is
  // the case that changed.
  //
  // Rated ones have always started pending: apply_match_result rejects anything
  // else and flips the status to confirmed itself. Unrated ones used to be
  // INSERTed already 'confirmed', because there is no Elo to apply and
  // therefore no reason to route them through that function — and that is the
  // whole of gap 1 in 00119. head_to_head_stats and partnership_stats are
  // written by on_match_confirmed, an AFTER UPDATE trigger, so a row BORN
  // confirmed was never counted by anything: an unrated admin match has never
  // appeared in any member's head-to-head record or partnership card.
  //
  // Inserting it unconfirmed and flipping it at the end (below) means the
  // counters are written by the same UPDATE that has always written them, at a
  // moment when the participants and games actually exist.
  //
  // WHY 'incomplete' AND NOT 'pending_confirmation' FOR THE UNRATED ONE. This
  // is the whole reason the status is still conditional, and getting it wrong
  // would trade one integrity bug for a worse one.
  //
  // apply_match_result decides whether to apply Elo on `event_type = 'casual'`,
  // NOT on rated_flag — and an admin-entered match is 'admin_entered'. Its only
  // other gate is `result_status = 'pending_confirmation'`. So a match parked at
  // 'pending_confirmation' with rated_flag FALSE is one RPC away from being
  // rated: confirmMatchResult in the player app (apps/player/src/lib/actions/
  // matches.ts) checks nothing but "are you a participant", the submitter guard
  // does not bite because the submitter is the ADMIN, and an unrated match would
  // quietly receive Elo. That window does not exist today because the match is
  // never pending; opening it here — between these two writes, and permanently
  // if the confirm below fails — would be a new hole dug by a fix for two
  // others.
  //
  // 'incomplete' has none of that reach. apply_match_result refuses it,
  // dispute_match_result refuses it (00027 accepts only pending_confirmation
  // and confirmed), reverse_match_result refuses it, and it is already the
  // status submit_match_result uses for a match row that is not a finished
  // result (00030) — which is exactly what a half-written admin entry is. The
  // console lists every status and offers void/convert on anything not voided,
  // so a stranded one is visible and recoverable, and it is badged honestly.
  //
  // AND THE INVARIANT THAT MAKES THIS SAFE ALONGSIDE THE DATABASE HALF is
  // unchanged by the conditional: neither branch is 'confirmed'. 00119 also
  // closes gap 1 in the database, with a trigger that counts a match when its
  // participants arrive and it is ALREADY confirmed — because service_role can
  // insert a confirmed match through PostgREST from any code path anybody
  // writes later, and a rule that lives only here is a rule that lasts until
  // the second call site. That trigger and discardIncompleteMatch below must
  // never both act on one match, or the cleanup would delete a match whose
  // counters had been written. They cannot: the cleanup is scoped
  // `.eq('result_status', initialStatus)`, initialStatus is never 'confirmed',
  // and the trigger acts on nothing else. Disjoint in either deploy order.
  const initialStatus = data.rated_flag ? 'pending_confirmation' : 'incomplete';

  const { data: match, error: matchError } = await adminClient.from('matches').insert({
    match_type: data.match_type,
    event_type: 'admin_entered',
    rated_flag: data.rated_flag,
    format: data.format,
    games_per_match: data.games_per_match ?? null,
    points_per_game: data.points_per_game ?? null,
    format_weight: formatWeight,
    event_multiplier: 1.0,
    completed_flag: true,
    winner_side: data.winner_side,
    score_summary: scoreSummary,
    played_at: new Date().toISOString(),
    submitted_by: admin.id,
    confirmed_by: admin.id,
    result_status: initialStatus,
    season_id: seasonId,
    // `admin_note` is no longer written. The form still sends it (the action's
    // input contract is unchanged, so create-match.tsx needed no edit); it now
    // lands in match_admin_notes, below. See 00117.
  }).select().single();

  if (matchError) throw new Error(matchError.message);

  // THE NOTE, IMMEDIATELY AND BEFORE THE CHILDREN. Placed here rather than at
  // the end of the action so a genuine failure to record it is treated like the
  // participant and game inserts below: discard the shell and tell the admin,
  // rather than leave a finished, confirmed match whose note quietly went
  // missing. If a LATER step discards the match, the note row goes with it —
  // match_admin_notes.match_id is ON DELETE CASCADE for exactly this path.
  //
  // A database without the table returns null here, so a pre-migration console
  // creates the match exactly as before and drops the note.
  const trimmedNote = data.admin_note?.trim();
  if (trimmedNote) {
    const note = await writeMatchNote(adminClient, match.id, trimmedNote, admin.id);
    if (note.error) await discardIncompleteMatch(adminClient, match.id, initialStatus, note.error);
  }

  // Get player ratings and build participants
  const allPlayerIds = [...data.side_a_players, ...data.side_b_players];
  const { data: ratings } = await adminClient.from('ratings').select('*').in('player_id', allPlayerIds);
  const ratingsMap = new Map(ratings?.map(r => [r.player_id, r]) || []);

  const isDoubles = data.match_type === 'doubles';
  const participants = allPlayerIds.map(pid => {
    const side = data.side_a_players.includes(pid) ? 'a' : 'b';
    const r = ratingsMap.get(pid);
    const preRating = isDoubles ? (r?.doubles_elo ?? 400) : (r?.singles_elo ?? 400);

    let pointsScored = 0, pointsAllowed = 0, gamesWon = 0, gamesLost = 0;
    for (const g of data.games) {
      if (side === 'a') {
        pointsScored += g.side_a_score;
        pointsAllowed += g.side_b_score;
        if (g.side_a_score > g.side_b_score) gamesWon++; else gamesLost++;
      } else {
        pointsScored += g.side_b_score;
        pointsAllowed += g.side_a_score;
        if (g.side_b_score > g.side_a_score) gamesWon++; else gamesLost++;
      }
    }

    return {
      match_id: match.id,
      player_id: pid,
      team_side: side,
      pre_rating: preRating,
      points_scored: pointsScored,
      points_allowed: pointsAllowed,
      games_won: gamesWon,
      games_lost: gamesLost,
    };
  });

  // Both of these results used to be thrown away. supabase-js RESOLVES on a
  // Postgres error rather than rejecting, so a duplicate player (UNIQUE
  // (match_id, player_id), 00001) or any other constraint failure looked
  // exactly like success — and for an unrated match nothing downstream reads
  // the participants, so the action audited the match and returned its id
  // while the database held a completed, confirmed match with a winner, a
  // score summary and nobody in it. That row is the invisible half-state: it
  // is a normal-looking result on /matches, it belongs to no player's history,
  // and there is no admin control that can repair it.
  const { error: participantError } = await adminClient.from('match_participants').insert(participants);
  if (participantError) await discardIncompleteMatch(adminClient, match.id, initialStatus, participantError.message);

  const gameRows = data.games.map(g => ({
    match_id: match.id,
    game_number: g.game_number,
    side_a_score: g.side_a_score,
    side_b_score: g.side_b_score,
  }));
  const { error: gameError } = await adminClient.from('match_games').insert(gameRows);
  if (gameError) await discardIncompleteMatch(adminClient, match.id, initialStatus, gameError.message);

  // Apply Elo if rated.
  //
  // Deliberately NOT discarded the way the two inserts above are: by this point
  // the match has its participants and games, so a failure here leaves a
  // complete, pending_confirmation match that shows up on /matches and that
  // voidMatch can already deal with. That is the visible, recoverable
  // half-state, and deleting a fully-formed match under the admin's feet would
  // be the more destructive choice.
  if (data.rated_flag) {
    const { error: eloError } = await adminClient.rpc('apply_match_result', {
      p_match_id: match.id,
      p_confirmed_by: admin.id,
    });
    if (eloError) {
      Sentry.captureException(new Error(`Elo application failed for admin match: ${eloError.message}`), {
        extra: { matchId: match.id },
      });
      throw new Error(eloError.message);
    }
  } else {
    // THE UNRATED MATCH IS CONFIRMED HERE, not on the INSERT — see the note on
    // initialStatus. There is no Elo to apply, so this does the one thing
    // apply_match_result would have done for it: move result_status to
    // 'confirmed', which is what fires on_match_confirmed and writes the
    // head-to-head and partnership counters (00119).
    //
    // apply_match_result is deliberately NOT called instead, and it could not
    // be: it refuses any status but 'pending_confirmation', which is the point
    // of parking this match at 'incomplete'. Even if it were reachable it would
    // be wrong — 'admin_entered' is not 'casual', so it would derive the winner
    // from match_games and apply Elo, which is precisely what an unrated match
    // must not get.
    //
    // NOT DISCARDED ON FAILURE, for the same reason as the Elo call above and
    // the same reason it is placed after the games rather than before: by this
    // point the match has its participants and its games, so a failure leaves a
    // complete pending_confirmation match on /matches that voidMatch can
    // already deal with. Deleting a fully-formed match under the admin's feet
    // would be the more destructive choice, and the counters are correct in
    // either outcome — a match that never reached 'confirmed' is a match the
    // counters are right not to include.
    const { error: confirmError } = await adminClient
      .from('matches')
      .update({ result_status: 'confirmed' })
      .eq('id', match.id);
    if (confirmError) {
      Sentry.captureException(new Error(`Unrated admin match not confirmed: ${confirmError.message}`), {
        extra: { matchId: match.id },
      });
      throw new Error(confirmError.message);
    }
  }

  // THE NOTE IS STRIPPED FROM THE AUDIT PAYLOAD. `data` carries `admin_note`,
  // and spreading it here used to put the exec's free text into
  // `audit_logs.new_value` as well — a second copy under a DIFFERENT access
  // rule (`audit.page`) from the one 00117 gives the note itself (the three
  // match writes). Two audiences for one secret is how a privacy fix quietly
  // fails. It is redundant as well as wider: the text is in
  // match_admin_notes, and this row already records that a match was created.
  //
  // The void and convert paths keep theirs in `reason`, which is deliberate and
  // different — a destructive act must be answerable in the audit log, and that
  // column exists for exactly that.
  const { admin_note: _auditedElsewhere, ...auditableData } = data;
  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'match_admin_created',
    target_type: 'match',
    target_id: match.id,
    new_value: { ...auditableData, score_summary: scoreSummary, has_admin_note: Boolean(trimmedNote) },
  }, { matchId: match.id });

  revalidatePath('/matches');
  revalidatePath('/leaderboard');
  return match.id;
}

// ============================================================
// Admin Challenge Creation
// ============================================================

export async function adminCreateChallenge(data: {
  type: string;
  format: string;
  // See adminCreateMatch: the enum is the fallback, this pair is the real shape.
  games_per_match?: number;
  points_per_game?: number;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  scheduled_date?: string;
  scheduled_time?: string;
  note?: string;
}): Promise<ActionResult<string>> {
  return runAction(() => adminCreateChallengeImpl(data));
}

async function adminCreateChallengeImpl(data: {
  type: string;
  format: string;
  // See adminCreateMatch: the enum is the fallback, this pair is the real shape.
  games_per_match?: number;
  points_per_game?: number;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  scheduled_date?: string;
  scheduled_time?: string;
  note?: string;
}) {
  // Challenge management is an admin-only section (permissions.ts '/challenges'),
  // so gate at admin — not exec — even though this lives in the exec-allowed
  // matches module.
  const admin = await requireCapability('challenges.create.write');
  const adminClient = createAdminClient();

  // This action has no zod schema of its own, and the shape is now typed rather
  // than chosen from a list — so check it here. Otherwise a typo reaches the
  // challenges_custom_format_sane CHECK and comes back as a Postgres constraint
  // string no admin can act on.
  if (data.points_per_game !== undefined || data.games_per_match !== undefined) {
    if (!isLegalCustomGames(data.games_per_match ?? 0) || !isLegalCustomPoints(data.points_per_game ?? 0)) {
      throw new ExpectedError(
        `Best of must be an odd number from ${CUSTOM_FORMAT_BOUNDS.minGames} to ${CUSTOM_FORMAT_BOUNDS.maxGames}, ` +
        `and points per game between ${CUSTOM_FORMAT_BOUNDS.minPoints} and ${CUSTOM_FORMAT_BOUNDS.maxPoints}.`,
      );
    }
  }

  const eventType = data.rated_flag ? 'rated_challenge' : 'casual';

  const { data: challenge, error } = await adminClient.from('challenges').insert({
    type: data.type,
    rated_flag: data.rated_flag,
    format: data.format,
    games_per_match: data.games_per_match ?? null,
    points_per_game: data.points_per_game ?? null,
    event_type: eventType,
    scheduled_date: data.scheduled_date || null,
    scheduled_time: data.scheduled_time || null,
    created_by: admin.id,
    status: 'accepted',
    note: data.note || `Created by admin`,
  }).select().single();

  if (error) throw new Error(error.message);

  // All participants auto-accepted since admin created
  const participants: { challenge_id: string; player_id: string; role: string; team_side: string; confirmation_status: string }[] = [];

  data.side_a_players.forEach((pid, i) => {
    participants.push({
      challenge_id: challenge.id,
      player_id: pid,
      role: i === 0 ? 'challenger' : 'partner',
      team_side: 'a',
      confirmation_status: 'accepted',
    });
  });

  data.side_b_players.forEach((pid, i) => {
    participants.push({
      challenge_id: challenge.id,
      player_id: pid,
      role: i === 0 ? 'opponent' : 'opponent_partner',
      team_side: 'b',
      confirmation_status: 'accepted',
    });
  });

  const { error: partError } = await adminClient.from('challenge_participants').insert(participants);
  if (partError) throw new Error(partError.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'challenge_admin_created',
    target_type: 'challenge',
    target_id: challenge.id,
    new_value: data,
  }, { challengeId: challenge.id });

  revalidatePath('/challenges');
  return challenge.id;
}

export async function forceExpireChallenge(challengeId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => forceExpireChallengeImpl(challengeId, reason));
}

async function forceExpireChallengeImpl(challengeId: string, reason: string) {
  // Admin-only section — see adminCreateChallengeImpl.
  const admin = await requireCapability('challenges.expire.write');
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('challenges')
    .update({ status: 'expired' })
    .eq('id', challengeId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'challenge_force_expired',
    target_type: 'challenge',
    target_id: challengeId,
    reason,
  }, { challengeId });

  revalidatePath('/challenges');
}
