'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { ExpectedError, isPlausibleReference, isUuid, normaliseReference } from '@badminton/shared';
import { checkSubmission } from '@badminton/shared/src/utils/receipt-check';
import { createServerSupabaseClient, createServiceRoleClient } from './supabase-server';
import { requirePlayer, assertCurrentWaiver, runAction, type ActionResult } from './actions/_shared';
import { fileFeeSubmission } from './fee-submission-core';
import { getMembershipPayments } from './club-socials';
import { serverReceiptOcr } from './receipt-ocr-server';
import { assertFeatureOn } from './feature-gate';
import { loadOwnImportEntry, settleImportEntry, settleRefusal } from './registration-import';

// SIGNING UP FOR A CLUB EVENT (00244). The event id is the only parameter: the
// member is always the one requirePlayer() resolves, never a POST field. Both
// RPCs are service-role only and lock the event row, so the capacity check and
// the insert cannot race another sign-up.

type RpcResult = { ok: boolean; reason?: string };

const REFUSALS: Record<string, string> = {
  not_found: 'That event no longer exists.',
  not_published: 'That event is not open to members yet.',
  cancelled: 'That event has been cancelled.',
  started: 'That event has already started.',
  not_open_yet: 'Sign-ups for that event are not open yet.',
  closed: 'Sign-ups for that event have closed.',
  full: 'That event is full.',
  already_registered: 'You are already signed up for that event.',
  not_eligible: 'Your account cannot sign up for club events right now.',
  not_registered: 'You are not signed up for that event.',
  // The waitlist (00294).
  waitlist_queue: 'Members on the waitlist are ahead of you. Join the waitlist to be next.',
  linked: 'That event runs as a tournament, so it has no waitlist.',
  ended: 'That event is over.',
  no_capacity: 'That event has no limit on places, so there is no waitlist.',
  already_waiting: 'You are already on the waitlist.',
  not_waiting: 'You are not on the waitlist.',
  not_full: 'A place is free. Sign up instead.',
};

// A PAID EVENT TAKES THE E-TRANSFER SCREENSHOT WITH THE SIGN-UP (owner,
// 2026-10-29): the button opens the receipt form, and signUpWithReceipt signs
// the member up and files it together, or neither. A member the fee trigger
// would charge cannot sign up without one. The Form asks for its own
// screenshot, a Form entry confirmed in the app (below) has one, and an exec
// adding somebody by hand is taking cash, so none of those come through here.
const RECEIPT_NEEDED = 'This event has a fee. Send your e-transfer screenshot to sign up.';

export async function signUpForClubEvent(eventId: string): Promise<ActionResult> {
  return runAction(async () => {
    if (!isUuid(eventId)) throw new ExpectedError('That event could not be found.');
    const player = await requirePlayer();
    if (await needsReceipt(createServiceRoleClient(), eventId, player)) throw new ExpectedError(RECEIPT_NEEDED);
    await signUpImpl(eventId);
  });
}

export interface SignUpReceipt {
  reference: string;
  screenshotPath: string;
}

/**
 * Sign up for a paid event with the e-transfer screenshot the browser already
 * uploaded under the member's own folder. EVERY FIELD IS A CLIENT-CONTROLLED
 * POST FIELD: only the event, the reference and the path are read, and the
 * path must sit in the caller's folder. When the receipt cannot be filed the
 * sign-up is withdrawn again (the withdraw trigger drops the unpaid fee).
 */
export async function signUpWithReceipt(eventId: string, receipt: SignUpReceipt): Promise<ActionResult> {
  return runAction(() => signUpWithReceiptImpl(eventId, receipt));
}

