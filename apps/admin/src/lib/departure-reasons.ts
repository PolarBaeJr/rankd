// WHY A MEMBER LEFT AN EVENT PART WAY THROUGH (00324 event_departures). Pure,
// so the dialog and the action share one list. The order is the dialog's, and
// the one choice that warns comes last, where it reads as the exception.

import { ExpectedError } from '@badminton/shared';

export const DEPARTURE_REASONS = ['injury', 'told_organizers', 'emergency', 'other', 'without_notice'] as const;

export type DepartureReason = (typeof DEPARTURE_REASONS)[number];

export const DEPARTURE_REASON_LABELS: Record<DepartureReason, string> = {
  injury: 'Injured',
  told_organizers: 'Told the organizers they were leaving',
  emergency: 'An emergency',
  other: 'Another reason (say what)',
  without_notice: 'Left without telling anyone',
};

/** The only reason that puts a warning on the member's record. */
export function departureWarns(reason: DepartureReason): boolean {
  return reason === 'without_notice';
}

/** What the Left dialog hands on: the reason chosen and its note. */
export interface Departure {
  reason: DepartureReason;
  note: string | null;
}

/**
 * The reason and note as a server action receives them, which is from the
 * client: a reason off the list, a note of at most 500 characters, and a note
 * for "other". Throws the desk's words.
 */
export function parseDeparture(input: unknown): Departure {
  const raw = (input ?? {}) as { reason?: unknown; note?: unknown };
  if (typeof raw.reason !== 'string' || !(DEPARTURE_REASONS as readonly string[]).includes(raw.reason)) {
    throw new ExpectedError('Choose why they left.');
  }
  const reason = raw.reason as DepartureReason;
  const note = typeof raw.note === 'string' && raw.note.trim() !== '' ? raw.note.trim() : null;
  if (note && note.length > 500) throw new ExpectedError('Keep the note to 500 characters.');
  if (reason === 'other' && !note) throw new ExpectedError('Say why they left.');
  return { reason, note };
}
