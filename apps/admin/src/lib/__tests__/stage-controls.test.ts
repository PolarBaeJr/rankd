import { describe, it, expect } from 'vitest';
import type { FormatResults, GroupsStage } from '@badminton/shared';
import {
  bulkVoidSummary,
  drawField,
  drawLeftOutMessage,
  isOpenMatch,
  lateEntrantGroupOptions,
  openMatchesOfEntry,
  splitGroupMatches,
  uncategorisedWarning,
  unplayedMatchesIn,
} from '../stage-controls';

describe('uncategorisedWarning', () => {
  it('counts teams still in the event with no category', () => {
    expect(uncategorisedWarning([
      { status: 'registered', team_category: null },
      { status: 'checked_in', team_category: undefined },
      { status: 'registered', team_category: 'mens' },
      { status: 'withdrawn', team_category: null },
      { status: 'disqualified', team_category: null },
    ])).toBe('2 teams have no category, so they get no head start. Set it in Participants.');
  });

  it('reads one team in the singular', () => {
    expect(uncategorisedWarning([{ status: 'no_show', team_category: null }]))
      .toBe('1 team has no category, so it gets no head start. Set it in Participants.');
  });

  it('says nothing when every team has one', () => {
    expect(uncategorisedWarning([{ status: 'registered', team_category: 'mixed' }])).toBeNull();
    expect(uncategorisedWarning([])).toBeNull();
  });
});

describe('splitGroupMatches', () => {
  const m = (id: string, status: string) => ({ id, status });

  it('puts a voided match in its own bucket, not in to play', () => {
    const split = splitGroupMatches([m('1', 'voided'), m('2', 'pending'), m('3', 'completed'), m('4', 'walkover'), m('5', 'live')]);
    expect(split.toPlay.map((x) => x.id)).toEqual(['2', '5']);
    expect(split.played.map((x) => x.id)).toEqual(['3', '4']);
    expect(split.voided.map((x) => x.id)).toEqual(['1']);
    expect(split.summary).toBe('2 to play, 2 played, 1 voided');
  });

  it('leaves voided out of the summary when there is none', () => {
    expect(splitGroupMatches([m('1', 'ready'), m('2', 'completed')]).summary).toBe('1 to play, 1 played');
  });
});

describe('drawField', () => {
  const e = (id: string, status: string) => ({ id, status });

  it('draws everyone registered or checked in when nobody has checked in', () => {
    const { field, leftOut } = drawField([e('a', 'registered'), e('b', 'registered'), e('c', 'withdrawn'), e('d', 'no_show')]);
    expect(field.map((x) => x.id)).toEqual(['a', 'b']);
    expect(leftOut).toEqual([]);
  });

  it('draws only the checked-in once anyone has checked in, and names who is left out', () => {
    const { field, leftOut } = drawField([e('a', 'checked_in'), e('b', 'registered'), e('c', 'checked_in'), e('d', 'no_show'), e('f', 'withdrawn')]);
    expect(field.map((x) => x.id)).toEqual(['a', 'c']);
    expect(leftOut.map((x) => x.id)).toEqual(['b']);
  });
});

describe('drawLeftOutMessage', () => {
  it('says nothing when nobody is left out', () => {
    expect(drawLeftOutMessage([])).toBeNull();
  });

  it('names who is left out', () => {
    expect(drawLeftOutMessage(['Ann / Bo'])).toBe(
      '1 entry has not checked in and will not be drawn: Ann / Bo. They stay in the event and can be placed in a group later, once they check in.',
    );
    expect(drawLeftOutMessage(['A', 'B'])).toMatch(/^2 entries have not checked in and will not be drawn: A, B\./);
  });
});

