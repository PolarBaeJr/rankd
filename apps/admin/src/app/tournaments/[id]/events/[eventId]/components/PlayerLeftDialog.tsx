'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input } from '@badminton/ui';
import { recordPlayerLeft } from '@/lib/tournament-actions';
import { DEPARTURE_REASONS, DEPARTURE_REASON_LABELS, departureWarns, type Departure, type DepartureReason } from '@/lib/departure-reasons';
import { useToast } from '@/components/toast-provider';

/**
 * "LEFT" (00324): a member gone for the rest of the event, from the court card
 * or the desk. The reason is required, and the copy says plainly that only
 * "left without telling anyone" puts a warning on their record, so a helper
 * never warns someone by picking the first choice.
 *
 * NOT A <form>, for the court card's reason: Dialog renders in place, inside
 * the score form there.
 */
export function PlayerLeftDialog({
  eventId,
  entryId,
  label,
  initial = null,
  onClose,
  onSub,
}: {
  eventId: string;
  entryId: string;
  label: string;
  /** The reason and note already chosen, when the desk comes Back from the sub. */
  initial?: Departure | null;
  onClose: () => void;
  /**
   * The desk, with substitutions on (00327, 00328): "Sub someone in" WRITES
   * NOTHING. It hands the reason on to the sub dialog, whose confirm records
   * the departure, voids the match on court and makes the sub in one call;
   * cancelling there comes back here with nothing written.
   */
  onSub?: (departure: Departure) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [reason, setReason] = useState<DepartureReason | null>(initial?.reason ?? null);
  const [note, setNote] = useState(initial?.note ?? '');
  const [pending, setPending] = useState(false);
  const needsNote = reason === 'other' && note.trim() === '';

  function sub() {
    if (!reason || needsNote || pending || !onSub) return;
    onSub({ reason, note: note.trim() || null });
  }

  async function submit() {
    if (!reason || needsNote || pending) return;
    setPending(true);
    const res = await recordPlayerLeft(eventId, entryId, { reason, note: note.trim() || null });
    setPending(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    const parts = [`${label} marked as left.`];
    if (res.data.warned > 0) parts.push('A warning was added to their record.');
    if (res.data.leftForDesk > 0) parts.push(`The desk voids their other ${res.data.leftForDesk} match${res.data.leftForDesk === 1 ? '' : 'es'}.`);
    toast(parts.join(' '), 'success');
    onClose();
    router.refresh();
  }

  return (
    <Dialog open onClose={() => { if (!pending) onClose(); }} title={`${label} left?`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-muted)]">
          They are out for the rest of the event, the same as Did not come, and their matches still to play are voided.
          {onSub && ' Sub someone in instead to keep the place: the substitute takes those matches, and nothing is recorded until you confirm who.'}
          {' '}Choose why they left.
        </p>
        <fieldset className="space-y-2">
          <legend className="sr-only">Why they left</legend>
          {DEPARTURE_REASONS.map((value) => (
            <label key={value} className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="radio"
                name={`left-reason-${entryId}`}
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
                className="mt-1"
              />
              <span>
                {DEPARTURE_REASON_LABELS[value]}
                {departureWarns(value) && (
                  <span className="block text-xs text-[var(--color-danger)]">Adds an attendance warning to their record.</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
        {reason && (
          <Input
            label={reason === 'other' ? 'What happened' : 'Note (optional)'}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          />
        )}
        <p className="text-xs text-[var(--text-muted)]">
          {reason && departureWarns(reason)
            ? 'They will be warned: leaving without telling anyone is against the attendance policy.'
            : 'Any other reason is recorded with no warning.'}
        </p>
        <div className="flex justify-between gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <div className="flex gap-2">
            {onSub && (
              <Button type="button" variant="secondary" disabled={!reason || needsNote || pending} onClick={sub}>
                Sub someone in
              </Button>
            )}
            <Button type="button" variant="danger" loading={pending} disabled={!reason || needsNote || pending} onClick={() => void submit()}>
              Mark as left
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
