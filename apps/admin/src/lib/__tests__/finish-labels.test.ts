import { describe, it, expect } from 'vitest';
import { finishLabel, knockoutRounds, type FinishLabelMatch } from '../finish-labels';

const row = (round: number, over: Partial<FinishLabelMatch> = {}): FinishLabelMatch => ({
  status: 'completed', round_number: round, ...over,
});
const labels = (rounds: number, playoff = false, upTo = 8) =>
  Array.from({ length: upTo }, (_, i) => finishLabel(i + 1, rounds, playoff));

describe('knockoutRounds', () => {
  it('reads a staged Top 4 after groups as two rounds', () => {
    const matches = [
      ...Array.from({ length: 6 }, () => row(1, { stage: 1, group_number: 1 })),
      row(1, { stage: 2 }), row(1, { stage: 2 }), row(2, { stage: 2 }),
    ];
    expect(knockoutRounds(matches, 'staged')).toBe(2);
  });

  it('ignores a later stage whose every row was voided', () => {
    const matches = [
      row(1, { stage: 2 }), row(1, { stage: 2 }), row(2, { stage: 2 }),
      row(1, { stage: 3, status: 'voided' }),
    ];
    expect(knockoutRounds(matches, 'staged')).toBe(2);
  });

  it('leaves the third-place match out of the round count', () => {
    expect(knockoutRounds([row(1), row(1), row(2), row(2, { is_third_place: true })], 'single_elimination')).toBe(2);
  });

  it('reads only the bracket half of a pool_to_bracket event', () => {
    expect(knockoutRounds([row(1, { phase: 'pool' }), row(2, { phase: 'pool' }), row(3, { phase: 'pool' }), row(1, { phase: 'bracket' })], 'pool_to_bracket')).toBe(1);
  });

  it('gives a round robin no knockout rounds', () => {
    expect(knockoutRounds([row(1), row(2), row(3), row(4)], 'round_robin')).toBe(0);
  });
});

describe('finishLabel', () => {
  it('labels 5th to 8th by place when the knockout was only a Top 4', () => {
    expect(labels(2)).toEqual(['Champion', 'Finalist', 'Semi-finalist', 'Semi-finalist', '5th', '6th', '7th', '8th']);
  });

  it('labels quarter-finalists in an eight draw', () => {
    expect(labels(3)).toEqual([
      'Champion', 'Finalist', 'Semi-finalist', 'Semi-finalist',
      'Quarter-finalist', 'Quarter-finalist', 'Quarter-finalist', 'Quarter-finalist',
    ]);
  });

  it('separates 3rd and 4th when the play-off was played', () => {
    expect(labels(2, true).slice(2, 4)).toEqual(['3rd place', '4th place']);
  });

  it('keeps a sixteen draw\'s top eight as they were', () => {
    expect(labels(4, false, 9)).toEqual([
      'Champion', 'Finalist', 'Semi-finalist', 'Semi-finalist',
      'Quarter-finalist', 'Quarter-finalist', 'Quarter-finalist', 'Quarter-finalist', 'Round of 16',
    ]);
  });

  it('gives a round robin places, not rounds', () => {
    expect(labels(0, false, 4)).toEqual(['Champion', '2nd', '3rd', '4th']);
    expect(finishLabel(11, 0, false)).toBe('11th');
    expect(finishLabel(22, 0, false)).toBe('22nd');
  });

  it('is blank with no position', () => {
    expect(finishLabel(null, 3, false)).toBe('');
  });
});
