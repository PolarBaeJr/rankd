// 00332: the rows mergeThinGroup sends to merge_stage_groups. The function
// refuses the whole merge ('invalid_rows') unless every row has an id and is
// stamped with the event, the stage, the pool, the merged-into group and the
// draw generation, and jsonb_populate_recordset quietly drops a key it does not
// know. The SQL tests are not run in CI, so this is the one check that the
// console's row shape and the function's column names agree.

import { describe, expect, it } from 'vitest';
import {
  buildMergedGroupRows,
  formatConfigSchema,
  formatResultsFrom,
  type StagedMatchRow,
} from '@badminton/shared';
import { rowForInsert } from '../tournament-actions/stage-rows';

const EVENT = 'bbbbbbbb-0332-4000-8000-000000000001';
const GENERATION = 'bbbbbbbb-0332-4000-8000-0000000000aa';
const scoring = { bestOf: 1, target: 21, winByTwo: true, cap: 30, handicap: false, forfeit: null };
const cfg = formatConfigSchema.parse({
  version: 1,
  stages: [{
    key: 'groups', name: 'Group stage', rated: false, kind: 'groups', pools: 1, groupsPerPool: 2,
    groupSize: 'auto', assignment: 'snake', scoring, entrants: { from: 'field', order: 'elo' },
  }],
});
const MEMBERS: Record<number, string[]> = { 1: ['t01', 't02', 't03'], 2: ['t04', 't05'] };

function drawn() {
  const rows: StagedMatchRow[] = [];
  let round = 0;
  for (const [group, ids] of Object.entries(MEMBERS)) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        rows.push({
          stage: 1, status: 'ready', pool_number: 1, group_number: Number(group), round_number: ++round,
          match_label: null, is_third_place: false, a: ids[i]!, b: ids[j]!, winner: null, scores: null,
        });
      }
    }
  }
  const entries = Object.values(MEMBERS).flat().map((id, index) => ({ id, seed: index + 1, status: 'checked_in' }));
  return {
    results: formatResultsFrom(cfg, entries, rows),
    active: new Set(entries.map((e) => e.id)),
    firstSlot: round + 1,
  };
}

describe('mergeThinGroup: the rows merge_stage_groups is sent', () => {
  for (const doubles of [false, true]) {
    it(`carry every field the function checks (${doubles ? 'doubles' : 'singles'})`, () => {
      const { results, active, firstSlot } = drawn();
      let next = 0;
      const rows = buildMergedGroupRows(cfg, 'groups', results, active, 1, 2, 1, new Map(), GENERATION, {
        firstSlot,
        firstMatchNumber: 10,
        newId: () => `cccccccc-0332-4000-8000-${String(++next).padStart(12, '0')}`,
      }).map((r) => rowForInsert(EVENT, r, doubles, null));

      // Five teams, one round robin: ten matches.
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.id).toEqual(expect.any(String));
        expect(row).toMatchObject({
          event_id: EVENT,
          stage: 1,
          pool_number: 1,
          group_number: 1,
          draw_generation_id: GENERATION,
        });
        const sides = doubles ? ['pair_a_id', 'pair_b_id'] : ['participant_a_id', 'participant_b_id'];
        for (const side of sides) expect(row[side]).toEqual(expect.any(String));
      }
      // Slotted after everything already stored, so the stage-wide index holds.
      expect(Math.min(...rows.map((row) => row.round_number as number))).toBeGreaterThanOrEqual(firstSlot);
    });
  }
});
