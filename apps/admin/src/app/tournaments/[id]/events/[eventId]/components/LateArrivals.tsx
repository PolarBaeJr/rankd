'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useConfirm } from '@badminton/ui';
import { reinstateLateArrival, returnLateArrivalToReserves } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import type { PairWithPlayers, ParticipantWithPlayer } from '@/lib/tournament-types';
import { getName } from './entry-name';

/**
 * RELEASED AT CHECK-IN CLOSE (00330): an entry the release withdrew whose
 * member then walks in. Reinstate while the place is free; once it has gone,
 * back to the reserves, at the back unless the desk overrides. A pair's
 * reinstate checks in the member at the desk, and the partner when they come.
 */
export function LateArrivals({
  eventId,
  entries,
  isDoubles,
}: {
  eventId: string;
  /** Withdrawn entries the release named. */
  entries: Array<ParticipantWithPlayer | PairWithPlayers>;
  isDoubles: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [taken, setTaken] = useState<Set<string>>(new Set());

  async function reinstate(entryId: string, name: string, slot: 1 | 2 | null) {
    setBusy(`reinstate-${entryId}-${slot ?? 0}`);
    const res = await reinstateLateArrival(eventId, entryId, isDoubles, slot);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    if (res.data.placeTaken) {
      setTaken((prev) => new Set(prev).add(entryId));
      toast(`${name}'s place has gone. Put them back on the reserves.`, 'error');
      return;
    }
    toast(res.data.checkedIn ? `${name} reinstated and checked in` : `${name} reinstated. ${res.data.checkInRefusal}`, res.data.checkedIn ? 'success' : 'error');
    router.refresh();
  }

  async function requeue(entryId: string, name: string, atHead: boolean) {
    if (atHead) {
      const ok = await confirm({
        title: `Put ${name} at the head of the reserves?`,
        message: 'They go ahead of everyone already waiting. Their late warning stays.',
        confirmLabel: 'Head of the reserves',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(`requeue-${entryId}`);
    const res = await returnLateArrivalToReserves(eventId, entryId, isDoubles, atHead, atHead);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`${name} is back on the reserves${atHead ? ', at the head' : ''}`, 'success');
    router.refresh();
  }

  if (entries.length === 0) return null;
  return (
    <section aria-label="Released at check-in close" className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Released at check-in close ({entries.length})</h3>
        <p className="text-xs text-[var(--text-muted)]">Somebody here after all: reinstate them while the place is free, or put them back on the reserves.</p>
      </div>
      <ul className="space-y-2">
        {entries.map((entry) => {
          const name = getName(entry, isDoubles);
          const pair = isDoubles ? (entry as PairWithPlayers) : null;
          const free = !taken.has(entry.id);
          return (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-[var(--text-primary)]">{name}</span>
              <span className="flex flex-wrap gap-1.5">
                {free && (pair
                  ? ([1, 2] as const).map((slot) => {
                    const person = (slot === 1 ? pair.player1 : pair.player2)?.full_name;
                    return person ? (
                      <Button key={slot} size="sm" loading={busy === `reinstate-${entry.id}-${slot}`} disabled={busy !== null} onClick={() => reinstate(entry.id, name, slot)}>
                        {`Arrived: ${person}`}
                      </Button>
                    ) : null;
                  })
                  : (
                    <Button size="sm" loading={busy === `reinstate-${entry.id}-0`} disabled={busy !== null} onClick={() => reinstate(entry.id, name, null)}>
                      Arrived: reinstate
                    </Button>
                  ))}
                <Button size="sm" variant="secondary" loading={busy === `requeue-${entry.id}`} disabled={busy !== null} onClick={() => requeue(entry.id, name, false)}>
                  Back of the reserves
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => requeue(entry.id, name, true)}>
                  Head of the reserves (override)
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
