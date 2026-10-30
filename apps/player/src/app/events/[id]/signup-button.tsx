'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@badminton/ui';
import type { ClubEventSignupState } from '@badminton/shared';
import {
  joinClubEventWaitlist,
  leaveClubEventWaitlist,
  signUpForClubEvent,
  signUpWithReceipt,
  withdrawFromClubEvent,
} from '@/lib/club-event-actions';
import { useToast } from '@/components/toast-provider';
import { EtransferForm } from '@/app/membership/etransfer-form';

/** A paid event's fee, when this member must send a receipt to sign up. */
export interface SignupFee {
  amount: string;
  /** Where to send it; null when the club has not set one, and nobody can pay. */
  etransferEmail: string | null;
}

type Act = 'sign_up' | 'withdraw' | 'join' | 'leave';

const DONE: Record<Act, string> = {
  sign_up: 'You are signed up',
  withdraw: 'You are no longer signed up',
  join: 'You are on the waitlist. We will tell you here if a place opens.',
  leave: 'You left the waitlist',
};

// The "your spot" card beside the event's details: one line saying where the
// member stands, and only the buttons the server would accept in that state
// (it decides again either way). `position` is the member's place on the
// waitlist (00294), and `canWait` says the event takes a waitlist.
export function SignupButton({
  eventId,
  state,
  position = null,
  canWait = false,
  opensAt = null,
  closesAt = null,
  fee = null,
}: {
  eventId: string;
  state: ClubEventSignupState;
  position?: number | null;
  canWait?: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
  fee?: SignupFee | null;
}) {
  const [loading, setLoading] = useState<Act | null>(null);
  const [paying, setPaying] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function act(what: Act) {
    // A paid event: the receipt goes with the sign-up, from the pop-up.
    if (what === 'sign_up' && fee) {
      setPaying(true);
      return;
    }
    setLoading(what);
    try {
      const res =
        what === 'sign_up'
          ? await signUpForClubEvent(eventId)
          : what === 'withdraw'
            ? await withdrawFromClubEvent(eventId)
            : what === 'join'
              ? await joinClubEventWaitlist(eventId)
              : await leaveClubEventWaitlist(eventId);
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      toast(DONE[what], 'success');
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  const button = (what: Act, label: string, variant: 'primary' | 'secondary' = 'primary') => (
    <Button
      key={what}
      variant={variant}
      onClick={() => act(what)}
      loading={loading === what}
      disabled={loading !== null && loading !== what}
    >
      {label}
    </Button>
  );

  let title: string;
  let detail: string | null = null;
  const buttons: React.ReactNode[] = [];

  if (state === 'going') {
    title = 'You are going';
    detail = 'See you there. Withdraw if you cannot make it, so someone else gets the place.';
    buttons.push(button('withdraw', 'Withdraw', 'secondary'));
  } else if (position !== null) {
    title = `You are number ${position} on the waitlist`;
    detail =
      state === 'open'
        ? 'A place is free. Take it before someone else does.'
        : 'We will tell you here if a place opens.';
    if (state === 'open') buttons.push(button('sign_up', 'Take the place'));
    buttons.push(button('leave', 'Leave the waitlist', 'secondary'));
  } else if (state === 'open') {
    title = 'Places are open';
    detail = closesAt ? `Sign-ups close ${closesAt}.` : null;
    if (fee) detail = `${fee.amount} by e-transfer. You send the screenshot when you sign up.${detail ? ` ${detail}` : ''}`;
    buttons.push(button('sign_up', 'Sign up'));
    if (canWait) {
      detail = 'Members on the waitlist are ahead of you for the free place.';
      buttons.push(button('join', 'Join the waitlist', 'secondary'));
    }
  } else if (canWait) {
    title = 'This event is full';
    detail = 'Join the waitlist and we will tell you here if a place opens.';
    buttons.push(button('join', 'Join the waitlist'));
  } else {
    title =
      state === 'full'
        ? 'This event is full'
        : state === 'not_open_yet'
          ? 'Sign-ups are not open yet'
          : state === 'started'
            ? 'This event has started'
            : state === 'cancelled'
              ? 'This event is cancelled'
              : 'Sign-ups are closed';
    if (state === 'not_open_yet' && opensAt) detail = `They open ${opensAt}.`;
  }

  return (
    <div>
      {paying && fee && (
        <Dialog open onClose={() => setPaying(false)} title="Pay to sign up">
          {fee.etransferEmail ? (
            <>
              <p style={{ fontSize: 14, margin: 0 }}>
                Send <b>{fee.amount}</b> by Interac e-Transfer to <b>{fee.etransferEmail}</b>, then add the
                screenshot of the confirmation here. You are signed up as soon as you send it, and an exec checks it.
              </p>
              <EtransferForm
                feeId={null}
                duesSeasonId={null}
                dues={false}
                sendLabel="Sign up"
                onSend={(receipt) =>
                  signUpWithReceipt(eventId, { reference: receipt.reference, screenshotPath: receipt.screenshotPath })
                }
                onSent={() => {
                  setPaying(false);
                  toast(DONE.sign_up, 'success');
                }}
              />
            </>
          ) : (
            <p style={{ fontSize: 14, margin: 0 }}>
              This event costs {fee.amount}, and the club has not said where to send it yet. Ask an exec how to pay.
            </p>
          )}
        </Dialog>
      )}
      <div className="ev-label">Your spot</div>
      <div className="ev-spot-title">{title}</div>
      {detail && <p className="ev-spot-detail">{detail}</p>}
      {buttons.length > 0 && <div className="ev-spot-actions">{buttons}</div>}
    </div>
  );
}
