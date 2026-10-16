import { buildSplit, type Split } from './charts';

/**
 * THE SEASON'S DUES, DIVIDED: what the club collected, what Campus Rec collected,
 * and what is still owed.
 *
 * Drawn twice (the Collection panel on /fees and the Season dues panel on the
 * dashboard), so the division lives here once and both call it.
 *
 * CAMPUS REC IS ITS OWN SEGMENT, NOT A SHRUNKEN "COLLECTED". A member who paid on
 * the Campus Rec website is paid; only the money went to Campus Rec rather than to the
 * club (see lib/season-income.ts). Leaving that money out of the split entirely
 * would shrink the billable total by it and make the term look further along
 * than it is; folding it into Collected would put money the club never held
 * back into the club's figure. A third segment keeps both honest: the three
 * still add up to the billable total, and Collected is the club's money only.
 *
 * The segment appears only when there is Campus Rec money, so a club that never
 * uses it sees the same two-part split as before.
 *
 * `paidPct` is the share of billable dues that is PAID, by either route. It is
 * what "X% of the term's dues are in" means to the person reading it: an
 * Campus Rec payer is not still owed.
 */
export interface DuesSplit {
  split: Split;
  /** One tone per segment, in the same order as `split.segments`. */
  tones: string[];
  /** 0 to 100: (club collected + Campus Rec collected) as a share of the total. */
  paidPct: number;
}

export const DUES_SPLIT_LABELS = {
  collected: 'Collected',
  sfuRec: 'Collected by Campus Rec',
  owed: 'Still owed',
} as const;

export function buildDuesSplit({
  collectedCents,
  sfuRecCents,
  outstandingCents,
}: {
  /** Paid dues the club collected itself (LedgerRead.total). */
  collectedCents: number;
  /** Paid dues Campus Rec collected (LedgerRead.collectedBySfuRec). */
  sfuRecCents: number;
  /** Roster-derived and unchanged by any of this. */
  outstandingCents: number;
}): DuesSplit {
  const withSfuRec = sfuRecCents > 0;
  const split = buildSplit([
    { label: DUES_SPLIT_LABELS.collected, value: collectedCents },
    ...(withSfuRec ? [{ label: DUES_SPLIT_LABELS.sfuRec, value: sfuRecCents }] : []),
    { label: DUES_SPLIT_LABELS.owed, value: outstandingCents },
  ]);
  const paidPct = split.segments
    .filter((segment) => segment.label !== DUES_SPLIT_LABELS.owed)
    .reduce((sum, segment) => sum + segment.pct, 0);
  // Money in is success and money owed is the warning tone, as before. Campus Rec
  // money is paid but not the club's, so it takes the neutral info tone.
  const tones = withSfuRec
    ? ['var(--color-success)', 'var(--color-info)', 'var(--color-warning)']
    : ['var(--color-success)', 'var(--color-warning)'];
  return { split, tones, paidPct };
}
