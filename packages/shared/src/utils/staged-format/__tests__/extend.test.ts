import { describe, expect, it } from 'vitest';
import {
  buildAddedRoundRows,
  buildLateEntrantRows,
  buildStageRows,
  formatConfigSchema,
  formatResultsFrom,
  groupLedger,
  groupScheduleRows,
  groupTable,
  nextGroupRound,
  pairKey,
  planLateEntrant,
  planStageGroups,
  rankStandings,
  scheduleStage,
  tallyStage,
  type FormatConfig,
  type FormatResults,
  type GroupsStage,
  type StageMatchResult,
  type StageRow,
} from '..';

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

function idsFrom(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const CATS = ['mens', 'womens', 'mixed'] as const;
const team = (n: number) => ({ id: `t${String(n).padStart(2, '0')}`, category: CATS[n % CATS.length]! });
const teams = (count: number) => Array.from({ length: count }, (_, i) => team(i + 1));

function groupsConfig(stage: Partial<GroupsStage> & { pools: number; groupsPerPool: number }): FormatConfig {
  return formatConfigSchema.parse({
    version: 1,
    stages: [{
      key: 'groups',
      name: 'Group stage',
      rated: false,
      kind: 'groups',
      groupSize: 'auto',
      assignment: 'snake',
      scoring: { bestOf: 1, target: 21, winByTwo: true, cap: 30, handicap: false, forfeit: null },
      entrants: { from: 'field', order: 'elo' },
      ...stage,
    }],
  });
}

/** Stored rows as the screens read them; every row in `played` is completed, the better seed winning. */
function resultsOf(cfg: FormatConfig, field: ReadonlyArray<{ id: string }>, rows: readonly StageRow[], opts: { played?: boolean; status?: Record<string, string> } = {}): FormatResults {
  const seedOf = new Map(field.map((e, i) => [e.id, i + 1]));
  return formatResultsFrom(
    cfg,
    field.map((e) => ({ id: e.id, seed: seedOf.get(e.id)!, status: opts.status?.[e.id] ?? 'registered' })),
    rows.map((r) => {
      const aWins = seedOf.get(r.a!)! < seedOf.get(r.b!)!;
      return {
        stage: r.stage,
        status: opts.played ? 'completed' : 'ready',
        pool_number: r.pool_number,
        group_number: r.group_number,
        round_number: r.round_number,
        match_label: null,
        is_third_place: false,
        a: r.a,
        b: r.b,
        winner: opts.played ? (aWins ? r.a : r.b) : null,
        scores: opts.played ? [aWins ? { a: 21, b: 10 } : { a: 10, b: 21 }] : null,
      };
    }),
  );
}

const appearances = (rows: readonly StageRow[]) => {
  const count = new Map<string, number>();
  for (const r of rows) for (const id of [r.a!, r.b!]) count.set(id, (count.get(id) ?? 0) + 1);
  return count;
};

const pairs = (rows: readonly StageRow[]) => rows.map((r) => pairKey(r.a!, r.b!));

describe('games per team', () => {
  it('is a full round robin when absent', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 2 });
    const rows = buildStageRows(cfg, 'groups', teams(8), 'g', { rng: rngFrom(1), newId: idsFrom('m') });
    expect(rows).toHaveLength(12);
    expect([...appearances(rows).values()].every((n) => n === 3)).toBe(true);
  });

  it('cuts an even group to that many rounds, everyone playing that many', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 2, gamesPerTeam: 2 });
    const rows = buildStageRows(cfg, 'groups', teams(8), 'g', { rng: rngFrom(1), newId: idsFrom('m') });
    expect(rows).toHaveLength(8);
    expect([...appearances(rows).values()].every((n) => n === 2)).toBe(true);
    expect(new Set(pairs(rows)).size).toBe(rows.length);
  });

  it('cuts an odd group to that many rounds, so some teams play one fewer', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 2, gamesPerTeam: 2 });
    const rows = buildStageRows(cfg, 'groups', teams(10), 'g', { rng: rngFrom(1), newId: idsFrom('m') });
    expect(rows).toHaveLength(8);
    const counts = [...appearances(rows).values()];
    expect(counts.every((n) => n === 1 || n === 2)).toBe(true);
    expect(counts.some((n) => n === 1)).toBe(true);
  });

  it('is no limit when it is at least the full round robin', () => {
    const full = buildStageRows(groupsConfig({ pools: 1, groupsPerPool: 1 }), 'groups', teams(5), 'g', { rng: rngFrom(3), newId: idsFrom('m') });
    const capped = buildStageRows(groupsConfig({ pools: 1, groupsPerPool: 1, gamesPerTeam: 15 }), 'groups', teams(5), 'g', { rng: rngFrom(3), newId: idsFrom('m') });
    expect(capped).toEqual(full);
  });
});

