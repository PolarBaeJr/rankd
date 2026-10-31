// Growing a groups stage that is already drawn: one more round for every
// group, or a late entrant placed into one group. Pure, like the draw: the
// stored play in, the new rows out. The new rows go after everything already
// stored (later slots, later match numbers), so nothing drawn before moves.

import { ExpectedError } from '../expected-error';
import { scheduleStage, type PlannedGroup } from './groups';
import { findStage } from './advance';
import { groupScheduleRows, type StageEntrant, type StageRow } from './build';
import type { FormatConfig, GroupsStage } from './schema';
import type { FormatResults } from './standings';

/** One group as it stands: who is still in it and who has played whom. */
export interface GroupLedger {
  pool: number;
  group: number;
  /** Entries still in the event, best seed first. */
  members: string[];
  /** Matches on each member's schedule, voided ones left out. */
  games: Map<string, number>;
  /** Times two entries have been drawn against each other, keyed by pairKey. */
  met: Map<string, number>;
}

/** The same key whichever way round the two sides are given. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Every group of a stage with its active members and their meetings so far.
 * Every row that is not voided counts, played or not: a fixture already on the
 * schedule is a meeting the next round should not repeat.
 */
export function groupLedger(results: FormatResults, stageKey: string, active: ReadonlySet<string>): GroupLedger[] {
  const seedOrder = new Map(results.field.map((e, i) => [e.id, i]));
  const bySeed = (x: string, y: string) =>
    (seedOrder.get(x) ?? Infinity) - (seedOrder.get(y) ?? Infinity) || (x < y ? -1 : x > y ? 1 : 0);
  return results.groups
    .filter((g) => g.stage === stageKey)
    .sort((x, y) => x.pool - y.pool || x.group - y.group)
    .map((g) => {
      const members = g.members.filter((id) => active.has(id)).sort(bySeed);
      const games = new Map(members.map((id) => [id, 0]));
      const met = new Map<string, number>();
      for (const m of results.matches) {
        if (m.stage !== stageKey || m.pool !== g.pool || m.group !== g.group || m.status === 'voided') continue;
        for (const id of [m.a, m.b]) if (id && games.has(id)) games.set(id, games.get(id)! + 1);
        if (m.a && m.b) met.set(pairKey(m.a, m.b), (met.get(pairKey(m.a, m.b)) ?? 0) + 1);
      }
      return { pool: g.pool, group: g.group, members, games, met };
    });
}

export interface NextGroupRound {
  /** Better seed first on each side. */
  fixtures: Array<[string, string]>;
  sittingOut: string[];
  /** Fixtures between two entries that have already been drawn together. */
  repeats: number;
}

/**
 * The cheapest way to pair everyone in `members` (an even count), where a
 * pairing costs the times the two have met. Searched exhaustively with the
 * best so far as a bound, and stopped as soon as nothing cheaper can exist, so
 * a group with fresh opponents left is settled on the first path tried.
 */
function cheapestPairing(members: readonly string[], met: ReadonlyMap<string, number>): { fixtures: Array<[string, string]>; cost: number } {
  const costOf = (a: string, b: string) => met.get(pairKey(a, b)) ?? 0;
  let cheapestEdge = Infinity;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) cheapestEdge = Math.min(cheapestEdge, costOf(members[i]!, members[j]!));
  }
  const floor = members.length === 0 ? 0 : cheapestEdge * (members.length / 2);

  let best: { fixtures: Array<[string, string]>; cost: number } | null = null;
  const chosen: Array<[string, string]> = [];
  const search = (left: readonly string[], cost: number): boolean => {
    if (best && cost >= best.cost) return false;
    if (left.length === 0) {
      best = { fixtures: [...chosen], cost };
      return cost <= floor;
    }
    const [first, ...rest] = left;
    // Cheapest partner first, then by seed, so the first full pairing found is
    // usually the answer and the bound cuts the rest short.
    const partners = rest
      .map((partner, order) => ({ partner, order, cost: costOf(first!, partner) }))
      .sort((x, y) => x.cost - y.cost || x.order - y.order);
    for (const { partner, cost: step } of partners) {
      chosen.push([first!, partner]);
      const done = search(rest.filter((id) => id !== partner), cost + step);
      chosen.pop();
      if (done) return true;
    }
    return false;
  };
  search(members, 0);
  return best ?? { fixtures: [], cost: 0 };
}

