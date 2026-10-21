import { describe, it, expect, beforeEach, vi } from 'vitest';

// MARKING A FEE PAID MUST NOT SILENTLY REWRITE A PAYMENT THAT WAS ALREADY TAKEN.
//
// waiveFee has a long comment about this and a guard to match: it names a
// fee_waived row on production whose old_value is empty, because the write
// replaced a real amount with $0 and the audit entry kept no copy of what had
// been there. The two mark-paid actions were the same defect and had neither
// half of the fix:
//
//   * they read the existing row's `id` alone, updated amount_cents / method /
//     reference / tier_id unconditionally, and audited with no old_value — so a
//     $100 dues row rewritten as $80, or a $25 door price rewritten as the $15
//     member tier, lost the original figure in the ledger AND in the log;
//   * the UPDATE carried no predicate, so two desks working the same roster both
//     read an unpaid row and the second write landed on top of the first.
//
// Both are covered here for BOTH ledgers — club dues (actions/fees.ts) and
// tournament entry fees (actions/tournament-fees.ts) — because they are the same
// three lines over the same table and only the tournament one was reported.
//
// The assertions are on the SURVIVING ROW and on the audit entry, not on "it
// threw": the point is never to lose the number, and a refusal that still
// overwrote would pass a throw-only test.
//
// THREE MORE OF THE SAME SHAPE, covered here because they were found while the
// two fee ledgers were about to grow bulk (multi-select) bars. A bulk bar is a
// LOOP over the single-record action, which makes "the caller omitted the
// optional arguments, over a selection that has gone stale" the ordinary case
// rather than the odd one:
//
//   * waiveFee permitted a re-waive, calling it idempotent. It is not: the write
//     sets a fresh paid_at and marked_by, so a second waive destroys the date the
//     waiver was granted and the officer who granted it.
//   * markFeeUnpaid reported a member with no dues row as a Sentry FAULT, and it
//     "reversed" an already-unpaid row — clearing three already-null fields,
//     reporting success, and filing a fee_marked_unpaid audit entry for a
//     reversal that reversed nothing.
//   * markTournamentFeePaid derived the amount BEFORE reading the existing row,
//     so a call naming neither a tier nor an amount re-priced that row from the
//     tournament's default tier. ensureEntryFees seeds those rows from the
//     member's REAL tier, so a $25 external snapshot came back as the $15 default
//     with nothing anywhere to show it had changed.
//
// Two of the three were unreachable from a rendered control, which is why they
// survived. The third was reachable narrowly: the Amount field is optional, so
// clearing it on a row carrying no tier_id sent neither field. Every one of them
// is reachable from a loop.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  /** Runs just before an UPDATE is applied — models another desk winning. */
  beforeUpdate: null as null | ((ctx: { table: string; payload: Row }) => void),
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    // `.is(col, null)` is a different predicate from `.eq(col, null)` and the
    // guards under test depend on it: it is what makes "only while this row is
    // still unpaid" true in the database rather than only in the read above it.
    const isFilters: Array<[string, unknown]> = [];
    // `.not(col, 'is', null)`: the column holds a value.
    const notNull: string[] = [];
    let op: Op = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)) &&
          notNull.every((c) => r[c] != null),
      );

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        const row = { id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        store.beforeUpdate?.({ table, payload });
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      // DETACHED COPIES, because PostgREST returns JSON and not a live handle on
      // the row. Returning the stored object would let the UPDATE below mutate
      // the snapshot the action is holding for old_value, and the audit
      // assertions in this file would pass against a log entry that recorded the
      // NEW values under the old key — the exact bug they exist to catch.
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
      not(c: string) { notNull.push(c); return api; },
      async single() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      async maybeSingle() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({
  requireCapability: async () => ({ id: 'admin-1', role: 'admin' }),
}));
// The REAL logAdminAudit, writing into the same fake db, so the audit row this
// suite asserts on is the row the action actually produces.
vi.mock('../audit', () => ({
  logAdminAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('audit_logs').insert(entry);
  },
}));

