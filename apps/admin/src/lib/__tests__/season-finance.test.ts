import { describe, it, expect } from 'vitest';
import { getSeasonFinances } from '../season-finance';

// Same PostgREST-shaped stub as season-income.test.ts: every builder method
// returns `this`, and the chain is awaited for its rows. Records which table
// each chain started from, and with which filters, so a test can assert the
// scoping that actually decides a money figure.
//
// club_fees rows are keyed by fee_type, because since 00094 one table holds
// dues, entry fees and reinstatements and getSeasonIncome reads it three times.
// A stub that ignored fee_type would hand every read the whole table and report
// the club's income at three times the money — which is the exact bug the
// filters exist to prevent, so the stub models them.
function makeClient(rows: {
  dues?: Record<string, unknown>[];
  tournament?: Record<string, unknown>[];
  reinstatement?: Record<string, unknown>[];
  income?: Record<string, unknown>[];
  expense?: Record<string, unknown>[];
}) {
  const calls: { table: string; filters: string[] }[] = [];
  return {
    calls,
    from(table: string) {
      const entry = { table, filters: [] as string[] };
      calls.push(entry);
      let feeType: string | null = null;
      let direction: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === 'fee_type') feeType = String(val);
          if (col === 'direction') direction = String(val);
          entry.filters.push(`eq:${col}=${val}`);
          return chain;
        },
        gte: (col: string, val: unknown) => { entry.filters.push(`gte:${col}=${val}`); return chain; },
        lte: (col: string, val: unknown) => { entry.filters.push(`lte:${col}=${val}`); return chain; },
        not: (col: string, op: string) => { entry.filters.push(`not:${col}:${op}`); return chain; },
        then: (resolve: (v: { data: unknown }) => unknown) => {
          if (table === 'club_fees') {
            return resolve({
              data: feeType
                ? rows[feeType as 'dues' | 'tournament' | 'reinstatement'] ?? []
                : [...(rows.dues ?? []), ...(rows.tournament ?? []), ...(rows.reinstatement ?? [])],
            });
          }
          if (table === 'club_ledger') {
            // Same modelling as club_fees above and for the same reason (00159):
            // an unfiltered read gets BOTH directions. Here that is worse than a
            // double count — getSeasonFinances SUBTRACTS what this returns, so
            // an unfiltered expense read books the club's income as spending and
            // moves the net position by twice every donation.
            return resolve({
              data: direction
                ? rows[direction as 'income' | 'expense'] ?? []
                : [...(rows.income ?? []), ...(rows.expense ?? [])],
            });
          }
          return resolve({ data: [] });
        },
      };
      return chain;
    },
  };
}

const SEASON = { id: 'season-1' };

