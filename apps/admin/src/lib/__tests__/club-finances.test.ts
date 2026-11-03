import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';
import type { ExpenseReceiptType } from '@badminton/shared';

// The two non-fee money ledgers (00073): other income in, club expenses out —
// plus reimbursement of whoever fronted an expense (00077).
//
// Four things can go wrong with a money action and every one of them is silent
// in production, so each is pinned here:
//   1. someone writes to a ledger they are not allowed to write to — which is
//      now a per-ACTION question, not a per-file one: an exec may add an
//      expense and may do nothing else here;
//   2. a delete or an update "succeeds" against a row that was not there,
//      because PostgREST reports "matched no rows" as success;
//   3. money moves with nobody's name attached, because the audit write was
//      forgotten or was given the destroyed row too late to record it;
//   4. the wrong person is recorded as being owed money, because the payer was
//      taken from whoever typed the row instead of being asked for.

type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  actor: { id: 'admin-1', role: 'admin' } as { id: string; role: string; is_exec?: boolean;
    /** The auth.uid() a receipt's folder is named after. */
    user_id?: string;
    // The three permission columns, because the gate mock resolves them now —
    // an officer's writes come from a permission_role, not from is_exec.
    permission_role?: string;
    permission_grants?: string[];
    permission_revokes?: string[];
  },
  /** Makes the next delete match nothing, without removing the row. */
  swallowDeletes: false,
  /** Same, for updates: PostgREST cannot tell "matched nothing" from success. */
  swallowUpdates: false,
  /** Makes the next save_club_expense_details call fail outright. */
  failRpc: false,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const sets: Array<[string, unknown[]]> = [];
    let orderBy: string | null = null;
    let op: Op = 'select';
    let payload: Row = {};
    let selected = false;

    // `.is(col, null)` in PostgREST means SQL NULL. In this in-memory store a
    // column that was never written is `undefined` and one written as NULL is
    // `null`, and both are the same thing in Postgres — so the null filter has
    // to accept either. Plain `===` would make `.is('reimbursed_at', null)`
    // match no rows at all and the reimbursement tests would pass for the wrong
    // reason.
    const NULLISH = Symbol('is-null');
    const matching = () => {
      const hit = (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => (v === NULLISH ? r[c] == null : r[c] === v)) &&
          sets.every(([c, vs]) => vs.includes(r[c])),
      );
      return orderBy ? hit.sort((a, b) => Number(a[orderBy!]) - Number(b[orderBy!])) : hit;
    };

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        // Same trap as the delete below, and the one that matters most for
        // reimbursement: an update whose filters matched nothing comes back
        // with error null and an empty array, identical to a real write.
        if (store.swallowUpdates) return { data: [], error: null };
        const hit = matching();
        for (const row of hit) Object.assign(row, payload);
        return { data: selected ? hit : [], error: null };
      }
      if (op === 'delete') {
        // The heart of the guard under test: PostgREST returns `error: null`
        // and an EMPTY array when the filter matched nothing. Success and
        // "there was nothing there" are the same response.
        if (store.swallowDeletes) return { data: [], error: null };
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        // ON DELETE CASCADE from the three child tables (00313).
        if (table === 'club_ledger') {
          const gone = hit.map((r) => r.id);
          for (const child of ['club_expense_receipts', 'club_expense_items', 'club_expense_tax_lines']) {
            store.db[child] = (store.db[child] ?? []).filter((r) => !gone.includes(r.ledger_id));
          }
        }
        // `.select()` is what makes the deleted rows come back at all. Without
        // it PostgREST returns no rows even on a successful delete, so a caller
        // that skipped it could never tell the two apart.
        return { data: selected ? hit : [], error: null };
      }
      // COPIES, not the stored objects. PostgREST hands back parsed JSON, so a
      // row an action read earlier cannot change under it when the row is later
      // updated. Returning the live objects here would make every "audit the
      // old value" assertion pass against the NEW value and hide exactly the
      // bug those assertions exist to catch.
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { selected = true; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      in(c: string, vs: unknown[]) { sets.push([c, vs]); return api; },
      order(c: string) { orderBy = c; return api; },
      // `.is(col, null)` is load-bearing, not incidental: it is what makes
      // marking an already-reimbursed row match zero rows instead of silently
      // re-dating a settlement that happened weeks ago.
      is(c: string, v: unknown) { filters.push([c, v === null ? NULLISH : v]); return api; },
      async single() {
        const res = run();
        return res.error ? { data: null, error: res.error } : { data: res.data?.[0] ?? null, error: null };
      },
      async maybeSingle() {
        const res = run();
        return res.error ? { data: null, error: res.error } : { data: res.data?.[0] ?? null, error: null };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  // save_club_expense_details (00313), doing what the SQL does: refuse a
  // settled row, write the share, the vendor, the printed total and the
  // mirrored receipt_path, and replace the three child lists wholesale.
  async function rpc(name: string, args: Record<string, unknown>) {
    if (name !== 'save_club_expense_details') return { data: null, error: { message: `no ${name}` } };
    if (store.failRpc) return { data: null, error: { message: 'rpc failed' } };
    const id = args.p_ledger_id;
    const row = (store.db.club_ledger ?? []).find((r) => r.id === id && r.direction === 'expense');
    if (!row) return { data: 'not_found', error: null };
    if (row.reimbursed_at) return { data: 'settled', error: null };
    const receipts = args.p_receipts as Row[];
    Object.assign(row, {
      amount_cents: args.p_amount_cents,
      vendor: args.p_vendor,
      receipt_total_cents: args.p_receipt_total_cents,
      receipt_path: receipts[0]?.path ?? null,
    });
    for (const [table, list] of [
      ['club_expense_receipts', receipts],
      ['club_expense_items', args.p_items as Row[]],
      ['club_expense_tax_lines', args.p_tax_lines as Row[]],
    ] as const) {
      store.db[table] = (store.db[table] ?? [])
        .filter((r) => r.ledger_id !== id)
        .concat(list.map((x) => ({ ledger_id: id, ...x })));
    }
    return { data: 'ok', error: null };
  }
  return { from: (table: string) => query(table), rpc };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
// The REAL decision, not a stand-in: permits() against the real baselines, so
// these assertions are checking that EXEC_BASELINE says what the old gates said.
// WHICH CAPABILITY AN ACTION NAMES IS THE ENTIRE ACCESS STORY, because
// createAdminClient() is service-role and bypasses RLS — the route map only
// decides who may open a page, and a server action can be invoked without ever
// loading one.
// TWO THINGS MOVED HERE WHEN THE EXEC BASELINE NARROWED, and both make this
// mock a CLOSER copy of the real requireCapability rather than a looser one.
//
//   * It resolves the actor's STORED permissions instead of forcing UNRESTRICTED.
//     An officer's writes arrive from a permission_role now, so a mock that
//     ignores the role can only ever model an officer who has been given
//     nothing — and every action below is one somebody was given a job to do.
//     permissionsOf() is the same function the real gate calls.
//   * The wording reads from EXEC_ASSIGNABLE, mirroring denialFor() in
//     supabase-server.ts for the same reason it does: "Exec or admin access
//     required" answers what LEVEL would have been enough, and these are still
//     exec-tier acts even though an exec no longer holds them by default.
vi.mock('../actions/_shared', async () => {
  const { accessLevelFor, permissionsOf, permits, EXEC_ASSIGNABLE } =
    await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      const level = accessLevelFor(store.actor);
      if (!permits(level, permissionsOf(level, store.actor), capability)) {
        // The wording the old two-gate mock used, kept so the assertions below
        // still read as prose. Which of the two you get is decided by whether
        // the capability is exec-tier work at all.
        throw new Error(
          EXEC_ASSIGNABLE.includes(capability)
            ? 'Exec or admin access required'
            : 'Admin access required',
        );
      }
      return store.actor;
    },
  };
});

