'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@badminton/ui';
import { confirmEventEntry, withdrawFromEvent } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';

// The two answers to "Confirm your place": keep it, or give it up so a reserve
// gets it. Both are a tap on this page, never the link in the email.
export function ConfirmEntryButton({ eventId, eventHref, canWithdraw }: { eventId: string; eventHref: string; canWithdraw: boolean }) {
  const [busy, setBusy] = useState<'confirm' | 'withdraw' | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  async function keep() {
    setBusy('confirm');
    const res = await confirmEventEntry(eventId);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(res.data.already ? 'Already confirmed' : 'Place confirmed. See you there.', 'success');
    router.push(eventHref);
  }

  async function giveUp() {
    setBusy('withdraw');
    const res = await withdrawFromEvent(eventId);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast('Withdrawn. Your place goes to the next on the waitlist.', 'success');
    router.push(eventHref);
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={keep} loading={busy === 'confirm'} disabled={busy !== null} className="press min-h-[44px]">
        Confirm my place
      </Button>
      {canWithdraw && (
        <Button onClick={giveUp} loading={busy === 'withdraw'} disabled={busy !== null} variant="ghost" className="press min-h-[44px]">
          I cannot come
        </Button>
      )}
    </div>
  );
}