import { ExpectedError } from '@badminton/shared';
import { markFeePaid, waiveFee, markFeeUnpaid, markNamedFeePaid } from '../actions/fees';
import { markTournamentFeePaid } from '../actions/tournament-fees';

const TOURNAMENT = '11111111-1111-4111-8111-111111111111';
const PLAYER = '33333333-3333-4333-8333-333333333333';
const SEASON = '99999999-9999-4999-8999-999999999999';
const MEMBER_TIER = '44444444-4444-4444-8444-444444444444';
// Not the default, and priced ABOVE it — so a fallback that reaches for the
// default is visible in the amount AND in the tier, not just one of them.
const EXTERNAL_TIER = '55555555-5555-4555-8555-555555555555';

const duesRow = () => (store.db.club_fees ?? []).find((r) => r.fee_type === 'dues');
const entryRow = () => (store.db.club_fees ?? []).find((r) => r.fee_type === 'tournament');
const auditRows = (type: string) =>
  (store.db.audit_logs ?? []).filter((r) => r.action_type === type);

beforeEach(() => {
  store.seq = 0;
  store.beforeUpdate = null;
  store.db = {
    club_fees: [],
    audit_logs: [],
    players: [{ id: PLAYER, status: 'competitive' }],
    seasons: [{ id: SEASON, competitive_fee_cents: 5000, recreational_fee_cents: 3000 }],
    tournaments: [{ id: TOURNAMENT, season_id: SEASON }],
    tournament_fee_tiers: [
      { id: MEMBER_TIER, tournament_id: TOURNAMENT, name: 'Member', amount_cents: 1500, is_default: true },
      { id: EXTERNAL_TIER, tournament_id: TOURNAMENT, name: 'External', amount_cents: 2500, is_default: false },
    ],
  };
});

/** An unpaid liability, which is what ensureEntryFees files at registration. */
function unpaidEntryFee() {
  store.db.club_fees!.push({
    id: 'fee-entry-1', fee_type: 'tournament', tournament_id: TOURNAMENT,
    player_id: PLAYER, season_id: SEASON, amount_cents: 2500, paid_at: null,
    method: null, reference: null, tier_id: null,
  });
}

function paidEntryFee() {
  store.db.club_fees!.push({
    id: 'fee-entry-1', fee_type: 'tournament', tournament_id: TOURNAMENT,
    player_id: PLAYER, season_id: SEASON, amount_cents: 2500,
    paid_at: '2026-08-01T00:00:00.000Z', method: 'cash', reference: 'door', tier_id: null,
  });
}

// What ensureEntryFees actually files: the liability priced from the member's
// own tier, which for an external entrant is not the tournament's default.
function unpaidEntryFeeFromTier() {
  store.db.club_fees!.push({
    id: 'fee-entry-1', fee_type: 'tournament', tournament_id: TOURNAMENT,
    player_id: PLAYER, season_id: SEASON, amount_cents: 2500, paid_at: null,
    method: null, reference: null, tier_id: EXTERNAL_TIER,
  });
}

function unpaidDues() {
  store.db.club_fees!.push({
    id: 'fee-dues-1', fee_type: 'dues', player_id: PLAYER, season_id: SEASON,
    amount_cents: null, paid_at: null, method: null, reference: null,
  });
}

function paidDues(extra: Row = {}) {
  store.db.club_fees!.push({
    id: 'fee-dues-1', fee_type: 'dues', player_id: PLAYER, season_id: SEASON,
    amount_cents: 10000, paid_at: '2026-08-01T00:00:00.000Z', method: 'cash',
    reference: 'envelope', ...extra,
  });
}

