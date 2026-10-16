'use server';

import { headers } from 'next/headers';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from './supabase-server';
import { revalidatePath } from 'next/cache';
import {
  ensureEntryFees,
  isDoublesEvent,
  isFeeExempt,
  loadPaidDues,
  membershipRefusalMessage,
  membershipUnpaidMessage,
  resolveEntrySeasonId,
  screenMembershipEntry,
  screenSelfEntry,
  categoryRefusalMessage,
  toCompetitionCategory,
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

// Same object-or-array unwrap as pickSuspension, for the eligibility list.
function pickAllowedMemberships(embed: unknown): string[] | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  const value = (row as { allowed_memberships?: string[] | null } | null)?.allowed_memberships;
  return Array.isArray(value) ? value : null;
}

// Same unwrap again, for the season the entry's dues are looked up in.
function pickSeasonId(embed: unknown): string | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  return (row as { season_id?: string | null } | null)?.season_id ?? null;
}

/**
 * What the member has to have been TOLD before this runs.
 *
 * Both flags are the server's copy of something the dialog said out loud, and
 * neither is a UI convenience: a request that arrives without one is refused,
 * so the sentence cannot be skipped by a client that forgot to render it.
 * `eventWaiverAccepted` already worked this way; `soloEntryAcknowledged` is the
 * same fiction for the same reason.
 */