describe('groupScheduleRows', () => {
  it('builds the same rows as the draw it was taken out of', () => {
    for (const courts of [null, { mode: 'shared' as const, courts: ['1', '2', '3'] }, { mode: 'per_pool' as const, pools: [['1', '2'], ['3']] }]) {
      const cfg = groupsConfig({ pools: 2, groupsPerPool: 2, courts, interleave: true });
      const field = teams(19);
      const drawn = buildStageRows(cfg, 'groups', field, 'g', { rng: rngFrom(9), newId: idsFrom('m'), firstMatchNumber: 4 });
      const stage = cfg.stages[0] as GroupsStage;
      const schedule = scheduleStage(planStageGroups(field, stage, rngFrom(9)), stage, (e) => e.id);
      expect(groupScheduleRows(cfg, 'groups', schedule, 'g', { newId: idsFrom('m'), firstMatchNumber: 4 })).toEqual(drawn);
    }
  });
});

describe('nextGroupRound', () => {
  it('finds a round with no rematch while one exists', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 1, gamesPerTeam: 2 });
    const field = teams(6);
    const rows = buildStageRows(cfg, 'groups', field, 'g', { rng: rngFrom(2), newId: idsFrom('m') });
    const [ledger] = groupLedger(resultsOf(cfg, field, rows), 'groups', new Set(field.map((e) => e.id)));
    const round = nextGroupRound(ledger!.members, ledger!.games, ledger!.met);
    expect(round.fixtures).toHaveLength(3);
    expect(round.repeats).toBe(0);
    expect(round.sittingOut).toEqual([]);
    expect(new Set(round.fixtures.flat()).size).toBe(6);
  });

  it('repeats as few meetings as it must once everyone has met', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 1 });
    const field = teams(4);
    const rows = buildStageRows(cfg, 'groups', field, 'g', { rng: rngFrom(2), newId: idsFrom('m') });
    const [ledger] = groupLedger(resultsOf(cfg, field, rows), 'groups', new Set(field.map((e) => e.id)));
    expect(nextGroupRound(ledger!.members, ledger!.games, ledger!.met).repeats).toBe(2);
  });

  it('rests the team with the most games in an odd group, the worst seed among them', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 1, gamesPerTeam: 2 });
    const field = teams(5);
    const rows = buildStageRows(cfg, 'groups', field, 'g', { rng: rngFrom(2), newId: idsFrom('m') });
    const [ledger] = groupLedger(resultsOf(cfg, field, rows), 'groups', new Set(field.map((e) => e.id)));
    const round = nextGroupRound(ledger!.members, ledger!.games, ledger!.met);
    const most = Math.max(...ledger!.games.values());
    const busiest = ledger!.members.filter((id) => ledger!.games.get(id) === most);
    expect(round.sittingOut).toEqual([busiest[busiest.length - 1]]);
    expect(round.repeats).toBe(0);
    expect(round.fixtures).toHaveLength(2);
  });

  it('rests somebody else when that is the only way to avoid a rematch', () => {
    // a has met b, c and d, so resting e (the most games) forces a rematch;
    // resting a pairs b, c, d and e freshly.
    const members = ['a', 'b', 'c', 'd', 'e'];
    const games = new Map([['a', 3], ['b', 1], ['c', 1], ['d', 1], ['e', 4]]);
    const met = new Map([[pairKey('a', 'b'), 1], [pairKey('a', 'c'), 1], [pairKey('a', 'd'), 1]]);
    const round = nextGroupRound(members, games, met);
    expect(round.sittingOut).toEqual(['a']);
    expect(round.repeats).toBe(0);
  });

  it('plays nobody in a group of one', () => {
    expect(nextGroupRound(['a'], new Map([['a', 0]]), new Map())).toEqual({ fixtures: [], sittingOut: ['a'], repeats: 0 });
  });
});