// A granted waiver, carrying the two fields a re-waive would rewrite: the date
// it was granted and the officer who granted it.
function waivedDues() {
  store.db.club_fees!.push({
    id: 'fee-dues-1', fee_type: 'dues', player_id: PLAYER, season_id: SEASON,
    amount_cents: 0, paid_at: '2026-08-01T00:00:00.000Z', marked_by: 'admin-original',
    method: 'waived', reference: null,
  });
}

describe('markTournamentFeePaid does not overwrite a recorded payment', () => {
  // The normal path, and it must stay open: ensureEntryFees files the row unpaid
  // at registration, so almost every real call is an UPDATE of an unpaid row.
  it('still records a payment against an unpaid entry-fee row', async () => {
    unpaidEntryFee();

    await markTournamentFeePaid({
      tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 2500, method: 'cash',
    });

    expect(entryRow()!.paid_at).toBeTruthy();
    expect(entryRow()!.amount_cents).toBe(2500);
  });

  // THE REPORTED DEFECT. $25 taken at the door, then a second Mark Paid falling
  // back to the $15 member tier: the old code reported success and the $25 was
  // gone from the ledger and absent from the audit log.
  it('refuses a second payment and leaves the recorded amount untouched', async () => {
    paidEntryFee();

    await expect(
      markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER, tier_id: MEMBER_TIER }),
    ).rejects.toThrow(/already recorded as paid/i);

    expect(entryRow()!.amount_cents).toBe(2500);
    expect(entryRow()!.method).toBe('cash');
    expect(entryRow()!.paid_at).toBe('2026-08-01T00:00:00.000Z');
    // And no audit row claiming a payment that did not happen.
    expect(auditRows('tournament_fee_marked_paid')).toHaveLength(0);
  });

  // The refusal above read a row that was unpaid a moment ago. Without the
  // `.is('paid_at', null)` on the UPDATE the loser of the race overwrites the
  // winner's figure and is told it worked.
  it('loses the race without overwriting when another desk pays first', async () => {
    unpaidEntryFee();
    store.beforeUpdate = ({ table }) => {
      if (table !== 'club_fees') return;
      store.beforeUpdate = null;
      const row = entryRow()!;
      row.paid_at = '2026-08-02T00:00:00.000Z';
      row.amount_cents = 2500;
      row.method = 'e-transfer';
    };

    await expect(
      markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 1500 }),
    ).rejects.toThrow(/another desk/i);

    expect(entryRow()!.amount_cents).toBe(2500);
    expect(entryRow()!.method).toBe('e-transfer');
    expect(auditRows('tournament_fee_marked_paid')).toHaveLength(0);
  });

  // Even when nothing is destroyed, the previous state has to be recoverable —
  // that is the half of waiveFee's incident that the guard alone does not fix.
  it('audits the previous row so the figure is recoverable', async () => {
    unpaidEntryFee();

    await markTournamentFeePaid({
      tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 1500, method: 'cash',
    });

    const [entry] = auditRows('tournament_fee_marked_paid');
    expect(entry).toBeTruthy();
    expect((entry!.old_value as Row).amount_cents).toBe(2500);
    expect((entry!.old_value as Row).paid_at).toBeNull();
  });

  it('records a fee that had no row at all, with a null old_value', async () => {
    await markTournamentFeePaid({
      tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 1500,
    });

    expect(entryRow()!.amount_cents).toBe(1500);
    expect(auditRows('tournament_fee_marked_paid')[0]!.old_value).toBeNull();
  });
});

