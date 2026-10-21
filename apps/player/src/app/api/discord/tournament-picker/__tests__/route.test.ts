import { describe, it, expect, vi, beforeEach } from 'vitest';

// The /tournaments pickers: active tournaments by name, a tournament's events,
// and with open=1 only the events taking entries. Never a draft's events, at
// most 25 choices, every label at most 100 characters.

const T1 = '22222222-3333-4444-8555-666666666666';
const WINDOWS = 'id, registration_opens_at, registration_closes_at, checkin_opens_at, checkin_closes_at';

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

async function pick(query: string) {
  const res = await GET(
    new Request(`http://localhost/api/discord/tournament-picker${query}`, {
      headers: { authorization: 'Bearer test-secret' },
    }),
  );
  return (await res.json()) as { choices: { id: string; label: string }[] };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  db.selects = [];
  db.filters = [];
  db.errors = {};
  db.rows = {
    platform_settings: null,
    tournaments: [
      { id: T1, name: 'Autumn Classic', start_date: '2026-10-20' },
      { id: 't2', name: 'Winter Open', start_date: '2026-12-01' },
    ],
    tournament_events: [
      { id: 'e1', event_type: 'mens_singles', status: 'registration' },
      { id: 'e2', event_type: 'mixed_doubles', status: 'live' },
    ],
  };
});

describe('GET /api/discord/tournament-picker', () => {
  it('lists active and completed tournaments, never drafts, filtered by what was typed', async () => {
    const { choices } = await pick('?q=autumn');
    expect(choices.map((c) => c.id)).toEqual([T1]);
    expect(choices[0]?.label).toContain('Autumn Classic');
    expect(db.filters).toContainEqual({ table: 'tournaments', method: 'in', args: ['status', ['active', 'completed']] });
  });

  it("lists one tournament's events", async () => {
    db.rows.tournaments = { id: T1, status: 'active' };
    const { choices } = await pick(`?tournamentId=${T1}&q=`);
    expect(choices).toEqual([
      { id: 'e1', label: "Men's Singles" },
      { id: 'e2', label: 'Mixed Doubles' },
    ]);
  });

  it('with open=1 lists only the events taking entries', async () => {
    db.rows.tournaments = { id: T1, status: 'active' };
    // The windows read (00276): none set, so registration status alone decides.
    db.rows[`tournaments|${WINDOWS}`] = [];
    db.rows[`tournament_events|${WINDOWS}`] = [];
    const { choices } = await pick(`?tournamentId=${T1}&open=1`);
    expect(choices.map((c) => c.id)).toEqual(['e1']);
  });

  it("never lists a draft's events", async () => {
    db.rows.tournaments = { id: T1, status: 'draft' };
    expect((await pick(`?tournamentId=${T1}`)).choices).toEqual([]);
  });

  it('answers nothing for a tournament id that is not a uuid', async () => {
    expect((await pick('?tournamentId=nope')).choices).toEqual([]);
  });

  it('offers at most 25 choices, each at most 100 characters', async () => {
    db.rows.tournaments = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      name: `Tournament ${i} ${'x'.repeat(120)}`,
      start_date: '2026-10-20',
    }));
    const { choices } = await pick('?q=');
    expect(choices).toHaveLength(25);
    for (const c of choices) expect(c.label.length).toBeLessThanOrEqual(100);
  });

  it('answers nothing while tournaments are switched off', async () => {
    db.rows.platform_settings = { value: { tournaments_enabled: false } };
    expect((await pick('?q=')).choices).toEqual([]);
  });

  it('never selects * or notes', async () => {
    db.rows.tournaments = { id: T1, status: 'active' };
    db.rows[`tournaments|${WINDOWS}`] = [];
    db.rows[`tournament_events|${WINDOWS}`] = [];
    await pick(`?tournamentId=${T1}&open=1`);
    for (const { columns } of db.selects) {
      expect(columns).not.toMatch(/\*/);
      expect(columns).not.toMatch(/\bnotes\b/);
    }
  });
});
