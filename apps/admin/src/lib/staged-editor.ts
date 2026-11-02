// The staged-format editor's logic, kept out of the component so it can be
// tested: no test here mounts a component. Every function takes a config and
// returns a new one; the component only renders and calls these.

import {
  ExpectedError,
  checkFormatConfig,
  poolsPlayoffThenPlacement,
  poolsThenPlacement,
  poolsThenSemisFinal,
  groupsThenTopKnockout,
  ordinal,
  parseCourtList,
  slotRefLabel,
  slotRefWidth,
  stagedConfigEditRefusal,
  totalGroups,
  withEveryStageUnrated,
  type FormatConfig,
  type FormatStage,
  type GroupsStage,
  type PoolsPresetOptions,
  type SlotRef,
  type StageMatchDef,
  type StageScoring,
} from '@badminton/shared';

export type StagedPresetName = 'groupsThenTopKnockout' | 'poolsThenPlacement' | 'poolsPlayoffThenPlacement' | 'poolsThenSemisFinal';

export const STAGED_PRESETS: Array<{ value: StagedPresetName; label: string }> = [
  { value: 'groupsThenTopKnockout', label: 'Groups, then the top N to a knockout' },
  { value: 'poolsThenPlacement', label: 'Pools, then placement matches' },
  { value: 'poolsPlayoffThenPlacement', label: 'Pools, a playoff per pool, then placement matches' },
  { value: 'poolsThenSemisFinal', label: 'Four pools, then semi-finals and a final' },
];

/** A preset, or the reason it cannot be built from these options. */
export function presetConfig(
  name: StagedPresetName,
  opts: PoolsPresetOptions,
  external: boolean,
): { ok: true; config: FormatConfig } | { ok: false; error: string } {
  try {
    const build = name === 'groupsThenTopKnockout' ? groupsThenTopKnockout
      : name === 'poolsThenPlacement' ? poolsThenPlacement
      : name === 'poolsPlayoffThenPlacement' ? poolsPlayoffThenPlacement
        : poolsThenSemisFinal;
    const config = build(opts);
    return { ok: true, config: external ? withEveryStageUnrated(config) : config };
  } catch (e) {
    if (e instanceof ExpectedError) return { ok: false, error: e.message };
    throw e;
  }
}

/** The first `${prefix}N` not already taken. Keys and labels are generated, never typed. */
export function nextKey(taken: readonly string[], prefix: string): string {
  for (let n = 1; ; n++) if (!taken.includes(`${prefix}${n}`)) return `${prefix}${n}`;
}

export const DEFAULT_STAGE_SCORING: StageScoring = {
  bestOf: 1, target: 21, winByTwo: true, cap: 30, handicap: false, forfeit: null,
};

export interface SlotOption {
  /** JSON of the ref, so a Select can carry it. */
  value: string;
  label: string;
  ref: SlotRef;
}

/**
 * Every place a slot in stage `index` can take an entrant from: the places of
 * each earlier groups stage, its pool winners when it ranks its pools, the
 * winner and loser of each earlier named match, and the seeds of this stage
 * when it reseeds. A match side takes one entrant, so a best-of-place there is
 * offered as the single best one.
 */
/**
 * A slot as the editor lists it. A best-of-place ref can stand for several
 * entrants (every group's winner, or the best two thirds), so it is named as a
 * whole here; slotRefLabel names one entrant out of it, which is what a drawn
 * match shows.
 */
export function editorSlotLabel(ref: SlotRef, cfg: FormatConfig): string {
  if (ref.type !== 'group_rank') return slotRefLabel(ref, cfg);
  const place = ordinal(ref.place);
  if (ref.count == null) return `Every group's ${place} place`;
  if (ref.count === 1) return `The best ${place} place`;
  return `The best ${ref.count} of the ${place} places`;
}

