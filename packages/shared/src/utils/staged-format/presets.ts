// Ready-made configs: the organiser's own event in three shapes, and the three
// legacy formats expressed as configs so old events read the same way.

import { ExpectedError } from '../expected-error';
import { getEventRules, pointsCap, type EventMatchShape } from '../constants';
import { POOL_LADDER_SHAPE } from '../tournament-phases';
import type { SeedBy } from '../standings';
import { defaultCategories, defaultHeadStarts } from './handicap';
import type {
  FormatConfig,
  GroupsStage,
  HeadStarts,
  FormatCategory,
  MatchesStage,
  SlotRef,
  StageMatchDef,
  StageScoring,
  StageTiebreak,
} from './schema';

export interface PoolsPresetOptions {
  pools?: number;
  groupsPerPool?: number;
  groupSize?: number | 'auto';
  /** One list of court names per pool. Default: two per pool, numbered 1, 2, 3, ... */
  courts?: string[][] | null;
  groupTarget?: number;
  finalsTarget?: number;
  /** poolsThenSemisFinal and groupsThenTopKnockout: play for third. Default true. */
  bronze?: boolean;
  /** groupsThenTopKnockout only: how many go through to the knockout, a power of 2. Default 4. */
  advance?: number;
  categories?: FormatCategory[];
  headStarts?: HeadStarts;
}

const STAGE_TIEBREAKS: StageTiebreak[] = ['wins', 'point_diff'];

function defaultCourts(pools: number): string[][] {
  return Array.from({ length: pools }, (_, i) => [String(2 * i + 1), String(2 * i + 2)]);
}

// Owner decision 7: the group stage is one game to 15 with no win by two (the
// sheet has a 15-14), the finals to 21 win by two capped at 30. Both handicapped,
// so both unrated (decision 6). Forfeits are target-0 (decision 5).
function groupScoring(target: number): StageScoring {
  return { bestOf: 1, target, winByTwo: false, cap: null, handicap: true, forfeit: { winner: target, loser: 0 } };
}

function finalsScoring(target: number): StageScoring {
  return { bestOf: 1, target, winByTwo: true, cap: pointsCap(target), handicap: true, forfeit: null };
}

function groupsStage(o: PoolsPresetOptions): GroupsStage {
  const pools = o.pools ?? 4;
  return {
    kind: 'groups',
    key: 'groups',
    name: 'Group stage',
    rated: false,
    scoring: groupScoring(o.groupTarget ?? 15),
    entrants: { from: 'field', order: 'elo' },
    pools,
    groupsPerPool: o.groupsPerPool ?? 2,
    groupSize: o.groupSize ?? 4,
    assignment: 'snake',
    interleave: true,
    courts: o.courts === null ? null : { mode: 'per_pool', pools: o.courts ?? defaultCourts(pools) },
    tiebreaks: STAGE_TIEBREAKS,
    poolRanking: 'best_group_winner',
  };
}

function base(o: PoolsPresetOptions, stages: FormatConfig['stages']): FormatConfig {
  return {
    version: 1,
    categories: o.categories ?? defaultCategories(),
    headStarts: o.headStarts ?? defaultHeadStarts(),
    stages,
  };
}

/** Places for N reseeded entrants: 1 v 2 for first, 3 v 4 for third, and so on. */
function placementMatches(count: number): StageMatchDef[] {
  if (count < 2 || count % 2 !== 0) {
    throw new ExpectedError('Placement matches need an even number of pool winners: use 2, 4, 6... pools.');
  }
  return Array.from({ length: count / 2 }, (_, i) => {
    const hi = 2 * i + 1;
    return {
      label: i === 0 ? 'final' : i === 1 ? 'third' : `place${hi}`,
      name: i === 0 ? 'Final' : i === 1 ? 'Third place' : `Place ${hi}`,
      a: { type: 'seed', n: hi },
      b: { type: 'seed', n: hi + 1 },
      winnerPlace: hi,
      loserPlace: hi + 1,
    } satisfies StageMatchDef;
  });
}

