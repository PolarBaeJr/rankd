// 00333: the top 4, announced. One announcement per event, edited by a
// re-finalize; names follow the owner's rule; the Marketing holders get the
// lines to copy, the admins when nobody holds it; the switch stops all of it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tableFake, type TableFake } from './table-fake';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('server-only', () => ({}));

let flags: Record<string, boolean> = {};
vi.mock('../release-flags', () => ({
  releaseFlagOn: vi.fn(async (id: string) => flags[id] !== false),
}));

const notices: { ids: string[]; input: { title: string; body?: string | null; metadata?: Record<string, unknown> } }[] = [];
vi.mock('../notify', () => ({
  notifyPlayers: vi.fn(async (_client: unknown, ids: string[], input: never) => {
    notices.push({ ids, input });
    return { delivered: ids };
  }),
}));

const { postEventResults, resultsLine } = await import('../event-results-post');
const { isMarketingHolder } = await import('../marketing-recipients');

const EVENT = 'bbbbbbbb-0000-4000-8000-000000000001';
const ACTOR = 'aaaaaaaa-0000-4000-8000-000000000001';
const MARKETING = '5eed0060-0000-4000-8000-000000000204';

const person = (full_name: string, extra: Record<string, unknown> = {}) => ({
  full_name,
  handle: null,
  hide_from_leaderboard: false,
  deletion_requested_at: null,
  is_guest: false,
  ...extra,
});

const officer = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
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
  ...extra,
});

function seed(extra: Record<string, unknown[]> = {}): TableFake {
  return tableFake({
    tournament_events: [{ id: EVENT, tournament_id: 't1', event_type: 'open_singles', tournament: { name: 'Fall Open' } }],
    tournament_participants: [
      { id: 'p1', event_id: EVENT, final_position: 1, player: person('Avery Placeholder') },
      { id: 'p2', event_id: EVENT, final_position: 2, player: person('Blake Placeholder') },
      { id: 'p3', event_id: EVENT, final_position: 3, player: person('Casey Placeholder', { hide_from_leaderboard: true }) },
      { id: 'p4', event_id: EVENT, final_position: 3, player: person('Drew Placeholder') },
      { id: 'p5', event_id: EVENT, final_position: 5, player: person('Emery Placeholder') },
    ],
    seasons: [{ id: 's1', active_flag: true }],
    players: [officer('m1')],
    ...extra,
  } as never);
}

beforeEach(() => {
  flags = {};
  notices.length = 0;
});

