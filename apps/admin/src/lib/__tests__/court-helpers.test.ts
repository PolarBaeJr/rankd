import { describe, it, expect, beforeEach, vi } from 'vitest';

// COURT HELPERS (00310). A console member named to a court saves the score of
// the match live on that court, through the one result path, and only while
// the match is still there: the court read is pinned into the result's UPDATE.
// The desk's capability still wins outright.

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  updates: [] as Array<{ table: string; filters: Array<[string, unknown]>; payload: Row }>,
  inserts: [] as Array<{ table: string; payload: Row }>,
  deletes: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  /** Answers every UPDATE with this count and writes nothing, as a lost CAS does. */
  forcedUpdateCount: null as number | null,
  insertError: null as null | { code: string; message: string },
}));

const makeClient = vi.hoisted(() => () => ({
  from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let payload: Row = {};
    let cols = '*';
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const embed = (r: Row): Row =>
      cols.includes('tournament_events(')
        ? { ...r, event: (db.tables.tournament_events ?? []).find((e) => e.id === r.event_id) ?? null }
        : { ...r };
    const run = () => {
      if (op === 'update') {
        db.updates.push({ table, filters: [...filters], payload });
        const hit = rows();
        if (db.forcedUpdateCount !== null) return { data: null, error: null, count: db.forcedUpdateCount };
        for (const r of hit) Object.assign(r, payload);
        return { data: null, error: null, count: hit.length };
      }
      if (op === 'insert') {
        db.inserts.push({ table, payload });
        if (db.insertError) return { data: null, error: db.insertError };
        (db.tables[table] ??= []).push({ ...payload });
        return { data: null, error: null };
      }
      if (op === 'delete') {
        const hit = rows();
        db.deletes.push({ table, filters: [...filters] });
        db.tables[table] = (db.tables[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      return { data: rows().map(embed), error: null };
    };
    const api = {
      select(c?: string) { if (op === 'select') cols = c ?? '*'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      in() { return api; },
      order() { return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      async single() { const r = rows()[0]; return { data: r ? embed(r) : null, error: null }; },
      async maybeSingle() { const r = rows()[0]; return { data: r ? embed(r) : null, error: null }; },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return api;
  },
}));

const gate = vi.hoisted(() => ({ asked: [] as string[], refuse: null as string | null }));
const consoleUser = vi.hoisted(() => ({
  current: { viewer: { id: 'helper-1' } as Row, level: 'exec' as string | null, permissions: { kind: 'unrestricted' } as unknown },
}));
const autoCall = vi.hoisted(() => ({ fillFreeCourts: vi.fn() }));
const audit = vi.hoisted(() => ({ logAudit: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('server-only', () => ({}));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../audit', () => ({ logAudit: (...args: unknown[]) => audit.logAudit(...args) }));
vi.mock('../court-helper-gate', () => ({ requireConsoleUser: async () => consoleUser.current }));
vi.mock('../tournament-actions/auto-call', () => ({
  fillFreeCourts: (...args: unknown[]) => autoCall.fillFreeCourts(...args),
}));
vi.mock('../tournament-actions/_internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tournament-actions/_internal')>()),
  requireCapability: async (capability: string) => {
    gate.asked.push(capability);
    if (gate.refuse) throw new Error(gate.refuse);
    return { id: 'admin-1' };
  },
  assertTournamentNotSuspended: async () => {},
  applyTournamentMatchElo: async () => {},
  advanceWinner: async () => {},
  advanceLoser: async () => {},
  notifyPlayers: async () => {},
  revalidateEventPaths: () => {},
}));

import { poolsThenPlacement } from '@badminton/shared';
import { courtHelperDecision } from '../court-helpers';
import { enterCourtHelperResult } from '../tournament-actions/results';
import { addCourtHelper, removeCourtHelper } from '../tournament-actions/court-helpers';

function seed(match: Row = {}) {
  db.tables = {
    tournament_events: [{
      id: 'e1', tournament_id: 't1', status: 'live', format: 'staged', event_type: 'mens_singles',
      format_config: poolsThenPlacement(),
    }],
    tournament_matches: [{
      id: 'm1', event_id: 'e1', stage: 1, status: 'live', court_id: 'c1', is_bye: false,
      participant_a_id: 'pa', participant_b_id: 'pb', pair_a_id: null, pair_b_id: null,
      handicap_a: 0, handicap_b: 0, scores: null, ...match,
    }],
    tournament_courts: [
      { id: 'c1', tournament_id: 't1', label: '1' },
      { id: 'c2', tournament_id: 't1', label: '2' },
    ],
    tournament_court_helpers: [{ id: 'h1', tournament_id: 't1', court_id: 'c1', player_id: 'helper-1' }],
    players: [
      { id: 'helper-1', role: 'player', is_exec: true, is_trainer: false, is_banned: false, status: 'active', active_flag: true },
      { id: 'member-1', role: 'player', is_exec: false, is_trainer: false, is_banned: false, status: 'active', active_flag: true },
      { id: 'banned-exec', role: 'player', is_exec: true, is_trainer: false, is_banned: true, status: 'active', active_flag: true },
    ],
  };
}

const resultWrite = () => db.updates.find((u) => u.table === 'tournament_matches' && u.payload.status === 'completed');
const GAME = [{ a: 15, b: 9 }];

beforeEach(() => {
  db.updates = [];
  db.inserts = [];
  db.deletes = [];
  db.forcedUpdateCount = null;
  db.insertError = null;
  gate.asked = [];
  gate.refuse = null;
  consoleUser.current = { viewer: { id: 'helper-1' }, level: 'exec', permissions: { kind: 'unrestricted' } };
  autoCall.fillFreeCourts.mockReset();
  autoCall.fillFreeCourts.mockResolvedValue({ called: [], failed: [] });
  audit.logAudit.mockReset();
  seed();
});

describe('courtHelperDecision', () => {
  const live = { status: 'live', stage: 1, court_id: 'c1' };

  it('lets the desk through even with no court', () => {
    expect(courtHelperDecision({ canDesk: true, match: { ...live, court_id: null }, eventFormat: 'staged', hasHelperRow: false }))
      .toEqual({ kind: 'desk' });
  });

  it('lets a helper on the match\'s court through, pinned to that court', () => {
    expect(courtHelperDecision({ canDesk: false, match: live, eventFormat: 'staged', hasHelperRow: true }))
      .toEqual({ kind: 'helper', courtId: 'c1' });
  });

  it('refuses a helper with no row on the match\'s court', () => {
    expect(courtHelperDecision({ canDesk: false, match: live, eventFormat: 'staged', hasHelperRow: false }))
      .toEqual({ kind: 'refuse', reason: 'You are not helping on this match\'s court.' });
  });

  it('refuses a match on no court', () => {
    expect(courtHelperDecision({ canDesk: false, match: { ...live, court_id: null }, eventFormat: 'staged', hasHelperRow: true }))
      .toEqual({ kind: 'refuse', reason: 'This match is not on a court.' });
  });

  it('refuses a match that is not live', () => {
    for (const status of ['ready', 'completed', 'pending']) {
      expect(courtHelperDecision({ canDesk: false, match: { ...live, status }, eventFormat: 'staged', hasHelperRow: true }).kind)
        .toBe('refuse');
    }
  });

  it('refuses outside a staged event', () => {
    expect(courtHelperDecision({ canDesk: false, match: live, eventFormat: 'single_elimination', hasHelperRow: true }))
      .toEqual({ kind: 'refuse', reason: 'Courtside scoring is for staged events.' });
    expect(courtHelperDecision({ canDesk: false, match: { ...live, stage: null }, eventFormat: 'staged', hasHelperRow: true }))
      .toEqual({ kind: 'refuse', reason: 'Courtside scoring is for staged events.' });
  });

  it('refuses a match that was not found', () => {
    expect(courtHelperDecision({ canDesk: false, match: null, eventFormat: 'staged', hasHelperRow: true }).kind).toBe('refuse');
  });
});

describe('enterCourtHelperResult', () => {
  it('takes the match and the games, nothing else', () => {
    expect(enterCourtHelperResult.length).toBe(2);
  });

  it('saves a helper\'s score with the court pinned into the result\'s UPDATE', async () => {
    const res = await enterCourtHelperResult('m1', GAME);
    expect(res).toEqual({ ok: true, data: { autoCall: { called: [], failed: [] } } });
    const write = resultWrite();
    expect(write?.filters).toContainEqual(['court_id', 'c1']);
    expect(write?.payload.result_entered_by).toBe('helper-1');
    expect(write?.payload.winner_participant_id).toBe('pa');
    expect(write?.payload.time_exceeded).toBe(false);
    // The helper never asked the desk's gate.
    expect(gate.asked).toEqual([]);
    const auditCall = audit.logAudit.mock.calls.find((c) => (c[1] as Row).action === 'result_entered');
    expect(auditCall?.[1]).toMatchObject({ performed_by: 'helper-1', details: { via: 'court_helper', court_id: 'c1' } });
  });

  it('puts the next match on with the helper as the actor', async () => {
    await enterCourtHelperResult('m1', GAME);
    expect(autoCall.fillFreeCourts).toHaveBeenCalledTimes(1);
    expect(autoCall.fillFreeCourts.mock.calls[0]![1]).toMatchObject({ actorId: 'helper-1', preferCourtId: 'c1' });
  });

  it('refuses when the match left the court before the write', async () => {
    db.forcedUpdateCount = 0;
    const res = await enterCourtHelperResult('m1', GAME);
    expect(res).toMatchObject({ ok: false, error: 'This match has left your court. Reload to see your courts.' });
  });

  it('refuses a helper on a different court', async () => {
    seed({ court_id: 'c2' });
    const res = await enterCourtHelperResult('m1', GAME);
    expect(res).toMatchObject({ ok: false, error: 'You are not helping on this match\'s court.' });
    expect(resultWrite()).toBeUndefined();
  });

  it('refuses a match that is not on court', async () => {
    seed({ status: 'ready' });
    const res = await enterCourtHelperResult('m1', GAME);
    expect(res.ok).toBe(false);
    expect(resultWrite()).toBeUndefined();
  });

  it('saves as the desk for someone holding the results capability, with no court filter', async () => {
    consoleUser.current = { viewer: { id: 'admin-1' }, level: 'admin', permissions: { kind: 'unrestricted' } };
    seed({ court_id: null });
    const res = await enterCourtHelperResult('m1', GAME);
    expect(res.ok).toBe(true);
    expect(gate.asked).toEqual(['tournaments.results.enter.write']);
    expect(resultWrite()?.filters.map(([c]) => c)).not.toContain('court_id');
    expect(resultWrite()?.payload.result_entered_by).toBe('admin-1');
  });

  it('refuses games that are not a score', async () => {
    expect(await enterCourtHelperResult('m1', [])).toMatchObject({ ok: false });
    expect(await enterCourtHelperResult('m1', [{ a: 1.5, b: 0 }])).toMatchObject({ ok: false });
    expect(await enterCourtHelperResult('m1', [{ a: 100, b: 0 }])).toMatchObject({ ok: false });
    expect(await enterCourtHelperResult('m1', [{ a: 10, b: 10 }])).toMatchObject({ ok: false, error: 'No game winner' });
    expect(resultWrite()).toBeUndefined();
  });
});

describe('addCourtHelper and removeCourtHelper', () => {
  it('asks the courts capability', async () => {
    gate.refuse = 'Not allowed';
    expect(await addCourtHelper('c2', 'helper-1')).toMatchObject({ ok: false });
    expect(await removeCourtHelper('c1', 'helper-1')).toMatchObject({ ok: false });
    expect(gate.asked).toEqual(['tournaments.manage.update.write', 'tournaments.manage.update.write']);
    expect(db.inserts).toEqual([]);
    expect(db.deletes).toEqual([]);
  });

  it('takes the tournament from the court row', async () => {
    db.tables.tournament_courts!.push({ id: 'c9', tournament_id: 't9', label: '9' });
    const res = await addCourtHelper('c9', 'helper-1');
    expect(res.ok).toBe(true);
    expect(db.inserts).toEqual([{
      table: 'tournament_court_helpers',
      payload: { tournament_id: 't9', court_id: 'c9', player_id: 'helper-1', created_by: 'admin-1' },
    }]);
    expect(audit.logAudit.mock.calls[0]![1]).toMatchObject({
      tournament_id: 't9', action: 'court_helper_added', details: { court_id: 'c9', player_id: 'helper-1' },
    });
  });

  it('refuses someone without console access, or not in good standing', async () => {
    expect(await addCourtHelper('c2', 'member-1')).toMatchObject({ ok: false, error: 'Only console members can help on a court.' });
    expect(await addCourtHelper('c2', 'banned-exec')).toMatchObject({ ok: false, error: 'Only console members can help on a court.' });
    expect(db.inserts).toEqual([]);
  });

  it('says so when the person is already on the court', async () => {
    db.insertError = { code: '23505', message: 'duplicate key' };
    expect(await addCourtHelper('c1', 'helper-1')).toMatchObject({ ok: false, error: 'Already helping on this court.' });
  });

  it('removes by court and person, and audits the removal', async () => {
    const res = await removeCourtHelper('c1', 'helper-1');
    expect(res.ok).toBe(true);
    expect(db.deletes).toEqual([{ table: 'tournament_court_helpers', filters: [['court_id', 'c1'], ['player_id', 'helper-1']] }]);
    expect(db.tables.tournament_court_helpers).toEqual([]);
    expect(audit.logAudit.mock.calls[0]![1]).toMatchObject({
      tournament_id: 't1', action: 'court_helper_removed', details: { court_id: 'c1', player_id: 'helper-1' },
    });
  });
});
