'use client';

import { useState } from 'react';
import { Button, Dialog, useConfirm } from '@badminton/ui';
import { EventWaiverConsent } from './EventWaiverConsent';
import { SoloEntryConsent } from './SoloEntryConsent';
import { AttendancePolicyConsent } from './AttendancePolicyConsent';
import { registerForEvent, withdrawFromEvent, selfCheckIn } from '@/lib/tournament-actions';
import type { ActionResult } from '@/lib/actions/_shared';
import { useToast } from '@/components/toast-provider';
import { useStanding } from '@/components/standing-provider';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface Props {
  eventId: string;
  eventStatus: string;
  /**
   * `paired` means a FORMED TEAM; false means a lone entry, which in a doubles
   * event is somebody still waiting to be given a partner. `partnerName` is
   * display only and may be null even when `paired` is true — nothing branches
   * on it, or a member whose partner's name failed to resolve would be told
   * they have no partner and handed a button the server refuses.
   */
  registration: { status: string; paired?: boolean; partnerName?: string | null } | null;
  isDoubles: boolean;
  suspended?: boolean;
  eventWaiverText?: string | null;
  /**
   * Shown instead of the entry button when the member cannot enter until this
   * season's club fee is paid (00260). Only replaces the way IN: an existing
   * entry keeps its Withdraw and Check In.
   */
  membershipBlocked?: string | null;
  /**
   * The registration and check-in windows (00276), as the sentence to show
   * instead of the button while the window is shut. null while it is open.
   */
  registrationNotice?: string | null;
  checkinNotice?: string | null;
  /** The attendance_policy_ack switch: the policy is shown and accepted at entry. */
  policyOn?: boolean;
}

