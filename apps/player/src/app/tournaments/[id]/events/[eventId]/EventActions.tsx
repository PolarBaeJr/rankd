'use client';

import { useState } from 'react';
import { Button, Dialog, useConfirm } from '@badminton/ui';
import { EventWaiverConsent } from '../../EventWaiverConsent';
import { SoloEntryConsent } from '../../SoloEntryConsent';
import { eventHasDraw, isOutOfEvent } from '@badminton/shared';
import { registerForEvent, withdrawFromEvent, selfCheckIn, joinEventWaitlist, leaveEventWaitlist } from '@/lib/tournament-actions';
import type { MyWaitlistState } from '@/lib/event-waitlist';
import { useToast } from '@/components/toast-provider';
import { useStanding } from '@/components/standing-provider';
import { StandingNote } from '@/components/standing-notice';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { UserPlus, UserMinus, CheckCircle, Clock, ArrowRight } from 'lucide-react';

interface Props {
  eventId: string;
  eventStatus: string;
  /**
   * `paired` means a FORMED TEAM; false means a lone entry, which in a doubles
   * event is somebody waiting to be given a partner. `partnerName` is display
   * only and may be null even when `paired` is true — nothing branches on it.
   */
  playerRegistration: {
    status: string;
    paired?: boolean;
    partnerName?: string | null;
  } | null;
  isDoubles: boolean;
  suspended?: boolean;
  eventWaiverText?: string | null;
  /**
   * The member cannot enter until this season's club fee is paid (00260).
   * Replaces the way IN only; an existing entry keeps its controls.
   */
  membershipBlocked?: { message: string; receiptPending: boolean; payHref: string | null } | null;
  /**
   * The registration and check-in windows (00276), as the sentence to show
   * instead of the button while the window is shut. null while it is open.
   */
  registrationNotice?: string | null;
  checkinNotice?: string | null;
  /**
   * The event's waitlist (00278) and where this member stands in it. null when
   * the database has none or the member is already in the event.
   */
  waitlist?: MyWaitlistState | null;
  /**
   * The club event this tournament is run for (00292). Its sign-up is the way
   * in, so it replaces the Register and waitlist buttons (00307).
   */
  clubEvent?: { href: string; title: string } | null;
}

