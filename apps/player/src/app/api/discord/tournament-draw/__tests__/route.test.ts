import { describe, it, expect, vi, beforeEach } from 'vitest';

// /tournaments draw. The rows are the event page's own reads, column for
// column, and they run with the service role, so the one thing that must never
// happen is `*` or `notes`: those columns still hold an exec's private reasons
// (00117/00118). Every select string is recorded and checked for both.

const EVENT_ID = '11111111-2222-4333-8444-555555555555';

const db = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  errors: {} as Record<string, { code?: string; message: string } | undefined>,
  selects: [] as { table: string; columns: string }[],
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      let columns = '';
      const chain: Record<string, unknown> = {};
      const result = () => {
        const key = table === 'tournament_matches' && columns.includes('stage') ? 'tournament_matches:staged' : table;
        return { data: db.errors[key] ? null : db.rows[key] ?? null, error: db.errors[key] ?? null };
      };
      chain.select = (c: string) => {
        columns = c;
        db.selects.push({ table, columns: c });
        return chain;
      };
      for (const m of ['eq', 'in', 'or', 'not', 'gte', 'order', 'limit', 'neq', 'is']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve(result());
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return chain;
    },
  }),
}));

const { GET } = await import('../route');

function get(eventId = EVENT_ID, auth = 'Bearer test-secret') {
  return GET(
    new Request(`http://localhost/api/discord/tournament-draw?eventId=${eventId}`, {
      headers: { authorization: auth },
    }),
  );
}

function match(over: Record<string, unknown>) {
  return {
    id: 'm',
    round_number: 1,
    bracket_position: 0,
    round_name: null,
    court: null,
    status: 'pending',
    scores: null,
    is_bye: false,
    phase: null,
    participant_a_id: null,
    participant_b_id: null,
    pair_a_id: null,
    pair_b_id: null,
    winner_participant_id: null,
    winner_pair_id: null,
    ...over,
  };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  process.env.NEXT_PUBLIC_PLAYER_URL = 'https://club.example.invalid';
  db.selects = [];
  db.errors = {};
  db.rows = {
    platform_settings: null,
    tournament_events: {
      id: EVENT_ID,
      tournament_id: 't1',
      event_type: 'mens_singles',
      status: 'live',
      format: 'single_elimination',
      tournament: { id: 't1', name: 'Autumn Classic', status: 'active', suspended_at: null, suspension_reason: null },
    },
    tournament_participants: [
      { id: 'pa', player: { full_name: 'Alex Smith' } },
      { id: 'pb', player: { full_name: 'Bo Jones' } },
      { id: 'pc', player: { full_name: 'Cy Lee' } },
    ],
    tournament_matches: [
      match({
        id: 'm1',
        round_name: 'Semi-finals',
        bracket_position: 2,
        status: 'completed',
        scores: [{ a: 21, b: 15 }, { a: 21, b: 18 }],
        participant_a_id: 'pa',
        participant_b_id: 'pb',
        winner_participant_id: 'pa',
      }),
      match({ id: 'bye', round_name: 'Semi-finals', is_bye: true, participant_a_id: 'pc' }),
      match({
        id: 'm2',
        round_number: 2,
        round_name: 'Final',
        status: 'ready',
        court: '2',
        participant_a_id: 'pc',
        participant_b_id: 'pa',
      }),
    ],
  };
});

describe('GET /api/discord/tournament-draw', () => {
  it('is a 401 without the service secret', async () => {
    expect((await get(EVENT_ID, 'Bearer nope')).status).toBe(401);
  });

  it('renders the knockout side A first, a section per round, without byes', async () => {
    const body = await (await get()).json();
    expect(body.found).toBe(true);
    expect(body.tournament).toEqual({ id: 't1', name: 'Autumn Classic' });
    expect(body.url).toBe(`https://club.example.invalid/tournaments/t1/events/${EVENT_ID}`);
    expect(body.sections).toEqual([
      { title: 'Semi-finals', lines: ['R1 #3 Alex Smith 21-15 21-18 Bo Jones'] },
      { title: 'Final', lines: ['R2 #1 Cy Lee v Alex Smith · waiting to be called · Court 2'] },
    ]);
    expect(body.truncated).toBe(false);
  });

  it('renders a round robin as standings', async () => {
    (db.rows.tournament_events as Record<string, unknown>).format = 'round_robin';
    db.rows.tournament_matches = [
      match({ id: 'r1', status: 'completed', participant_a_id: 'pa', participant_b_id: 'pb', winner_participant_id: 'pb' }),
      match({ id: 'r2', status: 'completed', participant_a_id: 'pb', participant_b_id: 'pc', winner_participant_id: 'pb' }),
      match({ id: 'r3', status: 'ready', participant_a_id: 'pa', participant_b_id: 'pc' }),
    ];
    const body = await (await get()).json();
    expect(body.sections).toEqual([
      { title: 'Round robin', lines: ['1. Bo Jones 2-0', '2. Alex Smith 0-1', '3. Cy Lee 0-1'] },
    ]);
  });

  it('never selects * or notes from any table', async () => {
    await get();
    (db.rows.tournament_events as Record<string, unknown>).format = 'staged';
    await get();
    expect(db.selects.length).toBeGreaterThan(0);
    for (const { table, columns } of db.selects) {
      expect(columns, table).not.toMatch(/\*/);
      expect(columns, table).not.toMatch(/\bnotes\b/);
    }
  });

  it('falls back to the older column list on a database without the stage columns', async () => {
    (db.rows.tournament_events as Record<string, unknown>).format = 'staged';
    db.errors['tournament_matches:staged'] = { code: '42703', message: 'column does not exist' };
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).found).toBe(true);
  });

  it('does not find an event in a draft tournament', async () => {
    (db.rows.tournament_events as { tournament: { status: string } }).tournament.status = 'draft';
    expect(await (await get()).json()).toEqual({ found: false });
  });

  it('does not find anything while tournaments are switched off', async () => {
    db.rows.platform_settings = { value: { tournaments_enabled: false } };
    expect(await (await get()).json()).toEqual({ found: false });
  });

  it('is a 503 when the matches cannot be read', async () => {
    db.errors.tournament_matches = { message: 'boom' };
    expect((await get()).status).toBe(503);
  });

  it('says when the tournament is suspended', async () => {
    (db.rows.tournament_events as { tournament: Record<string, unknown> }).tournament.suspended_at = '2026-10-10T00:00:00Z';
    (db.rows.tournament_events as { tournament: Record<string, unknown> }).tournament.suspension_reason = 'Fire alarm';
    expect((await (await get()).json()).suspended).toEqual({ reason: 'Fire alarm' });
  });
});
