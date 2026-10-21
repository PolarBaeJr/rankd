// The body of entering a tournament event, shared by the web action
// (registerForEvent) and the Discord route (/api/discord/tournament-entry).
// NOT a 'use server' module: nothing here may be reachable as a Server Action,
// because the acting player is a parameter. challenges-core.ts is the
// precedent.
//
// The checks that come BEFORE the body (standing, the feature flag, the legal
// documents) stay with the callers, since each door resolves its player
// differently, and so does revalidatePath. The one thing the web read from the
// request, the user agent stored beside an event waiver acceptance, is a
// parameter here: the Discord door passes null and never sends
// eventWaiverAccepted, so it can never create a signed record.
import * as Sentry from '@sentry/nextjs';
import type { createServiceRoleClient } from './supabase-server';
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
  formatWindowInstant,
  windowState,
  type TournamentEventType,
} from '@badminton/shared';
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import { getFeatureFlags } from './feature-gate';
import { refuseClosedTournament } from './tournament-closed';
import { loadEntryWindows, windowsFor } from './tournament-windows';

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

/** What the body reads off the acting player. */
export type EntryPlayer = {
  id: string;
  membership_type?: string | null;
  is_exec?: boolean | null;
  fee_exempt?: boolean | null;
  competition_category?: unknown;
};

// Supabase may return a to-one embed as object-or-array — unwrap defensively.
function pickSuspension(embed: unknown): {
  suspended_at: string | null;
  suspension_reason: string | null;
  waiver_text?: string | null;
  status?: string | null;
} | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  return (row as { suspended_at: string | null; suspension_reason: string | null; waiver_text?: string | null; status?: string | null } | null) ?? null;
}

function pickAllowedMemberships(embed: unknown): string[] | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  const value = (row as { allowed_memberships?: string[] | null } | null)?.allowed_memberships;
  return Array.isArray(value) ? value : null;
}

function pickSeasonId(embed: unknown): string | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  return (row as { season_id?: string | null } | null)?.season_id ?? null;
}

/**
 * Enter `player` in `eventId`, or throw the refusal. Returns the tournament so
 * the caller can revalidate its pages.
 */
export async function enterEventCore(
  service: ReturnType<typeof createServiceRoleClient>,
  player: EntryPlayer,
  eventId: string,
  opts: RegisterOptions | undefined,
  userAgent: string | null,
): Promise<{ tournamentId: string }> {
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
    p_user_agent: eventWaiverText ? userAgent : null,
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

  return { tournamentId: event.tournament_id };
}
