'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
// The withdrawal/DQ reason is exec-only free text and no longer lives on the
// entry row — 00118. See lib/private-notes.ts.
import { PAIR_NOTES, PARTICIPANT_NOTES, writePrivateNote } from '../private-notes';
import { lateEntryWindow } from '../stage-controls';
import {
  calculateTeamRating,
  ensureEntryFees,
  isDoublesEvent,
  eventHasDraw,
  screenForEventWaiver,
  eventWaiverRefusal,
  loadTournamentEntryCounts,
  isAtEntryCap,
  entryCapRefusal,
  doublesDrawSlots,
  countDoublesField,
  wouldExceedCapacity,
  planAutoPairs,
  unpairableNotice,
  screenExecEntry,
  screenPair,
  canPairForEvent,
  categoryRequiredBy,
  toCompetitionCategory,
  isOutOfEvent,
  isExpectedFailure,
  normalizeExternalTeamNames,
  parseFormatConfig,
  suggestCategory,
  categoryForEventType,
  pickCategory,
  ExpectedError,
  selectInChunks,
  type CompetitionCategory,
  type TournamentEventType,
} from '@badminton/shared';
import { runAction, type ActionResult } from '../action-result';
import {
  requireCapability,
  revalidateEventPaths,
  extractEventContext,
  participantContextSelect,
  pairContextSelect,
  assertTournamentNotSuspended,
  assertEventWaiverSigned,
  loadTournamentWaiverContext,
  pairWaiverMembers,
  unsignedAmong,
  notifyEventWaiverRequired,
  forfeitOpenMatchesForEntry,
  FORFEIT_REASON,
  fencedRefusal,
  fillFromWaitlistAfterFree,
  settleWaitlistPromotions,
  isWaitlistMissing,
  type DrawExitStatus,
  type FencedFieldResult,
  type WaitlistFillResult,
} from './_internal';

// An external event (00269) holds only teams entered by name. The DB triggers refuse
// every member entry path too; these refusals only make the message readable.
const EXTERNAL_EVENT_REFUSAL = 'This is an external event: add teams by name with Add external team.';
const EXTERNAL_PAIR_SPLIT_REFUSAL = 'An external team cannot be split or changed. Remove it, or withdraw it once the draw exists.';

// THE LATE-ENTRY WINDOW (00308). A staged event whose first stage is drawn
// groups still takes an entry until a later stage is drawn; the console then
// places it in a group (placeLateEntrant). Read only when the status alone
// would refuse, so registration and check-in pay nothing for it. The entry
// functions ask staged_late_entry_open again under the field lock.
async function lateEntryOpen(
  adminClient: ReturnType<typeof createAdminClient>,
  event: { id: string; format: string | null; status: string; draw_locked: boolean | null; format_config: unknown },
): Promise<boolean> {
  if (event.format !== 'staged' || (event.status !== 'bracket_generated' && event.status !== 'live')) return false;
  const { data, error } = await adminClient.from('tournament_matches')
    .select('stage')
    .eq('event_id', event.id)
    .not('stage', 'is', null);
  if (error) throw new Error(`Could not read the event's matches: ${error.message}`);
  return lateEntryWindow(event, (data ?? []).map((m) => m.stage));
}

// A doubles draw places teams, so a late entry there has to arrive as a pair:
// a loose player cannot be paired once check-in is over.
const LATE_SOLO_REFUSAL = 'The draw has been made, so add a late entry as a pair.';

// ---------------------------------------------------------------------------
// THE FIELD FENCE (00199)
// ---------------------------------------------------------------------------
// Every check above an entry — already paired, event full, at the entry cap —
// reads state in one round trip and writes in another, and an advisory lock
// cannot be held across two PostgREST calls because each call IS the
// transaction. So the last word belongs to add_participants_under_field_lock,
// which takes the same lock the player's own entry and the pool promotion take
// and asks the questions under it.
//
// The app's checks above are NOT redundant: they fail early, they fail per
// player, and they produce the messages an exec can act on. What comes back
// from the fence is always the same kind of answer — the field moved while you
// were deciding — so the messages here say that rather than pretending to be a
// fresh eligibility verdict.
interface FieldFenceRefusal {
  ok: false;
  reason?: string;
  cap?: number;
  player_id?: string;
  status?: string;
  suspension_reason?: string;
}
type FieldFenceResult =
  | { ok: true; participants: Array<Record<string, unknown>> }
  | FieldFenceRefusal;

function fenceRefusal(result: FieldFenceRefusal | null | undefined): string {
  switch (result?.reason) {
    case 'already_in_pair':
      return 'Somebody put one of these players into a team while this was being submitted, so nothing was added. Try again.';
    case 'already_registered':
      return 'Someone was registered while this was being submitted, so nothing was added. Try again.';
    case 'event_full':
      return 'The event filled up while this was being submitted, so nothing was added.';
    case 'entry_cap': {
      const cap = result?.cap;
      return cap
        ? `One of these players reached their limit of ${cap} ${cap === 1 ? 'event' : 'events'} at this tournament while this was being submitted, so nothing was added.`
        : 'One of these players reached their entry limit while this was being submitted, so nothing was added.';
    }
    case 'draw_locked':
      return 'The draw was locked while this was being submitted, so nothing was added.';
    case 'event_status':
      return 'The event moved out of registration while this was being submitted, so nothing was added.';
    case 'tournament_suspended':
      return result?.suspension_reason
        ? `The tournament was suspended while this was being submitted: ${result.suspension_reason}. Nothing was added.`
        : 'The tournament was suspended while this was being submitted, so nothing was added.';
    case 'tournament_closed':
      return 'The tournament was closed while this was being submitted, so nothing was added.';
    case 'event_not_found':
      return 'That event no longer exists.';
    default:
      return 'The field changed while this was being submitted, so nothing was added. Try again.';
  }
}

// Supabase returns a to-one embed as object-or-array depending on how it
// inferred the relationship. Unwrap defensively — the whole reason this matters
// is that a name is what the refusal message is FOR.
function pickName(embed: unknown): string | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  return (row as { full_name?: string | null } | null)?.full_name ?? null;
}

/**
 * The tournament's per-member event cap, and how many events each member has
 * already taken — or nulls, when the tournament is uncapped.
 *
 * READS NOTHING WHEN THERE IS NO CAP, which is every tournament that exists
 * today. `max_events_per_player IS NULL` means uncapped, so the counting
 * queries are only paid for by the tournaments that asked for the rule.
 *
 * REFUSES RATHER THAN RETURNING ZERO on a failed read. A swallowed error here
 * reads as "this member has entered nothing", which waves them straight past
 * the cap — the one failure mode a limit must not have. Same reasoning the
 * batch capacity check already applies to its own count.
 */
async function loadEntryCapState(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
): Promise<{ cap: number | null; counts: Map<string, number> }> {
  const { data: tournament, error } = await adminClient
    .from('tournaments')
    .select('max_events_per_player')
    .eq('id', tournamentId)
    .single();
  if (error || !tournament) {
    if (error) Sentry.captureException(error);
    throw new Error('Could not check this tournament’s event limit. Nothing was added — try again.');
  }

  const cap = (tournament as { max_events_per_player: number | null }).max_events_per_player;
  if (cap === null || cap === undefined) return { cap: null, counts: new Map() };

  try {
    return { cap, counts: await loadTournamentEntryCounts(adminClient, tournamentId) };
  } catch (err) {
    Sentry.captureException(err);
    throw new Error('Could not check how many events these players have entered. Nothing was added — try again.');
  }
}

// ============================================================
// The competition category (00111)
// ============================================================
// Which draw a member competes in — 'mens', 'womens', or null for the
// undeclared, who are everybody on the day this ships. The rules built on it
// are in @badminton/shared/utils/competition-category and the reasoning is in
// migration 00111; what lives here is the READ and nothing else.
//
// THE CONSOLE NEVER DISPLAYS THE VALUE. It is read inside these actions because
// the entry rule cannot be applied without it, and what reaches the exec is a
// sentence about eligibility for an event — never a sentence about a person.
// If a screen ever starts rendering this map, that is the change to argue for
// on its own, not a detail of an entry check.

/**
 * The declared category of each of these players, by id.
 *
 * REFUSES RATHER THAN RETURNING NULLS on a failed read, for the reason
 * loadEntryCapState gives about the cap: a swallowed error here reads as
 * "nobody has declared anything", which is precisely the state that waves every
 * entry through. A rule that silently stops applying is worse than no rule.
 */
async function loadCompetitionCategories(
  adminClient: ReturnType<typeof createAdminClient>,
  playerIds: readonly string[],
): Promise<Map<string, CompetitionCategory | null>> {
  const byPlayer = new Map<string, CompetitionCategory | null>();
  if (playerIds.length === 0) return byPlayer;
  // Chunked — a bulk add can pass an entire event's entrant list, and `.in()`
  // is a query-string filter the proxy refuses past 8 KB. The refusal below is
  // unchanged: a failed read must not wave entries through.
  const { data, error } = await selectInChunks<{ id: string; competition_category: unknown }>(
    playerIds as string[],
    (ids) => adminClient.from('players').select('id, competition_category').in('id', ids) as never,
  );
  if (error) {
    Sentry.captureException(error);
    throw new Error('Could not check who may enter this event. Nothing was added — try again.');
  }
  for (const row of data ?? []) {
    byPlayer.set(row.id as string, toCompetitionCategory((row as { competition_category?: unknown }).competition_category));
  }
  return byPlayer;
}

/**
 * The exec's way past a category refusal.
 *
 * ONE ARGUMENT, NOT A CAPABILITY. Overriding is part of adding: it is available
 * to exactly the holders of tournaments.draw.participants.add.write who could
 * add this person to this event anyway, and `added_by` already records who did.
 * Minting a key for it would cost both permission-vocabulary CHECKs (see 00098)
 * to express a distinction nobody has asked for — the club's actual case is a
 * social event where the exec on the desk decides, and that exec is already
 * trusted with the draw.
 *
 * IT IS NOT A DEFAULT AND MUST NEVER BECOME ONE. The dialog sets it after
 * showing the refusal, so the override is always a second, deliberate press. A
 * caller that passes it unconditionally has turned the rule off.
 */
export interface EntryCategoryOptions {
  allowCategoryMismatch?: boolean;
}

/** The name to put in a cap refusal, without letting a failed lookup mask it. */
async function nameOf(
  adminClient: ReturnType<typeof createAdminClient>,
  playerId: string,
): Promise<string> {
  const { data } = await adminClient.from('players').select('full_name').eq('id', playerId).maybeSingle();
  return (data as { full_name?: string | null } | null)?.full_name ?? 'This player';
}

// ============================================================
// The doubles pool
// ============================================================
// A doubles event holds BOTH kinds of entry at once: tournament_pairs rows for
// teams that have been formed, and tournament_participants rows for people who
// entered without a partner and are waiting to be given one. Pairing PROMOTES
// two of the second into one of the first (migration 00102).
//
// "unpaired", never "pool", in anything that touches brackets.ts —
// `seeded_from_event_id` / buildFieldFromPool already mean something else
// entirely there (seed this draw from another event's standings).

/**
 * The doubles field as it stands right now, in the currency the cap counts.
 *
 * READ-THEN-WRITE, and knowingly. pair_tournament_entrants serialises the
 * PAIRING on an advisory lock, but this count and the entry-cap count above it
 * are taken outside that lock, so two desks adding to the same event at the same
 * second can both see room for one more and both take it. That is the shape
 * every capacity check in this file already has — max_participants has never
 * been enforced by anything but a prior read — and the failure is one slot over
 * a soft limit, which an exec can see and undo. The invariants that CANNOT be
 * repaired from the console (a player counted twice, an entry deleted without a
 * pair to show for it) are the ones that moved into the database.
 */
async function loadDoublesField(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
): Promise<{ unpaired: number; pairs: number; slots: number }> {
  const [unpairedRes, pairsRes] = await Promise.all([
    adminClient.from('tournament_participants').select('player_id, status').eq('event_id', eventId),
    adminClient.from('tournament_pairs').select('player1_id, player2_id, status').eq('event_id', eventId),
  ]);
  // A failed read must not read as "the event is empty" — that would wave a
  // whole batch past max_participants in one go, which is the same failure the
  // batch capacity check already refuses to have.
  if (unpairedRes.error || pairsRes.error) {
    Sentry.captureException(unpairedRes.error ?? pairsRes.error);
    throw new Error('Could not check how full this event is. Nothing was added — try again.');
  }
  return countDoublesField(unpairedRes.data ?? [], pairsRes.data ?? []);
}

/** Which of these players are already on a team in this event. */
async function playersAlreadyPaired(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  playerIds: readonly string[],
): Promise<Set<string>> {
  if (playerIds.length === 0) return new Set();
  const { data, error } = await adminClient
    .from('tournament_pairs')
    .select('player1_id, player2_id, status')
    .eq('event_id', eventId);
  if (error) {
    Sentry.captureException(error);
    throw new Error('Could not check who is already paired in this event. Nothing was added — try again.');
  }
  const wanted = new Set(playerIds);
  const paired = new Set<string>();
  for (const row of data ?? []) {
    // Entries that have LEFT are ignored, exactly as the entry cap ignores
    // them: somebody whose team withdrew is free to enter again.
    if (row.status === 'withdrawn' || row.status === 'disqualified') continue;
    for (const half of [row.player1_id as string, row.player2_id as string]) {
      if (wanted.has(half)) paired.add(half);
    }
  }
  return paired;
}

