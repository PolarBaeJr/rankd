import { describe, it, expect } from 'vitest';
import {
  ENTRY_SORT_OPTIONS,
  SIGNUP_SORT_OPTIONS,
  ENTRY_SORT_KEY,
  SIGNUP_SORT_KEY,
  parseEntrySort,
  parseSignupSort,
  sortEntries,
  pairSignedUpAt,
  pairDisplayName,
  laterSignup,
} from '../entry-sort';
import type { PairWithPlayers } from '../tournament-types';

type Row = { id: string; at: string | null; seed: number | null; name: string };

const keys = {
  id: (r: Row) => r.id,
  signedUpAt: (r: Row) => r.at,
  seed: (r: Row) => r.seed,
  name: (r: Row) => r.name,
};

const ids = (rows: Row[]) => rows.map((r) => r.id);

const rows: Row[] = [
  { id: 'b', at: '2026-10-02T10:00:00Z', seed: 2, name: 'bea' },
  { id: 'a', at: '2026-10-01T10:00:00Z', seed: null, name: 'Al' },
  { id: 'c', at: null, seed: 1, name: 'Cy' },
  { id: 'd', at: '2026-10-03T10:00:00Z', seed: null, name: 'dee' },
  { id: 'e', at: 'not a date', seed: 3, name: 'Ed' },
];

describe('options and keys', () => {
  it('offers the four entry orders and the three sign-up orders with their labels', () => {
    expect(ENTRY_SORT_OPTIONS.map((o) => o.value)).toEqual(['newest', 'oldest', 'seed', 'name']);
    expect(SIGNUP_SORT_OPTIONS.map((o) => o.value)).toEqual(['newest', 'oldest', 'name']);
    expect(ENTRY_SORT_OPTIONS.map((o) => o.label)).toEqual([
      'Newest sign-up first',
      'Oldest sign-up first',
      'Seed',
      'Name',
    ]);
    expect(ENTRY_SORT_KEY).toBe('participants-sort');
    expect(SIGNUP_SORT_KEY).toBe('club-signups-sort');
  });
});

describe('parseEntrySort / parseSignupSort', () => {
  it('accepts every valid order', () => {
    for (const o of ENTRY_SORT_OPTIONS) expect(parseEntrySort(o.value)).toBe(o.value);
    for (const o of SIGNUP_SORT_OPTIONS) expect(parseSignupSort(o.value)).toBe(o.value);
  });

  it('rejects junk', () => {
    for (const junk of [null, undefined, '', 'NEWEST', 'random', 1, {}, ['newest']]) {
      expect(parseEntrySort(junk)).toBeNull();
      expect(parseSignupSort(junk)).toBeNull();
    }
  });

  it('a sign-up list has no seed order', () => {
    expect(parseSignupSort('seed')).toBeNull();
  });
});