import {
  addOtherIncome,
  removeOtherIncome,
  addExpense,
  updateExpense,
  removeExpense,
  markExpenseReimbursed,
} from '../actions/finance';

const SEASON = '22222222-2222-4222-8222-222222222222';
const ADMIN = { id: 'admin-1', role: 'admin' };
// Real uuids, unlike the actor ids above: paid_by is validated as a uuid before
// the write, so a placeholder string would fail validation and the access-check
// assertions would pass for the wrong reason.
// THE OFFICER WHO FILES AN EXPENSE, WHICH IS NOW AN OFFICER WITH THE FINANCE
// JOB. This was a bare `is_exec` row because `fees.expenses.add.write` was in
// the exec baseline; the baseline is twelve reads now, so the club owner's
// "allow execs to add expenses too" is expressed by ASSIGNING Finance rather
// than by being an officer at all. Finance's three capabilities are exactly the
// Expenses tab, so every refusal asserted below is unchanged.
const EXEC = {
  id: '44444444-4444-4444-8444-444444444444',
  role: 'player',
  is_exec: true,
  permission_role: 'finance',
  permission_grants: [],
  permission_revokes: [],
};
const OTHER_EXEC = '33333333-3333-4333-8333-333333333333';
/** A member who is neither exec nor admin — nobody who can buy for the club. */
const MEMBER = '55555555-5555-4555-8555-555555555555';

/**
 * What the confirm dialog showed, sent back with the click. markExpenseReimbursed
 * settles only a row that still matches, so a click approves the figures it was
 * rendered with — not whatever the row says by the time the write lands.
 */
const CONFIRM = { amountCents: 8400, paidBy: OTHER_EXEC };

// ONE TABLE, TWO BOOKS (00159). The rows live together in the store exactly as
// they now live together in Postgres, and these accessors split them the way a
// query has to. That is deliberate rather than convenient: if an action forgets
// its `direction` filter, its delete or update reaches a row in the OTHER book,
// and a fake that kept two arrays could never show it.
const ledger = () => store.db.club_ledger ?? [];
const income = () => ledger().filter((r) => r.direction === 'income');
const expenses = () => ledger().filter((r) => r.direction === 'expense');
const audits = () => store.db.audit_logs ?? [];

/** An expense in the store, plus its id, for the tests that act on one. */
async function recordExpense(over: Partial<Record<string, unknown>> = {}) {
  await addExpense({
    season_id: SEASON,
    category: 'shuttles',
    description: '6 tubes',
    amount_cents: 8400,
    ...over,
  } as Parameters<typeof addExpense>[0]);
  return expenses()[expenses().length - 1]!.id as string;
}

