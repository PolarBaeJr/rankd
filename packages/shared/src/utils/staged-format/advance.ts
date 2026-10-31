// Who fills each slot of a stage, read off the results of the stages before it.

import type { FormatConfig, FormatStage, GroupsStage, SlotRef, StageTiebreak } from './schema';
import { slotRefWidth } from './schema';
import {
  forfeitScore,
  isSettledStatus,
  rankStandings,
  tallyStage,
  type FormatResults,
  type StageMatchResult,
  type StageStandingRow,
} from './standings';
import { ordinal, stageGroupLabel } from './labels';

export interface ResolvedSlot {
  ref: SlotRef;
  /** Which of a group_rank ref's entrants this is, 0-based; 0 for every other ref. */
  index: number;
  entry: string | null;
  pendingReason?: string;
}

export function findStage(cfg: FormatConfig, key: string): FormatStage | undefined {
  return cfg.stages.find((s) => s.key === key);
}

function stageIndex(cfg: FormatConfig, key: string): number {
  return cfg.stages.findIndex((s) => s.key === key);
}

export function stageMatches(results: FormatResults, key: string): StageMatchResult[] {
  return results.matches.filter((m) => m.stage === key);
}

/** Has a stage been played out: at least one match, and every match settled. */
export function stageComplete(results: FormatResults, key: string): boolean {
  const ms = stageMatches(results, key);
  return ms.length > 0 && ms.every((m) => isSettledStatus(m.status));
}

function seedMap(results: FormatResults): Map<string, number | null> {
  return new Map(results.field.map((e) => [e.id, e.seed]));
}

function forfeitLookup(cfg: FormatConfig) {
  return (m: StageMatchResult) => {
    const s = findStage(cfg, m.stage);
    return s ? forfeitScore(s.scoring) : { winner: 0, loser: 0 };
  };
}

const outSet = (results: FormatResults) => new Set(results.out ?? []);

/** One group's table, best first, departed entries left out. */
export function groupTable(
  cfg: FormatConfig,
  stage: GroupsStage,
  results: FormatResults,
  pool: number,
  group: number,
): { rows: StageStandingRow[]; complete: boolean } {
  const members = results.groups.find((g) => g.stage === stage.key && g.pool === pool && g.group === group)?.members ?? [];
  const ms = stageMatches(results, stage.key).filter((m) => m.pool === pool && m.group === group);
  const tally = tallyStage(members, ms, forfeitLookup(cfg), seedMap(results));
  const out = outSet(results);
  const active = [...tally.values()].filter((r) => !out.has(r.id));
  const normalise = unevenSchedule(active.map((r) => r.id), ms, out);
  const rows = rankStandings(active, stage.tiebreaks, ms, normalise ? { normalise: true } : {});
  return { rows, complete: ms.length > 0 && ms.every((m) => isSettledStatus(m.status)) };
}

/**
 * Does one member of the group have more matches on its schedule than another.
 * Only then does the table rank per match played: a full round robin keeps the
 * raw counts it always had. Matches against a departed entry are left out,
 * because a withdrawal voids only the ones not yet played, which would make an
 * ordinary round robin look uneven. A voided match between two members still
 * counts for the same reason: it was drawn, and leaving it out would change how
 * an ordinary round robin with one void has always been ranked.
 */
function unevenSchedule(ids: readonly string[], ms: readonly StageMatchResult[], out: ReadonlySet<string>): boolean {
  const scheduled = new Map(ids.map((id) => [id, 0]));
  for (const m of ms) {
    if (!m.a || !m.b || out.has(m.a) || out.has(m.b)) continue;
    for (const id of [m.a, m.b]) if (scheduled.has(id)) scheduled.set(id, scheduled.get(id)! + 1);
  }
  return new Set(scheduled.values()).size > 1;
}

