// The rows one stage's draw inserts. Pure: the same config, entrants, rng and
// id source give the same rows, so a draw can be reproduced from its audit row.

import { ExpectedError } from '../expected-error';
import { getRoundName, nextPowerOf2 } from '../constants';
import { getStandardSeedPositions } from '../draw-order';
import { stageMatchRules } from './handicap';
import { planStageGroups, scheduleStage, type ScheduledStageMatch } from './groups';
import { findStage, resolveStageMatches } from './advance';
import type { FormatConfig, FormatStage, KnockoutStage, MatchesStage } from './schema';
import type { FormatResults } from './standings';

export interface StageEntrant {
  id: string;
  /** The team category head starts are read by; null for none. */
  category?: string | null;
}

export interface StageRow {
  id: string;
  draw_generation_id: string;
  stage: number;
  pool_number: number | null;
  group_number: number | null;
  slot: number | null;
  match_label: string | null;
  court: string | null;
  round_number: number;
  round_name: string;
  bracket_position: number;
  match_number: number;
  games_per_match: number;
  points_per_game: number;
  handicap_a: number;
  handicap_b: number;
  is_bye: boolean;
  is_third_place: boolean;
  status: 'pending' | 'ready' | 'completed';
  winner_to_match_id: string | null;
  winner_to_position: 'a' | 'b' | null;
  loser_to_match_id: string | null;
  loser_to_position: 'a' | 'b' | null;
  /** Entrant ids. The caller writes them to the pair or participant columns. */
  a: string | null;
  b: string | null;
  /** The entrant a bye sends through; null on every other row. */
  winner: string | null;
}

export interface BuildStageOptions {
  /** Drives random group assignment. Default: Math.random. */
  rng?: () => number;
  /** Row ids, so a knockout can be wired before it is inserted. Default: crypto.randomUUID. */
  newId?: () => string;
  /** Required for a 'matches' stage: the results its fixtures resolve against. */
  results?: FormatResults;
  /** The first match number; later stages continue the event's numbering. Default 1. */
  firstMatchNumber?: number;
}

export const STAGE_THIRD_PLACE_ROUND_NAME = '3rd Place Playoff';

type Sides = { a: string | null; b: string | null };

/**
 * Every row of one stage's draw.
 *
 * `entrants` is the stage's field in seed order (best first) for a groups or
 * knockout stage. A 'matches' stage takes its fixtures from `opts.results` and
 * reads `entrants` only for categories, so pass everyone who can appear.
 *
 * Head starts are snapshotted on the row when both sides are known; a knockout
 * row whose sides arrive later is settled when they do.
 */
export function buildStageRows(
  cfg: FormatConfig,
  stageKey: string,
  entrants: readonly StageEntrant[],
  generation: string,
  opts: BuildStageOptions = {},
): StageRow[] {
  const index = cfg.stages.findIndex((s) => s.key === stageKey);
  const stage = findStage(cfg, stageKey);
  if (!stage || index < 0) throw new ExpectedError(`There is no stage "${stageKey}".`);

  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const categories = new Map(entrants.map((e) => [e.id, e.category ?? null]));
  const starts = (s: Sides) => {
    if (!s.a || !s.b) return { handicap_a: 0, handicap_b: 0 };
    const r = stageMatchRules(cfg, stage, categories.get(s.a), categories.get(s.b));
    return { handicap_a: r.startA, handicap_b: r.startB };
  };
  const base = {
    draw_generation_id: generation,
    stage: index + 1,
    games_per_match: stage.scoring.bestOf,
    points_per_game: stage.scoring.target,
  };
  const first = opts.firstMatchNumber ?? 1;

  switch (stage.kind) {
    case 'groups': {
      const planned = planStageGroups(entrants, stage, opts.rng ?? Math.random);
      const schedule = scheduleStage(planned, stage, (e) => e.id);
      return groupScheduleRows(cfg, stageKey, schedule, generation, { newId, firstMatchNumber: first });
    }
    case 'knockout':
      return knockoutRows(stage, entrants, newId, base, first, starts);
    case 'matches':
      return matchesRows(cfg, stage, opts.results, newId, base, first, starts);
  }
}

