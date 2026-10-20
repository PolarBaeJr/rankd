'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  ExpectedError,
  clubEventSchema,
  clubWallClockToUtc,
  parseOrThrow,
  type ClubEventInput,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { notifyPlayers } from '../notify';
import { runAction, type ActionResult } from '../action-result';

// CLUB EVENTS THAT ARE NOT TOURNAMENTS (00244): the console's writes.
//
// EVERY EXPORTED PARAMETER BELOW IS A CLIENT-CONTROLLED POST FIELD. So every id
// is shape-checked, the event body goes through clubEventSchema (which is
// strict, so a stray created_by or status is refused), created_by is always
// the actor resolved by requireCapability, and there is no free status field:
// draft and published are a `publish` boolean, and cancelled is its own act.
//
// Members sign up through the service-role RPCs in the player app. Nothing here
// adds anybody to an event.

type EventRow = {
  id: string;
  title: string;
  status: string;
};

type ParsedEvent = ReturnType<typeof clubEventSchema.parse>;

export async function createClubEvent(input: ClubEventInput): Promise<ActionResult<{ id: string }>> {
  return runAction(() => createImpl(input));
}

async function createImpl(input: ClubEventInput): Promise<{ id: string }> {
  const actor = await requireCapability('events.manage.create.write');
  const parsed = parseOrThrow(clubEventSchema, input);
  const adminClient = createAdminClient();

  const { data, error } = await adminClient
    .from('club_events')
    .insert({
      ...eventColumns(parsed),
      status: parsed.publish ? 'published' : 'draft',
      created_by: actor.id,
    })
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`The event was not written: ${error.message}`);
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error('The event was not written.');

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'club_event_created',
      target_type: 'club_event',
      target_id: id,
      new_value: { title: parsed.title, kind: parsed.kind, published: parsed.publish },
      reason: `Club event "${parsed.title}" created`,
    },
    { eventId: id },
  );

  revalidatePath('/events');
  revalidatePath(`/events/${id}`);
  return { id };
}

export async function updateClubEvent(id: string, input: ClubEventInput): Promise<ActionResult> {
  return runAction(() => updateImpl(id, input));
}

async function updateImpl(id: string, input: ClubEventInput): Promise<void> {
  const actor = await requireCapability('events.manage.update.write');
  parseOrThrow(z.string().uuid(), id);
  const parsed = parseOrThrow(clubEventSchema, input);
  const adminClient = createAdminClient();

  const current = await loadEvent(adminClient, id);
  if (current.status === 'cancelled') {
    throw new ExpectedError('A cancelled event cannot be edited.');
  }
  const nextStatus = parsed.publish ? 'published' : 'draft';
  if (current.status === 'published' && nextStatus === 'draft') {
    const taken = await countSignups(adminClient, id);
    if (taken > 0) {
      throw new ExpectedError(
        'People have signed up, so this event cannot go back to a draft. Cancel it instead so they are told.',
      );
    }
  }

  const { data, error } = await adminClient
    .from('club_events')
    .update({ ...eventColumns(parsed), status: nextStatus })
    .eq('id', id)
    // A cancel that lands between the read above and this write must win:
    // matching nothing here is read as a refusal below, not as a success.
    .neq('status', 'cancelled')
    .select('id');
  if (error) throw new Error(`The event was not saved: ${error.message}`);
  if ((data ?? []).length === 0) {
    throw new ExpectedError('That event was cancelled or no longer exists.');
  }

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'club_event_updated',
      target_type: 'club_event',
      target_id: id,
      old_value: { title: current.title, status: current.status },
      new_value: { title: parsed.title, kind: parsed.kind, status: nextStatus },
      reason: `Club event "${parsed.title}" edited`,
    },
    { eventId: id },
  );

  revalidatePath('/events');
  revalidatePath(`/events/${id}`);
}

