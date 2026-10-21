'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ExpectedError, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';

// LAST-MINUTE CHANGES AT A CLUB EVENT'S DOOR (00294): no-shows, walk-ins and
// the waitlist. Each write is one service-role RPC that locks the event row
// and refuses a cancelled event, a draft and one run as a tournament.
//
// Every exported parameter is a client-controlled POST field, so each is
// shape-checked, and the actor is always the one requireCapability resolves.
// The actor goes in audit_logs, never on a row.

type RpcResult = { ok: boolean; reason?: string; already_signed_up?: boolean; player_id?: string };

const REFUSALS: Record<string, string> = {
  not_found: 'That event no longer exists.',
  cancelled: 'This event is cancelled.',
  not_published: 'This event is a draft. Publish it first.',
  linked: 'This event runs as a tournament. Use the tournament instead.',
  not_registered: 'That person is not signed up for this event.',
  checked_in: 'They are checked in. Undo the check-in first.',
  full: 'The event is full. Mark a no-show first to free a place.',
  not_waiting: 'They are no longer on the waitlist.',
  not_eligible: 'That member cannot sign up right now (suspended, pending approval or leaving).',
  bad_name: 'Type a name, up to 120 characters.',
  bad_email: 'That email does not look right.',
  already_registered: 'Somebody with that email is already signed up for this event.',
  bad_kind: 'That person could not be found.',
};

async function call(name: string, args: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await createAdminClient().rpc(name as never, args as never);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  const result = data as unknown as RpcResult;
  if (!result.ok) throw new ExpectedError(REFUSALS[result.reason ?? ''] ?? 'That could not be done.');
  return result;
}

function revalidate(eventId: string) {
  revalidatePath(`/events/${eventId}`);
  revalidatePath(`/events/${eventId}/checkin`);
}

const uuid = z.string().uuid();
const whoSchema = z.object({ kind: z.enum(['member', 'guest']), id: uuid }).strict();

/** Mark somebody who signed up and did not come, or undo it. They keep the sign-up and its fee. */
export async function setClubEventNoShow(
  eventId: string,
  who: { kind: 'member' | 'guest'; id: string },
  noShow: boolean,
): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireCapability('events.signups.checkin.write');
    parseOrThrow(uuid, eventId);
    const target = parseOrThrow(whoSchema, who);
    const flag = parseOrThrow(z.boolean(), noShow);
    await call('club_event_set_no_show', { p_event_id: eventId, p_kind: target.kind, p_id: target.id, p_no_show: flag });
    await logAdminAudit(
      createAdminClient(),
      {
        actor_id: actor.id as string,
        action_type: flag ? 'club_event_no_show' : 'club_event_no_show_undone',
        target_type: 'club_event',
        target_id: eventId,
        new_value: target.kind === 'member' ? { player_id: target.id } : { external_signup_id: target.id },
        reason: flag ? 'Marked a no-show at a club event' : 'A club event no-show was undone',
      },
      { eventId },
    );
    revalidate(eventId);
  });
}

const walkInSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), playerId: uuid }).strict(),
  z
    .object({
      kind: z.literal('guest'),
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().max(254).optional(),
    })
    .strict(),
]);

export type WalkIn = z.infer<typeof walkInSchema>;

/**
 * Somebody who did not sign up, standing at the door: a member (no fee, over
 * capacity if need be) or a guest by name, with an email if they give one.
 * Both are checked in at once.
 */
export async function addClubEventWalkIn(eventId: string, walkIn: WalkIn): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireCapability('events.signups.checkin.write');
    parseOrThrow(uuid, eventId);
    const input = parseOrThrow(walkInSchema, walkIn);
    const result =
      input.kind === 'member'
        ? await call('club_event_walk_in_member', { p_event_id: eventId, p_player_id: input.playerId })
        : await call('club_event_walk_in_guest', {
            p_event_id: eventId,
            p_name: input.name,
            p_email: input.email || null,
          });
    await logAdminAudit(
      createAdminClient(),
      {
        actor_id: actor.id as string,
        action_type: 'club_event_walk_in',
        target_type: 'club_event',
        target_id: eventId,
        new_value:
          input.kind === 'member'
            ? { player_id: input.playerId, already_signed_up: result.already_signed_up === true }
            : { guest: true, with_email: !!input.email },
        reason: 'A walk-in was added at a club event',
      },
      { eventId },
    );
    revalidate(eventId);
  });
}

/** Give a waiting member the place. They owe the fee as for any sign-up, and are told in the app. */
export async function promoteClubEventWaiting(eventId: string, waitlistId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireCapability('events.signups.checkin.write');
    parseOrThrow(uuid, eventId);
    parseOrThrow(uuid, waitlistId);
    await assertWaitlistRowIn(eventId, waitlistId);
    const result = await call('club_event_promote_waiting', { p_waitlist_id: waitlistId, p_actor: actor.id });
    await logAdminAudit(
      createAdminClient(),
      {
        actor_id: actor.id as string,
        action_type: 'club_event_waitlist_promoted',
        target_type: 'club_event',
        target_id: eventId,
        new_value: { player_id: result.player_id ?? null, waitlist_id: waitlistId },
        reason: 'A waiting member was given a place at a club event',
      },
      { eventId },
    );
    revalidate(eventId);
  });
}

/** Take somebody off the waitlist. */
export async function removeClubEventWaiting(eventId: string, waitlistId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireCapability('events.signups.checkin.write');
    parseOrThrow(uuid, eventId);
    parseOrThrow(uuid, waitlistId);
    await assertWaitlistRowIn(eventId, waitlistId);
    await call('club_event_remove_waiting', { p_waitlist_id: waitlistId, p_actor: actor.id });
    await logAdminAudit(
      createAdminClient(),
      {
        actor_id: actor.id as string,
        action_type: 'club_event_waitlist_removed',
        target_type: 'club_event',
        target_id: eventId,
        new_value: { waitlist_id: waitlistId },
        reason: 'A member was taken off a club event waitlist',
      },
      { eventId },
    );
    revalidate(eventId);
  });
}

// The waitlist id and the event id both come from the client, so the row must
// belong to the event the audit row and the revalidation name.
async function assertWaitlistRowIn(eventId: string, waitlistId: string) {
  const { data, error } = await createAdminClient()
    .from('club_event_waitlist' as never)
    .select('event_id')
    .eq('id', waitlistId)
    .maybeSingle();
  if (error) throw new Error(`The waitlist could not be read: ${error.message}`);
  if (!data || (data as { event_id: string }).event_id !== eventId) {
    throw new ExpectedError('They are no longer on the waitlist.');
  }
}
