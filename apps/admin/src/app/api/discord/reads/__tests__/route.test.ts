import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CONSOLE COMMANDS ON DISCORD: the read route. Same door as the writes, and
 * each read asks the console's own gate for its capability BEFORE any query.
 */

const resolveDiscordActor = vi.fn();
vi.mock('@/lib/discord-actor', async () => {
  const store = await import('@/lib/discord-actor-store');
  return { ...store, resolveDiscordActor: (...a: unknown[]) => resolveDiscordActor(...a) };
});

const state = vi.hoisted(() => ({
  capabilityCalls: [] as { capability: string; actorId: string | undefined }[],
  refusal: null as Error | null,
  queried: [] as string[],
  rows: [] as Record<string, unknown>[],
  // Per-table rows, when a test needs different rows from different tables.
  tables: {} as Record<string, Record<string, unknown>[]>,
  filters: [] as { table: string; method: string; column: string; value: unknown }[],
  readError: null as { message: string } | null,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/supabase-server', async () => {
  const { discordActorStore } = await import('@/lib/discord-actor-store');
  const builder = (table: string) => {
    state.queried.push(table);
    const self: Record<string, unknown> = {};
    const rows = () => state.tables[table] ?? state.rows;
    for (const method of ['select', 'gte', 'order', 'limit']) self[method] = () => self;
    for (const method of ['eq', 'neq', 'in']) {
      self[method] = (column: string, value: unknown) => {
        state.filters.push({ table, method, column, value });
        return self;
      };
    }
    self.maybeSingle = async () => ({ data: rows()[0] ?? null, error: state.readError });
    self.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: state.readError ? null : rows(), error: state.readError, count: 0 });
    return self;
  };
  return {
    createAdminClient: () => ({ from: builder }),
    requireCapability: async (capability: string) => {
      state.capabilityCalls.push({ capability, actorId: discordActorStore.getStore()?.playerId });
      if (state.refusal) throw state.refusal;
      return { id: 'exec-1' };
    },
  };
});

const { GET } = await import('../[name]/route');

const SECRET = 'test-service-secret';
const DISCORD_ID = '123456789012345678';

function call(name: string, query = '', secret: string | null = SECRET) {
  const request = new Request(`https://console.example.invalid/api/discord/reads/${name}${query}`, {
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      'x-discord-user-id': DISCORD_ID,
    },
  });
  return GET(request, { params: Promise.resolve({ name }) });
}

function coded(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = SECRET;
  state.capabilityCalls = [];
  state.refusal = null;
  state.queried = [];
  state.rows = [];
  state.tables = {};
  state.filters = [];
  state.readError = null;
  resolveDiscordActor.mockReset();
  resolveDiscordActor.mockResolvedValue({ playerId: 'exec-1' });
});

describe('GET /api/discord/reads/[name]', () => {
  it('is a 401 without the service secret', async () => {
    const res = await call('sessions', '', null);
    expect(res.status).toBe(401);
    expect(state.queried).toEqual([]);
  });

  it('is a 404 for an unknown read', async () => {
    expect((await call('players')).status).toBe(404);
    expect((await call('__proto__')).status).toBe(404);
  });

  it('names an unlinked caller', async () => {
    resolveDiscordActor.mockResolvedValue('not_linked');
    expect(await (await call('sessions')).json()).toEqual({ ok: false, refusal: 'not_linked' });
  });

  it.each([
    ['sessions', 'sessions.page'],
    ['session-attendance', 'sessions.page'],
    ['locations', 'sessions.page'],
    ['events', 'events.page'],
    ['event-signups', 'events.signups.read'],
    ['tournaments', 'tournaments.page'],
    ['tournament-entries', 'tournaments.page'],
    ['tournament-matches', 'tournaments.page'],
    ['tournament-fees', 'tournaments.fees.read'],
  ])('asks for the capability behind %s, as the linked exec', async (name, capability) => {
    await call(name);
    expect(state.capabilityCalls).toEqual([{ capability, actorId: 'exec-1' }]);
  });

  it('reads nothing when the capability is refused, and says why', async () => {
    state.refusal = coded('Your permissions do not include this. Ask an admin.', 'AUTH-104');
    const res = await call('sessions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Your permissions do not include this. Ask an admin.',
      code: 'AUTH-104',
    });
    expect(state.queried).toEqual([]);
  });

  it('turns the passkey policy refusal into passkey_required', async () => {
    state.refusal = coded('x', 'AUTH-105');
    expect(await (await call('events')).json()).toEqual({ ok: false, refusal: 'passkey_required' });
  });

  it('is a 503 when the read is refused by the database', async () => {
    state.readError = { message: 'boom' };
    expect((await call('sessions')).status).toBe(503);
  });

  it('hands back an edit input the console action takes', async () => {
    state.rows = [
      {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'Club night',
        date: '2026-10-20',
        start_time: '19:00:00',
        end_time: null,
        location: 'Gym',
        notes: null,
        track: 'all',
        status: 'open',
      },
    ];
    const body = await (await call('sessions')).json();
    expect(body.ok).toBe(true);
    expect(body.data.sessions[0].editInput).toEqual({
      name: 'Club night',
      date: '2026-10-20',
      time: '19:00',
      location: 'Gym',
      track: 'all',
    });
  });
});

