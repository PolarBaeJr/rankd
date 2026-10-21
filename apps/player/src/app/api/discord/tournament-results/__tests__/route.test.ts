import { describe, it, expect, vi, beforeEach } from 'vitest';

// /tournaments results: what is on court in one tournament and its latest
// results, as lines side A first. A draft is not found.

const T1 = '22222222-3333-4444-8555-666666666666';

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

const { GET } = await import('../route');

async function results(tournamentId = T1) {
  const res = await GET(
    new Request(`http://localhost/api/discord/tournament-results?tournamentId=${tournamentId}`, {
      headers: { authorization: 'Bearer test-secret' },
    }),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  db.selects = [];
  db.filters = [];
  db.errors = {};
  db.rows = {
    platform_settings: null,
    tournaments: { id: T1, name: 'Autumn Classic', status: 'active', suspended_at: null, suspension_reason: null },
    tournament_events: [{ id: 'e1', event_type: 'mens_singles' }],
    tournament_participants: [
      { id: 'pa', player: { full_name: 'Alex Smith' } },
      { id: 'pb', player: { full_name: 'Bo Jones' } },
    ],
    tournament_pairs: [],
    tournament_matches: [
      {
        id: 'm1', event_id: 'e1', round_number: 1, bracket_position: 0, round_name: null, court: null,
        status: 'completed', scores: [{ a: 21, b: 15 }], is_bye: false, phase: null,
        participant_a_id: 'pa', participant_b_id: 'pb', pair_a_id: null, pair_b_id: null,
        winner_participant_id: 'pa', winner_pair_id: null,
      },
    ],
  };
});

describe('GET /api/discord/tournament-results', () => {
  it('renders results as lines, side A first, scoped to the tournament', async () => {
    const { body } = await results();
    expect(body.found).toBe(true);
    expect(body.recent).toEqual(["Men's Singles R1 #1 Alex Smith 21-15 Bo Jones"]);
    expect(db.filters).toContainEqual({ table: 'tournament_matches', method: 'in', args: ['event_id', ['e1']] });
    expect(db.filters).toContainEqual({
      table: 'tournament_matches',
      method: 'order',
      args: ['result_entered_at', { ascending: false, nullsFirst: false }],
    });
  });

  it('does not find a draft', async () => {
    (db.rows.tournaments as Record<string, unknown>).status = 'draft';
    expect((await results()).body).toEqual({ found: false });
  });

  it('is a 503 when the matches cannot be read', async () => {
    db.errors.tournament_matches = { message: 'boom' };
    expect((await results()).status).toBe(503);
  });

  it('never selects * or notes', async () => {
    await results();
    for (const { columns } of db.selects) {
      expect(columns).not.toMatch(/\*/);
      expect(columns).not.toMatch(/\bnotes\b/);
    }
  });
});
