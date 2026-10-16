import { describe, expect, it } from 'vitest';
import { findPrediction, predictionPercent, sameSide, type MatchupPrediction } from '../prediction-match';

const singles: MatchupPrediction = {
  format: 'singles',
  sideA: ['me'],
  sideB: ['opp'],
  probability: 0.64,
  model: 'elo-v3',
  madeAt: '2026-10-08T18:00:00Z',
};
const doubles: MatchupPrediction = {
  format: 'doubles',
  sideA: ['me', 'partner'],
  sideB: ['opp1', 'opp2'],
  probability: 0.3,
  model: 'elo-v3',
  madeAt: '2026-10-08T18:00:00Z',
};
const list = [singles, doubles];

describe('sameSide', () => {
  it('ignores order and refuses a different size', () => {
    expect(sameSide(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSide(['a'], ['a', 'b'])).toBe(false);
    expect(sameSide(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

describe('findPrediction', () => {
  it('finds a singles matchup as stored', () => {
    expect(findPrediction(list, 'singles', ['me'], ['opp'])).toEqual(singles);
  });

  it('finds doubles with either partner order on either side', () => {
    expect(findPrediction(list, 'doubles', ['partner', 'me'], ['opp2', 'opp1'])?.probability).toBe(0.3);
  });

  it('flips the probability when the sides are asked the other way round', () => {
    const flipped = findPrediction(list, 'doubles', ['opp1', 'opp2'], ['me', 'partner']);
    expect(flipped?.probability).toBeCloseTo(0.7);
    expect(flipped?.sideA).toEqual(['opp1', 'opp2']);
  });

  it('never matches across formats', () => {
    expect(findPrediction(list, 'doubles', ['me'], ['opp'])).toBeNull();
  });

  it('matches nothing while a side is incomplete', () => {
    expect(findPrediction(list, 'singles', ['me'], [''])).toBeNull();
    expect(findPrediction(list, 'doubles', ['me', ''], ['opp1', 'opp2'])).toBeNull();
  });

  it('matches nothing for an unknown opponent', () => {
    expect(findPrediction(list, 'singles', ['me'], ['someone'])).toBeNull();
  });
});

describe('predictionPercent', () => {
  it('rounds to a whole percentage', () => {
    expect(predictionPercent(0.6449)).toBe(64);
    expect(predictionPercent(0.6451)).toBe(65);
    expect(predictionPercent(0)).toBe(0);
  });
});