export function EventActions({ eventId, eventStatus, playerRegistration, isDoubles, suspended, eventWaiverText, membershipBlocked, registrationNotice, checkinNotice, waitlist, clubEvent }: Props) {
  const [loading, setLoading] = useState(false);
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  // The doubles acknowledgement, separate from the waiver's: two different
  // things are being agreed to and a tournament may require either, both or
  // neither.
  const [soloAccepted, setSoloAccepted] = useState(false);
  // The same dialog collects the same consents for joining the waitlist,
  // because a promotion later enters the member without asking again.
  const [dialogFor, setDialogFor] = useState<'enter' | 'waitlist'>('enter');
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();
  // `suspended` above is the TOURNAMENT being suspended — a different thing
  // from the member's own standing, which is what this is. registerForEvent,
  // selfCheckIn and withdrawFromEvent all start with requirePlayer().
  const standing = useStanding();

  // A member in a FORMED TEAM — the one doubles state with no self-service
  // controls. Leaving a pair puts the PARTNER back in the pool as well, and
  // nothing here can tell them that happened, so it is an exec action
  // (withdrawPairMember). Name the partner and name who to ask: a chip on its
  // own would read as the app having lost the option.
  const paired = isDoubles && Boolean(playerRegistration?.paired);
  if (paired) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`chip ${playerRegistration!.status === 'checked_in' ? 'chip-success' : ''}`}
          style={playerRegistration!.status !== 'checked_in' ? { borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', color: '#93C5FD' } : undefined}
          role="status"
        >
          <span className="sr-only">Registration status: </span>
          {playerRegistration!.status === 'checked_in' ? '✓ Checked In' : 'Paired'}
        </span>
        <p className="text-xs text-[var(--text-secondary)]">
          {playerRegistration!.partnerName
            ? <>Playing with <strong>{playerRegistration!.partnerName}</strong>.</>
            : 'You have been given a partner.'}
          {' '}Leaving now would put them back in the pool too, so ask a tournament admin if you
          need to withdraw.
        </p>
      </div>
    );
  }

  async function handleRegister(opts?: { eventWaiverAccepted?: boolean; soloEntryAcknowledged?: boolean }) {
    setLoading(true);
    try {
      const res = await registerForEvent(eventId, opts);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast(isDoubles ? 'Entered — waiting for a partner' : 'Registered successfully!', 'success');
      setWaiverOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to register', 'error');
    }
    setLoading(false);
  }

  async function handleJoinWaitlist(opts?: { eventWaiverAccepted?: boolean; soloEntryAcknowledged?: boolean }) {
    setLoading(true);
    try {
      const res = await joinEventWaitlist(eventId, opts);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast(
        res.data.entered
          ? 'A place was free, so you have been entered'
          : `You are on the waitlist${res.data.position ? `, number ${res.data.position}` : ''}`,
        'success',
      );
      setWaiverOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to join the waitlist', 'error');
    }
    setLoading(false);
  }

  async function handleLeaveWaitlist() {
    if (!(await confirm({ title: 'Leave the waitlist?', message: 'You will lose your place in the queue. Joining again puts you at the back.', confirmLabel: 'Leave', danger: true }))) return;
    setLoading(true);
    try {
      const res = await leaveEventWaitlist(eventId);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast('You have left the waitlist', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to leave the waitlist', 'error');
    }
    setLoading(false);
  }

  async function handleWithdraw() {
    if (!(await confirm({ title: 'Withdraw from event?', message: 'Are you sure you want to withdraw from this event?', confirmLabel: 'Withdraw', danger: true }))) return;
    setLoading(true);
    try {
      const res = await withdrawFromEvent(eventId);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast('Withdrawn from event', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to withdraw', 'error');
    }
    setLoading(false);
  }

  async function handleCheckIn() {
    setLoading(true);
    try {
      const res = await selfCheckIn(eventId);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      toast('Checked in!', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to check in', 'error');
    }
    setLoading(false);
  }

  const waiverText = eventWaiverText?.trim();
  // A DOUBLES ENTRY ALWAYS GOES THROUGH THE DIALOG, waiver or no waiver — the
  // acknowledgement is what is being collected and the server refuses without
  // it. Singles with no waiver still enters on one tap.
  const needsDialog = Boolean(waiverText) || isDoubles;
  const canSubmit = (!waiverText || waiverAccepted) && (!isDoubles || soloAccepted);
  const enterOpts = {
    ...(waiverText ? { eventWaiverAccepted: true } : {}),
    ...(isDoubles ? { soloEntryAcknowledged: true } : {}),
  };

  // A tournament run for a club event (00307): the club event is the way in,
  // while entries are still open.
  const clubEventPanel = clubEvent && eventStatus === 'registration' && !suspended ? (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 sm:p-5" role="status">
      <p className="eyebrow mb-1">How to enter</p>
      <h2 className="display-md mb-2">Sign up on {clubEvent.title}</h2>
      <p className="text-sm text-[var(--text-secondary)] mb-4 max-w-prose">
        This tournament is run for the {clubEvent.title} club event. Everyone who signs up there is entered
        here automatically, so there is nothing to register for on this page.
      </p>
      <Link href={clubEvent.href} className="btn btn-primary min-h-[44px]">
        Go to {clubEvent.title}
        <ArrowRight className="w-4 h-4 ml-1.5" aria-hidden="true" />
      </Link>
    </div>
  ) : null;

  // ON THE WAITLIST. Their place in the queue and the way off it, whatever the
  // event's status: once the draw is made nobody is promoted, and they are
  // told so rather than left waiting for a place that cannot open.
  if (!playerRegistration && waitlist?.myPosition) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="chip" role="status">
          <Clock className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
          <span className="sr-only">Waitlist position: </span>Waitlist #{waitlist.myPosition}
        </span>
        <Button
          onClick={handleLeaveWaitlist}
          loading={loading}
          size="sm"
          variant="ghost"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <UserMinus className="w-3.5 h-3.5 mr-1.5" />
          Leave waitlist
        </Button>
        <p className="text-xs text-[var(--text-secondary)] w-full">
          {eventHasDraw(eventStatus)
            ? 'The draw has been made, so no more places will open up in this event.'
            : eventStatus === 'checkin'
              ? 'Check-in has started. Places can still open up until the draw is made.'
              : waitlist.autoPromote
                ? 'If a place opens up you will be entered automatically, in queue order, and notified.'
                : 'If a place opens up the tournament admins choose who goes in, and you will be notified.'}
        </p>
      </div>
    );
  }

  // Registration status chips (below) still render; only the live controls go.
  if (!standing.ok && !playerRegistration) {
    return eventStatus === 'registration'
      ? <StandingNote standing={standing} activity="Entries" />
      : null;
  }

  if (!playerRegistration) {
    if (eventStatus === 'registration' && !suspended) {
      if (clubEventPanel) return clubEventPanel;
      if (membershipBlocked) {
        return (
          <div className="space-y-1" role="status">
            <p className="text-xs text-[var(--text-secondary)]">
              {membershipBlocked.message}
              {membershipBlocked.receiptPending && ' Your receipt is waiting for an exec to confirm it.'}
            </p>
            {membershipBlocked.payHref && (
              <Link href={membershipBlocked.payHref} className="text-xs font-medium text-[var(--color-accent)]">
                Go to Membership
              </Link>
            )}
          </div>
        );
      }
      if (registrationNotice) {
        return <p className="text-xs text-[var(--text-secondary)]" role="status">{registrationNotice}</p>;
      }
      // A full event, or one with people already queueing: the way in is the
      // waitlist, because enter_tournament_event refuses a queue jump.
      const joinWaitlist = Boolean(waitlist?.enabled && (waitlist.full || waitlist.waitingCount > 0));
      if (joinWaitlist && !needsDialog) {
        return (
          <div className="space-y-1">
            <Button
              onClick={() => handleJoinWaitlist()}
              loading={loading}
              size="sm"
              className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            >
              <Clock className="w-3.5 h-3.5 mr-1.5" />
              Join waitlist
            </Button>
            <p className="text-xs text-[var(--text-secondary)]">
              {waitlist!.full ? 'This event is full.' : 'Others are already waiting for this event.'}
              {waitlist!.waitingCount > 0 ? ` ${waitlist!.waitingCount} on the waitlist.` : ''}
            </p>
          </div>
        );
      }
      if (needsDialog) {
        return (
          <>
            <Button
              onClick={() => { setWaiverAccepted(false); setSoloAccepted(false); setDialogFor(joinWaitlist ? 'waitlist' : 'enter'); setWaiverOpen(true); }}
              loading={loading}
              size="sm"
              className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            >
              {joinWaitlist ? <Clock className="w-3.5 h-3.5 mr-1.5" /> : <UserPlus className="w-3.5 h-3.5 mr-1.5" />}
              {joinWaitlist ? 'Join waitlist' : isDoubles ? 'Enter on your own' : 'Register'}
            </Button>
            {joinWaitlist && (
              <p className="text-xs text-[var(--text-secondary)]">
                {waitlist!.full ? 'This event is full.' : 'Others are already waiting for this event.'}
                {waitlist!.waitingCount > 0 ? ` ${waitlist!.waitingCount} on the waitlist.` : ''}
              </p>
            )}
            <Dialog
              open={waiverOpen}
              onClose={() => setWaiverOpen(false)}
              title={dialogFor === 'waitlist' ? 'Join the waitlist' : isDoubles ? 'Enter without a partner' : 'Event waiver'}
            >
              <div className="space-y-4">
                {isDoubles && (
                  <SoloEntryConsent accepted={soloAccepted} onAcceptedChange={setSoloAccepted} />
                )}
                {waiverText && (
                  <EventWaiverConsent
                    text={waiverText}
                    accepted={waiverAccepted}
                    onAcceptedChange={setWaiverAccepted}
                  />
                )}
                <div className="flex items-center justify-between">
                  <Button variant="ghost" type="button" onClick={() => setWaiverOpen(false)}>Cancel</Button>
                  <Button
                    loading={loading}
                    disabled={!canSubmit}
                    onClick={() => (dialogFor === 'waitlist' ? handleJoinWaitlist(enterOpts) : handleRegister(enterOpts))}
                  >
                    {dialogFor === 'waitlist' ? 'Join waitlist' : 'Enter'}
                  </Button>
                </div>
              </div>
            </Dialog>
          </>
        );
      }
      return (
        <Button
          onClick={() => handleRegister()}
          loading={loading}
          size="sm"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <UserPlus className="w-3.5 h-3.5 mr-1.5" />
          Register
        </Button>
      );
    }
    return null;
  }

  const regStatus = playerRegistration.status;
  const stillIn = regStatus === 'registered' || regStatus === 'checked_in';
  const outOfEvent = isOutOfEvent(regStatus);
  // Once the bracket exists, withdrawing has to forfeit your matches and move
  // the round above — an admin action, not a self-service one. The server
  // refuses it either way; hiding the button keeps the two in step.
  const drawPublished = eventHasDraw(eventStatus);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* An unpaired doubles entrant. No Check In: check-in in a doubles event
          happens on the PAIR, so offering it here is a button for a court they
          cannot yet take. Withdraw stays — leaving before you are paired
          affects nobody else, which is exactly why it is still theirs to do. */}
      {isDoubles && stillIn && (
        <span className="chip" style={{ borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', color: '#93C5FD' }} role="status">
          <span className="sr-only">Registration status: </span>Waiting for a partner
        </span>
      )}
      {!isDoubles && regStatus === 'registered' && eventStatus === 'checkin' && !suspended && standing.ok && checkinNotice && (
        <p className="text-xs text-[var(--text-secondary)]" role="status">{checkinNotice}</p>
      )}
      {!isDoubles && regStatus === 'registered' && eventStatus === 'checkin' && !suspended && standing.ok && !checkinNotice && (
        <Button
          onClick={handleCheckIn}
          loading={loading}
          size="sm"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
          Check In
        </Button>
      )}
      {stillIn && !drawPublished && standing.ok && (
        <Button
          onClick={handleWithdraw}
          loading={loading}
          size="sm"
          variant="ghost"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <UserMinus className="w-3.5 h-3.5 mr-1.5" />
          Withdraw
        </Button>
      )}
      {/* The button does not just disappear — say who can do it now, or the
          only reading available is that the app has lost the option. */}
      {stillIn && drawPublished && (
        <p className="text-xs text-[var(--text-secondary)] italic">
          You are in the draw. Ask a tournament admin if you need to withdraw.
        </p>
      )}
      {/* Registered, but check-in and withdrawal are both server-refused —
          say so rather than leave a bare chip where two buttons used to be. */}
      {stillIn && !drawPublished && !standing.ok && (
        <StandingNote standing={standing} activity="Check-in and withdrawal" />
      )}
      {outOfEvent && regStatus === 'withdrawn' && clubEventPanel}
      {outOfEvent && !(regStatus === 'withdrawn' && clubEventPanel) && (
        <p className="text-xs text-[var(--text-secondary)] italic">
          {regStatus === 'withdrawn'
            ? 'You have withdrawn from this event.'
            : 'You have been disqualified from this event.'}
        </p>
      )}
    </div>
  );
}