type Base = Pick<StageRow, 'draw_generation_id' | 'stage' | 'games_per_match' | 'points_per_game'>;
type Starts = (s: Sides) => Pick<StageRow, 'handicap_a' | 'handicap_b'>;

const unrouted = {
  winner_to_match_id: null, winner_to_position: null, loser_to_match_id: null, loser_to_position: null,
} as const;

/**
 * The rows for a groups stage's scheduled matches. The draw passes the whole
 * schedule; a round added later passes only its own, with slots that start
 * after the stage's last one, so the per-slot positions below cannot collide
 * with a row already stored.
 */
export function groupScheduleRows(
  cfg: FormatConfig,
  stageKey: string,
  schedule: ReadonlyArray<ScheduledStageMatch<StageEntrant>>,
  generation: string,
  opts: { newId?: () => string; firstMatchNumber: number },
): StageRow[] {
  const index = cfg.stages.findIndex((s) => s.key === stageKey);
  const stage = findStage(cfg, stageKey);
  if (!stage || index < 0 || stage.kind !== 'groups') throw new ExpectedError(`There is no groups stage "${stageKey}".`);
  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const first = opts.firstMatchNumber;
  const base: Base = {
    draw_generation_id: generation,
    stage: index + 1,
    games_per_match: stage.scoring.bestOf,
    points_per_game: stage.scoring.target,
  };
  const starts = (a: StageEntrant, b: StageEntrant) => {
    const r = stageMatchRules(cfg, stage, a.category ?? null, b.category ?? null);
    return { handicap_a: r.startA, handicap_b: r.startB };
  };
  // round_number is the slot. Slots repeat across pools, so the position is a
  // counter per slot across the whole stage (the per-stage unique index).
  const positionInSlot = new Map<number, number>();
  return schedule.map((m): StageRow => {
    const pos = positionInSlot.get(m.slot) ?? 0;
    positionInSlot.set(m.slot, pos + 1);
    const sides = { a: m.a.id, b: m.b.id };
    return {
      ...base,
      ...unrouted,
      ...starts(m.a, m.b),
      ...sides,
      id: newId(),
      pool_number: m.pool,
      group_number: m.group,
      slot: m.slot,
      match_label: null,
      court: m.court,
      round_number: m.slot,
      round_name: `Round ${m.slot}`,
      bracket_position: pos,
      match_number: first + m.matchNumber - 1,
      is_bye: false,
      is_third_place: false,
      status: 'ready',
      winner: null,
    };
  });
}