describe('markFeePaid does not overwrite a recorded payment', () => {
  it('still records a payment against an unpaid dues row', async () => {
    unpaidDues();

    await markFeePaid({ player_id: PLAYER, season_id: SEASON, amount_cents: 5000, method: 'cash' });

    expect(duesRow()!.paid_at).toBeTruthy();
    expect(duesRow()!.amount_cents).toBe(5000);
  });

  // The twin of the reported defect, in the file whose own waiveFee comment
  // describes it. $100 collected, re-marked at the season's $50 rate.
  it('refuses a second payment and leaves the recorded amount untouched', async () => {
    paidDues();

    await expect(
      markFeePaid({ player_id: PLAYER, season_id: SEASON }),
    ).rejects.toThrow(/already recorded as paid \(\$100\.00\)/i);

    expect(duesRow()!.amount_cents).toBe(10000);
    expect(duesRow()!.method).toBe('cash');
    expect(auditRows('fee_marked_paid')).toHaveLength(0);
  });

  // A waiver is a paid row with amount_cents 0 and method 'waived'. Recording a
  // PAYMENT over one replaces the club's decision not to charge, which is a fact
  // of its own — and waiveFee refuses a re-waive for a reason of its own, which
  // the waiveFee block further down covers.
  it('refuses to record a payment over a waived fee, and says it is waived', async () => {
    paidDues({ amount_cents: 0, method: 'waived', reference: null });

    await expect(
      markFeePaid({ player_id: PLAYER, season_id: SEASON, amount_cents: 5000 }),
    ).rejects.toThrow(/already recorded as waived/i);

    expect(duesRow()!.method).toBe('waived');
    expect(duesRow()!.amount_cents).toBe(0);
  });

  it('loses the race without overwriting when another desk pays first', async () => {
    unpaidDues();
    store.beforeUpdate = ({ table }) => {
      if (table !== 'club_fees') return;
      store.beforeUpdate = null;
      const row = duesRow()!;
      row.paid_at = '2026-08-02T00:00:00.000Z';
      row.amount_cents = 10000;
    };

    await expect(
      markFeePaid({ player_id: PLAYER, season_id: SEASON, amount_cents: 5000 }),
    ).rejects.toThrow(/another desk/i);

    expect(duesRow()!.amount_cents).toBe(10000);
    expect(auditRows('fee_marked_paid')).toHaveLength(0);
  });

  it('audits the previous row so the figure is recoverable', async () => {
    unpaidDues();

    await markFeePaid({ player_id: PLAYER, season_id: SEASON, amount_cents: 5000 });

    const [entry] = auditRows('fee_marked_paid');
    expect(entry).toBeTruthy();
    expect((entry!.old_value as Row).paid_at).toBeNull();
    expect((entry!.old_value as Row).id).toBe('fee-dues-1');
  });
});

