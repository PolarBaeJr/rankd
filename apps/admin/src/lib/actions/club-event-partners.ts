'use server';

import { randomInt } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ExpectedError, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { loadPartnerBoard } from '../partner-board';
import { addPairToEvent } from '../tournament-actions/participants';

// THE DESK SETTLES WHO PARTNERS WHOM (00311). The desk's choice is written to
// its own columns, never to preferred_partner: the Form reader rewrites that on
// every replay. Pairing is the linked tournament's addPairToEvent, which asks
// for its own capability and refuses anybody already teamed.
//
// Every exported parameter is a client-controlled POST field, so each is
// shape-checked, and who asked for whom is re-derived on the server: the
// client's idea of the requesters is never trusted.

type AdminClient = ReturnType<typeof createAdminClient>;

const uuid = z.string().uuid();
const whoSchema = z.object({ kind: z.enum(['member', 'guest']), id: uuid }).strict();
const choiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('typed') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('member'), id: uuid }).strict(),
  z.object({ kind: z.literal('guest'), id: uuid }).strict(),
]);
const pickSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('random') }).strict(),
  z.object({ mode: z.literal('choose'), requesterPlayerId: uuid }).strict(),
]);

export type PartnerWho = z.infer<typeof whoSchema>;
export type PartnerChoice = z.infer<typeof choiceSchema>;
export type ContestPick = z.infer<typeof pickSchema>;

const tableOf = (kind: 'member' | 'guest') => (kind === 'member' ? 'club_event_signups' : 'club_event_external_signups');
const keyColumnOf = (kind: 'member' | 'guest') => (kind === 'member' ? 'player_id' : 'id');

async function isSignedUp(adminClient: AdminClient, eventId: string, who: PartnerWho): Promise<boolean> {
  const { data, error } = await adminClient
    .from(tableOf(who.kind))
    .select(keyColumnOf(who.kind))
    .eq('event_id', eventId)
    .eq(keyColumnOf(who.kind), who.id)
    .maybeSingle();
  if (error) throw new Error(`The sign-up could not be read: ${error.message}`);
  return !!data;
}

async function revalidateBoth(adminClient: AdminClient, eventId: string, tournamentEventId: string | null) {
  revalidatePath(`/events/${eventId}`);
  if (!tournamentEventId) return;
  const { data } = await adminClient
    .from('tournament_events')
    .select('tournament_id')
    .eq('id', tournamentEventId)
    .maybeSingle();
  const tournamentId = (data as { tournament_id?: string } | null)?.tournament_id;
  if (tournamentId) revalidatePath(`/tournaments/${tournamentId}/events/${tournamentEventId}`);
}

/** Set, clear or reset to "what they wrote" one sign-up's partner. */
export async function setClubEventPartnerChoice(
  eventId: string,
  who: PartnerWho,
  choice: PartnerChoice,
): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireCapability('events.signups.checkin.write');
    parseOrThrow(uuid, eventId);
    const target = parseOrThrow(whoSchema, who);
    const picked = parseOrThrow(choiceSchema, choice);
    if ((picked.kind === 'member' || picked.kind === 'guest') && picked.kind === target.kind && picked.id === target.id) {
      throw new ExpectedError('Somebody cannot be their own partner.');
    }
    const adminClient = createAdminClient();

    const { data: event, error: eventError } = await adminClient
      .from('club_events')
      .select('id, status, tournament_event_id')
      .eq('id', eventId)
      .maybeSingle();
    if (eventError) throw new Error(`The event could not be read: ${eventError.message}`);
    if (!event) throw new ExpectedError('That event no longer exists.');
    if (event.status === 'cancelled') throw new ExpectedError('This event is cancelled.');

    if (!(await isSignedUp(adminClient, eventId, target))) {
      throw new ExpectedError('That person is not signed up for this event.');
    }
    if ((picked.kind === 'member' || picked.kind === 'guest') && !(await isSignedUp(adminClient, eventId, picked))) {
      throw new ExpectedError('The partner picked is not signed up for this event.');
    }

    const columns =
      picked.kind === 'typed'
        ? { preferred_partner_player_id: null, preferred_partner_external_id: null, preferred_partner_set_at: null }
        : {
            preferred_partner_player_id: picked.kind === 'member' ? picked.id : null,
            preferred_partner_external_id: picked.kind === 'guest' ? picked.id : null,
            preferred_partner_set_at: new Date().toISOString(),
          };
    const { data, error } = await adminClient
      .from(tableOf(target.kind))
      .update(columns as never)
      .eq('event_id', eventId)
      .eq(keyColumnOf(target.kind), target.id)
      .select('event_id');
    if (error) throw new Error(`The partner was not saved: ${error.message}`);
    if ((data ?? []).length === 0) throw new ExpectedError('That person is not signed up for this event.');

    // Ids only: the typed note is never copied into the audit trail.
    await logAdminAudit(
      adminClient,
      {
        actor_id: actor.id as string,
        action_type: 'club_event_partner_set',
        target_type: 'club_event',
        target_id: eventId,
        new_value: {
          ...(target.kind === 'member' ? { player_id: target.id } : { external_signup_id: target.id }),
          choice: picked.kind,
          partner_player_id: picked.kind === 'member' ? picked.id : null,
          partner_external_id: picked.kind === 'guest' ? picked.id : null,
        },
        reason: 'The desk set a club event sign-up\'s partner',
      },
      { eventId },
    );

    await revalidateBoth(adminClient, eventId, event.tournament_event_id ?? null);
  });
}

