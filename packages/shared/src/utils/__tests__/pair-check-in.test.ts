import { describe, it, expect } from 'vitest';
import { pairCheckInCounts, pairCheckInPeople, pairMemberHere, type PairCheckInRow } from '../pair-check-in';

type Pair = PairCheckInRow & { names?: [string, string] };

const pair = (over: Partial<Pair> & { id: string }): Pair => ({
  status: 'registered',
  checked_in_at: null,
  player1_id: `${over.id}-p1`,
  player2_id: `${over.id}-p2`,
  player1_checked_in_at: null,
  player2_checked_in_at: null,
  names: ['Ann', 'Bea'],
  ...over,
});

const nameOf = (p: Pair, slot: 1 | 2) => p.names?.[slot - 1];

describe('pairMemberHere', () => {
  it('reads the slot', () => {
    const p = pair({ id: 'a', player1_checked_in_at: '2026-11-02T18:00:00Z' });
    expect(pairMemberHere(p, 1)).toBe(true);
    expect(pairMemberHere(p, 2)).toBe(false);
  });

  it('counts both here on a checked-in team, slots or not', () => {
    expect(pairMemberHere(pair({ id: 'a', status: 'checked_in' }), 2)).toBe(true);
  });

  it('reads an absent column, before 00309, as not set', () => {
    const { player1_checked_in_at: _one, player2_checked_in_at: _two, ...old } = pair({ id: 'a' });
    expect(pairMemberHere(old, 1)).toBe(false);
  });
});

describe('pairCheckInPeople', () => {
  it('gives two people per waiting or checked-in team, partners named', () => {
    const people = pairCheckInPeople([
      pair({ id: 'a', player2_checked_in_at: '2026-11-02T18:05:00Z' }),
      pair({ id: 'b', status: 'withdrawn' }),
      pair({ id: 'c', status: 'no_show' }),
    ], nameOf);
    expect(people.map((p) => [p.pairId, p.slot, p.name, p.partnerName, p.here])).toEqual([
      ['a', 1, 'Ann', 'Bea', false],
      ['a', 2, 'Bea', 'Ann', true],
    ]);
    expect(people[1]!.checkedInAt).toBe('2026-11-02T18:05:00Z');
    expect(people[0]!.playerId).toBe('a-p1');
  });

  it('names an external team from its typed names, with no player ids', () => {
    const people = pairCheckInPeople([
      pair({ id: 'x', player1_id: null, player2_id: null, names: undefined, external1_name: 'Cy', external2_name: 'Di' }),
    ], nameOf);
    expect(people.map((p) => [p.name, p.partnerName, p.playerId])).toEqual([['Cy', 'Di', null], ['Di', 'Cy', null]]);
  });

  it('falls back to the team check-in time on a checked-in team with no slot stamp', () => {
    const [first] = pairCheckInPeople([pair({ id: 'a', status: 'checked_in', checked_in_at: '2026-11-02T17:55:00Z' })], nameOf);
    expect(first!.here).toBe(true);
    expect(first!.checkedInAt).toBe('2026-11-02T17:55:00Z');
  });
});

describe('pairCheckInCounts', () => {
  it('counts people here and teams in', () => {
    const people = pairCheckInPeople([
      pair({ id: 'a', status: 'checked_in' }),
      pair({ id: 'b', player1_checked_in_at: '2026-11-02T18:00:00Z' }),
      pair({ id: 'c' }),
    ], nameOf);
    expect(pairCheckInCounts(people)).toEqual({ peopleHere: 3, people: 6, teamsIn: 1, teams: 3 });
  });

  it('is all zero with nobody', () => {
    expect(pairCheckInCounts([])).toEqual({ peopleHere: 0, people: 0, teamsIn: 0, teams: 0 });
  });
});
