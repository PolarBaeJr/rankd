// Merging a thin group into another of its pool (00332). After the draw,
// Did not come, Left and a check-in after the draw can leave a group with one
// or two teams; merged before it plays, they get a proper round robin. Pure:
// the stored play in, the suggestion, the refusal and the new rows out.
//
// Never across pools, never once either group has a result or a match on
// court, and never when a later stage's slots would no longer add up, because
// format_config is never rewritten here: a group's number stays what the
// later stage reads.

import { ExpectedError } from '../expected-error';
import { scheduleStage, type PlannedGroup } from './groups';
import { findStage } from './advance';
import { groupLedger } from './extend';
import { groupScheduleRows, type StageEntrant, type StageRow } from './build';
import type { FormatConfig } from './schema';
import type { FormatResults } from './standings';

export const THIN_GROUP_SIZE = 3;

/** A match that keeps a group as it is: anything but not yet played, or voided. */
const UNTOUCHED = new Set(['pending', 'ready', 'voided']);

function touched(results: FormatResults, stageKey: string, pool: number, group: number): boolean {
  return results.matches.some((m) => m.stage === stageKey && m.pool === pool && m.group === group && !UNTOUCHED.has(m.status));
}

export interface ThinGroup {
  pool: number;
  group: number;
  /** Still in the event, best seed first. */
  members: string[];
}

/** Groups of a stage with fewer than `min` teams still in, none of whose matches has been played. */
export function thinGroups(results: FormatResults, stageKey: string, active: ReadonlySet<string>, min = THIN_GROUP_SIZE): ThinGroup[] {
  return groupLedger(results, stageKey, active)
    .filter((g) => g.members.length < min && !touched(results, stageKey, g.pool, g.group))
    .map((g) => ({ pool: g.pool, group: g.group, members: g.members }));
}

export interface MergeSuggestion {
  pool: number;
  from: number;
  into: number;
  /** Teams left in the thin group. */
  size: number;
}

export interface MergeContext {
  /** Any match of a later stage exists. */
  laterStageDrawn: boolean;
  /** A reached time cap covers one of the two groups. */
  capped?: (pool: number, group: number) => boolean;
}

/** The desk's words for why two groups cannot be merged, or null when they can. */
export function mergeRefusal(
  cfg: FormatConfig,
  stageKey: string,
  results: FormatResults,
  active: ReadonlySet<string>,
  pool: number,
  from: number,
  into: number,
  ctx: MergeContext,
): string | null {
  const stage = findStage(cfg, stageKey);
  if (!stage || stage.kind !== 'groups') return `There is no groups stage "${stageKey}".`;
  if (from === into) return 'Pick two different groups.';
  const ledger = groupLedger(results, stageKey, active);
  const fromGroup = ledger.find((g) => g.pool === pool && g.group === from);
  const intoGroup = ledger.find((g) => g.pool === pool && g.group === into);
  if (!fromGroup || !intoGroup) return 'Both groups have to be in the same pool of this stage.';
  if (touched(results, stageKey, pool, from) || touched(results, stageKey, pool, into)) {
    return 'One of the two groups has a result or a match on court, so it is played as it is.';
  }
  if (ctx.laterStageDrawn) return 'A later stage has been drawn from this stage, so its groups stay as they are.';
  if (ctx.capped?.(pool, from) || ctx.capped?.(pool, into)) return 'This group\'s time cap has passed, so its table stands.';

  const groupsLeft = ledger.length - 1;
  const groupsLeftInPool = ledger.filter((g) => g.pool === pool).length - 1;
  const merged = fromGroup.members.length + intoGroup.members.length;
  for (const later of cfg.stages) {
    if (later.entrants.from !== 'slots') continue;
    for (const ref of later.entrants.slots) {
      if (!('stage' in ref) || ref.stage !== stageKey) continue;
      if (ref.type === 'group_place' && ref.pool === pool && ref.group === from) {
        return `"${later.name}" takes a place from this group by number, so it cannot go.`;
      }
      if (ref.type === 'pool_place' && ref.pool === pool && ref.place > groupsLeftInPool) {
        return `"${later.name}" needs more groups in this pool than a merge would leave.`;
      }
      if (ref.type === 'group_rank') {
        if (ref.count == null) return `"${later.name}" takes one team per group, so a group cannot go.`;
        const withPlace = ledger
          .filter((g) => !(g.pool === pool && (g.group === from || g.group === into)))
          .filter((g) => g.members.length >= ref.place).length + (merged >= ref.place ? 1 : 0);
        if (ref.count > Math.min(withPlace, groupsLeft)) {
          return `"${later.name}" ranks ${ref.count} teams placed ${ref.place}, more than a merge would leave.`;
        }
      }
    }
  }
  return null;
}

/** One suggestion per thin group: the group of its pool with the fewest teams that it may merge into. */
export function suggestMerges(
  cfg: FormatConfig,
  stageKey: string,
  results: FormatResults,
  active: ReadonlySet<string>,
  ctx: MergeContext,
): MergeSuggestion[] {
  const ledger = groupLedger(results, stageKey, active);
  const suggestions: MergeSuggestion[] = [];
  for (const thin of thinGroups(results, stageKey, active)) {
    const into = ledger
      .filter((g) => g.pool === thin.pool && g.group !== thin.group)
      .sort((x, y) => x.members.length - y.members.length || x.group - y.group)
      .find((g) => mergeRefusal(cfg, stageKey, results, active, thin.pool, thin.group, g.group, ctx) === null);
    if (into) suggestions.push({ pool: thin.pool, from: thin.group, into: into.group, size: thin.members.length });
  }
  return suggestions;
}

export interface MergeRowsOptions {
  /** One past the highest round_number already stored in the stage. */
  firstSlot: number;
  /** One past the highest match_number already stored in the event. */
  firstMatchNumber: number;
  newId?: () => string;
}

/**
 * The merged group's matches: a round robin of everyone still in either group,
 * under the stage's own rules (games per team, courts), numbered `into`, and
 * slotted after everything already stored so the stage-wide slot index holds.
 */
export function buildMergedGroupRows(
  cfg: FormatConfig,
  stageKey: string,
  results: FormatResults,
  active: ReadonlySet<string>,
  pool: number,
  from: number,
  into: number,
  categories: ReadonlyMap<string, string | null>,
  generation: string,
  opts: MergeRowsOptions,
): StageRow[] {
  const stage = findStage(cfg, stageKey);
  if (!stage || stage.kind !== 'groups') throw new ExpectedError(`There is no groups stage "${stageKey}".`);
  const seedOrder = new Map(results.field.map((e, i) => [e.id, i]));
  const ledger = groupLedger(results, stageKey, active);
  const members = ledger
    .filter((g) => g.pool === pool && (g.group === from || g.group === into))
    .flatMap((g) => g.members)
    .sort((x, y) => (seedOrder.get(x) ?? Infinity) - (seedOrder.get(y) ?? Infinity) || (x < y ? -1 : x > y ? 1 : 0));
  const planned: Array<PlannedGroup<StageEntrant>> = [{
    pool,
    group: into,
    members: members.map((id) => ({ id, category: categories.get(id) ?? null })),
  }];
  const schedule = scheduleStage(planned, stage, (e) => e.id, { firstSlot: opts.firstSlot });
  return groupScheduleRows(cfg, stageKey, schedule, generation, {
    newId: opts.newId,
    firstMatchNumber: opts.firstMatchNumber,
  });
}
