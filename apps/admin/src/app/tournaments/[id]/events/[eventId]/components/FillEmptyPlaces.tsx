'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useConfirm } from '@badminton/ui';
import { enterReserveAndCheckIn, releaseCheckinNoShows, removeFromWaitlist } from '@/lib/tournament-actions';
import { addExecOnTheSpot } from '@/lib/tournament-actions/on-the-spot';
import { onTheSpotMessage } from '@/lib/on-the-spot';
import { useToast } from '@/components/toast-provider';
import type { PlayerSummary, WaitlistEntry } from '@/lib/tournament-types';

/**
 * FILL THE EMPTY PLACES (00326), once check-in closes, in the order the event
 * standard sets: release the no-shows, then the reserves in waitlist order,
 * then the execs. An exec cannot be added while a reserve is still waiting,
 * which the server refuses as well.
 */
export function FillEmptyPlaces({
  eventId,
  unreleased,
  openPlaces,
  waitlist,
  execs,
  canRelease,
  canAdd,
  warns,
}: {
  eventId: string;
  /** Entries still registered and not checked in. */
  unreleased: number;
  /** Free places by the slot rule, or null for an event with no cap. */
  openPlaces: number | null;
  waitlist: WaitlistEntry[];
  /** Execs not in the event. */
  execs: PlayerSummary[];
  canRelease: boolean;
  canAdd: boolean;
  /** Kill switch attendance_warnings: a released no-show is warned. */
  warns: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const reservesWaiting = waitlist.length > 0;

  async function release() {
    const ok = await confirm({
      title: `Release ${unreleased} ${unreleased === 1 ? 'entry' : 'entries'}?`,
      message: `Everyone not checked in is withdrawn and their place is free for a reserve.${warns ? ' Each is warned for not coming.' : ''}`,
      confirmLabel: 'Release',
      danger: true,
    });
    if (!ok) return;
    setBusy('release');
    const res = await releaseCheckinNoShows(eventId);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`Released ${res.data.released}${res.data.openSlots != null ? `, ${res.data.openSlots} place${res.data.openSlots === 1 ? '' : 's'} open` : ''}`, 'success');
    router.refresh();
  }

  async function enterReserve(entry: WaitlistEntry) {
    setBusy(entry.id);
    const res = await enterReserveAndCheckIn(eventId, entry.id);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    const name = entry.player?.full_name ?? 'The reserve';
    toast(res.data.checkedIn ? `${name} entered and checked in` : `${name} entered. ${res.data.checkInRefusal}`, res.data.checkedIn ? 'success' : 'error');
    router.refresh();
  }

  async function notHere(entry: WaitlistEntry) {
    setBusy(entry.id);
    const res = await removeFromWaitlist(entry.id);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`${entry.player?.full_name ?? 'The reserve'} taken off the waitlist`, 'success');
    router.refresh();
  }

  async function addExec(exec: PlayerSummary) {
    setBusy(exec.id);
    const res = await addExecOnTheSpot(eventId, exec.id);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(onTheSpotMessage(res.data), res.data.waiverUnsigned || res.data.checkInLocked ? 'error' : 'success');
    router.refresh();
  }

  return (
    <section aria-label="Fill the empty places" className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Fill the empty places</h3>
        {openPlaces != null && (
          <span className="text-xs text-[var(--text-muted)]">{openPlaces} place{openPlaces === 1 ? '' : 's'} open</span>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">1. Release the no-shows</p>
        {unreleased > 0 ? (
          <Button size="sm" variant="danger" loading={busy === 'release'} disabled={!canRelease || busy !== null} onClick={release}>
            Release {unreleased} not checked in
          </Button>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">Everyone left is checked in.</p>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">2. The reserves, in order</p>
        {waitlist.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Nobody is waiting.</p>
        ) : (
          <ul className="space-y-1">
            {waitlist.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-[var(--text-primary)]">{entry.player?.full_name ?? 'Unknown'}</span>
                <span className="flex gap-1.5">
                  <Button size="sm" loading={busy === entry.id} disabled={!canAdd || busy !== null || openPlaces === 0} onClick={() => enterReserve(entry)}>
                    Enter and check in
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!canAdd || busy !== null} onClick={() => notHere(entry)}>
                    Not here
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">3. The execs</p>
        {reservesWaiting && <p className="text-xs text-[var(--text-muted)]">Call or remove the reserves first.</p>}
        {execs.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No exec is free to play.</p>
        ) : (
          <ul className="space-y-1">
            {execs.map((exec) => (
              <li key={exec.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-[var(--text-primary)]">{exec.full_name ?? 'Unknown'}</span>
                <Button size="sm" variant="secondary" loading={busy === exec.id} disabled={!canAdd || reservesWaiting || busy !== null || openPlaces === 0} onClick={() => addExec(exec)}>
                  Add and check in
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