describe('buildAddedRoundRows', () => {
  const courtModes: Array<[string, GroupsStage['courts']]> = [
    ['no courts', null],
    ['shared courts', { mode: 'shared', courts: ['1', '2'] }],
    ['courts per pool', { mode: 'per_pool', pools: [['1', '2'], ['3']] }],
  ];

  for (const [label, courts] of courtModes) {
    it(`adds rounds after everything stored, never reusing a (round, position), with ${label}`, () => {
      const cfg = groupsConfig({ pools: 2, groupsPerPool: 2, courts, gamesPerTeam: 1 });
      const field = teams(18);
      const active = new Set(field.map((e) => e.id));
      const categories = new Map(field.map((e) => [e.id, e.category]));
      let rows = buildStageRows(cfg, 'groups', field, 'g', { rng: rngFrom(4), newId: idsFrom('m') });

      for (let added = 0; added < 2; added++) {
        const firstSlot = Math.max(...rows.map((r) => r.round_number)) + 1;
        const firstMatchNumber = Math.max(...rows.map((r) => r.match_number)) + 1;
        const { rows: extra, groups } = buildAddedRoundRows(cfg, 'groups', resultsOf(cfg, field, rows), active, categories, 'g', {
          firstSlot, firstMatchNumber, newId: idsFrom(`x${added}-`),
        });
        expect(groups).toHaveLength(4);
        expect(groups.every((g) => g.repeats === 0)).toBe(true);
        expect(extra.every((r) => r.round_number >= firstSlot && r.stage === 1 && r.draw_generation_id === 'g')).toBe(true);
        expect(extra.map((r) => r.match_number)).toEqual(extra.map((_, i) => firstMatchNumber + i));
        // Nobody on two courts in the same slot of the new round.
        for (const slot of new Set(extra.map((r) => r.round_number))) {
          const inSlot = extra.filter((r) => r.round_number === slot).flatMap((r) => [r.a, r.b]);
          expect(new Set(inSlot).size).toBe(inSlot.length);
        }
        rows = [...rows, ...extra];
      }

      const positions = rows.map((r) => `${r.round_number}:${r.bracket_position}`);
      expect(new Set(positions).size).toBe(positions.length);
      expect(new Set(pairs(rows)).size).toBe(rows.length);
    });
  }

  it('reads the stage scoring and head starts onto the new rows', () => {
    const cfg = formatConfigSchema.parse({
      ...groupsConfig({ pools: 1, groupsPerPool: 1, gamesPerTeam: 1 }),
      headStarts: { womens: { mens: 3 } },
    });
    const stage = cfg.stages[0]!;
    const handicapped: FormatConfig = { ...cfg, stages: [{ ...stage, scoring: { ...stage.scoring, handicap: true } }] };
    const field = teams(4);
    const rows = buildStageRows(handicapped, 'groups', field, 'g', { rng: rngFrom(5), newId: idsFrom('m') });
    const { rows: extra } = buildAddedRoundRows(handicapped, 'groups', resultsOf(handicapped, field, rows), new Set(field.map((e) => e.id)),
      new Map(field.map((e) => [e.id, e.category])), 'g', { firstSlot: 2, firstMatchNumber: 3, newId: idsFrom('x') });
    const category = new Map(field.map((e) => [e.id, e.category]));
    for (const r of extra) {
      expect(r.games_per_match).toBe(1);
      expect(r.points_per_game).toBe(21);
      expect(r.handicap_a).toBe(category.get(r.a!) === 'womens' && category.get(r.b!) === 'mens' ? 3 : 0);
      expect(r.handicap_b).toBe(category.get(r.b!) === 'womens' && category.get(r.a!) === 'mens' ? 3 : 0);
    }
  });

  it('leaves a departed team out of the new round', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 1, gamesPerTeam: 2 });
    const field = teams(6);
    const rows = buildStageRows(cfg, 'groups', field, 'g', { rng: rngFrom(6), newId: idsFrom('m') });
    const gone = field[2]!.id;
    const active = new Set(field.map((e) => e.id).filter((id) => id !== gone));
    const { rows: extra, groups } = buildAddedRoundRows(cfg, 'groups', resultsOf(cfg, field, rows, { status: { [gone]: 'withdrawn' } }),
      active, new Map(), 'g', { firstSlot: 10, firstMatchNumber: 10, newId: idsFrom('x') });
    expect(extra.some((r) => r.a === gone || r.b === gone)).toBe(false);
    expect(extra).toHaveLength(2);
    expect(groups[0]!.sittingOut).toHaveLength(1);
  });
});

