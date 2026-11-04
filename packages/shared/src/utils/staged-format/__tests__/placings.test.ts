import { describe, expect, it } from 'vitest';
import { finalPlacings, formatConfigSchema, type FormatConfig, type FormatResults, type StageMatchResult } from '..';

const cfg: FormatConfig = formatConfigSchema.parse({
  version: 1,
  stages: [{
    key: 'groups',
    name: 'Group stage',
    rated: false,
    kind: 'groups',
    groupSize: 'auto',
    assignment: 'snake',
    scoring: { bestOf: 1, target: 21, winByTwo: true, cap: 30, handicap: false, forfeit: null },
    entrants: { from: 'field', order: 'elo' },
    pools: 1,
    groupsPerPool: 1,
  }],
});

const match = (a: string, b: string, winner: string | null, status = 'completed'): StageMatchResult => ({
  stage: 'groups', pool: 1, group: 1, round: 1, label: null, thirdPlace: false, a, b, status, winner,
  games: winner ? [winner === a ? { a: 21, b: 10 } : { a: 10, b: 21 }] : null,
});

describe('finalPlacings: who gets a place', () => {
  const results: FormatResults = {
    field: [
      { id: 'a', seed: 1 }, { id: 'b', seed: 2 }, { id: 'showed', seed: 3 },
      { id: 'never', seed: 4 }, { id: 'gone', seed: 5 },
    ],
    groups: [{ stage: 'groups', pool: 1, group: 1, members: ['a', 'b', 'showed'] }],
    matches: [match('a', 'b', 'a'), match('a', 'showed', null, 'voided'), match('b', 'showed', null, 'voided')],
    out: ['gone'],
  };
  const places = finalPlacings(cfg, results);

  it('gives no place to an entry that was never drawn, so it earns no ladder points', () => {
    expect(places.has('never')).toBe(false);
  });

  it('still places a no-show who was drawn, even with only voided matches', () => {
    expect(places.get('a')).toBe(1);
    expect(places.has('showed')).toBe(true);
    expect(places.has('b')).toBe(true);
  });

  it('places nobody who left the event, and numbers the rest 1..N', () => {
    expect(places.has('gone')).toBe(false);
    expect([...places.values()].sort()).toEqual([1, 2, 3]);
  });
});
