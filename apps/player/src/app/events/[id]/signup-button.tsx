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

// Offers only what the server would accept in this state; the server decides
// again either way. `position` is the member's place on the waitlist (00294),
// and `canWait` says the event is full and takes a waitlist.
export function SignupButton({
  eventId,
  state,
  position = null,
  canWait = false,
}: {
  eventId: string;
  state: ClubEventSignupState;
  position?: number | null;
  canWait?: boolean;
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

  if (state === 'going') {
    return (
      <Button variant="secondary" onClick={() => act('withdraw')} loading={loading === 'withdraw'}>
        Withdraw
      </Button>
    );
  }
  if (position !== null) {
    return (
      <>
        <span className="muted" style={{ alignSelf: 'center' }}>
          You are number {position} on the waitlist
        </span>
        {state === 'open' && (
          <Button onClick={() => act('sign_up')} loading={loading === 'sign_up'} disabled={loading !== null}>
            Take the place
          </Button>
        )}
        <Button variant="secondary" onClick={() => act('leave')} loading={loading === 'leave'} disabled={loading !== null}>
          Leave the waitlist
        </Button>
      </>
    );
  }
  if (state === 'open') {
    return (
      <>
        <Button onClick={() => act('sign_up')} loading={loading === 'sign_up'} disabled={loading !== null}>
          Sign up
        </Button>
        {canWait && (
          <Button variant="secondary" onClick={() => act('join')} loading={loading === 'join'} disabled={loading !== null}>
            Join the waitlist
          </Button>
        )}
      </>
    );
  }
  if (canWait) {
    return (
      <Button onClick={() => act('join')} loading={loading === 'join'}>
        Join the waitlist
      </Button>
    );
  }
  return null;
}
