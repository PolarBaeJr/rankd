// THE MEMBER'S SIDE OF THE EVENT WAIVER.
//
// NOT a 'use server' module — these are helpers imported by the tournament
// actions, not actions themselves.
//
// ---------------------------------------------------------------------------
// THE ONE PLACE event_waiver_acceptances IS WRITTEN, AND WHY IT IS HERE
// ---------------------------------------------------------------------------
// The obvious-looking way to let an exec sign somebody in at the door is an
// admin action that inserts an acceptance on the member's behalf. It must not
// exist. A row that looks like a signature but is an officer's assertion is
// worse than no row at all, because it launders exactly the liability it claims
// to record — the club would hold a document saying somebody agreed to
// something they were never shown.
//
// No column and no flag makes that safe, so the guarantee is structural: every
// write to event_waiver_acceptances happens in the PLAYER app, behind
// requirePlayer(), against the member's own session cookie. `recordEventWaiverAcceptance`
// below and the one in registerForEvent are the entire set, and a test pins
// that the admin app contains no writer at all.
//
// "Hand them a device" therefore means handing them a device they sign in on —
// their phone, or an exec's phone with the member logged in as themselves.
// The officer's claim that they did so is an audit fact, and audit facts go in
// tournament_audit_log where officer claims belong.
import { headers } from 'next/headers';
import {
  ExpectedError,
  raise,
  resolveEventWaiverText,
  eventWaiverStatus,
  formSignedWaivers,
  type AcceptedEventWaiver,
  type EventWaiverStatus,
} from '@badminton/shared';
// By SUBPATH, never the barrel — node:crypto must not reach the browser bundle.
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import type { createServiceRoleClient } from './supabase-server';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export interface MyEventWaiver {
  /** The text to show, or null when this tournament requires nothing. */
  text: string | null;
  /** The hash of `text`. null exactly when `text` is null. */
  requiredHash: string | null;
  status: EventWaiverStatus;
}

/**
 * The whole tournament's waiver state, unfiltered by member.
 *
 * `loadMyEventWaiver` below answers "may I check in", which is one player's
 * question. A PAIR is not one player: 00102's own comment is explicit that
 * check-in is asked of the thing that takes the court, so a team needs BOTH
 * signatures and the scanning member's own is not enough. Screening the
 * partner needs their acceptances, which the per-player read filters out.
 *
 * Same failure discipline as the per-player read: a failed read throws rather
 * than returning "nothing required".
 */
export async function loadTournamentWaiverContext(
  service: ServiceClient,
  tournamentId: string,
): Promise<{ requiredHash: string | null; acceptances: AcceptedEventWaiver[] }> {
  const { data: tournament, error } = await service
    .from('tournaments')
    .select('waiver_text')
    .eq('id', tournamentId)
    .maybeSingle();
  if (error) throw raise('TRN-102', error);

  const text = resolveEventWaiverText(tournament);
  if (!text) return { requiredHash: null, acceptances: [] };

  const { data: rows, error: rowsError } = await service
    .from('event_waiver_acceptances')
    .select('player_id, waiver_hash, accepted_at')
    .eq('tournament_id', tournamentId);
  if (rowsError) throw raise('TRN-102', rowsError);

  const requiredHash = eventWaiverHash(text);
  return {
    requiredHash,
    acceptances: [...((rows ?? []) as AcceptedEventWaiver[]), ...await formSignedFor(service, tournamentId, requiredHash)],
  };
}

/**
 * Signed on the Google Form (00292): a club event run as this tournament took
 * its sign-ups from a Form that carries the waiver, so those entrants are not
 * asked again here. Same failure discipline as the reads above.
 */
async function formSignedFor(service: ServiceClient, tournamentId: string, requiredHash: string) {
  try {
    return await formSignedWaivers(service, tournamentId, requiredHash);
  } catch (err) {
    throw raise('TRN-102', err);
  }
}

/**
 * Where the signed-in member stands against one tournament's event waiver.
 *
 * A failed read throws rather than returning "not required" — a gate that
 * quietly opens when the database is unhappy is not a gate.
 */
export async function loadMyEventWaiver(
  service: ServiceClient,
  tournamentId: string,
  playerId: string,
): Promise<MyEventWaiver> {
  const { data: tournament, error } = await service
    .from('tournaments')
    .select('waiver_text')
    .eq('id', tournamentId)
    .maybeSingle();
  if (error) throw raise('TRN-102', error);

  const text = resolveEventWaiverText(tournament);
  if (!text) {
    return { text: null, requiredHash: null, status: eventWaiverStatus(playerId, null, []) };
  }

  const requiredHash = eventWaiverHash(text);
  const { data: rows, error: rowsError } = await service
    .from('event_waiver_acceptances')
    .select('player_id, waiver_hash, accepted_at')
    .eq('tournament_id', tournamentId)
    .eq('player_id', playerId);
  if (rowsError) throw raise('TRN-102', rowsError);

  const formSigned = (await formSignedFor(service, tournamentId, requiredHash)).filter((a) => a.player_id === playerId);
  return {
    text,
    requiredHash,
    status: eventWaiverStatus(playerId, requiredHash, [...((rows ?? []) as AcceptedEventWaiver[]), ...formSigned]),
  };
}

/**
 * The member's own refusal, which is a different sentence from the one the exec
 * at the door reads: this one is addressed to the person who can actually fix
 * it, and says where the button is.
 */
export function myEventWaiverRefusal(status: EventWaiverStatus): string {
  if (status.state === 'stale') {
    return (
      'The event waiver for this tournament has been updated since you accepted it, ' +
      'so you need to read and accept the new wording before you can check in. ' +
      'Open this tournament in the app to do it.'
    );
  }
  return (
    'You need to accept this tournament’s event waiver before you can check in. ' +
    'Open this tournament in the app, read it and accept it — it takes a few seconds.'
  );
}

/** Refuse a check-in the member is not eligible for. */
export async function assertMyEventWaiverSigned(
  service: ServiceClient,
  tournamentId: string,
  playerId: string,
): Promise<void> {
  const { status } = await loadMyEventWaiver(service, tournamentId, playerId);
  if (!status.eligible) throw new ExpectedError(myEventWaiverRefusal(status));
}

/**
 * Record an acceptance. THE HASH IS ALWAYS TAKEN FROM THE SERVER'S COPY of the
 * text, never from anything the client sent — otherwise a crafted request could
 * record agreement to wording that was never displayed, which is the same
 * laundering problem in a different coat.
 *
 * onConflict/ignoreDuplicates keeps it idempotent: accepting the same wording
 * twice is one row, and the UNIQUE index is what makes that true under a double
 * submit rather than the read that precedes it.
 */
export async function recordEventWaiverAcceptance(
  service: ServiceClient,
  tournamentId: string,
  playerId: string,
  text: string,
): Promise<void> {
  const userAgent = (await headers()).get('user-agent');
  const { error } = await service.from('event_waiver_acceptances').upsert(
    {
      player_id: playerId,
      tournament_id: tournamentId,
      waiver_hash: eventWaiverHash(text),
      user_agent: userAgent,
    },
    { onConflict: 'player_id,tournament_id,waiver_hash', ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}
