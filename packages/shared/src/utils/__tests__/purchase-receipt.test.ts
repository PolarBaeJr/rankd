import { describe, it, expect } from 'vitest';
import { joinReceiptPages, parsePurchaseReceipt } from '../purchase-receipt';

// EVERY STORE, NUMBER AND ITEM BELOW IS MADE UP. The layouts copy the shapes
// of real till slips (a card slip, a printing bill, a warehouse club, a
// supercentre); nothing here was read off a real receipt. Each slip prints its
// own tax legend where it uses codes, because codes are only ever mapped from
// what the receipt itself says.

const TODAY = new Date(2026, 10, 3);
const read = (lines: string[]) => parsePurchaseReceipt(lines.join('\n'), { today: TODAY });

const CARD_SLIP = [
  'MAPLELEAF PRINT & COPY LTD',
  '4410 Example Street',
  'SALE',
  '10/30/26 14:05',
  'VISA ************4821',
  'AUTH 01234Z',
  'AMOUNT $116.48',
  'APPROVED',
  'CUSTOMER COPY',
];

const PRINT_BILL = [
  'MAPLELEAF PRINT & COPY LTD',
  'Invoice # 99881',
  'QTY DESCRIPTION AMOUNT',
  '2 Banner vinyl 3x6 80.00',
  '250 Business cards 24.00',
  'SUBTOTAL 104.00',
  'GST 5% 5.20',
  'PST 7% 7.28',
  'TOTAL 116.48',
];

const WAREHOUSE = [
  'NORTHWIND WAREHOUSE',
  'MEMBER 111222333444',
  '1234567 KS WATER 40PK 4.99 A',
  '1234567 / INST SAV 1.00-',
  '7654321 SHUTTLE TUBE 12PK 30.00 A',
  'SUBTOTAL 33.99',
  'TAX 1.70',
  'TOTAL 35.69',
  'A = GST',
  'XXXXXXXXXXXX9876 VISA 35.69',
];

const SUPERCENTRE = [
  'VALUEMART SUPERCENTRE',
  'ST# 01234 OP# 00001 TE# 12 TR# 03456',
  'GV MILK 2L 062891234567 4.79 D',
  'SHUTTLECOCK TUBE 068700100123 29.97 J',
  'SUBTOTAL 34.76',
  'TAX 1 5.000 % 1.50',
  'TOTAL 36.26',
  'DEBIT TEND 36.26',
  'CHANGE DUE 0.00',
  'TOTAL SAVINGS 2.00',
  'TC# 1234 5678 9012 3456 7890',
  '10/30/26 13:42:05',
];

const MIXED = [
  'RIVERBEND GROCERS',
  'Oct 30 2026',
  'BANANAS 2.00',
  'SPORTS TAPE 10.00 G',
  'WATER BOTTLE 20.00 P',
  'SUBTOTAL 32.00',
  'GST 5% 1.50',
  'PST 7% 1.40',
  'TOTAL 34.90',
  'G = GST',
  'P = GST + PST',
];

const PRIVATE = ['4821', '111222333444', '1234 5678 9012 3456 7890', '01234Z', '01234', '00001', '03456', '062891234567', '068700100123', '1234567', '99881'];