// A CALLER THAT NAMES NEITHER A TIER NOR AN AMOUNT IS RECORDING PAYMENT OF WHAT
// THE ROW ALREADY SAYS, not asking for a fresh price. The amount used to be
// derived before `existing` was read, which meant the no-tier-no-amount path
// could only reach for the tournament's default tier — and the update then wrote
// it over the snapshot ensureEntryFees had taken from the member's real tier.
describe('markTournamentFeePaid does not re-price an existing snapshot', () => {
  // THE REGRESSION THAT MATTERS. $25 owed off the External tier, marked paid with
  // no arguments: the row must still say $25 External afterwards.
  it('keeps the row\'s own amount and tier when neither is supplied', async () => {
    unpaidEntryFeeFromTier();

    await markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER });

    expect(entryRow()!.paid_at).toBeTruthy();
    expect(entryRow()!.amount_cents).toBe(2500);
    expect(entryRow()!.tier_id).toBe(EXTERNAL_TIER);
    // And the audit entry agrees, so the ledger and the log cannot disagree
    // about which price was taken.
    expect((auditRows('tournament_fee_marked_paid')[0]!.new_value as Row).amount_cents).toBe(2500);
  });

  // The default tier is still the answer when there is nothing else to go on.
  it('falls back to the default tier when there is no existing row', async () => {
    await markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER });

    expect(entryRow()!.amount_cents).toBe(1500);
    expect(entryRow()!.tier_id).toBe(MEMBER_TIER);
  });

  // `existing?.amount_cents != null` and not `existing != null`: a row can exist
  // and carry no price at all, and that one genuinely has to be priced.
  it('falls back to the default tier when the existing row carries no amount', async () => {
    store.db.club_fees!.push({
      id: 'fee-entry-1', fee_type: 'tournament', tournament_id: TOURNAMENT,
      player_id: PLAYER, season_id: SEASON, amount_cents: null, paid_at: null,
      method: null, reference: null, tier_id: null,
    });

    await markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER });

    expect(entryRow()!.amount_cents).toBe(1500);
    expect(entryRow()!.tier_id).toBe(MEMBER_TIER);
  });

  // Preferring the row must not have turned into ignoring the caller: an
  // operator correcting the figure at the desk still outranks the snapshot.
  it('lets an explicit amount override the row\'s snapshot', async () => {
    unpaidEntryFeeFromTier();

    await markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER, amount_cents: 1500 });

    expect(entryRow()!.amount_cents).toBe(1500);
  });

  it('lets an explicitly named tier override the row\'s snapshot', async () => {
    unpaidEntryFeeFromTier();

    await markTournamentFeePaid({ tournament_id: TOURNAMENT, player_id: PLAYER, tier_id: MEMBER_TIER });

    expect(entryRow()!.amount_cents).toBe(1500);
    expect(entryRow()!.tier_id).toBe(MEMBER_TIER);
  });

  // The tier/tournament pair check moved BELOW the existing-row read, so it has
  // to be shown still running over a row that exists — the ordering that the
  // reorder could have broken without any other test noticing.
  it('still refuses a tier from another tournament over an existing row', async () => {
    unpaidEntryFeeFromTier();
    store.db.tournament_fee_tiers!.push({
      id: '66666666-6666-4666-8666-666666666666',
      tournament_id: '77777777-7777-4777-8777-777777777777',
      name: 'Other cup', amount_cents: 9900, is_default: true,
    });

    await expect(
      markTournamentFeePaid({
        tournament_id: TOURNAMENT, player_id: PLAYER,
        tier_id: '66666666-6666-4666-8666-666666666666',
      }),
    ).rejects.toThrow(/does not belong to this tournament/i);

    expect(entryRow()!.paid_at).toBeNull();
    expect(entryRow()!.amount_cents).toBe(2500);
    expect(auditRows('tournament_fee_marked_paid')).toHaveLength(0);
  });
});

// A RE-WAIVE IS NOT IDEMPOTENT. It was permitted on the grounds that writing
// $0/waived over $0/waived destroys nothing — but the write also sets a fresh
// paid_at and marked_by, so the second waive replaces the date the club granted
// the waiver and the officer who granted it with today and whoever clicked. That
// is a silent rewrite of who decided what, and when.
describe('waiveFee refuses a row that is already waived', () => {
  it('refuses, and leaves the original date and officer in place', async () => {
    waivedDues();

    await expect(waiveFee({ player_id: PLAYER, season_id: SEASON })).rejects.toThrow(/already waived/i);

    expect(duesRow()!.paid_at).toBe('2026-08-01T00:00:00.000Z');
    expect(duesRow()!.marked_by).toBe('admin-original');
    // No fee_waived entry either: a log that records a decision nobody made is
    // the half of this defect the row assertions above cannot see.
    expect(auditRows('fee_waived')).toHaveLength(0);
  });

  // Operator-facing, so it must not reach Sentry.
  it('refuses as an ExpectedError', async () => {
    waivedDues();

    await expect(waiveFee({ player_id: PLAYER, season_id: SEASON })).rejects.toBeInstanceOf(ExpectedError);
  });

  // Refusing on paid_at alone must not have made the ordinary case harder: this
  // is what "Skip (Waive)" does on every unpaid row on /fees.
  it('still waives a genuinely unpaid row', async () => {
    unpaidDues();

    await waiveFee({ player_id: PLAYER, season_id: SEASON });

    expect(duesRow()!.method).toBe('waived');
    expect(duesRow()!.amount_cents).toBe(0);
    expect(duesRow()!.paid_at).toBeTruthy();
    expect(auditRows('fee_waived')).toHaveLength(1);
  });

  it('still inserts a waiver where the member has no fee row at all', async () => {
    await waiveFee({ player_id: PLAYER, season_id: SEASON });

    expect(duesRow()!.method).toBe('waived');
    expect(duesRow()!.amount_cents).toBe(0);
    expect(auditRows('fee_waived')[0]!.old_value).toBeNull();
  });

  // Unchanged behaviour, kept because the guard it belongs to was rewritten: a
  // recorded payment is still refused, and still named in the message so the
  // operator knows what they were about to overwrite with $0.00.
  it('still refuses a recorded payment and names the amount', async () => {
    paidDues();

    await expect(waiveFee({ player_id: PLAYER, season_id: SEASON }))
      .rejects.toThrow(/already recorded as paid \(\$100\.00\)/i);

    expect(duesRow()!.amount_cents).toBe(10000);
    expect(duesRow()!.method).toBe('cash');
    expect(auditRows('fee_waived')).toHaveLength(0);
  });
});