async function signUpWithReceiptImpl(eventId: string, receipt: SignUpReceipt): Promise<void> {
  // The path first, before anything is removed: a crafted one may name
  // somebody else's object.
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new ExpectedError('Not authenticated');
  const path = typeof receipt?.screenshotPath === 'string' ? receipt.screenshotPath : '';
  if (!path.startsWith(`${user.id}/`) || path.includes('..')) {
    throw new ExpectedError('That screenshot could not be attached');
  }
  const service = createServiceRoleClient();
  const removeUpload = async () => {
    const { error } = await service.storage.from('fee-proofs').remove([path]);
    if (error) console.error('[events] could not remove an orphaned receipt upload:', error.message);
  };

  try {
    if (!isUuid(eventId)) throw new ExpectedError('That event could not be found.');
    const reference = normaliseReference(typeof receipt?.reference === 'string' ? receipt.reference : '');
    if (!isPlausibleReference(reference, 'e_transfer')) {
      throw new ExpectedError(
        'The reference is 6 to 32 letters, digits or hyphens, with no spaces, or the number exactly as your bank shows it',
      );
    }
    if (!(await getMembershipPayments()).etransferEmail) throw new ExpectedError('Ask an exec how to pay for this event.');
    await signUpImpl(eventId);
  } catch (err) {
    await removeUpload();
    throw err;
  }

  const player = await requirePlayer();
  let fee: EventFee | null = null;
  let readFailed = false;
  try {
    fee = await eventFee(service, eventId, player.id);
  } catch (err) {
    Sentry.captureException(err, { tags: { action: 'signUpWithReceipt' } });
    readFailed = true;
  }
  // No fee (an exec or a fee-exempt member), or one already paid or with a
  // receipt from before they withdrew: signed up, nothing more to file.
  if (!readFailed && (!fee || fee.covered)) {
    await removeUpload();
    return;
  }

  let submissionId: string;
  try {
    if (!fee) throw new ExpectedError('That did not go through. Please try again shortly.');
    submissionId = await fileFeeSubmission(service, player, {
      feeId: fee.id,
      duesSeasonId: null,
      reference: receipt.reference,
      screenshotPath: path,
    });
  } catch (err) {
    // Neither, then: off the list again, and the upload gone.
    const { error: undoError } = await service.rpc('club_event_withdraw', {
      p_event_id: eventId,
      p_player_id: player.id,
    });
    if (undoError) Sentry.captureException(undoError, { tags: { action: 'signUpWithReceipt.undo' } });
    await removeUpload();
    revalidateClubEventPaths(eventId);
    throw err;
  }
  after(async () => {
    try {
      await checkSubmission(createServiceRoleClient(), submissionId, serverReceiptOcr);
    } catch (err) {
      console.error('[events] the receipt check failed:', err instanceof Error ? err.message : typeof err);
    }
  });
  revalidatePath('/membership');
}

type ServiceClient = ReturnType<typeof createServiceRoleClient>;
type Chargeable = { id: string; is_exec?: boolean | null; fee_exempt?: boolean | null };
type EventFee = { id: string; covered: boolean };

/**
 * Whether signing up needs a receipt: club_event_signup_fee would charge this
 * member, and no fee of theirs for it is paid or holds a receipt already (a
 * withdraw keeps such a fee, so they may be signing up again).
 */
async function needsReceipt(service: ServiceClient, eventId: string, player: Chargeable): Promise<boolean> {
  if (player.is_exec || player.fee_exempt) return false;
  const { data, error } = await service.from('club_events').select('cost_cents').eq('id', eventId).maybeSingle();
  if (error) throw new Error(`Could not read the event: ${error.message}`);
  if (((data as { cost_cents: number | null } | null)?.cost_cents ?? 0) <= 0) return false;
  return !(await eventFee(service, eventId, player.id))?.covered;
}

