// 00331: the desk's time cap on a group. Each action asks the void key, then
// the group_time_cap switch, before anything is written; a cap is set only in
// the future and only on a groups stage that has not fed the next one.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../notify', () => ({ notifyPlayers: async () => ({ delivered: [] }) }));

const capabilities: string[] = [];
vi.mock('../actions/_shared', () => ({
  requireCapability: vi.fn(async (capability: string) => {
    capabilities.push(capability);
    return { id: 'aaaaaaaa-0000-4000-8000-000000000001' };
  }),
}));

let flags: Record<string, boolean> = {};
vi.mock('../release-flags', async () => {
  const { ExpectedError, releaseFlagOffMessage } = await import('@badminton/shared');
  return {
    releaseFlagOn: vi.fn(async (id: string) => flags[id] !== false),
    assertReleaseFlag: vi.fn(async (id: string) => {
      if (flags[id] === false) throw new ExpectedError(releaseFlagOffMessage(id as never));
    }),
  };
});
vi.mock('../audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('../tournament-actions/auto-call', () => ({ fillFreeCourts: vi.fn(async () => ({ called: [], failed: [] })) }));

const EVENT = 'bbbbbbbb-0000-4000-8000-000000000001';
const CAP = 'cccccccc-0000-4000-8000-000000000001';
const groupsConfig = {
  version: 1,
  stages: [{ key: 'groups', name: 'Groups', kind: 'groups' }, { key: 'ko', name: 'Knockout', kind: 'knockout' }],
};

const writes: { table: string; kind: string; values?: unknown }[] = [];
const rpcs: { name: string; args: Record<string, unknown> }[] = [];
let laterStageMatches = 0;
let capRow: Record<string, unknown> | null = null;

vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  parseFormatConfig: () => groupsConfig,
}));

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: { ok: true, voided: 3 }, error: null };
    }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, is: self, gt: self, order: self, limit: self,
        insert: (values: unknown) => { writes.push({ table, kind: 'insert', values }); return chain; },
        update: (values: unknown) => { writes.push({ table, kind: 'update', values }); return chain; },
        delete: () => { writes.push({ table, kind: 'delete' }); return chain; },
        single: async () => {
          if (table === 'tournaments') return { data: { suspended_at: null, suspension_reason: null }, error: null };
          return { data: { id: CAP }, error: null };
        },
        maybeSingle: async () => {
          if (table === 'tournament_events') {
            return { data: { id: EVENT, tournament_id: 't1', format: 'staged', format_config: groupsConfig, status: 'pool_live', event_type: 'open_singles' }, error: null };
          }
          if (table === 'stage_group_time_caps') return { data: capRow, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => void) => {
          if (table === 'tournament_matches') return resolve({ count: laterStageMatches, error: null });
          return resolve({ data: [], error: null, count: 1 });
        },
      });
      return chain;
    },
  }),
}));

const { setGroupTimeCap, clearGroupTimeCap, applyGroupTimeCapNow } = await import('../tournament-actions/time-caps');

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  capabilities.length = 0;
  writes.length = 0;
  rpcs.length = 0;
  flags = {};
  laterStageMatches = 0;
  capRow = { id: CAP, event_id: EVENT, stage: 1, pool_number: 1, group_number: 2, cap_at: inAnHour(), applied_at: null };
});

describe('setting a time cap', () => {
  it('asks the void key, and the switch refuses before any write', async () => {
    flags.group_time_cap = false;
    const res = await setGroupTimeCap(EVENT, { stage: 1, pool: 1, group: 2, capAt: inAnHour() });
    expect(res.ok).toBe(false);
    expect(capabilities).toEqual(['tournaments.results.void.write']);
    expect(writes).toEqual([]);
  });

  it('sets a cap still to come on a group', async () => {
    const res = await setGroupTimeCap(EVENT, { stage: 1, pool: 1, group: 2, capAt: inAnHour() });
    expect(res.ok).toBe(true);
    expect(writes).toEqual([expect.objectContaining({ table: 'stage_group_time_caps', kind: 'insert', values: expect.objectContaining({ stage: 1, pool_number: 1, group_number: 2 }) })]);
  });

  it('refuses a time already gone, a knockout stage, a group with no pool, and groups that fed the next stage', async () => {
    expect((await setGroupTimeCap(EVENT, { stage: 1, pool: null, group: null, capAt: new Date(Date.now() - 1000).toISOString() })).ok).toBe(false);
    expect((await setGroupTimeCap(EVENT, { stage: 2, pool: null, group: null, capAt: inAnHour() })).ok).toBe(false);
    expect((await setGroupTimeCap(EVENT, { stage: 1, pool: null, group: 2, capAt: inAnHour() })).ok).toBe(false);
    laterStageMatches = 4;
    const drawn = await setGroupTimeCap(EVENT, { stage: 1, pool: null, group: null, capAt: inAnHour() });
    expect(drawn.ok === false && drawn.error).toBe('The next stage is drawn, so these groups are over.');
    expect(writes).toEqual([]);
  });
});

describe('cap now and clear', () => {
  it('applies with the actor, then fills the courts', async () => {
    const res = await applyGroupTimeCapNow(CAP);
    expect(res.ok && res.data.voided).toBe(3);
    expect(rpcs).toEqual([{ name: 'apply_group_time_cap', args: { p_cap_id: CAP, p_actor: 'aaaaaaaa-0000-4000-8000-000000000001' } }]);
  });

  it('is behind the same switch', async () => {
    flags.group_time_cap = false;
    expect((await applyGroupTimeCapNow(CAP)).ok).toBe(false);
    expect((await clearGroupTimeCap(CAP)).ok).toBe(false);
    expect(rpcs).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('never clears a cap already applied', async () => {
    capRow = { ...capRow, applied_at: new Date().toISOString() };
    expect((await clearGroupTimeCap(CAP)).ok).toBe(false);
    expect(writes).toEqual([]);
  });
});