describe('postEventResults', () => {
  it('posts one short announcement with ties kept and a hidden member as "A member"', async () => {
    const fake = seed();
    const outcome = await postEventResults(fake.client as never, EVENT, ACTOR);
    expect(outcome.posted).toBe('created');
    const [announcement] = fake.tables.announcements!;
    expect(announcement).toMatchObject({
      title: 'Fall Open Open Singles results',
      body: 'Fall Open Open Singles results: 1st Avery Placeholder, 2nd Blake Placeholder, 3rd A member, 3rd Drew Placeholder',
      type: 'event', status: 'published', send_push: false, target_audience: 'all', season_id: 's1', all_seasons: false,
    });
    expect(fake.tables.event_results_posts).toHaveLength(1);
    expect(announcement!.body).not.toContain('\u2014');
  });

  it('a re-finalize edits the same announcement and does not post a second', async () => {
    const fake = seed();
    await postEventResults(fake.client as never, EVENT, ACTOR);
    fake.tables.tournament_participants![1]!.final_position = 1;
    fake.tables.tournament_participants![0]!.final_position = 2;
    const outcome = await postEventResults(fake.client as never, EVENT, ACTOR);
    expect(outcome.posted).toBe('updated');
    expect(fake.tables.announcements).toHaveLength(1);
    expect(fake.tables.announcements![0]!.body).toContain('1st Blake Placeholder, 2nd Avery Placeholder');
    expect(notices).toHaveLength(2);
  });

  it('a re-finalize that moved nobody sends no second notice', async () => {
    const fake = seed();
    await postEventResults(fake.client as never, EVENT, ACTOR);
    await postEventResults(fake.client as never, EVENT, ACTOR);
    expect(notices).toHaveLength(1);
  });

  it('an announcement an officer deleted stays deleted', async () => {
    const fake = seed();
    await postEventResults(fake.client as never, EVENT, ACTOR);
    fake.tables.event_results_posts![0]!.announcement_id = null;
    fake.tables.announcements = [];
    expect((await postEventResults(fake.client as never, EVENT, ACTOR)).posted).toBe('kept_deleted');
    expect(fake.tables.announcements).toHaveLength(0);
  });

  it('switched off, it writes and sends nothing', async () => {
    flags = { results_post: false };
    const fake = seed();
    expect((await postEventResults(fake.client as never, EVENT, ACTOR)).posted).toBe('off');
    expect(fake.writes).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it('evergreen with an expiry when no season is active', async () => {
    const fake = seed({ seasons: [] });
    await postEventResults(fake.client as never, EVENT, ACTOR);
    expect(fake.tables.announcements![0]).toMatchObject({ season_id: null, all_seasons: true });
    expect(fake.tables.announcements![0]!.expires_at).toBeTruthy();
  });

  it('tells the Marketing holders, with the lines to copy and the console link when Social posts is on', async () => {
    const fake = seed();
    await postEventResults(fake.client as never, EVENT, ACTOR);
    expect(notices[0]!.ids).toEqual(['m1']);
    expect(notices[0]!.input.metadata).toMatchObject({
      kind: 'event_results_handoff',
      event_id: EVENT,
      copy_text: expect.stringContaining('1st Avery Placeholder'),
      console_url: expect.stringContaining(`/announcements/social/${EVENT}`),
    });
  });

  it('no console link while Social posts is off', async () => {
    flags = { social_posts: false };
    const fake = seed();
    await postEventResults(fake.client as never, EVENT, ACTOR);
    expect(notices[0]!.input.metadata).not.toHaveProperty('console_url');
  });

  it('falls back to the admins when nobody holds it', async () => {
    const fake = seed({
      players: [
        officer('x1', { permission_baseline_id: null, permission_grants: ['announcements.page'] }),
        { ...officer('a1'), role: 'admin', permission_grants: [], permission_baseline_id: null },
        { ...officer('a2'), role: 'admin', permission_grants: [], permission_baseline_id: null, is_banned: true },
      ],
    });
    await postEventResults(fake.client as never, EVENT, ACTOR);
    expect(notices[0]!.ids).toEqual(['a1']);
  });

  it('a failed placings read throws, for finalize to hold', async () => {
    const fake = seed();
    fake.failRead.add('tournament_participants');
    await expect(postEventResults(fake.client as never, EVENT, ACTOR)).rejects.toThrow(/placings/);
    expect(fake.tables.announcements ?? []).toHaveLength(0);
  });
});

describe('isMarketingHolder', () => {
  it('a revoke wins over the portfolio', () => {
    expect(isMarketingHolder(officer('m1', { permission_revokes: ['announcements.socialposts.read'] }) as never)).toBe(false);
  });

  it('an officer with neither the grant nor the portfolio is not told, though the floor lets them read', () => {
    expect(isMarketingHolder(officer('m1', { permission_grants: ['announcements.page'], permission_baseline_id: null }) as never)).toBe(false);
  });

  it('a member with no console level is not told', () => {
    expect(isMarketingHolder(officer('m1', { is_exec: false }) as never)).toBe(false);
  });
});

describe('resultsLine', () => {
  it('reads as one line in place order', () => {
    expect(resultsLine('Cup', [{ position: 1, entry_id: 'a' }, { position: 2, entry_id: 'b' }], new Map([['a', 'A'], ['b', 'B']])))
      .toBe('Cup results: 1st A, 2nd B');
  });
});
