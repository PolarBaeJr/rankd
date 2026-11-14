import { describe, it, expect } from 'vitest';
import { matchResultLabel, retirementScoresRefusal, tallyStage, tallyRoundRobin, type StageMatchResult } from '../..';

// 00329: a match decided off court has a winner and no scores; one decided by
// retirement keeps the games as far as they got. Both are status completed.

describe('matchResultLabel', () => {
  it('reads a match played as its scores', () => {
    expect(matchResultLabel({ scores: [{ a: 21, b: 15 }, { a: 5, b: 3 }] })).toBe('21-15, 5-3');
    expect(matchResultLabel({ scores: null, result_kind: null })).toBe('');
  });

  it('reads off court and a retirement as what they were, with no em dash', () => {
    expect(matchResultLabel({ scores: [], result_kind: 'off_court' })).toBe('Decided off court');
    expect(matchResultLabel({ scores: [{ a: 21, b: 15 }, { a: 5, b: 3 }], result_kind: 'retired', retired_side: 'b' }))
      .toBe('21-15, 5-3 (B retired)');
    expect(matchResultLabel({ scores: [], result_kind: 'retired', retired_side: 'a' })).toBe('Retired (A retired)');
    for (const kind of ['off_court', 'retired']) {
      expect(matchResultLabel({ scores: [{ a: 1, b: 0 }], result_kind: kind, retired_side: 'a' })).not.toContain('\u2014');
    }
  });
});

describe('retirementScoresRefusal', () => {
  it('takes none to seven games, whoever is ahead, the last one unfinished', () => {
    expect(retirementScoresRefusal([])).toBeNull();
    expect(retirementScoresRefusal([{ a: 21, b: 3 }, { a: 4, b: 2 }])).toBeNull();
    expect(retirementScoresRefusal(Array.from({ length: 7 }, () => ({ a: 0, b: 0 })))).toBeNull();
  });

  it('refuses anything else', () => {
    expect(retirementScoresRefusal(Array.from({ length: 8 }, () => ({ a: 0, b: 0 })))).toMatch(/at most 7/);
    expect(retirementScoresRefusal('21-15')).toMatch(/at most 7/);
    for (const bad of [{ a: -1, b: 0 }, { a: 100, b: 0 }, { a: 1.5, b: 0 }, { a: '3', b: 0 }, null]) {
      expect(retirementScoresRefusal([bad])).toBe('Each game score is a whole number from 0 to 99.');
    }
  });
});

describe('a decided result in the table', () => {
  const result = (games: Array<{ a: number; b: number }> | null): StageMatchResult => ({
    stage: 's1', pool: 1, group: 1, round: 1, label: null, a: 'x', b: 'y', status: 'completed', winner: 'y', games,
  });
  const forfeit = () => ({ winner: 21, loser: 0 });

  it('off court: a win and a loss, and no points', () => {
    const rows = tallyStage(['x', 'y'], [result([])], forfeit);
    expect(rows.get('y')).toMatchObject({ played: 1, wins: 1, pointsFor: 0, pointsAgainst: 0, gamesFor: 0 });
    expect(rows.get('x')).toMatchObject({ played: 1, losses: 1, pointsFor: 0 });
  });

  it('retired: the partial games count, the retiree takes the loss even when ahead', () => {
    const rows = tallyStage(['x', 'y'], [result([{ a: 21, b: 10 }, { a: 4, b: 6 }])], forfeit);
    expect(rows.get('y')).toMatchObject({ wins: 1, pointsFor: 16, pointsAgainst: 25, gamesFor: 1, gamesAgainst: 1 });
    expect(rows.get('x')).toMatchObject({ losses: 1, pointsFor: 25 });
  });

  it('the legacy round robin counts an off-court win with empty scores', () => {
    const rows = tallyRoundRobin(
      [{ id: 'x', name: 'Side X', group: null, out: false }, { id: 'y', name: 'Side Y', group: null, out: false }],
      [{ status: 'completed', sideA: 'x', sideB: 'y', winner: 'y', scores: [] }],
    );
    const y = rows.find((r) => r.id === 'y')!;
    expect(y).toMatchObject({ wins: 1, losses: 0 });
  });
});
