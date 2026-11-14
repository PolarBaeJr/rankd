// 00333: social post sets. The first run is the full set; a later run is only
// the teams it added, batched for ten minutes into one notice, with a fresh
// full set superseding the old one; a draw supersedes the draw before it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tableFake, type TableFake } from '../../__tests__/table-fake';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('server-only', () => ({}));

let flags: Record<string, boolean> = {};
vi.mock('../../release-flags', () => ({
  releaseFlagOn: vi.fn(async (id: string) => flags[id] !== false),
}));

const notices: { ids: string[]; input: { title: string; body?: string | null; metadata?: Record<string, unknown> } }[] = [];
vi.mock('../../notify', () => ({
  notifyPlayers: vi.fn(async (_client: unknown, ids: string[], input: never) => {
    notices.push({ ids, input });
    return { delivered: ids };
  }),
}));

const { queueTeamSocialPosts, queueDrawSocialPosts, drawGroupsFrom, BATCH_MINUTES } = await import('../queue');

const EVENT = 'bbbbbbbb-0000-4000-8000-000000000001';
const MARKETING = '5eed0060-0000-4000-8000-000000000204';

const officer = {
  id: 'm1',
  role: 'player',
  is_exec: true,
  is_trainer: false,
  is_banned: false,
  status: 'active',
  active_flag: true,
  permission_role: 'custom',
  permission_grants: ['announcements.page', 'announcements.socialposts.read'],
  permission_revokes: [],
  permission_baseline_id: MARKETING,
};

const pair = (id: string, minute: number, status = 'registered') => ({
  id,
  event_id: EVENT,
  status,
  created_at: `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`,
});

function seed(pairs: unknown[], sets: unknown[] = [], eventType = 'mixed_doubles'): TableFake {
  return tableFake({
    tournament_events: [{ id: EVENT, tournament_id: 't1', event_type: eventType, tournament: { name: 'Fall Open', start_date: '2026-11-21', starts_time: null, location: 'West Gym' } }],
    tournament_pairs: pairs,
    event_social_post_sets: sets,
    platform_settings: [{ key: 'social_hashtags', value: { hashtags: '#club' } }],
    players: [officer],
  } as never);
}

const open = (fake: TableFake) =>
  (fake.tables.event_social_post_sets as Array<Record<string, unknown>>).filter((set) => !set.superseded_at);

beforeEach(() => {
  flags = {};
  notices.length = 0;
});

describe('queueTeamSocialPosts', () => {
  it('the first run is Meet the teams, in pairing order, with one notice', async () => {
    const fake = seed([pair('t2', 2), pair('t1', 1), pair('gone', 3, 'withdrawn')]);
    const outcome = await queueTeamSocialPosts(fake.client as never, EVENT, ['t1', 't2']);
    expect(outcome.created).toEqual(['teams_full']);
    const sets = open(fake);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ kind: 'teams_full', entry_ids: ['t1', 't2'] });
    expect(String(sets[0]!.caption)).toMatch(/^Meet the teams for Fall Open/);
    expect(sets[0]!.notified_at).toBeTruthy();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.ids).toEqual(['m1']);
    expect(notices[0]!.input.metadata).toMatchObject({ kind: 'social_posts_ready', event_id: EVENT });
    expect(String(notices[0]!.input.metadata!.console_url)).toContain(`/announcements/social/${EVENT}`);
  });

  it('a later run names only the teams it added, and supersedes the full set', async () => {
    const fake = seed(
      [pair('t1', 1), pair('t2', 2), pair('t3', 3)],
      [{ id: 'full1', event_id: EVENT, kind: 'teams_full', entry_ids: ['t1', 't2'], caption: 'x', superseded_at: null, created_at: '2026-11-10T09:00:00.000Z' }],
    );
    const outcome = await queueTeamSocialPosts(fake.client as never, EVENT, ['t3']);
    expect(outcome.created).toEqual(['teams_new', 'teams_full']);
    const sets = open(fake);
    expect(sets.find((set) => set.kind === 'teams_new')).toMatchObject({ entry_ids: ['t3'] });
    expect(sets.find((set) => set.kind === 'teams_full')).toMatchObject({ entry_ids: ['t1', 't2', 't3'] });
    expect(sets.some((set) => set.id === 'full1')).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.input.body).toContain('New teams slides (1)');
  });

  it(`batches additions within ${BATCH_MINUTES} minutes into the open New teams set, with no second notice`, async () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const fake = seed(
      [pair('t1', 1), pair('t2', 2), pair('t3', 3)],
      [
        { id: 'full1', event_id: EVENT, kind: 'teams_full', entry_ids: ['t1', 't2'], caption: 'x', superseded_at: null, created_at: '2026-11-10T11:55:00.000Z' },
        { id: 'new1', event_id: EVENT, kind: 'teams_new', entry_ids: ['t2'], caption: 'x', superseded_at: null, created_at: '2026-11-10T11:55:00.000Z' },
      ],
    );
    const outcome = await queueTeamSocialPosts(fake.client as never, EVENT, ['t3'], now);
    expect(outcome.appendedTo).toBe('new1');
    expect(open(fake).find((set) => set.id === 'new1')).toMatchObject({ entry_ids: ['t2', 't3'] });
    expect(open(fake).filter((set) => set.kind === 'teams_new')).toHaveLength(1);
    expect(notices).toHaveLength(0);
  });

  it('an older New teams set is not appended to', async () => {
    const now = new Date('2026-11-10T12:30:00.000Z');
    const fake = seed(
      [pair('t1', 1), pair('t2', 2), pair('t3', 3)],
      [
        { id: 'full1', event_id: EVENT, kind: 'teams_full', entry_ids: ['t1', 't2'], caption: 'x', superseded_at: null, created_at: '2026-11-10T11:55:00.000Z' },
        { id: 'new1', event_id: EVENT, kind: 'teams_new', entry_ids: ['t2'], caption: 'x', superseded_at: null, created_at: '2026-11-10T11:55:00.000Z' },
      ],
    );
    const outcome = await queueTeamSocialPosts(fake.client as never, EVENT, ['t3'], now);
    expect(outcome.appendedTo).toBeNull();
    expect(outcome.created).toContain('teams_new');
    expect(notices).toHaveLength(1);
  });

  it('nothing changes and nothing is sent when the teams are as posted', async () => {
    const fake = seed(
      [pair('t1', 1)],
      [{ id: 'full1', event_id: EVENT, kind: 'teams_full', entry_ids: ['t1'], caption: 'x', superseded_at: null, created_at: '2026-11-10T09:00:00.000Z' }],
    );
    const outcome = await queueTeamSocialPosts(fake.client as never, EVENT, []);
    expect(outcome.created).toEqual([]);
    expect(fake.writes).toHaveLength(0);
  });

  it('writes nothing with social_posts off, or for a singles event', async () => {
    flags = { social_posts: false };
    const off = seed([pair('t1', 1)]);
    expect((await queueTeamSocialPosts(off.client as never, EVENT, ['t1'])).created).toEqual([]);
    expect(off.writes).toHaveLength(0);
    flags = {};
    const singles = seed([pair('t1', 1)], [], 'open_singles');
    expect((await queueTeamSocialPosts(singles.client as never, EVENT, ['t1'])).created).toEqual([]);
    expect(singles.writes).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });
});

