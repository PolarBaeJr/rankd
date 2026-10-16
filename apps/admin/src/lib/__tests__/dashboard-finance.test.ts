import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getDashboardFinances } from '../dashboard-finance';

// WHICH LEDGERS ARE ACTUALLY QUERIED, per capability.
//
// The rule the money pages follow is that a hidden card whose query still ran
// has already shipped the figure — so "gated" has to mean the fetch, not the
// JSX. That claim is untestable while the mapping lives inline in a server
// component, so it lives in one function and this file asserts the only thing
// worth asserting about it: WHICH TABLES WERE TOUCHED.
//
// The tables named below are the club's separate books. Someone holding
// fees.expenses.read may see what the club has spent and nothing about what it
// has taken in, so club_fees, the income half of club_ledger, tournament_fees and
// reinstatement_fees must not be read on their behalf at all — and it is the
// composite helpers (getSeasonFinances, getSeasonIncome) that would read them,
// which is why the per-ledger entry points exist.
//
// `seasons` NO LONGER APPEARS IN THESE LISTS, and that is the point rather than
// a relaxation: the dashboard reads the active season once at the top of the
// page for the header eyebrow, and this function was selecting it a second time.
// It is handed in now. Every claim below about which BOOKS are opened is
// unchanged — the only table that left the assertions is the one that stopped
// being fetched.

const SEASON = { id: 'season-1', name: 'Fall 2026' };

/**
 * A Supabase stand-in that records every BOOK opened.
 *
 * A book is no longer the same thing as a table. 00159 put income and expenses
 * in one `club_ledger`, so "which books did this fetch open" — the only
 * question this file asks — is now answered by the table AND the `direction`
 * filter together. Recording the table alone would report a fetch for somebody
 * who may see expenses and no income as having opened the same book as one who
 * may see both, and every assertion here would go quietly green while the leak
 * it guards against was reintroduced.
 *
 * So a club_ledger read is recorded as `club_ledger:<direction>`, and a read
 * that applies no direction is recorded as `club_ledger:UNFILTERED` — which no
 * assertion below permits, so forgetting the filter fails rather than passing
 * under a name that looks close enough.
 */
function makeClient(rows: Record<string, { amount_cents: number | null; method?: string | null }[]>) {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      let direction: string | null = null;
      // The label is pushed once the chain is awaited, so the direction filter
      // has already been applied by the time the name is decided.
      const label = () => (table === 'club_ledger' ? `club_ledger:${direction ?? 'UNFILTERED'}` : table);
      const api = {
        select: () => api,
        eq: (col?: string, val?: unknown) => {
          if (col === 'direction') direction = String(val);
          return api;
        },
        not: () => api,
        maybeSingle: async () => {
          tables.push(label());
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => unknown) => {
          tables.push(label());
          const key = table === 'club_ledger' ? (direction ?? '') : table;
          return Promise.resolve({ data: rows[key] ?? [], error: null }).then(resolve);
        },
      };
      return api;
    },
  };
  return { supabase: client as unknown as SupabaseClient, tables };
}

// The rows carry their dates and categories now, because the panels draw
// charts of them. That is the same read it always was — no ledger gained a
// query, each gained columns — and the assertions below check the thing that
// matters about it: the figure and the series come from ONE read, so the last
// point of a chart cannot disagree with the number printed beside it.
const LEDGERS = {
  expense: [
    { amount_cents: 8400, category: 'shuttles', paid_at: '2026-09-04T18:00:00+00:00', paid_by: 'exec-1', reimbursed_at: null },
    { amount_cents: 1600, category: 'food', paid_at: '2026-09-11T18:00:00+00:00', paid_by: null, reimbursed_at: null },
  ],
  club_fees: [{ amount_cents: 2000, paid_at: '2026-09-02T18:00:00+00:00' }],
  income: [{ amount_cents: 15000, category: 'grant', paid_at: '2026-09-03T18:00:00+00:00' }],
  tournament_fees: [{ amount_cents: 500 }],
  reinstatement_fees: [{ amount_cents: 2500 }],
};