/** Which of these players are already loose in this event's pool. */
async function playersAlreadyUnpaired(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  playerIds: readonly string[],
): Promise<Set<string>> {
  if (playerIds.length === 0) return new Set();
  const { data, error } = await adminClient
    .from('tournament_participants')
    .select('player_id, status')
    .eq('event_id', eventId)
    .in('player_id', playerIds as string[]);
  if (error) {
    Sentry.captureException(error);
    throw new Error('Could not read this event’s entries. Nothing was changed — try again.');
  }
  return new Set(
    (data ?? [])
      .filter((r) => r.status !== 'withdrawn' && r.status !== 'disqualified')
      .map((r) => r.player_id as string),
  );
}

const ALREADY_PAIRED_REFUSAL =
  'is already in a pair in this event. Unpair that team first if they need a different partner.';

// ============================================================
// Singles Participant Management
// ============================================================
// …and, since 00102, SOLO ENTRY INTO A DOUBLES EVENT. Both paths below used to
// throw 'Use addPairToEvent for doubles events' outright, which is what made a
// partnerless entrant impossible. What still cannot happen is a PAIR in a
// singles event — addPairToEvent keeps its own refusal for that.

export async function addParticipantToEvent(
  eventId: string,
  playerId: string,
  opts?: EntryCategoryOptions,
) {
  const admin = await requireCapability('tournaments.draw.participants.add.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  const late = event.status !== 'registration' && event.status !== 'checkin' && await lateEntryOpen(adminClient, event);
  if (event.status !== 'registration' && event.status !== 'checkin' && !late) {
    throw new ExpectedError('Cannot add participants in current status');
  }
  if (event.external_event === true) throw new ExpectedError(EXTERNAL_EVENT_REFUSAL);
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // A DOUBLES EVENT TAKES A SOLO ENTRANT — that is the whole point of the pool.
  // What it must not take is the same person twice, and the second way to be in
  // a doubles event is as half of a team.
  const doubles = isDoublesEvent(event.event_type);
  if (late && doubles) throw new ExpectedError(LATE_SOLO_REFUSAL);
  if (doubles) {
    const paired = await playersAlreadyPaired(adminClient, eventId, [playerId]);
    if (paired.has(playerId)) {
      throw new ExpectedError(`${await nameOf(adminClient, playerId)} ${ALREADY_PAIRED_REFUSAL}`);
    }
  }

  // THE COMPETITION CATEGORY (00111). Refuses only a CONTRADICTION — a member
  // who has declared a category that is not this event's — and waves the
  // undeclared through, which is the same override the membership gate grants
  // this path and the only rule that can ship on a roster where nobody has
  // declared anything yet. Costs one read, and only for a gendered event.
  //
  // Overridable, because a club runs social events; not by default, because
  // then it would not be a rule. See EntryCategoryOptions.
  if (!opts?.allowCategoryMismatch && categoryRequiredBy(event.event_type as TournamentEventType) !== null) {
    const categories = await loadCompetitionCategories(adminClient, [playerId]);
    const screen = screenExecEntry(
      event.event_type as TournamentEventType,
      categories.get(playerId) ?? null,
      await nameOf(adminClient, playerId),
    );
    if (!screen.ok) throw new ExpectedError(screen.message);
  }

  // Check max participants. For doubles that is counted in DRAW SLOTS — formed
  // pairs plus one slot per two loose entrants — because max_participants has
  // always meant "how many entries fit", and a doubles entry is a team. Counting
  // participant rows there would let forty unpaired people into an event with
  // room for eight teams.
  if (event.max_participants) {
    if (doubles) {
      const field = await loadDoublesField(adminClient, eventId);
      const after = doublesDrawSlots(field.pairs, field.unpaired + 1);
      if (wouldExceedCapacity(field.slots, after, event.max_participants)) {
        throw new ExpectedError('Event is full');
      }
    } else {
      const { count } = await adminClient.from('tournament_participants')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .not('status', 'eq', 'withdrawn');
      if (count && count >= event.max_participants) {
        throw new ExpectedError('Event is full');
      }
    }
  }

  // THE PER-MEMBER CAP, one level up from the capacity check above: that one
  // asks whether the EVENT has room, this one asks whether the PLAYER has any
  // entries left at this tournament. Both sit before the insert, for the same
  // reason — a refusal must leave no trace of an entry that did not happen.
  const { cap, counts } = await loadEntryCapState(adminClient, event.tournament_id);
  if (cap !== null && isAtEntryCap(counts.get(playerId) ?? 0, cap)) {
    throw new ExpectedError(entryCapRefusal(await nameOf(adminClient, playerId), cap));
  }

  // Get or create player's ratings record
  let { data: rating } = await adminClient.from('ratings').select('singles_elo, doubles_elo').eq('player_id', playerId).maybeSingle();
  if (!rating) {
    // Player has no ratings record — create one with defaults
    const { data: newRating } = await adminClient.from('ratings').insert({
      player_id: playerId,
      singles_elo: 400,
      doubles_elo: 400,
      singles_provisional: true,
      doubles_provisional: true,
      singles_k_factor: 40,
      doubles_k_factor: 40,
    }).select('singles_elo, doubles_elo').single();
    rating = newRating;
  }

  // THE DISCIPLINE'S OWN RATING. elo_before was hardcoded to singles_elo, which
  // was right while only singles produced participant rows. A solo entrant in a
  // doubles event is rated on doubles_elo — it is the number the pool's Elo
  // column shows, and the number the team they end up in would be built from.
  const eloBefore = (doubles ? rating?.doubles_elo : rating?.singles_elo) ?? 400;

  // Through the fence, not straight into the table. Every check above this line
  // was answered a round trip ago; this is the one that cannot be overtaken.
  const { data: fenced, error } = await adminClient.rpc('add_participants_under_field_lock', {
    p_event_id: eventId,
    p_admin_id: admin.id,
    p_entries: [{ player_id: playerId, elo_before: eloBefore }],
  });

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  const fence = fenced as FieldFenceResult | null;
  if (!fence?.ok) {
    // The duplicate keeps its own words. Every other refusal here means the
    // field moved under an exec who had already been told this was allowed,
    // but this path never pre-checked for an existing entry at all — it leaned
    // on the unique violation coming back from its own insert — so the fence's
    // answer is the FIRST answer, not a second one, and it says what it always
    // said.
    if (fence?.reason === 'already_registered') {
      throw new ExpectedError('Player already registered for this event');
    }
    throw new ExpectedError(fenceRefusal(fence ?? null));
  }
  const data = fence.participants[0];

  // What this entry costs, on the club's fee ledger. One row per tournament
  // rather than per event, so adding somebody to a second event here finds the
  // row the first one made. Never throws — see ensureEntryFees — because the
  // participant is already committed and an incomplete price list must not
  // report a registration that happened as a failure.
  await ensureEntryFees(adminClient, event.tournament_id, [playerId]);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'participant_added',
    performed_by: admin.id,
    details: { player_id: playerId },
  });

  // BEING ADDED PUSHES THE SIGNATURE AT THEM. Adding still succeeds — the
  // walk-up on the day is exactly why it must — but somebody an exec put on the
  // sheet was never asked for the event waiver, and this is where they are.
  // After the insert and after the audit row, because none of those may be lost
  // to a notification failure.
  const { unsigned, tournamentName } = await unsignedAmong(adminClient, event.tournament_id, [playerId]);
  await notifyEventWaiverRequired(adminClient, event.tournament_id, tournamentName, unsigned);

  revalidateEventPaths(event.tournament_id, eventId);
  return data;
}

/** What the batch add reports back, per player, for the ones it could not take. */
export interface BatchAddFailure {
  id: string;
  message: string;
}

/**
 * Add a whole selection of players in ONE request.
 *
 * Why this exists rather than looping addParticipantToEvent: the loop was
 * sequential, and each pass paid for a full server action — authenticate, read
 * the event, check the tournament, read a rating, insert, write an audit row —
 * and then called revalidatePath, which makes the App Router re-render the event
 * page and ship the new RSC tree back in the response. Sixty players meant sixty
 * round trips to the server and sixty renders of a page that queries every
 * participant, pair and match in the event. Seeding a 128-slot draw took long
 * enough to look broken.
 *
 * Everything that does not depend on WHICH player is now done once, the inserts
 * go in a single statement, and the page is revalidated once at the end.
 *
 * The per-player action stays: it is still the honest shape for adding one
 * person, and other callers use it.
 */