function finalsStage(o: PoolsPresetOptions, slots: SlotRef[]): MatchesStage {
  return {
    kind: 'matches',
    key: 'finals',
    name: 'Finals',
    rated: false,
    scoring: finalsScoring(o.finalsTarget ?? 21),
    entrants: {
      from: 'slots',
      slots,
      // Decision 8: the reseed reads the group stage only, never a playoff.
      reseed: { by: STAGE_TIEBREAKS, scope: 'source_stage', stage: 'groups' },
    },
    matches: placementMatches(slots.length),
  };
}

const poolWinners = (pools: number): SlotRef[] =>
  Array.from({ length: pools }, (_, i) => ({ type: 'pool_place', stage: 'groups', pool: i + 1, place: 1 }));

/** The organiser's event: pools of two groups, the best group winner per pool to the placement finals. */
export function poolsThenPlacement(opts: PoolsPresetOptions = {}): FormatConfig {
  const groups = groupsStage(opts);
  return base(opts, [groups, finalsStage(opts, poolWinners(groups.pools))]);
}

/** As poolsThenPlacement, but each pool's two group winners play off for the pool. */
export function poolsPlayoffThenPlacement(opts: PoolsPresetOptions = {}): FormatConfig {
  const groups = groupsStage(opts);
  if (groups.groupsPerPool !== 2) throw new ExpectedError('A pool playoff needs exactly two groups per pool.');
  const playoff: MatchesStage = {
    kind: 'matches',
    key: 'playoff',
    name: 'Pool playoffs',
    rated: false,
    scoring: groupScoring(opts.groupTarget ?? 15),
    entrants: {
      from: 'slots',
      slots: Array.from({ length: groups.pools }, (_, i) => [1, 2].map((group): SlotRef => (
        { type: 'group_place', stage: 'groups', pool: i + 1, group, place: 1 }
      ))).flat(),
    },
    matches: Array.from({ length: groups.pools }, (_, i) => ({
      label: `pool${i + 1}`,
      name: `G${i + 1} playoff`,
      a: { type: 'group_place', stage: 'groups', pool: i + 1, group: 1, place: 1 },
      b: { type: 'group_place', stage: 'groups', pool: i + 1, group: 2, place: 1 },
    })),
  };
  const winners: SlotRef[] = playoff.matches.map((m) => ({ type: 'match', stage: 'playoff', match: m.label, result: 'winner' }));
  return base(opts, [groups, playoff, finalsStage(opts, winners)]);
}

/** Four pools: semis pool 1 v pool 2 and pool 3 v pool 4, then a final and (by default) a bronze match. */
export function poolsThenSemisFinal(opts: PoolsPresetOptions = {}): FormatConfig {
  const groups = groupsStage(opts);
  if (groups.pools !== 4) throw new ExpectedError('Semi-finals from pools need exactly four pools.');
  const scoring = finalsScoring(opts.finalsTarget ?? 21);
  const winners = poolWinners(4);
  const semis: MatchesStage = {
    kind: 'matches',
    key: 'semis',
    name: 'Semi-finals',
    rated: false,
    scoring,
    entrants: { from: 'slots', slots: winners },
    matches: [
      { label: 'semi1', name: 'Semi-final 1', a: winners[0]!, b: winners[1]! },
      { label: 'semi2', name: 'Semi-final 2', a: winners[2]!, b: winners[3]! },
    ],
  };
  const ref = (match: string, result: 'winner' | 'loser'): SlotRef => ({ type: 'match', stage: 'semis', match, result });
  const finals: MatchesStage = {
    kind: 'matches',
    key: 'finals',
    name: 'Finals',
    rated: false,
    scoring,
    entrants: {
      from: 'slots',
      slots: [ref('semi1', 'winner'), ref('semi2', 'winner'), ...(opts.bronze === false ? [] : [ref('semi1', 'loser'), ref('semi2', 'loser')])],
    },
    matches: [
      { label: 'final', name: 'Final', a: ref('semi1', 'winner'), b: ref('semi2', 'winner'), winnerPlace: 1, loserPlace: 2 },
      ...(opts.bronze === false ? [] : [{
        label: 'bronze', name: 'Third place', a: ref('semi1', 'loser'), b: ref('semi2', 'loser'), winnerPlace: 3, loserPlace: 4,
      }]),
    ],
  };
  return base(opts, [groups, semis, finals]);
}

