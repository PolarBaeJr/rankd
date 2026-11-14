'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import {
  calculateTeamRating,
  categoryRequiredBy,
  eventIsPlaying,
  eventWaiverRefusal,
  ExpectedError,
  isDoublesEvent,
  screenExecEntry,
  screenForEventWaiver,
  screenPair,
  toCompetitionCategory,
  type TournamentEventType,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { assertReleaseFlag, releaseFlagOn } from '../release-flags';
import { requireConsoleUser } from '../court-helper-gate';
import { permits } from '../permissions';
import { TOURNAMENT_MATCH_NOTES, writePrivateNote } from '../private-notes';
import { issueAttendanceWarnings } from '../attendance-warnings';
import { DEPARTURE_REASON_LABELS, departureWarns, parseDeparture, type Departure } from '../departure-reasons';
import { fillFreeCourts, type AutoCallEvent } from './auto-call';
import { assertTournamentNotSuspended, loadTournamentWaiverContext, revalidateEventPaths } from './_internal';

// SUBSTITUTIONS (00327, 00328). Somebody comes in for one member of a pair (a
// partner sub) or for a whole entry (a team sub), before or during an event.
// The entry keeps its id, so its seed, group, standing and fixtures stay; the
// database records who played every match already decided before the people
// change.
//
// WHO. The desk, holding both the check-in key and the add key for the
// discipline, because a sub is an addition made at the desk; and the
// tournament's day lead, the exec named to make the calls on the day. A court
// helper holds neither and is refused: helpers mark a player as left, the
// desk decides who replaces them.
//
// WHO COMES IN, and none of them through an entry path, because a sub reuses
// the entry and never needs a free place (00328): somebody entered here and in
// no match (a spare), a reserve still waiting (their waitlist row is resolved
// by the same transaction), an exec once no reserve waits, or a guest made by
// name with create_desk_guest. A reserve, an exec or a guest needs the solo add
// key, as Fill the empty places and Add on the spot do.
//
// NO FEE. The entry was charged to whoever entered it; the person coming in
// takes it over.
//
// LEFT, WITH A SUB (leaveAndSubstitute). One call and one transaction: the
// match they walked off is voided, the departure of each person going out is
// recorded and the sub is made, or none of it. Before 00328 these were two
// calls, and a sub dialog cancelled between them left the entry in neither
// state.

export type SubstitutionKind = 'partner' | 'team';

/** Who comes in, as the desk picked them. */
export type IncomingChoice =
  | { source: 'spare'; playerId: string }
  | { source: 'exec'; playerId: string }
  | { source: 'reserve'; waitlistId: string }
  | { source: 'guest'; name: string };

export interface SubstitutionInput {
  kind: SubstitutionKind;
  entryId: string;
  /** Paired with `incoming` by position. */
  outgoing: string[];
  incoming: IncomingChoice[];
  note?: string | null;
  /** The incoming member is restricted from entering events and an exec says go ahead. */
  overrideRestriction?: boolean;
}

export interface LeaveAndSubstituteInput extends SubstitutionInput {
  /** Why the people going out left (00324's reasons). */
  departure: Departure;
}

export interface SubstitutionResult {
  entryId: string;
  isPair: boolean;
  /** Decided matches that keep the outgoing people. */
  kept: number;
  /** Unplayed matches the incoming people take over. */
  moved: number;
  /** The match on court voided because they left; 0 for a plain sub. */
  voided: number;
  /** Members warned for leaving without telling anyone. */
  warned: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);
const uuidList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= 2 && value.every(isUuid);

const REFUSALS: Record<string, string> = {
  bad_kind: 'Choose a partner sub or a team sub.',
  bad_people: 'Pick who goes out and who comes in for each of them.',
  same_person: 'Somebody cannot come in for themselves or twice.',
  note_too_long: 'Keep the note to 500 characters.',
  bad_departure: 'Choose why they left, and say what happened for another reason.',
  event_not_found: 'That event is not there any more.',
  event_status: 'The event is not at a stage where this entry can change.',
  external: 'An external team is entered by name and cannot be subbed.',
  entry_not_found: 'That entry is not in this event.',
  entry_out: 'This entry is out of the event. Undo "Did not come" first, then sub.',
  not_in_entry: 'The person going out is not on this entry.',
  on_court: 'They are on court right now. Finish or void that match first.',
  already_in_event: 'The person coming in is already playing in this event.',
  not_entered: 'Only somebody here and not playing, a reserve, an exec or a guest can come in.',
  restricted: 'The person coming in is restricted from entering events. An exec has to confirm.',
  reserve_not_waiting: 'That reserve is no longer waiting. Reload to see the waitlist.',
  reserves_waiting: 'Call or remove the reserves first.',
  entry_cap: 'The person coming in has reached this tournament\'s limit of events.',
  player_suspended: 'The person coming in is suspended.',
  inactive: 'The person coming in is not an active member.',
};