export async function addParticipantsToEvent(
  eventId: string,
  playerIds: string[],
  opts?: EntryCategoryOptions,
) {
  const admin = await requireCapability('tournaments.draw.participants.add.write');
  const adminClient = createAdminClient();

  // Deduplicate but KEEP the caller's order. Order is not cosmetic here: when
  // the event fills mid-batch, the people who get in are the first ones the exec
  // picked, which is the same answer the sequential loop gave.
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return { added: [] as string[], failures: [] as BatchAddFailure[] };

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  const late = event.status !== 'registration' && event.status !== 'checkin' && await lateEntryOpen(adminClient, event);
  if (event.status !== 'registration' && event.status !== 'checkin' && !late) {
    throw new ExpectedError('Cannot add participants in current status');
  }
  if (event.external_event === true) throw new ExpectedError(EXTERNAL_EVENT_REFUSAL);
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // Solo entry into a doubles event, same as the per-player path above.
  const doubles = isDoublesEvent(event.event_type);
  if (late && doubles) throw new ExpectedError(LATE_SOLO_REFUSAL);

  const failures: BatchAddFailure[] = [];

  // Already registered, in one read. The per-player path leaned on the unique
  // violation (23505) coming back from its own insert, which cannot work for a
  // batch: one duplicate would fail the whole statement and take 59 innocent
  // rows with it. The unique index still guards the race — see below — this
  // read is what turns the common case into a per-player message.
  const { data: existing } = await adminClient
    .from('tournament_participants')
    .select('player_id')
    .eq('event_id', eventId)
    .in('player_id', ids);
  const alreadyIn = new Set((existing ?? []).map((r) => r.player_id as string));

  let candidates = ids.filter((id) => {
    if (alreadyIn.has(id)) {
      failures.push({ id, message: 'Player already registered for this event' });
      return false;
    }
    return true;
  });

  // The OTHER way to already be in a doubles event: on a team. Partitioned per
  // player rather than refusing the batch, like every other check here.
  if (doubles && candidates.length > 0) {
    const paired = await playersAlreadyPaired(adminClient, eventId, candidates);
    candidates = candidates.filter((id) => {
      if (paired.has(id)) {
        failures.push({ id, message: `This player ${ALREADY_PAIRED_REFUSAL}` });
        return false;
      }
      return true;
    });
  }

  // THE COMPETITION CATEGORY (00111) — PARTITIONED, never thrown. The entry
  // cap's reasoning applies word for word: this is a PER-PERSON test, each
  // candidate is independently eligible or not, and one member's declared
  // category must not cost the next fifty-nine their place. It is also the
  // reason the refusal cannot be an exception here — this action is not wrapped
  // in runAction, so a throw reaches production as a redacted banner and the
  // exec never learns which of the sixty was refused.
  //
  // Placed BEFORE the capacity slice on purpose: somebody who was never
  // eligible must not consume one of the event's remaining places and push an
  // eligible member into "Event is full".
  if (!opts?.allowCategoryMismatch && candidates.length > 0
      && categoryRequiredBy(event.event_type as TournamentEventType) !== null) {
    const categories = await loadCompetitionCategories(adminClient, candidates);
    candidates = candidates.filter((id) => {
      // Keyed by player id, so the caller already knows who this is — hence the
      // neutral subject, matching the other failure messages here.
      const screen = screenExecEntry(
        event.event_type as TournamentEventType,
        categories.get(id) ?? null,
        'This player',
      );
      if (!screen.ok) {
        failures.push({ id, message: screen.message });
        return false;
      }
      return true;
    });
  }

  // Capacity, counted once against the WHOLE batch rather than re-read per
  // player. Everyone past the line is refused with the same sentence the
  // sequential path used, so a partial add still reads the same way.
  // Every read below is checked. In a per-player loop a swallowed error costs one
  // player; here the same swallow applies the wrong answer to the whole
  // selection, so "the query failed" must not be allowed to read as "the number
  // is zero" or "nobody has a rating".
  if (event.max_participants) {
    let room: number;
    if (doubles) {
      // In DRAW SLOTS, as the per-player path explains. `ceil((u + k) / 2)` must
      // fit in what is left after the formed pairs, so k is bounded by
      // `2 * (max - pairs) - u` exactly — no search, no off-by-one.
      const field = await loadDoublesField(adminClient, eventId);
      room = Math.max(Math.max(event.max_participants - field.pairs, 0) * 2 - field.unpaired, 0);
    } else {
      const { count, error: countError } = await adminClient.from('tournament_participants')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .not('status', 'eq', 'withdrawn');
      // A failed count reads as null, and `max - 0` is the FULL cap: the batch
      // would then be waved past a nearly full event in one go.
      if (countError || count === null) {
        if (countError) Sentry.captureException(countError);
        throw new Error('Could not check how full this event is. Nothing was added — try again.');
      }
      room = Math.max(event.max_participants - count, 0);
    }
    if (candidates.length > room) {
      for (const id of candidates.slice(room)) failures.push({ id, message: 'Event is full' });
      candidates = candidates.slice(0, room);
    }
  }

  // THE PER-MEMBER CAP — PARTITION, exactly as the two checks above do, because
  // a batch that refused whole because one person was at their limit would make
  // the exec pick the other fifty-nine again by hand. Nothing half-applies: the
  // refusals are decided here, before the single insert, and reported per
  // player alongside "already registered" and "Event is full".
  //
  // DELIBERATELY NOT A `room`/slice() CUTOFF like max_participants above.
  // That cap is a SHARED POOL — the event has N places and the first N in the
  // exec's order win, so order decides who gets in. This cap is a PER-PERSON
  // ALLOWANCE: each candidate is adding exactly one event to their own count,
  // so each is independently either at their limit or not, and one person being
  // at theirs must not cost the next person in the list their place. Written as
  // a slice it would refuse an arbitrary tail of innocent players.
  if (candidates.length > 0) {
    const { cap, counts } = await loadEntryCapState(adminClient, event.tournament_id);
    if (cap !== null) {
      candidates = candidates.filter((id) => {
        if (isAtEntryCap(counts.get(id) ?? 0, cap)) {
          // Keyed by player id, so the caller already knows who this is —
          // hence no name, matching the other two failure messages here.
          failures.push({
            id,
            message: `Already entered in ${cap} ${cap === 1 ? 'event' : 'events'} at this tournament, which is the limit.`,
          });
          return false;
        }
        return true;
      });
    }
  }

  if (candidates.length === 0) return { added: [], failures };

  // elo_before is stamped at registration, so every candidate needs a rating —
  // and it is the DISCIPLINE'S rating. See the per-player path: a solo entrant
  // in a doubles event is stamped with doubles_elo.
  const eloColumn = doubles ? 'doubles_elo' : 'singles_elo';
  const { data: ratingRows, error: ratingsReadError } = await adminClient
    .from('ratings')
    .select(`player_id, ${eloColumn}`)
    .in('player_id', candidates);
  if (ratingsReadError) {
    Sentry.captureException(ratingsReadError);
    throw new Error('Could not read player ratings. Nothing was added — try again.');
  }
  const eloByPlayer = new Map<string, number>(
    (ratingRows ?? []).map((r) => [
      (r as Record<string, unknown>).player_id as string,
      (r as Record<string, unknown>)[eloColumn] as number,
    ]),
  );

  // Same defaults as the single-player path, deliberately including the k_factor
  // values that differ from the column defaults — this is a copy of existing
  // behaviour, not a place to correct it.
  const missing = candidates.filter((id) => !eloByPlayer.has(id));
  if (missing.length > 0) {
    // upsert, not insert: ratings.player_id is unique, and somebody registering
    // the same player elsewhere between the read above and this write would
    // otherwise raise 23505 and reject the ratings for all sixty.
    const { error: ratingsWriteError } = await adminClient.from('ratings').upsert(
      missing.map((id) => ({
        player_id: id,
        singles_elo: 400,
        doubles_elo: 400,
        singles_provisional: true,
        doubles_provisional: true,
        singles_k_factor: 40,
        doubles_k_factor: 40,
      })),
      { onConflict: 'player_id', ignoreDuplicates: true },
    );
    if (ratingsWriteError) {
      Sentry.captureException(ratingsWriteError);
      throw new Error('Could not create ratings for these players. Nothing was added — try again.');
    }

    // Read back rather than trusting what was written: ignoreDuplicates returns
    // nothing for a row that already existed, and that row's real Elo is the one
    // that belongs in elo_before.
    const { data: filled, error: refetchError } = await adminClient
      .from('ratings')
      .select(`player_id, ${eloColumn}`)
      .in('player_id', missing);
    if (refetchError) {
      Sentry.captureException(refetchError);
      throw new Error('Could not read the ratings that were just created. Nothing was added — try again.');
    }
    for (const r of filled ?? []) {
      const row = r as Record<string, unknown>;
      eloByPlayer.set(row.player_id as string, row[eloColumn] as number);
    }
  }

  // Refuse rather than fall back to 400. A participant stamped with a made-up
  // elo_before and no ratings row registers cleanly and then fails at the point
  // somebody tries to score their match, which is the worst possible moment to
  // find out.
  const unrated = candidates.filter((id) => !eloByPlayer.has(id));
  if (unrated.length > 0) {
    throw new Error(
      `${unrated.length} of these players still have no rating record. Nothing was added — try again.`,
    );
  }

  // ONE call, through the fence. The partitioning above decided who is eligible
  // and produced the per-player failures; this decides whether the field still
  // agrees, and refuses the WHOLE batch if it does not. That is the behaviour
  // the direct insert already had on a unique violation — nothing half-applies,
  // because a partial success this cannot describe is worse than a refusal it
  // can.
  const { data: fenced, error } = await adminClient.rpc('add_participants_under_field_lock', {
    p_event_id: eventId,
    p_admin_id: admin.id,
    p_entries: candidates.map((id) => ({
      player_id: id,
      elo_before: eloByPlayer.get(id) ?? 400,
    })),
  });

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  const fence = fenced as FieldFenceResult | null;
  if (!fence?.ok) throw new ExpectedError(fenceRefusal(fence ?? null));

  const added = fence.participants.map((r) => r.player_id as string);

  // Entry fees for everyone who actually landed, in one call. Priced from each
  // player's own membership_type, so a batch of internal members and alumni
  // comes out at two different amounts without anybody choosing a tier.
  if (added.length > 0) await ensureEntryFees(adminClient, event.tournament_id, added);

  // One row per player, same shape as the single-player path writes, in one
  // statement. Collapsing the batch into a single row with a list would change
  // what `details.player_id` means for everything that reads this table.
  //
  // Reported but NOT thrown: the participants are already committed, so failing
  // the action here would tell the exec nothing was added when sixty people
  // were. A missing audit row is a real loss, which is why it goes to Sentry
  // rather than nowhere — one bad statement now costs the whole batch's trail,
  // not one row's.
  if (added.length > 0) {
    const { error: auditError } = await adminClient.from('tournament_audit_log').insert(
      added.map((id) => ({
        tournament_id: event.tournament_id,
        event_id: eventId,
        match_id: null,
        action: 'participant_added',
        performed_by: admin.id,
        details: { player_id: id },
      })),
    );
    if (auditError) Sentry.captureException(auditError);
  }

  // One read and ONE insert for the whole batch, not sixty of each — the same
  // reason this action exists at all. Only the entrants who actually landed and
  // who do not already have a current acceptance are told.
  const { unsigned, tournamentName } = await unsignedAmong(adminClient, event.tournament_id, added);
  await notifyEventWaiverRequired(adminClient, event.tournament_id, tournamentName, unsigned);

  revalidateEventPaths(event.tournament_id, eventId);
  return { added, failures };
}

export async function removeParticipantFromEvent(participantId: string) {
  const admin = await requireCapability('tournaments.draw.participants.remove.write');
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select('*, event:tournament_events(*)')
    .eq('id', participantId)
    .single();
  if (!participant) throw new Error('Participant not found');

  const event = participant.event as Record<string, unknown>;
  // CHECK-IN COUNTS AS OPEN, and leaving it out was a dead end.
  //
  // Removal was registration-only and withdrawal only appears once a draw
  // exists, so at `checkin` an event offered NEITHER — while the status
  // transitions are forward-only, so there was no way back to registration
  // either. An exec who needed to take one entrant out during check-in could
  // not, and could not generate the draw around them. The owner hit exactly
  // that and reported the event stuck.
  //
  // Check-in is when a club learns who actually turned up, which makes it the
  // moment an entrant most often has to come out. Allowing it here closes the
  // gap without touching the draw statuses, where withdrawal — which keeps the
  // record and the fee — is the correct instrument instead.
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new ExpectedError('Entries can only be removed before the draw is generated.');
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');

  // FENCED — 00201. The two refusals above are read from a row fetched a round
  // trip ago; this RPC re-reads them under the field lock and deletes in the
  // same transaction, so a draw published in between refuses the removal
  // instead of silently dropping an entrant out of a bracket that already
  // contains them.
  const { data: removed, error } = await adminClient.rpc('remove_field_entry', {
    p_entry_id: participantId,
    p_is_pair: false,
  });
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const removedResult = removed as FencedFieldResult | null;
  if (!removedResult?.ok) fencedRefusal(removedResult, 'Participant not found');

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: participant.event_id,
    action: 'participant_removed',
    performed_by: admin.id,
    details: { player_id: participant.player_id },
  });

  // A place may have freed: the waitlist's head goes in (00278). Never throws.
  await fillFromWaitlistAfterFree(adminClient, participant.event_id as string, admin.id);

  revalidateEventPaths(event.tournament_id as string, participant.event_id as string);
}

export async function checkInParticipant(participantId: string): Promise<ActionResult> {
  return runAction(() => checkInParticipantImpl(participantId));
}

async function checkInParticipantImpl(participantId: string) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select(`${participantContextSelect}, player_id, player:players!player_id(full_name)`)
    .eq('id', participantId)
    .single();

  // Refuse BEFORE writing rather than pressing on without it. This context is
  // what names the paths to revalidate, and the page no longer calls
  // router.refresh() as a second chance — so a check-in that reached here
  // without it would update the row and leave the desk staring at a screen that
  // still says the player is waiting.
  const participantCtx = extractEventContext(participant);
  if (!participantCtx) throw new Error('Could not read this participant. Nothing was changed — try again.');
  await assertTournamentNotSuspended(adminClient, participantCtx.tid);

  // THE HARD BLOCK. Adding somebody stays permissive; taking part does not.
  // Deliberately BEFORE the update, so a refused check-in leaves no trace of a
  // check-in that did not happen.
  await assertEventWaiverSigned(adminClient, participantCtx.tid, {
    id: participantId,
    members: [{
      id: participant!.player_id as string,
      name: pickName(participant!.player) ?? 'This player',
    }],
  });

  // FENCED — 00201. Check-in used to be an unguarded direct write: it asked
  // nothing about the event's status and took no lock, so it could check
  // somebody in against an event that had just been completed, or against a
  // withdrawal that landed a millisecond earlier.
  const { data: checked, error } = await adminClient.rpc('set_field_entry_status', {
    p_entry_id: participantId,
    p_is_pair: false,
    p_new_status: 'checked_in',
    p_actor: admin.id,
  });
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const checkedResult = checked as FencedFieldResult | null;
  if (!checkedResult?.ok) fencedRefusal(checkedResult, 'Participant not found');

  revalidateEventPaths(participantCtx.tid, participantCtx.eventId);
}

export async function markParticipantNoShow(participantId: string) {
  await requireCapability('tournaments.draw.noshow.write');
  const adminClient = createAdminClient();

  // FENCED, AND GUARDED AT ALL FOR THE FIRST TIME — 00201.
  //
  // This was the most exposed write in the file: a bare status update with no
  // event-status check of any kind, so an entrant could be marked no-show on a
  // completed event, contradicting results and Elo that were already settled.
  // The guard added in 00201 is deliberately narrow — 'registration' and
  // 'completed' only — because the fence is what closes the races and a
  // stricter rule invented here would refuse a desk workflow that is ordinary.
  //
  // The context now comes BACK from the RPC, read under the same lock as the
  // write. It used to come from a RETURNING clause, which was already
  // correct, but this way there is one source for it across all these actions.
  const { data, error } = await adminClient.rpc('set_field_entry_status', {
    p_entry_id: participantId,
    p_is_pair: false,
    p_new_status: 'no_show',
    p_actor: null,
  });

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const noShowResult = data as FencedFieldResult | null;
  if (!noShowResult?.ok) fencedRefusal(noShowResult, 'Participant not found');

  // Without the context there is nothing to revalidate, and since these screens
  // stopped calling router.refresh() a silent skip leaves the desk looking at a
  // board that still says the player is waiting. Say what happened and tell
  // them to reload.
  if (!noShowResult.tournament_id || !noShowResult.event_id) {
    Sentry.captureException(new Error('Tournament entry updated but its event context was unreadable — page not revalidated'));
    throw new Error('Saved, but the page could not be refreshed. Reload to see the change.');
  }
  revalidateEventPaths(noShowResult.tournament_id, noShowResult.event_id);
}

// ============================================================
// Taking an entry OUT of the event
// ============================================================
// Withdrawal and disqualification are the same operation with different
// paperwork: the entry stops being part of the event. Once a draw exists that
// has to reach the bracket as well, because bracket generation only ever saw a
// point-in-time snapshot of who was in — leave it at a status change and the
// entry stays seeded, their match stays READY, and someone turns up to play a
// player who is not coming.

export interface DrawExitResult {
  /** Matches forfeited to an opponent right now. */
  forfeited: number;
  /**
   * Matches whose opposing slot is still TBD. They are settled automatically
   * the moment the feeder match resolves.
   */
  unresolved: number;
  /**
   * The draw exists but the event has not started, so nothing was forfeited.
   * Regenerating the bracket is the cleaner fix at this stage; failing that,
   * going live sweeps them.
   */
  deferredToGoLive: boolean;
}

