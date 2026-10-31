// Who is in which group, and when and where each group match is played.

import { ExpectedError } from '../expected-error';
import { shuffleWithRng } from '../draw-order';
import { snakeGroupAssignment } from '../standings';
import type { GroupsStage } from './schema';

/**
 * The circle method's fixtures for one set of entries, by round.
 *
 * Returned by round rather than written, because callers interleave several
 * groups' rounds into one shared numbering.
 */
export function circleMethodRounds<T>(entries: readonly T[]): Array<Array<[T, T]>> {
  // A phantom entry gives an odd field the bye it needs; the pairing it appears
  // in is dropped, which is what makes that entrant's round a rest.
  const padded: Array<T | null> = [...entries];
  if (padded.length % 2 !== 0) padded.push(null);

  const numRounds = padded.length - 1;
  const halfSize = padded.length / 2;
  const indices = padded.map((_, i) => i);
  const rounds: Array<Array<[T, T]>> = [];

  for (let round = 0; round < numRounds; round++) {
    const fixtures: Array<[T, T]> = [];
    for (let i = 0; i < halfSize; i++) {
      const home = padded[indices[i]!];
      const away = padded[indices[padded.length - 1 - i]!];
      if (home != null && away != null) fixtures.push([home, away]);
    }
    rounds.push(fixtures);
    // Rotate: keep index 0 fixed, rotate the rest.
    const last = indices.pop()!;
    indices.splice(1, 0, last);
  }

  return rounds;
}

export interface PlannedGroup<T> {
  pool: number;
  group: number;
  members: T[];
}

/**
 * Deal a seeded field (best first) into the stage's groups.
 *
 *  - snake: serpentine over the groups taken ACROSS pools first (pool 1 group 1,
 *    pool 2 group 1, ..., pool 1 group 2, ...), so the top seeds land in
 *    different pools before any pool gets a second one.
 *  - random: a full shuffle, then the same deal (owner decision 2).
 *  - manual: the given order fills pool 1 group 1, then pool 1 group 2, and so on.
 */
export function planStageGroups<T>(
  entrants: readonly T[],
  stage: Pick<GroupsStage, 'pools' | 'groupsPerPool' | 'groupSize' | 'assignment'>,
  rng: () => number,
): Array<PlannedGroup<T>> {
  const count = stage.pools * stage.groupsPerPool;
  const n = entrants.length;
  if (n < 2 * count) {
    throw new ExpectedError(`${n} entrants cannot fill ${count} groups of at least 2.`);
  }
  if (stage.groupSize !== 'auto' && n > count * stage.groupSize) {
    throw new ExpectedError(`${n} entrants do not fit ${count} groups of ${stage.groupSize}.`);
  }

  const natural: Array<PlannedGroup<T>> = [];
  for (let pool = 1; pool <= stage.pools; pool++) {
    for (let group = 1; group <= stage.groupsPerPool; group++) natural.push({ pool, group, members: [] });
  }
  const at = (pool: number, group: number) => natural[(pool - 1) * stage.groupsPerPool + (group - 1)]!;

  if (stage.assignment === 'manual') {
    const base = Math.floor(n / count);
    const extra = n % count;
    let i = 0;
    natural.forEach((g, gi) => {
      const size = base + (gi < extra ? 1 : 0);
      g.members.push(...entrants.slice(i, i + size));
      i += size;
    });
    return natural;
  }

  const ordered = stage.assignment === 'random' ? shuffleWithRng(entrants, rng) : [...entrants];
  const dealOrder: Array<PlannedGroup<T>> = [];
  for (let group = 1; group <= stage.groupsPerPool; group++) {
    for (let pool = 1; pool <= stage.pools; pool++) dealOrder.push(at(pool, group));
  }
  const plan = snakeGroupAssignment(ordered.length, count);
  ordered.forEach((entry, i) => dealOrder[plan[i]! - 1]!.members.push(entry));
  return natural;
}

export interface ScheduledStageMatch<T> {
  pool: number;
  group: number;
  /** The round within its own group, 1-based. */
  round: number;
  /** Per pool with per_pool courts or no courts; one shared sequence with shared courts. */
  slot: number;
  court: string | null;
  a: T;
  b: T;
  matchNumber: number;
}

interface Unit<T> {
  pool: number;
  group: number;
  round: number;
  fixtures: Array<[T, T]>;
}

type GroupRounds<T> = (g: PlannedGroup<T>) => Array<Array<[T, T]>>;

function poolUnits<T>(groups: ReadonlyArray<PlannedGroup<T>>, interleave: boolean, roundsFor: GroupRounds<T>): Array<Unit<T>> {
  const byGroup = [...groups]
    .sort((x, y) => x.group - y.group)
    .map((g) => ({ g, rounds: roundsFor(g) }));
  const units: Array<Unit<T>> = [];
  const push = (g: PlannedGroup<T>, r: number, fixtures: Array<[T, T]> | undefined) => {
    if (fixtures && fixtures.length) units.push({ pool: g.pool, group: g.group, round: r + 1, fixtures });
  };
  if (interleave) {
    const deepest = byGroup.reduce((m, x) => Math.max(m, x.rounds.length), 0);
    for (let r = 0; r < deepest; r++) for (const x of byGroup) push(x.g, r, x.rounds[r]);
  } else {
    for (const x of byGroup) x.rounds.forEach((f, r) => push(x.g, r, f));
  }
  return units;
}