describe('getSeasonFinances', () => {
  // The whole point of the feature: "to check if we are in the positives".
  // Income and expenses coming from one call is what makes the answer
  // trustworthy — the last time two figures were derived separately they
  // disagreed with reality for months.
  it('nets expenses off income', async () => {
    const client = makeClient({
      dues: [{ amount_cents: 20000 }],
      expense: [{ amount_cents: 8400, category: 'shuttles' }],
    });

    const f = await getSeasonFinances(client as never, SEASON);

    expect(f.income.totalCents).toBe(20000);
    expect(f.expenseCents).toBe(8400);
    expect(f.netCents).toBe(11600);
  });

  // A negative net is the answer the club owner most needs to see. Clamping it
  // at zero, or rendering the absolute value without a sign, would report
  // "in the positives" while the club is overdrawn — the single worst thing
  // this page could do.
  it('reports a negative net rather than clamping at zero', async () => {
    const client = makeClient({
      dues: [{ amount_cents: 5000 }],
      expense: [{ amount_cents: 12000, category: 'court_rental' }],
    });

    const f = await getSeasonFinances(client as never, SEASON);
    expect(f.netCents).toBe(-7000);
  });

  // Dues paid on the Campus Rec website went to Campus Rec, not to the club, so they
  // do not lift the net. The members are still paid; the money is just not
  // the club's to spend. It travels beside the net as its own figure.
  it('leaves money Campus Rec collected out of the net', async () => {
    const client = makeClient({
      dues: [
        { amount_cents: 20000, method: 'e_transfer' },
        { amount_cents: 6000, method: 'sfu_rec' },
      ],
      expense: [{ amount_cents: 8400, category: 'shuttles' }],
    });

    const f = await getSeasonFinances(client as never, SEASON);
    expect(f.income.totalCents).toBe(20000);
    expect(f.income.collectedBySfuRecCents).toBe(6000);
    expect(f.netCents).toBe(11600);
  });

  // Other income is money in and must lift the net. It reaches this helper
  // through getSeasonIncome, so this also pins that the two helpers are wired
  // together rather than each reading its own subset of the ledgers.
  it('counts other income on the income side of the net', async () => {
    const client = makeClient({
      income: [{ amount_cents: 10000 }],
      expense: [{ amount_cents: 2500, category: 'food' }],
    });

    const f = await getSeasonFinances(client as never, SEASON);
    expect(f.income.otherCents).toBe(10000);
    expect(f.netCents).toBe(7500);
  });

  // Expenses are scoped by season_id, never by a date window. reinstatement
  // fees were bucketed by paid_at and a payment taken between terms fell
  // outside every window and vanished from every total (00069). A shuttle
  // order placed in August for a September season is the identical shape.
  it('scopes expenses by season_id and not by date', async () => {
    const client = makeClient({ expense: [{ amount_cents: 700, category: 'shuttles' }] });
    const f = await getSeasonFinances(client as never, SEASON);
    expect(f.expenseCents).toBe(700);

    const expenses = client.calls.find((c) => c.table === 'club_ledger')!;
    expect(expenses.filters).toContain('eq:season_id=season-1');
    expect(expenses.filters.some((x) => x.includes('paid_at='))).toBe(false);
    // Same paid_at rule as every income ledger: money that has not left yet is
    // not spent.
    expect(expenses.filters).toContain('not:paid_at:is');
  });

  // The category chips under the headline are built from the same rows as the
  // total. If they were a second query or a second filter they could disagree,
  // and a breakdown that does not add up to its own total is worse than none.
  it('breaks expenses down into parts that add up to the whole', async () => {
    const client = makeClient({
      expense: [
        { amount_cents: 4000, category: 'shuttles' },
        { amount_cents: 2000, category: 'shuttles' },
        { amount_cents: 9000, category: 'court_rental' },
      ],
    });

    const f = await getSeasonFinances(client as never, SEASON);

    expect(f.expenseCents).toBe(15000);
    expect(f.expensesByCategory.reduce((a, c) => a + c.cents, 0)).toBe(15000);
    // Sorted biggest first, so the chip that explains the spend is read first.
    expect(f.expensesByCategory).toEqual([
      { category: 'court_rental', cents: 9000 },
      { category: 'shuttles', cents: 6000 },
    ]);
  });

  // A row whose category the console no longer knows about still cost money.
  // Grouping it under 'other' for display must not remove it from the total —
  // silently dropping a row from a money figure is the failure mode this whole
  // feature was written around.
  it('keeps a null-category row in the total', async () => {
    const client = makeClient({
      expense: [
        { amount_cents: 1000, category: null },
        { amount_cents: 500, category: 'food' },
      ],
    });

    const f = await getSeasonFinances(client as never, SEASON);
    expect(f.expenseCents).toBe(1500);
    expect(f.expensesByCategory.reduce((a, c) => a + c.cents, 0)).toBe(1500);
  });

  // A missing amount must read as zero, not NaN. One NaN poisons the total and
  // the net, and "$NaN" on the dashboard is a figure nobody can act on.
  it('treats a missing amount as zero rather than NaN', async () => {
    const client = makeClient({
      dues: [{ amount_cents: 5000 }],
      expense: [{ amount_cents: null, category: 'other' }, { amount_cents: 100, category: 'other' }],
    });

    const f = await getSeasonFinances(client as never, SEASON);
    expect(f.expenseCents).toBe(100);
    expect(f.netCents).toBe(4900);
  });

  it('is a clean zero when nothing has been recorded', async () => {
    const f = await getSeasonFinances(makeClient({}) as never, SEASON);
    expect(f.income.totalCents).toBe(0);
    expect(f.expenseCents).toBe(0);
    expect(f.netCents).toBe(0);
    expect(f.expensesByCategory).toEqual([]);
  });

  // A FAILED query is not an empty ledger. Read as one, it produces a number
  // that looks fine and is short by whatever the failed ledger held — and for
  // expenses specifically it makes netCents equal income exactly, reporting the
  // club as maximally in the positives at the moment the spend cannot be read.
  //
  // Not hypothetical: this console deploys through CI while migrations are
  // applied BY HAND, so between the deploy of this code and 00073 being run the
  // club_ledger query fails every time. Throwing turns that window into an
  // error page somebody fixes; swallowing it turns it into a wrong figure
  // nobody questions.
  it('throws rather than reporting a failed expense query as zero spend', async () => {
    const client = {
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: null, error: { message: 'relation "club_ledger" does not exist' } }),
        };
        return chain;
      },
    };

    await expect(getSeasonFinances(client as never, SEASON)).rejects.toThrow(/club_ledger/);
  });

  // THE NET-POSITION DECISION FOR REIMBURSEMENT (00077), pinned.
  //
  // An expense counts in full whether or not the exec who fronted it has been
  // paid back. Net is what the season COST the club; reimbursing someone is the
  // club settling a debt it already owed, not a second spend and not the
  // undoing of the first.
  //
  // The rejected alternative — count only settled expenses, making net track
  // the bank balance — fails twice, and both failures are visible right here:
  // netCents would RISE at the moment cash actually left the club, and an
  // unsettled shuttle bill would be invisible while the club still owed for it.
  // "Are we in the positives" has to include a commitment already made.
  it('counts a reimbursed expense exactly the same as an unreimbursed one', async () => {
    const rows = (reimbursed: boolean) => ({
      dues: [{ amount_cents: 20000 }],
      expense: [
        {
          amount_cents: 8400,
          category: 'shuttles',
          paid_by: 'exec-1',
          reimbursed_at: reimbursed ? '2026-09-10T12:00:00.000Z' : null,
        },
      ],
    });

    const owed = await getSeasonFinances(makeClient(rows(false)) as never, SEASON);
    const settled = await getSeasonFinances(makeClient(rows(true)) as never, SEASON);

    expect(owed.expenseCents).toBe(8400);
    expect(settled.expenseCents).toBe(8400);
    expect(settled.netCents).toBe(owed.netCents);
    expect(settled.netCents).toBe(11600);
  });

  // And the query must not learn about the columns at all. A `.not(...)` or
  // `.is(...)` on reimbursed_at appearing here would be the cash-basis change
  // arriving by accident, quietly moving every net figure on two pages.
  it('does not filter the expense query on reimbursement state', async () => {
    const client = makeClient({ expense: [{ amount_cents: 8400, category: 'shuttles' }] });

    await getSeasonFinances(client as never, SEASON);

    const expenseQuery = client.calls.find((c) => c.table === 'club_ledger')!;
    expect(expenseQuery.filters.some((f) => f.includes('reimbursed'))).toBe(false);
  });
});
