import { describe, it, expect, vi, beforeEach } from 'vitest';

// /tournaments next: the caller's own next match. Only the link is resolved
// (it reads, it writes nothing), and the order is on court, waiting to be
// called, scheduled with both sides known, then the earliest round.

const db = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  errors: {} as Record<string, { message: string } | undefined>,
  selects: [] as { table: string; columns: string }[],
  filters: [] as { table: string; method: string; args: unknown[] }[],
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      let columns = '';
      // Rows keyed `table|columns` answer that one select; plain `table` answers the rest.
      const rowsFor = () => db.rows[`${table}|${columns}`] ?? db.rows[table] ?? null;
      const result = () => ({ data: db.errors[table] ? null : rowsFor(), error: db.errors[table] ?? null });
      chain.select = (c: string) => {
        columns = c;
        db.selects.push({ table, columns: c });
        return chain;
      };
      for (const m of ['eq', 'in', 'or', 'not', 'gte', 'order', 'limit', 'neq', 'is']) {
        chain[m] = (...args: unknown[]) => {
          db.filters.push({ table, method: m, args });
          return chain;
        };
      }
      chain.maybeSingle = () => Promise.resolve(result());
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return chain;
    },
  }),
}));

let member: { ok: true; player: { id: string } } | { ok: false; refusal: string } = { ok: true, player: { id: 'me' } };
vi.mock('@/lib/discord-member', () => ({ resolveDiscordMember: vi.fn(async () => member) }));

const { GET } = await import('../route');

async function next(callerId = '111111') {
  const res = await GET(
    new Request('http://localhost/api/discord/tournament-next', {
      headers: { authorization: 'Bearer test-secret', 'x-discord-user-id': callerId },
    }),
  );
  return { status: res.status, body: await res.json() };
}

function match(over: Record<string, unknown>) {
  return {
    id: 'm', event_id: 'e1', round_number: 1, bracket_position: 0, round_name: null, court: null,
    scheduled_time: null, status: 'pending', scores: null, is_bye: false, phase: null,
    participant_a_id: null, participant_b_id: null, pair_a_id: null, pair_b_id: null,
    winner_participant_id: null, winner_pair_id: null, ...over,
  };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  member = { ok: true, player: { id: 'me' } };
  db.selects = [];
  db.filters = [];
  db.errors = {};
  db.rows = {
    platform_settings: null,
    tournament_participants: [
      { id: 'mine', event_id: 'e1', status: 'checked_in', player: { full_name: 'Me Myself' } },
      { id: 'them', event_id: 'e1', status: 'checked_in', player: { full_name: 'Bo Jones' } },
    ],
    // The caller's own entry rows; the plain key above is the names read.
    'tournament_participants|id, event_id, status': [{ id: 'mine', event_id: 'e1', status: 'checked_in' }],
    'tournament_pairs|id, event_id, status': [],
    tournament_pairs: [],
    tournament_events: [
      { id: 'e1', event_type: 'mens_singles', tournament: { id: 't1', name: 'Autumn Classic', status: 'active', suspended_at: null, suspension_reason: null } },
    ],
    tournament_matches: [
      match({ id: 'later', round_number: 2, participant_a_id: 'mine', participant_b_id: null }),
      match({ id: 'call', status: 'ready', court: '3', participant_a_id: 'them', participant_b_id: 'mine' }),
      match({ id: 'other', status: 'live', participant_a_id: 'x', participant_b_id: 'y' }),
    ],
  };
});

describe('GET /api/discord/tournament-next', () => {
  it('says so for an unlinked caller', async () => {
    member = { ok: false, refusal: 'not_linked' };
    expect((await next()).body).toEqual({ linked: false });
  });

  it('is a 503 when the caller cannot be read', async () => {
    member = { ok: false, refusal: 'unavailable' };
    expect((await next()).status).toBe(503);
  });

  it("picks the caller's match that is waiting to be called over a later one", async () => {
    const { body } = await next();
    expect(body.linked).toBe(true);
    expect(body.match).toMatchObject({
      tournament: 'Autumn Classic',
      event: "Men's Singles",
      opponents: 'Bo Jones',
      status: 'ready',
      court: '3',
      suspended: null,
    });
  });

  it('has nothing when the caller has withdrawn', async () => {
    db.rows['tournament_participants|id, event_id, status'] = [{ id: 'mine', event_id: 'e1', status: 'withdrawn' }];
    expect((await next()).body).toEqual({ linked: true, match: null });
  });

  it('ignores tournaments that are not active', async () => {
    (db.rows.tournament_events as { tournament: { status: string } }[])[0]!.tournament.status = 'completed';
    expect((await next()).body).toEqual({ linked: true, match: null });
  });

  it('never selects * or notes', async () => {
    await next();
    for (const { columns } of db.selects) {
      expect(columns).not.toMatch(/\*/);
      expect(columns).not.toMatch(/\bnotes\b/);
    }
  });
});