async function exitDrawImpl(
  entryId: string,
  isPair: boolean,
  status: DrawExitStatus,
  reason?: string,
): Promise<DrawExitResult> {
  const admin = await requireCapability('tournaments.draw.exit.write');
  const adminClient = createAdminClient();

  // THE STATUS WRITE AND THE EVENT STATUS IT LANDED AGAINST, IN ONE FENCED CALL.
  //
  // This used to be a read, a decision, and then a separate PostgREST update —
  // three round trips with no lock across them, which is the sequence the
  // round-9 review reproduced: this function read `checkin`, publication
  // committed a draw, and then this update committed anyway, because it took no
  // lock and never touched the event row publication had locked. The draw was
  // published containing an entrant who had just left it, and BOTH actions
  // reported success.
  //
  // set_field_entry_status (00201) takes the shared field key, re-reads the
  // entry and the event under it, and returns the event status it saw. What
  // makes that sufficient is not the write being atomic — it always was — but
  // the fact that EVERY OTHER field writer now takes the same key, so the
  // status below cannot move between this call and the next one.
  const { data: fenced, error: fenceError } = await adminClient.rpc('set_field_entry_status', {
    p_entry_id: entryId,
    p_is_pair: isPair,
    p_new_status: status,
    p_actor: admin.id,
  });
  if (fenceError) {
    Sentry.captureException(fenceError);
    throw new Error(fenceError.message);
  }
  const fencedResult = fenced as {
    ok: boolean; reason?: string; already?: boolean;
    event_status?: string; event_id?: string; tournament_id?: string;
  } | null;
  if (!fencedResult) throw new Error('Could not read this entry. Nothing was changed — try again.');
  if (!fencedResult.ok) {
    if (fencedResult.reason === 'entry_not_found') throw new ExpectedError('Entry not found');
    if (fencedResult.reason === 'event_not_found') throw new ExpectedError('Entry is not attached to an event');
    // A finished event's results and Elo are already settled. Pulling someone
    // out now would forfeit nothing and only contradict the standings.
    if (fencedResult.reason === 'event_completed') {
      throw new ExpectedError('This event is finished — void the affected matches instead.');
    }
    throw new ExpectedError('This entry could not be taken out of the draw. Reload the page and try again.');
  }

  const event = {
    id: fencedResult.event_id as string,
    // READ UNDER THE LOCK THE WRITE HAPPENED UNDER, which is the whole point:
    // the forfeit cascade below branches on this, and a stale value here is
    // exactly how a cascade got skipped on a live event.
    status: fencedResult.event_status as string,
    tournament_id: fencedResult.tournament_id as string,
  };

  // The 'completed' refusal that used to sit here has MOVED, not gone: it is
  // made inside set_field_entry_status under the field lock and surfaces above
  // as the `event_completed` reason. Repeating it here would be unreachable —
  // the RPC returns before writing — and an unreachable guard is how a reader
  // comes to believe a check runs when it does not.
  //
  // A repeat press is normally nothing to do — but on a live event it is also
  // the only way to finish a forfeit cascade that stopped partway, and that is
  // now reachable: applyTournamentMatchElo raises a failed rating write instead
  // of swallowing it, so an entry can end up marked withdrawn with some of its
  // matches still open. The status is written before the cascade runs, so the
  // old unconditional guard would have refused the very retry that fixes it —
  // the same trap finalizeEvent used to set.
  //
  // Forfeiting only ever touches matches that are still open, so re-running it
  // is idempotent. If there was genuinely nothing left, the original refusal
  // still stands (below, once we know).
  // Reported by the RPC rather than computed from a pre-read row: it is the
  // comparison made under the lock, against the status the write actually saw.
  // The RPC writes nothing when it is true, so this refusal still costs no
  // update — it just happens after the fenced call instead of before it.
  const alreadyOut = fencedResult.already === true;
  if (alreadyOut && event.status !== 'live') {
    throw new ExpectedError(status === 'withdrawn' ? 'Already withdrawn.' : 'Already disqualified.');
  }

  // `notes` is deliberately NOT set here any more — it moved to
  // tournament_participant_notes / tournament_pair_notes (00118) because both
  // parent tables carry a plain SELECT grant for `authenticated` AND are in the
  // realtime publication (00113), so an exec's reason for disqualifying
  // somebody was both queryable and streamed to every subscriber. The column
  // still exists and still holds its history; it is simply no longer written.
  //
  // The note itself is written FURTHER DOWN, immediately before logAudit, and
  // the distance is deliberate — see there.

  // Only a live event gets its matches forfeited. Between bracket generation
  // and the first serve nothing has been played: a walkover there could not be
  // rated, and recording one counts as a result, which would block the admin
  // from simply regenerating the draw without this entry. setEventStatus
  // sweeps whatever is still outstanding when the event goes live.
  let outcome: DrawExitResult = {
    forfeited: 0,
    unresolved: 0,
    deferredToGoLive: eventHasDraw(event.status),
  };
  if (event.status === 'live') {
    outcome = {
      ...await forfeitOpenMatchesForEntry(
        adminClient, event.id, entryId, isPair, FORFEIT_REASON[status], admin.id,
      ),
      deferredToGoLive: false,
    };
  }

  // Nothing was left over after all — so this really was just a second press,
  // and it gets the answer it always got.
  if (alreadyOut && outcome.forfeited === 0) {
    throw new ExpectedError(status === 'withdrawn' ? 'Already withdrawn.' : 'Already disqualified.');
  }

  // THE NOTE, WRITTEN HERE AND NOT BESIDE THE STATUS UPDATE IT ANNOTATES.
  //
  // It looks like it belongs up there, and putting it there is a bug. The
  // forfeit cascade sits between the two, and forfeitOpenMatchesForEntry can
  // throw — applyTournamentMatchElo raises a failed rating write rather than
  // swallowing it, which is the very thing that makes the retry path above
  // reachable. A note written before the cascade would then survive a call
  // whose logAudit never ran, leaving the private table holding a reason with
  // no audit row to explain it.
  //
  // That asymmetry is NEW, not inherited. While the reason was a column it was
  // set in the same statement as `status`, so "the entry is out" and "here is
  // why" could not disagree. Writing it last restores that: everything that can
  // fail has already failed, and the only two statements left are this one and
  // the audit row that records what it did.
  //
  // NOT WRITTEN AT ALL ON THE RETRY PATH, where the status update was skipped
  // too — a second press must not overwrite the reason the first press recorded
  // with whatever (possibly empty) reason was typed this time. `null` in the
  // audit row below means exactly that: no attempt.
  //
  // AND IT DOES NOT THROW. writePrivateNote never does, including on a
  // transport rejection; the outcome is threaded into the audit row instead of
  // being allowed to cost it.
  let noteResult: { recorded: boolean; error: string | null } | null = null;
  if (!alreadyOut) {
    noteResult = await writePrivateNote(
      adminClient,
      isPair ? PAIR_NOTES : PARTICIPANT_NOTES,
      entryId,
      reason,
      admin.id,
    );
    if (noteResult.error) {
      Sentry.captureException(
        new Error(`Draw-exit note not recorded: ${noteResult.error}`),
        { extra: { entryId, isPair, status } },
      );
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: status === 'withdrawn' ? 'participant_withdrawn' : 'participant_disqualified',
    performed_by: admin.id,
    details: {
      entry_id: entryId,
      is_pair: isPair,
      // The reason is recorded HERE regardless of whether the private note
      // landed, which is why a failed note is a degraded outcome rather than a
      // lost one.
      reason: reason ?? null,
      // WHAT ACTUALLY HAPPENED, not what was asked for. `null` means no attempt
      // was made (the retry path); `false` means 00118 has not been applied to
      // this database yet. The audit row must not imply a note it does not have.
      note_recorded: noteResult ? noteResult.recorded : null,
      ...outcome,
    },
  });

  // Before the draw, a withdrawal frees a place for the waitlist (00278). The
  // fill refuses quietly once a draw exists. Never throws.
  if (!alreadyOut) await fillFromWaitlistAfterFree(adminClient, event.id, admin.id);

  revalidateEventPaths(event.tournament_id, event.id);
  return outcome;
}

// These return ActionResult rather than throwing: Next.js redacts errors thrown
// out of a Server Action in production, so "This event is finished" would reach
// the exec as an opaque banner. Same contract the result actions already use.
export async function withdrawParticipant(participantId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(participantId, false, 'withdrawn', reason));
}

export async function disqualifyParticipant(participantId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(participantId, false, 'disqualified', reason));
}

export async function withdrawPair(pairId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(pairId, true, 'withdrawn', reason));
}

export async function disqualifyPair(pairId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(pairId, true, 'disqualified', reason));
}

// ============================================================
// Doubles Pair Management
// ============================================================

/**
 * Add a doubles pair.
 *
 * RETURNS ActionResult RATHER THAN THROWING, for the reason the withdraw and
 * check-in actions in this file already give: Next.js redacts an error thrown
 * out of a Server Action in production, so every refusal below — "Event is
 * full", "Draw is locked", and above all the entry-cap refusal that NAMES THE
 * HALF AT FAULT — would reach the exec as an opaque banner. A refusal whose
 * reason is redacted is a refusal the exec cannot act on, and naming the player
 * is the entire point of that message.
 */
export async function addPairToEvent(
  eventId: string,
  player1Id: string,
  player2Id: string,
  opts?: EntryCategoryOptions,
): Promise<ActionResult<unknown>> {
  return runAction(() => addPairToEventImpl(eventId, player1Id, player2Id, opts));
}