export async function cancelClubEvent(id: string, reason: string): Promise<ActionResult> {
  return runAction(() => cancelImpl(id, reason));
}

async function cancelImpl(id: string, reason: string): Promise<void> {
  const actor = await requireCapability('events.manage.cancel.write');
  parseOrThrow(z.string().uuid(), id);
  const why = parseOrThrow(z.string().trim().max(500, 'Keep the reason to 500 characters'), reason ?? '');
  const adminClient = createAdminClient();

  const { data, error } = await adminClient
    .from('club_events')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_reason: why || null,
    })
    .eq('id', id)
    // Idempotence: a second cancel must not rewrite when the first one happened.
    .neq('status', 'cancelled')
    .select('id, title');
  if (error) throw new Error(`The event was not cancelled: ${error.message}`);
  const row = (data ?? [])[0] as { id: string; title: string } | undefined;
  if (!row) throw new ExpectedError('That event is already cancelled, or no longer exists.');

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'club_event_cancelled',
      target_type: 'club_event',
      target_id: id,
      old_value: { cancelled: false },
      new_value: { cancelled: true, reason: why || null },
      reason: why ? `Club event "${row.title}" cancelled: ${why}` : `Club event "${row.title}" cancelled`,
    },
    { eventId: id },
  );

  // The people signed up are told. Best-effort by notifyPlayers' own contract:
  // the cancel has already happened whether or not the bell rows commit.
  const { data: signups, error: signupsError } = await adminClient
    .from('club_event_signups')
    .select('player_id')
    .eq('event_id', id);
  if (signupsError) throw new Error(`The event was cancelled but its sign-ups could not be read: ${signupsError.message}`);
  const playerIds = ((signups ?? []) as { player_id: string }[]).map((s) => s.player_id);
  await notifyPlayers(adminClient, playerIds, {
    type: 'general',
    title: `${row.title} is cancelled`,
    body: why || null,
    metadata: { kind: 'club_event_cancelled', event_id: id },
  });

  revalidatePath('/events');
  revalidatePath(`/events/${id}`);
}

export async function deleteClubEvent(id: string): Promise<ActionResult> {
  return runAction(() => deleteImpl(id));
}

async function deleteImpl(id: string): Promise<void> {
  const actor = await requireCapability('events.manage.delete.write');
  parseOrThrow(z.string().uuid(), id);
  const adminClient = createAdminClient();

  const current = await loadEvent(adminClient, id);
  if ((await countSignups(adminClient, id)) > 0) {
    throw new ExpectedError('People have signed up for this event. Cancel it instead so the people signed up are told.');
  }

  const { error } = await adminClient.from('club_events').delete().eq('id', id);
  // 23503: somebody signed up after the count above. The sign-ups FK is
  // RESTRICT (00244), so the database refused rather than dropping them.
  if (error?.code === '23503') {
    throw new ExpectedError('People have signed up for this event. Cancel it instead so the people signed up are told.');
  }
  if (error) throw new Error(`The event was not deleted: ${error.message}`);

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'club_event_deleted',
      target_type: 'club_event',
      target_id: id,
      old_value: { title: current.title, status: current.status },
      reason: `Club event "${current.title}" deleted`,
    },
    { eventId: id },
  );

  revalidatePath('/events');
}

export async function removeClubEventSignup(eventId: string, playerId: string): Promise<ActionResult> {
  return runAction(() => removeSignupImpl(eventId, playerId));
}

