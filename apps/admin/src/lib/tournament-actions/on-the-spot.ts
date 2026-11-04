'use server';

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { ExpectedError, isDoublesEvent, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { onTheSpotChecksIn, onTheSpotFeePath } from '../on-the-spot';
import { assertEventWaiverSigned, requireCapability, revalidateEventPaths } from './_internal';
import {
  addPairCore,
  addParticipantCore,
  checkInPairCore,
  checkInParticipantCore,
  type EntryCoreFlags,
} from './entry-core';

// ADD ON THE SPOT. The desk adds whoever is standing there: a member, or a
// guest by name alone (00317), with or without a partner, before or after the
// draw. The entry goes through the same core as the console's own add, with
// two differences only this path may ask for: a single may join a drawn
// doubles event to be paired later, and the fee is the desk's choice. Every
// field below is a client-controlled POST field, so each is shape-checked,
// and chargeFee only picks between the normal fee and none.

const uuid = z.string().uuid();
const inputSchema = z
  .object({
    eventId: uuid,
    playerId: uuid.nullable().optional(),
    guestName: z.string().trim().min(1).max(120).nullable().optional(),
    partnerId: uuid.nullable().optional(),
    chargeFee: z.boolean(),
  })
  .strict()
  .refine((v) => (v.playerId ? 1 : 0) + (v.guestName ? 1 : 0) === 1, { message: 'Pick a member or type a guest name.' })
  .refine((v) => !v.partnerId || v.partnerId !== v.playerId, { message: 'Pick a different partner.' });

export type OnTheSpotInput = z.infer<typeof inputSchema>;

export interface OnTheSpotResult {
  /** The tournament entry made: a pair, or a participant. */
  entryId: string;
  isPair: boolean;
  name: string;
  checkedIn: boolean;
  waiverUnsigned: boolean;
  /** A single in a doubles event: paired before a group can take them. */
  needsPartner: boolean;
}

async function addOnTheSpotImpl(raw: unknown): Promise<OnTheSpotResult> {
  const admin = await requireCapability('tournaments.draw.participants.add.write');
  const input = parseOrThrow(inputSchema, raw);
  const adminClient = createAdminClient();

  const { data: event, error: eventError } = await adminClient.from('tournament_events')
    .select('id, tournament_id, event_type, status')
    .eq('id', input.eventId)
    .maybeSingle();
  if (eventError) throw new Error(`Could not read the event: ${eventError.message}`);
  if (!event) throw new ExpectedError('Event not found');
  const doubles = isDoublesEvent(event.event_type);
  if (input.partnerId && !doubles) throw new ExpectedError('A singles event has no partner to pick.');

  const { data: linkedClub, error: linkError } = await adminClient.from('club_events')
    .select('id')
    .eq('tournament_event_id', event.id)
    .maybeSingle();
  if (linkError) throw new Error(`Could not read whether this event runs a club event: ${linkError.message}`);
  const feePath = onTheSpotFeePath(linkedClub != null, input.chargeFee);
  const flags: EntryCoreFlags = { lateSolo: true, chargeFee: feePath === 'tournament' };

  let playerId = input.playerId ?? null;
  if (!playerId) {
    const { data: made, error: guestError } = await adminClient.rpc('create_desk_guest' as never, {
      p_display_name: input.guestName,
      p_actor: admin.id,
    } as never);
    if ((guestError as { code?: string } | null)?.code === '23514') throw new ExpectedError(guestError!.message);
    if (guestError) throw new Error(`create_desk_guest failed: ${guestError.message}`);
    playerId = made as unknown as string;
  }

  const players = input.partnerId ? [playerId, input.partnerId] : [playerId];
  if (input.partnerId) await addPairCore(event.id, playerId, input.partnerId, undefined, flags);
  else await addParticipantCore(event.id, playerId, undefined, flags);

  // The entry just made, read back rather than taken from the core's return,
  // which differs between the two adds.
  const entryRead = input.partnerId
    ? await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, player1:players!player1_id(full_name), player2:players!player2_id(full_name)')
      .eq('event_id', event.id)
      .or(`and(player1_id.eq.${playerId},player2_id.eq.${input.partnerId}),and(player1_id.eq.${input.partnerId},player2_id.eq.${playerId})`)
      .not('status', 'in', '("withdrawn","disqualified")')
      .maybeSingle()
    : await adminClient.from('tournament_participants')
      .select('id, player_id, player:players!player_id(full_name)')
      .eq('event_id', event.id)
      .eq('player_id', playerId)
      .not('status', 'in', '("withdrawn","disqualified")')
      .maybeSingle();
  if (entryRead.error) throw new Error(`They were added, but the entry could not be read back: ${entryRead.error.message}. Reload to see them.`);
  if (!entryRead.data) throw new Error('They were added, but the entry could not be found. Reload to see them.');
  const entry = entryRead.data as unknown as {
    id: string;
    player1_id?: string;
    player2_id?: string;
    player1?: { full_name?: string | null } | null;
    player2?: { full_name?: string | null } | null;
    player?: { full_name?: string | null } | null;
  };
  const members = input.partnerId
    ? [
      { id: entry.player1_id!, name: entry.player1?.full_name ?? 'This player' },
      { id: entry.player2_id!, name: entry.player2?.full_name ?? 'This player' },
    ]
    : [{ id: playerId, name: entry.player?.full_name ?? input.guestName ?? 'This player' }];
  const name = members.map((m) => m.name).join(' / ');

  if (feePath === 'club_waived') {
    const { error: waiveError } = await adminClient.rpc('club_event_desk_entry_walk_in' as never, {
      p_tournament_event_id: event.id,
      p_player_ids: players,
    } as never);
    // Reported, not swallowed: they are in, but owe a fee the desk said to leave off.
    if (waiveError) throw new Error(`They were added, but the club-event fee could not be left off: ${waiveError.message}. Waive it from the fees page.`);
  }

  // Checked in through the ordinary check-in, so the waiver is never bypassed:
  // an unsigned waiver leaves the entry registered.
  let checkedIn = false;
  let waiverUnsigned = false;
  if (onTheSpotChecksIn(event.status)) {
    try {
      await assertEventWaiverSigned(adminClient, event.tournament_id, { id: entry.id, members });
    } catch (err) {
      if (!(err instanceof ExpectedError)) throw err;
      waiverUnsigned = true;
    }
    if (!waiverUnsigned) {
      try {
        if (input.partnerId) await checkInPairCore(entry.id);
        else await checkInParticipantCore(entry.id);
        checkedIn = true;
      } catch (err) {
        if (!(err instanceof ExpectedError)) Sentry.captureException(err);
      }
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'entry_added_on_the_spot',
    performed_by: admin.id,
    details: {
      entry_id: entry.id,
      player_ids: players,
      guest_made: !input.playerId,
      fee_charged: feePath === 'club' || feePath === 'tournament',
      fee_path: feePath,
      checked_in: checkedIn,
      waiver_unsigned: waiverUnsigned,
    },
  });

  revalidateEventPaths(event.tournament_id, event.id);
  return {
    entryId: entry.id,
    isPair: !!input.partnerId,
    name,
    checkedIn,
    waiverUnsigned,
    needsPartner: doubles && !input.partnerId,
  };
}

export async function addOnTheSpot(input: OnTheSpotInput): Promise<ActionResult<OnTheSpotResult>> {
  return runAction(() => addOnTheSpotImpl(input));
}
