// THE ENTRY CORE: adding an entry to a tournament event and checking one in,
// shared by the ordinary console actions (participants.ts) and the desk's
// Add on the spot (on-the-spot.ts). NOT a 'use server' module, so nothing here
// is callable from a browser and the flags below are never a POST field: the
// ordinary actions always pass ORDINARY_ENTRY.

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { lateEntryWindow } from '../stage-controls';
import {
  calculateTeamRating,
  ensureEntryFees,
  isDoublesEvent,
  loadTournamentEntryCounts,
  isAtEntryCap,
  entryCapRefusal,
  doublesDrawSlots,
  countDoublesField,
  wouldExceedCapacity,
  screenExecEntry,
  screenPair,
  categoryRequiredBy,
  toCompetitionCategory,
  parseFormatConfig,
  suggestCategory,
  categoryForEventType,
  pickCategory,
  ExpectedError,
  selectInChunks,
  type CompetitionCategory,
  type TournamentEventType,
} from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  extractEventContext,
  participantContextSelect,
  pairContextSelect,
  assertTournamentNotSuspended,
  assertEventWaiverSigned,
  pairWaiverMembers,
  unsignedAmong,
  notifyEventWaiverRequired,
  fencedRefusal,
  type FencedFieldResult,
} from './_internal';

// An external event (00269) holds only teams entered by name. The DB triggers refuse
// every member entry path too; these refusals only make the message readable.
export const EXTERNAL_EVENT_REFUSAL = 'This is an external event: add teams by name with Add external team.';
export const EXTERNAL_PAIR_SPLIT_REFUSAL = 'An external team cannot be split or changed. Remove it, or withdraw it once the draw exists.';

// THE LATE-ENTRY WINDOW (00308). A staged event whose first stage is drawn
// groups still takes an entry until a later stage is drawn; the console then
// places it in a group (placeLateEntrant). Read only when the status alone
// would refuse, so registration and check-in pay nothing for it. The entry
// functions ask staged_late_entry_open again under the field lock.
export async function lateEntryOpen(
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
export const LATE_SOLO_REFUSAL = 'The draw has been made, so add a late entry as a pair.';

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
export interface FieldFenceRefusal {
  ok: false;
  reason?: string;
  cap?: number;
  player_id?: string;
  status?: string;
  suspension_reason?: string;
}
export type FieldFenceResult =
  | { ok: true; participants: Array<Record<string, unknown>> }
  | FieldFenceRefusal;

export function fenceRefusal(result: FieldFenceRefusal | null | undefined): string {
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
export function pickName(embed: unknown): string | null {
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
export async function loadEntryCapState(
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
export async function loadCompetitionCategories(
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
export async function nameOf(
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
export async function loadDoublesField(
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
export async function playersAlreadyPaired(
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
export async function playersAlreadyUnpaired(
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

export const ALREADY_PAIRED_REFUSAL =
  'is already in a pair in this event. Unpair that team first if they need a different partner.';

/** What only Add on the spot may change about an entry. */
export interface EntryCoreFlags {
  /** A single may enter a drawn doubles event, to be paired later. */
  lateSolo: boolean;
  /** Create the tournament entry fee (ensureEntryFees). */
  chargeFee: boolean;
}

export const ORDINARY_ENTRY: EntryCoreFlags = { lateSolo: false, chargeFee: true };

export async function addParticipantCore(
  eventId: string,
  playerId: string,
  opts?: EntryCategoryOptions,
  flags: EntryCoreFlags = ORDINARY_ENTRY,
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
  if (late && doubles && !flags.lateSolo) throw new ExpectedError(LATE_SOLO_REFUSAL);
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
  if (flags.chargeFee) await ensureEntryFees(adminClient, event.tournament_id, [playerId]);

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

export async function checkInParticipantCore(participantId: string) {
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

export async function addPairCore(
  eventId: string,
  player1Id: string,
  player2Id: string,
  opts?: EntryCategoryOptions,
  flags: EntryCoreFlags = ORDINARY_ENTRY,
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
  if (flags.chargeFee) await ensureEntryFees(adminClient, event.tournament_id, [player1Id, player2Id]);

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

export async function checkInPairCore(pairId: string) {
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
