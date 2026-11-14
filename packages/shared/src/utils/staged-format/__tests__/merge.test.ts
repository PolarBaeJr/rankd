import { describe, expect, it } from 'vitest';
import {
  buildMergedGroupRows,
  formatConfigSchema,
  formatResultsFrom,
  mergeRefusal,
  pairKey,
  suggestMerges,
  thinGroups,
  type FormatConfig,
  type StagedMatchRow,
} from '..';

// 00332: a thin group merged into another of its pool, before either plays.

const scoring = { bestOf: 1, target: 21, winByTwo: true, cap: 30, handicap: false, forfeit: null };

function config(slots: unknown[]): FormatConfig {
  return formatConfigSchema.parse({
    version: 1,
    stages: [
      {
        key: 'groups', name: 'Group stage', rated: false, kind: 'groups', pools: 1, groupsPerPool: 3,
        groupSize: 'auto', assignment: 'snake', scoring, entrants: { from: 'field', order: 'elo' },
      },
      { key: 'ko', name: 'Knockout', rated: false, kind: 'knockout', size: 'auto', scoring, entrants: { from: 'slots', slots } },
    ],
  });
}

const winnersOf = (...groups: number[]) => groups.map((group) => ({ type: 'group_place', stage: 'groups', pool: 1, group, place: 1 }));

// Group 1: four teams. Group 2: three. Group 3: two, one of whom did not come.
const MEMBERS: Record<number, string[]> = { 1: ['t01', 't02', 't03', 't04'], 2: ['t05', 't06', 't07'], 3: ['t08', 't09'] };
const FIELD = Object.values(MEMBERS).flat();

function results(opts: { status?: Record<number, string>; noShow?: string[] } = {}) {
  const rows: StagedMatchRow[] = [];
  let round = 0;
  for (const [group, ids] of Object.entries(MEMBERS)) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        rows.push({
          stage: 1, status: opts.status?.[Number(group)] ?? 'ready', pool_number: 1, group_number: Number(group),
          round_number: ++round, match_label: null, is_third_place: false, a: ids[i]!, b: ids[j]!, winner: null, scores: null,
        });
      }
    }
  }
  const entries = FIELD.map((id, index) => ({ id, seed: index + 1, status: opts.noShow?.includes(id) ? 'no_show' : 'checked_in' }));
  return {
    results: formatResultsFrom(config(winnersOf(1, 2)), entries, rows),
    active: new Set(entries.filter((e) => e.status === 'checked_in').map((e) => e.id)),
  };
}

describe('a thin group', () => {
  it('has fewer than three teams still in, and no match played; a voided one does not count', () => {
    const { results: played, active } = results({ noShow: ['t09'], status: { 3: 'voided' } });
    expect(thinGroups(played, 'groups', active)).toEqual([{ pool: 1, group: 3, members: ['t08'] }]);
    const live = results({ noShow: ['t09'], status: { 3: 'live' } });
    expect(thinGroups(live.results, 'groups', live.active)).toEqual([]);
  });

  it('is suggested into the smallest other group of its pool', () => {
    const { results: r, active } = results({ noShow: ['t09'] });
    expect(suggestMerges(config(winnersOf(1, 2)), 'groups', r, active, { laterStageDrawn: false }))
      .toEqual([{ pool: 1, from: 3, into: 2, size: 1 }]);
  });
});

describe('a merge is refused', () => {
  const { results: r, active } = results({ noShow: ['t09'] });

  it('when a later stage takes a place from the thin group by number', () => {
    expect(mergeRefusal(config(winnersOf(1, 2, 3)), 'groups', r, active, 1, 3, 2, { laterStageDrawn: false }))
      .toMatch(/takes a place from this group by number/);
  });

  it('when a group_rank takes one per group, or more than a merge leaves', () => {
    const rank = (count?: number) => ({ type: 'group_rank', stage: 'groups', place: 2, rankBy: ['wins'], ...(count ? { count } : {}) });
    expect(mergeRefusal(config([rank()]), 'groups', r, active, 1, 3, 2, { laterStageDrawn: false })).toMatch(/one team per group/);
    expect(mergeRefusal(config([rank(3)]), 'groups', r, active, 1, 3, 2, { laterStageDrawn: false })).toMatch(/more than a merge would leave/);
    expect(mergeRefusal(config([rank(2)]), 'groups', r, active, 1, 3, 2, { laterStageDrawn: false })).toBeNull();
  });

  it('when either group has a result, a later stage is drawn, or a time cap has passed', () => {
    const played = results({ noShow: ['t09'], status: { 2: 'completed' } });
    expect(mergeRefusal(config(winnersOf(1, 2)), 'groups', played.results, played.active, 1, 3, 2, { laterStageDrawn: false })).not.toBeNull();
    expect(mergeRefusal(config(winnersOf(1, 2)), 'groups', r, active, 1, 3, 2, { laterStageDrawn: true })).not.toBeNull();
    expect(mergeRefusal(config(winnersOf(1, 2)), 'groups', r, active, 1, 3, 2, { laterStageDrawn: false, capped: (_p, g) => g === 2 })).not.toBeNull();
  });
});

describe('the merged group', () => {
  it('is a full round robin of everyone still in, numbered into, after every slot already stored', () => {
    const { results: r, active } = results({ noShow: ['t09'] });
    let n = 0;
    const rows = buildMergedGroupRows(config(winnersOf(1, 2)), 'groups', r, active, 1, 3, 2, new Map(), 'gen-1', {
      firstSlot: 11, firstMatchNumber: 11, newId: () => `new-${++n}`,
    });
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.group_number === 2 && row.pool_number === 1 && row.stage === 1 && row.draw_generation_id === 'gen-1')).toBe(true);
    expect(new Set(rows.map((row) => pairKey(row.a!, row.b!))).size).toBe(6);
    expect(rows.flatMap((row) => [row.a, row.b])).not.toContain('t09');
    expect(Math.min(...rows.map((row) => row.round_number))).toBeGreaterThanOrEqual(11);
    expect(new Set(rows.map((row) => row.match_number)).size).toBe(6);
  });
});
