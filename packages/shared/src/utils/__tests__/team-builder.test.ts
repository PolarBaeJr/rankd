import { describe, it, expect } from 'vitest';
import {
  planTeams,
  planningRatings,
  previewFromPlan,
  rerollUnlocked,
  swapMembers,
  toggleLock,
  type TeamCandidate,
} from '../team-builder';
import { planAutoPairs } from '../doubles-pool';

const person = (playerId: string, rating: number | null, extra: Partial<TeamCandidate> = {}): TeamCandidate => ({ playerId, rating, ...extra });
const pool = [person('a', 1600), person('b', 1500), person('c', 1400), person('d', 1300), person('e', 1200), person('f', 1100)];
const sums = (pairs: Array<[string, string]>, ratings: Map<string, number>) => pairs.map(([x, y]) => ratings.get(x)! + ratings.get(y)!);
const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('planTeams', () => {
  it('keeps mutual requests first when both are in the pool and allowed', () => {
    const plan = planTeams({ candidates: pool, mode: 'balanced', mutual: [['a', 'b'], ['c', 'zz']] });
    expect(plan.pairs[0]).toEqual(['a', 'b']);
    expect(plan.pairs.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('balanced is the Auto pair fold, and its spread of team sums is no wider', () => {
    const plan = planTeams({ candidates: pool, mode: 'balanced' });
    expect(plan.pairs).toEqual(planAutoPairs(pool.map((p) => ({ playerId: p.playerId, rating: p.rating! }))).pairs);
    const ratings = planningRatings(pool);
    const naive: Array<[string, string]> = [['a', 'b'], ['c', 'd'], ['e', 'f']];
    expect(spread(sums(plan.pairs, ratings))).toBeLessThanOrEqual(spread(sums(naive, ratings)));
  });

  it('similar pairs neighbours by rating', () => {
    expect(planTeams({ candidates: [...pool].reverse(), mode: 'similar' }).pairs).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
  });

  it('random is reproducible from its seed and covers everybody', () => {
    const one = planTeams({ candidates: pool, mode: 'random', rng: seeded(7) });
    const two = planTeams({ candidates: [...pool].reverse(), mode: 'random', rng: seeded(7) });
    expect(one).toEqual(two);
    expect(one.pairs.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(() => planTeams({ candidates: pool, mode: 'random' })).toThrow();
  });

  it('an odd count leaves one person', () => {
    for (const mode of ['balanced', 'similar'] as const) {
      const plan = planTeams({ candidates: pool.slice(0, 5), mode });
      expect(plan.pairs).toHaveLength(2);
      expect(plan.leftOver).not.toBeNull();
    }
  });

  it('honours the avoid hook in every mode', () => {
    const avoid = (x: string, y: string) => [x, y].sort().join() === 'a,f' || [x, y].sort().join() === 'a,b';
    for (const mode of ['balanced', 'similar', 'random'] as const) {
      const plan = planTeams({ candidates: pool, mode, avoid, rng: seeded(3), mutual: [['a', 'b']] });
      for (const [x, y] of plan.pairs) expect(avoid(x, y), `${mode} ${x} ${y}`).toBe(false);
    }
  });

  it('honours the event rule, naming who has nobody', () => {
    const mixed = [person('m1', 1500, { category: 'mens' }), person('m2', 1400, { category: 'mens' }), person('m3', 1350, { category: 'mens' }), person('w1', 1300, { category: 'womens' })];
    const plan = planTeams({ candidates: mixed, mode: 'similar', eligible: (a, b) => a.category !== b.category });
    expect(plan.pairs).toEqual([['m1', 'w1']]);
    expect(plan.unpairable).toEqual(['m2', 'm3']);
    expect(plan.leftOver).toBeNull();
  });

  it('a provisional or missing rating plans at the established median', () => {
    const ratings = planningRatings([person('a', 1000), person('b', 1400), person('c', 1200), person('n', null), person('p', 2000, { provisional: true })]);
    expect(ratings.get('n')).toBe(1200);
    expect(ratings.get('p')).toBe(1200);
    expect(planningRatings([person('n', null)]).get('n')).toBe(400);
  });
});

describe('the preview', () => {
  const base = previewFromPlan(planTeams({ candidates: pool.slice(0, 5), mode: 'similar' }));

  it('is pure: every operation returns a new preview', () => {
    const snapshot = JSON.stringify(base);
    toggleLock(base, 0);
    swapMembers(base, 'a', 'c');
    rerollUnlocked(base, pool, { mode: 'similar' });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('swaps between teams and with the leftover, never inside a locked team', () => {
    expect(swapMembers(base, 'b', 'c').teams.slice(0, 2)).toEqual([{ a: 'a', b: 'c', locked: false }, { a: 'b', b: 'd', locked: false }]);
    expect(swapMembers(base, 'a', 'e').leftOver).toEqual(['a']);
    const locked = toggleLock(base, 0);
    expect(swapMembers(locked, 'a', 'c')).toBe(locked);
  });

  it('mutual requests start locked, and a swap or re-roll leaves them be', () => {
    const mutual: Array<[string, string]> = [['d', 'a']];
    const preview = previewFromPlan(planTeams({ candidates: pool, mode: 'similar', mutual }), { locked: mutual });
    expect(preview.teams[0]).toEqual({ a: 'd', b: 'a', locked: true });
    expect(preview.teams.slice(1).every((team) => !team.locked)).toBe(true);
    expect(swapMembers(preview, 'a', 'b')).toBe(preview);
    const rolled = rerollUnlocked(preview, pool, { mode: 'random', rng: seeded(5) });
    expect(rolled.teams[0]).toEqual({ a: 'd', b: 'a', locked: true });
    expect(rolled.teams.slice(1).flatMap((team) => [team.a, team.b]).sort()).toEqual(['b', 'c', 'e', 'f']);
  });

  it('a re-roll keeps locked teams exactly', () => {
    const locked = toggleLock(base, 1);
    const rolled = rerollUnlocked(locked, pool.slice(0, 5), { mode: 'random', rng: seeded(11) });
    expect(rolled.teams[0]).toEqual(locked.teams[1]);
    expect([...rolled.teams.flatMap((t) => [t.a, t.b]), ...rolled.leftOver].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
