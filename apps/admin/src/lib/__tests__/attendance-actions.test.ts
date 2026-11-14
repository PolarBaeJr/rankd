// The event standard's actions (00324 to 00326). Each asks its capability,
// then its kill switch, and the switch refuses before anything is written; a
// restriction also takes the member off every waitlist they are waiting on.

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

const adminAudits: { action_type: string }[] = [];
const tournamentAudits: { action: string }[] = [];
vi.mock('../audit', () => ({
  logAdminAudit: vi.fn(async (_client: unknown, entry: { action_type: string }) => { adminAudits.push(entry); }),
  logAudit: vi.fn(async (_client: unknown, entry: { action: string }) => { tournamentAudits.push(entry); }),
}));

const writes: { table: string; kind: string; values?: unknown }[] = [];
const rpcs: { name: string; args: Record<string, unknown> }[] = [];
let waiting: { id: string }[] = [];
let rpcResult: Record<string, unknown> = { ok: true };

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: name === 'remove_from_event_waitlist' ? { ok: true } : rpcResult, error: null };
    }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, is: self, in: self, order: self, limit: self,
        insert: (values: unknown) => { writes.push({ table, kind: 'insert', values }); return chain; },
        update: (values: unknown) => { writes.push({ table, kind: 'update', values }); return chain; },
        single: async () => ({ data: { id: 'restriction-1' }, error: null }),
        maybeSingle: async () => {
          if (table === 'tournament_events') {
            return { data: { id: 'bbbbbbbb-0000-4000-8000-000000000001', tournament_id: 't1', event_type: 'open_singles', status: 'checkin' }, error: null };
          }
          if (table === 'tournaments') return { data: { suspended_at: null }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => void) => {
          resolve({ data: table === 'tournament_event_waitlist' ? waiting : [], error: null });
        },
      });
      return chain;
    },
  }),
}));

const { createEntryRestriction, liftEntryRestriction, rescindAttendanceWarning } = await import('../actions/attendance');
const { releaseCheckinNoShows, confirmEntryForMember } = await import('../tournament-actions/attendance');

const PLAYER = 'cccccccc-0000-4000-8000-000000000001';
const EVENT = 'bbbbbbbb-0000-4000-8000-000000000001';

beforeEach(() => {
  capabilities.length = 0;
  adminAudits.length = 0;
  tournamentAudits.length = 0;
  writes.length = 0;
  rpcs.length = 0;
  waiting = [];
  flags = {};
  rpcResult = { ok: true };
});

describe('entry restrictions', () => {
  it('asks the suspension capability, and the switch refuses before any write', async () => {
    flags.entry_restriction = false;
    const res = await createEntryRestriction({ playerId: PLAYER, reason: 'Two no-shows', endsAt: null });
    expect(res.ok).toBe(false);
    expect(capabilities).toEqual(['players.ban.write']);
    expect(writes).toEqual([]);
  });

  it('takes the member off every waitlist they are waiting on, and audits it', async () => {
    waiting = [{ id: 'w1' }, { id: 'w2' }];
    const res = await createEntryRestriction({ playerId: PLAYER, reason: 'Two no-shows', endsAt: null });
    expect(res.ok && res.data.removedFromWaitlists).toBe(2);
    expect(rpcs.filter((r) => r.name === 'remove_from_event_waitlist').map((r) => r.args.p_waitlist_id)).toEqual(['w1', 'w2']);
    expect(adminAudits.map((a) => a.action_type)).toEqual(['entry_restriction_created']);
  });

  it('refuses an end date in the past and a missing reason', async () => {
    expect((await createEntryRestriction({ playerId: PLAYER, reason: 'x', endsAt: '2020-01-01T00:00:00Z' })).ok).toBe(false);
    expect((await createEntryRestriction({ playerId: PLAYER, reason: ' ', endsAt: null })).ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('is lifted with the reinstatement capability', async () => {
    flags.entry_restriction = false;
    await liftEntryRestriction('dddddddd-0000-4000-8000-000000000001');
    expect(capabilities).toEqual(['players.reinstate.write']);
    expect(writes).toEqual([]);
  });
});

describe('attendance warnings', () => {
  it('refuses a rescind while the switch is off', async () => {
    flags.attendance_warnings = false;
    const res = await rescindAttendanceWarning('dddddddd-0000-4000-8000-000000000001', 'Mistake');
    expect(res.ok).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('the desk', () => {
  it('releases the no-shows behind fill_empty_places and asks for warnings only with attendance_warnings on', async () => {
    flags.attendance_warnings = false;
    rpcResult = { ok: true, released: [{ entry_id: 'e1', is_pair: false, player_ids: [PLAYER], warned: [] }], open_slots: 1 };
    const res = await releaseCheckinNoShows(EVENT);
    expect(res.ok && res.data).toEqual({ released: 1, warned: 0, openSlots: 1 });
    expect(capabilities).toEqual(['tournaments.draw.noshow.write']);
    expect(rpcs[0]).toMatchObject({ name: 'release_checkin_no_shows', args: { p_event_id: EVENT, p_warn: false } });
  });

  it('refuses the release while fill_empty_places is off', async () => {
    flags.fill_empty_places = false;
    expect((await releaseCheckinNoShows(EVENT)).ok).toBe(false);
    expect(rpcs).toEqual([]);
  });

  it('confirms a place for a member with the check-in capability, behind entry_confirmation', async () => {
    rpcResult = { ok: true, already: false };
    expect((await confirmEntryForMember(EVENT, PLAYER)).ok).toBe(true);
    expect(capabilities).toEqual(['tournaments.draw.checkin.mark.write']);
    expect(rpcs[0]).toMatchObject({ name: 'confirm_event_entry', args: { p_player_id: PLAYER } });
    flags.entry_confirmation = false;
    rpcs.length = 0;
    expect((await confirmEntryForMember(EVENT, PLAYER)).ok).toBe(false);
    expect(rpcs).toEqual([]);
  });
});
