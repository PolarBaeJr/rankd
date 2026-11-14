// 00334: every pairing path moves the members' confirmation rows to their
// current entry. Add pair, Auto pair, unpair and swap each relink after their
// write, a relink failure never fails the pairing, a database without the
// function is a quiet no-op, and nothing is relinked while entry_confirmation
// is off.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tableFake, type TableFake } from './table-fake';

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

let fake: TableFake;
const flags: Record<string, boolean> = {};
vi.mock('../supabase-server', () => ({
  createAdminClient: () => fake.client,
  requireCapability: vi.fn(async () => ({ id: 'desk-1' })),
}));
vi.mock('../actions/_shared', () => ({ requireCapability: vi.fn(async () => ({ id: 'desk-1' })) }));
vi.mock('../release-flags', () => ({
  releaseFlagOn: vi.fn(async (id: string) => flags[id] !== false),
  assertReleaseFlag: vi.fn(async () => {}),
  getReleaseFlags: vi.fn(async () => ({})),
}));
vi.mock('../audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  ensureEntryFees: vi.fn(async () => {}),
}));
vi.mock('../tournament-actions/_internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tournament-actions/_internal')>()),
  requireCapability: vi.fn(async () => ({ id: 'desk-1' })),
  revalidateEventPaths: () => {},
  assertTournamentNotSuspended: vi.fn(async () => {}),
  unsignedAmong: vi.fn(async () => ({ unsigned: [], tournamentName: 'Fall Open' })),
  notifyEventWaiverRequired: vi.fn(async () => {}),
  fillFromWaitlistAfterFree: vi.fn(async () => {}),
  loadTournamentWaiverContext: vi.fn(async () => ({ requiredHash: null, acceptances: [] })),
}));

const { addPairToEvent, autoPairWaitingEntrants, unpairEntry, swapPairMember } = await import('../tournament-actions/participants');

const EVENT = 'event-1';
const event = { id: EVENT, tournament_id: 't1', event_type: 'open_doubles', status: 'registration', draw_locked: false, external_event: false, max_participants: null, format: null, format_config: null };
const embedEvent = { id: EVENT, status: 'registration', event_type: 'open_doubles', tournament_id: 't1', draw_locked: false };
const solo = (id: string, rating: number) => ({
  id: `solo-${id}`,
  event_id: EVENT,
  player_id: id,
  status: 'registered',
  elo_before: rating,
  player: { full_name: `${id} Placeholder`, competition_category: null, ratings: { doubles_elo: rating } },
});

function seed(extra: Record<string, unknown[]> = {}) {
  fake = tableFake({
    tournament_events: [event],
    tournaments: [{ id: 't1', max_events_per_player: null }],
    tournament_participants: [solo('pa', 1600), solo('pb', 1400), solo('pc', 1200), solo('pd', 1000)],
    tournament_pairs: [],
    ratings: ['pa', 'pb', 'pc', 'pd'].map((id) => ({ player_id: id, doubles_elo: 1000 })),
    players: ['pa', 'pb', 'pc', 'pd'].map((id) => ({ id, full_name: `${id} Placeholder`, competition_category: null })),
    ...extra,
  } as never);
  fake.rpcResult = (name) => (name === 'pair_tournament_entrants' ? 'pair-new' : null);
}

const relinks = () => fake.rpcs.filter((call) => call.name === 'relink_event_confirmations');
const pairRow = { id: 'pair-1', event_id: EVENT, player1_id: 'pa', player2_id: 'pb', status: 'registered', event: embedEvent, player1: { full_name: 'pa Placeholder' }, player2: { full_name: 'pb Placeholder' } };

beforeEach(() => {
  for (const key of Object.keys(flags)) delete flags[key];
  sentry.captureException.mockClear();
  seed();
});

describe('relinking after a pairing write', () => {
  it('Add pair relinks both members', async () => {
    const result = await addPairToEvent(EVENT, 'pa', 'pb');
    expect(result.ok).toBe(true);
    expect(relinks()).toEqual([{ name: 'relink_event_confirmations', args: { p_event_id: EVENT, p_player_ids: ['pa', 'pb'] } }]);
  });

  it('Auto pair relinks every pair it made', async () => {
    const result = await autoPairWaitingEntrants(EVENT);
    expect(result).toMatchObject({ ok: true, data: { pairsMade: 2 } });
    expect(relinks().map((call) => [...(call.args.p_player_ids as string[])].sort())).toEqual(
      expect.arrayContaining([['pa', 'pd'], ['pb', 'pc']]),
    );
    expect(relinks()).toHaveLength(2);
  });

  it('unpair relinks both, back to their solo entries', async () => {
    seed({ tournament_pairs: [pairRow] });
    const result = await unpairEntry('pair-1');
    expect(result.ok).toBe(true);
    expect(fake.rpcs.map((call) => call.name)).toEqual(['unpair_tournament_pair', 'relink_event_confirmations']);
    expect(relinks()[0]!.args).toEqual({ p_event_id: EVENT, p_player_ids: ['pa', 'pb'] });
  });

  it('swap relinks the outgoing, the incoming and the partner', async () => {
    seed({ tournament_pairs: [pairRow] });
    const result = await swapPairMember('pair-1', 'pb', 'pc');
    expect(result.ok).toBe(true);
    expect(fake.rpcs.map((call) => call.name)).toEqual(['swap_tournament_pair_member', 'relink_event_confirmations']);
    expect(relinks()[0]!.args).toEqual({ p_event_id: EVENT, p_player_ids: ['pb', 'pc', 'pa'] });
  });

  it('a relink failure is reported and the pairing still succeeds', async () => {
    fake.rpcError = (name) => (name === 'relink_event_confirmations' ? { code: 'XX000', message: 'relink exploded' } : null);
    expect((await addPairToEvent(EVENT, 'pa', 'pb')).ok).toBe(true);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'relink exploded' }), expect.anything());

    seed({ tournament_pairs: [pairRow] });
    fake.rpcResult = (name) => {
      if (name === 'relink_event_confirmations') throw new Error('the call itself threw');
      return null;
    };
    expect((await unpairEntry('pair-1')).ok).toBe(true);
    expect(relinks()).toHaveLength(1);
  });

  it('a database without 00334 is a quiet no-op', async () => {
    fake.rpcError = (name) => (name === 'relink_event_confirmations' ? { code: 'PGRST202', message: 'no such function' } : null);
    expect((await addPairToEvent(EVENT, 'pa', 'pb')).ok).toBe(true);
    expect(relinks()).toHaveLength(1);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('nothing is relinked while entry_confirmation is off', async () => {
    flags.entry_confirmation = false;
    expect((await addPairToEvent(EVENT, 'pa', 'pb')).ok).toBe(true);
    expect(relinks()).toHaveLength(0);
  });
});