describe('planLateEntrant', () => {
  const groupOf = (rows: readonly StageRow[], id: string) => {
    const r = rows.find((row) => row.a === id || row.b === id)!;
    return `${r.pool_number}:${r.group_number}`;
  };

  it('takes the group with an odd number of teams when it ends level, even over a smaller group', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 2 });
    const drawn = teams(9);
    const rows = buildStageRows(cfg, 'groups', drawn, 'g', { rng: rngFrom(7), newId: idsFrom('m') });
    const sizes = new Map<string, number>();
    for (const e of drawn) sizes.set(groupOf(rows, e.id), (sizes.get(groupOf(rows, e.id)) ?? 0) + 1);
    expect([...sizes.values()].sort()).toEqual([4, 5]);

    const late = team(10);
    const field = [...drawn, late];
    const active = new Set(field.map((e) => e.id));
    const plan = planLateEntrant(cfg.stages[0]!, resultsOf(cfg, field, rows), active, late.id)!;
    expect(sizes.get(`${plan.pool}:${plan.group}`)).toBe(5);
    expect(plan.level).toBe(true);
    expect(plan.anyOddGroup).toBe(true);
    // A full round robin leaves everyone level, so the newcomer plays everyone.
    expect(plan.opponents).toHaveLength(5);
  });

  it('plays only the teams a game behind, which ends a part-played odd group level', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 1, gamesPerTeam: 2 });
    const drawn = teams(5);
    const rows = buildStageRows(cfg, 'groups', drawn, 'g', { rng: rngFrom(8), newId: idsFrom('m') });
    const games = appearances(rows);
    const behind = drawn.map((e) => e.id).filter((id) => games.get(id) === 1);
    expect(behind).toHaveLength(2);

    const late = team(6);
    const field = [...drawn, late];
    const plan = planLateEntrant(cfg.stages[0]!, resultsOf(cfg, field, rows), new Set(field.map((e) => e.id)), late.id)!;
    expect(plan.opponents).toEqual(behind);
    expect(plan.level).toBe(true);
  });

  it('says when no group can end level, and whether any group was odd', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 1 });
    const field = teams(5);
    const [a, b, c, d, late] = field.map((e) => e.id) as [string, string, string, string, string];
    const row = (x: string, y: string, slot: number) =>
      ({ stage: 1, pool_number: 1, group_number: 1, round_number: slot, a: x, b: y }) as unknown as StageRow;
    // One team has played the other three; nobody else has played anyone else.
    const rows = [row(a, b, 1), row(a, c, 2), row(a, d, 3)];
    const plan = planLateEntrant(cfg.stages[0]!, resultsOf(cfg, field, rows), new Set(field.map((e) => e.id)), late)!;
    expect(plan.opponents).toEqual([b, c, d]);
    expect(plan.level).toBe(false);
    expect(plan.anyOddGroup).toBe(false);
  });

  it('places nobody already in a group, and nobody before a draw', () => {
    const cfg = groupsConfig({ pools: 1, groupsPerPool: 1 });
    const field = teams(4);
    const active = new Set(field.map((e) => e.id));
    const rows = buildStageRows(cfg, 'groups', field, 'g', { rng: rngFrom(9), newId: idsFrom('m') });
    expect(planLateEntrant(cfg.stages[0]!, resultsOf(cfg, field, rows), active, field[0]!.id)).toBeNull();
    expect(planLateEntrant(cfg.stages[0]!, resultsOf(cfg, field, []), active, field[0]!.id)).toBeNull();
  });
});

