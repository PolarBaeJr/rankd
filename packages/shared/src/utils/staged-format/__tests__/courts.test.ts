import { describe, expect, it } from 'vitest';
import {
  allowedCourtsSentence,
  allowedTournamentCourts,
  formatConfigSchema,
  groupsThenTopKnockout,
  poolsThenPlacement,
  stageCourtLabels,
  stagedConfigEditRefusal,
  type FormatConfig,
  type TournamentCourt,
} from '../../..';

const withKnockoutCourts = (cfg: FormatConfig, courts: string[] | undefined): FormatConfig => ({
  ...cfg,
  stages: cfg.stages.map((s) => (s.kind === 'knockout' ? { ...s, courts } : s)),
});

const court = (id: string, label: string, sort_order: number, active = true): TournamentCourt =>
  ({ id, label, sort_order, active });
const COURTS = [court('c1', 'Court 1', 1), court('c2', 'Court 2', 2), court('c3', 'Court 3', 3)];

describe('the knockout courts key', () => {
  const base = groupsThenTopKnockout({ pools: 2, courts: [['1'], ['2']] });

  it('parses a knockout with and without courts', () => {
    const without = formatConfigSchema.parse(base);
    expect(without.stages[1]!.kind === 'knockout' && without.stages[1]!.courts).toBeUndefined();
    const listed = formatConfigSchema.parse(withKnockoutCourts(base, ['1', '2', '3']));
    expect(listed.stages[1]!.kind === 'knockout' && listed.stages[1]!.courts).toEqual(['1', '2', '3']);
  });

  it('refuses an empty list', () => {
    expect(formatConfigSchema.safeParse(withKnockoutCourts(base, [])).success).toBe(false);
  });
});

describe('stageCourtLabels', () => {
  const cfg = groupsThenTopKnockout({ pools: 2, courts: [['1'], ['2']] });

  it('gives each pool of a groups stage its own courts', () => {
    expect(stageCourtLabels(cfg, { stage: 1, pool_number: 1 })).toEqual(['1']);
    expect(stageCourtLabels(cfg, { stage: 1, pool_number: 2 })).toEqual(['2']);
    expect(stageCourtLabels(cfg, { stage: 1, pool_number: 3 })).toBeNull();
  });

  it('gives every pool the shared list', () => {
    const shared: FormatConfig = {
      ...cfg,
      stages: cfg.stages.map((s) => (s.kind === 'groups' ? { ...s, courts: { mode: 'shared' as const, courts: ['1', '2'] } } : s)),
    };
    expect(stageCourtLabels(shared, { stage: 1, pool_number: 2 })).toEqual(['1', '2']);
  });

  it('is any court for a groups stage with no courts', () => {
    expect(stageCourtLabels(groupsThenTopKnockout({ pools: 2, courts: null }), { stage: 1, pool_number: 1 })).toBeNull();
  });

  it('reads a knockout list, and is any court without one', () => {
    expect(stageCourtLabels(cfg, { stage: 2, pool_number: null })).toBeNull();
    expect(stageCourtLabels(withKnockoutCourts(cfg, ['1-8']), { stage: 2 })).toEqual(['1-8']);
  });

  it('is any court for a matches stage, no config, or no stage', () => {
    expect(stageCourtLabels(poolsThenPlacement(), { stage: 2 })).toBeNull();
    expect(stageCourtLabels(null, { stage: 1, pool_number: 1 })).toBeNull();
    expect(stageCourtLabels(cfg, { stage: null })).toBeNull();
    expect(stageCourtLabels(cfg, { stage: 9 })).toBeNull();
  });
});

describe('allowedTournamentCourts', () => {
  it('matches "1" to Court 1 by key', () => {
    expect(allowedTournamentCourts(COURTS, ['1'])!.map((c) => c.id)).toEqual(['c1']);
    expect(allowedTournamentCourts(COURTS, ['3', 'court 1'])!.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('is null for no restriction', () => {
    expect(allowedTournamentCourts(COURTS, null)).toBeNull();
  });

  it('falls back to any court when no label names an active court', () => {
    const off = [court('c1', 'Court 1', 1, false), court('c2', 'Court 2', 2)];
    expect(allowedTournamentCourts(off, ['1'])).toBeNull();
    expect(allowedTournamentCourts(COURTS, ['Centre'])).toBeNull();
  });
});

describe('allowedCourtsSentence', () => {
  it('names one court or lists several', () => {
    expect(allowedCourtsSentence(['1'])).toBe('Court 1');
    expect(allowedCourtsSentence(['1', 'Court 2'])).toBe('Courts 1, 2');
  });
});

describe('changing a drawn stage\'s courts', () => {
  const prev = groupsThenTopKnockout({ pools: 2, courts: [['1'], ['2']] });
  const drawn = new Set([1]);

  it('allows a courts-only change', () => {
    const next: FormatConfig = {
      ...prev,
      stages: prev.stages.map((s) => (s.kind === 'groups' ? { ...s, courts: { mode: 'per_pool' as const, pools: [['3'], ['2']] } } : s)),
    };
    expect(stagedConfigEditRefusal(prev, next, drawn)).toBeNull();
    expect(stagedConfigEditRefusal(prev, withKnockoutCourts(prev, ['1', '2']), new Set([1, 2]))).toBeNull();
  });

  it('still refuses any other change', () => {
    const next: FormatConfig = {
      ...prev,
      stages: prev.stages.map((s) => (s.kind === 'groups' ? { ...s, interleave: !s.interleave, courts: { mode: 'per_pool' as const, pools: [['3'], ['2']] } } : s)),
    };
    expect(stagedConfigEditRefusal(prev, next, drawn)).toMatch(/has been drawn/);
  });
});
