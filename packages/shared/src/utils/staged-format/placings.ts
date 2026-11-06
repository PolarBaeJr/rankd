// Where everybody finished, and the points that earns.

import type { FormatConfig, FormatStage, GroupsStage, StageTiebreak } from './schema';
import { findStage, groupTable, stageMatches } from './advance';
import { defaultPointsTable, pointsForPlace } from './points';
import {
  forfeitScore,
  isSettledStatus,
  isTalliedStatus,
  rankStandings,
  tallyStage,
  type FormatResults,
  type StageMatchResult,
} from './standings';

const PLAYED_ORDER: StageTiebreak[] = ['wins', 'point_diff', 'points_for'];

function seedMap(results: FormatResults): Map<string, number | null> {
  return new Map(results.field.map((e) => [e.id, e.seed]));
}

/** Rank a set of entries by their record in one stage, per match played. */
function rankInStage(
  cfg: FormatConfig,
  stage: FormatStage,
  results: FormatResults,
  ids: readonly string[],
  tiebreaks: readonly StageTiebreak[],
): string[] {
  const ms = stageMatches(results, stage.key);
  const rows = tallyStage(ids, ms, (m) => forfeitScore(findStage(cfg, m.stage)?.scoring ?? stage.scoring), seedMap(results));
  return rankStandings(ids.map((id) => rows.get(id)!), tiebreaks, ms, { normalise: true }).map((r) => r.id);
}

/** A groups stage read as one list: every group winner, then every runner-up, and so on. */
function groupsOrder(cfg: FormatConfig, stage: GroupsStage, results: FormatResults, ids: Set<string>): string[] {
  const tables = results.groups
    .filter((g) => g.stage === stage.key)
    .sort((x, y) => x.pool - y.pool || x.group - y.group)
    .map((g) => groupTable(cfg, stage, results, g.pool, g.group).rows.map((r) => r.id));
  const deepest = tables.reduce((m, t) => Math.max(m, t.length), 0);
  const out: string[] = [];
  // Depth is the place in the FULL group table: an entry that went on to a
  // later stage is skipped here, and must not lift its group's runner-up into
  // the winners' tier.
  for (let d = 0; d < deepest; d++) {
    const tier = tables.map((t) => t[d]).filter((id): id is string => id != null && ids.has(id));
    out.push(...rankInStage(cfg, stage, results, tier, stage.tiebreaks));
  }
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/** A knockout read by how far each entry got: champion, finalist, third, fourth, then by round lost in. */
function knockoutOrder(cfg: FormatConfig, stage: FormatStage, results: FormatResults, ids: Set<string>): string[] {
  const ms = stageMatches(results, stage.key);
  const main = ms.filter((m) => !m.thirdPlace);
  const rounds = main.reduce((r, m) => Math.max(r, m.round ?? 0), 0);
  const tier = new Map<string, number>();
  const decided = (m: StageMatchResult) => isTalliedStatus(m.status) && m.winner != null;
  const loserOf = (m: StageMatchResult) => (m.winner === m.a ? m.b : m.a);

  for (const m of main) {
    if (!decided(m) || m.round == null) continue;
    const loser = loserOf(m);
    if (loser) tier.set(loser, 2 ** (rounds - m.round) + 1);
    if (m.round === rounds) tier.set(m.winner!, 1);
  }
  for (const m of ms.filter((x) => x.thirdPlace && decided(x))) {
    tier.set(m.winner!, 3);
    const loser = loserOf(m);
    if (loser) tier.set(loser, 4);
  }

  const ranked = rankInStage(cfg, stage, results, [...ids], PLAYED_ORDER);
  const pos = new Map(ranked.map((id, i) => [id, i]));
  // Still in the draw (unfinished) sorts with the best possible tier for its round.
  return [...ids].sort((x, y) => (tier.get(x) ?? 0) - (tier.get(y) ?? 0) || pos.get(x)! - pos.get(y)!);
}

/**
 * Every entry's final place, 1..N with no ties, for every entry that played.
 *
 *  1. explicit winnerPlace / loserPlace of finished 'matches' stage fixtures;
 *  2. everyone else after the last explicit place, those who went further
 *     (a later last stage) first, then by that stage's own order: knockout
 *     depth, group finishing place then record, or record in a 'matches' stage;
 *  3. still level: seed, then id, so the answer never depends on input order.
 *
 * An entry in no group and on no match of any stage was never drawn (left out
 * for not checking in, say) and gets no place, so no ladder points. Nor does a
 * no-show who was drawn: formatResultsFrom puts it in `out`.
 *
 * `placeNeverDrawn` (the console's kill switch placings_skip_never_played,
 * off) puts the never-drawn back at the very bottom, by seed, as before.
 */
export function finalPlacings(
  cfg: FormatConfig,
  results: FormatResults,
  opts: { placeNeverDrawn?: boolean } = {},
): Map<string, number> {
  const out = new Set(results.out ?? []);
  const participants = results.field.map((e) => e.id).filter((id) => !out.has(id));
  const placed = new Map<string, number>();

  for (const stage of cfg.stages) {
    if (stage.kind !== 'matches') continue;
    for (const def of stage.matches) {
      const m = stageMatches(results, stage.key).find((x) => x.label === def.label);
      if (!m || !isSettledStatus(m.status) || !m.winner) continue;
      const loser = m.winner === m.a ? m.b : m.a;
      if (def.winnerPlace != null && !out.has(m.winner)) placed.set(m.winner, def.winnerPlace);
      if (def.loserPlace != null && loser && !out.has(loser)) placed.set(loser, def.loserPlace);
    }
  }

  const lastStage = new Map<string, number>();
  cfg.stages.forEach((stage, si) => {
    for (const g of results.groups) if (g.stage === stage.key) g.members.forEach((id) => lastStage.set(id, si));
    for (const m of stageMatches(results, stage.key)) {
      if (m.a) lastStage.set(m.a, si);
      if (m.b) lastStage.set(m.b, si);
    }
  });

  const rest = participants.filter((id) => !placed.has(id));
  const order: string[] = [];
  const bottom = opts.placeNeverDrawn ? -1 : 0;
  for (let si = cfg.stages.length - 1; si >= bottom; si--) {
    const ids = new Set(rest.filter((id) => (lastStage.get(id) ?? -1) === si));
    if (ids.size === 0) continue;
    const stage = cfg.stages[si];
    if (!stage) {
      const seeds = seedMap(results);
      order.push(...[...ids].sort((x, y) =>
        (seeds.get(x) ?? Infinity) - (seeds.get(y) ?? Infinity) || (x < y ? -1 : x > y ? 1 : 0)));
    } else if (stage.kind === 'groups') {
      order.push(...groupsOrder(cfg, stage, results, ids));
    } else if (stage.kind === 'knockout') {
      order.push(...knockoutOrder(cfg, stage, results, ids));
    } else {
      order.push(...rankInStage(cfg, stage, results, [...ids], PLAYED_ORDER));
    }
  }

  let next = placed.size ? Math.max(...placed.values()) + 1 : 1;
  for (const id of order) placed.set(id, next++);
  return placed;
}

/**
 * Ladder points for a finish. With no points table on the config the default
 * applies: the round robin's when the event ends in groups, the knockout's
 * otherwise (defaultPointsTable).
 */
export function pointsFor(cfg: FormatConfig, place: number, wins: number): number {
  const last = cfg.stages[cfg.stages.length - 1];
  return pointsForPlace(cfg.points ?? defaultPointsTable('staged', last?.kind), place, wins);
}