describe('buildLateEntrantRows', () => {
  const courtModes: Array<[string, GroupsStage['courts']]> = [
    ['no courts', null],
    ['shared courts', { mode: 'shared', courts: ['1', '2'] }],
    ['courts per pool', { mode: 'per_pool', pools: [['1', '2'], ['3']] }],
  ];

  for (const [label, courts] of courtModes) {
    it(`gives each opponent a slot of its own after everything stored, with ${label}`, () => {
      const cfg = groupsConfig({ pools: 2, groupsPerPool: 1, courts });
      const drawn = teams(10);
      const rows = buildStageRows(cfg, 'groups', drawn, 'g', { rng: rngFrom(10), newId: idsFrom('m') });
      const late = team(11);
      const field = [...drawn, late];
      const plan = planLateEntrant(cfg.stages[0]!, resultsOf(cfg, field, rows), new Set(field.map((e) => e.id)), late.id)!;
      const firstSlot = Math.max(...rows.map((r) => r.round_number)) + 1;
      const firstMatchNumber = Math.max(...rows.map((r) => r.match_number)) + 1;
      const extra = buildLateEntrantRows(cfg, 'groups', plan, late.id, new Map(field.map((e) => [e.id, e.category])), 'g', {
        firstSlot, firstMatchNumber, newId: idsFrom('x'),
      });

      expect(extra.map((r) => r.a)).toEqual(plan.opponents);
      expect(extra.every((r) => r.b === late.id && r.pool_number === plan.pool && r.group_number === plan.group)).toBe(true);
      expect(new Set(extra.map((r) => r.round_number)).size).toBe(extra.length);
      expect(extra.every((r) => r.round_number >= firstSlot)).toBe(true);
      expect(extra.map((r) => r.match_number)).toEqual(extra.map((_, i) => firstMatchNumber + i));
      const positions = [...rows, ...extra].map((r) => `${r.round_number}:${r.bracket_position}`);
      expect(new Set(positions).size).toBe(positions.length);

      // Read back, the newcomer is in the group and everyone there is level.
      const after = resultsOf(cfg, field, [...rows, ...extra]);
      const group = after.groups.find((g) => g.pool === plan.pool && g.group === plan.group)!;
      expect(group.members).toContain(late.id);
      const games = appearances([...rows, ...extra].filter((r) => r.pool_number === plan.pool && r.group_number === plan.group));
      expect(new Set(group.members.map((id) => games.get(id))).size).toBe(1);
    });
  }
});

describe('groupTable on an uneven schedule', () => {
  const cfg = groupsConfig({ pools: 1, groupsPerPool: 1, tiebreaks: ['wins', 'seed'] });
  const stage = cfg.stages[0] as GroupsStage;
  const match = (a: string, b: string, winner: string | null, status = 'completed'): StageMatchResult => ({
    stage: 'groups', pool: 1, group: 1, round: 1, label: null, a, b, status, winner,
    games: winner ? [winner === a ? { a: 21, b: 10 } : { a: 10, b: 21 }] : null,
  });
  const resultsWith = (members: string[], matches: StageMatchResult[], out: string[] = []): FormatResults => ({
    field: members.map((id, i) => ({ id, seed: i + 1 })),
    groups: [{ stage: 'groups', pool: 1, group: 1, members }],
    matches,
    out,
  });
  const rawOrder = (results: FormatResults) => {
    const ms = results.matches;
    const tally = tallyStage(results.groups[0]!.members, ms, () => ({ winner: 21, loser: 0 }), new Map(results.field.map((e) => [e.id, e.seed])));
    const out = new Set(results.out ?? []);
    return rankStandings([...tally.values()].filter((r) => !out.has(r.id)), stage.tiebreaks, ms);
  };

  it('ranks a full round robin by raw counts, exactly as before', () => {
    const results = resultsWith(['a', 'b', 'c', 'd'], [
      match('a', 'b', 'b'), match('c', 'd', 'c'), match('a', 'c', 'a'), match('b', 'd', 'd'), match('a', 'd', 'a'), match('b', 'c', 'c'),
    ]);
    expect(groupTable(cfg, stage, results, 1, 1).rows).toEqual(rawOrder(results));
  });

  it('stays raw when a withdrawal voided the matches the team had left', () => {
    const results = resultsWith(['a', 'b', 'c', 'd'], [
      match('a', 'b', 'b'), match('a', 'd', 'a'), match('a', 'c', 'a'), match('b', 'c', 'c'),
      match('b', 'd', null, 'voided'), match('c', 'd', null, 'voided'),
    ], ['d']);
    expect(groupTable(cfg, stage, results, 1, 1).rows).toEqual(rawOrder(results));
  });

  it('ranks per match played when one team has more matches on its schedule', () => {
    // a beat c and lost to b; b played once and won. Level on raw wins (a on
    // seed), but b is ahead per match played.
    const results = resultsWith(['a', 'b', 'c'], [match('a', 'b', 'b'), match('a', 'c', 'a')]);
    expect(rawOrder(results).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(groupTable(cfg, stage, results, 1, 1).rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});
