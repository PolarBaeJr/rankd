'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import {
  declineGuestMembership,
  makeGuestMember,
  requestGuestMembership,
} from '@/lib/actions/guests';

// Making a guest a member without them signing in (00292). An admin does it
// after a confirm; anybody else who edits players can only ask an admin, and
// the ask shows here until an admin confirms or declines it. The actions are
// the real gate; this only offers what the viewer can do.

export function GuestMembership({
  playerId,
  playerName,
  isAdmin,
  requestedBy,
  requestedAt,
}: {
  playerId: string;
  playerName: string;
  isAdmin: boolean;
  /** Who asked, already resolved to a name, or null if nobody has. */
  requestedBy: string | null;
  requestedAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const run = (action: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast(done, 'success');
      setOpen(false);
      router.refresh();
    });

  const asked = requestedBy
    ? `${requestedBy} asked an admin to make them a member${requestedAt ? ` on ${new Date(requestedAt).toLocaleDateString('en-CA')}` : ''}.`
    : null;

  return (
    <div className="flex flex-col gap-3 text-sm text-[var(--ink-2)]">
      <p className="m-0">
        A guest from a Google Form: no login, sent nothing, off the leaderboard, challenges and
        dues. They become a member on their own by signing in with the Form&apos;s email.
        {isAdmin ? '' : ' Otherwise only an admin can make them one.'}
      </p>
      {asked && <p className="m-0 text-[var(--text-primary)]">{asked}</p>}
      <div className="flex flex-wrap gap-2">
        {isAdmin ? (
          <>
            <Button onClick={() => setOpen(true)} disabled={isPending}>
              {requestedBy ? 'Confirm: make a member' : 'Make a member'}
            </Button>
            {requestedBy && (
              <Button
                variant="secondary"
                loading={isPending}
                onClick={() => run(() => declineGuestMembership(playerId), 'Declined. They stay a guest.')}
              >
                Decline
              </Button>
            )}
          </>
        ) : (
          !requestedBy && (
            <Button
              variant="secondary"
              loading={isPending}
              onClick={() => run(() => requestGuestMembership(playerId), 'Asked. An admin confirms it here.')}
            >
              Ask an admin to make them a member
            </Button>
          )
        )}
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Make ${playerName} a member`}>
        <div className="flex flex-col gap-4 text-sm">
          <p className="m-0">
            They come onto the member lists, the leaderboard and the dues lists, can be challenged,
            and get a member code. They still have no login until they sign in with their email.
            This is not undone from here.
          </p>
          <Textarea
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="For example: paid the club fee at the door"
          />
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              loading={isPending}
              disabled={!reason.trim()}
              onClick={() => run(() => makeGuestMember(playerId, reason.trim()), `${playerName} is now a member.`)}
            >
              Make a member
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