// REVERSING NOTHING IS NOT A REVERSAL, and a member with no dues row is not a
// fault. Neither refusal is reachable from /fees — it renders this control only
// over a paid row ("Mark Unpaid") or a waived one ("Unwaive") — and both are
// reachable from a loop over a stale selection.
describe('markFeeUnpaid refuses when there is nothing to reverse', () => {
  it('refuses an already-unpaid row and writes no audit entry', async () => {
    unpaidDues();

    await expect(markFeeUnpaid(PLAYER, SEASON)).rejects.toThrow(/already unpaid/i);

    // The audit row is the whole point: the old code cleared three already-null
    // fields, matched its row, and filed fee_marked_unpaid for a payment that
    // never existed.
    expect(auditRows('fee_marked_unpaid')).toHaveLength(0);
  });

  it('refuses an already-unpaid row as an ExpectedError', async () => {
    unpaidDues();

    await expect(markFeeUnpaid(PLAYER, SEASON)).rejects.toBeInstanceOf(ExpectedError);
  });

  // A plain Error here, with a message absent from EXPECTED_DB_GUARDS, filed
  // every unbilled member in Sentry as a defect. Asserted by TYPE: a message
  // match passes for a plain Error too, which is exactly the defect.
  it('reports a missing dues row as an ExpectedError, not a fault', async () => {
    await expect(markFeeUnpaid(PLAYER, SEASON)).rejects.toBeInstanceOf(ExpectedError);
    await expect(markFeeUnpaid(PLAYER, SEASON)).rejects.toThrow(/no season fee recorded/i);
  });

  it('still reverses a recorded payment', async () => {
    paidDues();

    await markFeeUnpaid(PLAYER, SEASON);

    expect(duesRow()!.paid_at).toBeNull();
    expect(duesRow()!.method).toBeNull();
    expect(duesRow()!.marked_by).toBeNull();
    // The amount stays — the entry is still a fact and the member still owes it.
    expect(duesRow()!.amount_cents).toBe(10000);
    expect((auditRows('fee_marked_unpaid')[0]!.old_value as Row).amount_cents).toBe(10000);
  });

  // The compare-and-swap is one predicate now that the null arm is unreachable,
  // and losing the race is the guard working — so it is an ExpectedError too,
  // where it used to be a plain one filed in Sentry as a defect.
  it('refuses as an ExpectedError when another desk changes the payment first', async () => {
    paidDues();
    store.beforeUpdate = ({ table }) => {
      if (table !== 'club_fees') return;
      store.beforeUpdate = null;
      duesRow()!.paid_at = '2026-08-02T00:00:00.000Z';
    };

    await expect(markFeeUnpaid(PLAYER, SEASON)).rejects.toBeInstanceOf(ExpectedError);

    expect(duesRow()!.paid_at).toBe('2026-08-02T00:00:00.000Z');
    expect(auditRows('fee_marked_unpaid')).toHaveLength(0);
  });

  // "Unwaive", the only way to redo a waiver now that a re-waive is refused.
  it('still removes a waiver', async () => {
    waivedDues();

    await markFeeUnpaid(PLAYER, SEASON);

    expect(duesRow()!.paid_at).toBeNull();
    expect(duesRow()!.method).toBeNull();
    expect(duesRow()!.marked_by).toBeNull();
    expect((auditRows('fee_marked_unpaid')[0]!.old_value as Row).method).toBe('waived');
  });
});

