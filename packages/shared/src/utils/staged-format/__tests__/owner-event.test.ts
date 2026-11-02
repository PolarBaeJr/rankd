import { describe, expect, it } from 'vitest';
import { isLegalGame } from '../../game-rules';
import {
  finalPlacings,
  formatConfigSchema,
  groupTable,
  groupsThenTopKnockout,
  headStartFor,
  legacyFormatDefinition,
  planStageGroups,
  pointsFor,
  poolsPlayoffThenPlacement,
  poolsThenPlacement,
  poolsThenSemisFinal,
  reseededEntrants,
  resolveSlots,
  resolveStageMatches,
  scheduleStage,
  slotRefLabel,
  stageMatchRules,
  stageReady,
  suggestCategory,
  categoryForEventType,
  pickCategory,
  defaultCategories,
  tallyStage,
  type FormatConfig,
  type FormatResults,
  type GroupsStage,
  type StageMatchResult,
} from '..';

// mulberry32, the generator the admin draw uses.
function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'Kestrel', 'Osprey', 'Heron', 'Plover', 'Curlew', 'Merlin', 'Harrier', 'Gannet',
  'Puffin', 'Tern', 'Dunlin', 'Avocet', 'Bittern', 'Egret', 'Lapwing', 'Wagtail',
  'Siskin', 'Linnet', 'Bunting', 'Shrike', 'Swift', 'Martin', 'Petrel', 'Shag',
  'Grebe', 'Dipper', 'Godwit', 'Redshank', 'Sanderling', 'Whimbrel', 'Fulmar', 'Skua',
];
const CATS = ['mens', 'womens', 'mixed', 'mens'] as const;

interface Team { id: string; name: string; seed: number; category: string }
const TEAMS: Team[] = NAMES.map((n, i) => ({
  id: `t${String(i + 1).padStart(2, '0')}`,
  name: `Team ${n}`,
  seed: i + 1,
  category: CATS[i % CATS.length]!,
}));
const byId = new Map(TEAMS.map((t) => [t.id, t]));
const cat = (id: string) => byId.get(id)!.category;

/** A legal one-game result: the winner on the target, the loser anywhere from its start to target-1 (or 2 short with win by two). */
function playGame(cfg: FormatConfig, stage: FormatConfig['stages'][number], a: string, b: string, rng: () => number) {
  const rules = stageMatchRules(cfg, stage, cat(a), cat(b));
  // The better seed wins about 70% of the time.
  const aWins = (byId.get(a)!.seed < byId.get(b)!.seed) === rng() < 0.7;
  const loserStart = aWins ? rules.startB : rules.startA;
  const top = rules.winByTwo ? rules.target - 2 : rules.target - 1;
  const loser = loserStart + Math.floor(rng() * (top - loserStart + 1));
  const game = aWins ? { a: rules.target, b: loser } : { a: loser, b: rules.target };
  expect(isLegalGame(game, rules)).toBe(true);
  return { game, winner: aWins ? a : b };
}

function playGroups(cfg: FormatConfig, seed = 7) {
  const stage = cfg.stages[0] as GroupsStage;
  const rng = rngFrom(seed);
  const planned = planStageGroups(TEAMS, stage, rng);
  const schedule = scheduleStage(planned, stage, (t) => t.id);
  const matches: StageMatchResult[] = schedule.map((s) => {
    const base = { stage: stage.key, pool: s.pool, group: s.group, round: s.round, label: null, a: s.a.id, b: s.b.id };
    // Match 5 is a walkover to side A: counted as the stage's 15-0 forfeit.
    if (s.matchNumber === 5) return { ...base, status: 'walkover', winner: s.a.id, games: null };
    const { game, winner } = playGame(cfg, stage, s.a.id, s.b.id, rng);
    return { ...base, status: 'completed', winner, games: [game] };
  });
  const results: FormatResults = {
    field: TEAMS.map((t) => ({ id: t.id, seed: t.seed })),
    groups: planned.map((g) => ({ stage: stage.key, pool: g.pool, group: g.group, members: g.members.map((m) => m.id) })),
    matches,
  };
  return { stage, planned, schedule, results };
}

