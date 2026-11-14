'use server';

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { ExpectedError, parseOrThrow, type TournamentEventType } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { assertReleaseFlag, releaseFlagOn } from '../release-flags';
import {
  assertTournamentNotSuspended,
  isWaitlistMissing,
  requireCapability,
  revalidateEventPaths,
  settleWaitlistPromotions,
  type WaitlistFillResult,
} from './_internal';
import { checkInPairCore, checkInParticipantCore } from './entry-core';
import { checkInPairMember } from './participants';

// THE EVENT STANDARD AT THE DESK (00324 to 00326, 00330): the desk confirming a
// place for a member, the fill after check-in closes, and a late arrival whose
// place it released. A member who left part way through is recordPlayerLeft
// in ./results.ts, beside "Did not come", because it voids through the same
// machinery. Each sits behind its own kill switch, asked after the capability
// so a member without the capability never learns which switches exist.

const uuid = z.string().uuid();

async function readEvent(adminClient: ReturnType<typeof createAdminClient>, eventId: unknown) {
  const id = parseOrThrow(uuid, eventId);
  const { data: event, error } = await adminClient.from('tournament_events')
    .select('id, tournament_id, event_type, status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the event: ${error.message}`);
  if (!event) throw new Error('Event not found');
  return event as { id: string; tournament_id: string; event_type: TournamentEventType; status: string };
}

// ---------------------------------------------------------------------------
// The desk confirms a member's place
// ---------------------------------------------------------------------------

async function confirmEntryForMemberImpl(eventId: unknown, playerId: unknown): Promise<void> {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  await assertReleaseFlag('entry_confirmation');
  const adminClient = createAdminClient();
  const event = await readEvent(adminClient, eventId);
  const player = parseOrThrow(uuid, playerId);

  const { data, error } = await adminClient.rpc('confirm_event_entry', {
    p_event_id: event.id,
    p_player_id: player,
    p_actor: admin.id,
  });
  if (error) {
    if (['PGRST202', '42883'].includes(error.code ?? '')) throw new ExpectedError('Run migration 00325 first');
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as { ok: boolean; reason?: string; already?: boolean } | null;
  if (!result?.ok) {
    if (result?.reason === 'released') {
      throw new ExpectedError('Their place was already released. Add them on the spot if they are here.');
    }
    throw new ExpectedError('This member was not asked to confirm in this event.');
  }
  if (!result.already) {
    await logAudit(adminClient, {
      tournament_id: event.tournament_id,
      event_id: event.id,
      action: 'event_entry_confirmed_by_desk',
      performed_by: admin.id,
      details: { player_id: player },
    });
  }
  revalidateEventPaths(event.tournament_id, event.id);
}

export async function confirmEntryForMember(eventId: string, playerId: string): Promise<ActionResult> {
  return runAction(() => confirmEntryForMemberImpl(eventId, playerId));
}

// ---------------------------------------------------------------------------
// Fill the empty places: release, then the reserves, then the execs
// ---------------------------------------------------------------------------

export interface ReleaseNoShowsResult {
  released: number;
  warned: number;
  /** Free places by the slot rule, or null for an event with no cap. */
  openSlots: number | null;
}

async function releaseCheckinNoShowsImpl(eventId: unknown): Promise<ReleaseNoShowsResult> {
  const admin = await requireCapability('tournaments.draw.noshow.write');
  await assertReleaseFlag('fill_empty_places');
  const adminClient = createAdminClient();
  const event = await readEvent(adminClient, eventId);
  await assertTournamentNotSuspended(adminClient, event.tournament_id);
  const warn = await releaseFlagOn('attendance_warnings');

  const { data, error } = await adminClient.rpc('release_checkin_no_shows', {
    p_event_id: event.id,
    p_actor: admin.id,
    p_warn: warn,
  });
  if (error) {
    if (['PGRST202', '42883'].includes(error.code ?? '')) throw new ExpectedError('Run migration 00326 first');
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as {
    ok: boolean;
    reason?: string;
    released?: Array<{ entry_id: string; is_pair: boolean; player_ids: string[]; warned: string[] }>;
    open_slots?: number | null;
  } | null;
  if (!result?.ok) {
    throw new ExpectedError(
      result?.reason === 'event_status'
        ? 'Places can only be released during check-in, before the draw.'
        : 'Event not found',
    );
  }
  const released = result.released ?? [];
  const warnedIds = released.flatMap((entry) => entry.warned ?? []);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'checkin_no_shows_released',
    performed_by: admin.id,
    details: { entry_ids: released.map((entry) => entry.entry_id), warned: warn },
  });
  if (warnedIds.length > 0) {
    await logAudit(adminClient, {
      tournament_id: event.tournament_id,
      event_id: event.id,
      action: 'attendance_warning_issued',
      performed_by: admin.id,
      details: { player_ids: warnedIds, kind: 'no_show', source: 'checkin_close' },
    });
  }
  revalidateEventPaths(event.tournament_id, event.id);
  return { released: released.length, warned: warnedIds.length, openSlots: result.open_slots ?? null };
}

export async function releaseCheckinNoShows(eventId: string): Promise<ActionResult<ReleaseNoShowsResult>> {
  return runAction(() => releaseCheckinNoShowsImpl(eventId));
}

export interface ReserveEntryResult {
  checkedIn: boolean;
  /** Why the check-in did not happen, in the desk's words; null when it did. */
  checkInRefusal: string | null;
}

// The desk calls a reserve by name and they are standing there: entered off
// the waitlist and checked in, in two steps. A refused check-in (an unsigned
// waiver, say) leaves them entered, and the desk is told why.
async function enterReserveAndCheckInImpl(eventId: unknown, waitlistId: unknown): Promise<ReserveEntryResult> {
  const admin = await requireCapability('tournaments.draw.participants.add.write');
  await assertReleaseFlag('fill_empty_places');
  const adminClient = createAdminClient();
  const event = await readEvent(adminClient, eventId);
  const waitlist = parseOrThrow(uuid, waitlistId);
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const { data, error } = await adminClient.rpc('fill_event_from_waitlist', {
    p_event_id: event.id,
    p_actor: admin.id,
    p_waitlist_id: waitlist,
  });
  if (error) {
    if (isWaitlistMissing(error)) throw new ExpectedError('Run migration 00278 first');
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as WaitlistFillResult | null;
  const promoted = result?.ok ? (result.promoted ?? []).find((p) => p.waitlist_id === waitlist) : undefined;
  if (!promoted) {
    const reason = result?.reason ?? result?.skipped?.find((s) => s.waitlist_id === waitlist)?.reason;
    throw new ExpectedError(
      reason === 'event_full'
        ? 'There is no free place in this event. Release the no-shows first.'
        : reason
          ? `This reserve could not be entered (${reason.replace(/_/g, ' ')}).`
          : 'This reserve could not be entered. Reload the page to see where they stand.',
    );
  }
  await settleWaitlistPromotions(adminClient, result, admin.id, false);

  let checkInRefusal: string | null = null;
  try {
    await checkInParticipantCore(promoted.participant_id);
  } catch (err) {
    if (!(err instanceof ExpectedError)) throw err;
    checkInRefusal = err.message;
  }
  revalidateEventPaths(event.tournament_id, event.id);
  return { checkedIn: checkInRefusal === null, checkInRefusal };
}

export async function enterReserveAndCheckIn(eventId: string, waitlistId: string): Promise<ActionResult<ReserveEntryResult>> {
  return runAction(() => enterReserveAndCheckInImpl(eventId, waitlistId));
}

// ---------------------------------------------------------------------------
// A late arrival whose place was released (00330)
// ---------------------------------------------------------------------------

const DRAWN = 'The draw is made. Use a substitution or Add on the spot.';

function lateArrivalRefusal(reason: string | undefined): string {
  switch (reason) {
    case 'drawn': return DRAWN;
    case 'event_status': return 'A released place can only come back during check-in, before the draw.';
    case 'entry_status': return 'This entry is not withdrawn. Reload the page to see where it stands.';
    case 'not_released': return 'This entry withdrew itself; it was not released at check-in close. Add them on the spot instead.';
    case 'no_members': return 'An external team has nobody to put on the reserves.';
    case 'already_waiting': return 'They are already on the reserves.';
    case 'club_event_linked': return 'This event\'s reserves are its club event\'s queue. Add them to that queue instead.';
    case 'entry_not_found': return 'Entry not found';
    default: return 'This entry could not be brought back. Reload the page and try again.';
  }
}

async function lateArrivalRpc(fn: 'reinstate_released_entry' | 'requeue_released_entry', args: Record<string, unknown>) {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc(fn, args);
  if (error) {
    if (['PGRST202', '42883'].includes(error.code ?? '')) throw new ExpectedError('Run migration 00330 first');
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  return data as { ok: boolean; reason?: string; player_ids?: string[] } | null;
}

export interface LateArrivalResult {
  /** The place went to somebody else; the desk can put them on the reserves. */
  placeTaken: boolean;
  checkedIn: boolean;
  /** Why the check-in did not happen, in the desk's words; null when it did. */
  checkInRefusal: string | null;
}

// Back to 'registered', then the desk's normal check-in, so the waiver gate
// still applies. For a pair, the slot names which of the two is at the desk;
// none checks in the team as a whole.
async function reinstateLateArrivalImpl(eventId: unknown, entryId: unknown, isPair: unknown, slot: unknown): Promise<LateArrivalResult> {
  const admin = await requireCapability('tournaments.draw.noshow.write');
  await assertReleaseFlag('late_arrival_reinstate');
  const adminClient = createAdminClient();
  const event = await readEvent(adminClient, eventId);
  const entry = parseOrThrow(uuid, entryId);
  const pair = parseOrThrow(z.boolean(), isPair);
  const member = parseOrThrow(z.union([z.literal(1), z.literal(2)]).nullable(), slot ?? null);
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const result = await lateArrivalRpc('reinstate_released_entry', { p_entry_id: entry, p_is_pair: pair, p_actor: admin.id });
  if (!result?.ok) {
    if (result?.reason === 'place_taken') return { placeTaken: true, checkedIn: false, checkInRefusal: null };
    throw new ExpectedError(lateArrivalRefusal(result?.reason));
  }

  let checkInRefusal: string | null = null;
  try {
    if (!pair) {
      await checkInParticipantCore(entry);
    } else if (member === null) {
      await checkInPairCore(entry);
    } else {
      const marked = await checkInPairMember(entry, member);
      if (!marked.ok) checkInRefusal = marked.error;
    }
  } catch (err) {
    if (!(err instanceof ExpectedError)) throw err;
    checkInRefusal = err.message;
  }
  revalidateEventPaths(event.tournament_id, event.id);
  return { placeTaken: false, checkedIn: checkInRefusal === null, checkInRefusal };
}

export async function reinstateLateArrival(
  eventId: string,
  entryId: string,
  isPair: boolean,
  slot: 1 | 2 | null = null,
): Promise<ActionResult<LateArrivalResult>> {
  return runAction(() => reinstateLateArrivalImpl(eventId, entryId, isPair, slot));
}

// The place has gone: the entry is removed and its members wait again, at the
// back. The head of the queue is the desk overriding the order, so it has to
// be said twice. The late warning stays.
async function returnLateArrivalToReservesImpl(eventId: unknown, entryId: unknown, isPair: unknown, atHead: unknown, confirm: unknown): Promise<void> {
  const admin = await requireCapability('tournaments.draw.noshow.write');
  await assertReleaseFlag('late_arrival_reinstate');
  const adminClient = createAdminClient();
  const event = await readEvent(adminClient, eventId);
  const entry = parseOrThrow(uuid, entryId);
  const pair = parseOrThrow(z.boolean(), isPair);
  const head = parseOrThrow(z.boolean(), atHead);
  if (head && confirm !== true) {
    throw new ExpectedError('Putting them ahead of the reserves already waiting needs confirming.');
  }
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const result = await lateArrivalRpc('requeue_released_entry', { p_entry_id: entry, p_is_pair: pair, p_actor: admin.id, p_head: head });
  if (!result?.ok) throw new ExpectedError(lateArrivalRefusal(result?.reason));
  revalidateEventPaths(event.tournament_id, event.id);
}

export async function returnLateArrivalToReserves(
  eventId: string,
  entryId: string,
  isPair: boolean,
  atHead: boolean,
  confirm = false,
): Promise<ActionResult> {
  return runAction(() => returnLateArrivalToReservesImpl(eventId, entryId, isPair, atHead, confirm));
}
