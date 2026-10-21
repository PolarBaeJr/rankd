'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog } from '@badminton/ui';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { eraseGuest } from '@/lib/actions/guests';

// A guest (00292) cannot sign in, so their access and deletion requests reach
// the club by email and an exec acts on them here. Export downloads from the
// member app, which holds the export assembler and checks the viewer again.

export function GuestActions({
  playerId,
  playerName,
  canExport,
  canErase,
}: {
  playerId: string;
  playerName: string;
  /** players.read. The member app's route is the real gate. */
  canExport: boolean;
  /** players.remove.write. eraseGuest is the real gate. */
  canErase: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const playerBase = (process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000').replace(/\/$/, '');

  const run = () =>
    startTransition(async () => {
      const result = await eraseGuest(playerId);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast(`Erased. The record now reads ${result.data.label}.`, 'success');
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      {canExport && (
        <a
          href={`${playerBase}/api/guests/${playerId}/export`}
          className="inline-flex min-h-[44px] items-center px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--border-hover)] hover:text-[var(--text-primary)]"
        >
          Export data
        </a>
      )}
      {canErase && (
        <Button variant="ghost" onClick={() => setOpen(true)} disabled={isPending}>
          Erase
        </Button>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="Erase this guest">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            For a request to the privacy address. {playerName}&apos;s name, email and e-transfer
            screenshots are erased, here and in the Google Form imports the app keeps.
          </p>
          <p className="text-sm text-[var(--text-secondary)]">
            The record stays as &quot;Former guest#&quot; and a short code, so draws, results and
            fees still add up. The waiver they signed in the Google Form is kept. This cannot be
            undone; export their data first if they asked for a copy.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={run} disabled={isPending}>
              {isPending ? 'Erasing…' : 'Erase'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