async function addPairToEventImpl(
  eventId: string,
  player1Id: string,
  player2Id: string,
  opts?: EntryCategoryOptions,
) {
  const admin = await requireCapability('tournaments.draw.pairs.add.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin' && !(await lateEntryOpen(adminClient, event))) {
    throw new ExpectedError('Cannot add pairs in current status');
  }
  if (event.external_event === true) throw new ExpectedError(EXTERNAL_EVENT_REFUSAL);

  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  if (!isDoublesEvent(event.event_type)) {
    throw new Error('Use addParticipantToEvent for singles events');
  }

  if (player1Id === player2Id) throw new ExpectedError('A pair needs two different players.');

  // WHO IS ALREADY WHERE, because since 00102 either half may already be in
  // this event as an unpaired entrant — and forming their team is then a
  // PROMOTION, not a new entry. Everything below has to know which it is: a
  // promotion spends no new cap slot, occupies no new draw slot and is already
  // invoiced.
  const [alreadyPaired, alreadyUnpaired] = await Promise.all([
    playersAlreadyPaired(adminClient, eventId, [player1Id, player2Id]),
    playersAlreadyUnpaired(adminClient, eventId, [player1Id, player2Id]),
  ]);

  // Get both players' Elo and names
  const { data: ratings } = await adminClient.from('ratings')
    .select('player_id, doubles_elo')
    .in('player_id', [player1Id, player2Id]);

  // competition_category rides along on the name read this path already does
  // (00111), so the pair rule costs no extra round trip. Read, never shown.
  const { data: players } = await adminClient.from('players')
    .select('id, full_name, competition_category')
    .in('id', [player1Id, player2Id]);
  const nameFor = (id: string) => players?.find((p) => p.id === id)?.full_name ?? 'This player';
  const categoryFor = (id: string) =>
    toCompetitionCategory(
      (players?.find((p) => p.id === id) as { competition_category?: unknown } | undefined)
        ?.competition_category,
    );

  // Refused here as well as inside the RPC, so the exec gets a sentence with a
  // NAME in it rather than the database's own wording.
  for (const half of [player1Id, player2Id]) {
    if (alreadyPaired.has(half)) {
      throw new ExpectedError(`${nameFor(half)} ${ALREADY_PAIRED_REFUSAL}`);
    }
  }

  // THE CATEGORY RULES (00111), IN TWO PARTS, because this action does two
  // things: it can ENTER people who were not in the event at all, and it forms
  // a TEAM out of whoever the two halves are.
  //
  // 1. THE PER-PERSON RULE, ONLY FOR A HALF WHO IS ENTERING NOW. A half already
  //    loose in the pool is being PROMOTED, and they were screened on the way
  //    into it — re-screening them here would refuse a pairing on a rule an exec
  //    already, deliberately, overrode at entry, and leave that person stranded
  //    in a pool nobody may pair them out of. Same discount, same reason, as the
  //    entry cap's `alreadyUnpaired` subtraction below.
  //
  // 2. THE MIXED RULE, ALWAYS, because it is about the team and not about
  //    either person: one 'mens' and one 'womens'. Two people who both declared
  //    the same category cannot be a mixed pair however eligible each is alone,
  //    and that stays true whether they were promoted or entered here.
  //
  // A HALF WHO DECLARED NOTHING REFUSES NOTHING. They cannot make the pair
  // provably wrong, and "not provably wrong" is where every console check in
  // this file draws its line.
  //
  // This is also the gate 00102's pairing RPC cannot hold: it runs in one
  // transaction precisely so no application logic sits between the delete and
  // the insert, and these refusals need sentences with names in them.
  if (!opts?.allowCategoryMismatch) {
    const pairEventType = event.event_type as TournamentEventType;
    for (const half of [player1Id, player2Id]) {
      if (alreadyUnpaired.has(half)) continue;
      const screen = screenExecEntry(pairEventType, categoryFor(half), nameFor(half));
      if (!screen.ok) throw new ExpectedError(screen.message);
    }
    if (categoryRequiredBy(pairEventType) === 'mixed') {
      const pairScreen = screenPair(
        pairEventType,
        { category: categoryFor(player1Id), name: nameFor(player1Id) },
        { category: categoryFor(player2Id), name: nameFor(player2Id) },
      );
      if (!pairScreen.ok) throw new ExpectedError(pairScreen.message);
    }
  }

  // Capacity, in draw slots. PROMOTION IS SLOT-NEUTRAL by construction — two
  // loose entrants were already worth one prospective team — so pairing up an
  // event that is exactly full still works, which is the whole point of letting
  // people enter alone. See doublesDrawSlots.
  if (event.max_participants) {
    const field = await loadDoublesField(adminClient, eventId);
    const promoted = [player1Id, player2Id].filter((id) => alreadyUnpaired.has(id)).length;
    const after = doublesDrawSlots(field.pairs + 1, field.unpaired - promoted);
    if (wouldExceedCapacity(field.slots, after, event.max_participants)) {
      throw new ExpectedError('Event is full');
    }
  }

  // THE PER-MEMBER CAP, FOR BOTH HALVES. A pair is two entrants who happen to
  // play together — this row spends one of each player's allowance — so EITHER
  // of them being at their limit refuses the whole pair. There is no half-entry
  // to fall back to: a doubles event needs two people.
  //
  // The refusal NAMES THE HALF AT FAULT. "This pair is at the limit" tells the
  // exec the team is broken but not whose entries to go and look at, and with
  // the partner standing right there that is the difference between a two-second
  // fix and a support question. Checked before the insert, and before the fee
  // rows and waiver notices below, so a refused pair leaves nothing behind.
  //
  // THE PROMOTION IS DISCOUNTED. countEventEntriesPerPlayer already counts an
  // unpaired entrant's row, and this pair CONSUMES that row rather than adding
  // to it. Without the subtraction, pairing two people who each entered alone
  // at a tournament capped to one event would be refused for being at a limit
  // the operation does not move.
  const { cap, counts } = await loadEntryCapState(adminClient, event.tournament_id);
  if (cap !== null) {
    for (const half of [player1Id, player2Id]) {
      const spent = (counts.get(half) ?? 0) - (alreadyUnpaired.has(half) ? 1 : 0);
      if (isAtEntryCap(spent, cap)) {
        throw new ExpectedError(entryCapRefusal(nameFor(half), cap));
      }
    }
  }

  const p1Rating = ratings?.find(r => r.player_id === player1Id)?.doubles_elo ?? 400;
  const p2Rating = ratings?.find(r => r.player_id === player2Id)?.doubles_elo ?? 400;
  const combinedElo = calculateTeamRating([p1Rating, p2Rating]);

  const p1Name = players?.find(p => p.id === player1Id)?.full_name ?? '';
  const p2Name = players?.find(p => p.id === player2Id)?.full_name ?? '';

  // ONE TRANSACTION: the pair is written and both halves leave the unpaired
  // pool together, or neither happens. From here that could only be a delete
  // and an insert over two PostgREST round trips, and a failure between them
  // leaves somebody counted twice by the entry cap — in the draw AND in the
  // pool — or strips two entries that were paid for. See migration 00102.
  //
  // The arithmetic stays out of the database, per 00070: combined_elo is
  // calculateTeamRating's answer and the name is joined here, so there is only
  // ever one implementation of either.
  const { data: newPairId, error } = await adminClient.rpc('pair_tournament_entrants', {
    p_event_id: eventId,
    p_player1_id: player1Id,
    p_player2_id: player2Id,
    p_pair_name: `${p1Name} / ${p2Name}`,
    p_combined_elo: combinedElo,
    p_added_by: admin.id,
  });

  if (error) {
    if (error.code === '23505') throw new ExpectedError('This pair is already registered');
    // The function raises its own refusals with real messages — "already in a
    // pair", "already left this event", "not a doubles event" — so they are
    // passed through rather than replaced with something vaguer.
    // 23514 check_violation, P0002 no_data_found — the two SQLSTATEs 00102
    // raises its own refusals under.
    if (error.code === '23514' || error.code === 'P0002') throw new ExpectedError(error.message);
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // A staged event's head starts read the team's category. Best effort: the
  // members' declared categories, else what the event type implies, and only
  // when the event lists it. The organiser can change it on the tab, so a
  // failure here is reported and does not undo the pair.
  if (event.format === 'staged' && newPairId) {
    const suggested = pickCategory(
      parseFormatConfig(event.format_config),
      suggestCategory([categoryFor(player1Id), categoryFor(player2Id)].map((c) => ({ competition_category: c })))
        ?? categoryForEventType(event.event_type),
    );
    if (suggested) {
      const { error: categoryError } = await adminClient.from('tournament_pairs')
        .update({ team_category: suggested }).eq('id', newPairId as string);
      if (categoryError) Sentry.captureException(categoryError);
    }
  }

  const { data } = await adminClient.from('tournament_pairs').select().eq('id', newPairId as string).maybeSingle();

  // BOTH HALVES OF THE PAIR, each priced off their own membership_type. A pair
  // is two entrants who happen to play together, not one; an internal member
  // partnering an alum pays the internal price and the alum pays theirs.
  //
  // A PROMOTED HALF IS NOT INVOICED TWICE, and not because of a check here:
  // club_fees_tournament_player_key (00094) keys the row on
  // (tournament_id, player_id), so the row their solo entry created IS the row
  // this call would write, and ensureEntryFees skips everyone who already has
  // one. Double-invoicing a promoted entrant is not something this code avoids;
  // it is something the schema makes unreachable.
  await ensureEntryFees(adminClient, event.tournament_id, [player1Id, player2Id]);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'pair_added',
    performed_by: admin.id,
    // `promoted_from_pool` is how the trail distinguishes "an exec entered a
    // team" from "two people who had entered alone were put together" — the
    // same row either way, and a different thing to have happened.
    details: {
      player1_id: player1Id,
      player2_id: player2Id,
      promoted_from_pool: [player1Id, player2Id].filter((id) => alreadyUnpaired.has(id)),
    },
  });

  // BOTH HALVES ARE TOLD, and each is asked for their own signature — because
  // the pair cannot be checked in until both have one. A pair is the population
  // this feature was built for: the player app's registration dialog returns
  // early for doubles and never shows the waiver at all, so before this change
  // NO doubles entrant had ever been asked, in any tournament.
  const { unsigned, tournamentName } = await unsignedAmong(
    adminClient, event.tournament_id, [player1Id, player2Id],
  );
  await notifyEventWaiverRequired(adminClient, event.tournament_id, tournamentName, unsigned);

  revalidateEventPaths(event.tournament_id, eventId);
  return data;
}

/**
 * AN EXTERNAL TEAM (00269): two names, no member accounts, in an external event only.
 *
 * No fee row, no waiver request and no entry-cap count, because there is no
 * member to charge, ask or count. add_external_tournament_pair re-checks
 * everything below under the field lock and is the only writer of the row.
 */
export async function addExternalPairToEvent(
  eventId: string,
  name1: string,
  name2: string,
  teamName?: string | null,
  category?: string | null,
): Promise<ActionResult<unknown>> {
  return runAction(() => addExternalPairToEventImpl(eventId, name1, name2, teamName, category));
}

async function addExternalPairToEventImpl(
  eventId: unknown, name1: unknown, name2: unknown, teamName: unknown, category: unknown,
) {
  const admin = await requireCapability('tournaments.draw.pairs.add.write');
  const adminClient = createAdminClient();

  if (typeof eventId !== 'string' || eventId.length === 0) throw new Error('Event not found');
  const names = normalizeExternalTeamNames(name1, name2, teamName);
  if (!names.ok) throw new ExpectedError(names.error);
  if (category != null && typeof category !== 'string') throw new ExpectedError('Choose a category from the list.');
  const teamCategory = typeof category === 'string' && category.trim() !== '' ? category.trim() : null;

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).maybeSingle();
  if (!event) throw new Error('Event not found');
  if (event.external_event !== true) throw new ExpectedError('External teams can only be entered in an external event.');
  if (event.status !== 'registration' && event.status !== 'checkin' && !(await lateEntryOpen(adminClient, event))) {
    throw new ExpectedError('Cannot add pairs in current status');
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);
  if (teamCategory !== null) {
    if (event.format !== 'staged') throw new ExpectedError('A category applies to staged events only.');
    const cfg = parseFormatConfig(event.format_config);
    if (!cfg?.categories.some((c) => c.key === teamCategory)) {
      throw new ExpectedError(`"${teamCategory}" is not a category of this event.`);
    }
  }

  const [first, second] = names.names;
  const team = names.teamName;
  const args = {
    p_event_id: eventId,
    p_external1_name: first,
    p_external2_name: second,
    p_added_by: admin.id,
    ...(team ? { p_team_name: team } : {}),
  };
  // 00274's v2 takes the category in the same transaction. An older database
  // has only the 00269 function: without a category that is the same write,
  // with one it would silently drop it, so it is refused instead.
  let { data: newPairId, error } = await adminClient.rpc('add_external_tournament_pair_v2', {
    ...args,
    // Always sent, null included, so PostgREST resolves the six-argument v2.
    p_category: teamCategory as string,
  });
  if (error && (error.code === 'PGRST202' || error.code === '42883')) {
    if (teamCategory !== null) throw new ExpectedError('Run migration 00274 first');
    ({ data: newPairId, error } = await adminClient.rpc('add_external_tournament_pair', args));
  }
  if (error) {
    if (error.code === '23505' || error.code === '23514' || error.code === 'P0002') {
      throw new ExpectedError(error.message);
    }
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'external_pair_added',
    performed_by: admin.id,
    details: { pair_id: newPairId, external_names: [first, second], team_name: team, team_category: teamCategory },
  });

  revalidateEventPaths(event.tournament_id, eventId);
  return { id: newPairId as string };
}

// ============================================================
// Taking a team APART — the two ways out that are not "remove"
// ============================================================
// Three different things an exec might mean by "this pair is wrong", and they
// are deliberately three actions rather than one:
//
//   removePairFromEvent  — the team should never have been entered. The row is
//                          deleted and nobody is left in the event.
//   unpairEntry          — the two PEOPLE belong here, this TEAM does not.
//                          Both return to the unpaired pool and can be paired
//                          with somebody else.
//   withdrawPairMember   — one half has pulled out. The leaver is marked
//                          withdrawn; the partner returns to the pool.
//
// Both of the new ones are the same two writes in the opposite order to
// pairing (delete a pair, insert two participants) and carry the same hazard,
// so both go through unpair_tournament_pair (00102) and are atomic for the same
// reason.

/** What the caller is told back, so the toast can name the pool. */
export interface UnpairResult {
  /** The two members now loose in the pool — or one, when the other withdrew. */
  returned: number;
  withdrawnName: string | null;
}

export async function unpairEntry(pairId: string): Promise<ActionResult<UnpairResult>> {
  return runAction(() => splitPairImpl(pairId, null, undefined));
}

/**
 * ONE HALF OF A FORMED PAIR PULLS OUT.
 *
 * The club owner has ruled that withdrawing does not refund. So the partner who
 * is left has already paid the tournament's entry fee, has already accepted its
 * event waiver, and is already spending one of their allowed entries — and none
 * of those three came from having a partner. Deleting their entry because
 * somebody else bailed would take all three away and punish the wrong person.
 * They drop back into the unpaired pool instead, keeping every one of them, and
 * can be given a different partner. That is the whole point of the pool.
 *
 * The leaver keeps a 'withdrawn' row rather than disappearing: it is what makes
 * "no refund" legible next to their fee, and it releases their own entry-cap
 * slot exactly as any other withdrawal does.
 *
 * ONLY BEFORE THE DRAW. Once the pair is seeded, splitting it up is not
 * something the database will do — tournament_matches.pair_a_id and its three
 * siblings REFERENCE tournament_pairs(id) with no ON DELETE action, so the
 * delete raises a foreign-key violation. At that point the coherent exit is
 * withdrawing the WHOLE pair, which forfeits its matches to its opponents and
 * is what withdrawPair already does.
 */
export async function withdrawPairMember(
  pairId: string,
  playerId: string,
  reason?: string,
): Promise<ActionResult<UnpairResult>> {
  return runAction(() => splitPairImpl(pairId, playerId, reason));
}

async function splitPairImpl(
  pairId: string,
  withdrawnPlayerId: string | null,
  reason: string | undefined,
): Promise<UnpairResult> {
  // TWO DIFFERENT CAPABILITIES FOR ONE FUNCTION, chosen by what is being asked
  // for. Unpairing destroys a pair row and creates nothing that is not already
  // in the event, which is `pairs.remove.write`. Withdrawing a member takes
  // somebody OUT of the event, which is `exit.write` — the same key the other
  // three withdrawal actions in this file ask for. Handing one to a holder of
  // the other would be a hole in whichever they do not hold.
  const admin = withdrawnPlayerId
    ? await requireCapability('tournaments.draw.exit.write')
    : await requireCapability('tournaments.draw.pairs.remove.write');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('id, event_id, player1_id, player2_id, event:tournament_events(id, status, tournament_id, draw_locked), player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
    .eq('id', pairId)
    .maybeSingle();
  if (!pair) throw new ExpectedError('Pair not found');

  const event = (Array.isArray(pair.event) ? pair.event[0] : pair.event) as {
    id: string; status: string; tournament_id: string; draw_locked: boolean;
  } | null;
  if (!event) throw new ExpectedError('Pair is not attached to an event');
  if (pair.player1_id == null) throw new ExpectedError(EXTERNAL_PAIR_SPLIT_REFUSAL);

  if (withdrawnPlayerId && withdrawnPlayerId !== pair.player1_id && withdrawnPlayerId !== pair.player2_id) {
    throw new ExpectedError('That player is not in this pair.');
  }

  // Same window pairing has: while the entry list is still being assembled.
  // `bracket_generated` and everything after is refused by the function too, on
  // the stronger test of whether the pair is actually in a match.
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new ExpectedError(
      withdrawnPlayerId
        ? 'The draw already exists, so this pair cannot be split up. Withdraw the whole pair instead — their matches are forfeited to their opponents.'
        : 'Pairs can only be split up while the event is still taking entries.',
    );
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const { error } = await adminClient.rpc('unpair_tournament_pair', {
    p_pair_id: pairId,
    p_withdrawn_player_id: withdrawnPlayerId,
    p_reason: reason ?? null,
    p_added_by: admin.id,
  });
  if (error) {
    // The function's own refusals are sentences an exec can act on — "already
    // in the draw", "already left the event" — so they are passed through.
    // 23503 foreign_key_violation (the pair is in the draw), 23514
    // check_violation, P0002 no_data_found.
    if (error.code === '23503' || error.code === '23514' || error.code === 'P0002') {
      throw new ExpectedError(error.message);
    }
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  const nameOfHalf = (id: string) =>
    pickName(id === pair.player1_id ? pair.player1 : pair.player2) ?? 'This player';

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: withdrawnPlayerId ? 'participant_withdrawn' : 'pair_unpaired',
    performed_by: admin.id,
    details: {
      pair_id: pairId,
      player1_id: pair.player1_id,
      player2_id: pair.player2_id,
      withdrawn_player_id: withdrawnPlayerId,
      reason: reason ?? null,
    },
  });

  // NO FEE IS TOUCHED, in either direction. ensureEntryFees is not called
  // because both members already have their one row for this tournament, and
  // nothing is refunded because the club owner has ruled that a withdrawal does
  // not refund. Nor is the event-waiver acceptance touched: it is per member per
  // TOURNAMENT and was never a fact about who they were playing with.
  //
  // A withdrawn half can free a draw slot when the pool count turns odd, so
  // the waitlist is offered it (00278). Never throws.
  await fillFromWaitlistAfterFree(adminClient, event.id, admin.id);
  revalidateEventPaths(event.tournament_id, event.id);
  // Both rows exist either way; only one of them is still IN the event when a
  // member withdrew, and that is the number the toast should say.
  return {
    returned: withdrawnPlayerId ? 1 : 2,
    withdrawnName: withdrawnPlayerId ? nameOfHalf(withdrawnPlayerId) : null,
  };
}

