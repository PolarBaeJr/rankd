'use server';

import { headers } from 'next/headers';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from './supabase-server';
import { revalidatePath } from 'next/cache';
import {
  isDoublesEvent,
  membershipRefusalMessage,
  membershipUnpaidMessage,
  categoryRefusalMessage,
  ExpectedError,
  isUuid,
  formatWindowInstant,
  windowState,
  type TournamentEventType,
} from '@badminton/shared';
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import {
  assertMyEventWaiverSigned,
  loadMyEventWaiver,
  recordEventWaiverAcceptance,
} from './event-waiver';
import { requirePlayer, assertCurrentWaiver, runAction, type ActionResult } from './actions/_shared';
import { assertFeatureOn, getFeatureFlags } from './feature-gate';
import { refuseClosedTournament } from './tournament-closed';
import { loadEntryWindows, windowsFor } from './tournament-windows';
import { enterEventCore, type RegisterOptions } from './tournament-entry-core';
import {
  fillFromWaitlistAfterFree,
  isWaitlistMissing,
  settleWaitlistPromotions,
  type WaitlistPromotion,
} from './event-waitlist';
import {
  loadOwnImportEntry,
  pairMutualImportEntries,
  settleImportEntry,
  settleRefusal,
} from './registration-import';

// Revalidate every surface that surfaces tournament_participants /
// tournament_pairs after a register/withdraw/check-in. The event detail
// page must be in this list — that's the page where the user clicked
// the action button, and "No participants yet" was rendering stale.
function revalidateTournamentPaths(tournamentId: string, eventId: string) {
  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
  revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}

// Supabase may return a to-one embed as object-or-array — unwrap defensively.
function pickSuspension(embed: unknown): {
  suspended_at: string | null;
  suspension_reason: string | null;
  waiver_text?: string | null;
  // The tournament's own status, so an entry path can tell a tournament that is
  // OVER from one that is merely paused. Optional because not every select that
  // goes through this unwrap asks for it.
  status?: string | null;
} | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  return (row as { suspended_at: string | null; suspension_reason: string | null; waiver_text?: string | null; status?: string | null } | null) ?? null;
}

export type { RegisterOptions } from './tournament-entry-core';

export async function registerForEvent(eventId: string, opts?: RegisterOptions): Promise<ActionResult> {
  return runAction(() => registerForEventImpl(eventId, opts));
}

async function registerForEventImpl(eventId: string, opts?: RegisterOptions) {
  const player = await requirePlayer();
  await assertFeatureOn('tournaments', player);
  if (player.is_banned) {
    throw new ExpectedError('Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.');
  }
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  const { tournamentId } = await enterEventCore(
    service,
    player,
    eventId,
    opts,
    (await headers()).get('user-agent'),
  );

  revalidateTournamentPaths(tournamentId, eventId);
}

export interface ConfirmImportResult {
  status: 'entered' | 'awaiting_partner';
  paired: boolean;
}

/**
 * Confirm a tournament entry a Google Form response asked for (00283).
 *
 * The entry id is the only thing the client names, and it is checked against
 * the signed-in member: an id that is not theirs reads as not found. The entry
 * itself is made by registerForEventImpl, the member's own path, so every gate
 * a member meets on the event page (waiver, legal documents, membership,
 * category, window, the solo-doubles acknowledgement) is met here too.
 *
 * Settle is asked first: a member who already entered the event on their own
 * is confirmed without a second entry attempt.
 */
export async function confirmImportedTournamentEntry(
  entryId: string,
  opts?: RegisterOptions,
): Promise<ActionResult<ConfirmImportResult>> {
  return runAction(() => confirmImportedTournamentEntryImpl(entryId, opts));
}

async function confirmImportedTournamentEntryImpl(
  entryId: string,
  opts?: RegisterOptions,
): Promise<ConfirmImportResult> {
  if (!isUuid(entryId)) throw new ExpectedError('That entry could not be found.');
  const player = await requirePlayer();
  const service = createServiceRoleClient();
  const entry = await loadOwnImportEntry(service, entryId, player.id);
  if (!entry.tournament_event_id) throw new ExpectedError('That entry could not be found.');
  if (entry.status !== 'awaiting_member') throw new ExpectedError('This entry is no longer waiting for you.');

  let settled = await settleImportEntry(service, entryId, player.id);
  if (!settled.ok && settled.reason === 'not_entered') {
    // Only the two flags the member's own dialog would send, never anything
    // else from the client.
    await registerForEventImpl(entry.tournament_event_id, {
      eventWaiverAccepted: opts?.eventWaiverAccepted === true,
      soloEntryAcknowledged: opts?.soloEntryAcknowledged === true,
    });
    settled = await settleImportEntry(service, entryId, player.id);
  }
  if (!settled.ok) throw new ExpectedError(settleRefusal(settled));

  let paired = false;
  if (settled.partner_entry_id && settled.partner_player_id && isUuid(settled.partner_player_id)) {
    paired = await pairMutualImportEntries(service, entryId, player.id, settled.partner_player_id);
  }
  return {
    status: paired || settled.status === 'entered' ? 'entered' : 'awaiting_partner',
    paired,
  };
}

