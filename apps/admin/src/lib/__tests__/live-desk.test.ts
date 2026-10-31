import { describe, it, expect } from 'vitest';
import {
  deskRows, nextCallable, deskCounts, buildEntryMaps, deskEventPlaying, hasCourtsTab,
  deskRowGroup, groupsInPlay, filterDeskRows, deskRoundLine, deskRowMatchesSearch,
  stagedGroupKey, stagedGroupParts, deskGroupLabel, deskGroupChipLabel, deskPools, deskCourtSuggestion,
  liveEntrants, nextMatchForCourt, planCourtCalls, inlineScoreVerdict, autoCallFailureText,
  type DeskMatch,
} from '../live-desk';
import { groupsThenTopKnockout, poolsThenPlacement, type MatchRules, type TournamentCourt } from '@badminton/shared';

function match(over: Partial<DeskMatch> & { id: string }): DeskMatch {
  return {
    status: 'pending',
    is_bye: false,
    phase: null,
    round_number: 1,
    match_number: null,
    bracket_position: 0,
    court: null,
    participant_a_id: null,
    participant_b_id: null,
    pair_a_id: null,
    pair_b_id: null,
    ...over,
  };
}

const sideOf = (entryId: string | null) => ({ entryId, label: entryId ?? 'TBD' });
const ids = (rows: Array<{ match: { id: string } }>) => rows.map((r) => r.match.id);

describe('deskRows', () => {
  it('keeps one order however the states change, so no row moves under the desk', () => {
    const before = [
      match({ id: 'm2', match_number: 2, participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'm1', match_number: 1, participant_a_id: 'c', participant_b_id: 'd' }),
      match({ id: 'm3', match_number: 3, participant_a_id: 'e' }),
    ];
    const after = before.map((m) =>
      m.id === 'm2' ? { ...m, status: 'live', court: '3' } : m.id === 'm3' ? { ...m, participant_b_id: 'f' } : m,
    );
    expect(ids(deskRows(before, sideOf, false))).toEqual(['m1', 'm2', 'm3']);
    expect(ids(deskRows(after, sideOf, false))).toEqual(['m1', 'm2', 'm3']);
  });

  it('puts the whole pool before the bracket although round_number restarts', () => {
    const rows = deskRows([
      match({ id: 'qf', phase: 'bracket', round_number: 1, match_number: 1 }),
      match({ id: 'pool3', phase: 'pool', round_number: 3, match_number: 1 }),
      match({ id: 'pool1', phase: 'pool', round_number: 1, match_number: 1 }),
    ], sideOf, false);
    expect(ids(rows)).toEqual(['pool1', 'pool3', 'qf']);
  });

  it('falls back to bracket_position where there is no match number', () => {
    const rows = deskRows([
      match({ id: 'p1', bracket_position: 1 }),
      match({ id: 'p0', bracket_position: 0 }),
    ], sideOf, false);
    expect(ids(rows)).toEqual(['p0', 'p1']);
  });

  it('reads a TBD side as waiting, both sides known as callable, and live as live', () => {
    const rows = deskRows([
      match({ id: 'w', match_number: 1, participant_a_id: 'a' }),
      match({ id: 'c', match_number: 2, participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'l', match_number: 3, status: 'live', participant_a_id: 'c', participant_b_id: 'd' }),
    ], sideOf, false);
    expect(rows.map((r) => r.state)).toEqual(['waiting', 'callable', 'live']);
  });

  it('reads the pair columns on a doubles event', () => {
    const rows = deskRows([
      match({ id: 'd', participant_a_id: 'x', participant_b_id: 'y', pair_a_id: 'p', pair_b_id: 'q' }),
    ], sideOf, true);
    expect(rows[0]!.a.entryId).toBe('p');
    expect(rows[0]!.b.entryId).toBe('q');
  });

  it('drops byes, voided matches and anything with a result', () => {
    const rows = deskRows([
      match({ id: 'bye', is_bye: true, status: 'completed', participant_a_id: 'a' }),
      match({ id: 'bye-pending', is_bye: true }),
      match({ id: 'void', status: 'voided', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'done', status: 'completed', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'wo', status: 'walkover', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'disputed', status: 'disputed', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'open', participant_a_id: 'a', participant_b_id: 'b' }),
    ], sideOf, false);
    expect(ids(rows)).toEqual(['open']);
  });
});