type Pending<T> = { pool: number; group: number; round: number; a: T; b: T };

/**
 * Fill slots in order, `capacity` matches at a time. A slot stops at the first
 * match that would put somebody on two courts at once, so order is kept and
 * nobody is double-booked; the next slot picks up from there.
 */
function pack<T>(queue: Array<Pending<T>>, capacity: number, key: (t: T) => unknown): Array<Array<Pending<T>>> {
  const slots: Array<Array<Pending<T>>> = [];
  let i = 0;
  while (i < queue.length) {
    const busy = new Set<unknown>();
    const slot: Array<Pending<T>> = [];
    while (i < queue.length && slot.length < capacity) {
      const m = queue[i]!;
      if (busy.has(key(m.a)) || busy.has(key(m.b))) break;
      busy.add(key(m.a));
      busy.add(key(m.b));
      slot.push(m);
      i++;
    }
    slots.push(slot);
  }
  return slots;
}

const flatten = <T>(units: Array<Unit<T>>): Array<Pending<T>> =>
  units.flatMap((u) => u.fixtures.map(([a, b]) => ({ pool: u.pool, group: u.group, round: u.round, a, b })));

/**
 * Every match of a groups stage with its slot and court.
 *
 * With interleave a pool's groups take turns a round at a time (group 1 round 1,
 * group 2 round 1, group 1 round 2, ...), so a group always rests while the
 * other plays. A slot's matches take the pool's courts in order. With no courts
 * set, each group round is its own slot.
 *
 * matchNumber runs across the whole stage in slot order (then pool, then court
 * order), so it is stable for a given plan.
 *
 * `opts.roundsFor` replaces the circle method, so a round added to a drawn
 * stage is packed onto courts by the same rules as the draw was. `opts.firstSlot`
 * starts the slots after the ones already played; matchNumber still starts at 1.
 */
export function scheduleStage<T>(
  groups: ReadonlyArray<PlannedGroup<T>>,
  stage: Pick<GroupsStage, 'pools' | 'interleave' | 'courts' | 'gamesPerTeam'>,
  key: (t: T) => unknown = (t) => t,
  opts: { roundsFor?: GroupRounds<T>; firstSlot?: number } = {},
): Array<ScheduledStageMatch<T>> {
  // gamesPerTeam keeps the first rounds of the circle method, which is a whole
  // number of rounds for every group: in an odd group the rest falls on a
  // different team each round, so some teams play one game fewer.
  const roundsFor = opts.roundsFor ?? ((g: PlannedGroup<T>) => circleMethodRounds(g.members).slice(0, stage.gamesPerTeam ?? Infinity));
  const firstSlot = opts.firstSlot ?? 1;
  const pools = [...new Set(groups.map((g) => g.pool))].sort((x, y) => x - y);
  const placed: Array<Omit<ScheduledStageMatch<T>, 'matchNumber'> & { order: number }> = [];

  if (stage.courts?.mode === 'shared') {
    const courts = stage.courts.courts;
    const perPool = pools.map((p) => poolUnits(groups.filter((g) => g.pool === p), stage.interleave, roundsFor));
    const deepest = perPool.reduce((m, u) => Math.max(m, u.length), 0);
    const units: Array<Unit<T>> = [];
    for (let i = 0; i < deepest; i++) for (const u of perPool) if (u[i]) units.push(u[i]!);
    pack(flatten(units), courts.length, key).forEach((slot, si) => {
      slot.forEach((m, ci) => placed.push({ ...m, slot: firstSlot + si, court: courts[ci]!, order: ci }));
    });
  } else {
    for (const p of pools) {
      const units = poolUnits(groups.filter((g) => g.pool === p), stage.interleave, roundsFor);
      if (stage.courts?.mode === 'per_pool') {
        const courts = stage.courts.pools[p - 1] ?? [];
        pack(flatten(units), Math.max(1, courts.length), key).forEach((slot, si) => {
          slot.forEach((m, ci) => placed.push({ ...m, slot: firstSlot + si, court: courts[ci] ?? null, order: ci }));
        });
      } else {
        units.forEach((u, si) => {
          u.fixtures.forEach(([a, b], ci) => placed.push({
            pool: u.pool, group: u.group, round: u.round, a, b, slot: firstSlot + si, court: null, order: ci,
          }));
        });
      }
    }
  }

  // Shared courts number a slot in court order; per-pool courts pool by pool.
  const shared = stage.courts?.mode === 'shared';
  placed.sort((x, y) => x.slot - y.slot || (shared ? 0 : x.pool - y.pool) || x.order - y.order);
  return placed.map((m, i) => ({
    pool: m.pool, group: m.group, round: m.round, slot: m.slot, court: m.court, a: m.a, b: m.b, matchNumber: i + 1,
  }));
}
