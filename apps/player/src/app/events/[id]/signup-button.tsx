'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@badminton/ui';
import type { ClubEventSignupState } from '@badminton/shared';
import {
  joinClubEventWaitlist,
  leaveClubEventWaitlist,
  signUpForClubEvent,
  withdrawFromClubEvent,
} from '@/lib/club-event-actions';
import { useToast } from '@/components/toast-provider';

type Act = 'sign_up' | 'withdraw' | 'join' | 'leave';

const DONE: Record<Act, string> = {
  sign_up: 'You are signed up',
  withdraw: 'You are no longer signed up',
  join: 'You are on the waitlist. We will tell you here if a place opens.',
  leave: 'You left the waitlist',
};

// The "your spot" panel under the event's details: one line saying where the
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
}: {
  eventId: string;
  state: ClubEventSignupState;
  position?: number | null;
  canWait?: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
}) {
  const [loading, setLoading] = useState<Act | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  async function act(what: Act) {
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
    <div
      className="row"
      style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="stat-label" style={{ marginBottom: 4 }}>
          YOUR SPOT
        </div>
        <div style={{ fontWeight: 600, fontSize: 16 }}>{title}</div>
        {detail && (
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            {detail}
          </div>
        )}
      </div>
      {buttons.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {buttons}
        </div>
      )}
    </div>
  );
}