beforeEach(() => {
  store.seq = 0;
  store.actor = { ...ADMIN };
  store.swallowDeletes = false;
  store.swallowUpdates = false;
  store.failRpc = false;
  store.db = {
    club_ledger: [],
    audit_logs: [],
    seasons: [{ id: SEASON, active_flag: true }],
    // The roster the payer check reads. Only an exec or an admin may be named
    // as having bought something for the club.
    players: [
      { id: ADMIN.id, role: 'admin', is_exec: false },
      { id: EXEC.id, role: 'player', is_exec: true },
      { id: OTHER_EXEC, role: 'player', is_exec: true },
      { id: MEMBER, role: 'player', is_exec: false },
    ],
  };
});

describe('addOtherIncome / addExpense', () => {
  it('records an entry against the season it was given', async () => {
    await addOtherIncome({
      season_id: SEASON,
      category: 'donation',
      description: 'Alumni donation',
      amount_cents: 15000,
    });

    expect(income()).toHaveLength(1);
    expect(income()[0]!.season_id).toBe(SEASON);
    expect(income()[0]!.amount_cents).toBe(15000);
  });

  // The season is a COLUMN, set from what the caller passed, and no code path
  // derives it from a date. reinstatement_fees was bucketed by paid_at and a
  // $20 payment taken three weeks before its term began fell outside every
  // window and appeared in no total (00069). An expense dated outside the
  // season must still count toward the season it was recorded under.
  it('keeps a back-dated expense in its season', async () => {
    await addExpense({
      season_id: SEASON,
      category: 'shuttles',
      description: 'Pre-season shuttle order',
      amount_cents: 8400,
      paid_at: '2026-08-01T12:00:00.000Z',
    });

    expect(expenses()[0]!.season_id).toBe(SEASON);
    expect(expenses()[0]!.paid_at).toBe('2026-08-01T12:00:00.000Z');
  });

  // paid_at is what makes a row count toward a total. Leaving it null on an
  // ordinary entry would file real money into a row every sum ignores, so the
  // action stamps it when the caller gives no date.
  it('stamps paid_at when no date is given, so the row is counted', async () => {
    await addExpense({
      season_id: SEASON,
      category: 'food',
      description: 'Social pizza',
      amount_cents: 6000,
    });

    expect(expenses()[0]!.paid_at).toBeTruthy();
  });

  it('records who entered it', async () => {
    await addExpense({ season_id: SEASON, category: 'equipment', description: 'Net', amount_cents: 4000 });
    expect(expenses()[0]!.marked_by).toBe(ADMIN.id);
  });

  // Money moving with nobody's name on it is what an audit trail exists for.
  it('audits both ledgers', async () => {
    await addOtherIncome({ season_id: SEASON, category: 'grant', description: 'SFSS grant', amount_cents: 50000 });
    await addExpense({ season_id: SEASON, category: 'court_rental', description: 'Gym block', amount_cents: 30000 });

    expect(audits().map((a) => a.action_type)).toEqual(['other_income_added', 'expense_added']);
  });

  // THE ONE THING AN EXEC MAY DO HERE. The club owner asked for it by name:
  // "allow execs to add expenses too". An exec who buys shuttles at the door
  // has to be able to record it, or the club never learns the money went out
  // and the exec is never paid back.
  it('lets an exec with the Finance job record an expense', async () => {
    store.actor = { ...EXEC };

    await addExpense({ season_id: SEASON, category: 'shuttles', description: '6 tubes', amount_cents: 8400 });

    expect(expenses()).toHaveLength(1);
    expect(expenses()[0]!.marked_by).toBe(EXEC.id);
  });

  // Every OTHER money mutation stays admin-only, and middleware is not what
  // makes it so: these actions run with a service-role client that bypasses RLS
  // entirely, so an ungated action is an open write endpoint regardless of the
  // route map — and a server action can be invoked without ever loading the
  // page it lives on. An exec runs the club and may now record a spend; they
  // may not delete one, may not edit one, may not touch the income ledger, and
  // above all may not confirm their own reimbursement.
  it('refuses an exec everything except adding an expense', async () => {
    // Set up as an admin so there is a real row for the exec to attack.
    const id = await recordExpense({ paid_by: EXEC.id });
    store.actor = { ...EXEC };

    await expect(addOtherIncome({ season_id: SEASON, category: 'donation', description: 'x', amount_cents: 100 }))
      .rejects.toThrow(/Admin access required/);
    await expect(removeOtherIncome('00000000-0000-4000-8000-000000000001'))
      .rejects.toThrow(/Admin access required/);
    await expect(removeExpense(id)).rejects.toThrow(/Admin access required/);
    await expect(updateExpense({ id, category: 'shuttles', description: 'x', amount_cents: 99999 }))
      .rejects.toThrow(/Admin access required/);
    // The one that would actually cost the club money: an exec marking their
    // own out-of-pocket expense as already paid back.
    await expect(markExpenseReimbursed(id, CONFIRM)).rejects.toThrow(/Admin access required/);

    expect(income()).toHaveLength(0);
    expect(expenses()).toHaveLength(1);
    expect(expenses()[0]!.amount_cents).toBe(8400);
    expect(expenses()[0]!.reimbursed_at).toBeUndefined();
  });

  // An ordinary member is not a console user at all, so they hold no baseline
  // and fees.expenses.add.write is not theirs — otherwise "execs may add
  // expenses" would read as "anyone may".
  it('refuses a plain member the one action an exec may take', async () => {
    store.actor = { id: 'player-9', role: 'player' };

    await expect(addExpense({ season_id: SEASON, category: 'shuttles', description: 'x', amount_cents: 100 }))
      .rejects.toThrow(/Exec or admin access required/);
    expect(expenses()).toHaveLength(0);
  });

  // paid_by is WHO FRONTED THE MONEY and is taken from the input, never from
  // the actor. The two differ every time an admin writes up an exec's receipt,
  // and deriving it from the actor would file the admin as the person owed —
  // then reimburse them.
  it('records the payer given, not whoever typed the row', async () => {
    await recordExpense({ paid_by: OTHER_EXEC });

    expect(expenses()[0]!.marked_by).toBe(ADMIN.id);
    expect(expenses()[0]!.paid_by).toBe(OTHER_EXEC);
  });

  // No payer means the club account paid directly. It has to be storable as
  // NULL rather than defaulted to somebody, or every club-card purchase would
  // create a phantom debt to a person.
  it('stores no payer at all when the club paid directly', async () => {
    await recordExpense();
    expect(expenses()[0]!.paid_by).toBeNull();
  });

  // The dialog only offers execs and admins, but the dialog is not the
  // boundary: a server action takes whatever payload it is handed, and the
  // schema checks paid_by only as "a uuid". Without a server-side check an exec
  // could name any member as the person the club owes money to, and an admin
  // would later be asked to settle that debt.
  it('refuses to name an ordinary member as the payer', async () => {
    await expect(recordExpense({ paid_by: MEMBER })).rejects.toThrow(/exec or an admin/i);
    expect(expenses()).toHaveLength(0);
  });

  it('refuses a payer who is not on the roster at all', async () => {
    await expect(recordExpense({ paid_by: '99999999-9999-4999-8999-999999999999' }))
      .rejects.toThrow(/not a member/i);
    expect(expenses()).toHaveLength(0);
  });

  it('refuses the same on an edit, not only on the insert', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });

    await expect(updateExpense({ id, category: 'shuttles', description: '6 tubes', amount_cents: 8400, paid_by: MEMBER }))
      .rejects.toThrow(/exec or an admin/i);
    expect(expenses()[0]!.paid_by).toBe(OTHER_EXEC);
  });

  // Validation runs before the write. A blank description makes a ledger line
  // nobody can identify a year later, and a fractional cent is not money.
  it('rejects an entry with no description', async () => {
    await expect(addExpense({ season_id: SEASON, category: 'shuttles', description: '   ', amount_cents: 100 }))
      .rejects.toThrow();
    expect(expenses()).toHaveLength(0);
  });
});

