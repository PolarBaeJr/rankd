import { describe, expect, it } from 'vitest';
import { isLegalCutShortGame, validateMatch } from '../../game-rules';
import {
  buildStageRows,
  formatConfigSchema,
  groupsThenTopKnockout,
  headStartFor,
  parseFormatConfig,
  poolsThenPlacement,
  poolsThenSemisFinal,
  reseededEntrants,
  stagedMatchRated,
  stagedMatchRules,
  stageNumber,
  type FormatConfig,
  type FormatResults,
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

const NAMES = [
  'Kestrel', 'Osprey', 'Heron', 'Plover', 'Curlew', 'Merlin', 'Harrier', 'Gannet',
  'Puffin', 'Tern', 'Dunlin', 'Avocet', 'Bittern', 'Egret', 'Lapwing', 'Wagtail',
  'Siskin', 'Linnet', 'Bunting', 'Shrike', 'Swift', 'Martin', 'Petrel', 'Shag',
  'Grebe', 'Dipper', 'Godwit', 'Redshank', 'Sanderling', 'Whimbrel', 'Fulmar', 'Skua',
];
// A three-cycle, so a snake-dealt group mixes men's teams with the others.
const CATS = ['mens', 'womens', 'mixed'] as const;
const TEAMS = NAMES.map((n, i) => ({
  id: `t${String(i + 1).padStart(2, '0')}`,
  name: `Team ${n}`,
  seed: i + 1,
  category: CATS[i % CATS.length]!,
}));
const seedOf = new Map(TEAMS.map((t) => [t.id, t.seed]));

/** Rows to results: the better seed wins every match at the target, the loser on its start. */
function play(cfg: FormatConfig, rows: StageRow[], key: string): StageMatchResult[] {
  const stage = cfg.stages.find((s) => s.key === key)!;
  return rows.map((r) => {
    const aWins = seedOf.get(r.a!)! < seedOf.get(r.b!)!;
    const game = aWins ? { a: stage.scoring.target, b: r.handicap_b } : { a: r.handicap_a, b: stage.scoring.target };
    return {
      stage: key, pool: r.pool_number, group: r.group_number, round: r.round_number, label: r.match_label,
      a: r.a, b: r.b, status: 'completed', winner: aWins ? r.a : r.b, games: [game],
    };
  });
}

describe('buildStageRows on the organiser\'s event', () => {
  const cfg = poolsThenPlacement();
  const rows = buildStageRows(cfg, 'groups', TEAMS, 'gen-1', { rng: rngFrom(7), newId: idsFrom('m') });

  it('draws 48 group matches into stage 1 under the generation, numbered 1..48', () => {
    expect(rows).toHaveLength(48);
    expect(rows.every((r) => r.stage === 1 && r.draw_generation_id === 'gen-1')).toBe(true);
    expect(rows.map((r) => r.match_number)).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
    expect(rows.every((r) => r.status === 'ready' && !r.is_bye && r.match_label == null)).toBe(true);
  });

  it('stamps the stage scoring as the typed shape', () => {
    expect(rows.every((r) => r.games_per_match === 1 && r.points_per_game === 15)).toBe(true);
  });

  it('never repeats a (round, position) within the stage, which the per-stage unique index needs', () => {
    const keys = rows.map((r) => `${r.round_number}:${r.bracket_position}`);
    expect(new Set(keys).size).toBe(rows.length);
  });

  it('puts each pool on its own two courts and books nobody twice in a slot', () => {
    for (let pool = 1; pool <= 4; pool++) {
      const inPool = rows.filter((r) => r.pool_number === pool);
      expect(inPool).toHaveLength(12);
      expect(new Set(inPool.map((r) => r.court))).toEqual(new Set([String(2 * pool - 1), String(2 * pool)]));
      for (const slot of new Set(inPool.map((r) => r.slot))) {
        const people = inPool.filter((r) => r.slot === slot).flatMap((r) => [r.a, r.b]);
        expect(new Set(people).size).toBe(people.length);
      }
    }
  });

  it('snapshots the head starts from the category matrix', () => {
    const cat = new Map(TEAMS.map((t) => [t.id, t.category]));
    for (const r of rows) {
      expect({ a: r.handicap_a, b: r.handicap_b }).toEqual(headStartFor(cfg, cat.get(r.a!), cat.get(r.b!)));
    }
    expect(rows.some((r) => r.handicap_a > 0 || r.handicap_b > 0)).toBe(true);
  });

  it('is reproducible from the same rng and ids', () => {
    expect(buildStageRows(cfg, 'groups', TEAMS, 'gen-1', { rng: rngFrom(7), newId: idsFrom('m') })).toEqual(rows);
  });

  it('draws the placement finals from the played groups, labelled and handicapped', () => {
    const groups = new Map<string, { stage: string; pool: number; group: number; members: string[] }>();
    for (const r of rows) {
      const key = `${r.pool_number}:${r.group_number}`;
      const g = groups.get(key) ?? { stage: 'groups', pool: r.pool_number!, group: r.group_number!, members: [] };
      for (const id of [r.a!, r.b!]) if (!g.members.includes(id)) g.members.push(id);
      groups.set(key, g);
    }
    const results: FormatResults = {
      field: TEAMS.map((t) => ({ id: t.id, seed: t.seed })),
      groups: [...groups.values()],
      matches: play(cfg, rows, 'groups'),
    };
    const finals = buildStageRows(cfg, 'finals', TEAMS, 'gen-2', { results, newId: idsFrom('f'), firstMatchNumber: 49 });
    const seeds = reseededEntrants(cfg, 'finals', results)!;
    expect(finals.map((r) => [r.match_label, r.a, r.b, r.match_number])).toEqual([
      ['final', seeds[0], seeds[1], 49],
      ['third', seeds[2], seeds[3], 50],
    ]);
    expect(finals.every((r) => r.stage === 2 && r.points_per_game === 21 && r.round_name.length > 0)).toBe(true);
    const cat = new Map(TEAMS.map((t) => [t.id, t.category]));
    for (const r of finals) {
      expect({ a: r.handicap_a, b: r.handicap_b }).toEqual(headStartFor(cfg, cat.get(r.a!), cat.get(r.b!)));
    }
  });

  it('refuses a matches stage whose sides are not known yet', () => {
    const results: FormatResults = { field: [], groups: [], matches: [] };
    expect(() => buildStageRows(cfg, 'finals', TEAMS, 'gen-2', { results })).toThrow(/Final/);
  });

  it('numbers stages from 1 in config order', () => {
    expect(stageNumber(cfg, 'groups')).toBe(1);
    expect(stageNumber(cfg, 'finals')).toBe(2);
    expect(stageNumber(cfg, 'nope')).toBeNull();
  });
});

describe('buildStageRows with one court per group', () => {
  it('puts every match of group p on court p', () => {
    const cfg = groupsThenTopKnockout({ pools: 2, courts: [['1'], ['2']] });
    const rows = buildStageRows(cfg, 'groups', TEAMS.slice(0, 10), 'g', { rng: rngFrom(3), newId: idsFrom('m') });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.stage).toBe(1);
      expect(r.court).toBe(String(r.pool_number));
    }
  });
});