/**
 * SWAP ONE HALF OF A FORMED PAIR FOR SOMEBODY ELSE.
 *
 * "we should also be allowed to edit pairs" — the club owner, and the case is
 * "Priya is injured, Sam is taking her place". Done as unpair-then-pair that is
 * three operations with a durable middle state in which two people who ARE
 * entered look like they are not on a team; done here it is one.
 *
 * TWO CAPABILITIES, BOTH REQUIRED, and deliberately a conjunction rather than a
 * new key. A swap genuinely is a removal and an addition fused — it takes one
 * member off a team and puts another on — so asking only one of them would make
 * this the way a holder of `pairs.add.write` does `pairs.remove.write`'s job, or
 * the reverse. Nothing is widened: anybody who could already do it in three
 * steps can do it in one, and nobody else can.
 *
 * THE INCOMING PLAYER MUST ALREADY BE IN THE POOL, which is what makes the swap
 * neutral for the entry cap, the fee ledger and the event waiver all at once —
 * one member in, one out, both already entered. See 00103's header for why the
 * alternative (swapping in a stranger) would mean re-implementing the whole
 * entry path inside the function whose job is atomicity.
 */
export async function swapPairMember(
  pairId: string,
  outgoingPlayerId: string,
  incomingPlayerId: string,
  opts?: EntryCategoryOptions,
): Promise<ActionResult<{ pairName: string }>> {
  return runAction(() => swapPairMemberImpl(pairId, outgoingPlayerId, incomingPlayerId, opts));
}

async function swapPairMemberImpl(
  pairId: string,
  outgoingPlayerId: string,
  incomingPlayerId: string,
  opts?: EntryCategoryOptions,
): Promise<{ pairName: string }> {
  // Both, in the order the operation performs them. requireCapability takes one
  // capability, so this is two calls rather than a new kind of gate.
  await requireCapability('tournaments.draw.pairs.remove.write');
  const admin = await requireCapability('tournaments.draw.pairs.add.write');
  const adminClient = createAdminClient();

  // event_type joins the embed for 00111: a swap FORMS A NEW TEAM out of an
  // existing one, so it is the fifth entry path and the one a category rule is
  // easiest to forget. Replacing the woman on a mixed pair with a second man
  // produces an ineligible team out of two additions that were each fine.
  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('id, event_id, player1_id, player2_id, event:tournament_events(id, status, event_type, tournament_id, draw_locked)')
    .eq('id', pairId)
    .maybeSingle();
  if (!pair) throw new ExpectedError('Pair not found');

  const event = (Array.isArray(pair.event) ? pair.event[0] : pair.event) as {
    id: string; status: string; event_type: string; tournament_id: string; draw_locked: boolean;
  } | null;
  if (!event) throw new ExpectedError('Pair is not attached to an event');
  if (pair.player1_id == null) throw new ExpectedError(EXTERNAL_PAIR_SPLIT_REFUSAL);

  if (outgoingPlayerId !== pair.player1_id && outgoingPlayerId !== pair.player2_id) {
    throw new ExpectedError('That player is not in this pair.');
  }
  // Same window pairing and unpairing have: while the entry list is still being
  // assembled. The function refuses anything later on the stronger test of
  // whether the pair is actually in a match.
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new ExpectedError(
      'The draw already exists, so this team cannot be changed. Regenerate the bracket, or withdraw the pair.',
    );
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // RECOMPUTED, NEVER CARRIED OVER. A swap that kept the old combined_elo seeds
  // the draw off somebody who is no longer on the team, and one that kept the
  // old pair_name puts their name on the bracket. Both come from here rather
  // than from plpgsql, for the reason 00070 gives about the rating arithmetic.
  const partnerId = pair.player1_id === outgoingPlayerId ? pair.player2_id : pair.player1_id;
  const [{ data: ratings }, { data: players }] = await Promise.all([
    adminClient.from('ratings').select('player_id, doubles_elo').in('player_id', [partnerId, incomingPlayerId]),
    // competition_category rides along on the read the swap already does — the
    // pair rule below needs both halves of the team AS IT WILL BE.
    adminClient.from('players').select('id, full_name, competition_category').in('id', [partnerId, incomingPlayerId]),
  ]);
  const nameFor = (id: string) => players?.find((p) => p.id === id)?.full_name ?? '';
  const eloFor = (id: string) => ratings?.find((r) => r.player_id === id)?.doubles_elo ?? 400;

  // THE MIXED RULE, ON THE TEAM THE SWAP WOULD LEAVE BEHIND (00111). Screened
  // on the REMAINING partner and the INCOMING member, never on the outgoing one
  // — the question is whether the new team is legal, not whether the old one
  // was.
  //
  // THE MIXED RULE AND NOTHING ELSE. The per-person rule is not re-applied here
  // for the reason addPairToEvent gives about a promotion: the incoming member
  // is by construction already in this event's pool, so they met it — or an exec
  // deliberately overrode it — when they entered. Re-asking would refuse a swap
  // on a decision that has already been taken, and strand somebody in a pool.
  //
  // Same override as the add paths, and the same reason it exists: an exec
  // fixing a team five minutes before a draw may know something the rule does
  // not. Nothing is written before this refusal.
  if (!opts?.allowCategoryMismatch
      && categoryRequiredBy(event.event_type as TournamentEventType) === 'mixed') {
    const categoryFor = (id: string) =>
      toCompetitionCategory(
        (players?.find((p) => p.id === id) as { competition_category?: unknown } | undefined)
          ?.competition_category,
      );
    const pairScreen = screenPair(
      event.event_type as TournamentEventType,
      { category: categoryFor(partnerId), name: nameFor(partnerId) || 'Their partner' },
      { category: categoryFor(incomingPlayerId), name: nameFor(incomingPlayerId) || 'This player' },
    );
    if (!pairScreen.ok) throw new ExpectedError(pairScreen.message);
  }

  // The pair keeps its column ORDER, so the name reads the way the row does.
  const newPlayer1 = pair.player1_id === outgoingPlayerId ? incomingPlayerId : pair.player1_id;
  const newPlayer2 = pair.player2_id === outgoingPlayerId ? incomingPlayerId : pair.player2_id;
  const pairName = `${nameFor(newPlayer1)} / ${nameFor(newPlayer2)}`;
  const combinedElo = calculateTeamRating([eloFor(newPlayer1), eloFor(newPlayer2)]);

  const { error } = await adminClient.rpc('swap_tournament_pair_member', {
    p_pair_id: pairId,
    p_outgoing_player_id: outgoingPlayerId,
    p_incoming_player_id: incomingPlayerId,
    p_pair_name: pairName,
    p_combined_elo: combinedElo,
    p_added_by: admin.id,
  });
  if (error) {
    // 23503 the pair is in the draw, 23505 already on another team, 23514 every
    // other refusal, P0002 not found. All four carry sentences an exec can act
    // on, so they are passed through rather than replaced.
    if (['23503', '23505', '23514', 'P0002'].includes(error.code ?? '')) {
      throw new ExpectedError(error.message);
    }
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // NOTHING IS INVOICED AND NOTHING IS REFUNDED. Both members already have their
  // one club_fees row for this tournament — the incoming one because they had to
  // be in the pool to be swapped in, the outgoing one because they were on a
  // team. This call is therefore a no-op by the schema's own key
  // (tournament_id, player_id), and it is here so that the guarantee is stated
  // where a future edit would break it rather than only in a comment.
  await ensureEntryFees(adminClient, event.tournament_id, [incomingPlayerId]);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'pair_member_swapped',
    performed_by: admin.id,
    details: {
      pair_id: pairId,
      outgoing_player_id: outgoingPlayerId,
      incoming_player_id: incomingPlayerId,
      partner_player_id: partnerId,
      pair_name: pairName,
    },
  });

  // THE SAME PUSH A PAIRING GIVES, AND NOT A NEW BLOCK. addPairToEvent does not
  // refuse an unsigned entrant — the club owner's rule is permissive at entry and
  // strict at participation, and the hard blocks are check-in and draw
  // generation, both of which screen this pair as it now stands. Refusing a swap
  // on a signature that a plain unpair-and-re-pair would not be refused on would
  // just teach execs to take the longer route.
  //
  // The incoming member was already asked when they entered the pool; this is
  // the second nudge, and it is worth it because they have just been given a
  // team and a reason to care.
  const { unsigned, tournamentName } = await unsignedAmong(
    adminClient, event.tournament_id, [incomingPlayerId],
  );
  await notifyEventWaiverRequired(adminClient, event.tournament_id, tournamentName, unsigned);

  revalidateEventPaths(event.tournament_id, event.id);
  return { pairName };
}

export async function removePairFromEvent(pairId: string) {
  const admin = await requireCapability('tournaments.draw.pairs.remove.write');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('*, event:tournament_events(*)')
    .eq('id', pairId)
    .single();
  if (!pair) throw new Error('Pair not found');

  const event = pair.event as Record<string, unknown>;
  // THROUGH CHECK-IN, matching removeParticipantFromEvent. Half the fix is no
  // fix: singles removal was opened first and a doubles event's entries are
  // PAIRS, so the dead end survived untouched on exactly the events that had
  // the pool feature that made it easy to reach. Withdrawal still only begins
  // once a draw exists, so without this a doubles event at `checkin` has no
  // exit at all.
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new ExpectedError('Pairs can only be removed before the draw is generated.');
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');

  // FENCED — 00201, same reasoning as removeParticipantFromEvent.
  const { data: removedPair, error } = await adminClient.rpc('remove_field_entry', {
    p_entry_id: pairId,
    p_is_pair: true,
  });
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const removedPairResult = removedPair as FencedFieldResult | null;
  if (!removedPairResult?.ok) fencedRefusal(removedPairResult, 'Pair not found');

  // An external team has no fee row or member trail to show it ever existed, so its
  // removal is written down here.
  if (pair.player1_id == null) {
    await logAudit(adminClient, {
      tournament_id: event.tournament_id as string,
      event_id: pair.event_id as string,
      action: 'external_pair_removed',
      performed_by: admin.id,
      details: { pair_id: pairId, pair_name: pair.pair_name ?? null },
    });
  }

  // A place freed: the waitlist's head goes in (00278). Never throws.
  await fillFromWaitlistAfterFree(adminClient, pair.event_id as string, admin.id);

  revalidateEventPaths(event.tournament_id as string, pair.event_id as string);
}

// ============================================================
// The waitlist (00278)
// ============================================================

const WAITLIST_MIGRATION_MISSING = 'Run migration 00278 first';
const NOT_WAITING = 'That member is no longer on the waitlist. Reload the page.';

function waitlistRefusal(result: WaitlistFillResult | null): string {
  switch (result?.reason) {
    case 'event_full':
      return 'The event is full. Free a place, or raise the event limit, before promoting anybody.';
    case 'not_waiting':
      return NOT_WAITING;
    case 'event_status':
      return 'Members can only be promoted while the event is taking entries or checking in.';
    case 'draw_locked':
      return 'Draw is locked. Unlock it before making changes.';
    case 'tournament_suspended':
      return 'This tournament is suspended, so nobody can be promoted.';
    case 'tournament_closed':
      return 'This tournament has ended, so nobody can be promoted.';
    case 'external_event':
      return EXTERNAL_EVENT_REFUSAL;
    case 'player_suspended':
      return 'This member is suspended, so they cannot be entered.';
    case 'inactive':
      return 'This member is inactive, so they cannot be entered.';
    case 'already_registered':
      return 'This member already has an entry in this event. Remove them from the waitlist instead.';
    case 'already_in_pair':
      return 'This member is already in a pair in this event. Remove them from the waitlist instead.';
    case 'no_rating':
      return 'This member has no club rating yet, so they cannot be entered. Contact an exec to set one up.';
    case 'entry_cap':
      return result.cap
        ? `This member is already entered in ${result.cap} ${result.cap === 1 ? 'event' : 'events'} at this tournament, which is the limit.`
        : 'This member is already entered in as many events as this tournament allows.';
    default:
      return 'This member could not be promoted. Reload the page and try again.';
  }
}