describe('removeOtherIncome / removeExpense', () => {
  it('deletes the row and audits what was destroyed', async () => {
    await addExpense({ season_id: SEASON, category: 'shuttles', description: '6 tubes', amount_cents: 8400 });
    const id = expenses()[0]!.id as string;

    await removeExpense(id);

    expect(expenses()).toHaveLength(0);
    const entry = audits().find((a) => a.action_type === 'expense_removed')!;
    // old_value read BEFORE the delete: afterwards there is nothing left to
    // read, and an audit row that records only "an expense was deleted" cannot
    // answer which one or for how much. There is a fee_waived row on production
    // with an empty old_value for exactly this reason.
    expect((entry.old_value as Row).amount_cents).toBe(8400);
  });

  // THE ONE THIS FILE EXISTS FOR. PostgREST reports a delete that matched no
  // rows as a success — `error` is null and the row array is empty — so a guard
  // that only checks `error` reports "Deleted" for a row that is still there,
  // or for one somebody else already removed. Several bugs shipped this way.
  it('refuses to report success when the delete matched nothing', async () => {
    await addExpense({ season_id: SEASON, category: 'shuttles', description: '6 tubes', amount_cents: 8400 });
    const id = expenses()[0]!.id as string;
    store.swallowDeletes = true;

    await expect(removeExpense(id)).rejects.toThrow(/not deleted/i);
    // And nothing is written to the audit log claiming it went.
    expect(audits().some((a) => a.action_type === 'expense_removed')).toBe(false);
  });

  it('refuses to report success when an income delete matched nothing', async () => {
    await addOtherIncome({ season_id: SEASON, category: 'donation', description: 'Alumni', amount_cents: 15000 });
    const id = income()[0]!.id as string;
    store.swallowDeletes = true;

    await expect(removeOtherIncome(id)).rejects.toThrow(/not deleted/i);
    expect(audits().some((a) => a.action_type === 'other_income_removed')).toBe(false);
  });

  // A delete of an id that never existed must not be reported as a deletion
  // either — same failure, one step earlier.
  it('rejects an unknown id instead of silently doing nothing', async () => {
    await expect(removeExpense('00000000-0000-4000-8000-000000009999')).rejects.toThrow(/not found/i);
    await expect(removeOtherIncome('00000000-0000-4000-8000-000000009999')).rejects.toThrow(/not found/i);
  });

  // ============================================================
  // THE INTERLOCK 00159 MADE NECESSARY
  // ============================================================
  // Before the merge, the table name was the boundary: removeOtherIncome could
  // not physically reach an expense, because expenses were in another table.
  // Now ids are unique across ONE ledger, so an expense id handed to the income
  // action would find a real row — and delete it — unless every id-keyed
  // statement also filters on `direction`.
  //
  // That matters beyond a mixed-up id. The two halves are separate
  // capabilities: a person may hold fees.otherincome.remove.write and NOT
  // fees.expenses.remove.write. Without the filter, the capability they DO hold
  // becomes a way to destroy rows in the book they do not. These two tests are
  // the only place that is checked, so they are worth more than their length.
  it('will not let the income action delete an expense', async () => {
    const expenseId = await recordExpense();
    expect(expenses()).toHaveLength(1);

    await expect(removeOtherIncome(expenseId)).rejects.toThrow(/not found/i);

    // Refused, and — the part that actually matters — the row is still there.
    expect(expenses()).toHaveLength(1);
    expect(audits().some((a) => a.action_type === 'other_income_removed')).toBe(false);
  });

  it('will not let the expense action delete an income entry', async () => {
    await addOtherIncome({
      season_id: SEASON,
      category: 'donation',
      description: 'Alumni',
      amount_cents: 15000,
    });
    const incomeId = income()[0]!.id as string;
    expect(income()).toHaveLength(1);

    await expect(removeExpense(incomeId)).rejects.toThrow(/not found/i);

    expect(income()).toHaveLength(1);
    expect(audits().some((a) => a.action_type === 'expense_removed')).toBe(false);
  });

  // The same interlock on the write paths, which are worse: a delete that
  // crossed books at least removes something the caller pointed at, while an
  // update that crosses books REWRITES a row in the other ledger and leaves it
  // looking ordinary.
  it('will not let the expense edit or settlement reach an income entry', async () => {
    await addOtherIncome({
      season_id: SEASON,
      category: 'donation',
      description: 'Alumni',
      amount_cents: 15000,
    });
    const incomeId = income()[0]!.id as string;

    await expect(
      updateExpense({
        id: incomeId,
        category: 'shuttles',
        description: 'rewritten',
        amount_cents: 1,
      } as Parameters<typeof updateExpense>[0]),
    ).rejects.toThrow(/not found/i);

    await expect(
      markExpenseReimbursed(incomeId, { amountCents: 15000, paidBy: OTHER_EXEC }),
    ).rejects.toThrow(/not found/i);

    const row = income()[0]!;
    expect(row.description).toBe('Alumni');
    expect(row.amount_cents).toBe(15000);
    expect(row.reimbursed_at ?? null).toBeNull();
  });
});