// A NAMED ROW A GOOGLE FORM FILED UNPAID (00290) is settled here when the money
// came some other way. The same three guards as markFeePaid: no second payment,
// no payment over a waiver, and the write lands only while the row is unpaid.
describe('markNamedFeePaid settles a named dues row without overwriting', () => {
  const NAMED = '66666666-6666-4666-8666-666666666666';
  const namedRow = () => (store.db.club_fees ?? []).find((r) => r.id === NAMED);
  function unpaidNamed(extra: Row = {}) {
    store.db.club_fees!.push({
      id: NAMED, fee_type: 'dues', player_id: null, manual_name: 'Season Guest',
      manual_email: 'guest@example.invalid', season_id: SEASON, amount_cents: 2500,
      paid_at: null, method: null, reference: null, ...extra,
    });
  }

  it('records the payment at the row\'s own amount when none is given', async () => {
    unpaidNamed();

    await markNamedFeePaid({ fee_id: NAMED, method: 'cash' });

    expect(namedRow()!.paid_at).toBeTruthy();
    expect(namedRow()!.amount_cents).toBe(2500);
    expect(namedRow()!.method).toBe('cash');
    const [entry] = auditRows('fee_marked_paid');
    expect((entry!.old_value as Row).paid_at).toBeNull();
  });

  it('asks for an amount when the row has none', async () => {
    unpaidNamed({ amount_cents: null });

    await expect(markNamedFeePaid({ fee_id: NAMED })).rejects.toThrow(ExpectedError);
    expect(namedRow()!.paid_at).toBeNull();
  });

  it('refuses a row that is already paid and leaves it untouched', async () => {
    unpaidNamed({ paid_at: '2026-08-01T00:00:00.000Z', method: 'e_transfer' });

    await expect(markNamedFeePaid({ fee_id: NAMED, amount_cents: 1000 })).rejects.toThrow(/already recorded as paid/i);
    expect(namedRow()!.amount_cents).toBe(2500);
    expect(auditRows('fee_marked_paid')).toHaveLength(0);
  });

  it('will not touch a member\'s dues row through a crafted id', async () => {
    unpaidDues();

    await expect(markNamedFeePaid({ fee_id: '00000000-0000-4000-8000-0000000000aa' })).rejects.toThrow(ExpectedError);
    store.db.club_fees![0]!.id = NAMED;
    await expect(markNamedFeePaid({ fee_id: NAMED })).rejects.toThrow(/no longer on this season/i);
    expect(duesRow()!.paid_at).toBeNull();
  });

  it('loses the race to a confirmed receipt without overwriting it', async () => {
    unpaidNamed();
    store.beforeUpdate = ({ table }) => {
      if (table !== 'club_fees') return;
      store.beforeUpdate = null;
      const row = namedRow()!;
      row.paid_at = '2026-08-02T00:00:00.000Z';
      row.method = 'e_transfer';
    };

    await expect(markNamedFeePaid({ fee_id: NAMED, method: 'cash' })).rejects.toThrow(/confirming its receipt/i);
    expect(namedRow()!.method).toBe('e_transfer');
    expect(auditRows('fee_marked_paid')).toHaveLength(0);
  });
});