async function removeSignupImpl(eventId: string, playerId: string): Promise<void> {
  const actor = await requireCapability('events.signups.remove.write');
  parseOrThrow(z.string().uuid(), eventId);
  parseOrThrow(z.string().uuid(), playerId);
  const adminClient = createAdminClient();

  const { data, error } = await adminClient
    .from('club_event_signups')
    .delete()
    .eq('event_id', eventId)
    .eq('player_id', playerId)
    .select('player_id');
  // 23514: the linked tournament's draw is made (00292), and the message says
  // to withdraw them from the tournament instead.
  if (error?.code === '23514') throw new ExpectedError(error.message);
  if (error) throw new Error(`The sign-up was not removed: ${error.message}`);
  if ((data ?? []).length === 0) {
    throw new ExpectedError('That member is not signed up for this event.');
  }

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'club_event_signup_removed',
      target_type: 'club_event',
      target_id: eventId,
      new_value: { player_id: playerId, removed: true },
      reason: 'A member was removed from a club event',
    },
    { eventId, playerId },
  );

  revalidatePath('/events');
  revalidatePath(`/events/${eventId}`);
}

// CHECK-IN AT THE DOOR (00293). One action for both lists: a member's sign-up
// is keyed by player, a non-member's (from the Google Form) by its own row id.
// `here` false is the undo. The actor goes in audit_logs, not on the row: a
// checked_in_by column would be a player foreign key that blocks merges.
export async function setClubEventCheckIn(
  eventId: string,
  who: { kind: 'member' | 'guest'; id: string },
  here: boolean,
): Promise<ActionResult<{ checkedInAt: string | null }>> {
  return runAction(() => setCheckInImpl(eventId, who, here));
}

const checkInWhoSchema = z.object({ kind: z.enum(['member', 'guest']), id: z.string().uuid() }).strict();

async function setCheckInImpl(
  eventId: string,
  who: { kind: 'member' | 'guest'; id: string },
  here: boolean,
): Promise<{ checkedInAt: string | null }> {
  const actor = await requireCapability('events.signups.checkin.write');
  parseOrThrow(z.string().uuid(), eventId);
  const target = parseOrThrow(checkInWhoSchema, who);
  const checkedIn = parseOrThrow(z.boolean(), here);
  const adminClient = createAdminClient();

  const { data: event, error: eventError } = await adminClient
    .from('club_events')
    .select('id, status, tournament_event_id')
    .eq('id', eventId)
    .maybeSingle();
  if (eventError) throw new Error(`The event could not be read: ${eventError.message}`);
  if (!event) throw new ExpectedError('That event no longer exists.');
  if (event.status === 'cancelled') throw new ExpectedError('This event is cancelled.');
  // A linked event's sign-ups are tournament entries, and the tournament's
  // check-in (with its waiver block) is the one record of who is here.
  if (event.tournament_event_id) {
    throw new ExpectedError('This event runs as a tournament. Check people in on the tournament.');
  }

  const checkedInAt = checkedIn ? new Date().toISOString() : null;
  const { data, error } =
    target.kind === 'member'
      ? await adminClient
          .from('club_event_signups')
          .update({ checked_in_at: checkedInAt })
          .eq('event_id', eventId)
          .eq('player_id', target.id)
          .select('event_id')
      : await adminClient
          .from('club_event_external_signups')
          .update({ checked_in_at: checkedInAt })
          .eq('event_id', eventId)
          .eq('id', target.id)
          .select('event_id');
  if (error) throw new Error(`Check-in was not saved: ${error.message}`);
  if ((data ?? []).length === 0) {
    throw new ExpectedError('That person is not signed up for this event.');
  }

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: checkedIn ? 'club_event_checked_in' : 'club_event_check_in_undone',
      target_type: 'club_event',
      target_id: eventId,
      new_value: target.kind === 'member' ? { player_id: target.id } : { external_signup_id: target.id },
      reason: checkedIn ? 'Checked in at a club event' : 'A club event check-in was undone',
    },
    { eventId },
  );

  revalidatePath(`/events/${eventId}`);
  return { checkedInAt };
}

// ---------------------------------------------------------------------------
// Helpers. Not exported: an exported function in a 'use server' module is a
// POST endpoint.
// ---------------------------------------------------------------------------