/** Every entry's record over the given stages, for ranking across groups. */
function recordOver(cfg: FormatConfig, results: FormatResults, stageKeys: readonly string[], ids: readonly string[]) {
  const keys = new Set(stageKeys);
  const ms = results.matches.filter((m) => keys.has(m.stage));
  return { rows: tallyStage(ids, ms, forfeitLookup(cfg), seedMap(results)), matches: ms };
}

/** Rank entries from different groups: counts per match played, so unequal groups compare fairly. */
function rankAcross(
  cfg: FormatConfig,
  results: FormatResults,
  stageKeys: readonly string[],
  ids: readonly string[],
  by: readonly StageTiebreak[],
  fallback?: readonly string[],
): string[] {
  const { rows, matches } = recordOver(cfg, results, stageKeys, ids);
  return rankStandings(ids.map((id) => rows.get(id)!), by, matches, { normalise: true, fallback }).map((r) => r.id);
}

function groupsOf(results: FormatResults, stage: GroupsStage, pool?: number) {
  return results.groups
    .filter((g) => g.stage === stage.key && (pool == null || g.pool === pool))
    .sort((x, y) => x.pool - y.pool || x.group - y.group);
}

function resolveDirect(cfg: FormatConfig, ref: Exclude<SlotRef, { type: 'seed' }>, results: FormatResults): ResolvedSlot[] {
  const pending = (pendingReason: string, index = 0): ResolvedSlot => ({ ref, index, entry: null, pendingReason });
  const source = findStage(cfg, ref.stage);
  if (!source) return [pending(`There is no stage "${ref.stage}".`)];

  if (ref.type === 'match') {
    const m = stageMatches(results, ref.stage).find((x) => x.label === ref.match);
    if (!m) return [pending(`"${ref.match}" has not been drawn.`)];
    if (!isSettledStatus(m.status) || m.status === 'voided' || !m.winner) return [pending(`"${ref.match}" is not finished.`)];
    const loser = m.winner === m.a ? m.b : m.a;
    return [{ ref, index: 0, entry: ref.result === 'winner' ? m.winner : loser }];
  }

  if (source.kind !== 'groups') return [pending(`"${ref.stage}" has no groups.`)];

  if (ref.type === 'group_place') {
    const t = groupTable(cfg, source, results, ref.pool, ref.group);
    if (!t.complete) return [pending(`${stageGroupLabel(source, ref.pool, ref.group)} is not finished.`)];
    const row = t.rows[ref.place - 1];
    return [row ? { ref, index: 0, entry: row.id } : pending(`That group has no ${ordinal(ref.place)} place.`)];
  }

  if (ref.type === 'pool_place') {
    // best_group_winner: the pool's group winners ranked by the stage tiebreaks.
    const tables = groupsOf(results, source, ref.pool).map((g) => groupTable(cfg, source, results, g.pool, g.group));
    if (tables.length === 0 || tables.some((t) => !t.complete)) return [pending(`Pool ${ref.pool} is not finished.`)];
    const winners = tables.map((t) => t.rows[0]?.id).filter((id): id is string => id != null);
    const ranked = rankAcross(cfg, results, [source.key], winners, source.tiebreaks, winners);
    const id = ranked[ref.place - 1];
    return [id ? { ref, index: 0, entry: id } : pending(`Pool ${ref.pool} has no ${ordinal(ref.place)} group winner.`)];
  }

  // group_rank
  const width = slotRefWidth(ref, source);
  const tables = groupsOf(results, source).map((g) => groupTable(cfg, source, results, g.pool, g.group));
  if (tables.length === 0 || tables.some((t) => !t.complete)) {
    return Array.from({ length: width }, (_, i) => pending(`"${source.name}" is not finished.`, i));
  }
  const candidates = tables.map((t) => t.rows[ref.place - 1]?.id).filter((id): id is string => id != null);
  const ranked = rankAcross(cfg, results, [source.key], candidates, ref.rankBy, candidates);
  return Array.from({ length: width }, (_, i) => {
    const id = ranked[i];
    return id ? { ref, index: i, entry: id } : pending(`No group has another ${ordinal(ref.place)} place.`, i);
  });
}

