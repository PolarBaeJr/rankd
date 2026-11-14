'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useConfirm } from '@badminton/ui';
import { CLUB_TIMEZONE, wallClockToUtc, type GroupTimeCap } from '@badminton/shared';
import { applyGroupTimeCapNow, clearGroupTimeCap, setGroupTimeCap } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';

export interface TimeCapScope {
  pool: number | null;
  group: number | null;
  label: string;
}

const clubTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CLUB_TIMEZONE });

/** Today's date in club time, for a time typed as a wall clock. */
function clubToday(): { year: number; month: number; day: number } {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: CLUB_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

/**
 * GROUP TIME CAP (00331), on a groups stage while it is played: a time for the
 * whole stage, a pool or one group, after which no new match of it starts.
 * The minute job applies it; Cap now applies it at once. Once applied the
 * scope reads Locked: its table stands.
 */
export function TimeCapControl({
  eventId,
  stage,
  scopes,
  caps,
}: {
  eventId: string;
  stage: number;
  /** The whole stage first, then each pool or group drawn. */
  scopes: TimeCapScope[];
  /** This stage's caps. */
  caps: GroupTimeCap[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [scopeIndex, setScopeIndex] = useState(0);
  const [time, setTime] = useState('');

  const labelOf = (cap: GroupTimeCap) =>
    scopes.find((s) => s.pool === cap.pool_number && s.group === cap.group_number)?.label ?? 'Groups';

  async function save() {
    const scope = scopes[scopeIndex];
    const [hour, minute] = time.split(':').map(Number);
    if (!scope || hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return;
    const { year, month, day } = clubToday();
    setBusy('set');
    const res = await setGroupTimeCap(eventId, {
      stage,
      pool: scope.pool,
      group: scope.group,
      capAt: wallClockToUtc(year, month, day, hour, minute).toISOString(),
    });
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`${scope.label}: capped at ${time}`, 'success');
    setTime('');
    router.refresh();
  }

  async function capNow(cap: GroupTimeCap) {
    const ok = await confirm({
      title: `Cap ${labelOf(cap)} now?`,
      message: 'Every match of it not yet on court is voided. The ones on court finish, and the table stands as it is.',
      confirmLabel: 'Cap now',
      danger: true,
    });
    if (!ok) return;
    setBusy(cap.id);
    const res = await applyGroupTimeCapNow(cap.id);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`${labelOf(cap)} capped: ${res.data.voided} match${res.data.voided === 1 ? '' : 'es'} voided`, 'success');
    router.refresh();
  }

  async function clear(cap: GroupTimeCap) {
    setBusy(cap.id);
    const res = await clearGroupTimeCap(cap.id);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast('Time cap cleared', 'success');
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Time cap</p>
      {caps.length > 0 && (
        <ul className="space-y-1">
          {caps.map((cap) => (
            <li key={cap.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-[var(--text-primary)]">
                {labelOf(cap)}: {cap.applied_at ? 'Locked' : `Cap at ${clubTime(cap.cap_at)}`}
              </span>
              {!cap.applied_at && (
                <span className="flex gap-1.5">
                  <Button size="sm" variant="danger" loading={busy === cap.id} disabled={busy !== null} onClick={() => capNow(cap)}>
                    Cap now
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => clear(cap)}>
                    Clear
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="text-xs text-[var(--text-muted)] flex flex-col gap-1">
          Which
          <select
            value={scopeIndex}
            onChange={(e) => setScopeIndex(Number(e.target.value))}
            className="min-h-[36px] rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 text-sm text-[var(--text-primary)]"
          >
            {scopes.map((scope, index) => (
              <option key={`${scope.pool}-${scope.group}`} value={index}>{scope.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--text-muted)] flex flex-col gap-1">
          At (club time)
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="min-h-[36px] rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 text-sm text-[var(--text-primary)]"
          />
        </label>
        <Button type="submit" size="sm" variant="secondary" loading={busy === 'set'} disabled={!time || busy !== null}>
          Set cap
        </Button>
      </form>
    </div>
  );
}
