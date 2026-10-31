import { describe, it, expect } from 'vitest';
import { poolsThenPlacement, poolsThenSemisFinal, type GroupsStage, type SlotRef } from '@badminton/shared';
import {
  addCategory,
  addMatch,
  addStage,
  changeStageKind,
  moveStage,
  presetConfig,
  removeCategory,
  removeStage,
  setHeadStart,
  setPools,
  setScoring,
  slotOptions,
  slotOptionsFor,
  slotValue,
  stagedEditorErrors,
} from '../staged-editor';
import { lateEntrantConfirmMessage, lateEntryWindow, stageDrawControl, stageExtendControl } from '../stage-controls';

describe('presets', () => {
  it('builds the owner preset, unrated everywhere for an external event', () => {
    const res = presetConfig('poolsThenPlacement', { pools: 4 }, true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.stages.every((s) => s.rated === false)).toBe(true);
  });

  it('says why a preset cannot be built rather than throwing', () => {
    expect(presetConfig('poolsThenSemisFinal', { pools: 3 }, false))
      .toEqual({ ok: false, error: 'Semi-finals from pools need exactly four pools.' });
    expect(presetConfig('poolsThenPlacement', { pools: 3 }, false).ok).toBe(false);
  });
});

describe('stages', () => {
  const cfg = poolsThenPlacement();

  it('adds a stage with a fresh key that reads from the stage before it, and saves clean', () => {
    const next = addStage(cfg, 'knockout');
    const added = next.stages[2]!;
    expect(added.key).toBe('stage1');
    expect(added.entrants.from).toBe('slots');
    expect(stagedEditorErrors(next, null, new Set())).toEqual([]);
    expect(addStage(next, 'groups').stages[3]!.key).toBe('stage2');
  });

  it('changes a kind keeping the key, name and scoring', () => {
    const next = changeStageKind(cfg, 1, 'knockout');
    expect(next.stages[1]).toMatchObject({ kind: 'knockout', key: 'finals', name: 'Finals', scoring: cfg.stages[1]!.scoring });
  });

  it('moves and removes stages, and a stage reading a later one is reported in words', () => {
    const moved = moveStage(cfg, 1, -1);
    expect(moved.stages.map((s) => s.key)).toEqual(['finals', 'groups']);
    expect(stagedEditorErrors(moved, null, new Set()).length).toBeGreaterThan(0);
    expect(moveStage(cfg, 0, -1)).toBe(cfg);
    expect(removeStage(cfg, 1).stages).toHaveLength(1);
  });

  it('turns rating off with head starts on', () => {
    const rated = { ...cfg.stages[1]!, rated: true, scoring: { ...cfg.stages[1]!.scoring, handicap: false } };
    expect(setScoring(rated, { handicap: true }).rated).toBe(false);
    expect(setScoring(rated, { target: 15 }).rated).toBe(true);
  });

  it('keeps one court list per pool when the pool count changes', () => {
    const groups = cfg.stages[0] as GroupsStage;
    const fewer = setPools(groups, 2);
    expect(fewer.courts).toEqual({ mode: 'per_pool', pools: [['1', '2'], ['3', '4']] });
    const more = setPools(groups, 5);
    expect(more.courts?.mode === 'per_pool' && more.courts.pools).toHaveLength(5);
  });

  it('adds a named match with the next free label', () => {
    const next = addMatch(cfg, 1);
    const stage = next.stages[1]!;
    expect(stage.kind === 'matches' && stage.matches.map((m) => m.label)).toEqual(['final', 'third', 'm1']);
  });
});

describe('slot options', () => {
  it('offers pool winners, group places and the best of each place from the groups', () => {
    const cfg = poolsThenPlacement();
    const labels = slotOptions(cfg, 1, false).map((o) => o.label);
    expect(labels).toContain('G2 winner');
    expect(labels).toContain('G3 Group B 2nd');
    expect(labels).toContain('1st best 1st place');
  });

  it('offers the seeds of a reseeding stage on a match side, and match results from earlier named matches', () => {
    const cfg = poolsThenSemisFinal();
    expect(slotOptions(cfg, 1, true).some((o) => o.ref.type === 'seed')).toBe(false);
    const finals = slotOptions(cfg, 2, true).map((o) => o.label);
    expect(finals).toContain('Winner of semi1');
    expect(finals).toContain('Loser of semi2');
    const placement = slotOptions(poolsThenPlacement(), 1, true).map((o) => o.label);
    expect(placement).toContain('Seed 4');
  });

  it('finds a stored ref whatever order its keys were written in, and keeps an unlisted one', () => {
    const ref = { place: 1, pool: 2, type: 'pool_place', stage: 'groups' } as const;
    const opts = slotOptions(poolsThenPlacement(), 1, false);
    expect(opts.some((o) => o.value === slotValue(ref))).toBe(true);
    const odd: SlotRef = { type: 'group_rank', stage: 'groups', place: 3, rankBy: ['points_for'], count: 2 };
    expect(slotOptionsFor(poolsThenPlacement(), 1, false, odd)[0]!.value).toBe(slotValue(odd));
  });
});

