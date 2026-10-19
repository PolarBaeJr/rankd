import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isWaivedFee, summariseFeeCollection, type FeeStatusRow } from '../fee-status';

// THE STRIP HAS TO ADD UP.
//
// Paid, Outstanding and Waived sit next to each other above the fee table, so a
// reader subtracts them and expects the answer to be the table. Before this
// they were assembled from two different populations — Paid was roster-paid
// plus every manual entry taken on trust, Outstanding was derived from the
// roster alone — and the manual half was never actually tested for whether it
// was paid.
//
// The property worth defending is not any one figure: it is that the three
// partition the list, whatever is in it.

const PAID: FeeStatusRow = { paid_at: '2026-01-05T00:00:00.000Z', method: 'cash' };
const WAIVED: FeeStatusRow = { paid_at: '2026-01-05T00:00:00.000Z', method: 'waived' };
const UNPAID: FeeStatusRow = { paid_at: null, method: null };
/** A roster player with no club_fees row at all. */
const NO_ROW = undefined;

describe('summariseFeeCollection', () => {
  it('is empty for an empty roster', () => {
    expect(summariseFeeCollection([])).toEqual({ total: 0, paid: 0, outstanding: 0, waived: 0 });
  });

  it('classifies the three states', () => {
    expect(summariseFeeCollection([PAID, UNPAID, WAIVED, NO_ROW])).toEqual({
      total: 4,
      paid: 1,
      outstanding: 2,
      waived: 1,
    });
  });

  it('treats a missing fee row the same as an unpaid one', () => {
    // A player who has never been billed is outstanding, not uncounted.
    expect(summariseFeeCollection([NO_ROW, null]).outstanding).toBe(2);
  });

  it('partitions the list for every combination', () => {
    const shapes: Array<FeeStatusRow | null | undefined> = [PAID, UNPAID, WAIVED, NO_ROW, null];
    for (const a of shapes) {
      for (const b of shapes) {
        for (const c of shapes) {
          const s = summariseFeeCollection([a, b, c]);
          expect(s.paid + s.outstanding + s.waived).toBe(3);
          expect(s.total).toBe(3);
          expect(s.outstanding).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('counts a waived manual entry as Waived, not as Paid', () => {
    // THE REGRESSION. Paid was `paidPlayers + manualFees.length`, so a manual
    // entry was Paid by virtue of existing. A roster row in the identical state
    // — paid_at set, method 'waived' — counted as Waived. Same data, two
    // answers, depending only on which half of the list it landed in.
    //
    // 'waived' is reserved (payment-methods.ts) and the manual-fee dialog
    // refuses it, but manualFeeSchema types method as a plain string so the
    // server does not, and rows predate the fixed method list.
    const roster = [WAIVED];
    const manual = [WAIVED];
    const s = summariseFeeCollection([...roster, ...manual]);
    expect(s.waived).toBe(2);
    expect(s.paid).toBe(0);
  });

  it('does not count a manual entry that was never marked paid', () => {
    // addManualFee always stamps paid_at, so this needs a direct insert to
    // happen — but `manualFees.length` would have called it Paid regardless,
    // and a figure that cannot be wrong is a figure that is not being computed.
    const s = summariseFeeCollection([PAID, { paid_at: null, method: 'cash' }]);
    expect(s.paid).toBe(1);
    expect(s.outstanding).toBe(1);
  });

  it('agrees with the old arithmetic on well-formed data', () => {
    // What the club will actually see. Ten members: six paid, one waived, three
    // outstanding; plus two manual entries, both properly paid. The old code
    // gave Paid 8 / Outstanding 3 / Waived 1 and so does this — the change is
    // that it now also holds when the data is not well-formed.
    const roster = [PAID, PAID, PAID, PAID, PAID, PAID, WAIVED, UNPAID, NO_ROW, NO_ROW];
    const manual = [PAID, PAID];

    const oldPaidPlayers = 6;
    const oldWaivedPlayers = 1;
    const oldPaidCount = oldPaidPlayers + manual.length;
    const oldOutstandingCount = roster.length - oldPaidPlayers - oldWaivedPlayers;

    const s = summariseFeeCollection([...roster, ...manual]);
    expect(s.paid).toBe(oldPaidCount);
    expect(s.outstanding).toBe(oldOutstandingCount);
    expect(s.waived).toBe(oldWaivedPlayers);
    expect(s.total).toBe(12);
  });
});

describe('isWaivedFee', () => {
  it('needs both the stamp and the method', () => {
    // Guarding the predicate the summary is built on: a row with method
    // 'waived' and no paid_at is an unfinished waiver, not a waived fee.
    expect(isWaivedFee(WAIVED)).toBe(true);
    expect(isWaivedFee({ paid_at: null, method: 'waived' })).toBe(false);
    expect(isWaivedFee(PAID)).toBe(false);
    expect(isWaivedFee(null)).toBe(false);
    expect(isWaivedFee(undefined)).toBe(false);
  });
});

// The rows under the strip, read off disk: no test here mounts the page. A
// named dues row used to be drawn Paid whatever it held, and a Google Form now
// files unpaid ones for non-members (00290).
describe('the /fees named rows', () => {
  const page = readFileSync(join(__dirname, '../../app/fees/page.tsx'), 'utf8');
  const named = page.slice(page.indexOf('...manualFees.map((fee) =>'), page.indexOf('after={'));

  it('test paid_at the way a member row does', () => {
    expect(named).toContain('const waived = isWaived(fee);');
    expect(named).toContain('const paid = Boolean(fee.paid_at) && !waived;');
    expect(named).not.toContain('<Badge variant="success">Paid</Badge>');
    expect(named.match(/\{paid \? 'Paid' : waived \? 'Waived' : 'Unpaid'\}/g)).toHaveLength(2);
  });
});