describe('buildStageRows for a knockout stage', () => {
  const knockout = (size: 'auto' | 8 | 16, thirdPlace: boolean): FormatConfig => formatConfigSchema.parse({
    version: 1,
    stages: [{
      kind: 'knockout', key: 'main', name: 'Main draw', rated: true,
      scoring: { bestOf: 3, target: 21, winByTwo: true, cap: 30, handicap: false, forfeit: null },
      entrants: { from: 'field', order: 'elo' },
      size, seeding: 'standard', thirdPlace,
    }],
  });

  it('wires every winner forward and sends byes straight through', () => {
    const field = TEAMS.slice(0, 6);
    const rows = buildStageRows(knockout('auto', true), 'main', field, 'g', { newId: idsFrom('k') });
    const main = rows.filter((r) => !r.is_third_place);
    expect(main).toHaveLength(7);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Seeds 1 and 2 get the two byes, and are already waiting in round 2.
    const byes = main.filter((r) => r.is_bye);
    expect(byes.map((r) => r.winner).sort()).toEqual(['t01', 't02']);
    expect(byes.every((r) => r.status === 'completed')).toBe(true);
    for (const b of byes) {
      const next = byId.get(b.winner_to_match_id!)!;
      expect(next[b.winner_to_position!]).toBe(b.winner);
    }
    for (const r of main.filter((x) => x.round_number < 3)) expect(byId.has(r.winner_to_match_id!)).toBe(true);
    expect(main.find((r) => r.round_number === 3)!.winner_to_match_id).toBeNull();
    // The playoff takes both semi-final losers and is numbered last.
    const third = rows.find((r) => r.is_third_place)!;
    const semis = main.filter((r) => r.round_number === 2);
    expect(semis.map((s) => [s.loser_to_match_id, s.loser_to_position])).toEqual([[third.id, 'a'], [third.id, 'b']]);
    expect(third.match_number).toBe(8);
    expect(new Set(rows.filter((r) => !r.is_third_place).map((r) => `${r.round_number}:${r.bracket_position}`)).size).toBe(7);
  });

  it('refuses a fixed draw too large for the field', () => {
    expect(() => buildStageRows(knockout(16, false), 'main', TEAMS.slice(0, 6), 'g')).toThrow(/empty/);
    expect(() => buildStageRows(knockout(8, false), 'main', TEAMS.slice(0, 9), 'g')).toThrow(/do not fit/);
  });
});