/** Play every fixture of a 'matches' stage whose sides are known. */
function playStage(cfg: FormatConfig, key: string, results: FormatResults, seed = 11): FormatResults {
  const stage = cfg.stages.find((s) => s.key === key)!;
  const rng = rngFrom(seed);
  const resolved = resolveStageMatches(cfg, key, results);
  expect(resolved.every((m) => m.a.entry && m.b.entry)).toBe(true);
  const played: StageMatchResult[] = resolved.map((m) => {
    const { game, winner } = playGame(cfg, stage, m.a.entry!, m.b.entry!, rng);
    return {
      stage: key, pool: null, group: null, round: null, label: m.label,
      a: m.a.entry, b: m.b.entry, status: 'completed', winner, games: [game],
    };
  });
  return { ...results, matches: [...results.matches, ...played] };
}

function expectPermutation(places: Map<string, number>) {
  expect(places.size).toBe(32);
  expect([...places.values()].sort((x, y) => x - y)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
}

const record = (results: FormatResults, stageKey: string, id: string) => {
  const ms = results.matches.filter((m) => m.stage === stageKey);
  return tallyStage([id], ms, () => ({ winner: 15, loser: 0 })).get(id)!;
};

describe('the organiser\'s event: 32 teams, 4 pools of 2 groups of 4', () => {
  const cfg = poolsThenPlacement();

  it('the preset is a valid config, unchanged by parsing', () => {
    expect(formatConfigSchema.parse(cfg)).toEqual(cfg);
  });

  const { stage, planned, schedule, results } = playGroups(cfg);

  it('deals 8 groups of 4, the top four seeds in four different pools', () => {
    expect(planned).toHaveLength(8);
    expect(planned.every((g) => g.members.length === 4)).toBe(true);
    const poolOf = (seed: number) => planned.find((g) => g.members.some((m) => m.seed === seed))!.pool;
    expect(new Set([1, 2, 3, 4].map(poolOf)).size).toBe(4);
  });

  it('schedules 48 group matches, numbered 1..48', () => {
    expect(schedule).toHaveLength(48);
    expect(schedule.map((m) => m.matchNumber)).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
  });

  it('each pool plays 6 slots on its own 2 courts, its groups taking turns', () => {
    for (let pool = 1; pool <= 4; pool++) {
      const ms = schedule.filter((m) => m.pool === pool);
      expect(ms).toHaveLength(12);
      const courts = [String(2 * pool - 1), String(2 * pool)];
      for (let slot = 1; slot <= 6; slot++) {
        const inSlot = ms.filter((m) => m.slot === slot);
        expect(inSlot.map((m) => m.court)).toEqual(courts);
        // Odd slots are group 1, even slots group 2.
        expect(new Set(inSlot.map((m) => m.group))).toEqual(new Set([slot % 2 === 1 ? 1 : 2]));
        const people = inSlot.flatMap((m) => [m.a.id, m.b.id]);
        expect(new Set(people).size).toBe(people.length);
      }
    }
    expect(new Set(schedule.filter((m) => m.pool === 1).map((m) => m.court))).toEqual(new Set(['1', '2']));
    expect(new Set(schedule.filter((m) => m.pool === 4).map((m) => m.court))).toEqual(new Set(['7', '8']));
  });

  it('everyone in a group meets everyone else once', () => {
    for (const g of planned) {
      const pairs = schedule
        .filter((m) => m.pool === g.pool && m.group === g.group)
        .map((m) => [m.a.id, m.b.id].sort().join('-'));
      expect(new Set(pairs).size).toBe(6);
    }
  });

  it('head starts follow the category matrix', () => {
    expect(headStartFor(cfg, 'womens', 'mens')).toEqual({ a: 5, b: 0 });
    expect(headStartFor(cfg, 'mens', 'mixed')).toEqual({ a: 0, b: 3 });
    expect(headStartFor(cfg, 'womens', 'mixed')).toEqual({ a: 0, b: 0 });
    expect(headStartFor(cfg, null, 'mens')).toEqual({ a: 0, b: 0 });
  });

  it('a walkover counts as 15-0', () => {
    const wo = results.matches.find((m) => m.status === 'walkover')!;
    const rows = tallyStage([wo.a!, wo.b!], [wo], () => ({ winner: 15, loser: 0 }));
    expect(rows.get(wo.a!)).toMatchObject({ wins: 1, pointsFor: 15, pointsAgainst: 0, gamesFor: 1 });
    expect(rows.get(wo.b!)).toMatchObject({ losses: 1, pointsFor: 0, pointsAgainst: 15, gamesAgainst: 1 });

    // And through the config: the group table reads the stage's own forfeit.
    const played = results.matches.filter((m) =>
      m.status === 'completed' && m.pool === wo.pool && m.group === wo.group && (m.a === wo.a || m.b === wo.a));
    const fromGames = played.reduce((sum, m) => sum + m.games!.reduce((g, x) => g + (m.a === wo.a ? x.a : x.b), 0), 0);
    const row = groupTable(cfg, stage, results, wo.pool!, wo.group!).rows.find((r) => r.id === wo.a)!;
    expect(row.pointsFor).toBe(15 + fromGames);
    expect(row.played).toBe(3);
  });

  it('every group table is ranked by wins, then point difference', () => {
    for (const g of planned) {
      const { rows, complete } = groupTable(cfg, stage, results, g.pool, g.group);
      expect(complete).toBe(true);
      expect(rows).toHaveLength(4);
      for (let i = 1; i < rows.length; i++) {
        const [hi, lo] = [rows[i - 1]!, rows[i]!];
        expect(hi.wins).toBeGreaterThanOrEqual(lo.wins);
        if (hi.wins === lo.wins) {
          expect(hi.pointsFor - hi.pointsAgainst).toBeGreaterThanOrEqual(lo.pointsFor - lo.pointsAgainst);
        }
      }
    }
  });

  it('the finals cannot be drawn until every group match is played', () => {
    const partial: FormatResults = {
      ...results,
      matches: results.matches.map((m, i) => (i === 47 ? { ...m, status: 'live', winner: null, games: null } : m)),
    };
    expect(stageReady(cfg, 'finals', partial)).toBe(false);
    expect(resolveSlots(cfg, 'finals', partial).some((s) => s.entry == null)).toBe(true);
    expect(stageReady(cfg, 'finals', results)).toBe(true);
    expect(stageReady(cfg, 'groups', results)).toBe(true);
  });

  it('variant A: the best group winner of each pool, reseeded, plays 1 v 2 and 3 v 4', () => {
    const slots = resolveSlots(cfg, 'finals', results);
    expect(slots).toHaveLength(4);
    slots.forEach((s, i) => {
      const pool = i + 1;
      const winners = [1, 2].map((group) => groupTable(cfg, stage, results, pool, group).rows[0]!);
      const best = [...winners].sort((x, y) =>
        y.wins - x.wins || (y.pointsFor - y.pointsAgainst) - (x.pointsFor - x.pointsAgainst))[0]!;
      expect(s.entry).toBe(best.id);
      expect(slotRefLabel(s.ref, cfg)).toBe(`G${pool} winner`);
    });

    const seeds = reseededEntrants(cfg, 'finals', results)!;
    expect(new Set(seeds)).toEqual(new Set(slots.map((s) => s.entry)));
    for (let i = 1; i < seeds.length; i++) {
      const hi = record(results, 'groups', seeds[i - 1]!);
      const lo = record(results, 'groups', seeds[i]!);
      expect(hi.wins).toBeGreaterThanOrEqual(lo.wins);
      if (hi.wins === lo.wins) expect(hi.pointsFor - hi.pointsAgainst).toBeGreaterThanOrEqual(lo.pointsFor - lo.pointsAgainst);
    }

    const fixtures = resolveStageMatches(cfg, 'finals', results);
    expect(fixtures.map((f) => [f.label, f.a.entry, f.b.entry])).toEqual([
      ['final', seeds[0], seeds[1]],
      ['third', seeds[2], seeds[3]],
    ]);

    const done = playStage(cfg, 'finals', results);
    const places = finalPlacings(cfg, done);
    expectPermutation(places);
    const final = done.matches.find((m) => m.label === 'final')!;
    const third = done.matches.find((m) => m.label === 'third')!;
    expect(places.get(final.winner!)).toBe(1);
    expect(places.get(final.winner === final.a ? final.b! : final.a!)).toBe(2);
    expect(places.get(third.winner!)).toBe(3);
    expect(places.get(third.winner === third.a ? third.b! : third.a!)).toBe(4);
    // The four group winners who lost their pool come next, then every runner-up.
    const groupWinners = planned.map((g) => groupTable(cfg, stage, results, g.pool, g.group).rows[0]!.id);
    const stayedBehind = groupWinners.filter((id) => !seeds.includes(id));
    expect(stayedBehind.map((id) => places.get(id)!).sort((x, y) => x - y)).toEqual([5, 6, 7, 8]);
    const runnersUp = planned.map((g) => groupTable(cfg, stage, results, g.pool, g.group).rows[1]!.id);
    expect(runnersUp.map((id) => places.get(id)!).sort((x, y) => x - y)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(pointsFor(cfg, 1, 4)).toBe(100);
  });

  it('variant B: each pool\'s two group winners play off, the winners go to the placement finals', () => {
    const b = poolsPlayoffThenPlacement();
    expect(formatConfigSchema.parse(b)).toEqual(b);
    expect(stageReady(b, 'playoff', results)).toBe(true);
    expect(stageReady(b, 'finals', results)).toBe(false);

    const playoffs = resolveStageMatches(b, 'playoff', results);
    expect(playoffs).toHaveLength(4);
    playoffs.forEach((p, i) => {
      expect(p.a.entry).toBe(groupTable(b, stage, results, i + 1, 1).rows[0]!.id);
      expect(p.b.entry).toBe(groupTable(b, stage, results, i + 1, 2).rows[0]!.id);
    });

    const afterPlayoff = playStage(b, 'playoff', results, 21);
    expect(stageReady(b, 'finals', afterPlayoff)).toBe(true);
    const seeds = reseededEntrants(b, 'finals', afterPlayoff)!;
    const winners = afterPlayoff.matches.filter((m) => m.stage === 'playoff').map((m) => m.winner);
    expect(new Set(seeds)).toEqual(new Set(winners));
    // Decision 8: the reseed reads the group stage only, never the playoff.
    for (let i = 1; i < seeds.length; i++) {
      const hi = record(afterPlayoff, 'groups', seeds[i - 1]!);
      const lo = record(afterPlayoff, 'groups', seeds[i]!);
      expect(hi.wins).toBeGreaterThanOrEqual(lo.wins);
      if (hi.wins === lo.wins) expect(hi.pointsFor - hi.pointsAgainst).toBeGreaterThanOrEqual(lo.pointsFor - lo.pointsAgainst);
    }

    const done = playStage(b, 'finals', afterPlayoff, 31);
    const places = finalPlacings(b, done);
    expectPermutation(places);
    const losers = done.matches.filter((m) => m.stage === 'playoff').map((m) => (m.winner === m.a ? m.b! : m.a!));
    expect(losers.map((id) => places.get(id)!).sort((x, y) => x - y)).toEqual([5, 6, 7, 8]);
  });

  it('variant C: semi-finals pool 1 v pool 2 and pool 3 v pool 4, then a final and a bronze', () => {
    const c = poolsThenSemisFinal();
    expect(formatConfigSchema.parse(c)).toEqual(c);
    const semis = resolveStageMatches(c, 'semis', results);
    const pw = resolveSlots(c, 'semis', results).map((s) => s.entry);
    expect(semis.map((s) => [s.a.entry, s.b.entry])).toEqual([[pw[0], pw[1]], [pw[2], pw[3]]]);
    expect(slotRefLabel({ type: 'match', stage: 'semis', match: 'semi1', result: 'winner' })).toBe('Winner of semi1');

    const afterSemis = playStage(c, 'semis', results, 41);
    expect(stageReady(c, 'finals', afterSemis)).toBe(true);
    const done = playStage(c, 'finals', afterSemis, 51);
    const places = finalPlacings(c, done);
    expectPermutation(places);
    const final = done.matches.find((m) => m.label === 'final')!;
    expect(places.get(final.winner!)).toBe(1);
    const bronze = done.matches.find((m) => m.label === 'bronze')!;
    expect(places.get(bronze.winner!)).toBe(3);

    const noBronze = poolsThenSemisFinal({ bronze: false });
    expect(formatConfigSchema.safeParse(noBronze).success).toBe(true);
    const doneNoBronze = playStage(noBronze, 'finals', playStage(noBronze, 'semis', results, 41), 51);
    expectPermutation(finalPlacings(noBronze, doneNoBronze));
  });
});

describe('preset options', () => {
  it('stay valid when the organiser changes the shape', () => {
    for (const opts of [
      { pools: 2 },
      { pools: 6, groupsPerPool: 1, groupSize: 5 as const },
      { pools: 4, groupsPerPool: 3, groupSize: 'auto' as const, groupTarget: 11, finalsTarget: 15 },
      { pools: 2, courts: null },
    ]) {
      const cfg = poolsThenPlacement(opts);
      expect(formatConfigSchema.safeParse(cfg).success).toBe(true);
    }
    expect(formatConfigSchema.safeParse(poolsPlayoffThenPlacement({ pools: 2 })).success).toBe(true);
  });

  it('refuse shapes they cannot place', () => {
    expect(() => poolsThenPlacement({ pools: 3 })).toThrow();
    expect(() => poolsThenSemisFinal({ pools: 2 })).toThrow();
    expect(() => poolsPlayoffThenPlacement({ groupsPerPool: 3 })).toThrow();
  });
});

describe('formatConfigSchema refuses broken configs', () => {
  const good = poolsThenPlacement();
  const fails = (cfg: unknown) => expect(formatConfigSchema.safeParse(cfg).success).toBe(false);

  it('a slot pointing forward', () => {
    fails({ ...good, stages: [...good.stages].reverse() });
  });

  it('a duplicate stage key', () => {
    fails({ ...good, stages: [good.stages[0], { ...good.stages[1]!, key: 'groups' }] });
  });

  it('a duplicate category key', () => {
    fails({ ...good, categories: [...good.categories, { key: 'mens', label: 'Again' }] });
  });

  it('a head start as big as a handicapped target', () => {
    fails({ ...good, headStarts: { womens: { mens: 15 } } });
    expect(formatConfigSchema.safeParse({ ...good, headStarts: { womens: { mens: 14 } } }).success).toBe(true);
  });

  it('a head start against the same category, or an unknown one', () => {
    fails({ ...good, headStarts: { mens: { mens: 2 } } });
    fails({ ...good, headStarts: { juniors: { mens: 2 } } });
  });

  it('a handicapped stage that is rated', () => {
    fails({ ...good, stages: [{ ...good.stages[0]!, rated: true }, good.stages[1]] });
  });

  it('courts for the wrong number of pools', () => {
    const g = good.stages[0] as GroupsStage;
    fails({ ...good, stages: [{ ...g, courts: { mode: 'per_pool', pools: [['1', '2']] } }, good.stages[1]] });
  });

  it('a seed in a stage that does not reseed', () => {
    const finals = good.stages[1]!;
    if (finals.entrants.from !== 'slots') throw new Error('preset changed');
    fails({ ...good, stages: [good.stages[0], { ...finals, entrants: { from: 'slots', slots: finals.entrants.slots } }] });
  });

  it('a last stage that places nobody, or places with a gap', () => {
    const finals = good.stages[1]!;
    if (finals.kind !== 'matches') throw new Error('preset changed');
    fails({ ...good, stages: [good.stages[0], { ...finals, matches: finals.matches.map((m) => ({ ...m, winnerPlace: undefined, loserPlace: undefined })) }] });
    fails({ ...good, stages: [good.stages[0], { ...finals, matches: [finals.matches[0]!, { ...finals.matches[1]!, winnerPlace: 5, loserPlace: 6 }] }] });
  });

  it('a cap below the target', () => {
    const g = good.stages[0] as GroupsStage;
    fails({ ...good, stages: [{ ...g, scoring: { ...g.scoring, winByTwo: true, cap: 14 } }, good.stages[1]] });
  });
});

describe('legacyFormatDefinition', () => {
  const events = [
    { format: 'single_elimination', match_format: 'one_game_21', seeding_method: 'elo' },
    { format: 'single_elimination', match_format: 'best_of_3_to_21', games_per_match: 3, points_per_game: 15, seeding_method: 'random' },
    { format: 'round_robin', match_format: 'one_game_15', group_count: 3, seed_by: 'points' as const, seeding_method: 'manual' },
    { format: 'round_robin', match_format: 'one_game_11', group_count: null, external_event: true },
    { format: 'pool_to_bracket', match_format: 'best_of_3_to_21', group_count: 4, qualifiers_per_group: 2, seed_by: 'wins' as const },
    { format: 'pool_to_bracket', match_format: 'one_game_21', group_count: null, qualifiers_per_group: null },
  ];

  for (const event of events) {
    it(`${event.format} ${event.match_format} round-trips through the schema`, () => {
      const cfg = legacyFormatDefinition(event, { thirdPlace: true });
      const parsed = formatConfigSchema.safeParse(cfg);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(cfg);
    });
  }

  it('ranks a round robin by wins whatever its seed_by, a pool by its seed_by', () => {
    const rr = legacyFormatDefinition(events[2]!).stages[0]!;
    expect(rr.kind === 'groups' && rr.tiebreaks[0]).toBe('wins');
    const pool = legacyFormatDefinition({ ...events[4]!, seed_by: 'points' }).stages[0]!;
    expect(pool.kind === 'groups' && pool.tiebreaks[0]).toBe('points_for');
  });

  it('keeps the legacy points tables', () => {
    const ko = legacyFormatDefinition(events[0]!);
    expect([1, 2, 3, 4, 5, 8, 9].map((p) => pointsFor(ko, p, 0))).toEqual([100, 75, 50, 40, 25, 25, 10]);
    const rr = legacyFormatDefinition(events[2]!);
    expect(pointsFor(rr, 1, 4)).toBe(13);
  });

  it('pays a custom table when the config carries one', () => {
    const ko = { ...legacyFormatDefinition(events[0]!), points: { byPlace: [60, 40, 20], rest: 4, participation: 1, perWin: 2 } };
    expect([1, 3, 4].map((p) => pointsFor(ko, p, 1))).toEqual([63, 23, 7]);
  });

  it('pool_to_bracket qualifies the top two of each group ranked across groups', () => {
    const cfg = legacyFormatDefinition(events[4]!);
    const ko = cfg.stages[1]!;
    expect(ko.kind).toBe('knockout');
    if (ko.entrants.from !== 'slots') throw new Error('expected slots');
    expect(ko.entrants.slots.map((s) => (s.type === 'group_rank' ? [s.place, s.count] : null))).toEqual([[1, 4], [2, 4]]);
    expect(slotRefLabel({ type: 'group_place', stage: 'pool', pool: 2, group: 1, place: 1 }, cfg)).toBe('Group B 1st');
  });
});

describe('suggestCategory', () => {
  it('reads the team from its members', () => {
    expect(suggestCategory([{ competition_category: 'mens' }, { competition_category: 'mens' }])).toBe('mens');
    expect(suggestCategory([{ competition_category: 'womens' }])).toBe('womens');
    expect(suggestCategory([{ competition_category: 'mens' }, { competition_category: 'womens' }])).toBe('mixed');
    expect(suggestCategory([{ competition_category: 'mens' }, { competition_category: null }])).toBeNull();
    expect(suggestCategory([])).toBeNull();
  });
});

describe('categoryForEventType', () => {
  it('maps the gendered doubles events and nothing else', () => {
    expect(categoryForEventType('mens_doubles')).toBe('mens');
    expect(categoryForEventType('womens_doubles')).toBe('womens');
    expect(categoryForEventType('mixed_doubles')).toBe('mixed');
    expect(categoryForEventType('open_doubles')).toBeNull();
    expect(categoryForEventType('mens_singles')).toBeNull();
    expect(categoryForEventType(null)).toBeNull();
  });
});

describe('pickCategory', () => {
  const cfg = { categories: defaultCategories() };
  it('keeps a suggestion the event lists', () => {
    expect(pickCategory(cfg, 'womens')).toBe('womens');
  });
  it('drops a suggestion the event does not list', () => {
    expect(pickCategory({ categories: [{ key: 'a', label: 'A' }] }, 'mens')).toBeNull();
  });
  it('is null with no config or no suggestion', () => {
    expect(pickCategory(null, 'mens')).toBeNull();
    expect(pickCategory(cfg, null)).toBeNull();
  });
});

describe('groups, then the top N to a knockout', () => {
  const placeOf = (cfg: FormatConfig, results: FormatResults, groups: number, place: number) =>
    Array.from({ length: groups }, (_, i) => groupTable(cfg, cfg.stages[0] as GroupsStage, results, i + 1, 1).rows[place - 1]!.id);

  it('takes the best 8 from 3 groups: every winner, every runner-up, the best 2 thirds', () => {
    const cfg = groupsThenTopKnockout({ pools: 3, advance: 8 });
    expect(formatConfigSchema.parse(cfg)).toEqual(cfg);
    const { results } = playGroups(cfg);
    const slots = resolveSlots(cfg, 'knockout', results).map((s) => s.entry);
    expect(slots).toHaveLength(8);
    expect(new Set(slots).size).toBe(8);
    expect(slots.slice(0, 3).sort()).toEqual(placeOf(cfg, results, 3, 1).sort());
    expect(slots.slice(3, 6).sort()).toEqual(placeOf(cfg, results, 3, 2).sort());
    const thirds = placeOf(cfg, results, 3, 3);
    expect(slots.slice(6).every((id) => thirds.includes(id!))).toBe(true);
  });

  it('takes the best 2 group winners of 4 for a final', () => {
    const cfg = groupsThenTopKnockout({ pools: 4, advance: 2 });
    const { results } = playGroups(cfg);
    const slots = resolveSlots(cfg, 'knockout', results).map((s) => s.entry);
    expect(slots).toHaveLength(2);
    expect(slots.every((id) => placeOf(cfg, results, 4, 1).includes(id!))).toBe(true);
    expect(cfg.stages[1]).toMatchObject({ kind: 'knockout', size: 2, thirdPlace: false });
  });

  it('reads one group top down', () => {
    const cfg = groupsThenTopKnockout({ pools: 1, advance: 4 });
    const { results } = playGroups(cfg);
    const table = groupTable(cfg, cfg.stages[0] as GroupsStage, results, 1, 1).rows.map((r) => r.id);
    expect(resolveSlots(cfg, 'knockout', results).map((s) => s.entry)).toEqual(table.slice(0, 4));
  });

  it('refuses a number going through that is not a power of 2', () => {
    expect(() => groupsThenTopKnockout({ pools: 3, advance: 6 })).toThrow(/2, 4, 8/);
  });
});