describe('sortEntries', () => {
  it('newest first, with missing and unparseable times last', () => {
    expect(ids(sortEntries(rows, 'newest', keys))).toEqual(['d', 'b', 'a', 'c', 'e']);
  });

  it('oldest first, with missing and unparseable times still last', () => {
    expect(ids(sortEntries(rows, 'oldest', keys))).toEqual(['a', 'b', 'd', 'c', 'e']);
  });

  it('seed ascending, unseeded last, then oldest, then id', () => {
    expect(ids(sortEntries(rows, 'seed', keys))).toEqual(['c', 'b', 'e', 'a', 'd']);
  });

  it('seed order with no seed accessor falls back to time', () => {
    const { seed: _seed, ...noSeed } = keys;
    expect(ids(sortEntries(rows, 'seed', noSeed))).toEqual(['a', 'b', 'd', 'c', 'e']);
  });

  it('name ignoring case', () => {
    expect(ids(sortEntries(rows, 'name', keys))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('identical timestamps are stable by id whatever the input order', () => {
    const same = '2026-10-05T12:00:00Z';
    const tied: Row[] = [
      { id: 'z', at: same, seed: null, name: 'x' },
      { id: 'm', at: same, seed: null, name: 'x' },
      { id: 'a', at: same, seed: null, name: 'x' },
    ];
    for (const order of ['newest', 'oldest', 'seed', 'name'] as const) {
      const forward = ids(sortEntries(tied, order, keys));
      const backward = ids(sortEntries([...tied].reverse(), order, keys));
      expect(forward).toEqual(['a', 'm', 'z']);
      expect(backward).toEqual(forward);
    }
  });

  it('rows without times tie-break by id in both directions', () => {
    const untimed: Row[] = [
      { id: 'q', at: null, seed: null, name: 'x' },
      { id: 'p', at: null, seed: null, name: 'x' },
    ];
    expect(ids(sortEntries(untimed, 'newest', keys))).toEqual(['p', 'q']);
    expect(ids(sortEntries(untimed, 'oldest', keys))).toEqual(['p', 'q']);
  });

  it('compares times as times, not as strings', () => {
    const offsets: Row[] = [
      { id: 'x', at: '2026-10-01T12:00:00-07:00', seed: null, name: 'x' },
      { id: 'y', at: '2026-10-01T15:00:00Z', seed: null, name: 'y' },
    ];
    expect(ids(sortEntries(offsets, 'newest', keys))).toEqual(['x', 'y']);
  });

  it('returns a new array and leaves the input alone', () => {
    const before = ids(rows);
    const result = sortEntries(rows, 'newest', keys);
    expect(result).not.toBe(rows);
    expect(ids(rows)).toEqual(before);
  });
});

function pair(overrides: Partial<PairWithPlayers>): PairWithPlayers {
  return {
    id: 'pair-1',
    created_at: '2026-10-01T00:00:00Z',
    pair_name: null,
    player1: { id: 'p1', full_name: 'Ann' },
    player2: { id: 'p2', full_name: 'Bo' },
    ...overrides,
  } as unknown as PairWithPlayers;
}

describe('pairSignedUpAt', () => {
  it('prefers the club event time', () => {
    expect(pairSignedUpAt(pair({}), { 'pair-1': '2026-10-09T00:00:00Z' })).toBe('2026-10-09T00:00:00Z');
  });

  it('falls back to the row, then to null', () => {
    expect(pairSignedUpAt(pair({}), {})).toBe('2026-10-01T00:00:00Z');
    expect(pairSignedUpAt(pair({}), null)).toBe('2026-10-01T00:00:00Z');
    expect(pairSignedUpAt(pair({ created_at: null }), null)).toBeNull();
  });
});

describe('pairDisplayName', () => {
  it('uses the pair name when there is one', () => {
    expect(pairDisplayName(pair({ pair_name: 'Smash Bros' }))).toBe('Smash Bros');
  });

  it('otherwise both players, as the table shows them', () => {
    expect(pairDisplayName(pair({}))).toBe('Ann / Bo');
  });
});

describe('laterSignup', () => {
  it('takes the later of two times', () => {
    expect(laterSignup('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')).toBe('2026-10-02T00:00:00Z');
    expect(laterSignup('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')).toBe('2026-10-02T00:00:00Z');
  });

  it('compares as times across offsets and returns the original string', () => {
    expect(laterSignup('2026-10-01T12:00:00-07:00', '2026-10-01T15:00:00Z')).toBe('2026-10-01T12:00:00-07:00');
  });

  it('takes the one there is', () => {
    expect(laterSignup('2026-10-01T00:00:00Z', null)).toBe('2026-10-01T00:00:00Z');
    expect(laterSignup(undefined, '2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00Z');
    expect(laterSignup('junk', '2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00Z');
  });

  it('null when neither', () => {
    expect(laterSignup(null, undefined)).toBeNull();
    expect(laterSignup('junk', 'also junk')).toBeNull();
  });
});