/**
 * Groups, then the best N overall to a knockout: every group winner first,
 * then the best runners-up across the groups, then the best thirds, until N
 * are in. N need not be a multiple of the groups (8 from 3 groups is the 3
 * winners, the 3 runners-up and the best 2 thirds). The group size fits the
 * turnout, so only the number of groups is set in advance. Plain scoring with
 * no head starts, and rated unless the event is not.
 */
export function groupsThenTopKnockout(opts: PoolsPresetOptions = {}): FormatConfig {
  const groupCount = opts.pools ?? 4;
  const advance = opts.advance ?? 4;
  if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount > 32) {
    throw new ExpectedError('Use between 1 and 32 groups.');
  }
  if (!Number.isInteger(advance) || advance < 2 || advance > 128 || (advance & (advance - 1)) !== 0) {
    throw new ExpectedError('The number going through must be 2, 4, 8, 16, 32, 64 or 128.');
  }
  const groupTarget = opts.groupTarget ?? 21;
  const finalsTarget = opts.finalsTarget ?? 21;
  const plain = (target: number): StageScoring => (
    { bestOf: 1, target, winByTwo: true, cap: pointsCap(target), handicap: false, forfeit: null }
  );
  const groups: GroupsStage = {
    kind: 'groups',
    key: 'groups',
    name: 'Group stage',
    rated: true,
    scoring: plain(groupTarget),
    entrants: { from: 'field', order: 'elo' },
    pools: groupCount,
    groupsPerPool: 1,
    groupSize: 'auto',
    assignment: 'snake',
    interleave: false,
    courts: opts.courts === null ? null : { mode: 'per_pool', pools: opts.courts ?? defaultCourts(groupCount) },
    tiebreaks: STAGE_TIEBREAKS,
    poolRanking: 'none',
  };
  // Place by place, each place ranked across the groups and only as many taken
  // as are still needed. With one group, its table is read top down.
  const slots: SlotRef[] = [];
  for (let place = 1, left = advance; left > 0; place++) {
    if (groupCount === 1) {
      slots.push({ type: 'group_place', stage: 'groups', pool: 1, group: 1, place });
      left -= 1;
    } else {
      const take = Math.min(groupCount, left);
      slots.push({ type: 'group_rank', stage: 'groups', place, rankBy: STAGE_TIEBREAKS, ...(take < groupCount ? { count: take } : {}) });
      left -= take;
    }
  }
  return base(opts, [groups, {
    kind: 'knockout',
    key: 'knockout',
    name: advance === 2 ? 'Final' : 'Knockout',
    rated: true,
    scoring: plain(finalsTarget),
    entrants: { from: 'slots', slots },
    size: advance,
    seeding: 'standard',
    thirdPlace: advance >= 4 && opts.bronze !== false,
  }]);
}

// ============================================================
// Legacy formats
// ============================================================

export interface LegacyEventFormat extends EventMatchShape {
  format: string;
  seed_by?: SeedBy | null;
  group_count?: number | null;
  qualifiers_per_group?: number | null;
  seeding_method?: 'elo' | 'manual' | 'random' | string | null;
  external_event?: boolean | null;
}

/**
 * The order sortStandings / rankRoundRobin rank a legacy table in. seed_by is
 * read on pool_to_bracket only: a round_robin's own table is always by wins
 * (finalize.ts), its seed_by describes the pool it was drawn from.
 */