describe('markExpenseReimbursed', () => {
  it('records when the club paid the exec back, and which admin confirmed it', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });

    await markExpenseReimbursed(id, CONFIRM);

    const row = expenses()[0]!;
    expect(row.reimbursed_at).toBeTruthy();
    expect(row.reimbursed_by).toBe(ADMIN.id);
    // The payer is untouched: who was owed and who confirmed are two facts, and
    // overwriting one with the other is how "reimbursed to the admin who
    // clicked the button" would happen.
    expect(row.paid_by).toBe(OTHER_EXEC);
  });

  // THE ONE THIS BLOCK EXISTS FOR, and the money bug the whole feature risks.
  // PostgREST reports an update that matched NO rows exactly as it reports a
  // successful one: error null, empty array. Without a row-count check an admin
  // is toasted "Marked as reimbursed" for a write that never landed, the exec
  // is told they have been paid, and an audit row is filed swearing to it.
  it('refuses to report success when the update matched nothing', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    store.swallowUpdates = true;

    await expect(markExpenseReimbursed(id, CONFIRM)).rejects.toThrow(/not marked reimbursed/i);
    expect(audits().some((a) => a.action_type === 'expense_reimbursed')).toBe(false);
  });

  // Nothing to reimburse when the club account paid: marking such a row would
  // assert the club refunded itself, and would show a "Reimbursed" badge for
  // money nobody spent. 00077's club_ledger_reimbursement_needs_payer CHECK
  // is the same rule stated in the database.
  it('refuses a row the club paid for directly', async () => {
    const id = await recordExpense();

    await expect(markExpenseReimbursed(id, CONFIRM)).rejects.toThrow(/nobody to reimburse/i);
    expect(expenses()[0]!.reimbursed_at).toBeUndefined();
  });

  // A second click must not silently re-date a settlement that happened weeks
  // ago. The action refuses on the read, and the update's `.is(reimbursed_at,
  // null)` filter refuses again if two admins race.
  it('refuses to re-date an expense that is already reimbursed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id, CONFIRM);
    const first = expenses()[0]!.reimbursed_at;

    await expect(markExpenseReimbursed(id, CONFIRM)).rejects.toThrow(/already marked reimbursed/i);
    expect(expenses()[0]!.reimbursed_at).toBe(first);
  });

  it('rejects an unknown id instead of silently doing nothing', async () => {
    await expect(markExpenseReimbursed('00000000-0000-4000-8000-000000009999', CONFIRM))
      .rejects.toThrow(/not found/i);
  });

  // A CLICK APPROVES A FIGURE, NOT A ROW ID. The confirm dialog names an amount
  // and a person; if another admin edits the row in between, settling on the id
  // alone would apply that approval to numbers the approver never saw — "pay
  // Alice back her $84" quietly becoming "pay Bob $840". The amount and the
  // payer are part of the WHERE clause for exactly that reason.
  it('refuses to settle an amount the admin never confirmed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    // Somebody else corrects the figure between the render and the click.
    await updateExpense({ id, category: 'shuttles', description: '6 tubes', amount_cents: 84000, paid_by: OTHER_EXEC });

    await expect(markExpenseReimbursed(id, CONFIRM)).rejects.toThrow(/changed while you were looking/i);
    expect(expenses()[0]!.reimbursed_at).toBeUndefined();
  });

  it('refuses to settle against a payer the admin never confirmed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await updateExpense({ id, category: 'shuttles', description: '6 tubes', amount_cents: 8400, paid_by: EXEC.id });

    await expect(markExpenseReimbursed(id, CONFIRM)).rejects.toThrow(/changed while you were looking/i);
    expect(expenses()[0]!.reimbursed_at).toBeUndefined();
  });

  // Money moving with nobody's name on it is what the audit trail exists for,
  // and a reimbursement moves real money out of the club account.
  it('audits the settlement with both sides', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id, CONFIRM);

    const entry = audits().find((a) => a.action_type === 'expense_reimbursed')!;
    expect(entry.actor_id).toBe(ADMIN.id);
    expect((entry.old_value as Row).amount_cents).toBe(8400);
    expect((entry.new_value as Row).paid_by).toBe(OTHER_EXEC);
  });
});

