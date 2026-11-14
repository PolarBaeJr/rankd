// WHY A MEMBER LEFT AN EVENT PART WAY THROUGH (00324 event_departures). Pure,
// so the dialog and the action share one list. The order is the dialog's, and
// the one choice that warns comes last, where it reads as the exception.

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
