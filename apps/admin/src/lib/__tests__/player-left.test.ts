// "LEFT" (00324 event_departures). The desk may mark any entry; a court helper
// only an entry playing on a court they help on. Every departure is recorded
// with its reason, and only "left without telling anyone" warns.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  inserts: [] as Array<{ table: string; payload: Row }>,
  rpcs: [] as Array<{ name: string; args: Row }>,
}));

const makeClient = vi.hoisted(() => () => ({
  rpc: async (name: string, args: Row) => {
    db.rpcs.push({ name, args });
    return { data: { ok: true, already: false }, error: null };
  },
  from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let inserting = false;
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const api: Record<string, unknown> = {
      select: () => api,
      limit: () => api,
      in: () => api,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return api; },
      insert: (payload: Row) => {
        inserting = true;
        db.inserts.push({ table, payload });
        return api;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: inserting ? null : rows(), error: null }),
    };
    return api;
  },
}));

const consoleUser = vi.hoisted(() => ({ caps: new Set<string>() }));
const flags = vi.hoisted(() => ({ off: new Set<string>() }));
const warnings = vi.hoisted(() => ({ calls: [] as Row[] }));

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
  entryPlayerIds: async () => ['player-1'],
  issueAttendanceWarnings: async (_client: unknown, input: Row) => {
    warnings.calls.push(input);
    return [{ playerId: 'player-1', warningId: 'warning-1' }];
  },
}));
vi.mock('../tournament-actions/_internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tournament-actions/_internal')>()),
  assertTournamentNotSuspended: async () => {},
  revalidateEventPaths: () => {},
}));

const { recordPlayerLeft } = await import('../tournament-actions/results');

const ENTRY = 'cccccccc-0000-4000-8000-000000000001';

function seed() {
  db.tables = {
    tournament_events: [{ id: 'e1', tournament_id: 't1', event_type: 'mens_singles', status: 'pool_live', format: 'staged' }],
    tournament_participants: [{ id: ENTRY, event_id: 'e1', player_id: 'player-1' }],
    tournament_matches: [
      { id: 'm1', event_id: 'e1', status: 'live', stage: 1, court_id: 'court-1', participant_a_id: ENTRY, participant_b_id: 'other' },
    ],
    tournament_court_helpers: [{ id: 'h1', court_id: 'court-1', player_id: 'helper-1' }],
    event_departures: [],
  };
}

beforeEach(() => {
  seed();
  db.inserts = [];
  db.rpcs = [];
  warnings.calls = [];
  consoleUser.caps = new Set();
  // The match void itself is the helper void, tested in court-helpers.test.ts.
  flags.off = new Set(['desk_helper_void']);
});

const departures = () => db.inserts.filter((i) => i.table === 'event_departures').map((i) => i.payload);

describe('recordPlayerLeft', () => {
  it('lets a helper on the entry\'s court mark them, records the reason, and warns nobody', async () => {
    const res = await recordPlayerLeft('e1', ENTRY, { reason: 'injury' });
    expect(res.ok).toBe(true);
    expect(db.rpcs[0]).toMatchObject({ name: 'set_field_entry_status', args: { p_entry_id: ENTRY, p_new_status: 'no_show' } });
    expect(departures()).toEqual([expect.objectContaining({
      player_id: 'player-1', participant_id: ENTRY, reason: 'injury', marked_as: 'court_helper', warning_id: null,
    })]);
    expect(warnings.calls).toEqual([]);
  });

  it('refuses a helper on another court, before anything is written', async () => {
    db.tables.tournament_court_helpers = [{ id: 'h1', court_id: 'court-2', player_id: 'helper-1' }];
    const res = await recordPlayerLeft('e1', ENTRY, { reason: 'injury' });
    expect(res.ok === false && res.error).toBe('You are not helping on this match\'s court.');
    expect(db.rpcs).toEqual([]);
    expect(departures()).toEqual([]);
  });

  it('warns for "left without telling anyone", and links the warning', async () => {
    const res = await recordPlayerLeft('e1', ENTRY, { reason: 'without_notice' });
    expect(res.ok && res.data.warned).toBe(1);
    expect(warnings.calls).toEqual([expect.objectContaining({ kind: 'left_without_notice', source: 'court_helper' })]);
    expect(departures()[0]).toMatchObject({ reason: 'without_notice', warning_id: 'warning-1' });
  });

  it('lets the desk mark an entry with no live match, as the desk', async () => {
    consoleUser.caps = new Set(['tournaments.draw.noshow.write', 'tournaments.results.void.write']);
    db.tables.tournament_matches = [];
    const res = await recordPlayerLeft('e1', ENTRY, { reason: 'without_notice' });
    expect(res.ok).toBe(true);
    expect(warnings.calls).toEqual([expect.objectContaining({ source: 'desk' })]);
    expect(departures()[0]).toMatchObject({ marked_as: 'desk' });
  });

  it('refuses while attendance_warnings is off, and asks for a reason and a note for "other"', async () => {
    flags.off.add('attendance_warnings');
    expect((await recordPlayerLeft('e1', ENTRY, { reason: 'injury' })).ok).toBe(false);
    flags.off.delete('attendance_warnings');
    expect(await recordPlayerLeft('e1', ENTRY, { reason: 'other' })).toMatchObject({ ok: false, error: 'Say why they left.' });
    expect(await recordPlayerLeft('e1', ENTRY, { reason: 'bored' as never })).toMatchObject({ ok: false, error: 'Choose why they left.' });
    expect(db.rpcs).toEqual([]);
    expect(departures()).toEqual([]);
  });

  // "Left, with a sub" is no longer this action: leaveAndSubstitute writes the
  // departure, the void and the sub in one call (substitutions.test.ts), so a
  // cancelled sub leaves nothing behind. This one always marks the no-show.
  it('has no way to record a departure without marking the entry out', async () => {
    consoleUser.caps = new Set(['tournaments.draw.noshow.write', 'tournaments.results.void.write']);
    const res = await recordPlayerLeft('e1', ENTRY, { reason: 'injury', subbing: true } as never);
    expect(res.ok).toBe(true);
    expect(db.rpcs.map((r: { name: string }) => r.name)).toContain('set_field_entry_status');
  });
});
