'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useConfirm } from '@badminton/ui';
import { formatClubEventTime, wallClockToUtc } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { createEntryRestriction, liftEntryRestriction, rescindAttendanceWarning } from '@/lib/actions/attendance';
import { PanelLabel } from './panel';

// A MEMBER'S ATTENDANCE (00324): the warnings the event standard wrote and the
// restrictions an exec set. The count is the last twelve months, because that
// is the window an exec weighs a restriction against; the list shows every
// warning, rescinded ones struck through, so nothing is lost by rescinding.

export interface AttendanceWarningRow {
  id: string;
  kind: string;
  source: string;
  note: string | null;
  issued_at: string;
  rescinded_at: string | null;
  rescind_reason: string | null;
  where: string | null;
}

export interface EntryRestrictionRow {
  id: string;
  reason: string;
  starts_at: string;
  ends_at: string | null;
  lifted_at: string | null;
}

const KIND_LABEL: Record<string, string> = {
  no_show: 'No-show',
  left_without_notice: 'Left without telling us',
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function activeRestriction(rows: EntryRestrictionRow[], now = Date.now()): EntryRestrictionRow | null {
  return rows.find((row) =>
    !row.lifted_at
    && new Date(row.starts_at).getTime() <= now
    && (!row.ends_at || new Date(row.ends_at).getTime() > now)) ?? null;
}

export function AttendancePanel({
  playerId,
  warnings,
  restrictions,
  warningsOn,
  restrictionsOn,
  canRestrict,
  canLift,
}: {
  playerId: string;
  warnings: AttendanceWarningRow[];
  restrictions: EntryRestrictionRow[];
  warningsOn: boolean;
  restrictionsOn: boolean;
  canRestrict: boolean;
  canLift: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  const now = Date.now();
  const recent = warnings.filter((w) => !w.rescinded_at && now - new Date(w.issued_at).getTime() < YEAR_MS).length;
  const active = activeRestriction(restrictions, now);

  async function handleRescind(warning: AttendanceWarningRow) {
    const ok = await confirm({
      title: 'Rescind this warning?',
      message: 'It stays on the record, struck through, and no longer counts.',
      confirmLabel: 'Rescind',
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await rescindAttendanceWarning(warning.id, 'Rescinded by an exec.');
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      toast('Warning rescinded', 'success');
      router.refresh();
    });
  }

  function handleRestrict() {
    // The date is the club's calendar day: the restriction ends at the start of it.
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
    const endsAt = match
      ? wallClockToUtc(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0).toISOString()
      : null;
    startTransition(async () => {
      const res = await createEntryRestriction({ playerId, reason: reason.trim(), endsAt });
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      toast(
        res.data.removedFromWaitlists > 0
          ? `Restricted, and taken off ${res.data.removedFromWaitlists} waitlist(s)`
          : 'Restricted',
        'success',
      );
      setReason('');
      setUntil('');
      router.refresh();
    });
  }

  async function handleLift(row: EntryRestrictionRow) {
    const ok = await confirm({
      title: 'Lift the restriction?',
      message: 'They can enter events again straight away.',
      confirmLabel: 'Lift',
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await liftEntryRestriction(row.id);
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      toast('Restriction lifted', 'success');
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {warningsOn && (
        <div className="space-y-2">
          <PanelLabel>Warnings, {recent} in the last 12 months</PanelLabel>
          {warnings.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No attendance warnings.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {warnings.map((w) => (
                <li key={w.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <div className={w.rescinded_at ? 'line-through text-[var(--text-muted)]' : ''}>
                    <p className="text-[var(--text-primary)]">
                      {KIND_LABEL[w.kind] ?? w.kind}
                      {w.where ? `, ${w.where}` : ''}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {formatClubEventTime(w.issued_at)}
                      {w.note ? `. ${w.note}` : ''}
                    </p>
                  </div>
                  {!w.rescinded_at && canRestrict && (
                    <Button size="sm" variant="ghost" disabled={isPending} onClick={() => handleRescind(w)}>
                      Rescind
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {restrictionsOn && (
        <div className="space-y-2">
          <PanelLabel>Entry restriction</PanelLabel>
          {active ? (
            <div className="flex items-start justify-between gap-3 text-sm">
              <div>
                <p className="text-[var(--text-primary)]">
                  {active.ends_at
                    ? `Cannot enter events until ${formatClubEventTime(active.ends_at)}`
                    : 'Cannot enter events until an exec lifts it'}
                </p>
                <p className="text-xs text-[var(--text-muted)]">{active.reason}</p>
              </div>
              {canLift && (
                <Button size="sm" variant="ghost" disabled={isPending} onClick={() => handleLift(active)}>
                  Lift
                </Button>
              )}
            </div>
          ) : canRestrict ? (
            <div className="space-y-2">
              <Input
                aria-label="Reason"
                placeholder="Reason, for example two no-shows this term"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-[var(--text-muted)]" htmlFor="restriction-until">
                  Until (leave empty for until lifted)
                </label>
                <Input
                  id="restriction-until"
                  type="date"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                  className="w-auto"
                />
                <Button size="sm" disabled={isPending || reason.trim() === ''} onClick={handleRestrict}>
                  Restrict
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">Not restricted.</p>
          )}
        </div>
      )}
    </div>
  );
}
