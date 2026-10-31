import { describe, it, expect, beforeEach, vi } from 'vitest';

// ONE PERSON OF A DOUBLES TEAM CHECKS IN (00309).
//
// The desk marks each person as they arrive. The waiver is asked of the person
// marked and nobody else, an external team has nobody to ask, and a pair-level
// undo goes through the same write with both slots at once.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  pairs: [] as Row[],
  rpcCalls: [] as Array<{ name: string; args: Row }>,
  rpcResult: {} as Record<string, { data: unknown; error: { code?: string; message: string } | null }>,
  waiverAsked: [] as Array<{ tournamentId: string; members: Array<{ id: string; name: string }> }>,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const rows = () => (table === 'tournament_pairs' ? store.pairs : []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const api = {
      select() { return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async single() { return { data: rows()[0] ?? null, error: null }; },
      async maybeSingle() { return { data: rows()[0] ?? null, error: null }; },
    };
    return api;
  }
  return {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Row) => {
      store.rpcCalls.push({ name, args });
      return store.rpcResult[name] ?? { data: null, error: { message: `no fake for ${name}` } };
    },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('server-only', () => ({}));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../tournament-actions/_internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tournament-actions/_internal')>();
  return {
    ...actual,
    requireCapability: async () => ({ id: 'admin-1' }),
    revalidateEventPaths: () => {},
    assertTournamentNotSuspended: async () => {},
    assertEventWaiverSigned: async (_client: unknown, tournamentId: string, entry: { members: Array<{ id: string; name: string }> }) => {
      store.waiverAsked.push({ tournamentId, members: entry.members });
    },
  };
});

import { checkInPairMember, undoPairMemberCheckIn, undoCheckIn } from '../tournament-actions/participants';

const PAIR = 'pair-1';
const okResult = (extra: Row = {}) => ({
  data: { ok: true, already: false, event_id: 'event-1', tournament_id: 'tourn-1', ...extra },
  error: null,
});

function seedPair(extra: Row = {}) {
  store.pairs = [{
    id: PAIR,
    event_id: 'event-1',
    event: { tournament_id: 'tourn-1' },
    status: 'registered',
    player1_id: 'pl-ann',
    player2_id: 'pl-bea',
    external1_name: null,
    external2_name: null,
    player1: { full_name: 'Ann' },
    player2: { full_name: 'Bea' },
    ...extra,
  }];
}

beforeEach(() => {
  store.rpcCalls = [];
  store.rpcResult = {};
  store.waiverAsked = [];
  seedPair();
});

describe('checkInPairMember', () => {
  it('refuses a slot that is not 1 or 2, writing nothing', async () => {
    const res = await checkInPairMember(PAIR, 3);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/two people/);
    expect(store.rpcCalls).toHaveLength(0);
  });

  it('asks the waiver of the tapped person only, and names the officer', async () => {
    store.rpcResult.set_pair_member_check_in = okResult({ pair_checked_in: false });

    const res = await checkInPairMember(PAIR, 2);

    expect(res).toEqual({ ok: true, data: { pairCheckedIn: false } });
    expect(store.waiverAsked).toEqual([{ tournamentId: 'tourn-1', members: [{ id: 'pl-bea', name: 'Bea' }] }]);
    expect(store.rpcCalls).toEqual([{
      name: 'set_pair_member_check_in',
      args: { p_pair_id: PAIR, p_slot: 2, p_here: true, p_actor: 'admin-1' },
    }]);
  });

  it('says when the second person in completes the team', async () => {
    store.rpcResult.set_pair_member_check_in = okResult({ pair_checked_in: true });

    const res = await checkInPairMember(PAIR, 1);

    expect(res).toEqual({ ok: true, data: { pairCheckedIn: true } });
  });

  it('asks no waiver of an external team', async () => {
    seedPair({ player1_id: null, player2_id: null, player1: null, player2: null, external1_name: 'Cy', external2_name: 'Di' });
    store.rpcResult.set_pair_member_check_in = okResult();

    const res = await checkInPairMember(PAIR, 1);

    expect(res.ok).toBe(true);
    expect(store.waiverAsked).toHaveLength(0);
  });

  it('turns a fenced refusal into the desk sentence', async () => {
    store.rpcResult.set_pair_member_check_in = { data: { ok: false, reason: 'entry_status', entry_status: 'withdrawn' }, error: null };

    const res = await checkInPairMember(PAIR, 1);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/"withdrawn" and cannot be checked in/);
  });

  it('names the migration when the function is not there yet', async () => {
    store.rpcResult.set_pair_member_check_in = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };

    const res = await checkInPairMember(PAIR, 1);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('Run migration 00309 first');
  });
});

describe('undoPairMemberCheckIn', () => {
  it('takes one person back without asking a waiver', async () => {
    store.rpcResult.set_pair_member_check_in = okResult({ pair_checked_in: false });

    const res = await undoPairMemberCheckIn(PAIR, 1);

    expect(res.ok).toBe(true);
    expect(store.waiverAsked).toHaveLength(0);
    expect(store.rpcCalls[0]!.args).toEqual({ p_pair_id: PAIR, p_slot: 1, p_here: false, p_actor: 'admin-1' });
  });
});

describe('the pair-level undo', () => {
  it('takes both people back in one write, slot null', async () => {
    seedPair({ status: 'checked_in' });
    store.rpcResult.set_pair_member_check_in = okResult();

    const res = await undoCheckIn(PAIR, true);

    expect(res.ok).toBe(true);
    expect(store.rpcCalls).toEqual([{
      name: 'set_pair_member_check_in',
      args: { p_pair_id: PAIR, p_slot: null, p_here: false, p_actor: 'admin-1' },
    }]);
  });

  it('falls back to the pair-level write before 00309', async () => {
    seedPair({ status: 'checked_in' });
    store.rpcResult.set_pair_member_check_in = { data: null, error: { code: '42883', message: 'function does not exist' } };
    store.rpcResult.set_field_entry_status = okResult();

    const res = await undoCheckIn(PAIR, true);

    expect(res.ok).toBe(true);
    expect(store.rpcCalls.map((c) => c.name)).toEqual(['set_pair_member_check_in', 'set_field_entry_status']);
    expect(store.rpcCalls[1]!.args).toMatchObject({ p_entry_id: PAIR, p_is_pair: true, p_new_status: 'registered' });
  });
});