describe('updateExpense', () => {
  it('corrects a recorded expense and audits both sides', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });

    await updateExpense({
      id,
      category: 'shuttles',
      description: '6 tubes of Yonex AS-30',
      amount_cents: 8900,
    });

    expect(expenses()[0]!.description).toBe('6 tubes of Yonex AS-30');
    expect(expenses()[0]!.amount_cents).toBe(8900);

    // Both values, so a changed FIGURE is reconstructible from the log alone.
    // An audit row that records only "an expense was edited" cannot answer what
    // the amount used to be, which is the only question anyone will ask.
    const entry = audits().find((a) => a.action_type === 'expense_updated')!;
    expect((entry.old_value as Row).amount_cents).toBe(8400);
    expect((entry.new_value as Row).amount_cents).toBe(8900);
  });

  // Same PostgREST trap as the delete and the reimbursement: an update that
  // matched nothing is reported as success, so an admin would be told a
  // corrected amount was saved while the row still holds the old one.
  it('refuses to report success when the update matched nothing', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    store.swallowUpdates = true;

    await expect(updateExpense({ id, category: 'shuttles', description: 'x', amount_cents: 1 }))
      .rejects.toThrow(/not updated/i);
    expect(audits().some((a) => a.action_type === 'expense_updated')).toBe(false);
  });

  // THE DECISION THIS FEATURE TURNS ON. Once the club has handed a specific
  // amount to a specific person, that figure is settled. Editing it would leave
  // the row asserting the club reimbursed something it did not — and the badge
  // says so on screen, where nobody cross-checks the audit log. A wrong
  // settlement is a delete-and-re-record, deliberately.
  it('refuses to change the amount of an expense that is already reimbursed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id, CONFIRM);

    await expect(updateExpense({ id, category: 'shuttles', description: '6 tubes', amount_cents: 9900 }))
      .rejects.toThrow(/already been reimbursed/i);
    expect(expenses()[0]!.amount_cents).toBe(8400);
  });

  // And the payer, for the same reason: the club paid THAT person. Repointing
  // it would claim someone was reimbursed who never received anything.
  it('refuses to change the payer of an expense that is already reimbursed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id, CONFIRM);

    await expect(updateExpense({
      id, category: 'shuttles', description: '6 tubes', amount_cents: 8400, paid_by: EXEC.id,
    })).rejects.toThrow(/already been reimbursed/i);
    expect(expenses()[0]!.paid_by).toBe(OTHER_EXEC);
  });

  // The typo case the club owner actually described still works on a settled
  // row. Freezing the whole row would have made the feature useless for the
  // most common edit, and none of these fields change what was paid.
  it('still allows a settled expense to have its description fixed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    await markExpenseReimbursed(id, CONFIRM);
    const settledAt = expenses()[0]!.reimbursed_at;

    // paid_by is resent unchanged. The update is a full replacement, exactly as
    // addExpense is, so an omitted payer means "the club paid" — the action
    // refuses that here rather than silently un-assigning the person the club
    // has already reimbursed.
    await updateExpense({
      id,
      category: 'equipment',
      description: 'Shuttle tubes (corrected)',
      amount_cents: 8400,
      paid_by: OTHER_EXEC,
    });

    expect(expenses()[0]!.description).toBe('Shuttle tubes (corrected)');
    expect(expenses()[0]!.category).toBe('equipment');
    // The settlement itself survives untouched — the edit must not clear or
    // re-date it. Clearing was the rejected alternative: the club really did
    // pay that money out, on that date, confirmed by that admin.
    expect(expenses()[0]!.reimbursed_at).toBe(settledAt);
    expect(expenses()[0]!.reimbursed_by).toBe(ADMIN.id);
  });

  // An UNSETTLED row's payer is correctable — picking the wrong person is one
  // of the mistakes this feature exists to fix, and there is no other way to
  // repair it once delete is admin-only.
  it('lets an unsettled expense be repointed at the right payer', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });

    await updateExpense({ id, category: 'shuttles', description: '6 tubes', amount_cents: 8400, paid_by: EXEC.id });

    expect(expenses()[0]!.paid_by).toBe(EXEC.id);
  });

  // AND OMITTING THE PAYER CLEARS IT. Pinned because it is a deliberate choice
  // that looks like a bug: the update is a full replacement, exactly like
  // addExpense, so an absent paid_by means "the club paid" and not "leave it
  // alone". There is no way to distinguish the two in a full-replacement
  // payload, and the alternative — treating absent as unchanged — would leave
  // no way to correct a row wrongly attributed to a person at all.
  //
  // The exposure is one caller: EditExpense always resends the stored value. On
  // a settled row the equality check above refuses the omission outright, so
  // the case where money is actually owed cannot be cleared by accident. If a
  // second caller is ever added, it MUST send paid_by.
  it('treats an omitted payer as "the club paid" — full replacement, deliberately', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });

    await updateExpense({ id, category: 'shuttles', description: '6 tubes', amount_cents: 8400 });

    expect(expenses()[0]!.paid_by).toBeNull();
  });

  // The date is not a field an edit should invent. addExpense stamps paid_at
  // when none is given; doing the same on an edit would silently re-date a
  // September spend to whenever the typo was noticed.
  it('keeps the stored date when the edit carries none', async () => {
    const id = await recordExpense({ paid_at: '2026-09-01T12:00:00.000Z' });

    await updateExpense({ id, category: 'shuttles', description: 'renamed', amount_cents: 8400 });

    expect(expenses()[0]!.paid_at).toBe('2026-09-01T12:00:00.000Z');
  });

  // The reference number is the one thing that must never move: every receipt
  // annotated with it would start pointing at a different row. It is assigned
  // by the database and is not in the update's column list at all. Nor is
  // season_id — moving a spend between seasons changes two net positions in one
  // write, so the schema omits it outright.
  it('never touches the reference number or the season', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC });
    // Stands in for what the IDENTITY column does on the real table.
    expenses()[0]!.ref_no = 7;

    await updateExpense({ id, category: 'food', description: 'moved', amount_cents: 100 });

    expect(expenses()[0]!.ref_no).toBe(7);
    expect(expenses()[0]!.season_id).toBe(SEASON);
  });

  it('rejects an unknown id instead of silently doing nothing', async () => {
    await expect(updateExpense({
      id: '00000000-0000-4000-8000-000000009999', category: 'shuttles', description: 'x', amount_cents: 1,
    })).rejects.toThrow(/not found/i);
  });
});