function knockoutRows(
  stage: KnockoutStage,
  entrants: readonly StageEntrant[],
  newId: () => string,
  base: Base,
  first: number,
  starts: Starts,
): StageRow[] {
  const n = entrants.length;
  if (n < 2) throw new ExpectedError(`"${stage.name}" needs at least 2 entrants.`);
  const size = stage.size === 'auto' ? nextPowerOf2(n) : stage.size;
  if (n > size) throw new ExpectedError(`${n} entrants do not fit a draw of ${size}.`);
  // A first-round match with nobody in it would leave a hole the bye logic
  // cannot fill. 'auto' never produces one.
  if (n <= size / 2) {
    throw new ExpectedError(`${n} entrants would leave whole matches empty in a draw of ${size}. Use a smaller draw.`);
  }

  const lines: Array<string | null> = new Array(size).fill(null);
  if (stage.seeding === 'as_listed') {
    entrants.forEach((e, i) => { lines[i] = e.id; });
  } else {
    getStandardSeedPositions(size).forEach((rank, pos) => { lines[pos] = entrants[rank - 1]?.id ?? null; });
  }

  const rounds = Math.log2(size);
  const ids: string[][] = [];
  for (let r = 1; r <= rounds; r++) ids[r] = Array.from({ length: size / 2 ** r }, () => newId());

  const sides = new Map<string, Sides>();
  for (let r = 1; r <= rounds; r++) for (const id of ids[r]!) sides.set(id, { a: null, b: null });
  const byeWinner = new Map<string, string>();
  ids[1]!.forEach((id, p) => {
    const s = { a: lines[2 * p] ?? null, b: lines[2 * p + 1] ?? null };
    sides.set(id, s);
    if ((s.a == null) !== (s.b == null)) {
      const through = (s.a ?? s.b)!;
      byeWinner.set(id, through);
      if (rounds > 1) {
        const next = sides.get(ids[2]![Math.floor(p / 2)]!)!;
        if (p % 2 === 0) next.a = through;
        else next.b = through;
      }
    }
  });

  const rows: StageRow[] = [];
  let number = first;
  for (let r = 1; r <= rounds; r++) {
    ids[r]!.forEach((id, p) => {
      const s = sides.get(id)!;
      const bye = byeWinner.get(id) ?? null;
      rows.push({
        ...base,
        ...unrouted,
        ...starts(s),
        ...s,
        id,
        pool_number: null,
        group_number: null,
        slot: null,
        match_label: null,
        court: null,
        round_number: r,
        round_name: getRoundName(r, rounds),
        bracket_position: p,
        match_number: number++,
        winner_to_match_id: r < rounds ? ids[r + 1]![Math.floor(p / 2)]! : null,
        winner_to_position: r < rounds ? (p % 2 === 0 ? 'a' : 'b') : null,
        is_bye: bye != null,
        is_third_place: false,
        status: bye ? 'completed' : s.a && s.b ? 'ready' : 'pending',
        winner: bye,
      });
    });
  }

  if (stage.thirdPlace && rounds >= 2) {
    const thirdId = newId();
    ids[rounds - 1]!.forEach((semiId, i) => {
      const semi = rows.find((x) => x.id === semiId)!;
      semi.loser_to_match_id = thirdId;
      semi.loser_to_position = i === 0 ? 'a' : 'b';
    });
    rows.push({
      ...base,
      ...unrouted,
      handicap_a: 0,
      handicap_b: 0,
      a: null,
      b: null,
      id: thirdId,
      pool_number: null,
      group_number: null,
      slot: null,
      match_label: null,
      court: null,
      round_number: rounds,
      round_name: STAGE_THIRD_PLACE_ROUND_NAME,
      bracket_position: 1,
      match_number: number++,
      is_bye: false,
      is_third_place: true,
      status: 'pending',
      winner: null,
    });
  }
  return rows;
}

function matchesRows(
  cfg: FormatConfig,
  stage: MatchesStage,
  results: FormatResults | undefined,
  newId: () => string,
  base: Base,
  first: number,
  starts: Starts,
): StageRow[] {
  if (!results) throw new Error(`buildStageRows: "${stage.key}" is a matches stage and needs the results.`);
  const resolved = resolveStageMatches(cfg, stage.key, results);
  return stage.matches.map((def, i): StageRow => {
    const m = resolved[i]!;
    const pending = m.a.entry == null ? m.a : m.b.entry == null ? m.b : null;
    if (pending) throw new ExpectedError(`${def.name}: ${pending.pendingReason ?? 'a side is not known yet.'}`);
    const sides = { a: m.a.entry, b: m.b.entry };
    return {
      ...base,
      ...unrouted,
      ...starts(sides),
      ...sides,
      id: newId(),
      pool_number: null,
      group_number: null,
      slot: null,
      match_label: def.label,
      court: def.court ?? null,
      round_number: 1,
      round_name: def.name,
      bracket_position: i,
      match_number: first + i,
      is_bye: false,
      is_third_place: false,
      status: 'ready',
      winner: null,
    };
  });
}

/** The 1-based stage number a stage key is stored under. */
export function stageNumber(cfg: FormatConfig, stageKey: string): number | null {
  const i = cfg.stages.findIndex((s) => s.key === stageKey);
  return i < 0 ? null : i + 1;
}

/** The stage stored under a 1-based number. */
export function stageAt(cfg: FormatConfig, stage: number | null | undefined): FormatStage | undefined {
  return stage == null ? undefined : cfg.stages[stage - 1];
}