/**
 * THE DESK PROMOTES ONE NAMED MEMBER OFF THE WAITLIST.
 *
 * The same capability as adding somebody by hand, because that is what it is:
 * an entry the desk decided on. fill_event_from_waitlist re-asks every
 * question under the field lock and writes nothing when it refuses, so the
 * member stays waiting and the desk reads why.
 */
export async function promoteFromWaitlist(waitlistId: string): Promise<ActionResult<{ promoted: number }>> {
  return runAction(() => promoteFromWaitlistImpl(waitlistId));
}

async function promoteFromWaitlistImpl(waitlistId: string): Promise<{ promoted: number }> {
  const admin = await requireCapability('tournaments.draw.participants.add.write');
  const adminClient = createAdminClient();

  const { data: row, error: rowError } = await adminClient.from('tournament_event_waitlist')
    .select('id, event_id, status, event:tournament_events(tournament_id)')
    .eq('id', waitlistId)
    .maybeSingle();
  if (rowError) {
    if (isWaitlistMissing(rowError)) throw new ExpectedError(WAITLIST_MIGRATION_MISSING);
    Sentry.captureException(rowError);
    throw new Error(rowError.message);
  }
  if (!row || row.status !== 'waiting') throw new ExpectedError(NOT_WAITING);
  const ctx = extractEventContext(row);
  if (!ctx) throw new Error('Could not read this waitlist entry. Nothing was changed, try again.');
  await assertTournamentNotSuspended(adminClient, ctx.tid);

  const { data, error } = await adminClient.rpc('fill_event_from_waitlist', {
    p_event_id: ctx.eventId,
    p_actor: admin.id,
    p_waitlist_id: waitlistId,
  });
  if (error) {
    if (isWaitlistMissing(error)) throw new ExpectedError(WAITLIST_MIGRATION_MISSING);
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as WaitlistFillResult | null;
  if (!result?.ok) throw new ExpectedError(waitlistRefusal(result));

  const promoted = await settleWaitlistPromotions(adminClient, result, admin.id, false);
  revalidateEventPaths(ctx.tid, ctx.eventId);
  return { promoted };
}

/** The desk takes a member off the waitlist. Their history row stays, as 'removed'. */
export async function removeFromWaitlist(waitlistId: string): Promise<ActionResult> {
  return runAction(() => removeFromWaitlistImpl(waitlistId));
}

async function removeFromWaitlistImpl(waitlistId: string): Promise<void> {
  const admin = await requireCapability('tournaments.draw.participants.remove.write');
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.rpc('remove_from_event_waitlist', {
    p_waitlist_id: waitlistId,
    p_actor: admin.id,
  });
  if (error) {
    if (isWaitlistMissing(error)) throw new ExpectedError(WAITLIST_MIGRATION_MISSING);
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as { ok: boolean; reason?: string; event_id?: string; tournament_id?: string; player_id?: string } | null;
  if (!result?.ok || !result.event_id || !result.tournament_id) throw new ExpectedError(NOT_WAITING);

  await logAudit(adminClient, {
    tournament_id: result.tournament_id,
    event_id: result.event_id,
    action: 'waitlist_remove',
    performed_by: admin.id,
    details: { waitlist_id: waitlistId, player_id: result.player_id ?? null },
  });

  revalidateEventPaths(result.tournament_id, result.event_id);
}

export async function checkInPair(pairId: string): Promise<ActionResult> {
  return runAction(() => checkInPairImpl(pairId));
}

async function checkInPairImpl(pairId: string) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select(`${pairContextSelect}, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)`)
    .eq('id', pairId)
    .single();

  const pairCtx = extractEventContext(pair);
  if (pairCtx) await assertTournamentNotSuspended(adminClient, pairCtx.tid);

  // BOTH HALVES, OR NEITHER. A pair with one signature is not half-eligible: the
  // unsigned partner would be on court. The refusal names only the half at
  // fault, so the exec knows whose phone to point at rather than being told the
  // team is broken.
  //
  // Unlike the singles path this cannot proceed without context, because
  // without a tournament id there is nothing to screen against — and a
  // check-in that silently skipped the gate is the one outcome that must not
  // be possible.
  if (!pairCtx) throw new Error('Could not read this pair. Nothing was changed — try again.');
  await assertEventWaiverSigned(adminClient, pairCtx.tid, {
    id: pairId,
    members: pairWaiverMembers(pair as never),
  });

  // FENCED — 00201, same reasoning as checkInParticipant.
  const { data, error } = await adminClient.rpc('set_field_entry_status', {
    p_entry_id: pairId,
    p_is_pair: true,
    p_new_status: 'checked_in',
    p_actor: admin.id,
  });

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const checkedPairResult = data as FencedFieldResult | null;
  if (!checkedPairResult?.ok) fencedRefusal(checkedPairResult, 'Pair not found');

  // Without the context there is nothing to revalidate, and since these screens
  // stopped calling router.refresh() a silent skip leaves the desk looking at a
  // board that still says the team is waiting. Say what happened and tell them
  // to reload.
  if (!checkedPairResult.tournament_id || !checkedPairResult.event_id) {
    Sentry.captureException(new Error('Tournament entry updated but its event context was unreadable — page not revalidated'));
    throw new Error('Saved, but the page could not be refreshed. Reload to see the change.');
  }
  revalidateEventPaths(checkedPairResult.tournament_id, checkedPairResult.event_id);
}

// ONE PERSON OF A DOUBLES TEAM (00309). People arrive at the door one at a
// time, so the desk marks each, and the team is checked in when the second one
// is. The waiver is asked of the person marked, not their partner: the partner
// is asked when they arrive. An external team has nobody to ask.
const PAIR_MEMBER_MIGRATION_MISSING = 'Run migration 00309 first';

type PairMemberResult = FencedFieldResult & { pair_checked_in?: boolean };

export async function checkInPairMember(pairId: string, slot: number): Promise<ActionResult<{ pairCheckedIn: boolean }>> {
  return runAction(() => setPairMemberHereImpl(pairId, slot, true));
}

export async function undoPairMemberCheckIn(pairId: string, slot: number): Promise<ActionResult<{ pairCheckedIn: boolean }>> {
  return runAction(() => setPairMemberHereImpl(pairId, slot, false));
}

async function setPairMemberHereImpl(pairId: string, slot: number, here: boolean): Promise<{ pairCheckedIn: boolean }> {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  // A client-controlled POST field, so the slot is checked here and again in the RPC.
  if (slot !== 1 && slot !== 2) throw new ExpectedError('A team has two people. Pick the first or the second.');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select(`${pairContextSelect}, player1_id, player2_id, external1_name, external2_name, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)`)
    .eq('id', pairId)
    .single();

  const pairCtx = extractEventContext(pair);
  if (!pairCtx) throw new Error('Could not read this pair. Nothing was changed. Try again.');
  await assertTournamentNotSuspended(adminClient, pairCtx.tid);

  if (here) {
    const playerId = (slot === 1 ? pair!.player1_id : pair!.player2_id) as string | null;
    if (playerId) {
      await assertEventWaiverSigned(adminClient, pairCtx.tid, {
        id: pairId,
        members: [{ id: playerId, name: pickName(slot === 1 ? pair!.player1 : pair!.player2) ?? 'This player' }],
      });
    }
  }

  const { data, error } = await adminClient.rpc('set_pair_member_check_in', {
    p_pair_id: pairId,
    p_slot: slot,
    p_here: here,
    p_actor: admin.id,
  });
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') throw new ExpectedError(PAIR_MEMBER_MIGRATION_MISSING);
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as PairMemberResult | null;
  if (!result?.ok) fencedRefusal(result, 'Pair not found');

  revalidateEventPaths(result.tournament_id ?? pairCtx.tid, result.event_id ?? pairCtx.eventId);
  return { pairCheckedIn: result.pair_checked_in === true };
}

export async function markPairNoShow(pairId: string) {
  await requireCapability('tournaments.draw.noshow.write');
  const adminClient = createAdminClient();

  // FENCED, AND GUARDED AT ALL FOR THE FIRST TIME — 00201. See
  // markParticipantNoShow for why the guard is narrow.
  const { data, error } = await adminClient.rpc('set_field_entry_status', {
    p_entry_id: pairId,
    p_is_pair: true,
    p_new_status: 'no_show',
    p_actor: null,
  });

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const pairNoShowResult = data as FencedFieldResult | null;
  if (!pairNoShowResult?.ok) fencedRefusal(pairNoShowResult, 'Pair not found');

  // Without the context there is nothing to revalidate, and since these screens
  // stopped calling router.refresh() a silent skip leaves the desk looking at a
  // board that still says the team is waiting. Say what happened and tell them
  // to reload.
  if (!pairNoShowResult.tournament_id || !pairNoShowResult.event_id) {
    Sentry.captureException(new Error('Tournament entry updated but its event context was unreadable — page not revalidated'));
    throw new Error('Saved, but the page could not be refreshed. Reload to see the change.');
  }
  revalidateEventPaths(pairNoShowResult.tournament_id, pairNoShowResult.event_id);
}

// ============================================================
// Bulk check-in
// ============================================================

// THE UNDO for a check-in or a no-show pressed on the wrong row. Both go back
// to waiting through the same fenced RPC (00271), and only while check-in is
// open: once the draw is published the field is what was drawn. A no-show
// comes back as waiting, not checked in, so the waiver check at the door still
// runs when they do turn up. Each undo asks for the capability of the press it
// reverses.
export async function undoCheckIn(entryId: string, isPair: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const admin = await requireCapability('tournaments.draw.checkin.mark.write');
    await returnEntryToWaiting(entryId, isPair, 'checked_in', admin.id);
  });
}

export async function undoNoShow(entryId: string, isPair: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const admin = await requireCapability('tournaments.draw.noshow.write');
    await returnEntryToWaiting(entryId, isPair, 'no_show', admin.id);
  });
}

async function returnEntryToWaiting(
  entryId: string,
  isPair: boolean,
  expected: 'checked_in' | 'no_show',
  actorId: string,
) {
  const adminClient = createAdminClient();
  const { data: entry } = await adminClient
    .from(isPair ? 'tournament_pairs' : 'tournament_participants')
    .select('status')
    .eq('id', entryId)
    .maybeSingle();
  if (!entry) throw new ExpectedError(isPair ? 'Pair not found' : 'Participant not found');
  // The capability asked for is the one for THIS undo, so an undo of the other
  // kind is refused here rather than let through the shared RPC.
  if (entry.status !== expected) {
    throw new ExpectedError(
      expected === 'checked_in'
        ? 'This entry is no longer checked in. Reload the page to see where it stands.'
        : 'This entry is no longer marked as a no-show. Reload the page to see where it stands.',
    );
  }

  // A checked-in pair goes back through 00309's per-person write, both people
  // at once, so the slots and the status move together. Before 00309 it takes
  // the pair-level path below.
  if (isPair && expected === 'checked_in') {
    const { data: both, error: bothError } = await adminClient.rpc('set_pair_member_check_in', {
      p_pair_id: entryId,
      p_slot: null,
      p_here: false,
      p_actor: actorId,
    });
    if (!bothError || (bothError.code !== 'PGRST202' && bothError.code !== '42883')) {
      if (bothError) {
        Sentry.captureException(bothError);
        throw new Error(bothError.message);
      }
      const bothResult = both as PairMemberResult | null;
      if (!bothResult?.ok) fencedRefusal(bothResult, 'Pair not found');
      if (!bothResult.tournament_id || !bothResult.event_id) {
        Sentry.captureException(new Error('Tournament entry updated but its event context was unreadable, page not revalidated'));
        throw new Error('Saved, but the page could not be refreshed. Reload to see the change.');
      }
      revalidateEventPaths(bothResult.tournament_id, bothResult.event_id);
      return;
    }
  }

  const { data, error } = await adminClient.rpc('set_field_entry_status', {
    p_entry_id: entryId,
    p_is_pair: isPair,
    p_new_status: 'registered',
    p_actor: actorId,
  });
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as FencedFieldResult | null;
  if (!result?.ok) fencedRefusal(result, isPair ? 'Pair not found' : 'Participant not found');

  if (!result.tournament_id || !result.event_id) {
    Sentry.captureException(new Error('Tournament entry updated but its event context was unreadable, page not revalidated'));
    throw new Error('Saved, but the page could not be refreshed. Reload to see the change.');
  }
  revalidateEventPaths(result.tournament_id, result.event_id);
}

/** What "Check In All Present" reports back when it could not take everybody. */
export interface BulkCheckInResult {
  checkedIn: number;
  /** Empty when the whole field went through. The sentence names the people. */
  skippedForWaiver: string;
}

export async function bulkCheckIn(
  eventId: string,
  type: 'participants' | 'pairs',
): Promise<ActionResult<BulkCheckInResult>> {
  return runAction(() => bulkCheckInImpl(eventId, type));
}