describe('nextCallable', () => {
  it('is the earliest callable row, never a live one', () => {
    const rows = deskRows([
      match({ id: 'l', match_number: 1, status: 'live', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'w', match_number: 2, participant_a_id: 'c' }),
      match({ id: 'c1', match_number: 3, participant_a_id: 'd', participant_b_id: 'e' }),
      match({ id: 'c2', match_number: 4, participant_a_id: 'f', participant_b_id: 'g' }),
    ], sideOf, false);
    expect(nextCallable(rows)?.match.id).toBe('c1');
  });

  it('is null when everything left is live or waiting', () => {
    const rows = deskRows([
      match({ id: 'l', status: 'live', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'w', match_number: 2 }),
    ], sideOf, false);
    expect(nextCallable(rows)).toBeNull();
  });
});

describe('deskCounts', () => {
  it('counts each state once and the uncourted across all of them', () => {
    const rows = deskRows([
      match({ id: 'l', match_number: 1, status: 'live', court: 'Court 2', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'c', match_number: 2, court: '   ', participant_a_id: 'c', participant_b_id: 'd' }),
      match({ id: 'c2', match_number: 3, court: '4', participant_a_id: 'e', participant_b_id: 'f' }),
      match({ id: 'w', match_number: 4 }),
    ], sideOf, false);
    expect(deskCounts(rows)).toEqual({ live: 1, callable: 2, waiting: 1, uncourted: 2 });
  });

  it('is all zeroes on an empty list', () => {
    expect(deskCounts([])).toEqual({ live: 0, callable: 0, waiting: 0, uncourted: 0 });
  });
});

describe('buildEntryMaps', () => {
  const entries = [
    { id: 'z', seed_number: 2, status: 'registered', name: 'Zed' },
    { id: 'a', seed_number: null, status: 'checked_in', name: 'Ann' },
    { id: 'w', seed_number: 1, status: 'withdrawn', name: 'Wes' },
    { id: 'd', seed_number: 0, status: 'disqualified', name: 'Dee' },
  ];

  it('names every entry, seeds only the seeded, and places only those still in', () => {
    const { nameMap, seedMap, placeableEntries } = buildEntryMaps(entries, (e) => e.name);
    expect(nameMap).toEqual({ z: 'Zed', a: 'Ann', w: 'Wes', d: 'Dee' });
    expect(seedMap).toEqual({ z: 2, w: 1 });
    expect(placeableEntries).toEqual([{ id: 'a', name: 'Ann' }, { id: 'z', name: 'Zed' }]);
  });
});

describe('the event-level predicates', () => {
  it('lets the desk score across both halves of a pool_to_bracket event', () => {
    expect(deskEventPlaying('pool_generated')).toBe(true);
    expect(deskEventPlaying('bracket_generated')).toBe(true);
    expect(deskEventPlaying('live')).toBe(true);
    expect(deskEventPlaying('completed')).toBe(false);
    expect(deskEventPlaying('checkin')).toBe(false);
    expect(deskEventPlaying('bracket_generated', 'staged')).toBe(false);
    expect(deskEventPlaying('live', 'staged')).toBe(true);
  });

  it('offers the courts tab only on a drawn event that is not finished', () => {
    expect(hasCourtsTab('live')).toBe(true);
    expect(hasCourtsTab('completed')).toBe(false);
    expect(hasCourtsTab('registration')).toBe(false);
  });
});

