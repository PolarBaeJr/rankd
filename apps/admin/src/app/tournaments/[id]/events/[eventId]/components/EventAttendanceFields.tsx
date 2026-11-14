'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Switch } from '@badminton/ui';
import {
  confirmationWindow,
  DEFAULT_CONFIRM_DEADLINE_HOURS,
  DEFAULT_CONFIRM_OPENS_HOURS,
  eventStartInstant,
  formatClubEventTime,
} from '@badminton/shared';
import { setEventAttendanceSettings } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import type { TournamentEventRow } from '@/lib/tournament-types';

/**
 * "CONFIRM YOUR PLACE" (00325), in the event's settings. Saved on its own, as
 * the waitlist is, so the format form's Save never carries it. The instants
 * are shown in club time, because "48 hours" is the question and "Thursday
 * 10:00" is the answer an exec checks it against.
 */
export function EventAttendanceFields({
  event,
  startDate,
  startsTime,
}: {
  event: TournamentEventRow;
  startDate: string | null;
  startsTime: string | null;
}) {
  const row = event as { confirm_required?: boolean; confirm_opens_hours?: number; confirm_deadline_hours?: number };
  const ready = 'confirm_required' in event;
  const [required, setRequired] = useState(row.confirm_required === true);
  const [opens, setOpens] = useState(String(row.confirm_opens_hours ?? DEFAULT_CONFIRM_OPENS_HOURS));
  const [deadline, setDeadline] = useState(String(row.confirm_deadline_hours ?? DEFAULT_CONFIRM_DEADLINE_HOURS));
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const editable = event.status === 'registration' || event.status === 'checkin';

  if (!ready) return <p className="text-xs text-[var(--text-muted)]">Confirm your place: run migration 00324 first.</p>;

  const opensHours = Number(opens);
  const deadlineHours = Number(deadline);
  const valid = Number.isInteger(opensHours) && Number.isInteger(deadlineHours)
    && deadlineHours >= 1 && opensHours <= 336 && deadlineHours < opensHours;
  const asks = valid && startDate ? confirmationWindow(eventStartInstant(startDate, startsTime), opensHours, deadlineHours) : null;

  async function save(nextRequired: boolean) {
    if (!valid) {
      toast('The ask opens before the deadline: at least 1 hour before the start, at most 336.', 'error');
      return;
    }
    setSaving(true);
    const res = await setEventAttendanceSettings(event.id, { confirmRequired: nextRequired, opensHours, deadlineHours });
    setSaving(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    setRequired(nextRequired);
    toast('Confirmation updated', 'success');
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <Switch
        label="Ask entrants to confirm their place"
        description={editable
          ? 'Entrants who do not confirm by the deadline lose their place to the waitlist. Anyone the club could not reach keeps it.'
          : 'Can only be changed while the event is taking entries or checking in.'}
        checked={required}
        disabled={!editable || saving}
        onChange={(next) => save(next)}
      />
      {required && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ask, hours before the start"
              type="number"
              min={2}
              max={336}
              value={opens}
              onChange={(e) => setOpens(e.target.value)}
              disabled={!editable || saving}
            />
            <Input
              label="Deadline, hours before the start"
              type="number"
              min={1}
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              disabled={!editable || saving}
            />
          </div>
          {!startsTime && (
            <p className="text-xs text-[var(--color-warning)]" role="status">
              The tournament has no start time, so 09:00 is used. Set one on the tournament for the real times.
            </p>
          )}
          {asks && (
            <p className="text-xs text-[var(--text-muted)]">
              Asked from {formatClubEventTime(asks.opensAt.toISOString())}; released at {formatClubEventTime(asks.deadlineAt.toISOString())}.
            </p>
          )}
          <Button type="button" size="sm" variant="secondary" loading={saving} disabled={!editable || !valid} onClick={() => save(true)}>
            Save the hours
          </Button>
        </>
      )}
    </div>
  );
}
