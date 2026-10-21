import { describe, it, expect, beforeEach, vi } from 'vitest';

// The two server actions behind "Paste a list" on /fees: previewFeePaste, which
// reads and must never write, and bulkAddManualFees, which keeps not-found
// people as named payments through addManualFee one row at a time.
//
// The store mock is bulk-actions.test.ts's, with the four query methods the
// preview uses added, an error switch per table, and a log of every write so
// "writes nothing" is asserted rather than inferred.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  gateError: null as string | null,
  gateCalls: [] as string[],
  /** A table whose reads come back as a PostgREST error. */
  readError: {} as Record<string, string>,
  writes: [] as string[],
  sentry: [] as string[],
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    let inserted: Row | null = null;
    let order: string | null = null;
    let window: [number, number] | null = null;

    const matching = () => (store.db[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const run = () => {
      if (op === 'insert') return { data: inserted ? [{ ...inserted }] : [], error: null };
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (op === 'delete') {
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (store.readError[table]) return { data: null, error: { message: store.readError[table], code: 'XX000' } };
      let rows = matching().map((r) => ({ ...r }));
      if (order) rows = rows.sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
      // PostgREST's row cap: a read with no range stops at 1000 without saying so.
      rows = window ? rows.slice(window[0], window[1] + 1) : rows.slice(0, 1000);
      return { data: rows, error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) {
        const row: Row = { id: `${table}-${(store.db[table] ?? []).length + 1}`, ...p };
        (store.db[table] ??= []).push(row);
        store.writes.push(`insert:${table}`);
        op = 'insert';
        inserted = row;
        return api;
      },
      update(p: Row) { store.writes.push(`update:${table}`); op = 'update'; payload = p; return api; },
      delete() { store.writes.push(`delete:${table}`); op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api; },
      is(c: string, v: unknown) {
        filters.push((r) => (v === null ? r[c] == null : r[c] === v));
        return api;
      },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return api; },
      not(c: string, operator: string, v: string) {
        if (operator !== 'like') throw new Error(`mock: not.${operator} unsupported`);
        const re = new RegExp(`^${v.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        filters.push((r) => !re.test(String(r[c] ?? '')));
        return api;
      },
      order(c: string) { order = c; return api; },
      range(from: number, to: number) { window = [from, to]; return api; },
      async single() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      async maybeSingle() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return {
    from: (table: string) => query(table),
    rpc: async () => ({ data: null, error: null }),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({
  captureException: (err: unknown) => {
    store.sentry.push(err instanceof Error ? err.message : String(err));
  },
}));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../notify', () => ({ notifyPlayers: async () => {} }));
vi.mock('../session-reminders', () => ({ remindSessionGoers: async () => ({ notified: 0 }) }));
vi.mock('../actions/_shared', () => ({
  requireCapability: async (capability: string) => {
    store.gateCalls.push(capability);
    if (store.gateError) throw new Error(store.gateError);
    return { id: 'exec-1', role: 'player', is_exec: true };
  },
}));
vi.mock('../audit', () => ({
  logAdminAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('audit_logs').insert(entry);
  },
}));
vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  sendPlayerApprovedEmail: async () => {},
}));

import { previewFeePaste } from '../actions/fee-paste';
import { bulkAddManualFees } from '../actions/bulk';
import { attachNamedPayment } from '../actions/fees';
import { MAX_BULK_TARGETS } from '../bulk';

const SEASON = '11111111-1111-4111-8111-111111111111';
const OTHER_SEASON = '22222222-2222-4222-8222-222222222222';

const person = (id: string, fullName: string, over: Row = {}): Row => ({
  id,
  full_name: fullName,
  first_name: fullName.split(' ')[0],
  last_name: fullName.split(' ').slice(1).join(' ') || null,
  display_name: null,
  email: `${id}@example.org`,
  status: 'competitive',
  is_exec: false,
  fee_exempt: false,
  deletion_requested_at: null,
  ...over,
});

const auditsOf = (type: string) => (store.db.audit_logs ?? []).filter((r) => r.action_type === type);

beforeEach(() => {
  store.gateError = null;
  store.gateCalls = [];
  store.readError = {};
  store.writes = [];
  store.sentry = [];
  store.db = {
    seasons: [
      { id: SEASON, name: 'Fall 2026', competitive_fee_cents: 3000, recreational_fee_cents: 2000 },
    ],
    players: [
      person('jane', 'Jane Doe'),
      person('sam', 'Sam Lee'),
      person('exec', 'Ari Exec', { is_exec: true }),
      person('gone', 'Pat Gone', { email: 'x1@deleted.invalid' }),
    ],
    club_fees: [
      { id: 'f-1', player_id: 'sam', season_id: SEASON, fee_type: 'dues', paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 3000 },
      // A reinstatement row for Jane in the same season: not her dues, and the
      // preview must not read her as paid because of it.
      { id: 'f-2', player_id: 'jane', season_id: SEASON, fee_type: 'reinstatement', paid_at: '2026-09-03T00:00:00Z', method: 'cash', amount_cents: 1500 },
    ],
    audit_logs: [],
  };
});

describe('previewFeePaste', () => {
  it('sorts a pasted list against the season, and writes nothing', async () => {
    const res = await previewFeePaste({
      season_id: SEASON,
      text: 'jane@example.org\nSam Lee\nx1@deleted.invalid\nari exec\nRobin Park, $25\nnot an email@',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.season).toEqual({ id: SEASON, name: 'Fall 2026', competitiveFeeCents: 3000, recreationalFeeCents: 2000 });
    expect(res.data.willMark).toEqual([{ raw: 'jane@example.org', playerId: 'jane', fullName: 'Jane Doe', email: 'jane@example.org' }]);
    expect(res.data.alreadyPaid.map((r) => r.name)).toEqual(['Sam Lee']);
    expect(res.data.notBillable.map((r) => r.name)).toEqual(['Ari Exec']);
    expect(res.data.notFound.map((n) => n.raw)).toEqual(['x1@deleted.invalid', 'Robin Park, $25']);
    expect(res.data.notFound[1]).toMatchObject({ name: 'Robin Park', amountCents: 2500 });
    expect(res.data.invalid).toHaveLength(1);
    expect(store.gateCalls).toEqual(['fees.clubfees.read']);
    expect(store.writes).toEqual([]);
  });

  it('refuses an officer without the club-fee read, and writes nothing', async () => {
    store.gateError = 'You do not have access to that';

    const res = await previewFeePaste({ season_id: SEASON, text: 'jane@example.org' });

    expect(res.ok).toBe(false);
    expect(store.gateCalls).toEqual(['fees.clubfees.read']);
    expect(store.writes).toEqual([]);
  });

  it('refuses input that is not the schema, before the gate', async () => {
    for (const input of [{ season_id: 'nope', text: 'x' }, { season_id: SEASON, text: '' }, 'jane@example.org', null]) {
      const res = await previewFeePaste(input);
      expect(res.ok).toBe(false);
    }
    expect(store.gateCalls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it('fails loudly when the players read errors, rather than reporting everyone as not found', async () => {
    store.readError.players = 'permission denied for table players';

    const res = await previewFeePaste({ season_id: SEASON, text: 'jane@example.org' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FEE-105');
    expect(store.writes).toEqual([]);
  });

  it('fails loudly when the dues read errors', async () => {
    store.readError.club_fees = 'boom';
    const res = await previewFeePaste({ season_id: SEASON, text: 'sam@example.org' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FEE-105');
  });

  it('reads every dues row of a large season, not just the first page', async () => {
    // 1000 named payments that sort before Jane's paid row. Unpaged, the read
    // would stop at the row cap and Jane would come back as someone to mark.
    for (let i = 0; i < 1000; i++) {
      store.db.club_fees!.push({
        id: `a-${String(i).padStart(4, '0')}`, player_id: null, manual_name: `Filler ${i}`, manual_email: null,
        season_id: SEASON, fee_type: 'dues', paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 2500,
      });
    }
    store.db.club_fees!.push({
      id: 'z-jane', player_id: 'jane', season_id: SEASON, fee_type: 'dues',
      paid_at: '2026-09-04T00:00:00Z', method: 'cash', amount_cents: 3000,
    });

    const res = await previewFeePaste({ season_id: SEASON, text: 'jane@example.org' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.willMark).toEqual([]);
    expect(res.data.alreadyPaid.map((r) => r.name)).toEqual(['Jane Doe']);
  });

  it('lists named payments that look like a member, pasted or not', async () => {
    store.db.club_fees!.push({
      id: 'f-9', player_id: null, manual_name: 'J Doe', manual_email: 'jane@example.org',
      season_id: SEASON, fee_type: 'dues', paid_at: '2026-09-02T00:00:00Z', method: 'cash', amount_cents: 2500,
    });

    const res = await previewFeePaste({ season_id: SEASON, text: 'Robin Park' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.namedMatches).toEqual([
      {
        feeId: 'f-9', manualName: 'J Doe', amountCents: 2500, paidAt: '2026-09-02T00:00:00Z',
        candidates: [{ playerId: 'jane', name: 'Jane Doe', maskedEmail: 'j***@example.org', match: 'email', memberDues: 'none' }],
      },
    ]);
    expect(store.writes).toEqual([]);
  });

  it('refuses a season that does not exist', async () => {
    const res = await previewFeePaste({ season_id: OTHER_SEASON, text: 'jane@example.org' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/season/i);
    expect(store.writes).toEqual([]);
  });
});

describe('bulkAddManualFees', () => {
  const entry = (name: string, over: Row = {}): Row => ({ manual_name: name, amount_cents: 2500, ...over });
  const manualRows = () => (store.db.club_fees ?? []).filter((r) => r.manual_name != null);

  it('records each entry as its own named payment, with its own audit row', async () => {
    const res = await bulkAddManualFees(SEASON, [
      entry('Robin Park', { email: 'Robin@Example.net' }),
      entry('Chris Wu', { method: 'e-transfer', reference: 'ABC123' }),
    ]);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ attempted: 2, succeeded: 2, failures: [] });
    expect(manualRows().map((r) => [r.manual_name, r.manual_email])).toEqual([
      ['Robin Park', 'robin@example.net'],
      ['Chris Wu', null],
    ]);
    expect(auditsOf('manual_fee_added')).toHaveLength(2);
    expect(new Set(store.gateCalls)).toEqual(new Set(['fees.clubfees.addmanual.write']));
  });

  it('files every entry against the season it was called with, whatever the entry says', async () => {
    await bulkAddManualFees(SEASON, [entry('Robin Park', { season_id: OTHER_SEASON })]);
    expect(manualRows()[0]!.season_id).toBe(SEASON);
  });

  it('refuses an officer without the capability before any write', async () => {
    store.gateError = 'You do not have access to that';

    const res = await bulkAddManualFees(SEASON, [entry('Robin Park')]);

    expect(res.ok).toBe(false);
    expect(store.gateCalls).toEqual(['fees.clubfees.addmanual.write']);
    expect(store.writes).toEqual([]);
    expect(manualRows()).toHaveLength(0);
  });

  it(`refuses more than ${MAX_BULK_TARGETS} entries, and a list that is not a list, before the gate`, async () => {
    const tooMany = Array.from({ length: MAX_BULK_TARGETS + 1 }, (_, i) => entry(`Person ${i}`));
    for (const input of [tooMany, 'Robin Park', { 0: entry('Robin Park') }, [], null, [null], ['Robin Park']]) {
      const res = await bulkAddManualFees(SEASON, input);
      expect(res.ok).toBe(false);
    }
    expect(store.gateCalls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it('fails an entry whose email belongs to an account on its own, and records the rest', async () => {
    const res = await bulkAddManualFees(SEASON, [
      entry('Robin Park'),
      entry('Jane D', { email: 'jane@example.org' }),
      entry('Chris Wu'),
    ]);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(2);
      expect(res.data.failures).toHaveLength(1);
      expect(res.data.failures[0]!.id).toBe('1');
      expect(res.data.failures[0]!.error).toMatch(/already belongs to Jane Doe/);
    }
    expect(manualRows().map((r) => r.manual_name)).toEqual(['Robin Park', 'Chris Wu']);
    expect(auditsOf('manual_fee_added')).toHaveLength(2);
    // A refusal, not a fault.
    expect(store.sentry).toEqual([]);
  });

  it('fails an entry with no amount on its own', async () => {
    const res = await bulkAddManualFees(SEASON, [entry('Robin Park', { amount_cents: undefined }), entry('Chris Wu')]);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(1);
      expect(res.data.failures).toEqual([{ id: '0', error: 'Enter the amount they paid.' }]);
    }
    expect(manualRows().map((r) => r.manual_name)).toEqual(['Chris Wu']);
  });

  it('fails a malformed entry on its own', async () => {
    const res = await bulkAddManualFees(SEASON, [entry(''), entry('Chris Wu', { email: 'not-an-email' }), entry('Kim Ho')]);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(1);
      expect(res.data.failures.map((f) => f.id)).toEqual(['0', '1']);
    }
    expect(manualRows().map((r) => r.manual_name)).toEqual(['Kim Ho']);
  });
});

describe('attachNamedPayment', () => {
  const MEMBER = '33333333-3333-4333-8333-333333333333';
  const NAMED = '44444444-4444-4444-8444-444444444444';
  const OWN = '55555555-5555-4555-8555-555555555555';
  const GONE = '66666666-6666-4666-8666-666666666666';

  const namedRow = (over: Row = {}): Row => ({
    id: NAMED, player_id: null, manual_name: 'J Doe', manual_email: null, season_id: SEASON, fee_type: 'dues',
    paid_at: '2026-09-02T00:00:00Z', marked_by: 'exec-0', amount_cents: 2500, method: 'e-transfer', reference: 'REF123',
    ...over,
  });
  const ownRow = (over: Row = {}): Row => ({
    id: OWN, player_id: MEMBER, manual_name: null, manual_email: null, season_id: SEASON, fee_type: 'dues',
    paid_at: null, marked_by: null, amount_cents: 3000, method: null, reference: null,
    ...over,
  });
  const fee = (id: string) => (store.db.club_fees ?? []).find((r) => r.id === id);

  beforeEach(() => {
    store.db.players!.push(
      person(MEMBER, 'Jane Doe', { email: 'jdoe@example.org' }),
      person(GONE, 'Pat Gone', { email: 'x2@deleted.invalid' }),
    );
    store.db.club_fees = [namedRow()];
  });

  it('refuses an officer without the capability before any write', async () => {
    store.gateError = 'You do not have access to that';

    const res = await attachNamedPayment(NAMED, MEMBER);

    expect(res.ok).toBe(false);
    expect(store.gateCalls).toEqual(['fees.clubfees.addmanual.write']);
    expect(store.writes).toEqual([]);
  });

  it('asks for both the add-a-name and the mark-paid capabilities', async () => {
    await attachNamedPayment(NAMED, MEMBER);
    expect(store.gateCalls).toEqual(['fees.clubfees.addmanual.write', 'fees.clubfees.markpaid.write']);
  });

  it('refuses ids that are not uuids, before the gate', async () => {
    for (const [a, b] of [['nope', MEMBER], [NAMED, 'jane'], [null, MEMBER], [NAMED, { id: MEMBER }]] as const) {
      const res = await attachNamedPayment(a, b);
      expect(res.ok).toBe(false);
    }
    expect(store.gateCalls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it('refuses a payment that has already moved onto a member, or is not dues', async () => {
    for (const over of [
      { player_id: 'sam', manual_name: null },
      { fee_type: 'reinstatement' },
    ]) {
      store.db.club_fees = [namedRow(over)];
      const res = await attachNamedPayment(NAMED, MEMBER);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/no longer there|already moved/);
    }
    expect(store.writes).toEqual([]);
  });

  it('refuses a member who does not exist or has been deleted', async () => {
    for (const who of [GONE, '77777777-7777-4777-8777-777777777777']) {
      const res = await attachNamedPayment(NAMED, who);
      expect(res.ok).toBe(false);
    }
    expect(store.writes).toEqual([]);
  });

  it('makes the named row the member\'s own when they have no dues row this season', async () => {
    const res = await attachNamedPayment(NAMED, MEMBER);

    expect(res).toEqual({ ok: true, data: { playerName: 'Jane Doe', moved: 'attached' } });
    expect(fee(NAMED)).toMatchObject({ player_id: MEMBER, manual_name: null, manual_email: null, amount_cents: 2500, reference: 'REF123' });
    expect(store.db.club_fees).toHaveLength(1);
    expect(auditsOf('manual_fee_attached')).toHaveLength(1);
    expect(auditsOf('manual_fee_attached')[0]).toMatchObject({ target_id: NAMED, actor_id: 'exec-1' });
  });

  it('moves the payment onto an unpaid dues row, then deletes the named row', async () => {
    store.db.club_fees!.push(ownRow());

    const res = await attachNamedPayment(NAMED, MEMBER);

    expect(res).toEqual({ ok: true, data: { playerName: 'Jane Doe', moved: 'merged' } });
    expect(fee(NAMED)).toBeUndefined();
    expect(fee(OWN)).toMatchObject({
      player_id: MEMBER, paid_at: '2026-09-02T00:00:00Z', marked_by: 'exec-0',
      amount_cents: 2500, method: 'e-transfer', reference: 'REF123',
    });
    expect(store.writes).toEqual(['update:club_fees', 'delete:club_fees', 'insert:audit_logs']);
    expect(auditsOf('manual_fee_attached')).toHaveLength(1);
    expect(auditsOf('manual_fee_attached')[0]).toMatchObject({ target_id: OWN });
  });

  it.each([
    ['paid', { paid_at: '2026-09-01T00:00:00Z', method: 'cash', amount_cents: 3000 }, /already recorded as paid/],
    ['waived', { paid_at: '2026-09-01T00:00:00Z', method: 'waived', amount_cents: 0 }, /already recorded as waived/],
  ] as const)('refuses when the member\'s dues are already %s, and writes nothing', async (_label, over, message) => {
    store.db.club_fees!.push(ownRow(over));

    const res = await attachNamedPayment(NAMED, MEMBER);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(message);
      expect(res.error).toMatch(/count it twice/);
    }
    expect(store.writes).toEqual([]);
    expect(fee(NAMED)).toBeDefined();
    expect(store.sentry).toEqual([]);
  });
  it('refuses to merge an unpaid named row a Google Form filed (00290), and writes nothing', async () => {
    store.db.club_fees = [namedRow({ paid_at: null, marked_by: null, method: null, reference: null })];
    store.db.club_fees.push(ownRow());

    const res = await attachNamedPayment(NAMED, MEMBER);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not paid yet/);
    expect(store.writes).toEqual([]);
    expect(fee(NAMED)).toBeDefined();
  });

  it('still attaches an unpaid named row when the member has no dues row, so its receipt follows', async () => {
    store.db.club_fees = [namedRow({ paid_at: null, marked_by: null, method: null, reference: null })];

    const res = await attachNamedPayment(NAMED, MEMBER);

    expect(res).toEqual({ ok: true, data: { playerName: 'Jane Doe', moved: 'attached' } });
    expect(fee(NAMED)).toMatchObject({ player_id: MEMBER, paid_at: null });
  });
});