describe('categories and head starts', () => {
  const cfg = poolsThenPlacement();

  it('adds a category under a generated key and removes one with its head starts', () => {
    const added = addCategory(cfg, 'Juniors');
    expect(added.categories.at(-1)).toEqual({ key: 'cat1', label: 'Juniors' });
    const key = cfg.categories[0]!.key;
    const removed = removeCategory(cfg, key);
    expect(removed.categories.some((c) => c.key === key)).toBe(false);
    expect(Object.keys(removed.headStarts)).not.toContain(key);
    expect(Object.values(removed.headStarts).every((cols) => !(key in cols))).toBe(true);
  });

  it('stores a head start, drops a zero, and never one against itself', () => {
    const [a, b] = cfg.categories.map((c) => c.key);
    const set = setHeadStart(cfg, a!, b!, 4);
    expect(set.headStarts[a!]![b!]).toBe(4);
    expect(setHeadStart(set, a!, b!, 0).headStarts[a!]?.[b!]).toBeUndefined();
    expect(setHeadStart(cfg, a!, a!, 3)).toBe(cfg);
  });

  it('refuses a categories change once a stage is drawn', () => {
    expect(stagedEditorErrors(addCategory(cfg, 'Juniors'), cfg, new Set([1])))
      .toEqual(['Categories and head starts are fixed once the first stage is drawn.']);
  });
});

describe('stageDrawControl', () => {
  const base = { status: 'live' as const, drawLocked: false, canGenerate: true, laterDrawn: false, rows: [] };
  const stage = { number: 2, name: 'Finals', drawn: false, ready: true, waitingOn: [] };

  it('draws a ready stage, and says what it is waiting on otherwise', () => {
    expect(stageDrawControl(stage, base)).toEqual({ action: 'draw', blockedReason: null });
    expect(stageDrawControl({ ...stage, ready: false, waitingOn: ['Group stage'] }, base).blockedReason)
      .toBe('Waiting on Group stage to finish.');
    expect(stageDrawControl(stage, { ...base, status: 'bracket_generated' }).blockedReason)
      .toBe('Start the event before drawing a later stage.');
    expect(stageDrawControl({ ...stage, number: 1 }, { ...base, status: 'checkin' }).blockedReason).toBeNull();
  });

  it('refuses a redraw with a later stage drawn or a result in the stage', () => {
    const drawn = { ...stage, drawn: true };
    expect(stageDrawControl(drawn, { ...base, laterDrawn: true }).blockedReason).toBe('A later stage has been drawn from this one.');
    const played = [{ status: 'completed', is_bye: false, winner_participant_id: 'x', winner_pair_id: null, scores: [{ a: 21, b: 10 }], elo_snapshot: null }];
    expect(stageDrawControl(drawn, { ...base, rows: played as never }).blockedReason).toMatch(/has a result/);
    expect(stageDrawControl(drawn, base)).toEqual({ action: 'redraw', blockedReason: null });
  });

  it('says why when the draw is locked, finalised or out of reach', () => {
    expect(stageDrawControl(stage, { ...base, drawLocked: true }).blockedReason).toMatch(/locked/);
    expect(stageDrawControl(stage, { ...base, status: 'completed' }).blockedReason).toMatch(/finalised/);
    expect(stageDrawControl(stage, { ...base, canGenerate: false }).blockedReason).toMatch(/permission/);
  });
});