// A grouped round robin: entries g1-* are in group 1 (A), g2-* in group 2 (B),
// g3-* in group 3 (C). The desk sides carry the group and the people behind them.
const groupOfEntry: Record<string, number> = {
  'g1-kestrel': 1, 'g1-heron': 1, 'g1-osprey': 1, 'g1-plover': 1,
  'g2-egret': 2, 'g2-finch': 2, 'g2-wren': 2, 'g2-swift': 2,
  'g3-rook': 3, 'g3-crane': 3,
};
const groupedSideOf = (entryId: string | null) => ({
  entryId,
  label: entryId ? `Team ${entryId.slice(3, 4).toUpperCase()}${entryId.slice(4)}` : 'TBD',
  players: entryId ? [{ name: `Player ${entryId.slice(3)}` }] : [],
  group: entryId ? groupOfEntry[entryId] ?? null : null,
});
const groupedRows = () => deskRows([
  match({ id: 'a1', phase: 'pool', match_number: 1, participant_a_id: 'g1-kestrel', participant_b_id: 'g1-heron', court: '1' }),
  match({ id: 'b1', phase: 'pool', match_number: 2, participant_a_id: 'g2-egret', participant_b_id: 'g2-finch' }),
  match({ id: 'c1', phase: 'pool', match_number: 3, status: 'live', participant_a_id: 'g3-rook', participant_b_id: 'g3-crane' }),
  match({ id: 'a2', phase: 'pool', match_number: 4, participant_a_id: 'g1-osprey', participant_b_id: 'g1-plover' }),
  match({ id: 'b2', phase: 'pool', match_number: 5, round_name: 'Round 1', participant_a_id: 'g2-wren', participant_b_id: 'g2-swift' }),
  match({ id: 'qf', phase: 'bracket', round_number: 1, match_number: 6, round_name: 'Quarter-final', participant_a_id: 'g1-kestrel' }),
], groupedSideOf, false);

describe('deskRowGroup and groupsInPlay', () => {
  it('reads the group off side a, or side b while a is TBD, and never on a knockout row', () => {
    const rows = groupedRows();
    expect(rows.map((r) => deskRowGroup(r))).toEqual([1, 2, 3, 1, 2, null]);
    expect(deskRowGroup({ match: { phase: 'pool' }, a: { group: null }, b: { group: 2 } })).toBe(2);
    expect(deskRowGroup({ match: { phase: null }, a: {}, b: {} })).toBeNull();
  });

  it('lists the groups still in play, ascending, without the knockout', () => {
    expect(groupsInPlay(groupedRows())).toEqual([1, 2, 3]);
    expect(groupsInPlay(groupedRows().filter((r) => r.match.id !== 'c1'))).toEqual([1, 2]);
  });
});

describe('filterDeskRows', () => {
  it('keeps every row when nothing is picked', () => {
    const rows = groupedRows();
    const { rows: mine, active } = filterDeskRows(rows, []);
    expect(mine).toBe(rows);
    expect(active).toEqual([]);
  });

  it('narrows to the picked groups, and next and the counts follow it', () => {
    const rows = groupedRows();
    const { rows: mine, active } = filterDeskRows(rows, [2]);
    expect(active).toEqual([2]);
    expect(ids(mine)).toEqual(['b1', 'b2']);
    expect(nextCallable(mine)?.match.id).toBe('b1');
    expect(deskCounts(mine)).toEqual({ live: 0, callable: 2, waiting: 0, uncourted: 2 });

    const both = filterDeskRows(rows, [3, 1]);
    expect(both.active).toEqual([1, 3]);
    expect(ids(both.rows)).toEqual(['a1', 'c1', 'a2']);
    expect(nextCallable(both.rows)?.match.id).toBe('a1');
    expect(deskCounts(both.rows).live).toBe(1);
  });

  it('ignores a saved pick of groups that have all finished, rather than hiding everything', () => {
    const rows = groupedRows();
    const { rows: mine, active } = filterDeskRows(rows, [7]);
    expect(active).toEqual([]);
    expect(mine).toBe(rows);
    expect(filterDeskRows(rows, [7, 3]).active).toEqual([3]);
  });
});

describe('deskRoundLine', () => {
  it('names the group, the phase, the round and the match number', () => {
    const [a1, , , , b2, qf] = groupedRows();
    expect(deskRoundLine(a1!.match, 1)).toBe('Group A · Pool · Round 1 · M1');
    expect(deskRoundLine(b2!.match, 2)).toBe('Group B · Pool · Round 1 · M5');
    expect(deskRoundLine(qf!.match)).toBe('Knockout · Quarter-final · M6');
    expect(deskRoundLine(match({ id: 'x', round_number: 3 }))).toBe('Round 3');
  });
});