/**
 * The stage's entrant slots, in order, each with its entry or why it is still
 * empty. A stage drawn from the field has no slots and returns [].
 */
export function resolveSlots(cfg: FormatConfig, stageKey: string, results: FormatResults): ResolvedSlot[] {
  const stage = findStage(cfg, stageKey);
  if (!stage || stage.entrants.from !== 'slots') return [];
  return stage.entrants.slots.flatMap((ref) =>
    ref.type === 'seed'
      ? [{ ref, index: 0, entry: null, pendingReason: 'A seed is not an entrant slot.' }]
      : resolveDirect(cfg, ref, results));
}

/** The stages whose record a reseed reads. */
function reseedStages(cfg: FormatConfig, stage: FormatStage): string[] {
  if (stage.entrants.from !== 'slots' || !stage.entrants.reseed) return [];
  const { reseed, slots } = stage.entrants;
  if (reseed.scope === 'all_prior') return cfg.stages.slice(0, stageIndex(cfg, stage.key)).map((s) => s.key);
  if (reseed.stage) return [reseed.stage];
  for (const r of slots) if (r.type !== 'seed') return [r.stage];
  return [];
}

/**
 * The stage's entrants in seed order after the reseed, or null while any slot
 * is still empty. Without a reseed, the slot order is the seed order.
 */
export function reseededEntrants(cfg: FormatConfig, stageKey: string, results: FormatResults): string[] | null {
  const stage = findStage(cfg, stageKey);
  if (!stage || stage.entrants.from !== 'slots') return null;
  const slots = resolveSlots(cfg, stageKey, results);
  if (slots.some((s) => s.entry == null)) return null;
  const ids = slots.map((s) => s.entry!);
  if (!stage.entrants.reseed) return ids;
  return rankAcross(cfg, results, reseedStages(cfg, stage), ids, stage.entrants.reseed.by, ids);
}

export interface ResolvedStageMatch {
  label: string;
  a: ResolvedSlot;
  b: ResolvedSlot;
}

/** A 'matches' stage's fixtures with both sides resolved, seeds included. */
export function resolveStageMatches(cfg: FormatConfig, stageKey: string, results: FormatResults): ResolvedStageMatch[] {
  const stage = findStage(cfg, stageKey);
  if (!stage || stage.kind !== 'matches') return [];
  let seeds: string[] | null | undefined;
  const side = (ref: SlotRef): ResolvedSlot => {
    if (ref.type !== 'seed') return resolveDirect(cfg, ref, results)[0]!;
    if (seeds === undefined) seeds = reseededEntrants(cfg, stageKey, results);
    const id = seeds?.[ref.n - 1];
    return id ? { ref, index: 0, entry: id } : { ref, index: 0, entry: null, pendingReason: 'The seeds are not settled yet.' };
  };
  return stage.matches.map((m) => ({ label: m.label, a: side(m.a), b: side(m.b) }));
}

/** The earlier stages a stage reads from. */
export function sourceStages(cfg: FormatConfig, stageKey: string): string[] {
  const stage = findStage(cfg, stageKey);
  if (!stage || stage.entrants.from !== 'slots') return [];
  const keys = new Set<string>();
  const add = (ref: SlotRef) => { if (ref.type !== 'seed') keys.add(ref.stage); };
  stage.entrants.slots.forEach(add);
  if (stage.kind === 'matches') stage.matches.forEach((m) => { add(m.a); add(m.b); });
  reseedStages(cfg, stage).forEach((k) => keys.add(k));
  return cfg.stages.map((s) => s.key).filter((k) => keys.has(k));
}

/** Owner decision 9: a stage can be drawn only once every stage it reads from is played out. */
export function stageReady(cfg: FormatConfig, stageKey: string, results: FormatResults): boolean {
  const stage = findStage(cfg, stageKey);
  if (!stage) return false;
  return sourceStages(cfg, stageKey).every((k) => stageComplete(results, k));
}