/**
 * Accept a tournament's event waiver on its own, outside registration.
 *
 * This is what closes the loop for somebody an EXEC added: they never went
 * through registerForEvent, so nothing ever asked them. The tournament page
 * shows them the text and this records the acceptance.
 *
 * IT IS THE MEMBER'S ACTION AND NOBODY ELSE'S. requirePlayer() reads the
 * signed-in session, and the row is written for THAT player — there is no
 * parameter for whose signature this is, deliberately, because a parameter is
 * all an exec-facing wrapper would need to start recording signatures on other
 * people's behalf.
 *
 * "Sign at the door" is therefore: the exec hands over a device the member is
 * signed in on, and the member reads and accepts. Same action, same evidence,
 * no proxy.
 */
export async function acceptEventWaiver(
  tournamentId: string,
  opts: { accepted: boolean },
): Promise<ActionResult> {
  return runAction(() => acceptEventWaiverImpl(tournamentId, opts));
}

async function acceptEventWaiverImpl(tournamentId: string, opts: { accepted: boolean }) {
  const player = await requirePlayer();
  await assertFeatureOn('tournaments', player);
  const service = createServiceRoleClient();

  // The tick box is a UI affordance and this is the server's copy of the same
  // question. Without it, a request with the box unchecked records agreement.
  if (!opts.accepted) throw new ExpectedError('Tick the box to accept the event waiver.');

  const { text, status } = await loadMyEventWaiver(service, tournamentId, player.id);
  if (!text) throw new ExpectedError('This tournament has no event waiver to accept.');
  // Idempotent by the unique index anyway; saying so is friendlier than a
  // silent no-op that looks like the button did nothing.
  if (status.state === 'signed') return;

  // ENTRANTS ONLY. An acceptance from somebody who is not in the tournament is
  // evidence of nothing and would sit in the table forever. Checked across both
  // disciplines because a doubles entrant has no tournament_participants row at
  // all — they exist only as half of a pair, which is exactly the population
  // this feature was built for.
  const [singles, pairs] = await Promise.all([
    service.from('tournament_participants')
      .select('id, event:tournament_events!inner(tournament_id)')
      .eq('player_id', player.id)
      .eq('event.tournament_id', tournamentId)
      .limit(1),
    service.from('tournament_pairs')
      .select('id, event:tournament_events!inner(tournament_id)')
      .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
      .eq('event.tournament_id', tournamentId)
      .limit(1),
  ]);
  if ((singles.data?.length ?? 0) === 0 && (pairs.data?.length ?? 0) === 0) {
    throw new ExpectedError('You are not entered in this tournament, so there is nothing to accept yet.');
  }

  await recordEventWaiverAcceptance(service, tournamentId, player.id, text);

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function withdrawFromEvent(eventId: string): Promise<ActionResult> {
  return runAction(() => withdrawFromEventImpl(eventId));
}

async function withdrawFromEventImpl(eventId: string) {
  const player = await requirePlayer();
  await assertFeatureOn('tournaments', player);
  const service = createServiceRoleClient();

  // ONE STATEMENT, NOT READ-THEN-UPDATE (00193). This used to read the
  // participant row and the event status, reason about them, and then issue an
  // UPDATE keyed on the participant id alone — so a draw published in the gap
  // turned a refusal that had already been decided into a withdrawal from an
  // event that now has a bracket. The entry stays seeded, its match stays
  // playable, the bye it was handed stays on the record, and the forfeit
  // cascade that makes a late withdrawal coherent never runs.
  //
  // Every rule below still lives in exactly one place; the function is that
  // place, and it holds the event row while it decides.
  const { data: result, error } = await service.rpc('withdraw_from_tournament_event', {
    p_event_id: eventId,
    p_player_id: player.id,
  });
  if (error) throw new Error(error.message);
  if (!result) throw new Error('Could not withdraw you — please try again shortly.');

  if (!result.ok) {
    switch (result.reason) {
      // No participant row is not the same as not entered: half of a formed
      // pair is entered and has no row. Leaving a pair puts the partner back in
      // the pool and they have to be told, which nothing on the player side can
      // do — so it stays an exec action, the same line drawn once a draw exists.
      case 'in_pair':
        throw new ExpectedError(
          'You have been paired with a partner, so leaving is not something you can do on your own — ' +
          'it puts them back in the pool too. Ask a tournament admin to withdraw you.',
        );
      case 'not_registered':
        throw new ExpectedError('Not registered');
      case 'not_withdrawable':
        throw new ExpectedError('Cannot withdraw at this stage');
      case 'draw_published':
        throw new ExpectedError(
          'The draw is already published — ask a tournament admin to withdraw you so your matches can be forfeited properly.',
        );
      case 'event_not_found':
        throw new Error('Event not found');
      default:
        throw new Error('Could not withdraw you — please try again shortly.');
    }
  }

  // The place this freed goes to the head of the waitlist (00278), as its own
  // step: the withdrawal has committed and nothing here can undo it.
  await fillFromWaitlistAfterFree(service, eventId);

  const tournamentId = result.tournament_id as string | undefined;
  if (tournamentId) revalidateTournamentPaths(tournamentId, eventId);
  else revalidatePath('/tournaments');
}

// ---------------------------------------------------------------------------
// THE WAITLIST (00278)
// ---------------------------------------------------------------------------
// A member who could not get into a full event can queue for it. Joining asks
// every question entering asks, inside join_event_waitlist under the same
// locks, so a member who could not enter cannot queue either. The sentences
// here are the ones registerForEvent uses for the same reasons.

const WAITLIST_NOT_AVAILABLE = 'The waitlist is not available yet';

export interface JoinWaitlistResult {
  /** Place in the queue, 1 first, or null when the join went straight in. */
  position: number | null;
  /** True when a free place was waiting and the member was entered at once. */
  entered: boolean;
}

export async function joinEventWaitlist(eventId: string, opts?: RegisterOptions): Promise<ActionResult<JoinWaitlistResult>> {
  return runAction(() => joinEventWaitlistImpl(eventId, opts));
}

async function joinEventWaitlistImpl(eventId: string, opts?: RegisterOptions): Promise<JoinWaitlistResult> {
  const player = await requirePlayer();
  await assertFeatureOn('tournaments', player);
  if (player.is_banned) {
    throw new ExpectedError('Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.');
  }
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  const { data: event, error: eventError } = await service.from('tournament_events')
    .select('id, event_type, tournament_id, external_event, tournament:tournaments(waiver_text)')
    .eq('id', eventId).maybeSingle();
  if (eventError) {
    Sentry.captureException(eventError, { tags: { action: 'joinEventWaitlist', read: 'event' } });
    throw new ExpectedError('Cannot process your request right now, please try again shortly');
  }
  if (!event) throw new Error('Event not found');
  if (event.external_event) throw new ExpectedError('This event is entered by the organisers.');

  // The same two consents an entry needs, because a promotion later enters the
  // member without asking again.
  const doubles = isDoublesEvent(event.event_type);
  if (doubles && !opts?.soloEntryAcknowledged) {
    throw new ExpectedError(
      'Entering a doubles event on your own means the exec will pair you with another member. ' +
      'Confirm that before you join the waitlist.',
    );
  }
  const eventWaiverText = pickSuspension(event.tournament)?.waiver_text?.trim();
  if (eventWaiverText && !opts?.eventWaiverAccepted) {
    throw new ExpectedError('You must accept the event waiver to join the waitlist');
  }

  const { data: joined, error: joinErr } = await service.rpc('join_event_waitlist', {
    p_event_id: eventId,
    p_player_id: player.id,
    p_doubles: doubles,
    p_waiver_hash: eventWaiverText ? eventWaiverHash(eventWaiverText) : null,
    p_user_agent: eventWaiverText ? (await headers()).get('user-agent') : null,
  });
  if (joinErr) {
    if (isWaitlistMissing(joinErr)) {
      Sentry.captureException(new Error(`join_event_waitlist is missing, migration 00278 is not applied: ${joinErr.message}`));
      throw new ExpectedError(WAITLIST_NOT_AVAILABLE);
    }
    throw new Error(joinErr.message);
  }
  if (!joined) throw new Error('Could not add you to the waitlist, please try again shortly.');
  if (!joined.ok) {
    switch (joined.reason) {
      case 'waitlist_disabled':
        throw new ExpectedError('This event does not have a waitlist.');
      case 'already_waiting':
        throw new ExpectedError('You are already on the waitlist for this event.');
      case 'event_has_room':
        throw new ExpectedError('This event has room, so you can enter it now.');
      case 'already_registered':
        throw new ExpectedError(
          joined.entry_status === 'withdrawn' || joined.entry_status === 'disqualified'
            ? 'You have already left this event. Ask a tournament admin if you want to enter it again.'
            : 'Already registered',
        );
      case 'entry_cap':
        throw new ExpectedError(
          `You are already entered in ${joined.cap} ${joined.cap === 1 ? 'event' : 'events'} at this tournament, which is the limit. ` +
          'Withdraw from one to join this waitlist, or ask a tournament admin if one of them is a doubles pair.',
        );
      case 'registration_closed':
        throw new ExpectedError('Registration is closed');
      case 'registration_not_open':
        throw new ExpectedError(
          joined.opens_at ? `Registration opens ${formatWindowInstant(joined.opens_at)}` : 'Registration is closed',
        );
      case 'registration_window_closed':
        throw new ExpectedError(
          joined.closes_at ? `Registration closed ${formatWindowInstant(joined.closes_at)}` : 'Registration is closed',
        );
      case 'waiver_required':
        throw new ExpectedError('You must accept the event waiver to join the waitlist');
      case 'tournament_suspended':
        throw new ExpectedError(
          `This tournament is currently suspended${joined.suspension_reason ? `: ${joined.suspension_reason}` : ''}`,
        );
      case 'tournament_closed':
        throw new ExpectedError(
          refuseClosedTournament(joined.status, 'enter this event')
          ?? 'This tournament has ended.',
        );
      case 'membership_not_allowed':
        throw new ExpectedError(
          membershipRefusalMessage(Array.isArray(joined.allowed) ? joined.allowed : null),
        );
      case 'membership_unpaid':
        throw new ExpectedError(
          membershipUnpaidMessage(
            Array.isArray(joined.allowed) ? joined.allowed : null,
            (await getFeatureFlags()).membership,
          ),
        );
      case 'player_suspended':
        throw new ExpectedError(
          'Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.',
        );
      case 'already_in_pair':
        throw new ExpectedError('You are already in a pair in this event.');
      case 'category_undeclared':
        throw new ExpectedError(
          categoryRefusalMessage(event.event_type as TournamentEventType, 'undeclared'),
        );
      case 'category_mismatch':
        throw new ExpectedError(
          categoryRefusalMessage(event.event_type as TournamentEventType, 'mismatch'),
        );
      case 'player_not_found':
        throw new Error('Player not found');
      case 'event_not_found':
        throw new Error('Event not found');
      default:
        throw new Error('Could not add you to the waitlist, please try again shortly.');
    }
  }

  // The join's self-heal can enter somebody (this member included) when a
  // place was free while others waited; their fee is settled the same way.
  const promoted = (Array.isArray(joined.promoted) ? joined.promoted : []) as WaitlistPromotion[];
  await settleWaitlistPromotions(service, event.tournament_id, promoted);

  revalidateTournamentPaths(event.tournament_id, eventId);
  const position = typeof joined.position === 'number' ? joined.position : null;
  return { position, entered: promoted.some((p) => p.player_id === player.id) };
}

export async function leaveEventWaitlist(eventId: string): Promise<ActionResult> {
  return runAction(() => leaveEventWaitlistImpl(eventId));
}

async function leaveEventWaitlistImpl(eventId: string): Promise<void> {
  const player = await requirePlayer();
  await assertFeatureOn('tournaments', player);
  const service = createServiceRoleClient();

  const { data: left, error } = await service.rpc('leave_event_waitlist', {
    p_event_id: eventId,
    p_player_id: player.id,
  });
  if (error) {
    if (isWaitlistMissing(error)) {
      Sentry.captureException(new Error(`leave_event_waitlist is missing, migration 00278 is not applied: ${error.message}`));
      throw new ExpectedError(WAITLIST_NOT_AVAILABLE);
    }
    throw new Error(error.message);
  }
  if (!left) throw new Error('Could not take you off the waitlist, please try again shortly.');
  if (!left.ok) {
    if (left.reason === 'not_waiting') throw new ExpectedError('You are not on the waitlist for this event.');
    if (left.reason === 'event_not_found') throw new Error('Event not found');
    throw new Error('Could not take you off the waitlist, please try again shortly.');
  }

  const tournamentId = left.tournament_id as string | undefined;
  if (tournamentId) revalidateTournamentPaths(tournamentId, eventId);
  else revalidatePath('/tournaments');
}

export async function selfCheckIn(eventId: string): Promise<ActionResult> {
  return runAction(() => selfCheckInImpl(eventId));
}

async function selfCheckInImpl(eventId: string) {
  const player = await requirePlayer();
  await assertFeatureOn('tournaments', player);
  if (player.is_banned) {
    throw new ExpectedError('Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.');
  }
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  // Parallel reads — event status and player participation row are independent.
  const [eventRes, participantRes] = await Promise.all([
    service.from('tournament_events')
      .select('status, tournament_id, tournament:tournaments(status, suspended_at, suspension_reason)')
      .eq('id', eventId).maybeSingle(),
    service.from('tournament_participants')
      .select('id, status').eq('event_id', eventId).eq('player_id', player.id).maybeSingle(),
  ]);

  const event = eventRes.data;
  const participant = participantRes.data;
  const checkinTournament = event ? pickSuspension(event.tournament) : null;
  if (checkinTournament?.suspended_at) {
    throw new ExpectedError(`This tournament is currently suspended${checkinTournament.suspension_reason ? `: ${checkinTournament.suspension_reason}` : ''}`);
  }
  // Same ordering as registerForEvent, for the same reason.
  const checkinClosed = refuseClosedTournament(checkinTournament?.status, 'check in');
  if (checkinClosed) throw new ExpectedError(checkinClosed);
  // Split so the two halves classify separately. A wrong STATUS is the member
  // arriving before check-in opens or after it closed — a refusal. A MISSING
  // event on a service-role read is a bad id or a row that went away, which is
  // a fault worth reporting. The member sees the same sentence either way.
  if (!event) throw new Error('Check-in is not open');
  if (event.status !== 'checkin') throw new ExpectedError('Check-in is not open');
  if (!participant) throw new ExpectedError('Not registered');
  if (participant.status !== 'registered') throw new ExpectedError('Cannot check in');

  // THE CHECK-IN WINDOW (00276). Only the member's own check-in is gated; the
  // desk can check anybody in at any time. set_field_entry_status asks again
  // under the lock.
  const checkinWindow = windowsFor(
    await loadEntryWindows(service, { eventIds: [eventId], tournamentIds: [event.tournament_id] }),
    eventId,
    event.tournament_id,
  ).checkin;
  const checkinWindowState = windowState(checkinWindow.opens_at, checkinWindow.closes_at, new Date());
  if (checkinWindowState === 'not_open_yet') {
    throw new ExpectedError(`Check-in opens ${formatWindowInstant(checkinWindow.opens_at!)}`);
  }
  if (checkinWindowState === 'closed') throw new ExpectedError('Check-in has closed, see the desk');

  // THE HARD BLOCK, on the member's own route in. An exec who added them never
  // asked for the event waiver — that is the whole gap — so this is the point
  // where being on the sheet stops being enough. registerForEvent already
  // refuses without an acceptance, but an admin-added entrant never went
  // through it, and an edited waiver un-signs somebody who did.
  await assertMyEventWaiverSigned(service, event.tournament_id, player.id);

  // FENCED — 00201. The member's own check-in took no lock and asked the
  // event's status from a row read several awaits earlier, above: the waiver
  // assertion sits between that read and this write, so the gap is real rather
  // than theoretical. set_field_entry_status re-reads both the entry and the
  // event under the shared field key, so a draw published in the meantime
  // refuses the check-in instead of adding a member to a field it was not
  // generated from.
  //
  // p_actor is null: nobody at a desk checked this person in, they checked
  // themselves in, and writing their own id into checked_in_by would claim an
  // exec was present.
  const { data: checked, error } = await service.rpc('set_field_entry_status', {
    p_entry_id: participant.id,
    p_is_pair: false,
    p_new_status: 'checked_in',
    p_actor: null,
  });
  if (error) throw new Error(error.message);
  const checkedResult = checked as { ok: boolean; reason?: string; event_status?: string; opens_at?: string } | null;
  if (!checkedResult?.ok) {
    // The member sees the same sentence the pre-read guard above would have
    // given them; only the moment it is decided has changed.
    if (checkedResult?.reason === 'event_status' || checkedResult?.reason === 'event_completed') {
      throw new ExpectedError('Check-in is not open');
    }
    if (checkedResult?.reason === 'checkin_not_open') {
      throw new ExpectedError(
        checkedResult.opens_at ? `Check-in opens ${formatWindowInstant(checkedResult.opens_at)}` : 'Check-in is not open',
      );
    }
    if (checkedResult?.reason === 'checkin_window_closed') throw new ExpectedError('Check-in has closed, see the desk');
    if (checkedResult?.reason === 'entry_status') throw new ExpectedError('Cannot check in');
    if (checkedResult?.reason === 'entry_not_found') throw new ExpectedError('Not registered');
    throw new Error('Could not check you in. Try again.');
  }

  revalidateTournamentPaths(event.tournament_id, eventId);
}

/**
 * "I'M HERE" — the member telling the desk they are standing courtside and
 * ready to play this match.
 *
 * THE BUG THIS CAME OUT OF. The event page painted the match's status in a
 * bordered uppercase chip in the right-hand slot of the member's own row, so a
 * match at status 'ready' rendered a thing that looked exactly like a READY
 * button. The owner pressed it repeatedly and reported "it has never worked".
 * It was a label. Rather than make the label look less like a button, the club
 * asked for the button — and it turns out to be the thing the scoring table is
 * missing, because today nobody there knows whether the person whose match is
 * up is even in the building.
 *
 * A TOGGLE, WHICH IS THE UNDO. Somebody taps it and then goes to the toilet;
 * they tap it again on the way and the mark comes off. There is no timeout and
 * no expiry — a flag that silently withdrew itself would be worse than one that
 * is occasionally stale, because the desk would have no way to tell the two
 * apart. The other two ways a mark ends are structural rather than actions:
 * every mark is scoped to ONE match, so the next round starts empty; and the
 * marks are on the match row, so regenerating a draw deletes them with it.
 *
 * NOT eventId-SCOPED LIKE ITS NEIGHBOURS. Every other action in this file is
 * given the event and finds the member's row; this one is given the MATCH,
 * because that is what the control is attached to. The tournament and event ids
 * needed for revalidation are read back from it.
 *
 * NO PARTICIPANT LOOKUP HERE, deliberately. Whether this member is in this
 * match is decided by set_match_ready() inside one statement — it has to be,
 * because a doubles entrant may have no tournament_participants row at all
 * (00102) and because a stray id in that array is data nobody can see in order
 * to fix. The gate is not skipped, it has moved somewhere it cannot be raced.
 */
export async function setMyMatchReady(matchId: string, ready: boolean): Promise<ActionResult> {
  return runAction(() => setMyMatchReadyImpl(matchId, ready));
}

async function setMyMatchReadyImpl(matchId: string, ready: boolean) {
  const player = await requirePlayer();
  await assertFeatureOn('tournaments', player);
  const service = createServiceRoleClient();

  const { data: match } = await service
    .from('tournament_matches')
    .select('id, event_id, event:tournament_events(tournament_id, tournament:tournaments(suspended_at, suspension_reason))')
    .eq('id', matchId)
    .maybeSingle();
  if (!match) throw new ExpectedError('Match not found');

  const event = (Array.isArray(match.event) ? match.event[0] : match.event) as
    { tournament_id?: string; tournament?: unknown } | null;
  const tournamentId = event?.tournament_id;
  if (!tournamentId) throw new Error('Match is not attached to a tournament');

  const suspension = pickSuspension(event?.tournament);
  if (suspension?.suspended_at) {
    throw new ExpectedError(
      `This tournament is currently suspended${suspension.suspension_reason ? `: ${suspension.suspension_reason}` : ''}`,
    );
  }

  // p_player_id is ALWAYS requirePlayer()'s id and never a parameter of this
  // action — the same rule every self-service action in this app follows, and
  // the reason set_match_ready's EXECUTE is service_role only. The function
  // takes an arbitrary player id because the console needs to pass somebody
  // else's; nothing reachable from a browser gets to choose it.
  const { error } = await service.rpc('set_match_ready', {
    p_match_id: matchId,
    p_player_id: player.id,
    p_ready: ready,
  });
  // The refusals this can return are sentences an entrant can act on ("This
  // match is finished"), so they go through the expected channel rather than
  // into Sentry as unhandled.
  if (error) throw new ExpectedError(error.message);

  revalidateTournamentPaths(tournamentId, match.event_id as string);
}
