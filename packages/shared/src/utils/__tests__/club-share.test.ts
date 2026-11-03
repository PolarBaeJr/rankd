import { describe, it, expect } from 'vitest';
import { computeClubShare, roundHalfUp, type ShareItem, type ShareTaxLine } from '../club-share';

// Every figure is worked by hand in the comment beside it. GST is 5% and PST
// 7%, as rates in parts per million.

const GST: ShareTaxLine = { label: 'GST', ratePpm: 50000, printedCents: null, codes: ['G', 'P'] };
const PST: ShareTaxLine = { label: 'PST', ratePpm: 70000, printedCents: null, codes: ['P'] };

const item = (netCents: number, taxCode: string | null, isClub = true): ShareItem => ({ netCents, taxCode, isClub });

describe('computeClubShare', () => {
  it('with every item ticked, is the subtotal plus the tax worked out per line', () => {
    // G 10.00 and P 20.00: GST 5% of 30.00 = 1.50, PST 7% of 20.00 = 1.40.
    const share = computeClubShare(
      [item(1000, 'G'), item(2000, 'P')],
      [{ ...GST, printedCents: 150 }, { ...PST, printedCents: 140 }],
    );
    expect(share.mode).toBe('by_code');
    expect(share.clubShareCents).toBe(3000 + 150 + 140);
    expect(share.roundingNotes).toEqual([]);
  });

  it('notes a till that rounded per item', () => {
    // Three items of 0.33 G: 5% of 0.99 = 0.0495, rounds to 0.05. The till
    // rounded each 0.0165 to 0.02 and printed 0.06.
    const share = computeClubShare([item(33, 'G'), item(33, 'G'), item(33, 'G')], [{ ...GST, printedCents: 6 }]);
    expect(share.clubTaxCents).toBe(5);
    expect(share.roundingNotes).toEqual([
      'GST worked out to $0.05 over every item, the receipt prints $0.06 (1 cent apart).',
    ]);
  });

  it('counts only ticked items, each taxed by its own code', () => {
    // Untaxed grocery 5.00 (personal), G 10.00 (club), P 20.00 (personal), P 4.00 (club).
    // Club net 14.00; GST 5% of 14.00 = 0.70; PST 7% of 4.00 = 0.28.
    const share = computeClubShare(
      [item(500, null, false), item(1000, 'G'), item(2000, 'P', false), item(400, 'P')],
      [GST, PST],
    );
    expect(share.clubNetCents).toBe(1400);
    expect(share.perLine.map((l) => l.clubTaxCents)).toEqual([70, 28]);
    expect(share.clubShareCents).toBe(1498);
  });

  it('splits a combined tax line with no rate by the taxed base', () => {
    // TAX 3.00 printed over T items of 10.00 and 30.00; the club takes the 10.00: 3.00 * 10/40 = 0.75.
    const share = computeClubShare(
      [item(1000, 'T'), item(3000, 'T', false), item(500, null)],
      [{ label: 'TAX', ratePpm: null, printedCents: 300, codes: ['T'] }],
    );
    expect(share.clubTaxCents).toBe(75);
    expect(share.clubShareCents).toBe(1000 + 500 + 75);
  });

  it('splits by share of the items when the receipt prints no code', () => {
    // GST 2.00 over 10.00 + 30.00; the club takes 10.00: 2.00 * 10/40 = 0.50.
    const share = computeClubShare(
      [item(1000, null), item(3000, null, false)],
      [{ label: 'GST', ratePpm: 50000, printedCents: 200, codes: [] }],
    );
    expect(share.mode).toBe('proportional');
    expect(share.clubShareCents).toBe(1050);
  });

  it('changes when the exec sets a different code', () => {
    const lines = [GST, PST];
    const before = computeClubShare([item(1000, 'G')], lines).clubShareCents; // 10.50
    const after = computeClubShare([item(1000, 'P')], lines).clubShareCents; // 10.00 + 0.50 + 0.70
    expect(before).toBe(1050);
    expect(after).toBe(1120);
  });

  it('has no tax at all when the receipt prints none', () => {
    const share = computeClubShare([item(1000, 'G'), item(500, null, false)], []);
    expect(share.mode).toBe('none');
    expect(share.clubShareCents).toBe(1000);
  });

  it('rounds half up', () => {
    expect(roundHalfUp(5, 10)).toBe(1);
    expect(roundHalfUp(4, 10)).toBe(0);
    expect(roundHalfUp(-5, 10)).toBe(-1);
    // 5% of 0.10 = 0.005, which is half a cent: up to 0.01.
    expect(computeClubShare([item(10, 'G')], [GST]).clubTaxCents).toBe(1);
  });

  it('stays in whole cents over many items', () => {
    const many = Array.from({ length: 200 }, (_, i) => item(101 + i, i % 2 ? 'G' : 'P', i % 3 !== 0));
    const share = computeClubShare(many, [GST, PST]);
    for (const value of [share.clubNetCents, share.clubTaxCents, share.clubShareCents]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(share.clubShareCents).toBe(share.clubNetCents + share.clubTaxCents);
  });
});