const match = (extra: Record<string, unknown>) => ({
  event_id: EVENT,
  stage: 1,
  pool_number: null,
  group_number: null,
  round_number: 1,
  bracket_position: 1,
  participant_a_id: null,
  participant_b_id: null,
  pair_a_id: null,
  pair_b_id: null,
  ...extra,
});

describe('the draw', () => {
  it('reads groups off the newest stage, each entry once', () => {
    const { groups, shape } = drawGroupsFrom(
      [
        match({ stage: 1, group_number: 1, pair_a_id: 'old', pair_b_id: 'older' }),
        match({ stage: 2, group_number: 2, pair_a_id: 'c', pair_b_id: 'd' }),
        match({ stage: 2, group_number: 1, pair_a_id: 'a', pair_b_id: 'b' }),
        match({ stage: 2, group_number: 1, pair_a_id: 'b', pair_b_id: 'a' }),
      ] as never,
      true,
    );
    expect(shape).toBe('groups');
    expect(groups.map((group) => group.entry_ids)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(groups[0]!.title).toMatch(/A|1/);
  });

  it('reads a bracket as its first round, in position order, a bye kept as a gap', () => {
    const { groups, shape } = drawGroupsFrom(
      [
        match({ bracket_position: 2, participant_a_id: 'c', participant_b_id: null }),
        match({ bracket_position: 1, participant_a_id: 'a', participant_b_id: 'b' }),
        match({ round_number: 2, bracket_position: 1, participant_a_id: 'a' }),
      ] as never,
      false,
    );
    expect(shape).toBe('bracket');
    expect(groups).toEqual([{ title: 'First round', entry_ids: ['a', 'b', 'c', ''], versus: true }]);
  });

  it('a redraw supersedes the draw set before it and notifies', async () => {
    const fake = tableFake({
      tournament_events: [{ id: EVENT, tournament_id: 't1', event_type: 'open_singles', tournament: { name: 'Fall Open' } }],
      tournament_matches: [match({ participant_a_id: 'a', participant_b_id: 'b' })],
      event_social_post_sets: [{ id: 'draw1', event_id: EVENT, kind: 'draw', entry_ids: ['x'], caption: 'x', superseded_at: null, created_at: '2026-11-10T09:00:00.000Z' }],
      players: [officer],
    } as never);
    const outcome = await queueDrawSocialPosts(fake.client as never, EVENT);
    expect(outcome.created).toEqual(['draw']);
    const sets = open(fake);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ kind: 'draw', entry_ids: ['a', 'b'] });
    expect(String(sets[0]!.caption)).toMatch(/^The draw is out for Fall Open/);
    expect(notices).toHaveLength(1);
  });
});