interface Resolved {
  source: IncomingChoice['source'];
  /** Null for a guest until they are made. */
  playerId: string | null;
  waitlistId: string | null;
  guestName: string | null;
}

/** Every choice checked and turned into a person, before anything is written. */
async function resolveIncoming(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  choices: IncomingChoice[],
  canAdd: boolean,
): Promise<Resolved[]> {
  const resolved: Resolved[] = [];
  for (const raw of choices) {
    const choice = (raw ?? {}) as Partial<{ source: string; playerId: unknown; waitlistId: unknown; name: unknown }>;
    if (choice.source === 'spare') {
      if (!isUuid(choice.playerId)) throw new ExpectedError(REFUSALS.bad_people!);
      resolved.push({ source: 'spare', playerId: choice.playerId, waitlistId: null, guestName: null });
      continue;
    }
    // A reserve, an exec or a guest is somebody the desk adds: the solo add
    // key, and the switch of the screen that offered them.
    if (choice.source !== 'exec' && choice.source !== 'reserve' && choice.source !== 'guest') {
      throw new ExpectedError(REFUSALS.bad_people!);
    }
    if (!canAdd) throw new ExpectedError('Only the desk with the add key can bring in a reserve, an exec or a guest.');
    if (choice.source === 'guest') {
      await assertReleaseFlag('add_on_the_spot');
      const name = typeof choice.name === 'string' ? choice.name.trim() : '';
      if (name.length < 1 || name.length > 120) throw new ExpectedError('Type the guest\'s name, up to 120 characters.');
      resolved.push({ source: 'guest', playerId: null, waitlistId: null, guestName: name });
      continue;
    }
    await assertReleaseFlag('fill_empty_places');
    if (choice.source === 'reserve') {
      if (!isUuid(choice.waitlistId)) throw new ExpectedError(REFUSALS.bad_people!);
      const { data: row, error } = await adminClient.from('tournament_event_waitlist')
        .select('id, event_id, player_id, status')
        .eq('id', choice.waitlistId)
        .maybeSingle();
      if (error) throw new Error(`Could not read the waitlist: ${error.message}`);
      if (!row || row.event_id !== eventId || row.status !== 'waiting') throw new ExpectedError(REFUSALS.reserve_not_waiting!);
      resolved.push({ source: 'reserve', playerId: row.player_id as string, waitlistId: row.id as string, guestName: null });
      continue;
    }
    if (!isUuid(choice.playerId)) throw new ExpectedError(REFUSALS.bad_people!);
    const { data: exec, error: execError } = await adminClient.from('players')
      .select('id, is_exec')
      .eq('id', choice.playerId)
      .maybeSingle();
    if (execError) throw new Error(`Could not read the member: ${execError.message}`);
    if (!exec?.is_exec) throw new ExpectedError('Only an exec can fill a place this way.');
    resolved.push({ source: 'exec', playerId: choice.playerId, waitlistId: null, guestName: null });
  }

  // An exec only once no reserve waits, other than one coming in on this sub.
  if (resolved.some((r) => r.source === 'exec')) {
    const { data: waiting, error } = await adminClient.from('tournament_event_waitlist')
      .select('id')
      .eq('event_id', eventId)
      .eq('status', 'waiting');
    if (error && !['42P01', 'PGRST205'].includes(error.code ?? '')) throw new Error(`Could not read the waitlist: ${error.message}`);
    const taking = new Set(resolved.map((r) => r.waitlistId).filter(Boolean));
    if ((waiting ?? []).some((w) => !taking.has(w.id as string))) throw new ExpectedError(REFUSALS.reserves_waiting!);
  }
  const ids = resolved.map((r) => r.playerId).filter((id): id is string => id != null);
  if (new Set(ids).size !== ids.length) throw new ExpectedError(REFUSALS.same_person!);
  return resolved;
}