describe('deskRowMatchesSearch', () => {
  const rows = groupedRows();
  const find = (q: string) => ids(rows.filter((r) => deskRowMatchesSearch(r, q)));

  it('fits every row on a blank query', () => {
    expect(find('')).toEqual(ids(rows));
    expect(find('   ')).toEqual(ids(rows));
  });

  it('matches a side label or a player name, case-insensitively', () => {
    expect(find('team egret')).toEqual(['b1']);
    expect(find('PLAYER wren')).toEqual(['b2']);
  });

  it('matches the court, the match number and the group', () => {
    expect(find('court 1')).toEqual(['a1']);
    expect(find('m5')).toEqual(['b2']);
    expect(find('group c')).toEqual(['c1']);
    expect(find('knockout')).toEqual(['qf']);
  });

  it('narrows only the list: next and the counts are worked out before it', () => {
    const { rows: mine } = filterDeskRows(rows, []);
    const next = nextCallable(mine);
    const counts = deskCounts(mine);
    const shown = mine.filter((r) => deskRowMatchesSearch(r, 'team swift'));
    expect(ids(shown)).toEqual(['b2']);
    expect(next?.match.id).toBe('a1');
    expect(counts).toEqual(deskCounts(rows));
  });
});

describe('a staged event on the desk', () => {
  const cfg = poolsThenPlacement({ pools: 4, groupsPerPool: 2, groupSize: 3 });
  const staged = (id: string, over: Partial<DeskMatch>) =>
    match({ id, stage: 1, phase: null, participant_a_id: `${id}a`, participant_b_id: `${id}b`, ...over });
  const rowsOf = (ms: DeskMatch[]) => deskRows(ms, (e) => ({ ...sideOf(e), group: 9 }), false);

  it('runs stage by stage, then slot, then match number, whatever the round says', () => {
    const rows = rowsOf([
      staged('final', { stage: 2, round_number: 1, match_number: 1, match_label: 'final' }),
      staged('s2m3', { pool_number: 2, group_number: 1, slot: 2, round_number: 1, match_number: 3 }),
      staged('s1m2', { pool_number: 1, group_number: 2, slot: 1, round_number: 1, match_number: 2 }),
      staged('s1m1', { pool_number: 2, group_number: 2, slot: 1, round_number: 2, match_number: 1 }),
    ]);
    expect(ids(rows)).toEqual(['s1m1', 's1m2', 's2m3', 'final']);
  });

  it('reads the group off the row, so group A of pool 1 and of pool 2 stay apart', () => {
    const rows = rowsOf([
      staged('p1a', { pool_number: 1, group_number: 1, match_number: 1 }),
      staged('p2a', { pool_number: 2, group_number: 1, match_number: 2 }),
      staged('final', { stage: 2, match_label: 'final', match_number: 3 }),
    ]);
    expect(rows.map(deskRowGroup)).toEqual([stagedGroupKey(1, 1, 1), stagedGroupKey(1, 2, 1), null]);
    expect(groupsInPlay(rows)).toEqual([10101, 10201]);
    const { rows: mine } = filterDeskRows(rows, [stagedGroupKey(1, 2, 1)]);
    expect(ids(mine)).toEqual(['p2a']);
  });

  it('round-trips a group key and leaves a legacy group number alone', () => {
    expect(stagedGroupParts(stagedGroupKey(1, 3, 2))).toEqual({ stage: 1, pool: 3, group: 2 });
    expect(stagedGroupParts(4)).toBeNull();
  });

  it('labels groups by pool, as on the sheet', () => {
    expect(deskGroupLabel(stagedGroupKey(1, 2, 2), cfg)).toBe('G2 Group B');
    expect(deskGroupChipLabel(stagedGroupKey(1, 2, 2), cfg)).toBe('G2 B');
    expect(deskGroupLabel(3)).toBe('Group C');
    expect(deskGroupChipLabel(3)).toBe('C');
  });

  it('offers a chip per pool holding its groups in play', () => {
    const keys = [stagedGroupKey(1, 1, 1), stagedGroupKey(1, 1, 2), stagedGroupKey(1, 2, 1)];
    expect(deskPools(keys, cfg)).toEqual([{ key: '1:1', label: 'G1', groups: [10101, 10102] }]);
    expect(deskPools([1, 2], cfg)).toEqual([]);
  });

  it('names the group and slot, the stage, and a placement match by its name', () => {
    const g = staged('g', { pool_number: 2, group_number: 2, round_number: 3, round_name: 'Round 3', match_number: 12 });
    expect(deskRoundLine(g, stagedGroupKey(1, 2, 2), cfg)).toBe('G2 Group B · Round 3 · M12');
    const third = staged('t', { stage: 2, match_label: 'third', round_name: 'Finals', match_number: 14 });
    expect(deskRoundLine(third, null, cfg)).toBe('Finals · Third place · M14');
    expect(deskRowMatchesSearch({ match: third, a: { label: 'x' }, b: { label: 'y' } }, 'third place', cfg)).toBe(true);
  });
});