// Field by field from the parsed body, never a spread of it.
function eventColumns(parsed: ParsedEvent) {
  return {
    title: parsed.title,
    kind: parsed.kind,
    description: parsed.description ?? null,
    location: parsed.location ?? null,
    starts_at: toInstant(parsed.starts_at),
    ends_at: parsed.ends_at ? toInstant(parsed.ends_at) : null,
    signup_opens_at: parsed.signup_opens_at ? toInstant(parsed.signup_opens_at) : null,
    signup_closes_at: parsed.signup_closes_at ? toInstant(parsed.signup_closes_at) : null,
    capacity: parsed.capacity,
    cost_cents: parsed.cost_cents,
  };
}

function toInstant(wallClock: string): string {
  const at = clubWallClockToUtc(wallClock);
  if (!at) throw new ExpectedError(`Not a real date and time: ${wallClock}`);
  return at.toISOString();
}

async function loadEvent(
  adminClient: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<EventRow> {
  const { data, error } = await adminClient
    .from('club_events')
    .select('id, title, status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`The event could not be read: ${error.message}`);
  if (!data) throw new ExpectedError('That event no longer exists.');
  return data as EventRow;
}

async function countSignups(
  adminClient: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<number> {
  const { count, error } = await adminClient
    .from('club_event_signups')
    .select('player_id', { count: 'exact', head: true })
    .eq('event_id', id);
  // Fail closed: an unread count is not zero sign-ups.
  if (error || count === null) throw new Error(`The sign-ups could not be counted: ${error?.message ?? 'no count'}`);
  return count;
}

// ============================================================
// RUN AS A TOURNAMENT (00292)
// ============================================================
//
// Makes a tournament event for this club event and links them, so the draw,
// pairing, check-in and scores run on the tournament pages and every sign-up is
// an entry there (and back). The database does all of it in one transaction;
// this checks the caller may both edit club events and create tournaments.

const linkTournamentSchema = z
  .object({
    event_type: z.enum([
      'mens_singles',
      'womens_singles',
      'open_singles',
      'mens_doubles',
      'womens_doubles',
      'mixed_doubles',
      'open_doubles',
    ]),
    format: z.enum(['single_elimination', 'round_robin', 'pool_to_bracket']),
    rated: z.boolean(),
  })
  .strict();

export type LinkTournamentInput = z.infer<typeof linkTournamentSchema>;

export async function linkClubEventTournament(
  id: string,
  input: LinkTournamentInput,
): Promise<ActionResult<{ tournamentId: string; eventId: string }>> {
  return runAction(() => linkTournamentImpl(id, input));
}

async function linkTournamentImpl(
  id: string,
  input: LinkTournamentInput,
): Promise<{ tournamentId: string; eventId: string }> {
  await requireCapability('events.manage.update.write');
  const actor = await requireCapability('tournaments.manage.create.write');
  parseOrThrow(z.string().uuid(), id);
  const body = parseOrThrow(linkTournamentSchema, input);
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.rpc('link_club_event_tournament', {
    p_club_event_id: id,
    p_actor_id: actor.id as string,
    p_event_type: body.event_type,
    p_format: body.format,
    p_rated: body.rated,
  });
  if (error) throw new Error(`The tournament was not made: ${error.message}`);
  const result = data as {
    ok: boolean;
    reason?: string;
    tournament_id?: string;
    event_id?: string;
  } | null;
  if (!result?.ok || !result.tournament_id || !result.event_id) {
    switch (result?.reason) {
      case 'cancelled':
        throw new ExpectedError('This event is cancelled.');
      case 'no_active_season':
        throw new ExpectedError('There must be exactly one active season to make a tournament.');
      case 'not_found':
        throw new ExpectedError('That event no longer exists.');
      default:
        throw new Error(`The tournament was not made: ${result?.reason ?? 'no answer'}`);
    }
  }

  revalidatePath(`/events/${id}`);
  revalidatePath('/tournaments');
  return { tournamentId: result.tournament_id, eventId: result.event_id };
}