describe('parsePurchaseReceipt', () => {
  it('reads a printing shop card slip', () => {
    const r = read(CARD_SLIP);
    expect(r.totalCents).toBe(11648);
    expect(r.date).toBe('2026-10-30');
    expect(r.store).toBe('MAPLELEAF PRINT & COPY LTD');
    expect(r.items).toEqual([]);
  });

  it('reads a printing shop bill with a quantity column', () => {
    const r = read(PRINT_BILL);
    expect(r.items).toEqual([
      { description: 'Banner vinyl 3x6', quantity: 2, unitPriceCents: 4000, lineTotalCents: 8000, discountCents: 0, taxCode: null },
      { description: 'Business cards', quantity: 250, unitPriceCents: null, lineTotalCents: 2400, discountCents: 0, taxCode: null },
    ]);
    expect(r.subtotalCents).toBe(10400);
    expect(r.totalCents).toBe(11648);
    expect(r.taxLines.map((t) => [t.label, t.ratePpm, t.printedCents])).toEqual([
      ['GST', 50000, 520],
      ['PST', 70000, 728],
    ]);
    expect(r.flags).toEqual(['no_date']);
  });

  it('reads a warehouse club slip, attaching an instant saving to its item', () => {
    const r = read(WAREHOUSE);
    expect(r.store).toBe('NORTHWIND WAREHOUSE');
    expect(r.items.map((i) => [i.description, i.lineTotalCents, i.discountCents, i.taxCode])).toEqual([
      ['KS WATER 40PK', 499, -100, 'A'],
      ['SHUTTLE TUBE 12PK', 3000, 0, 'A'],
    ]);
    expect(r.totalCents).toBe(3569);
    expect(r.taxLines).toEqual([{ label: 'TAX', ratePpm: null, printedCents: 170, codes: ['A'] }]);
    expect(r.flags).not.toContain('items_subtotal_mismatch');
    expect(r.flags).not.toContain('tax_codes_unmapped');
  });

  it('reads a supercentre slip without taking the tender, change or savings as the total', () => {
    const r = read(SUPERCENTRE);
    expect(r.totalCents).toBe(3626);
    expect(r.subtotalCents).toBe(3476);
    expect(r.date).toBe('2026-10-30');
    expect(r.items.map((i) => [i.description, i.lineTotalCents, i.taxCode])).toEqual([
      ['GV MILK 2L', 479, 'D'],
      ['SHUTTLECOCK TUBE', 2997, 'J'],
    ]);
    expect(r.taxLines[0]).toMatchObject({ label: 'TAX 1', ratePpm: 50000, printedCents: 150 });
    // Two codes, one tax line, no legend: not guessed.
    expect(r.flags).toContain('tax_codes_unmapped');
    expect(r.flags).not.toContain('totals_disagree');
  });

  it.each([
    ['VISA TEND 36.26'],
    ['CASH TEND 40.00'],
    ['YOU SAVED 2.00'],
  ])('ignores %s as a total', (line) => {
    const lines = SUPERCENTRE.map((l) => (l === 'DEBIT TEND 36.26' ? line : l));
    if (line.startsWith('CASH')) lines.splice(lines.indexOf('CHANGE DUE 0.00'), 1, 'CHANGE DUE 3.74');
    expect(read(lines).totalCents).toBe(3626);
  });

  it('maps codes from the legend, leaving an uncoded item untaxed', () => {
    const r = read(MIXED);
    expect(r.items.map((i) => i.taxCode)).toEqual([null, 'G', 'P']);
    expect(r.taxLines).toEqual([
      { label: 'GST', ratePpm: 50000, printedCents: 150, codes: ['G', 'P'] },
      { label: 'PST', ratePpm: 70000, printedCents: 140, codes: ['P'] },
    ]);
    expect(r.date).toBe('2026-10-30');
    expect(r.flags).toEqual([]);
  });

  it('flags two totals that disagree, and still answers the last', () => {
    const r = read(['SOME CAFE', 'Latte 50.00', 'TOTAL 50.00', 'TOTAL 55.00']);
    expect(r.totalCents).toBe(5500);
    expect(r.flags).toContain('totals_disagree');
  });

  it('reads a tip slip after a bill as the tip, not a disagreement', () => {
    const r = read(['SOME BISTRO', 'Team dinner 47.62', 'SUBTOTAL 47.62', 'GST 5% 2.38', 'TOTAL 50.00', 'TIP 8.00', 'TOTAL 58.00']);
    expect(r.totalCents).toBe(5800);
    expect(r.flags).toContain('tip_included');
    expect(r.flags).not.toContain('totals_disagree');
    expect(r.flags).not.toContain('subtotal_tax_total_mismatch');
  });

  it('never takes the SUBTOTAL as the total', () => {
    const r = read(['SOME SHOP', 'Thing 10.00', 'SUBTOTAL 10.00', 'AMOUNT 10.50']);
    expect(r.totalCents).toBe(1050);
    expect(read(['SOME SHOP', 'SUBTOTAL 10.00']).totalCents).toBeNull();
    expect(read(['SOME SHOP', 'SUBTOTAL 10.00']).flags).toContain('no_total');
  });

  it.each([
    ['2026-10-30', '2026-10-30'],
    ['Oct 30 2026', '2026-10-30'],
    ['October 30, 2026', '2026-10-30'],
    ['30-OCT-26', '2026-10-30'],
    ['30 Oct 2026', '2026-10-30'],
    ['30/10/2026', '2026-10-30'],
  ])('reads the date %s', (text, iso) => {
    const r = read(['SOME SHOP', text, 'TOTAL 1.00']);
    expect(r.date).toBe(iso);
    expect(r.flags).not.toContain('date_ambiguous');
  });

  it('flags a date that reads two ways, and refuses one in the future', () => {
    const ambiguous = read(['SOME SHOP', '03/04/26', 'TOTAL 1.00']);
    expect(ambiguous.date).toBe('2026-03-04');
    expect(ambiguous.flags).toContain('date_ambiguous');
    const future = read(['SOME SHOP', '12/30/26', 'TOTAL 1.00']);
    expect(future.date).toBeNull();
    expect(future.flags).toContain('no_date');
    expect(read(['SOME SHOP', 'TOTAL 1.00']).flags).toContain('no_date');
  });

  it('flags items that do not add up to the subtotal', () => {
    const r = read(['SOME SHOP', 'Thing 10.00', 'Other 5.00', 'SUBTOTAL 20.00', 'TOTAL 20.00']);
    expect(r.flags).toContain('items_subtotal_mismatch');
  });

  it('returns none of the card, membership, register or item numbers', () => {
    for (const fixture of [CARD_SLIP, PRINT_BILL, WAREHOUSE, SUPERCENTRE, MIXED]) {
      const out = JSON.stringify(read(fixture));
      for (const value of PRIVATE) expect(out).not.toContain(value);
    }
  });

  it('never throws', () => {
    expect(parsePurchaseReceipt(null).items).toEqual([]);
    expect(parsePurchaseReceipt('').totalCents).toBeNull();
    expect(() => parsePurchaseReceipt('$$$ ... 1.2.3 @@ \u0000 ////')).not.toThrow();
    expect(() => parsePurchaseReceipt(42 as unknown as string)).not.toThrow();
  });
});

describe('joinReceiptPages', () => {
  it('does not count the overlap between two photos of one receipt twice', () => {
    const top = WAREHOUSE.slice(0, 5).join('\n');
    const bottom = WAREHOUSE.slice(3).join('\n');
    const joined = joinReceiptPages([top, bottom]);
    expect(joined.split('\n')).toEqual(WAREHOUSE);
    expect(parsePurchaseReceipt(joined, { today: TODAY }).items).toHaveLength(2);
  });

  it('keeps pages in order and tolerates an empty one', () => {
    expect(joinReceiptPages(['A 1.00', '', 'B 2.00'])).toBe('A 1.00\nB 2.00');
  });
});