export function slotOptions(cfg: FormatConfig, index: number, inMatch: boolean): SlotOption[] {
  const out: SlotOption[] = [];
  const add = (ref: SlotRef) => out.push({ value: slotValue(ref), label: editorSlotLabel(ref, cfg), ref });
  const stage = cfg.stages[index];
  if (inMatch && stage?.entrants.from === 'slots' && stage.entrants.reseed) {
    const seeds = stage.entrants.slots.reduce(
      (n, ref) => n + slotRefWidth(ref, ref.type === 'seed' ? undefined : cfg.stages.find((s) => s.key === ref.stage)),
      0,
    );
    for (let n = 1; n <= seeds; n++) add({ type: 'seed', n });
  }
  for (const source of cfg.stages.slice(0, index)) {
    if (source.kind === 'groups') {
      const places = source.groupSize === 'auto' ? 4 : source.groupSize;
      for (let pool = 1; pool <= source.pools; pool++) {
        if (source.poolRanking !== 'none') {
          for (let place = 1; place <= source.groupsPerPool; place++) add({ type: 'pool_place', stage: source.key, pool, place });
        }
        for (let group = 1; group <= source.groupsPerPool; group++) {
          for (let place = 1; place <= places; place++) add({ type: 'group_place', stage: source.key, pool, group, place });
        }
      }
      if (totalGroups(source) > 1) {
        for (let place = 1; place <= places; place++) {
          add({ type: 'group_rank', stage: source.key, place, rankBy: ['wins', 'point_diff'], ...(inMatch ? { count: 1 } : {}) });
        }
      }
    } else if (source.kind === 'matches') {
      for (const m of source.matches) {
        add({ type: 'match', stage: source.key, match: m.label, result: 'winner' });
        add({ type: 'match', stage: source.key, match: m.label, result: 'loser' });
      }
    }
  }
  return out;
}

/** A ref as a Select value: JSON with its keys sorted, so a stored ref finds its option whatever order it was written in. */
export function slotValue(ref: SlotRef): string {
  return JSON.stringify(ref, Object.keys(ref).sort());
}

/** The options for one slot, with the slot's current ref added when it is not among them. */
export function slotOptionsFor(cfg: FormatConfig, index: number, inMatch: boolean, current: SlotRef): SlotOption[] {
  const opts = slotOptions(cfg, index, inMatch);
  const value = slotValue(current);
  return opts.some((o) => o.value === value) ? opts : [{ value, label: editorSlotLabel(current, cfg), ref: current }, ...opts];
}

function defaultEntrants(cfg: FormatConfig, index: number): FormatStage['entrants'] {
  if (index === 0) return { from: 'field', order: 'elo' };
  const first = slotOptions(cfg, index, false).find((o) => o.ref.type !== 'seed');
  return { from: 'slots', slots: first ? [first.ref] : [] };
}

function defaultMatches(cfg: FormatConfig, index: number): StageMatchDef[] {
  const opts = slotOptions(cfg, index, true).filter((o) => o.ref.type !== 'seed');
  return [{
    label: 'm1',
    name: 'Match 1',
    a: opts[0]?.ref ?? { type: 'seed', n: 1 },
    b: opts[1]?.ref ?? opts[0]?.ref ?? { type: 'seed', n: 2 },
  }];
}

function stageOfKind(cfg: FormatConfig, index: number, kind: FormatStage['kind'], from: Partial<FormatStage>): FormatStage {
  const common = {
    key: from.key ?? nextKey(cfg.stages.map((s) => s.key), 'stage'),
    name: from.name ?? `Stage ${index + 1}`,
    rated: from.rated ?? false,
    scoring: from.scoring ?? DEFAULT_STAGE_SCORING,
    entrants: from.entrants ?? defaultEntrants(cfg, index),
  };
  if (kind === 'groups') {
    return {
      ...common, kind, pools: 1, groupsPerPool: 1, groupSize: 4, assignment: 'snake', interleave: false,
      courts: null, tiebreaks: ['wins', 'point_diff'], poolRanking: 'none',
    };
  }
  if (kind === 'knockout') return { ...common, kind, size: 'auto', seeding: 'standard', thirdPlace: false };
  // A matches stage reads its sides from earlier stages, never the field.
  const entrants = common.entrants.from === 'field' ? defaultEntrants(cfg, Math.max(index, 1)) : common.entrants;
  return { ...common, entrants, kind, matches: defaultMatches(cfg, index) };
}

export function addStage(cfg: FormatConfig, kind: FormatStage['kind']): FormatConfig {
  return { ...cfg, stages: [...cfg.stages, stageOfKind(cfg, cfg.stages.length, kind, {})] };
}

