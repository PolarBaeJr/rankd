'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@badminton/ui';
import {
  checkinCutoffInstant,
  clubWallClockToUtc,
  DEFAULT_CHECKIN_CUTOFF_MINUTES,
  eventStartInstant,
  formatClubEventTime,
  utcToClubWallClock,
  type WindowColumns,
} from '@badminton/shared';
import { setEventWindows } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { EntryWindowFields, entryWindowText, type EntryWindowText } from '@/components/entry-window-fields';

// This event's own registration and check-in windows (00276). A blank box
// inherits the tournament's bound, shown under it.
//
// THE EVENT STANDARD (checkin_cutoff_default): check-in closes 15 minutes
// before the start. A quick fill sets it, and a close that says otherwise is
// pointed out, never changed.
export function EventWindowsDialog({
  eventId,
  event,
  tournament,
  cutoffOn = false,
  startDate = null,
  startsTime = null,
  onClose,
}: {
  eventId: string;
  event: WindowColumns;
  tournament: WindowColumns;
  cutoffOn?: boolean;
  startDate?: string | null;
  startsTime?: string | null;
  onClose: () => void;
}) {
  const [windows, setWindows] = useState<EntryWindowText>(() => entryWindowText(event));
  const cutoff = cutoffOn && startDate && startsTime
    ? checkinCutoffInstant(eventStartInstant(startDate, startsTime)).toISOString()
    : null;
  const cutoffText = cutoff ? utcToClubWallClock(cutoff) : null;
  const closesText = windows.checkin_closes_at || (tournament.checkin_closes_at ? utcToClubWallClock(tournament.checkin_closes_at) : '');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await setEventWindows(eventId, windows);
    setSaving(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast('Windows saved', 'success');
    onClose();
    router.refresh();
  }

  return (
    <Dialog open onClose={onClose} title="Registration and check-in windows">
      <form onSubmit={handleSubmit} className="space-y-4">
        <EntryWindowFields value={windows} onChange={setWindows} inherited={tournament} />
        {cutoff && cutoffText && (
          <div className="space-y-1">
            <Button type="button" size="sm" variant="secondary" onClick={() => setWindows({ ...windows, checkin_closes_at: cutoffText })}>
              Close check-in {DEFAULT_CHECKIN_CUTOFF_MINUTES} min before start
            </Button>
            {closesText && closesText !== cutoffText && (
              <p className="text-xs text-[var(--color-warning)]" role="status">
                Check-in closes at {formatClubEventTime(clubWallClockToUtc(closesText)?.toISOString() ?? cutoff)}, not {DEFAULT_CHECKIN_CUTOFF_MINUTES} minutes
                before the start ({formatClubEventTime(cutoff)}) as the event standard has it.
              </p>
            )}
          </div>
        )}
        <p className="text-xs text-[var(--text-muted)]">
          Club time. Members can only enter or check themselves in inside these windows, and the stages
          still open by hand. Execs can still add entrants and check people in outside these times.
        </p>
        <div className="flex items-center justify-between">
          <Button type="button" variant="ghost" onClick={() => setWindows(entryWindowText(null))}>
            Clear
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={saving}>Save</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
