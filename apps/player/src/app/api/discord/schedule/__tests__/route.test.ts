import { describe, it, expect, vi, beforeEach } from 'vitest';

// /schedule on Discord: the caller's own next two weeks. The stub records every
// filter so the tests pin WHO the rows are scoped to and WHEN the feed link is
// minted, which is what this route exists to get right.

interface Recorded {
  table: string;
  calls: [string, unknown[]][];
}

const state = vi.hoisted(() => ({
  link: null as { players: Record<string, unknown> } | null,
  linkError: null as { message: string } | null,
  rows: {} as Record<string, unknown[]>,
  errors: {} as Record<string, { message: string } | null>,
  flags: { sessions: true, events: true, tournaments: true } as Record<string, boolean>,
  recorded: [] as Recorded[],
  tokenCalls: 0,
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === 'player_discord_links') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.link, error: state.linkError }) }),
          }),
        };
      }
      const recorded: Recorded = { table, calls: [] };
      state.recorded.push(recorded);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'gte', 'lte', 'lt', 'in', 'is', 'or', 'order', 'limit']) {
        builder[method] = (...args: unknown[]) => {
          recorded.calls.push([method, args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: state.errors[table] ? null : state.rows[table] ?? [], error: state.errors[table] ?? null });
      return builder;
    },
  }),
}));

vi.mock('@/lib/calendar-feed-token', () => ({
  getOrCreateCalendarFeedToken: async () => {
    state.tokenCalls += 1;
    return 'a'.repeat(48);
  },
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

vi.mock('@badminton/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@badminton/shared')>();
  return {
    ...actual,
    clubToday: () => '2026-10-19',
    readFeatureFlags: async () => ({ ...actual.DEFAULT_FEATURE_FLAGS, ...state.flags }),
  };
});

const MEMBER = {
  id: 'p1',
  user_id: 'u1',
  role: 'player',
  is_exec: false,
  status: 'recreational',
  active_flag: true,
  is_banned: false,
};

function req(discordUserId: string | null = '424242424242', secret = 'test-secret') {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (discordUserId) headers['x-discord-user-id'] = discordUserId;
  return new Request('http://localhost/api/discord/schedule', { headers });
}

async function call(discordUserId?: string | null) {
  const { GET } = await import('../route');
  const response = await GET(req(discordUserId === undefined ? '424242424242' : discordUserId));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function callsOn(table: string) {
  return state.recorded.find((r) => r.table === table)?.calls ?? [];
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  process.env.NEXT_PUBLIC_PLAYER_URL = 'https://club.example.invalid/';
  state.link = { players: { ...MEMBER } };
  state.linkError = null;
  state.rows = {};
  state.errors = {};
  state.flags = { sessions: true, events: true, tournaments: true };
  state.recorded = [];
  state.tokenCalls = 0;
});

describe('GET /api/discord/schedule', () => {
  it('refuses without the service secret', async () => {
    const { GET } = await import('../route');
    expect((await GET(req('424242424242', 'wrong'))).status).toBe(401);
  });

  it('needs the caller header', async () => {
    expect((await call(null)).status).toBe(400);
  });

  it('answers linked:false for an unlinked caller and reads nothing else', async () => {
    state.link = null;
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toEqual({ linked: false });
    expect(state.recorded).toEqual([]);
  });

  it('is a 503, never "not linked", when the link read fails', async () => {
    state.linkError = { message: 'boom' };
    expect((await call()).status).toBe(503);
  });

  it('scopes sessions to the member track and the two-week window', async () => {
    await call();
    const sessionCalls = callsOn('sessions');
    expect(sessionCalls).toContainEqual(['in', ['track', ['recreational', 'all']]]);
    expect(sessionCalls).toContainEqual(['eq', ['status', 'open']]);
    expect(sessionCalls).toContainEqual(['gte', ['date', '2026-10-19']]);
    expect(sessionCalls).toContainEqual(['lte', ['date', '2026-11-01']]);
  });

  it('reads published club events and published, unsuspended tournaments only', async () => {
    await call();
    expect(callsOn('club_events')).toContainEqual(['eq', ['status', 'published']]);
    expect(callsOn('tournaments')).toContainEqual(['in', ['status', ['active', 'completed']]]);
    expect(callsOn('tournaments')).toContainEqual(['is', ['suspended_at', null]]);
  });

  it('skips the reads of a switched-off feature', async () => {
    state.flags = { sessions: true, events: false, tournaments: false };
    await call();
    expect(state.recorded.map((r) => r.table)).toEqual(['sessions']);
  });

  it('is a 503 when a schedule read is refused', async () => {
    state.errors.club_events = { message: 'permission denied' };
    expect((await call()).status).toBe(503);
  });

  it('groups lines by club day, all-day tournaments first', async () => {
    state.rows.sessions = [
      { id: 's1', name: 'Club night', date: '2026-10-20', start_time: '19:00:00', location: 'Main gym' },
    ];
    state.rows.club_events = [{ id: 'e1', title: 'Pub night', location: null, starts_at: '2026-10-21T04:00:00Z' }];
    state.rows.tournaments = [{ id: 't1', name: 'Fall Open', start_date: '2026-10-20', end_date: null }];
    const { body } = await call();
    expect(body.days).toEqual([
      { label: 'Tomorrow, 20 Oct', items: ['All day · Fall Open (tournament)', '7:00 PM · Club night · Main gym', '9:00 PM · Pub night'] },
    ]);
  });

  it('mints the feed link for a member in good standing', async () => {
    const { body } = await call();
    expect(state.tokenCalls).toBe(1);
    expect(body.feed).toEqual({
      https: `https://club.example.invalid/api/calendar/${'a'.repeat(48)}`,
      webcal: `webcal://club.example.invalid/api/calendar/${'a'.repeat(48)}`,
    });
    expect(body.calendarUrl).toBe('https://club.example.invalid/calendar');
  });

  it('withholds the feed link, and mints no token, for a suspended member', async () => {
    state.link = { players: { ...MEMBER, status: 'suspended' } };
    const { body } = await call();
    expect(body.feed).toBeNull();
    expect(state.tokenCalls).toBe(0);
  });
});