describe('the rules a staged match is judged and rated by', () => {
  const cfg = poolsThenSemisFinal();

  it('reads the stage scoring and the row\'s head starts', () => {
    expect(stagedMatchRules(cfg, { stage: 1, handicap_a: 5, handicap_b: 0 })).toEqual({
      bestOf: 1, target: 15, winByTwo: false, cap: null, startA: 5, startB: 0,
    });
    expect(stagedMatchRules(cfg, { stage: null })).toBeNull();
    expect(stagedMatchRules(cfg, { stage: 9 })).toBeNull();
    expect(stagedMatchRules(null, { stage: 1 })).toBeNull();
  });

  it('accepts the sheet\'s 15-14 and a head start, refuses a score below a start', () => {
    const rules = stagedMatchRules(cfg, { stage: 1, handicap_a: 5, handicap_b: 0 })!;
    expect(validateMatch([{ a: 15, b: 14 }], rules)).toEqual({ ok: true, winner: 'a' });
    expect(validateMatch([{ a: 5, b: 15 }], rules)).toEqual({ ok: true, winner: 'b' });
    expect(validateMatch([{ a: 4, b: 15 }], rules).ok).toBe(false);
  });

  it('a game cut short needs a winner, the starts, and nobody past the target', () => {
    const rules = stagedMatchRules(cfg, { stage: 1, handicap_a: 5, handicap_b: 0 })!;
    expect(isLegalCutShortGame({ a: 9, b: 7 }, rules)).toBe(true);
    expect(isLegalCutShortGame({ a: 9, b: 9 }, rules)).toBe(false);
    expect(isLegalCutShortGame({ a: 4, b: 2 }, rules)).toBe(false);
    expect(isLegalCutShortGame({ a: 16, b: 2 }, rules)).toBe(false);
    expect(validateMatch([{ a: 9, b: 7 }], rules).ok).toBe(false);
    expect(validateMatch([{ a: 9, b: 7 }], rules, { cutShort: true })).toEqual({ ok: true, winner: 'a' });
  });

  it('rates only a rated event\'s rated stages, reading the stored config raw', () => {
    const raw = JSON.parse(JSON.stringify(cfg));
    expect(stagedMatchRated({ rated: true, format_config: raw }, 1)).toBe(false);
    raw.stages[0].rated = true;
    expect(stagedMatchRated({ rated: true, format_config: raw }, 1)).toBe(true);
    delete raw.stages[0].rated;
    expect(stagedMatchRated({ rated: true, format_config: raw }, 1)).toBe(true);
    expect(stagedMatchRated({ rated: false, format_config: raw }, 1)).toBe(false);
    expect(stagedMatchRated({ rated: true }, null)).toBe(true);
    expect(stagedMatchRated({}, null)).toBe(true);
  });

  it('parses a stored config, and not a broken one', () => {
    expect(parseFormatConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
    expect(parseFormatConfig({ version: 2 })).toBeNull();
    expect(parseFormatConfig(null)).toBeNull();
  });
});