describe('the dashboard finance fetch', () => {
  // THE FINANCE ROLE, which is the whole reason this exists: fees.page,
  // fees.expenses.read and fees.expenses.add.write, and no claim on any book
  // but the expense one.
  it('reads only the expense ledger for somebody who may only see expenses', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: true,
      clubFees: false,
      otherIncome: false,
    });

    expect(tables).toEqual(['club_ledger:expense']);
    expect(finances?.expenses?.expenseCents).toBe(10000);
    // Not an empty ledger — nothing was asked for, so there is no book to have.
    expect(finances?.clubFees).toBeNull();
    expect(finances?.otherIncome).toBeNull();
  });

  // THE CHART AND THE FIGURE ARE THE SAME READ. Both come back from the one
  // query above, so the running total's last point is the headline by
  // construction. A second query for the series is the thing this asserts
  // against: it could return a different set of rows and put two numbers that
  // disagree on the same card.
  it('returns the dated rows behind the expense figure, from that one read', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: true,
      clubFees: false,
      otherIncome: false,
    });

    expect(tables).toEqual(['club_ledger:expense']);
    const payments = finances?.expenses?.payments ?? [];
    expect(payments.map((p) => p.cents)).toEqual([8400, 1600]);
    expect(payments.reduce((n, p) => n + p.cents, 0)).toBe(finances?.expenses?.expenseCents);
    expect(finances?.expenses?.expensesByCategory).toEqual([
      { category: 'shuttles', cents: 8400 },
      { category: 'food', cents: 1600 },
    ]);
  });

  // MONEY THE CLUB OWES ITS OWN EXECS: a paid row somebody fronted that has not
  // been paid back. `paid_by` is required, not just a null reimbursed_at — a
  // court booking on the club's own card has nobody to reimburse, and counting
  // it would report a debt to a person who does not exist.
  it('counts only fronted, unreimbursed rows as owed back', async () => {
    const { supabase } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: true,
      clubFees: false,
      otherIncome: false,
    });

    expect(finances?.expenses?.owedToExecsCount).toBe(1);
    expect(finances?.expenses?.owedToExecsCents).toBe(8400);
  });

  it('reads only the club fee ledger for somebody who may only see club fees', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: false,
      clubFees: true,
      otherIncome: false,
    });

    expect(tables).toEqual(['club_fees']);
    expect(finances?.clubFees?.total).toBe(2000);
    expect(finances?.expenses).toBeNull();
    // club_fees has no category column, so the dues ledger has no breakdown —
    // and an invented "other" bucket holding the whole thing would draw a
    // one-bar chart that says nothing. Splitting it by fee_type instead is not
    // an option either: entry money and reinstatements are separate
    // capabilities' books.
    expect(finances?.clubFees?.byCategory).toEqual([]);
  });

  // The Season dues panel draws the club's dues and the dues Campus Rec collected
  // as separate segments, and both come off this one read of the dues ledger.
  it('splits the dues Campus Rec collected off the club figure in the same read', async () => {
    const { supabase, tables } = makeClient({
      club_fees: [
        { amount_cents: 2000, method: 'cash' },
        { amount_cents: 4000, method: 'sfu_rec' },
      ],
    });

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: false,
      clubFees: true,
      otherIncome: false,
    });

    expect(tables).toEqual(['club_fees']);
    expect(finances?.clubFees?.total).toBe(2000);
    expect(finances?.clubFees?.collectedBySfuRec).toBe(4000);
  });

  it('reads only the other-income ledger for somebody who may only see it', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: false,
      clubFees: false,
      otherIncome: true,
    });

    expect(tables).toEqual(['club_ledger:income']);
    expect(finances?.otherIncome?.total).toBe(15000);
    // The income ledger DOES carry a category, and unlike club_fees' fee_type every
    // one of them is the same permission — so this ledger gets a breakdown.
    expect(finances?.otherIncome?.byCategory).toEqual([{ category: 'grant', cents: 15000 }]);
  });

  // Even holding all three tiles' reads is not the net position, which is its
  // own capability over its own set of books: tournament money and
  // reinstatements belong to it and must stay unread here.
  it('never reads the ledgers behind the net position', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    await getDashboardFinances(supabase, SEASON, { expenses: true, clubFees: true, otherIncome: true });

    expect(tables).not.toContain('tournament_fees');
    expect(tables).not.toContain('reinstatement_fees');
    expect([...tables].sort()).toEqual(['club_fees', 'club_ledger:expense', 'club_ledger:income']);
  });

  // The season the figures are labelled with is the caller's, not one this
  // function went and found for itself. A second lookup could in principle
  // disagree with the header eyebrow above it.
  it('labels the figures with the season it was handed, without asking for one', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: true,
      clubFees: false,
      otherIncome: false,
    });

    expect(finances?.season).toEqual(SEASON);
    expect(tables).not.toContain('seasons');
  });

  // A viewer with no tile is a viewer with no query — including when a season
  // was handed in, because holding the row is not a reason to open a book.
  it('asks the database nothing at all when no ledger may be seen', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, SEASON, {
      expenses: false,
      clubFees: false,
      otherIncome: false,
    });

    expect(finances).toBeNull();
    expect(tables).toEqual([]);
  });

  // Between terms there is no season to total, and the ledgers are keyed by
  // season_id — so there is nothing to add up and nothing to ask for. The
  // question moved from "did the lookup find one" to "did the caller have one";
  // the answer this function gives is the one it always gave, and it now costs
  // nothing to give it.
  it('reads no ledger at all when the club has no active season', async () => {
    const { supabase, tables } = makeClient(LEDGERS);

    const finances = await getDashboardFinances(supabase, null, {
      expenses: true,
      clubFees: true,
      otherIncome: true,
    });

    expect(finances).toBeNull();
    expect(tables).toEqual([]);
  });
});