/**
 * One more round for a group: everyone plays once, with as few repeat meetings
 * as the group allows. In an odd group one team sits out: the one with the
 * most games on its schedule, the worst seed among those, unless resting a
 * different team is the only way to avoid a repeat.
 */
export function nextGroupRound(
  members: readonly string[],
  games: ReadonlyMap<string, number>,
  met: ReadonlyMap<string, number>,
): NextGroupRound {
  if (members.length < 2) return { fixtures: [], sittingOut: [...members], repeats: 0 };
  const repeatsIn = (fixtures: Array<[string, string]>) => fixtures.filter(([a, b]) => (met.get(pairKey(a, b)) ?? 0) > 0).length;
  if (members.length % 2 === 0) {
    const { fixtures } = cheapestPairing(members, met);
    return { fixtures, sittingOut: [], repeats: repeatsIn(fixtures) };
  }
  const candidates = members
    .map((id, order) => ({ id, order }))
    .sort((x, y) => (games.get(y.id) ?? 0) - (games.get(x.id) ?? 0) || y.order - x.order)
    .map((c) => c.id);
  let best: { sittingOut: string; fixtures: Array<[string, string]>; cost: number } | null = null;
  for (const sittingOut of candidates) {
    const pairing = cheapestPairing(members.filter((id) => id !== sittingOut), met);
    if (!best || pairing.cost < best.cost) best = { sittingOut, ...pairing };
    if (pairing.cost === 0) break;
  }
  return { fixtures: best!.fixtures, sittingOut: [best!.sittingOut], repeats: repeatsIn(best!.fixtures) };
}

export interface AddedGroupRound {
  pool: number;
  group: number;
  sittingOut: string[];
  repeats: number;
}

export interface ExtendStageOptions {
  /** One past the highest round_number already stored in the stage. */
  firstSlot: number;
  /** One past the highest match_number already stored in the event. */
  firstMatchNumber: number;
  newId?: () => string;
}

/**
 * The rows of one more round for every group of a drawn groups stage, put on
 * courts by the stage's own rules and slotted after everything already there.
 * `active` is the entries still in the event; `categories` their team
 * categories, which head starts read.
 */
export function buildAddedRoundRows(
  cfg: FormatConfig,
  stageKey: string,
  results: FormatResults,
  active: ReadonlySet<string>,
  categories: ReadonlyMap<string, string | null>,
  generation: string,
  opts: ExtendStageOptions,
): { rows: StageRow[]; groups: AddedGroupRound[] } {
  const stage = findStage(cfg, stageKey);
  if (!stage || stage.kind !== 'groups') throw new ExpectedError(`There is no groups stage "${stageKey}".`);
  const entrant = new Map<string, StageEntrant>();
  const entrantOf = (id: string) => {
    const found = entrant.get(id) ?? { id, category: categories.get(id) ?? null };
    entrant.set(id, found);
    return found;
  };

  const groups: AddedGroupRound[] = [];
  const planned: Array<PlannedGroup<StageEntrant>> = [];
  const roundOf = new Map<string, Array<[StageEntrant, StageEntrant]>>();
  for (const ledger of groupLedger(results, stageKey, active)) {
    const round = nextGroupRound(ledger.members, ledger.games, ledger.met);
    groups.push({ pool: ledger.pool, group: ledger.group, sittingOut: round.sittingOut, repeats: round.repeats });
    planned.push({ pool: ledger.pool, group: ledger.group, members: ledger.members.map(entrantOf) });
    roundOf.set(`${ledger.pool}:${ledger.group}`, round.fixtures.map(([a, b]) => [entrantOf(a), entrantOf(b)]));
  }

  const schedule = scheduleStage(planned, stage, (e) => e.id, {
    roundsFor: (g) => [roundOf.get(`${g.pool}:${g.group}`) ?? []],
    firstSlot: opts.firstSlot,
  });
  const rows = groupScheduleRows(cfg, stageKey, schedule, generation, {
    newId: opts.newId,
    firstMatchNumber: opts.firstMatchNumber,
  });
  return { rows, groups };
}

