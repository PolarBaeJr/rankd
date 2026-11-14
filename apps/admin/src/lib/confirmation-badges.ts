// "CONFIRM YOUR PLACE" AT THE DESK (00325). Pure: one state per entry, read
// from the entrants' rows, for the Check-in tab's badge and its counts line.
// A pair is confirmed when either partner confirmed, the rule the release uses.

import type { ConfirmationRow } from './tournament-types';

export type EntryConfirmationState = 'confirmed' | 'waiting' | 'released' | 'unreached';

export const CONFIRMATION_BADGE_LABELS: Record<EntryConfirmationState, string> = {
  confirmed: 'Confirmed',
  waiting: 'Waiting',
  released: 'Released',
  unreached: 'Not reached',
};

/** null: this entry was never asked, or every row was voided. */
export function entryConfirmationState(
  rows: readonly ConfirmationRow[],
  entryId: string,
  isPair: boolean,
): EntryConfirmationState | null {
  const mine = rows.filter((r) => (isPair ? r.pair_id : r.participant_id) === entryId && r.status !== 'void');
  if (mine.length === 0) return null;
  if (mine.some((r) => r.status === 'confirmed')) return 'confirmed';
  if (mine.some((r) => r.status === 'released')) return 'released';
  if (mine.some((r) => r.status === 'unreached')) return 'unreached';
  return 'waiting';
}

export function confirmationCounts(
  rows: readonly ConfirmationRow[],
  entryIds: readonly string[],
  isPair: boolean,
): Record<EntryConfirmationState, number> & { asked: number } {
  const counts = { confirmed: 0, waiting: 0, released: 0, unreached: 0, asked: 0 };
  for (const id of entryIds) {
    const state = entryConfirmationState(rows, id, isPair);
    if (!state) continue;
    counts[state] += 1;
    counts.asked += 1;
  }
  return counts;
}