/** A new kind keeps the key, name, rated switch, scoring and entrants. */
export function changeStageKind(cfg: FormatConfig, index: number, kind: FormatStage['kind']): FormatConfig {
  const old = cfg.stages[index];
  if (!old || old.kind === kind) return cfg;
  const { key, name, rated, scoring, entrants } = old;
  return replaceStage(cfg, index, stageOfKind(cfg, index, kind, { key, name, rated, scoring, entrants }));
}

export function replaceStage(cfg: FormatConfig, index: number, stage: FormatStage): FormatConfig {
  return { ...cfg, stages: cfg.stages.map((s, i) => (i === index ? stage : s)) };
}

export function removeStage(cfg: FormatConfig, index: number): FormatConfig {
  return { ...cfg, stages: cfg.stages.filter((_, i) => i !== index) };
}

export function moveStage(cfg: FormatConfig, index: number, by: -1 | 1): FormatConfig {
  const to = index + by;
  if (to < 0 || to >= cfg.stages.length) return cfg;
  const stages = [...cfg.stages];
  [stages[index], stages[to]] = [stages[to]!, stages[index]!];
  return { ...cfg, stages };
}

/** Head starts make a game unfair to rate (owner decision 6), so turning them on turns rating off. */
export function setScoring(stage: FormatStage, patch: Partial<StageScoring>): FormatStage {
  const scoring = { ...stage.scoring, ...patch };
  return { ...stage, scoring, rated: scoring.handicap ? false : stage.rated };
}

/** A pool count change keeps one court list per pool. */
export function setPools(stage: GroupsStage, pools: number): GroupsStage {
  if (stage.courts?.mode !== 'per_pool' || !Number.isInteger(pools) || pools < 1) return { ...stage, pools };
  const lists = stage.courts.pools.slice(0, pools);
  while (lists.length < pools) lists.push([String(lists.length + 1)]);
  return { ...stage, pools, courts: { mode: 'per_pool', pools: lists } };
}

/** Court names typed as "1, 2, 3", or a range as "1-8". */
export function parseCourts(text: string): string[] {
  return parseCourtList(text);
}

export function addMatch(cfg: FormatConfig, index: number): FormatConfig {
  const stage = cfg.stages[index];
  if (stage?.kind !== 'matches') return cfg;
  const label = nextKey(stage.matches.map((m) => m.label), 'm');
  const [first] = defaultMatches(cfg, index);
  return replaceStage(cfg, index, { ...stage, matches: [...stage.matches, { ...first!, label, name: `Match ${stage.matches.length + 1}` }] });
}

/** A category's key is fixed once made (team_category and head starts point at it); only its label is typed. */
export function addCategory(cfg: FormatConfig, label: string): FormatConfig {
  const key = nextKey(cfg.categories.map((c) => c.key), 'cat');
  return { ...cfg, categories: [...cfg.categories, { key, label }] };
}

export function removeCategory(cfg: FormatConfig, key: string): FormatConfig {
  const headStarts: FormatConfig['headStarts'] = {};
  for (const [row, cols] of Object.entries(cfg.headStarts)) {
    if (row === key) continue;
    headStarts[row] = Object.fromEntries(Object.entries(cols).filter(([col]) => col !== key));
  }
  return { ...cfg, categories: cfg.categories.filter((c) => c.key !== key), headStarts };
}

/** The points `row` starts on against `col`. 0 is stored as absent; a category never starts ahead of itself. */
export function setHeadStart(cfg: FormatConfig, row: string, col: string, points: number): FormatConfig {
  if (row === col) return cfg;
  const cols = { ...(cfg.headStarts[row] ?? {}) };
  if (points > 0 || Number.isNaN(points)) cols[col] = points;
  else delete cols[col];
  const headStarts = { ...cfg.headStarts };
  if (Object.keys(cols).length > 0) headStarts[row] = cols;
  else delete headStarts[row];
  return { ...cfg, headStarts };
}

/**
 * Everything wrong with the config as it stands, in words: what the schema
 * refuses, then what the server refuses once stages are drawn. Empty means it
 * can be saved.
 */
export function stagedEditorErrors(
  draft: unknown,
  stored: FormatConfig | null,
  drawn: ReadonlySet<number>,
): string[] {
  const checked = checkFormatConfig(draft);
  if (!checked.ok) return checked.errors;
  const refusal = stagedConfigEditRefusal(stored, checked.config, drawn);
  return refusal ? [refusal] : [];
}