describe('GET /api/discord/reads/[name]: tournaments', () => {
  const TOURNAMENT = '22222222-3333-4444-8555-666666666666';
  const EVENT = '33333333-4444-4555-8666-777777777777';
  const OTHER_EVENT = '44444444-5555-4666-8777-888888888888';

  beforeEach(() => {
    state.tables = {
      tournament_events: [
        { id: EVENT, event_type: 'mens_singles', status: 'live' },
        { id: OTHER_EVENT, event_type: 'mixed_doubles', status: 'live' },
      ],
      tournament_participants: [
        { id: 'pa', event_id: EVENT, status: 'checked_in', player: { full_name: 'Alex Smith' } },
        { id: 'pb', event_id: EVENT, status: 'registered', player: { full_name: 'Bo Jones' } },
      ],
      tournament_pairs: [
        {
          id: 'pair1',
          event_id: OTHER_EVENT,
          status: 'registered',
          pair_name: null,
          external1_name: null,
          external2_name: null,
          player1: { full_name: 'Cy Lee' },
          player2: [{ full_name: 'Di Wu' }],
        },
      ],
      tournament_matches: [
        {
          id: 'm1',
          event_id: EVENT,
          round_number: 2,
          bracket_position: 2,
          match_number: null,
          match_label: null,
          court: '2',
          status: 'ready',
          is_bye: false,
          participant_a_id: 'pb',
          participant_b_id: 'pa',
          pair_a_id: null,
          pair_b_id: null,
        },
        {
          id: 'bye',
          event_id: EVENT,
          round_number: 1,
          bracket_position: 0,
          match_number: null,
          match_label: null,
          court: null,
          status: 'pending',
          is_bye: true,
          participant_a_id: 'pa',
          participant_b_id: null,
          pair_a_id: null,
          pair_b_id: null,
        },
      ],
    };
  });

  it('answers nothing for a tournament id that is not a uuid, and reads nothing', async () => {
    for (const name of ['tournament-entries', 'tournament-matches', 'tournament-fees']) {
      const body = await (await call(name, '?tournamentId=nope')).json();
      expect(body.ok).toBe(true);
      expect(Object.values(body.data)).toEqual([[]]);
    }
    expect(state.queried).toEqual([]);
  });

  it('scopes entries to the tournament through its event ids', async () => {
    const body = await (await call('tournament-entries', `?tournamentId=${TOURNAMENT}`)).json();
    expect(state.filters).toContainEqual({ table: 'tournament_events', method: 'eq', column: 'tournament_id', value: TOURNAMENT });
    expect(state.filters).toContainEqual({
      table: 'tournament_participants',
      method: 'in',
      column: 'event_id',
      value: [EVENT, OTHER_EVENT],
    });
    expect(state.filters).toContainEqual({ table: 'tournament_pairs', method: 'in', column: 'event_id', value: [EVENT, OTHER_EVENT] });
    expect(body.data.entries).toEqual([
      { value: 'p:pa', label: "Alex Smith · Men's Singles · checked in" },
      { value: 'p:pb', label: "Bo Jones · Men's Singles · registered" },
      { value: 'pr:pair1', label: 'Cy Lee & Di Wu · Mixed Doubles · registered' },
    ]);
  });

  it('labels a match with side A first, and leaves byes out', async () => {
    const body = await (await call('tournament-matches', `?tournamentId=${TOURNAMENT}`)).json();
    expect(body.data.matches).toEqual([
      {
        id: 'm1',
        label: "Men's Singles R2 #3: Bo Jones v Alex Smith · ready · Court 2",
        sideA: 'Bo Jones',
        sideB: 'Alex Smith',
        status: 'ready',
      },
    ]);
    expect(state.filters).toContainEqual({
      table: 'tournament_matches',
      method: 'in',
      column: 'status',
      value: ['pending', 'ready', 'live'],
    });
  });

  it('never offers more than 25 choices, each at most 100 characters', async () => {
    state.tables.tournament_participants = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`,
      event_id: EVENT,
      status: 'registered',
      player: { full_name: `Member ${i} ${'x'.repeat(120)}` },
    }));
    const body = await (await call('tournament-entries', `?tournamentId=${TOURNAMENT}`)).json();
    expect(body.data.entries).toHaveLength(25);
    for (const entry of body.data.entries) expect(entry.label.length).toBeLessThanOrEqual(100);
  });

  it('lists entrants with their entry-fee state', async () => {
    state.tables.tournament_participants = [{ player_id: 'player-a' }];
    state.tables.tournament_pairs = [{ player1_id: 'player-b', player2_id: null }];
    state.tables.club_fees = [{ player_id: 'player-a', amount_cents: 1500, paid_at: '2026-10-01T00:00:00Z', method: 'etransfer' }];
    state.tables.players = [
      { id: 'player-a', full_name: 'Alex Smith' },
      { id: 'player-b', full_name: 'Bo Jones' },
    ];
    const body = await (await call('tournament-fees', `?tournamentId=${TOURNAMENT}`)).json();
    expect(body.data.fees).toEqual([
      { playerId: 'player-a', label: 'Alex Smith · Paid $15.00 etransfer', paid: true },
      { playerId: 'player-b', label: 'Bo Jones · No fee recorded', paid: false },
    ]);
    expect(state.filters).toContainEqual({ table: 'club_fees', method: 'eq', column: 'fee_type', value: 'tournament' });
  });
});