export interface LateEntrantPlan {
  pool: number;
  group: number;
  /** The members the late entrant plays, best seed first. */
  opponents: string[];
  /** After those matches, every team in the group has the same number of games. */
  level: boolean;
  /** Some group in the stage has an odd number of teams still in it. */
  anyOddGroup: boolean;
}

/**
 * Where a late entrant goes in a drawn groups stage, and whom they play.
 *
 * They play the members a game behind the busiest, so the group ends level
 * where it can; in a group where everyone is level they play everyone. That
 * evens out best in a group with an odd number of teams, where somebody rests
 * each round, so such a group is taken first when it ends level, then the
 * smallest, then the first. Otherwise the smallest group. null when the
 * entrant is already in a group or no group has been drawn.
 */
export function planLateEntrant(
  stage: Pick<GroupsStage, 'key'>,
  results: FormatResults,
  active: ReadonlySet<string>,
  entrantId: string,
): LateEntrantPlan | null {
  if (results.groups.some((g) => g.stage === stage.key && g.members.includes(entrantId))) return null;
  const options = groupLedger(results, stage.key, active).map((ledger) => {
    const most = Math.max(0, ...ledger.games.values());
    const behind = ledger.members.filter((id) => (ledger.games.get(id) ?? 0) < most);
    const opponents = behind.length > 0 ? behind : [...ledger.members];
    const after = ledger.members.map((id) => (ledger.games.get(id) ?? 0) + (opponents.includes(id) ? 1 : 0));
    const level = after.every((n) => n === opponents.length);
    return { pool: ledger.pool, group: ledger.group, opponents, level, size: ledger.members.length };
  });
  if (options.length === 0) return null;
  type Option = (typeof options)[number];
  const order = (x: Option, y: Option) => x.size - y.size || x.pool - y.pool || x.group - y.group;
  const best = options.filter((o) => o.size % 2 === 1 && o.level).sort(order)[0] ?? [...options].sort(order)[0]!;
  return {
    pool: best.pool,
    group: best.group,
    opponents: best.opponents,
    level: best.level,
    anyOddGroup: options.some((o) => o.size % 2 === 1),
  };
}

/**
 * The late entrant's matches. Each opponent is a round of its own, so however
 * the stage packs its courts the entrant is never on two at once.
 */
export function buildLateEntrantRows(
  cfg: FormatConfig,
  stageKey: string,
  plan: LateEntrantPlan,
  entrantId: string,
  categories: ReadonlyMap<string, string | null>,
  generation: string,
  opts: ExtendStageOptions,
): StageRow[] {
  const stage = findStage(cfg, stageKey);
  if (!stage || stage.kind !== 'groups') throw new ExpectedError(`There is no groups stage "${stageKey}".`);
  const entrantOf = (id: string): StageEntrant => ({ id, category: categories.get(id) ?? null });
  const newcomer = entrantOf(entrantId);
  const opponents = plan.opponents.map(entrantOf);
  const planned: Array<PlannedGroup<StageEntrant>> = [{ pool: plan.pool, group: plan.group, members: [...opponents, newcomer] }];
  const schedule = scheduleStage(planned, stage, (e) => e.id, {
    roundsFor: () => opponents.map((opponent): Array<[StageEntrant, StageEntrant]> => [[opponent, newcomer]]),
    firstSlot: opts.firstSlot,
  });
  return groupScheduleRows(cfg, stageKey, schedule, generation, {
    newId: opts.newId,
    firstMatchNumber: opts.firstMatchNumber,
  });
}
