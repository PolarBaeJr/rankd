// 00329: Decided off court and Retired from a court helper, and a retirement
// where the side that retired also leaves. The rating and the table are
// covered in tournament-write-integrity.test.ts; this is who may, and what a
// retire-and-leave writes.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  inserts: [] as Array<{ table: string; payload: Row }>,
  updates: [] as Array<{ table: string; payload: Row; filters: Array<[string, unknown]> }>,
  rpcs: [] as Array<{ name: string; args: Row }>,
}));

const makeClient = vi.hoisted(() => () => ({
  rpc: async (name: string, args: Row) => {
    db.rpcs.push({ name, args });
    return { data: { ok: true, already: false }, error: null };
  },
  from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let mode: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const settle = () => {
      if (mode === 'update') {
        const hit = rows();
        for (const r of hit) Object.assign(r, payload);
        db.updates.push({ table, payload, filters: [...filters] });
        return { data: null, error: null, count: hit.length };
      }
      return { data: mode === 'insert' ? null : rows(), error: null };
    };
    const api: Record<string, unknown> = {
      select: () => api,
      limit: () => api,
      in: () => api,
      is: () => api,
      order: () => api,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return api; },
      insert: (value: Row) => { mode = 'insert'; db.inserts.push({ table, payload: value }); return api; },
      update: (value: Row) => { mode = 'update'; payload = value; return api; },
      single: async () => {
        const row = rows()[0];
        if (!row) return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
        return { data: table === 'tournament_matches' ? { ...row, event: db.tables.tournament_events![0] } : row, error: null };
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve(settle()),
    };
    return api;
  },
}));

const consoleUser = vi.hoisted(() => ({ caps: new Set<string>() }));
const flags = vi.hoisted(() => ({ off: new Set<string>() }));
const calls = vi.hoisted(() => ({ rated: [] as string[], warnings: [] as Row[] }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('server-only', () => ({}));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../audit', () => ({ logAudit: async () => {} }));
vi.mock('../court-helper-gate', () => ({
  requireConsoleUser: async () => ({ viewer: { id: 'helper-1' }, level: 'exec', permissions: {} }),
}));
vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  permits: (_level: unknown, _permissions: unknown, capability: string) => consoleUser.caps.has(capability),
}));
vi.mock('../release-flags', async () => {
  const { ExpectedError } = await import('@badminton/shared');
  return {
    releaseFlagOn: async (id: string) => !flags.off.has(id),
    assertReleaseFlag: async (id: string) => {
      if (flags.off.has(id)) throw new ExpectedError(`${id} is switched off`);
    },
  };
});
vi.mock('../attendance-warnings', () => ({
  entryPlayerIds: async () => ['player-b'],
  issueAttendanceWarnings: async (_client: unknown, input: Row) => {
    calls.warnings.push(input);
    return [];
  },
}));
vi.mock('../tournament-actions/auto-call', () => ({ fillFreeCourts: async () => ({ called: [], failed: [] }) }));
vi.mock('../tournament-actions/_internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tournament-actions/_internal')>()),
  assertTournamentNotSuspended: async () => {},
  revalidateEventPaths: () => {},
  notifyPlayers: async () => {},
  advanceWinner: async () => {},
  advanceLoser: async () => {},
  applyTournamentMatchElo: async (matchId: string) => { calls.rated.push(matchId); },
  requireCapability: async () => ({ id: 'desk-1' }),
}));

const { enterCourtHelperOffCourt, enterCourtHelperRetirement, recordRetirement } = await import('../tournament-actions/results');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

function seed() {
  db.tables = {
    tournament_events: [{ id: 'e1', tournament_id: 't1', event_type: 'mens_singles', status: 'pool_live', format: 'staged' }],
    tournament_participants: [
      { id: A, event_id: 'e1', player_id: 'player-a' },
      { id: B, event_id: 'e1', player_id: 'player-b' },
    ],
    tournament_matches: [
      { id: 'm1', event_id: 'e1', status: 'live', stage: 1, court_id: 'court-1', participant_a_id: A, participant_b_id: B },
      { id: 'm2', event_id: 'e1', status: 'ready', stage: 1, court_id: null, participant_a_id: B, participant_b_id: 'other' },
    ],
    tournament_court_helpers: [{ id: 'h1', court_id: 'court-1', player_id: 'helper-1' }],
    event_departures: [],
  };
}

beforeEach(() => {
  seed();
  db.inserts = [];
  db.updates = [];
  db.rpcs = [];
  calls.rated = [];
  calls.warnings = [];
  consoleUser.caps = new Set();
  // The leave's own voids are the desk's voidMatchImpl, covered elsewhere.
  flags.off = new Set(['desk_helper_void']);
});

const matchWrites = () => db.updates.filter((u) => u.table === 'tournament_matches');
const departures = () => db.inserts.filter((i) => i.table === 'event_departures').map((i) => i.payload);

describe('a court helper', () => {
  it('records off court on their own court, pinned to it, and nobody is rated', async () => {
    const res = await enterCourtHelperOffCourt('m1', 'a');
    expect(res.ok).toBe(true);
    expect(matchWrites()[0]!.payload).toMatchObject({ result_kind: 'off_court', scores: [], status: 'completed', winner_participant_id: A });
    expect(matchWrites()[0]!.filters).toContainEqual(['court_id', 'court-1']);
    expect(calls.rated).toEqual([]);
  });

  it('is refused on another court, before anything is written', async () => {
    db.tables.tournament_court_helpers = [{ id: 'h1', court_id: 'court-2', player_id: 'helper-1' }];
    const res = await enterCourtHelperRetirement('m1', { retiredSide: 'b', scores: [], leaves: false });
    expect(res.ok === false && res.error).toBe('You are not helping on this match\'s court.');
    expect(matchWrites()).toEqual([]);
  });
});

describe('retire and leave', () => {
  it('records the retirement, rates it, then the injury departure with no warning, and leaves the match alone', async () => {
    const res = await enterCourtHelperRetirement('m1', { retiredSide: 'b', scores: [{ a: 11, b: 8 }], leaves: true });
    expect(res.ok).toBe(true);
    expect(calls.rated).toEqual(['m1']);
    expect(db.tables.tournament_matches![0]).toMatchObject({ status: 'completed', result_kind: 'retired', retired_side: 'b' });
    expect(db.rpcs).toContainEqual({ name: 'set_field_entry_status', args: expect.objectContaining({ p_entry_id: B, p_new_status: 'no_show' }) });
    expect(departures()).toEqual([expect.objectContaining({ player_id: 'player-b', participant_id: B, reason: 'injury', marked_as: 'court_helper', warning_id: null })]);
    expect(calls.warnings).toEqual([]);
    // Their next match is for the desk; the retired one is never voided again.
    expect(res.ok && res.data.left).toMatchObject({ voided: 0, warned: 0, leftForDesk: 1 });
    expect(matchWrites().filter((u) => u.payload.status === 'voided')).toEqual([]);
  });

  it('refuses up front when Left is switched off, so no retirement is stranded', async () => {
    flags.off.add('attendance_warnings');
    const res = await recordRetirement('m1', { retiredSide: 'b', scores: [], leaves: true });
    expect(res.ok).toBe(false);
    expect(matchWrites()).toEqual([]);
  });

  it('stays in the event without leaving', async () => {
    const res = await recordRetirement('m1', { retiredSide: 'a', scores: [{ a: 15, b: 3 }], leaves: false });
    expect(res.ok).toBe(true);
    expect(matchWrites()[0]!.payload).toMatchObject({ winner_participant_id: B, retired_side: 'a' });
    expect(departures()).toEqual([]);
  });
});