async function bulkCheckInImpl(
  eventId: string,
  type: 'participants' | 'pairs',
): Promise<BulkCheckInResult> {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const table = type === 'pairs' ? 'tournament_pairs' : 'tournament_participants';

  // Read the event BEFORE the update and refuse without it — same reason as
  // checkInParticipant. Checking in a whole field and leaving the board showing
  // everyone as waiting is the failure this is guarding against, and there is no
  // router.refresh() behind it any more.
  const { data: event } = await adminClient.from('tournament_events').select('tournament_id').eq('id', eventId).single();
  if (!event) throw new Error('Could not read this event. Nobody was checked in — try again.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // PARTITION, DO NOT REFUSE WHOLE. This is the button an exec presses with a
  // room full of people in front of them. Failing the whole press because one
  // entrant has not signed would hold up everybody else — the queue at the door
  // this feature exists to prevent, caused by the feature itself. So the ones
  // who may play are checked in, and the ones who may not are named.
  const { requiredHash, acceptances } = await loadTournamentWaiverContext(adminClient, event.tournament_id);

  let idsToCheckIn: string[] | null = null;
  let skippedForWaiver = '';

  if (requiredHash) {
    const { data: waiting, error: waitingError } = type === 'pairs'
      ? await adminClient.from('tournament_pairs')
        .select('id, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
        .eq('event_id', eventId).eq('status', 'registered')
      : await adminClient.from('tournament_participants')
        .select('id, player_id, player:players!player_id(full_name)')
        .eq('event_id', eventId).eq('status', 'registered');
    // A failed read here must not read as "nobody is waiting" — that would
    // check in zero people and report success — nor may it be allowed to skip
    // the gate. Refuse and say nothing happened.
    if (waitingError) {
      Sentry.captureException(waitingError);
      throw new Error('Could not check who has signed the event waiver. Nobody was checked in — try again.');
    }

    const entries = (waiting ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        members: type === 'pairs'
          ? pairWaiverMembers(r as never)
          : [{ id: r.player_id as string, name: pickName(r.player) ?? 'This player' }],
      };
    });

    const screening = screenForEventWaiver(entries, requiredHash, acceptances);
    idsToCheckIn = screening.allowed;
    skippedForWaiver = eventWaiverRefusal(screening.blocked);

    if (idsToCheckIn.length === 0) {
      // Nothing to write. Still not an error: the exec asked a reasonable
      // question and gets the reason, not a failure.
      if (skippedForWaiver) throw new ExpectedError(skippedForWaiver);
      return { checkedIn: 0, skippedForWaiver: '' };
    }
  }

  // FENCED — 00201. One statement as before, but inside the field lock.
  //
  // `status = 'registered'` HAS NOT MOVED INTO THE ID LIST, and that matters.
  // The waiver screening above runs in this process, over a list read before
  // the fence was taken, so by the time the write lands an entrant in
  // `idsToCheckIn` may have withdrawn. The RPC repeats the predicate on its own
  // side rather than trusting the list, so the worst case is that somebody is
  // silently left out of a bulk check-in — not that a withdrawal is quietly
  // overwritten with a check-in.
  //
  // A null id list means "everybody still waiting", which is the no-waiver
  // path's original whole-field update.
  const { data: bulk, error } = await adminClient.rpc('bulk_check_in_field', {
    p_event_id: eventId,
    p_is_pair: type === 'pairs',
    p_ids: idsToCheckIn,
    p_actor: admin.id,
  });

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const bulkResult = bulk as FencedFieldResult | null;
  if (!bulkResult?.ok) fencedRefusal(bulkResult, 'Event not found');

  revalidateEventPaths(event.tournament_id, eventId);
  return { checkedIn: bulkResult.checked_in ?? 0, skippedForWaiver };
}

// ============================================================
// Auto pair — the waiting list, sorted out in one press
// ============================================================

/** What Auto pair reports back. Never a bare success: see the comment below. */
export interface AutoPairResult {
  pairsMade: number;
  /** How many people are still in the pool afterwards. */
  stillWaiting: number;
  /**
   * How many pairs were REFUSED, as opposed to never attempted.
   *
   * Reported separately from `stillWaiting` because the two are different
   * facts and the caller has to tell them apart to choose a tone. An odd list
   * leaves somebody over by arithmetic — the exec was told that in the confirm
   * and agreed to it, so it is not a failure. A refused pair is something going
   * wrong. Collapsing both into "not everybody was paired" made auto-pairing
   * five people report itself in red.
   */
  refused: number;
  /**
   * Why they are still there — the odd one out, and anybody a pair was refused
   * for. Empty only when the list emptied completely.
   */
  stillWaitingReason: string;
  /**
   * Newly paired players with no current event-waiver signature.
   *
   * NOT A REFUSAL, and this is the point most likely to be got wrong by a later
   * reader. Pairing does not require a signature and never has: the gates are
   * check-in (assertEventWaiverSigned) and draw generation
   * (assertDrawFieldEventWaiverSigned), and migration 00102 writes every new
   * pair as 'registered' precisely so the team faces the waiver gate as a team.
   * Auto pair therefore pairs an unsigned entrant exactly as the manual button
   * beside it does — refusing here would make the bulk control STRICTER than
   * the single one and strand pairable people in the pool for a reason nothing
   * else in the flow cares about.
   *
   * It is still worth SAYING, because those pairs cannot be checked in and will
   * stop the draw, and the exec is standing in front of the people who need to
   * sign.
   */
  unsignedNotice: string;
}

/**
 * Pair everybody on the waiting list, strongest with weakest.
 *
 * ONE TRANSACTION PER PAIR, not one for the batch, and the result type is built
 * around that being visible. Each pair goes through addPairToEventImpl — the
 * same function the manual button calls, so there is exactly one pairing path
 * and no second copy of the entry-cap discount, the capacity arithmetic, the
 * fee rows, the audit row or the waiver notification to drift out of step. A
 * pair that fails therefore fails AFTER the earlier ones have committed, which
 * is why this reports counts and reasons rather than ok/not-ok: "3 pairs made,
 * 2 people still waiting" is the true statement, and a bare success would not
 * be.
 *
 * RE-RUNNING IS SAFE. The plan is rebuilt from the pool as it is now, so people
 * paired by the previous press are simply not in it; and if two execs press at
 * once, pair_tournament_entrants takes an advisory lock on the event and
 * refuses the second attempt on anybody already placed on a team. Nobody can be
 * double-paired by pressing this twice.
 */
export async function autoPairWaitingEntrants(eventId: string): Promise<ActionResult<AutoPairResult>> {
  return runAction(() => autoPairWaitingEntrantsImpl(eventId));
}

async function autoPairWaitingEntrantsImpl(eventId: string): Promise<AutoPairResult> {
  // THE SAME CAPABILITY MANUAL PAIRING ASKS FOR, transcribed from
  // addPairToEventImpl's own requireCapability call rather than inferred from
  // the name. Auto pair is that act in bulk and no new key was minted for it:
  // anybody who can pair two people can pair six, and nobody else can. Asked
  // here as well as inside each addPairToEventImpl so a viewer without it is
  // refused before any reads happen, not after the first pair commits.
  await requireCapability('tournaments.draw.pairs.add.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (!isDoublesEvent(event.event_type)) {
    throw new ExpectedError('Only a doubles event has a waiting list to pair.');
  }
  // The same two statuses manual pairing accepts. Check-in is exactly when the
  // club finds out who turned up without a partner, so this has to work there.
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new ExpectedError('Cannot pair in current status');
  }
  if (event.external_event === true) throw new ExpectedError(EXTERNAL_EVENT_REFUSAL);
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // competition_category joins the embed (00111). Auto pair is the one place
  // the rule cannot be a refusal: 00102 pairs people AFTER they enter, so by the
  // time this runs the pool already holds whoever entered, and the honest answer
  // to "these two may not play together" is to pair somebody else with each of
  // them — not to refuse the batch and not to form the team anyway.
  const { data: pool, error: poolError } = await adminClient
    .from('tournament_participants')
    .select('player_id, status, elo_before, player:players!player_id(full_name, competition_category, ratings(doubles_elo))')
    .eq('event_id', eventId);
  // A failed read must not read as "nobody is waiting" — that would report a
  // cheerful zero and change nothing, which is the one answer the exec cannot
  // tell apart from success.
  if (poolError) {
    Sentry.captureException(poolError);
    throw new Error('Could not read the waiting list. Nobody was paired — try again.');
  }

  // WITHDRAWN ROWS ARE NOT RAW MATERIAL. 00102 refuses them outright ("remove
  // their withdrawn entry from the waiting list first"), so including them
  // would spend a whole pair's attempt on a guaranteed refusal and drag their
  // partner down with it.
  const waiting = (pool ?? []).filter((row) => !isOutOfEvent(row.status));

  const nameOfPlayer = new Map<string, string>();
  const candidates = waiting.map((row) => {
    const embed = (Array.isArray(row.player) ? row.player[0] : row.player) as
      { full_name?: string | null; competition_category?: unknown; ratings?: unknown } | null;
    nameOfPlayer.set(row.player_id, embed?.full_name ?? 'This player');
    const ratings = Array.isArray(embed?.ratings) ? embed?.ratings[0] : embed?.ratings;
    const doublesElo = (ratings as { doubles_elo?: number | null } | null)?.doubles_elo;
    // The same fallback chain the pool's own Elo column shows, and the same 400
    // default unpair_tournament_pair stamps — so the fold sorts on the number
    // the exec is looking at.
    return {
      playerId: row.player_id,
      rating: doublesElo ?? row.elo_before ?? 400,
      category: toCompetitionCategory(embed?.competition_category),
    };
  });

  const nameOf = (id: string) => nameOfPlayer.get(id) ?? 'This player';

  // NOT AN ERROR when there is nobody to pair, and not when there is only one
  // person. The exec asked a reasonable question and gets the reason rather
  // than a failure — bulkCheckIn's rule, for the same situation.
  if (candidates.length < 2) {
    return {
      pairsMade: 0,
      stillWaiting: candidates.length,
      refused: 0,
      stillWaitingReason: candidates.length === 1
        ? `${nameOf(candidates[0]!.playerId)} is the only person waiting, so there is nobody to pair them with.`
        : 'Nobody is waiting for a partner.',
      unsignedNotice: '',
    };
  }

  // THE EVENT'S OWN RULE, HANDED TO THE PLANNER AS A PREDICATE (00111).
  // planAutoPairs knows nothing about competition categories and is not going
  // to learn: the rule is one import away, in the module that owns it, and
  // passing it in keeps the fold's arithmetic testable without one.
  //
  // Only Mixed Doubles constrains a PAIR — mens_doubles and womens_doubles
  // constrain each entrant, and those entrants were screened on the way in — so
  // every other event gets the unrestricted fold and byte-identical behaviour.
  const eventType = event.event_type as TournamentEventType;
  const plan = planAutoPairs(
    candidates,
    categoryRequiredBy(eventType) === 'mixed'
      ? { eligible: (a, b) => canPairForEvent(eventType, a.category ?? null, b.category ?? null) }
      : undefined,
  );

  let pairsMade = 0;
  let refused = 0;
  const paired: string[] = [];
  const reasons: string[] = [];
  let stillWaiting = 0;

  for (const [player1Id, player2Id] of plan.pairs) {
    try {
      // THE ONLY PAIRING PATH. Every check, fee row, audit row and notification
      // that manual pairing performs happens here too, because it is literally
      // the same function.
      await addPairToEventImpl(eventId, player1Id, player2Id);
      pairsMade += 1;
      paired.push(player1Id, player2Id);
    } catch (err) {
      // ONE PAIR'S REFUSAL IS NOT THE BATCH'S. bulkCheckIn's partition rule:
      // the ones who can be paired are, and the ones who cannot are named with
      // the reason the server gave, which is already written to be read by an
      // exec standing at a desk.
      stillWaiting += 2;
      refused += 1;
      const why = err instanceof Error ? err.message : 'the pair was refused';
      reasons.push(`${nameOf(player1Id)} and ${nameOf(player2Id)} could not be paired — ${why}`);
      if (!isExpectedFailure(err)) Sentry.captureException(err);
    }
  }

  // SAY WHO IS STILL WAITING AND WHY, always. An odd list leaves somebody
  // behind by arithmetic, and that person must not be discovered later by a
  // refused draw.
  if (plan.leftOver) {
    stillWaiting += 1;
    reasons.push(
      `${nameOf(plan.leftOver)} is still waiting — an odd number of people cannot be paired up completely.`,
    );
  }

  // The people a MIXED pool could not seat: the pairing rule allowed them no
  // partner, not the arithmetic. Empty for every other event.
  //
  // NAMED AND LEFT IN THE POOL, which is the only defensible answer of the
  // three — the same argument unpairedDrawRefusal makes about the draw. Forming
  // the pair anyway ships a team the event's own rule forbids; dropping them
  // silently hands the exec a waiting list that looks finished. So the button
  // does what it can, says who it could not place, and the exec has the two
  // remedies (find a partner from the other category, or move them to Open).
  if (plan.unpairable.length > 0) {
    stillWaiting += plan.unpairable.length;
    reasons.push(unpairableNotice(plan.unpairable.map(nameOf)));
  }

  // The waiver, reported and not enforced — see AutoPairResult.unsignedNotice.
  //
  // eventWaiverRefusal's wording was READ before being reused here, not assumed
  // from its name: it says the members "cannot be CHECKED IN until they do" and
  // tells the exec how they sign. That is exactly true of a pair auto-pairing
  // just made, so the sentence is reused rather than reworded. It does not
  // claim anybody was refused entry or refused a partner — if it ever starts
  // to, this call needs its own wording, because here nobody was refused.
  let unsignedNotice = '';
  if (paired.length > 0) {
    const { requiredHash, acceptances } = await loadTournamentWaiverContext(adminClient, event.tournament_id);
    if (requiredHash) {
      const { blocked } = screenForEventWaiver(
        paired.map((id) => ({ id, members: [{ id, name: nameOf(id) }] })),
        requiredHash,
        acceptances,
      );
      if (blocked.length > 0) unsignedNotice = eventWaiverRefusal(blocked);
    }
  }

  revalidateEventPaths(event.tournament_id, eventId);

  return { pairsMade, stillWaiting, refused, stillWaitingReason: reasons.join(' '), unsignedNotice };
}
