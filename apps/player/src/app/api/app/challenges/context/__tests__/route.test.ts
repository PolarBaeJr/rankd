import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WHAT THE NATIVE APP'S CHALLENGES SCREENS ARE TOLD, and that it is the same
 * answer the website's pages reach.
 *
 * standing and feature pass straight through from getAccountStanding and
 * featureGate; the opponent list is the web's server-side one, handed out only
 * where the web would render the form (good standing, feature on); a session
 * with no player row is a 403.
 */

const resolveAppActor = vi.fn();
vi.mock('@/lib/app-actor', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/app-actor')>();
  return { ...real, resolveAppActor: (r: Request) => resolveAppActor(r) };
});

let player: Record<string, unknown> | null = null;
vi.mock('@/lib/supabase-server', () => ({ getCurrentPlayer: async () => player }));

let challengesOn = true;
vi.mock('@/lib/feature-gate', () => ({ getFeatureFlags: async () => ({ challenges: challengesOn }) }));

vi.mock('@/lib/challenge-settings', () => ({
  getChallengeRules: async () => ({ maxActive: 3, expiryHours: 72, eloRange: 9999, ladderRange: 50 }),
}));

const listChallengeableOpponents = vi.fn();
vi.mock('@/lib/challengeable-opponents', () => ({
  listChallengeableOpponents: (id: string) => listChallengeableOpponents(id),
}));

const countQuery: [string, unknown][] = [];
const actorClient = {
  from: (table: string) => {
    countQuery.push(['from', table]);
    const api = {
      select: (cols: string, opts: unknown) => { countQuery.push(['select', [cols, opts]]); return api; },
      eq: (c: string, v: unknown) => { countQuery.push(['eq', [c, v]]); return api; },
      in: (c: string, v: unknown) => { countQuery.push(['in', [c, v]]); return Promise.resolve({ count: 2, error: null }); },
    };
    return api;
  },
};

const { GET } = await import('../route');

const ME = { id: 'player-1', status: 'recreational', is_banned: false, active_flag: true };
const OTHER = { id: 'player-2', full_name: 'Another Member', handle: null, singles_elo: null, doubles_elo: 410 };

function get() {
  return GET(new Request('https://site.example.invalid/api/app/challenges/context', {
    headers: { Authorization: 'Bearer t' },
  }));
}

beforeEach(() => {
  player = { ...ME };
  challengesOn = true;
  countQuery.length = 0;
  resolveAppActor.mockReset();
  resolveAppActor.mockResolvedValue({ user: { id: 'user-1' }, supabase: actorClient });
  listChallengeableOpponents.mockReset();
  listChallengeableOpponents.mockResolvedValue([OTHER]);
});

describe('GET /api/app/challenges/context', () => {
  it('is a 401 with no bearer', async () => {
    resolveAppActor.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });

  it('is a 403 for a session with no player row', async () => {
    player = null;
    const res = await get();
    expect(res.status).toBe(403);
    expect(listChallengeableOpponents).not.toHaveBeenCalled();
  });

  it('answers with standing, feature, rules, quota and the opponents, self excluded', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({
      playerId: 'player-1',
      standing: { ok: true, detail: '' },
      feature: 'on',
      featureMessage: null,
      rules: { maxActive: 3, expiryHours: 72, eloRange: 9999, ladderRange: 50 },
      quota: { used: 2, max: 3, full: false, ratio: 2 / 3 },
      opponents: [OTHER],
    });
    expect(listChallengeableOpponents).toHaveBeenCalledWith('player-1');
    // The /challenges page's own count, on the member's client.
    expect(countQuery).toEqual([
      ['from', 'challenges'],
      ['select', ['id', { count: 'exact', head: true }]],
      ['eq', ['created_by', 'player-1']],
      ['in', ['status', ['proposed', 'partially_confirmed', 'accepted']]],
    ]);
  });

  it('passes a bad standing through with its detail, and hands out no opponents', async () => {
    player = { ...ME, is_banned: true, ban_reason: 'no-shows' };
    const body = await (await get()).json();
    expect(body.standing.ok).toBe(false);
    expect(body.standing.detail).toContain('no-shows');
    expect(body.opponents).toEqual([]);
    expect(listChallengeableOpponents).not.toHaveBeenCalled();
  });

  it('says the feature is off, with the web sentence, and hands out no opponents', async () => {
    challengesOn = false;
    const body = await (await get()).json();
    expect(body.feature).toBe('off');
    expect(body.featureMessage).toMatch(/switched .* off/);
    expect(body.opponents).toEqual([]);
  });
});
