import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE NEXT MATCH GOES ON COURT BY ITSELF, and only the way a desk would put it
// there: one guarded write per court, the status and court it was read with,
// audited as automatic. The fake client is match-desk-race.test.ts's, so a lost
// race is modelled by `beforeUpdate` between the read and the write.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  /** Runs just before an UPDATE is applied: models the other desk winning. */
  beforeUpdate: null as null | ((ctx: { table: string; payload: Row }) => void),
  /** A database older than 00273: tournament_courts answers PGRST205. */
  courtsMissing: false,
  /** The next UPDATE fails with this instead of landing (a constraint refusing it). */
  updateError: null as null | { code: string; message: string },
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    // `.eq(col, null)` compiles to `col=eq.null` in PostgREST and matches NOTHING,
    // which is why the two predicate kinds are tracked separately here. A fake
    // that folded them together would let a guard written as `.eq('court', null)`
    // pass in this file and turn every court-clear into a spurious conflict in
    // production, the exact class of mistake these tests exist to catch.
    const eqFilters: Array<[string, unknown]> = [];
    const isFilters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          eqFilters.every(([c, v]) => v !== null && r[c] === v) &&
          isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)),
      );

    const run = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
      if (table === 'tournament_courts' && store.courtsMissing) {
        return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.tournament_courts' in the schema cache" } };
      }
      if (op === 'update' && store.updateError) {
        const error = store.updateError;
        store.updateError = null;
        return { data: null, error };
      }
      if (op === 'insert') {
        const row = { id: `row-${++store.seq}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        store.beforeUpdate?.({ table, payload });
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      // Detached copies: PostgREST returns JSON, not a live handle on the row.
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { eqFilters.push([c, v]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
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

vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../audit', () => ({
  logAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('tournament_audit_log').insert(entry);
  },
}));

import { groupsThenTopKnockout } from '@badminton/shared';
import { fillFreeCourts, type AutoCallEvent } from '../tournament-actions/auto-call';

const TOURNAMENT = 'tourn-1';
const EVENT = 'event-1';
const groups = groupsThenTopKnockout({ pools: 2, courts: [['1'], ['2']] });
const openKnockout = {
  ...groups,
  stages: groups.stages.map((s) => (s.kind === 'knockout' ? { ...s, courts: undefined } : s)),
};

const event = (over: Partial<AutoCallEvent> = {}): AutoCallEvent => ({
  id: EVENT, tournament_id: TOURNAMENT, format: 'staged', format_config: groups, status: 'live', event_type: 'mens_singles', ...over,
});
const client = makeClient() as never;
const fill = (over: Partial<AutoCallEvent> = {}, preferCourtId: string | null = null) =>
  fillFreeCourts(client, { event: event(over), actorId: 'admin-1', trigger: 'result', preferCourtId });

const row = (id: string) => store.db.tournament_matches!.find((r) => r.id === id)!;
const auditRows = (action?: string) =>
  (store.db.tournament_audit_log ?? []).filter((r) => !action || r.action === action);

function seedCourts(n = 2) {
  store.db.tournament_courts = Array.from({ length: n }, (_, i) => (
    { id: `court-${i + 1}`, tournament_id: TOURNAMENT, label: `Court ${i + 1}`, sort_order: i + 1, active: true, notes: null }
  ));
}

function seedMatch(id: string, over: Row = {}) {
  (store.db.tournament_matches ??= []).push({
    id,
    event_id: EVENT,
    'tournament_events.tournament_id': TOURNAMENT,
    status: 'ready',
    is_bye: false,
    phase: null,
    stage: 1,
    pool_number: 1,
    group_number: 1,
    slot: 1,
    match_label: null,
    round_number: 1,
    round_name: null,
    match_number: 1,
    bracket_position: 0,
    court: 'Court 1',
    court_id: 'court-1',
    participant_a_id: `${id}-a`,
    participant_b_id: `${id}-b`,
    pair_a_id: null,
    pair_b_id: null,
    ...over,
  });
}

beforeEach(() => {
  store.seq = 0;
  store.beforeUpdate = null;
  store.courtsMissing = false;
  store.updateError = null;
  store.db = { tournament_matches: [], tournament_audit_log: [], tournament_courts: [] };
});

describe('fillFreeCourts', () => {
  it('puts group A\'s next match on the court its result freed, and leaves court 2 alone', async () => {
    seedCourts();
    seedMatch('done', { status: 'completed' });
    seedMatch('next', { slot: 2, match_number: 3 });
    seedMatch('b-live', { status: 'live', pool_number: 2, court: 'Court 2', court_id: 'court-2' });
    seedMatch('b-next', { slot: 2, match_number: 4, pool_number: 2, court: 'Court 2', court_id: 'court-2' });

    const report = await fill({}, 'court-1');

    expect(report).toEqual({ called: [{ matchId: 'next', court: 'Court 1' }], failed: [] });
    expect(row('next').status).toBe('live');
    expect(row('b-live').status).toBe('live');
    expect(row('b-next').status).toBe('ready');
    expect(auditRows('match_court_set')).toHaveLength(0);
    expect(auditRows('match_started')).toHaveLength(1);
    expect(auditRows('match_started')[0]!.details).toEqual({ previous_status: 'ready', auto: true, trigger: 'result' });
  });

  it('gives a court-less knockout match a court and starts it in one write, with both audits', async () => {
    seedCourts(1);
    seedMatch('qf', { stage: 2, pool_number: null, group_number: null, slot: null, court: null, court_id: null });

    const report = await fill({ format_config: openKnockout });

    expect(report?.called).toEqual([{ matchId: 'qf', court: 'Court 1' }]);
    expect(row('qf')).toMatchObject({ status: 'live', court: 'Court 1', court_id: 'court-1' });
    expect(auditRows('match_court_set')[0]!.details).toMatchObject({ court_id: 'court-1', previous_court_id: null, auto: true });
    expect(auditRows('match_started')).toHaveLength(1);
  });

  it('does not use a court that another event has a match live on', async () => {
    seedCourts(1);
    seedMatch('other', { event_id: 'event-2', status: 'live', stage: null });
    seedMatch('qf', { stage: 2, pool_number: null, court: null, court_id: null });

    const report = await fill({ format_config: openKnockout });

    expect(report).toEqual({ called: [], failed: [] });
    expect(row('qf').status).toBe('ready');
  });

  it('skips a court another desk filled first, without reporting or auditing it', async () => {
    seedCourts(1);
    seedMatch('next');
    store.beforeUpdate = () => { store.beforeUpdate = null; row('next').status = 'live'; };

    const report = await fill();

    expect(report).toEqual({ called: [], failed: [] });
    expect(auditRows()).toHaveLength(0);
  });

  it('skips a court the one-live index refuses', async () => {
    seedCourts(1);
    seedMatch('next');
    store.updateError = { code: '23505', message: 'duplicate key value violates unique constraint' };

    expect(await fill()).toEqual({ called: [], failed: [] });
    expect(row('next').status).toBe('ready');
  });

  it('reports any other failure with the court, and does not throw', async () => {
    seedCourts(1);
    seedMatch('next');
    store.updateError = { code: '57014', message: 'canceling statement due to statement timeout' };

    expect(await fill()).toEqual({
      called: [],
      failed: [{ court: 'Court 1', reason: 'canceling statement due to statement timeout' }],
    });
    expect(auditRows()).toHaveLength(0);
  });

  it('says why when the tournament lists no courts, and writes nothing', async () => {
    seedMatch('next');

    const report = await fill();

    expect(report?.off).toBe('This tournament lists no courts, so the next match is not called automatically.');
    expect(row('next').status).toBe('ready');
  });

  it('does nothing on an event that is not staged or not started', async () => {
    seedCourts(1);
    seedMatch('next');

    expect(await fill({ format: 'single_elimination' })).toBeNull();
    expect(await fill({ status: 'bracket_generated' })).toBeNull();
    expect(row('next').status).toBe('ready');
    expect(auditRows()).toHaveLength(0);
  });
});