/**
 * Somebody asked for by two or more people: pair one of them with that person
 * in the linked tournament, picked by the officer or at random by the server.
 * The others are left waiting for a partner.
 */
export async function resolveContestedPartner(
  clubEventId: string,
  targetPlayerId: string,
  pick: ContestPick,
): Promise<ActionResult<{ winnerName: string }>> {
  return runAction(async () => {
    const actor = await requireCapability('events.signups.read');
    parseOrThrow(uuid, clubEventId);
    parseOrThrow(uuid, targetPlayerId);
    const mode = parseOrThrow(pickSchema, pick);
    const adminClient = createAdminClient();

    const board = await loadPartnerBoard(adminClient, clubEventId);
    if (!board.linkedEventId) throw new ExpectedError('This event does not run as a tournament, so nobody can be paired here.');
    if (!board.pool.has(targetPlayerId)) {
      throw new ExpectedError('That person is not waiting for a partner in the tournament.');
    }
    const check = board.result.byKey.get(`member:${targetPlayerId}`);
    if (!check || !check.contested) throw new ExpectedError('Nobody else is asking for that person now. Reload the page.');
    const byKey = new Map(board.people.map((person) => [person.key, person]));
    const requesters = check.requestedBy
      .map((key) => byKey.get(key))
      .filter((person): person is NonNullable<typeof person> => !!person?.playerId && board.pool.has(person.playerId));
    if (requesters.length === 0) throw new ExpectedError('None of those asking can be paired now.');

    let winner: (typeof requesters)[number];
    if (mode.mode === 'choose') {
      const chosen = requesters.find((person) => person.playerId === mode.requesterPlayerId);
      if (!chosen) throw new ExpectedError('Pick one of the people who asked for them.');
      winner = chosen;
    } else {
      winner = requesters[randomInt(0, requesters.length)]!;
    }

    const paired = await addPairToEvent(board.linkedEventId, winner.playerId!, targetPlayerId);
    if (!paired.ok) throw new ExpectedError(paired.error);

    await logAdminAudit(
      adminClient,
      {
        actor_id: actor.id as string,
        action_type: 'club_event_partner_contest_resolved',
        target_type: 'club_event',
        target_id: clubEventId,
        new_value: {
          player_id: targetPlayerId,
          winner_player_id: winner.playerId,
          mode: mode.mode,
          requester_player_ids: requesters.map((person) => person.playerId),
        },
        reason: 'A partner asked for by several people was settled',
      },
      { eventId: clubEventId },
    );

    await revalidateBoth(adminClient, clubEventId, board.linkedEventId);
    return { winnerName: winner.name };
  });
}

/** Two people who named each other, both waiting for a partner: team them. */
export async function pairMutualPartners(
  clubEventId: string,
  playerA: string,
  playerB: string,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireCapability('events.signups.read');
    parseOrThrow(uuid, clubEventId);
    parseOrThrow(uuid, playerA);
    parseOrThrow(uuid, playerB);
    const adminClient = createAdminClient();

    const board = await loadPartnerBoard(adminClient, clubEventId);
    if (!board.linkedEventId) throw new ExpectedError('This event does not run as a tournament, so nobody can be paired here.');
    const keyA = `member:${playerA}`;
    const keyB = `member:${playerB}`;
    const mutual = board.result.mutualPairs.some(
      ([first, second]) => (first === keyA && second === keyB) || (first === keyB && second === keyA),
    );
    if (!mutual) throw new ExpectedError('Those two did not name each other, or one is no longer waiting for a partner.');

    const paired = await addPairToEvent(board.linkedEventId, playerA, playerB);
    if (!paired.ok) throw new ExpectedError(paired.error);
    await revalidateBoth(adminClient, clubEventId, board.linkedEventId);
  });
}