describe('open matches for a bulk void', () => {
  const m = (id: string, status: string, a: string | null, b: string | null, extra: Partial<{ is_bye: boolean; stage: number; pool_number: number; group_number: number }> = {}) => ({
    id, status, a, b, is_bye: false, stage: 1, pool_number: 1, group_number: 1, ...extra,
  });

  it('takes only waiting and ready matches that are not byes', () => {
    expect(isOpenMatch({ status: 'pending' })).toBe(true);
    expect(isOpenMatch({ status: 'ready', is_bye: null })).toBe(true);
    expect(isOpenMatch({ status: 'ready', is_bye: true })).toBe(false);
    for (const status of ['live', 'disputed', 'completed', 'walkover', 'voided']) expect(isOpenMatch({ status })).toBe(false);
  });

  it('voids an entry\'s open matches and leaves the live one to its court', () => {
    const ms = [
      m('1', 'ready', 'x', 'y'), m('2', 'pending', 'z', 'x'), m('3', 'live', 'x', 'w'),
      m('4', 'completed', 'x', 'v'), m('5', 'voided', 'x', 'u'), m('6', 'ready', 'y', 'z'),
    ];
    const { open, live } = openMatchesOfEntry(ms, 'x');
    expect(open.map((r) => r.id)).toEqual(['1', '2']);
    expect(live).toBe(1);
  });

  it('scopes "Void unplayed" to a stage, or to one group of it', () => {
    const ms = [
      m('1', 'ready', 'a', 'b'), m('2', 'live', 'c', 'd'),
      m('3', 'pending', 'e', 'f', { group_number: 2 }), m('4', 'completed', 'g', 'h', { group_number: 2 }),
      m('5', 'ready', 'i', 'j', { stage: 2, group_number: 1 }),
    ];
    expect(unplayedMatchesIn(ms, { stage: 1 }).open.map((r) => r.id)).toEqual(['1', '3']);
    expect(unplayedMatchesIn(ms, { stage: 1 }).live).toBe(1);
    expect(unplayedMatchesIn(ms, { stage: 1 }).skipped).toBe(0);
    const group2 = unplayedMatchesIn(ms, { stage: 1, pool: 1, group: 2 });
    expect(group2.open.map((r) => r.id)).toEqual(['3']);
    expect(group2.live).toBe(0);
  });

  it('never voids a knockout slot still waiting on a side, and counts it as skipped', () => {
    const ko = { stage: 2, pool_number: null as unknown as number, group_number: null as unknown as number };
    const ms = [
      m('1', 'ready', 'a', 'b', ko), m('2', 'pending', 'c', null, ko),
      m('3', 'pending', null, null, ko), m('4', 'completed', 'a', 'd', ko),
    ];
    const { open, live, skipped } = unplayedMatchesIn(ms, { stage: 2 });
    expect(open.map((r) => r.id)).toEqual(['1']);
    expect(live).toBe(0);
    expect(skipped).toBe(2);
  });

  it('reports what was voided, what failed and what was left on court', () => {
    expect(bulkVoidSummary({ voided: 3, failed: 0, live: 0, skipped: 0 })).toEqual({ text: '3 matches voided', ok: true });
    expect(bulkVoidSummary({ voided: 1, failed: 1, live: 1, skipped: 0 })).toEqual({
      text: '1 match voided; 1 could not be voided, reload and check it; 1 on court left alone, void it from the court',
      ok: false,
    });
    expect(bulkVoidSummary({ voided: 2, failed: 0, live: 0, skipped: 3 })).toEqual({
      text: '2 matches voided; 3 still waiting on a side left alone',
      ok: true,
    });
  });
});

describe('lateEntrantGroupOptions', () => {
  const stage = { key: 'groups' } as GroupsStage;
  const row = (a: string, b: string, group: number) => ({ stage: 'groups', pool: 1, group, round: 1, label: null, a, b, status: 'pending', winner: null, games: null });
  const results: FormatResults = {
    field: ['a', 'b', 'c', 'd', 'e', 'late'].map((id, i) => ({ id, seed: i + 1 })),
    groups: [
      { stage: 'groups', pool: 1, group: 1, members: ['a', 'b', 'c'] },
      { stage: 'groups', pool: 1, group: 2, members: ['d', 'e'] },
    ],
    matches: [row('a', 'b', 1), row('a', 'c', 1), row('b', 'c', 1), row('d', 'e', 2)],
    out: [],
  };
  const entries = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, status: 'checked_in' }));

  it('offers the suggested group first, then every other group with its own opponents', () => {
    const options = lateEntrantGroupOptions(stage, results, [...entries, { id: 'late', status: 'checked_in' }], 'late');
    expect(options.map((o) => `${o.pool}:${o.group}`)).toEqual(['1:1', '1:2']);
    expect(options[0]!.opponents).toEqual(['a', 'b', 'c']);
    expect(options[1]!.opponents).toEqual(['d', 'e']);
  });

  it('offers nothing to an entry already in a group or out of the event', () => {
    expect(lateEntrantGroupOptions(stage, results, entries, 'a')).toEqual([]);
    expect(lateEntrantGroupOptions(stage, results, [...entries, { id: 'late', status: 'withdrawn' }], 'late')).toEqual([]);
  });
});