/** The member's fee for this event, and whether it is paid or has a receipt waiting or confirmed. */
async function eventFee(service: ServiceClient, eventId: string, playerId: string): Promise<EventFee | null> {
  const { data, error } = await service
    .from('club_fees')
    .select('id, paid_at, fee_submissions!fee_submissions_club_fee_fkey(status)')
    .eq('fee_type', 'event')
    .eq('club_event_id', eventId)
    .eq('player_id', playerId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the event fee: ${error.message}`);
  if (!data) return null;
  const row = data as { id: string; paid_at: string | null; fee_submissions: { status: string }[] | null };
  const receipted = (row.fee_submissions ?? []).some((s) => s.status === 'submitted' || s.status === 'confirmed');
  return { id: row.id, covered: row.paid_at !== null || receipted };
}

async function signUpImpl(eventId: string): Promise<void> {
  if (!isUuid(eventId)) throw new ExpectedError('That event could not be found.');
  const player = await requirePlayer();
  await assertFeatureOn('events', player);
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  const { data, error } = await service.rpc('club_event_sign_up', {
    p_event_id: eventId,
    p_player_id: player.id,
  });
  settle('signUpForClubEvent', data, error);
  revalidateClubEventPaths(eventId);
}

/**
 * Confirm a club event sign-up a Google Form response asked for (00283). The
 * entry id is checked against the signed-in member, and the sign-up itself is
 * signUpImpl, the member's own path, so the fee trigger and every gate apply.
 */
export async function confirmImportedClubEventEntry(entryId: string): Promise<ActionResult> {
  return runAction(() => confirmImportedClubEventEntryImpl(entryId));
}

async function confirmImportedClubEventEntryImpl(entryId: string): Promise<void> {
  if (!isUuid(entryId)) throw new ExpectedError('That entry could not be found.');
  const player = await requirePlayer();
  const service = createServiceRoleClient();
  const entry = await loadOwnImportEntry(service, entryId, player.id);
  if (!entry.club_event_id) throw new ExpectedError('That entry could not be found.');
  if (entry.status !== 'awaiting_member') throw new ExpectedError('This entry is no longer waiting for you.');

  let settled = await settleImportEntry(service, entryId, player.id);
  if (!settled.ok && settled.reason === 'not_entered') {
    await signUpImpl(entry.club_event_id);
    settled = await settleImportEntry(service, entryId, player.id);
  }
  if (!settled.ok) throw new ExpectedError(settleRefusal(settled));
}

export async function withdrawFromClubEvent(eventId: string): Promise<ActionResult> {
  return runAction(() => withdrawImpl(eventId));
}

async function withdrawImpl(eventId: string): Promise<void> {
  if (!isUuid(eventId)) throw new ExpectedError('That event could not be found.');
  const player = await requirePlayer();
  await assertFeatureOn('events', player);
  const service = createServiceRoleClient();

  const { data, error } = await service.rpc('club_event_withdraw', {
    p_event_id: eventId,
    p_player_id: player.id,
  });
  settle('withdrawFromClubEvent', data, error);
  revalidateClubEventPaths(eventId);
}

/**
 * The waitlist for a full club event (00294). Nobody is moved off it
 * automatically: a freed place is offered in the app, and the member signs
 * up, or an exec gives them the place at the door.
 */
export async function joinClubEventWaitlist(eventId: string): Promise<ActionResult> {
  return runAction(() => waitlistImpl(eventId, true));
}

export async function leaveClubEventWaitlist(eventId: string): Promise<ActionResult> {
  return runAction(() => waitlistImpl(eventId, false));
}

async function waitlistImpl(eventId: string, join: boolean): Promise<void> {
  if (!isUuid(eventId)) throw new ExpectedError('That event could not be found.');
  const player = await requirePlayer();
  await assertFeatureOn('events', player);
  const service = createServiceRoleClient();
  if (join) await assertCurrentWaiver(service, player);

  const { data, error } = await service.rpc(
    (join ? 'club_event_join_waitlist' : 'club_event_leave_waitlist') as never,
    { p_event_id: eventId, p_player_id: player.id } as never,
  );
  settle(join ? 'joinClubEventWaitlist' : 'leaveClubEventWaitlist', data, error);
  revalidateClubEventPaths(eventId);
}

function settle(action: string, data: unknown, error: unknown): void {
  // 23514 from 00292: the event runs as a tournament whose draw is already
  // made, so nobody joins or leaves from the event page any more.
  if ((error as { code?: string } | null)?.code === '23514') {
    throw new ExpectedError(
      'This event\'s tournament draw is already made, so sign-ups can no longer change here. Ask an exec.',
    );
  }
  if (error) {
    Sentry.captureException(error, { tags: { action } });
    throw new ExpectedError('That did not go through. Please try again shortly.');
  }
  const result = data as RpcResult | null;
  if (result?.ok) return;
  const reason = result?.reason ?? '';
  throw new ExpectedError(REFUSALS[reason] ?? 'That did not go through. Please try again shortly.');
}

function revalidateClubEventPaths(eventId: string) {
  revalidatePath('/events');
  revalidatePath(`/events/${eventId}`);
  // The schedule on /feed shows "Going" beside the event.
  revalidatePath('/feed');
}
