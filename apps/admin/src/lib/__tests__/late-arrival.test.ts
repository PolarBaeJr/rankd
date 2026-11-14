// 00330: a late arrival whose place was released at check-in close. The desk
// asks the no-show capability, then the switch, before anything is written; a
// reinstate goes on to the normal check-in, and the head of the reserves has
// to be confirmed.

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
vi.mock('../audit', () => ({ logAudit: vi.fn(async () => {}), logAdminAudit: vi.fn(async () => {}) }));

const checkIns: string[] = [];
let checkInError: Error | null = null;
vi.mock('../tournament-actions/entry-core', () => ({
  checkInParticipantCore: vi.fn(async (id: string) => {
    if (checkInError) throw checkInError;
    checkIns.push(`participant:${id}`);
  }),
  checkInPairCore: vi.fn(async (id: string) => { checkIns.push(`pair:${id}`); }),
}));
vi.mock('../tournament-actions/participants', () => ({
  checkInPairMember: vi.fn(async (id: string, slot: number) => {
    checkIns.push(`member:${id}:${slot}`);
    return { ok: true, data: { pairCheckedIn: false } };
  }),
}));

const rpcs: { name: string; args: Record<string, unknown> }[] = [];
let rpcResult: Record<string, unknown> = { ok: true };

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: rpcResult, error: null };
    }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, is: self, in: self, order: self, limit: self,
        single: async () => ({ data: { suspended_at: null, suspension_reason: null }, error: null }),
        maybeSingle: async () => {
          if (table === 'tournament_events') {
            return { data: { id: EVENT, tournament_id: 't1', event_type: 'open_singles', status: 'checkin' }, error: null };
          }
          if (table === 'tournaments') return { data: { suspended_at: null }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
      });
      return chain;
    },
  }),
}));

const { reinstateLateArrival, returnLateArrivalToReserves } = await import('../tournament-actions/attendance');
const { ExpectedError } = await import('@badminton/shared');

const EVENT = 'bbbbbbbb-0000-4000-8000-000000000001';
const ENTRY = 'cccccccc-0000-4000-8000-000000000001';

beforeEach(() => {
  capabilities.length = 0;
  rpcs.length = 0;
  checkIns.length = 0;
  checkInError = null;
  flags = {};
  rpcResult = { ok: true };
});

describe('reinstate a late arrival', () => {
  it('asks the no-show capability, and the switch refuses before the RPC', async () => {
    flags.late_arrival_reinstate = false;
    const res = await reinstateLateArrival(EVENT, ENTRY, false);
    expect(res.ok).toBe(false);
    expect(capabilities).toEqual(['tournaments.draw.noshow.write']);
    expect(rpcs).toEqual([]);
  });

  it('reinstates, then runs the normal check-in', async () => {
    const res = await reinstateLateArrival(EVENT, ENTRY, false);
    expect(res.ok && res.data).toEqual({ placeTaken: false, checkedIn: true, checkInRefusal: null });
    expect(rpcs.map((r) => r.name)).toEqual(['reinstate_released_entry']);
    expect(checkIns).toEqual([`participant:${ENTRY}`]);
  });

  it('marks only the pair member at the desk', async () => {
    await reinstateLateArrival(EVENT, ENTRY, true, 2);
    expect(checkIns).toEqual([`member:${ENTRY}:2`]);
  });

  it('keeps the entry and says why when the check-in is refused', async () => {
    checkInError = new ExpectedError('The waiver is not signed.');
    const res = await reinstateLateArrival(EVENT, ENTRY, false);
    expect(res.ok && res.data).toEqual({ placeTaken: false, checkedIn: false, checkInRefusal: 'The waiver is not signed.' });
  });

  it('tells the desk the place is taken, without checking anyone in', async () => {
    rpcResult = { ok: false, reason: 'place_taken' };
    const res = await reinstateLateArrival(EVENT, ENTRY, false);
    expect(res.ok && res.data.placeTaken).toBe(true);
    expect(checkIns).toEqual([]);
  });

  it('after the draw, points at a substitution', async () => {
    rpcResult = { ok: false, reason: 'drawn' };
    const res = await reinstateLateArrival(EVENT, ENTRY, false);
    expect(res.ok === false && res.error).toBe('The draw is made. Use a substitution or Add on the spot.');
  });
});

describe('back to the reserves', () => {
  it('goes to the back by default', async () => {
    const res = await returnLateArrivalToReserves(EVENT, ENTRY, true, false);
    expect(res.ok).toBe(true);
    expect(rpcs).toEqual([{ name: 'requeue_released_entry', args: expect.objectContaining({ p_is_pair: true, p_head: false }) }]);
  });

  it('refuses the head of the queue unless confirmed', async () => {
    expect((await returnLateArrivalToReserves(EVENT, ENTRY, false, true)).ok).toBe(false);
    expect(rpcs).toEqual([]);
    expect((await returnLateArrivalToReserves(EVENT, ENTRY, false, true, true)).ok).toBe(true);
    expect(rpcs[0]!.args.p_head).toBe(true);
  });

  it('is behind the same switch', async () => {
    flags.late_arrival_reinstate = false;
    expect((await returnLateArrivalToReserves(EVENT, ENTRY, false, false)).ok).toBe(false);
    expect(rpcs).toEqual([]);
  });
});