function legacyTiebreaks(event: LegacyEventFormat): StageTiebreak[] {
  if (event.external_event) return ['wins', 'point_diff', 'points_for'];
  if (event.format === 'pool_to_bracket' && event.seed_by === 'points') {
    return ['points_for', 'h2h', 'game_diff', 'point_diff'];
  }
  return ['wins', 'h2h', 'game_diff', 'point_diff', 'points_for'];
}

/**
 * A legacy event as a config, for read-only uniform handling. Not stored.
 *
 * Approximations, all deliberate:
 *  - legacy h2h compares two entries at a time; here it is a mini-league among
 *    the tied set, which agrees for two-way ties;
 *  - across groups every count is divided by matches played, where the legacy
 *    compareAcrossGroups divides points by games played;
 *  - a pool_to_bracket knockout's per-round ladder (11/15/21/best of 3) cannot be
 *    said per stage, so the stage carries the event shape; per-match shape
 *    overrides (00108) still decide how each match is scored;
 *  - the third-place playoff is chosen when the draw is made and is not stored,
 *    so it is passed in.
 */
export function legacyFormatDefinition(event: LegacyEventFormat, opts: { thirdPlace?: boolean } = {}): FormatConfig {
  const rules = getEventRules(event);
  const scoringFor = (target: number, bestOf: number): StageScoring => ({
    bestOf: bestOf as StageScoring['bestOf'],
    target,
    winByTwo: true,
    cap: pointsCap(target),
    handicap: false,
    forfeit: null,
  });
  const rated = !event.external_event;
  const order = (event.seeding_method === 'random' || event.seeding_method === 'manual') ? event.seeding_method : 'elo';
  const tiebreaks = legacyTiebreaks(event);
  const groupCount = Math.max(1, event.group_count ?? 1);

  // One pool per legacy group, so labels still read "Group A", "Group B".
  const groups = (key: string, name: string, scoring: StageScoring): GroupsStage => ({
    kind: 'groups',
    key,
    name,
    rated,
    scoring,
    entrants: { from: 'field', order },
    pools: groupCount,
    groupsPerPool: 1,
    groupSize: 'auto',
    assignment: order === 'random' ? 'random' : 'snake',
    interleave: false,
    courts: null,
    tiebreaks,
    poolRanking: 'none',
  });

  const stages: FormatConfig['stages'] = [];
  if (event.format === 'round_robin') {
    stages.push(groups('groups', 'Round robin', scoringFor(rules.target, rules.bestOf)));
  } else if (event.format === 'pool_to_bracket') {
    stages.push(groups('pool', 'Round robin', scoringFor(POOL_LADDER_SHAPE.points_per_game, POOL_LADDER_SHAPE.games_per_match)));
    const perGroup = event.qualifiers_per_group ?? (groupCount >= 2 ? 2 : 4);
    const slots: SlotRef[] = groupCount >= 2
      ? Array.from({ length: perGroup }, (_, i) => ({ type: 'group_rank', stage: 'pool', place: i + 1, rankBy: tiebreaks, count: groupCount }))
      : Array.from({ length: perGroup }, (_, i) => ({ type: 'group_place', stage: 'pool', pool: 1, group: 1, place: i + 1 }));
    stages.push({
      kind: 'knockout', key: 'knockout', name: 'Knockout', rated,
      scoring: scoringFor(rules.target, rules.bestOf),
      entrants: { from: 'slots', slots },
      size: 'auto', seeding: 'standard', thirdPlace: opts.thirdPlace ?? false,
    });
  } else {
    stages.push({
      kind: 'knockout', key: 'main', name: 'Main draw', rated,
      scoring: scoringFor(rules.target, rules.bestOf),
      entrants: { from: 'field', order },
      size: 'auto', seeding: 'standard', thirdPlace: opts.thirdPlace ?? false,
    });
  }

  return { version: 1, categories: defaultCategories(), headStarts: {}, stages };
}