describe('stageExtendControl', () => {
  const base = { status: 'live' as const, drawLocked: false, canGenerate: true, laterDrawn: false };
  const groups = { kind: 'groups' as const, drawn: true };

  it('offers Add a round on a drawn groups stage, before and after Start', () => {
    expect(stageExtendControl(groups, base)).toEqual({ blockedReason: null });
    expect(stageExtendControl(groups, { ...base, status: 'bracket_generated' })).toEqual({ blockedReason: null });
  });

  it('has no button on an undrawn stage, a knockout, named matches or a finalised event', () => {
    expect(stageExtendControl({ ...groups, drawn: false }, base)).toBeNull();
    expect(stageExtendControl({ kind: 'knockout', drawn: true }, base)).toBeNull();
    expect(stageExtendControl({ kind: 'matches', drawn: true }, base)).toBeNull();
    expect(stageExtendControl(groups, { ...base, status: 'completed' })).toBeNull();
  });

  it('greys it with the reason the server would give', () => {
    expect(stageExtendControl(groups, { ...base, canGenerate: false })?.blockedReason).toMatch(/permission/);
    expect(stageExtendControl(groups, { ...base, drawLocked: true })?.blockedReason).toMatch(/locked/);
    expect(stageExtendControl(groups, { ...base, laterDrawn: true })?.blockedReason).toBe('A later stage has been drawn from this one.');
    expect(stageExtendControl(groups, { ...base, status: 'checkin' })?.blockedReason).toMatch(/Draw the stage/);
  });
});

describe('lateEntryWindow', () => {
  const groupsFirst = poolsThenSemisFinal();
  const knockoutOnly = presetConfig('groupsThenTopKnockout', { pools: 2, advance: 4 }, false);
  const knockoutFirst = knockoutOnly.ok ? { ...knockoutOnly.config, stages: knockoutOnly.config.stages.slice(1) } : null;
  const base = { format: 'staged', status: 'live', draw_locked: false, format_config: groupsFirst };

  it('opens once the first stage is drawn, at bracket_generated or live', () => {
    expect(lateEntryWindow(base, [1, 1, 1])).toBe(true);
    expect(lateEntryWindow({ ...base, status: 'bracket_generated' }, [1])).toBe(true);
  });

  it('shuts once a later stage is drawn, or before the first is', () => {
    expect(lateEntryWindow(base, [1, 1, 2])).toBe(false);
    expect(lateEntryWindow(base, [])).toBe(false);
    expect(lateEntryWindow(base, [null])).toBe(false);
  });

  it('is shut for a locked draw, another status, another format or a first stage that is not groups', () => {
    expect(lateEntryWindow({ ...base, draw_locked: true }, [1])).toBe(false);
    for (const status of ['registration', 'checkin', 'completed']) expect(lateEntryWindow({ ...base, status }, [1])).toBe(false);
    expect(lateEntryWindow({ ...base, format: 'round_robin' }, [1])).toBe(false);
    expect(lateEntryWindow({ ...base, format_config: knockoutFirst }, [1])).toBe(false);
    expect(lateEntryWindow({ ...base, format_config: { nonsense: true } }, [1])).toBe(false);
  });
});

describe('lateEntrantConfirmMessage', () => {
  it('names the group and the opponents', () => {
    expect(lateEntrantConfirmMessage({ level: true, anyOddGroup: true }, 'Group A', ['Ann', 'Bo', 'Cy']))
      .toBe('Joins Group A and plays Ann, Bo and Cy. Everyone ends level.');
    expect(lateEntrantConfirmMessage({ level: true, anyOddGroup: false }, 'Group B', ['Ann']))
      .toBe('Joins Group B and plays Ann. Everyone ends level.');
  });

  it('warns when the group will be uneven', () => {
    expect(lateEntrantConfirmMessage({ level: false, anyOddGroup: false }, 'Group A', ['Ann', 'Bo']))
      .toBe('Joins Group A and plays Ann and Bo. No group has an odd number of teams, so Group A will be uneven.');
    expect(lateEntrantConfirmMessage({ level: false, anyOddGroup: true }, 'Group A', ['Ann', 'Bo']))
      .toMatch(/No group can take them and end level/);
  });
});

describe('the top N preset saves', () => {
  // The Save button is disabled while stagedEditorErrors has anything to say,
  // and the server runs the same checkFormatConfig, so every shape the picker
  // can make has to pass both.
  it.each([
    [3, 8], [4, 2], [1, 4], [3, 16], [4, 4], [2, 32], [8, 8],
  ])('%i groups, %i through', (groups, advance) => {
    for (const unrated of [false, true]) {
      const res = presetConfig('groupsThenTopKnockout', { pools: groups, advance }, unrated);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(stagedEditorErrors(res.config, null, new Set())).toEqual([]);
    }
  });
});