describe('deskCourtSuggestion', () => {
  const courts: TournamentCourt[] = [
    { id: 'c1', label: '1', sort_order: 1, active: true },
    { id: 'c2', label: '2', sort_order: 2, active: true },
    { id: 'c3', label: '3', sort_order: 3, active: false },
  ];
  const row = (over: Partial<DeskMatch>) => ({ match: match({ id: 'm', ...over }) });

  it('suggests nothing when the tournament lists no courts', () => {
    expect(deskCourtSuggestion(row({}), null, new Set())).toBeNull();
    expect(deskCourtSuggestion(row({}), [], new Set())).toBeNull();
  });

  it('suggests the first free court for a match with none', () => {
    expect(deskCourtSuggestion(row({}), courts, new Set())?.id).toBe('c1');
    expect(deskCourtSuggestion(row({}), courts, new Set(['c1']))?.id).toBe('c2');
  });

  it('suggests nothing for a match already on a free active court, linked or typed', () => {
    expect(deskCourtSuggestion(row({ court: '2', court_id: 'c2' }), courts, new Set())).toBeNull();
    expect(deskCourtSuggestion(row({ court: 'Court 2' }), courts, new Set())).toBeNull();
  });

  it('moves a match off a busy or switched-off court', () => {
    expect(deskCourtSuggestion(row({ court: '1', court_id: 'c1' }), courts, new Set(['c1']))?.id).toBe('c2');
    expect(deskCourtSuggestion(row({ court: '3', court_id: 'c3' }), courts, new Set())?.id).toBe('c1');
  });

  it('suggests nothing when every active court is busy', () => {
    expect(deskCourtSuggestion(row({}), courts, new Set(['c1', 'c2']))).toBeNull();
  });

  // A staged match's stage courts: only these are suggested.
  it('keeps to the allowed courts', () => {
    const onlyTwo = [courts[1]!];
    expect(deskCourtSuggestion(row({}), courts, new Set(), onlyTwo)?.id).toBe('c2');
    expect(deskCourtSuggestion(row({ court: '2', court_id: 'c2' }), courts, new Set(), onlyTwo)).toBeNull();
    expect(deskCourtSuggestion(row({}), courts, new Set(['c2']), onlyTwo)).toBeNull();
  });

  it('never calls a current court outside the allowed ones fine', () => {
    const onlyTwo = [courts[1]!];
    expect(deskCourtSuggestion(row({ court: '1', court_id: 'c1' }), courts, new Set(), onlyTwo)?.id).toBe('c2');
    expect(deskCourtSuggestion(row({ court: 'Court 1' }), courts, new Set(), onlyTwo)?.id).toBe('c2');
  });

  it('skips a switched-off allowed court, and null allows any', () => {
    expect(deskCourtSuggestion(row({}), courts, new Set(), [courts[2]!, courts[1]!])?.id).toBe('c2');
    expect(deskCourtSuggestion(row({}), courts, new Set(), null)?.id).toBe('c1');
  });
});

