import { describe, it, expect } from 'vitest';
import { buildDuesSplit } from '../dues-split';

// The Season dues split on /fees and on the dashboard. Campus Rec payers are paid,
// so they are part of the billable total and of the share that is in; their
// money is simply not the club's, so it is not in "Collected".
describe('buildDuesSplit', () => {
  it('is the old two-part split when nothing went through Campus Rec', () => {
    const { split, tones, paidPct } = buildDuesSplit({
      collectedCents: 3000,
      sfuRecCents: 0,
      outstandingCents: 1000,
    });
    expect(split.segments.map((s) => s.label)).toEqual(['Collected', 'Still owed']);
    expect(split.total).toBe(4000);
    expect(tones).toHaveLength(2);
    expect(paidPct).toBe(75);
  });

  it('adds Campus Rec as a third segment that still counts as paid', () => {
    const { split, tones, paidPct } = buildDuesSplit({
      collectedCents: 2000,
      sfuRecCents: 1000,
      outstandingCents: 1000,
    });
    expect(split.segments.map((s) => [s.label, s.value])).toEqual([
      ['Collected', 2000],
      ['Collected by Campus Rec', 1000],
      ['Still owed', 1000],
    ]);
    // The billable total is unchanged by where the money went.
    expect(split.total).toBe(4000);
    expect(tones).toHaveLength(3);
    expect(paidPct).toBe(75);
  });

  it('is zero paid for an empty term rather than NaN', () => {
    const { split, paidPct } = buildDuesSplit({ collectedCents: 0, sfuRecCents: 0, outstandingCents: 0 });
    expect(split.total).toBe(0);
    expect(paidPct).toBe(0);
  });
});