async function substituteImpl(eventId: unknown, raw: unknown, leaving: boolean): Promise<SubstitutionResult> {
  const { viewer, level, permissions } = await requireConsoleUser();
  const actorId = viewer.id as string;
  if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) throw new Error('Event not found');
  const input = (raw ?? {}) as Partial<LeaveAndSubstituteInput>;
  const adminClient = createAdminClient();

  const { data: event, error: eventError } = await adminClient.from('tournament_events')
    .select('id, tournament_id, event_type, status, format, format_config, tournament:tournaments!tournament_events_tournament_id_fkey(day_lead_player_id)')
    .eq('id', eventId)
    .maybeSingle();
  if (eventError) throw new Error(`Could not read the event: ${eventError.message}`);
  if (!event) throw new Error('Event not found');
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  const desk = permits(level, permissions, 'tournaments.draw.checkin.mark.write')
    && permits(level, permissions, doubles ? 'tournaments.draw.pairs.add.write' : 'tournaments.draw.participants.add.write');
  // A reserve, an exec or a guest: the solo add key, as Fill the empty places
  // and Add on the spot ask.
  const canAdd = permits(level, permissions, 'tournaments.draw.participants.add.write');
  if (!desk) {
    const tournament = (Array.isArray(event.tournament) ? event.tournament[0] : event.tournament) as { day_lead_player_id?: string | null } | null;
    const dayLead = viewer.is_exec === true
      && tournament?.day_lead_player_id === actorId
      && await releaseFlagOn('day_lead');
    if (!dayLead) throw new ExpectedError('Only the desk or the day lead can sub somebody in.');
  }
  // Left is the desk's "Did not come" with a reason, so its keys too.
  if (leaving && !(permits(level, permissions, 'tournaments.draw.noshow.write') && permits(level, permissions, 'tournaments.results.void.write'))) {
    throw new ExpectedError('Only the desk can mark them as left and sub somebody in.');
  }
  await assertReleaseFlag('substitutions');
  if (leaving) await assertReleaseFlag('attendance_warnings');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  let departure: Departure | null = null;
  if (leaving) {
    departure = parseDeparture(input.departure);
    if (!eventIsPlaying(event.status)) throw new ExpectedError('Start the event before marking anybody as left.');
    // Before anything is marked: a database without 00324 has nowhere to keep
    // the departure.
    const { error: probeError } = await adminClient.from('event_departures').select('id').limit(1);
    if (probeError) {
      if (['42P01', 'PGRST205'].includes(probeError.code ?? '')) throw new ExpectedError('Run migration 00324 first');
      throw new Error(`Could not read the departures: ${probeError.message}`);
    }
  }

  if (input.kind !== 'partner' && input.kind !== 'team') throw new ExpectedError(REFUSALS.bad_kind!);
  if (!isUuid(input.entryId)) throw new ExpectedError(REFUSALS.entry_not_found!);
  if (!uuidList(input.outgoing) || !Array.isArray(input.incoming) || input.incoming.length !== input.outgoing.length) {
    throw new ExpectedError(REFUSALS.bad_people!);
  }
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null;
  if (note && note.length > 500) throw new ExpectedError(REFUSALS.note_too_long!);
  // The override is an exec's decision, so nobody else can send it.
  const allowRestricted = input.overrideRestriction === true && viewer.is_exec === true;

  const incoming = await resolveIncoming(adminClient, event.id, input.incoming, canAdd);
  const knownIds = incoming.map((r) => r.playerId).filter((id): id is string => id != null);

  // THE NEW TEAM'S NAME, RATING AND CATEGORY, worked out here as swapPairMember
  // does: a sub that kept the old combined rating or name would seed and label
  // the team off somebody who is no longer on it. A guest is named as typed,
  // has no category and starts at create_guest_player's 400.
  const eventType = event.event_type as TournamentEventType;
  let pair: { player1_id: string; player2_id: string } | null = null;
  if (doubles) {
    const { data, error: pairError } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id')
      .eq('id', input.entryId)
      .eq('event_id', event.id)
      .maybeSingle();
    if (pairError) throw new Error(`Could not read the pair: ${pairError.message}`);
    if (!data?.player1_id || !data.player2_id) throw new ExpectedError(REFUSALS.entry_not_found!);
    pair = { player1_id: data.player1_id, player2_id: data.player2_id };
  }
  const lookupIds = [...new Set([...knownIds, ...(pair ? [pair.player1_id, pair.player2_id] : [])])];
  const [{ data: ratings }, { data: players }] = await Promise.all([
    adminClient.from('ratings').select('player_id, singles_elo, doubles_elo').in('player_id', lookupIds),
    adminClient.from('players').select('id, full_name, competition_category').in('id', lookupIds),
  ]);
  const playerRow = (id: string) => players?.find((p) => p.id === id) as { full_name?: string | null; competition_category?: unknown } | undefined;
  const slotKey = (at: number) => incoming[at]!.playerId ?? `guest:${at}`;
  const nameFor = (key: string) => {
    if (key.startsWith('guest:')) return incoming[Number(key.slice(6))]!.guestName ?? '';
    return playerRow(key)?.full_name ?? '';
  };
  const categoryFor = (key: string) => (key.startsWith('guest:') ? null : toCompetitionCategory(playerRow(key)?.competition_category));

  // A member of the wrong declared category is refused as addParticipantCore
  // refuses them; the mixed pair is screened as a pair below.
  if (categoryRequiredBy(eventType) !== null) {
    for (let at = 0; at < incoming.length; at++) {
      const key = slotKey(at);
      const screen = screenExecEntry(eventType, categoryFor(key), nameFor(key) || 'The person coming in');
      if (!screen.ok) throw new ExpectedError(screen.message);
    }
  }

  let pairName: string | null = null;
  let combinedElo: number | null = null;
  let eloBefore: number | null = null;
  if (pair) {
    const swap = (id: string) => {
      const at = input.outgoing!.indexOf(id);
      return at >= 0 ? slotKey(at) : id;
    };
    const next1 = swap(pair.player1_id);
    const next2 = swap(pair.player2_id);
    const eloFor = (key: string) => (key.startsWith('guest:') ? 400 : ratings?.find((r) => r.player_id === key)?.doubles_elo ?? 400);
    if (categoryRequiredBy(eventType) === 'mixed') {
      const screen = screenPair(
        eventType,
        { category: categoryFor(next1), name: nameFor(next1) || 'One player' },
        { category: categoryFor(next2), name: nameFor(next2) || 'The other player' },
      );
      if (!screen.ok) throw new ExpectedError(screen.message);
    }
    pairName = `${nameFor(next1)} / ${nameFor(next2)}`;
    combinedElo = calculateTeamRating([eloFor(next1), eloFor(next2)]);
  } else {
    const only = incoming[0]!;
    eloBefore = only.source === 'guest' ? 400 : ratings?.find((r) => r.player_id === only.playerId)?.singles_elo ?? null;
  }

  // THE EVENT WAIVER, which the entry path's check-in would have asked: the
  // sub checks them in during play, so it asks here. A guest added by name
  // has no account to sign it with.
  const { requiredHash, acceptances } = await loadTournamentWaiverContext(adminClient, event.tournament_id);
  if (requiredHash) {
    if (incoming.some((r) => r.source === 'guest')) {
      throw new ExpectedError('This tournament asks every player to sign its waiver, and a guest added by name cannot. Bring in a member instead.');
    }
    const { blocked } = screenForEventWaiver(
      [{ id: input.entryId, members: knownIds.map((id) => ({ id, name: nameFor(id) || 'The person coming in' })) }],
      requiredHash,
      acceptances,
    );
    if (blocked.length > 0) throw new ExpectedError(eventWaiverRefusal(blocked));
  }

  // THE ONE THING MADE BEFORE THE SUBSTITUTION: a guest's player record. If
  // the substitution then refuses, the record stays, in no event.
  for (const r of incoming) {
    if (r.source !== 'guest') continue;
    const { data: made, error: guestError } = await adminClient.rpc('create_desk_guest' as never, {
      p_display_name: r.guestName,
      p_actor: actorId,
    } as never);
    if ((guestError as { code?: string } | null)?.code === '23514') throw new ExpectedError(guestError!.message);
    if (guestError) throw new Error(`create_desk_guest failed: ${guestError.message}`);
    r.playerId = made as unknown as string;
  }
  const incomingIds = incoming.map((r) => r.playerId!);
  const waitlistIds = incoming.map((r) => r.waitlistId).filter((id): id is string => id != null);

  const { data, error } = await adminClient.rpc('substitute_event_entry', {
    p_event_id: event.id,
    p_entry_id: input.entryId,
    p_kind: input.kind,
    p_outgoing: input.outgoing,
    p_incoming: incomingIds,
    p_note: note as string,
    p_actor: actorId,
    p_allow_restricted: allowRestricted,
    ...(pairName != null ? { p_pair_name: pairName } : {}),
    ...(combinedElo != null ? { p_combined_elo: combinedElo } : {}),
    ...(eloBefore != null ? { p_elo_before: eloBefore } : {}),
    ...(waitlistIds.length > 0 ? { p_waitlist_ids: waitlistIds } : {}),
    ...(departure ? { p_departure_reason: departure.reason, ...(departure.note ? { p_departure_note: departure.note } : {}) } : {}),
  });
  if (error) {
    if (['PGRST202', '42883'].includes(error.code ?? '')) throw new ExpectedError('Run migration 00328 first');
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as {
    ok: boolean;
    reason?: string;
    kept?: number;
    moved?: number;
    voided?: string[];
    departures?: Array<{ player_id: string; departure_id: string }>;
  } | null;
  if (!result?.ok) {
    const reason = result?.reason ?? '';
    if (reason === 'event_not_found') throw new Error('Event not found');
    throw new ExpectedError(REFUSALS[reason] ?? 'Could not make the substitution.');
  }

  // ---- After the transaction: what voidMatchImpl does after its void, the
  // warning, and the audit. None of it throws: the sub is made. ----
  const voided = result.voided ?? [];
  let warned = 0;
  if (departure) {
    const text = `Left the event: ${DEPARTURE_REASON_LABELS[departure.reason].toLowerCase()}`;
    for (const matchId of voided) {
      const written = await writePrivateNote(adminClient, TOURNAMENT_MATCH_NOTES, matchId, text, actorId);
      if (written.error) Sentry.captureException(new Error(`Void note not recorded: ${written.error}`), { extra: { matchId } });
      await logAudit(adminClient, {
        tournament_id: event.tournament_id,
        event_id: event.id,
        match_id: matchId,
        action: 'match_voided',
        performed_by: actorId,
        details: { reason: text, note_recorded: written.recorded, reversed_elo: false, via: 'left_with_sub' },
      });
    }
    // Only the people going out, never the partner who stays.
    const warnings = departureWarns(departure.reason)
      ? await issueAttendanceWarnings(adminClient, {
        playerIds: input.outgoing,
        tournamentId: event.tournament_id,
        eventId: event.id,
        kind: 'left_without_notice',
        source: 'desk',
        note: departure.note,
        actorId,
      })
      : [];
    warned = warnings.length;
    for (const w of warnings) {
      const row = (result.departures ?? []).find((d) => d.player_id === w.playerId);
      if (!row) continue;
      const { error: linkError } = await adminClient.from('event_departures').update({ warning_id: w.warningId }).eq('id', row.departure_id);
      if (linkError) Sentry.captureException(new Error(`Departure warning link failed: ${linkError.message}`), { extra: { eventId: event.id } });
    }
    await logAudit(adminClient, {
      tournament_id: event.tournament_id,
      event_id: event.id,
      action: 'player_left_event',
      performed_by: actorId,
      details: {
        entry_id: input.entryId,
        player_ids: input.outgoing,
        reason: departure.reason,
        marked_as: 'desk',
        warned,
        subbed: true,
      },
    });
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'event_substitution_made',
    performed_by: actorId,
    details: {
      kind: input.kind,
      entry_id: input.entryId,
      outgoing_player_ids: input.outgoing,
      incoming_player_ids: incomingIds,
      incoming_sources: incoming.map((r) => r.source),
      guest_made: incoming.some((r) => r.source === 'guest'),
      reserves_resolved: waitlistIds,
      fee_charged: false,
      kept: result.kept ?? 0,
      moved: result.moved ?? 0,
      voided: voided.length,
      by: desk ? 'desk' : 'day_lead',
      restriction_overridden: allowRestricted,
    },
  });

  // The court they walked off is free, and the incoming person is in the
  // entry now, so the next call may well be theirs. As voidMatchImpl: kill
  // switch desk_helper_void off, the court is freed and nothing more.
  if (voided.length > 0 && event.format === 'staged' && await releaseFlagOn('desk_helper_void')) {
    try {
      await fillFreeCourts(adminClient, { event: event as unknown as AutoCallEvent, actorId, trigger: 'void' });
    } catch (err) {
      Sentry.captureException(err);
    }
  }

  revalidateEventPaths(event.tournament_id, event.id);
  if (departure) revalidatePath('/my-courts');
  return {
    entryId: input.entryId,
    isPair: doubles,
    kept: result.kept ?? 0,
    moved: result.moved ?? 0,
    voided: voided.length,
    warned,
  };
}

export async function substituteEntry(eventId: string, input: SubstitutionInput): Promise<ActionResult<SubstitutionResult>> {
  return runAction(() => substituteImpl(eventId, input, false));
}

/**
 * LEFT, WITH A SUB: the desk marks the people going out as left, for the
 * reason chosen, and puts somebody in, in one transaction. Nothing is written
 * until the sub is confirmed, and a refusal writes nothing at all.
 */
export async function leaveAndSubstitute(eventId: string, input: LeaveAndSubstituteInput): Promise<ActionResult<SubstitutionResult>> {
  return runAction(() => substituteImpl(eventId, input, true));
}