describe('the next match for a court', () => {
  const groups = groupsThenTopKnockout({ pools: 2, courts: [['1'], ['2']] });
  const twoCourtPool = groupsThenTopKnockout({ pools: 2, courts: [['1', '2'], ['3']] });
  const listedKnockout = {
    ...groups,
    stages: groups.stages.map((s) => (s.kind === 'knockout' ? { ...s, courts: ['3', '4'] } : s)),
  };
  const openKnockout = {
    ...groups,
    stages: groups.stages.map((s) => (s.kind === 'knockout' ? { ...s, courts: undefined } : s)),
  };
  const courts: TournamentCourt[] = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, label: `Court ${n}`, sort_order: n, active: true }));
  const court = (n: number) => courts[n - 1]!;
  const group = (id: string, pool: number, courtNo: number, slot: number, a: string, b: string, over: Partial<DeskMatch> = {}) =>
    match({
      id, stage: 1, pool_number: pool, group_number: 1, slot, match_number: slot * 10 + pool,
      court: `Court ${courtNo}`, court_id: `c${courtNo}`, participant_a_id: a, participant_b_id: b, ...over,
    });
  const knockout = (id: string, n: number, a: string | null, b: string | null, over: Partial<DeskMatch> = {}) =>
    match({ id, stage: 2, round_number: 1, match_number: 100 + n, participant_a_id: a, participant_b_id: b, ...over });
  const rowsOf = (ms: DeskMatch[]) => deskRows(ms, sideOf, false);

  it('gives court 1 the first callable match drawn on it, and never a pool 2 match', () => {
    const rows = rowsOf([
      group('p2s1', 2, 2, 1, 'e', 'f'),
      group('p1s2', 1, 1, 2, 'a', 'c'),
      group('p1s1', 1, 1, 1, 'a', 'b'),
    ]);
    expect(nextMatchForCourt(rows, court(1), courts, groups)?.match.id).toBe('p1s1');
    expect(nextMatchForCourt(rows, court(2), courts, groups)?.match.id).toBe('p2s1');
    expect(nextMatchForCourt(rows.filter((r) => r.match.pool_number === 2), court(1), courts, groups)).toBeNull();
  });

  it('skips a match whose entrant is on court, unless that match is let off', () => {
    const rows = rowsOf([
      group('live', 1, 1, 1, 'a', 'b', { status: 'live' }),
      group('next', 1, 1, 2, 'a', 'c'),
      group('after', 1, 1, 3, 'd', 'e'),
    ]);
    expect(liveEntrants(rows)).toEqual(new Set(['a', 'b']));
    expect(nextMatchForCourt(rows, court(1), courts, groups)?.match.id).toBe('after');
    expect(nextMatchForCourt(rows, court(1), courts, groups, { busyEntries: liveEntrants(rows, 'live') })?.match.id).toBe('next');
  });

  it('keeps a pool with two courts to the court each match was drawn on', () => {
    const rows = rowsOf([group('on1', 1, 1, 1, 'a', 'b'), group('on1b', 1, 1, 2, 'c', 'd')]);
    expect(nextMatchForCourt(rows, court(2), courts, twoCourtPool)).toBeNull();
    expect(nextMatchForCourt(rows, court(1), courts, twoCourtPool)?.match.id).toBe('on1');
  });

  it('puts a listed knockout on its own courts only, and an open one on any', () => {
    const rows = rowsOf([knockout('qf1', 1, 'a', 'b')]);
    expect(nextMatchForCourt(rows, court(1), courts, listedKnockout)).toBeNull();
    expect(nextMatchForCourt(rows, court(3), courts, listedKnockout)?.match.id).toBe('qf1');
    expect(nextMatchForCourt(rows, court(1), courts, openKnockout)?.match.id).toBe('qf1');
  });

  it('never returns a waiting or a live match, and gives a switched-off court nothing', () => {
    const rows = rowsOf([
      knockout('live', 1, 'a', 'b', { status: 'live', court: 'Court 3', court_id: 'c3' }),
      knockout('tbd', 2, 'c', null),
    ]);
    expect(nextMatchForCourt(rows, court(4), courts, openKnockout)).toBeNull();
    const ready = rowsOf([knockout('qf', 1, 'a', 'b')]);
    expect(nextMatchForCourt(ready, { ...court(1), active: false }, courts, openKnockout)).toBeNull();
  });

  it('keeps the stage, slot and match number order', () => {
    const rows = rowsOf([
      knockout('ko', 1, 'x', 'y'),
      group('s2', 1, 1, 2, 'c', 'd'),
      group('s1b', 1, 1, 1, 'e', 'f', { match_number: 12 }),
      group('s1a', 1, 1, 1, 'a', 'b', { match_number: 11 }),
    ]);
    expect(nextMatchForCourt(rows, court(1), courts, openKnockout)?.match.id).toBe('s1a');
  });

  it('plans one match per free court at Start, never a match or an entrant twice', () => {
    const rows = rowsOf([knockout('qf1', 1, 'a', 'b'), knockout('qf2', 2, 'a', 'c'), knockout('qf3', 3, 'd', 'e')]);
    const plan = planCourtCalls(rows, courts, new Set(), openKnockout);
    expect(plan.map((p) => [p.row.match.id, p.court.id])).toEqual([['qf1', 'c1'], ['qf3', 'c2']]);
  });

  it('skips a busy court, fills the preferred court first, and plans nothing without courts', () => {
    const rows = rowsOf([knockout('qf1', 1, 'a', 'b'), knockout('qf2', 2, 'c', 'd')]);
    expect(planCourtCalls(rows, courts, new Set(['c1']), openKnockout).map((p) => p.court.id)).toEqual(['c2', 'c3']);
    expect(planCourtCalls(rows, courts, new Set(), openKnockout, 'c4').map((p) => [p.row.match.id, p.court.id]))
      .toEqual([['qf1', 'c4'], ['qf2', 'c1']]);
    expect(planCourtCalls(rows, [], new Set(), openKnockout)).toEqual([]);
  });
});