export function EventRegistrationButton({ eventId, eventStatus, registration, isDoubles, suspended, eventWaiverText, membershipBlocked, registrationNotice, checkinNotice, policyOn = false }: Props) {
  const [loading, setLoading] = useState(false);
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  // The doubles acknowledgement. Its own state and not folded into
  // `waiverAccepted`, because they are two different things being agreed to and
  // a tournament may require one, the other, both or neither.
  const [soloAccepted, setSoloAccepted] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  // Set when an entry is refused because others are queueing (00278): the
  // waitlist lives on the event's own page, so this row points there.
  const [waitlistLink, setWaitlistLink] = useState(false);
  const { id: tournamentId } = useParams<{ id: string }>();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();
  // Member standing, not the tournament's `suspended` flag above. This is the
  // compact per-event row on the tournament page; the event's own page carries
  // the explanation, and the app-wide banner carries it everywhere, so here we
  // only withhold the buttons and leave the status chips.
  const standing = useStanding();

  // A member in a FORMED TEAM. This is the only doubles state that still has no
  // controls: leaving a pair takes somebody else's team away from them and puts
  // them back in the pool, so it is an exec action — see withdrawFromEvent. Say
  // who the partner is and who to ask, rather than showing a bare chip and
  // letting the missing button read as the app having lost the option.
  if (isDoubles && registration?.paired) {
    return (
      <div className="flex items-center gap-1.5">
        <span
          className={`chip ${registration.status === 'checked_in' ? 'chip-success' : 'chip-info'}`}
          role="status"
        >
          <span className="sr-only">Registration status: </span>
          {registration.status === 'checked_in' ? 'Checked In' : 'Paired'}
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">
          {registration.partnerName ? `with ${registration.partnerName}` : 'with your partner'}
        </span>
      </div>
    );
  }

  async function act(fn: () => Promise<ActionResult>, msg: string) {
    setLoading(true);
    try {
      const res = await fn();
      if (!res.ok) {
        toast(res.error, 'error');
        if (res.error.includes('join the waitlist')) {
          setWaiverOpen(false);
          setWaitlistLink(true);
        }
        setLoading(false);
        return;
      }
      toast(msg, 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  const waiverText = eventWaiverText?.trim();
  // A DOUBLES ENTRY ALWAYS GOES THROUGH THE DIALOG, waiver or no waiver: the
  // acknowledgement is the thing being collected, and registerForEvent refuses
  // without it. A singles entry with no waiver still registers on one tap,
  // unless the attendance policy is being asked.
  const needsDialog = Boolean(waiverText) || isDoubles || policyOn;
  const canSubmit = (!waiverText || waiverAccepted) && (!isDoubles || soloAccepted) && (!policyOn || policyAccepted);

  if (!registration) {
    if (waitlistLink && tournamentId) {
      return (
        <Link
          href={`/tournaments/${tournamentId}/events/${eventId}`}
          className="text-xs font-medium text-[var(--color-accent)]"
        >
          Join the waitlist
        </Link>
      );
    }
    if (eventStatus === 'registration' && !suspended && standing.ok) {
      if (membershipBlocked) {
        return (
          <span className="text-[10px] text-[var(--text-muted)]" role="status">{membershipBlocked}</span>
        );
      }
      if (registrationNotice) {
        return (
          <span className="text-[10px] text-[var(--text-muted)]" role="status">{registrationNotice}</span>
        );
      }
      if (needsDialog) {
        return (
          <>
            <Button
              size="sm"
              loading={loading}
              onClick={() => { setWaiverAccepted(false); setSoloAccepted(false); setPolicyAccepted(false); setWaiverOpen(true); }}
              className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
            >
              Enter
            </Button>
            <Dialog
              open={waiverOpen}
              onClose={() => setWaiverOpen(false)}
              title={isDoubles ? 'Enter without a partner' : waiverText ? 'Event waiver' : 'Enter this event'}
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
                {policyOn && (
                  <AttendancePolicyConsent accepted={policyAccepted} onAcceptedChange={setPolicyAccepted} />
                )}
                <div className="flex items-center justify-between">
                  <Button variant="ghost" type="button" onClick={() => setWaiverOpen(false)}>Cancel</Button>
                  <Button
                    loading={loading}
                    disabled={!canSubmit}
                    onClick={() =>
                      act(async () => {
                        const r = await registerForEvent(eventId, {
                          ...(waiverText ? { eventWaiverAccepted: true } : {}),
                          ...(isDoubles ? { soloEntryAcknowledged: true } : {}),
                          ...(policyOn ? { attendancePolicyAcknowledged: true } : {}),
                        });
                        if (r.ok) setWaiverOpen(false);
                        return r;
                      }, isDoubles ? 'Entered — waiting for a partner' : 'Registered!')
                    }
                  >
                    Enter
                  </Button>
                </div>
              </div>
            </Dialog>
          </>
        );
      }
      return (
        <Button
          size="sm"
          loading={loading}
          onClick={() => act(() => registerForEvent(eventId), 'Registered!')}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
        >
          Register
        </Button>
      );
    }
    return null;
  }

  const s = registration.status;
  // An unpaired doubles entrant: entered, invoiced, signed — and with no team
  // yet, so nothing to check in. Check-in in a doubles event is done on the
  // PAIR, and offering it here would be a button for a court they cannot take.
  const waitingForPartner = isDoubles;

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.preventDefault()}>
      {waitingForPartner && (
        <span className="chip chip-info" role="status">
          <span className="sr-only">Registration status: </span>Waiting for a partner
        </span>
      )}
      {!waitingForPartner && s === 'registered' && eventStatus === 'checkin' && !suspended && standing.ok && checkinNotice && (
        <span className="text-[10px] text-[var(--text-muted)]" role="status">{checkinNotice}</span>
      )}
      {!waitingForPartner && s === 'registered' && eventStatus === 'checkin' && !suspended && standing.ok && !checkinNotice && (
        <Button
          size="sm"
          loading={loading}
          onClick={() => act(() => selfCheckIn(eventId), 'Checked in!')}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
        >
          Check In
        </Button>
      )}
      {(s === 'registered' || s === 'checked_in') && eventStatus !== 'completed' && standing.ok && (
        <Button
          size="sm"
          variant="ghost"
          loading={loading}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
          onClick={async () => {
            if (await confirm({ title: 'Withdraw from event?', message: 'Are you sure you want to withdraw from this event?', confirmLabel: 'Withdraw', danger: true })) {
              act(() => withdrawFromEvent(eventId), 'Withdrawn');
            }
          }}
        >
          Withdraw
        </Button>
      )}
      {!waitingForPartner && s === 'checked_in' && (
        <span className="chip chip-success" role="status">
          <span className="sr-only">Registration status: </span>Checked In
        </span>
      )}
      {!waitingForPartner && s === 'registered' && eventStatus !== 'checkin' && (
        <span
          className="chip chip-info"
          role="status"
        >
          <span className="sr-only">Registration status: </span>Registered
        </span>
      )}
    </div>
  );
}