// ============================================================
// RECEIPT FILES, ITEMS AND THE CLUB'S SHARE (00313)
// ============================================================
describe('receipts and items', () => {
  const ADMIN_UID = '66666666-6666-4666-8666-666666666666';
  const EXEC_UID = '77777777-7777-4777-8777-777777777777';
  const own = (name: string, type: ExpenseReceiptType = 'image/jpeg') => ({ path: `${ADMIN_UID}/${name}`, content_type: type });
  // G is GST only, P is GST and PST, as this made-up receipt's legend says.
  const TAX_LINES = [
    { label: 'GST', rate_ppm: 50000, printed_cents: 300, codes: ['G', 'P'] },
    { label: 'PST', rate_ppm: 70000, printed_cents: 280, codes: ['P'] },
  ];
  const ITEMS = [
    { description: 'Shuttle tubes', line_total_cents: 2000, tax_code: 'G', is_club: true },
    { description: 'Running shoes', line_total_cents: 4000, tax_code: 'P', is_club: false },
  ];
  const receiptsOf = (id: string) => (store.db.club_expense_receipts ?? []).filter((r) => r.ledger_id === id);
  const itemsOf = (id: string) => (store.db.club_expense_items ?? []).filter((r) => r.ledger_id === id);

  beforeEach(() => {
    store.actor = { ...ADMIN, user_id: ADMIN_UID };
  });

  it('keeps every file in the order given', async () => {
    const id = await recordExpense({ receipts: [own('b.jpg'), own('a.heic', 'image/heic'), own('c.pdf', 'application/pdf')] });

    expect(receiptsOf(id).map((r) => [r.position, r.path])).toEqual([
      [1, `${ADMIN_UID}/b.jpg`],
      [2, `${ADMIN_UID}/a.heic`],
      [3, `${ADMIN_UID}/c.pdf`],
    ]);
    // Mirrored, so a reader still on receipt_path sees the first page.
    expect(expenses()[0]!.receipt_path).toBe(`${ADMIN_UID}/b.jpg`);
  });

  it('refuses a file outside the uploader\'s own folder, one that climbs out, or one whose type lies', async () => {
    await expect(recordExpense({ receipts: [{ path: `${EXEC_UID}/x.jpg`, content_type: 'image/jpeg' as const }] }))
      .rejects.toThrow(/could not be attached/);
    await expect(recordExpense({ receipts: [own('../x.jpg')] })).rejects.toThrow(/could not be attached/);
    await expect(recordExpense({ receipts: [own('x.jpg', 'application/pdf')] })).rejects.toThrow(/could not be attached/);
    await expect(recordExpense({ receipts: [own('x.jpg'), own('x.jpg')] })).rejects.toThrow(/could not be attached/);
    expect(expenses()).toHaveLength(0);
  });

  it('works out the club\'s share itself and ignores the amount the client sent', async () => {
    // Club: 20.00 G, GST 5% = 1.00. The shoes are personal.
    const id = await recordExpense({ amount_cents: 99999, items: ITEMS, tax_lines: TAX_LINES, receipt_total_cents: 6580 });

    const row = expenses().find((r) => r.id === id)!;
    expect(row.amount_cents).toBe(2100);
    expect(row.receipt_total_cents).toBe(6580);
  });

  it('stores an unticked item as "Personal item", keeping its amount and code', async () => {
    const id = await recordExpense({ items: ITEMS, tax_lines: TAX_LINES });

    expect(itemsOf(id).map((r) => [r.description, r.line_total_cents, r.tax_code, r.is_club])).toEqual([
      ['Shuttle tubes', 2000, 'G', true],
      ['Personal item', 4000, 'P', false],
    ]);
    expect(JSON.stringify(store.db)).not.toContain('Running shoes');
  });

  it('takes the row back out when the receipts cannot be attached', async () => {
    store.failRpc = true;

    await expect(recordExpense({ receipts: [own('a.jpg')] })).rejects.toThrow(/Nothing was recorded/);
    expect(expenses()).toHaveLength(0);
    expect(audits().some((a) => a.action_type === 'expense_added')).toBe(false);
  });

  it('lets an admin keep an exec\'s files when editing', async () => {
    store.actor = { ...EXEC, user_id: EXEC_UID };
    const id = await recordExpense({ receipts: [{ path: `${EXEC_UID}/a.jpg`, content_type: 'image/jpeg' as const }] });
    store.actor = { ...ADMIN, user_id: ADMIN_UID };

    await updateExpense({
      id, category: 'shuttles', description: '6 tubes', amount_cents: 8400,
      receipts: [{ path: `${EXEC_UID}/a.jpg`, content_type: 'image/jpeg' as const }, own('b.png', 'image/png')],
    });
    expect(receiptsOf(id).map((r) => r.path)).toEqual([`${EXEC_UID}/a.jpg`, `${ADMIN_UID}/b.png`]);
  });

  it('freezes the files, items and ticks of a settled expense, and still lets its description be fixed', async () => {
    const id = await recordExpense({ paid_by: OTHER_EXEC, receipts: [own('a.jpg')], items: ITEMS, tax_lines: TAX_LINES });
    await markExpenseReimbursed(id, { amountCents: 2100, paidBy: OTHER_EXEC });
    const base = {
      id, category: 'shuttles' as const, description: '6 tubes', amount_cents: 2100, paid_by: OTHER_EXEC,
      receipts: [own('a.jpg')], items: ITEMS, tax_lines: TAX_LINES,
    };

    await expect(updateExpense({ ...base, receipts: [own('a.jpg'), own('b.jpg')] })).rejects.toThrow(/receipts and items/);
    await expect(updateExpense({ ...base, receipts: [] })).rejects.toThrow(/receipts and items/);
    await expect(updateExpense({ ...base, items: [ITEMS[0]!, { ...ITEMS[1]!, is_club: true }] }))
      .rejects.toThrow(/already been reimbursed/);
    await expect(updateExpense({ ...base, items: [{ ...ITEMS[0]!, tax_code: 'P' }, ITEMS[1]!] }))
      .rejects.toThrow(/already been reimbursed/);
    expect(itemsOf(id).map((r) => r.is_club)).toEqual([true, false]);

    // The untouched resend compares equal, personal description and all.
    await updateExpense({ ...base, description: '6 tubes (corrected)' });
    expect(expenses()[0]!.description).toBe('6 tubes (corrected)');
    expect(expenses()[0]!.receipt_path).toBe(`${ADMIN_UID}/a.jpg`);
  });

  it('audits the files, the item count and the share, and never an item\'s description', async () => {
    const id = await recordExpense({ receipts: [own('a.jpg')], items: ITEMS, tax_lines: TAX_LINES, vendor: 'NORTHWIND WAREHOUSE' });
    await updateExpense({
      id, category: 'shuttles', description: '6 tubes', amount_cents: 1,
      receipts: [own('a.jpg')], items: ITEMS, tax_lines: TAX_LINES, vendor: 'NORTHWIND WAREHOUSE',
    });
    await removeExpense(id);

    const removed = audits().find((a) => a.action_type === 'expense_removed')!;
    expect(removed.old_value).toMatchObject({
      receipts: [`${ADMIN_UID}/a.jpg`],
      vendor: 'NORTHWIND WAREHOUSE',
      item_count: 2,
      club_share_cents: 2100,
    });
    const added = audits().find((a) => a.action_type === 'expense_added')!;
    expect(added.new_value).toMatchObject({ item_count: 2, club_share_cents: 2100 });
    const logged = JSON.stringify(audits());
    expect(logged).not.toContain('Shuttle tubes');
    expect(logged).not.toContain('Running shoes');
    expect(logged).not.toContain('Personal item');
    // And the delete cascaded to the children, as the foreign keys do.
    expect(receiptsOf(id)).toHaveLength(0);
  });

  it('keeps a receipt that is only in receipt_path when the row is edited', async () => {
    store.actor = { ...EXEC, user_id: EXEC_UID };
    const id = await recordExpense();
    // As the old console writes it: the column, and no child row.
    expenses()[0]!.receipt_path = `${EXEC_UID}/old.jpg`;
    store.actor = { ...ADMIN, user_id: ADMIN_UID };

    await updateExpense({
      id, category: 'shuttles', description: '6 tubes', amount_cents: 8400,
      receipts: [{ path: `${EXEC_UID}/old.jpg`, content_type: 'image/jpeg' as const }],
    });
    expect(receiptsOf(id).map((r) => r.path)).toEqual([`${EXEC_UID}/old.jpg`]);
    expect(expenses()[0]!.receipt_path).toBe(`${EXEC_UID}/old.jpg`);
  });

  it('reads a single receipt_path from a dialog opened before 00313 as one file', async () => {
    const id = await recordExpense({ receipt_path: `${ADMIN_UID}/old.webp` });
    expect(receiptsOf(id).map((r) => [r.path, r.content_type])).toEqual([[`${ADMIN_UID}/old.webp`, 'image/webp']]);
  });
});