export interface RegisterOptions {
  eventWaiverAccepted?: boolean;
  /**
   * DOUBLES ONLY, AND REQUIRED THERE. Entering a doubles event on your own is a
   * commitment to play with whoever you are given — the exec pairs you later —
   * and finding that out when a partner appears is not consent. This is set by
   * the dialog that says so, and nothing else sets it.
   */
  soloEntryAcknowledged?: boolean;
}

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

  // Parallelize the three independent reads needed before we can validate.
  // `.maybeSingle()` instead of `.single()` so a missing existing row isn't
  // surfaced as a thrown PGRST116 error.
  const [eventRes, existingRes, existingPairRes, ratingRes] = await Promise.all([
    service.from('tournament_events')
      .select('id, status, event_type, tournament_id, max_participants, external_event, tournament:tournaments(status, suspended_at, suspension_reason, waiver_text, allowed_memberships, season_id)')
      .eq('id', eventId).maybeSingle(),
    service.from('tournament_participants')
      .select('id, status').eq('event_id', eventId).eq('player_id', player.id).maybeSingle(),
    // THE OTHER WAY TO ALREADY BE IN A DOUBLES EVENT. Since 00102 a member can
    // be an unpaired entrant (a participant row) OR half of a formed pair, and
    // the second has no participant row at all — so the existing check above
    // would wave a paired member straight through into a second entry.
    service.from('tournament_pairs')
      .select('id').eq('event_id', eventId)
      .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
      .limit(1),
    // Both disciplines' ratings. elo_before is stamped at registration and a
    // doubles entrant is rated on doubles_elo — it is the number the pool shows
    // and the number the team they end up in would be built from.
    service.from('ratings').select('singles_elo, doubles_elo').eq('player_id', player.id).maybeSingle(),
  ]);

  // FAIL CLOSED ON EVERY PREREQUISITE. All four of these reads answer a
  // question whose failure mode is silently permissive: a failed pair read is
  // "not in a pair", a failed participant read is "not registered", a failed
  // rating read is Elo 400. Awaiting a Supabase call is not error handling —
  // PostgREST failures resolve, they do not reject — so each one has to be
  // inspected or the guards below are decided by an outage.
  for (const [what, res] of [
    ['event', eventRes],
    ['existing entry', existingRes],
    ['existing pair', existingPairRes],
    ['rating', ratingRes],
  ] as const) {
    if (res.error) {
      Sentry.captureException(res.error, { tags: { action: 'registerForEvent', read: what } });
      throw new ExpectedError('Cannot process your entry right now — please try again shortly');
    }
  }

  const event = eventRes.data;
  if (!event) throw new Error('Event not found');
  // An external event (00269) is entered by the organisers, by name. The DB refuses
  // the participant row too; this says why.
  if (event.external_event) throw new ExpectedError('This event is entered by the organisers.');
  const regTournament = pickSuspension(event.tournament);
  if (regTournament?.suspended_at) {
    throw new ExpectedError(`This tournament is currently suspended${regTournament.suspension_reason ? `: ${regTournament.suspension_reason}` : ''}`);
  }
  // BEFORE the event's own status, because a finished tournament is the true
  // reason and the more useful sentence. "Registration is closed" on an event
  // still sitting at `registration` inside an archived tournament reads as a
  // bug; nothing here told the member the tournament itself had ended.
  const regClosed = refuseClosedTournament(regTournament?.status, 'enter this event');
  if (regClosed) throw new ExpectedError(regClosed);
  // Membership gate. Some events are internal-only, some admit alumni, some are
  // open. Enforced here rather than in RLS because this action uses the
  // service-role key, which bypasses policies entirely — a policy would look
  // like protection and do nothing.
  //
  // Admin-added participants deliberately skip this: adding someone by hand in
  // the admin app is an explicit override, not a loophole.
  //
  // The group is the one the member ENTERS as (00260): internal means this
  // season's club fee is paid, so the stored membership_type alone decides
  // nothing. Only asked when the event restricts entry at all.
  const allowedMemberships = pickAllowedMemberships(event.tournament);
  if (allowedMemberships && allowedMemberships.length > 0) {
    const season = await resolveEntrySeasonId(service, pickSeasonId(event.tournament));
    const paidDues = season.error ? null : await loadPaidDues(service, season.seasonId, [player.id]);
    // FAIL CLOSED, like every other prerequisite above. A failed dues read is
    // not "unpaid" (that would refuse a paid member) and not "paid" (that
    // would admit an unpaid one); it is a read to retry.
    if (!paidDues) {
      Sentry.captureException(season.error ?? new Error('dues read failed'), {
        tags: { action: 'registerForEvent', read: 'dues' },
      });
      throw new ExpectedError('Cannot process your entry right now, please try again shortly');
    }
    const membershipScreen = screenMembershipEntry(
      {
        stored: player.membership_type,
        exempt: isFeeExempt(player),
        paid: paidDues.has(player.id),
        hasSeason: season.seasonId !== null,
      },
      allowedMemberships,
    );
    if (!membershipScreen.ok) {
      // Only point at the Membership page while it is switched on.
      throw new ExpectedError(
        membershipScreen.reason === 'membership_unpaid'
          ? membershipUnpaidMessage(allowedMemberships, (await getFeatureFlags()).membership)
          : membershipScreen.message,
      );
    }
  }

  if (event.status !== 'registration') throw new ExpectedError('Registration is closed');

  // THE REGISTRATION WINDOW (00276), on top of the status and never instead of
  // it. enter_tournament_event asks again under the lock; this is the early,
  // readable answer. Read on its own so a database without 00276 is no window.
  const regWindow = windowsFor(
    await loadEntryWindows(service, { eventIds: [eventId], tournamentIds: [event.tournament_id] }),
    eventId,
    event.tournament_id,
  ).registration;
  const regWindowState = windowState(regWindow.opens_at, regWindow.closes_at, new Date());
  if (regWindowState === 'not_open_yet') {
    throw new ExpectedError(`Registration opens ${formatWindowInstant(regWindow.opens_at!)}`);
  }
  if (regWindowState === 'closed') {
    throw new ExpectedError(`Registration closed ${formatWindowInstant(regWindow.closes_at!)}`);
  }

  // THE COMPETITION CATEGORY GATE (00111), and the reason it exists at all.
  // event_type has said 'womens_singles' since 00001 with nothing enforcing it,
  // which was survivable while only an exec could put somebody in an event. This
  // action is the path that made it a real hole: the member enters THEMSELVES.
  //
  // STRICTER HERE THAN IN THE CONSOLE, deliberately and in both directions:
  // this refuses an undeclared member, the console does not. Adding somebody by
  // hand is an explicit override by a named exec — the same line the membership
  // gate above draws, in the same words — whereas nobody overrides themselves.
  // The refusal carries the remedy, because a member who cannot act on it will
  // just ask anyway — and since 00129 the remedy differs by branch: an
  // UNDECLARED member is sent to Settings, where the Gender control is still
  // theirs to set, while a MISMATCH is by definition somebody who has already
  // declared and therefore somebody the write-once lock refuses, so they are
  // sent to an exec. Both also get the Open events, which need nobody.
  //
  // Open events reach none of this: screenSelfEntry returns ok for them, which
  // is what keeps an undeclared member playing tournaments.
  const categoryScreen = screenSelfEntry(
    event.event_type as TournamentEventType,
    toCompetitionCategory(player.competition_category),
  );
  if (!categoryScreen.ok) throw new ExpectedError(categoryScreen.message);

  // ---------------------------------------------------------------------
  // ENTERING A DOUBLES EVENT ON YOUR OWN
  // ---------------------------------------------------------------------
  // "i need it to be allowed to join" — the club owner. This used to throw
  // 'Use pair registration for doubles events', which was true because there was
  // no way to be in a doubles event without a partner. Since 00102 there is: the
  // member enters the POOL and an exec pairs them later.
  //
  // SOLO ONLY. Entering as a self-selected pair is deliberately still
  // admin-managed — one member cannot enter another, because that needs the
  // partner's own consent, which needs an invite and an accept and states for
  // both. That is a separate feature and this is not half of it.
  //
  // THE ACKNOWLEDGEMENT IS A HARD GATE, not a tick box the client may skip.
  // Being paired with a stranger is the substance of what is being agreed to
  // here, and a member who finds that out when a partner appears was never
  // asked. Refused server-side so that no client can register somebody who was
  // not shown the sentence.
  const doubles = isDoublesEvent(event.event_type);
  if (doubles && !opts?.soloEntryAcknowledged) {
    throw new ExpectedError(
      'Entering a doubles event on your own means the exec will pair you with another member. ' +
      'Confirm that before you enter.',
    );
  }
  if (doubles && (existingPairRes.data?.length ?? 0) > 0) {
    throw new ExpectedError('You are already in a pair in this event.');
  }

  // A WITHDRAWN ROW IS STILL A ROW, and the insert below would collide with it
  // on UNIQUE(event_id, player_id). Saying "Already registered" to somebody
  // looking at their own withdrawal is the one reading that cannot be right, so
  // the two cases are separated. Re-entry is deliberately NOT an UPDATE here:
  // resurrecting a withdrawn entry is an exec decision with its own fee and cap
  // consequences, and it is already reachable from the console.
  if (existingRes.data) {
    if (existingRes.data.status === 'withdrawn' || existingRes.data.status === 'disqualified') {
      throw new ExpectedError(
        'You have already left this event. Ask a tournament admin if you want to enter it again.',
      );
    }
    throw new ExpectedError('Already registered');
  }

  // Event waiver gate — the tournament may require its own waiver before
  // registering. The client must confirm acceptance; the hash is always taken
  // from the server-side text, never a client-supplied value.
  const eventWaiverText = regTournament?.waiver_text?.trim();
  if (eventWaiverText && !opts?.eventWaiverAccepted) {
    throw new ExpectedError('You must accept the event waiver to register');
  }

  // NO 400 FALLBACK. elo_before is a snapshot that seeding, the pool display
  // and the legacy undo path all read back as fact, so inventing 400 for a
  // member whose rating row simply failed to load contaminates all three and
  // leaves no trace that it was a guess. A member with no rating row at all is
  // an integrity problem to repair, not a number to make up.
  const eloBefore = doubles ? ratingRes.data?.doubles_elo : ratingRes.data?.singles_elo;
  if (eloBefore == null) {
    Sentry.captureMessage('registerForEvent: no rating row for player', {
      level: 'error',
      tags: { action: 'registerForEvent', playerId: player.id, discipline: doubles ? 'doubles' : 'singles' },
    });
    throw new ExpectedError('Your club rating is not set up yet — contact an exec before entering.');
  }

  // THE THREE COUNTS AND THE INSERT, IN ONE TRANSACTION — audit F-004.
  //
  // Capacity, the per-member cap and the event's own status used to be read
  // here and acted on hundreds of milliseconds later, under the SERVICE ROLE,
  // so RLS was not in the picture and nothing held any of it still. Two members
  // entering a 16-slot event with 15 entries both counted 15 and both inserted;
  // an exec generating the draw in that window got a bracket built from a field
  // that gained somebody afterwards, leaving an entrant in the event and in no
  // match.
  //
  // 00185 takes the event row FOR UPDATE and does all three inside it. The
  // counting now has ONE implementation and it is that function — the reads
  // that used to live here are gone rather than kept as a fast path, because
  // two copies of "is this event full" is how the screen ends up promising a
  // place this action refuses.
  // The waiver travels WITH the entry now (00193). It used to be written after
  // this call returned, with its result discarded, so a member could end up
  // registered with no acceptance record at all — best-effort storage for the
  // one artefact whose entire purpose is to be evidence. The function refuses an
  // entry that brings no hash when the tournament has a waiver, so this is also
  // the gate rather than a copy of it.
  const enterWaiverHash = eventWaiverText ? eventWaiverHash(eventWaiverText) : null;
  const { data: entered, error: enterErr } = await service.rpc('enter_tournament_event', {
    p_event_id: eventId,
    p_player_id: player.id,
    p_elo_before: eloBefore,
    p_doubles: doubles,
    p_waiver_hash: enterWaiverHash,
    p_user_agent: eventWaiverText ? (await headers()).get('user-agent') : null,
  });
  if (enterErr) throw new Error(enterErr.message);
  if (!entered) throw new Error('Could not complete your entry — please try again shortly.');
  if (!entered.ok) {
    switch (entered.reason) {
      case 'event_full':
        // 00278 says whether this event keeps a waitlist, so the member is
        // pointed at it rather than told only that the door is shut.
        if (entered.waitlist === true) throw new ExpectedError('Event is full, join the waitlist');
        throw new ExpectedError('Event is full');
      // 00278: somebody is already waiting, so a free place is theirs.
      case 'waitlist_queue':
        throw new ExpectedError('Others are waiting for this event, join the waitlist');
      case 'registration_closed':
        throw new ExpectedError('Registration is closed');
      // The window (00276) moved between the check above and the lock.
      case 'registration_not_open':
        throw new ExpectedError(
          entered.opens_at ? `Registration opens ${formatWindowInstant(entered.opens_at)}` : 'Registration is closed',
        );
      case 'registration_window_closed':
        throw new ExpectedError(
          entered.closes_at ? `Registration closed ${formatWindowInstant(entered.closes_at)}` : 'Registration is closed',
        );
      case 'entry_cap':
        throw new ExpectedError(
          `You are already entered in ${entered.cap} ${entered.cap === 1 ? 'event' : 'events'} at this tournament, which is the limit. ` +
          // "Withdraw from one" is not advice a member in a formed doubles pair
          // can act on — leaving a pair is an exec action, because it takes
          // somebody else's team away from them. Don't tell them to do
          // something the app will refuse.
          'Withdraw from one to enter another, or ask a tournament admin if one of them is a doubles pair.',
        );
      case 'already_registered':
        throw new ExpectedError('Already registered');
      // The application checked this above; reaching it here means the two
      // disagreed, which is worth a distinct sentence rather than the generic
      // retry message.
      case 'waiver_required':
        throw new ExpectedError('You must accept the event waiver to register');
      // THE FIVE ELIGIBILITY REFUSALS 00196 MOVED INSIDE THE LOCK. Every one of
      // them is also checked above, so reaching one here means the check and the
      // function disagreed — which is precisely the race 00196 closes, and is a
      // permanent refusal rather than something to retry. Telling a member whose
      // tournament was archived mid-dialog to "try again shortly" is an
      // instruction they can follow forever.
      case 'tournament_suspended':
        throw new ExpectedError(
          `This tournament is currently suspended${entered.suspension_reason ? `: ${entered.suspension_reason}` : ''}`,
        );
      case 'tournament_closed':
        // Same sentence the app-side gate produces, from the same helper, so the
        // member cannot get two different answers to the same question.
        throw new ExpectedError(
          refuseClosedTournament(entered.status, 'enter this event')
          ?? 'This tournament has ended.',
        );
      case 'membership_not_allowed':
        throw new ExpectedError(
          membershipRefusalMessage(Array.isArray(entered.allowed) ? entered.allowed : null),
        );
      // The club fee was marked unpaid between the screen above and the lock.
      case 'membership_unpaid':
        throw new ExpectedError(
          membershipUnpaidMessage(
            Array.isArray(entered.allowed) ? entered.allowed : null,
            (await getFeatureFlags()).membership,
          ),
        );
      case 'player_suspended':
        throw new ExpectedError(
          'Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.',
        );
      case 'already_in_pair':
        throw new ExpectedError('You are already in a pair in this event.');
      // THE COMPETITION CATEGORY, RE-ASKED UNDER THE LOCK (00200). screenSelfEntry
      // ran above, so reaching either of these means an exec changed this
      // member's Gender in the window between that screen and the insert — the
      // one race the app-side gate could never win, because competition_category
      // is only writable from the console and the console does not wait for us.
      //
      // The sentence comes from the same helper screenSelfEntry uses, built from
      // the event type this action already holds. The function returns a reason
      // and never the member's category, so this is the only place the wording
      // exists and a member who loses the race reads what one who never entered
      // it would have read.
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
        throw new Error('Could not complete your entry — please try again shortly.');
    }
  }

  // What this entry costs, on the club's fee ledger, priced from the group the
  // member enters as (their membership_type, corrected by this season's dues). Deliberately AFTER the participant row and deliberately
  // not awaited for its success: the member is registered either way, and
  // ensureEntryFees never throws for exactly that reason. Per tournament, not
  // per event, so entering a second event here finds the existing row.
  await ensureEntryFees(service, event.tournament_id, [player.id]);

  revalidateTournamentPaths(event.tournament_id, eventId);
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