describe('inlineScoreVerdict', () => {
  const rules: MatchRules = { bestOf: 1, target: 15, winByTwo: true, cap: 24, startA: 0, startB: 0 };
  const names = { a: 'Ann', b: 'Bo' };
  const one = (a: string, b: string, r: MatchRules | null = rules) => inlineScoreVerdict([{ a, b }], r, names);

  it('names the winner of a finished game', () => {
    expect(one('15', '13').winner).toBe('a');
    expect(one('13', '15').winner).toBe('b');
    expect(one('17', '15')).toEqual({ winner: 'a', error: null, scores: [{ a: 17, b: 15 }] });
    expect(one('24', '23').winner).toBe('a');
  });

  it('refuses an unfinished or impossible game with the shared wording', () => {
    for (const [a, b] of [['25', '23'], ['15', '14'], ['16', '15']] as const) {
      const v = one(a, b);
      expect(v.winner).toBeNull();
      expect(v.error).toBe(`Game 1: ${a}-${b} is not a finished game.`);
    }
    expect(one('1e', '15').error).toBe('Scores must be whole numbers.');
  });

  it('says nothing while blank or on a head start alone', () => {
    expect(one('', '')).toEqual({ winner: null, error: null, scores: [] });
    expect(one('15', '')).toEqual({ winner: null, error: null, scores: [] });
    expect(one('3', '', { ...rules, startA: 3 })).toEqual({ winner: null, error: null, scores: [] });
    expect(one('5', '5', null).error).toBe('This stage\'s rules could not be read. Reload the page and try again.');
  });
});

describe('autoCallFailureText', () => {
  it('is null when nothing failed, and names the court when one did', () => {
    expect(autoCallFailureText(undefined)).toBeNull();
    expect(autoCallFailureText({ called: [{ matchId: 'm', court: 'Court 1' }], failed: [] })).toBeNull();
    expect(autoCallFailureText({ called: [], failed: [{ court: 'Court 2', reason: 'boom' }, { court: null, reason: 'down' }] }))
      .toBe('Next match could not be called: Court 2: boom; down');
  });
});
