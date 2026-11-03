// THE CLUB'S SHARE OF A MIXED RECEIPT (00313).
//
// An exec buys shuttles and their own groceries on one Costco run. The items
// they tick are the club's; the club owes them those items plus the tax on
// those items, by each item's own tax code, and nothing for the rest. The
// server recomputes this on every save (finance.ts) and stores it as the
// expense's amount_cents, so the figure an admin reimburses is never the one a
// browser typed.
//
// INTEGERS ONLY, HALF-UP, ROUNDED ONCE PER TAX LINE and never per item: a sum
// of per-item roundings drifts a cent per item from the line the till prints.
// The till itself often does round per item, so a small gap between the tax
// worked out here over every item and the printed tax is expected, and is
// reported as a note rather than corrected.

export interface ShareItem {
  /** line_total_cents + discount_cents. */
  netCents: number;
  taxCode: string | null;
  isClub: boolean;
}

export interface ShareTaxLine {
  label: string;
  ratePpm: number | null;
  printedCents: number | null;
  codes: string[];
}

export interface ClubShare {
  clubNetCents: number;
  clubTaxCents: number;
  clubShareCents: number;
  mode: 'by_code' | 'proportional' | 'none';
  perLine: { label: string; clubTaxCents: number; computedAllCents: number | null; printedCents: number | null }[];
  roundingNotes: string[];
}

/** numerator / denominator, rounded half away from zero, in integers. */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

const dollars = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

export function computeClubShare(items: readonly ShareItem[], taxLines: readonly ShareTaxLine[]): ClubShare {
  const sum = (list: readonly ShareItem[]) => list.reduce((s, it) => s + it.netCents, 0);
  const club = items.filter((it) => it.isClub);
  const clubNetCents = sum(club);
  const allNetCents = sum(items);
  const mode: ClubShare['mode'] =
    taxLines.length === 0 ? 'none' : items.some((it) => it.taxCode) ? 'by_code' : 'proportional';

  const taxOver = (t: ShareTaxLine, set: readonly ShareItem[]): number => {
    if (mode === 'by_code') {
      const base = (list: readonly ShareItem[]) =>
        sum(list.filter((it) => it.taxCode !== null && t.codes.includes(it.taxCode)));
      const baseSet = base(set);
      if (t.ratePpm !== null) return roundHalfUp(baseSet * t.ratePpm, 1_000_000);
      if (t.printedCents !== null) return roundHalfUp(t.printedCents * baseSet, base(items));
      return 0;
    }
    if (t.printedCents !== null) return roundHalfUp(t.printedCents * sum(set), allNetCents);
    if (t.ratePpm !== null) return roundHalfUp(sum(set) * t.ratePpm, 1_000_000);
    return 0;
  };

  const perLine: ClubShare['perLine'] = [];
  const roundingNotes: string[] = [];
  for (const t of taxLines) {
    const clubTax = taxOver(t, club);
    const computedAllCents = t.printedCents !== null ? taxOver(t, items) : null;
    perLine.push({ label: t.label, clubTaxCents: clubTax, computedAllCents, printedCents: t.printedCents });
    if (computedAllCents !== null && t.printedCents !== null && computedAllCents !== t.printedCents) {
      const gap = Math.abs(computedAllCents - t.printedCents);
      roundingNotes.push(
        `${t.label} worked out to ${dollars(computedAllCents)} over every item, the receipt prints ${dollars(t.printedCents)} (${gap} ${gap === 1 ? 'cent' : 'cents'} apart).` +
          (gap > items.length ? ' Check the tax codes.' : ''),
      );
    }
  }

  const clubTaxCents = perLine.reduce((s, l) => s + l.clubTaxCents, 0);
  return {
    clubNetCents,
    clubTaxCents,
    clubShareCents: clubNetCents + clubTaxCents,
    mode,
    perLine,
    roundingNotes,
  };
}
