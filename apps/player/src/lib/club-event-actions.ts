'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { ExpectedError, isUuid } from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';
import { requirePlayer, assertCurrentWaiver, runAction, type ActionResult } from './actions/_shared';
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
};

export async function signUpForClubEvent(eventId: string): Promise<ActionResult> {
  return runAction(() => signUpImpl(eventId));
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

function settle(action: string, data: unknown, error: unknown): void {
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
