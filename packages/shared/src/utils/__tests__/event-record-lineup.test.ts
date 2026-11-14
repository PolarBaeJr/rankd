import { describe, it, expect } from 'vitest';
import { parseLineup, viewerEventRecord, viewerSideOf, type EventRecordMatch } from '../event-record';

// After a substitution (00327) the entry is the incoming member's, and the
// decided matches carry a lineup naming who played them. The member's own
// record follows the lineup, not the entry.

const ENTRY = 'entry-1';
const OUT = 'player-out';
const IN = 'player-in';
const PARTNER = 'player-partner';

type M = EventRecordMatch & { lineup?: unknown };
function m(over: Partial<M> & { id: string }): M {
  return {
    status: 'completed',
    is_bye: false,
    scores: [{ a: 21, b: 10 }],
    round_number: 1,
    bracket_position: 0,
    phase: null,
    round_name: null,
    aId: ENTRY,
    bId: 'other',
    winnerId: ENTRY,
    ...over,
  };
}

// The outgoing member won round 1 and lost round 2, then the sub; the incoming
// member won round 3. Round 4 is still to play.
const matches: M[] = [
  m({ id: 'r1', lineup: { a: [OUT, PARTNER] } }),
  m({ id: 'r2', round_number: 2, winnerId: 'other', scores: [{ a: 15, b: 21 }], lineup: { a: [OUT, PARTNER] } }),
  m({ id: 'r3', round_number: 3, scores: [{ a: 21, b: 19 }] }),
  m({ id: 'r4', round_number: 4, status: 'pending', winnerId: null, scores: null }),
];

describe('viewerSideOf', () => {
  it('gives a match to who the lineup names, even with no entry now', () => {
    expect(viewerSideOf(matches[0]!, { playerId: OUT, entryId: null })).toBe('a');
    expect(viewerSideOf(matches[2]!, { playerId: OUT, entryId: null })).toBeNull();
    expect(viewerSideOf(matches[3]!, { playerId: OUT, entryId: null })).toBeNull();
  });

  it('keeps a match whose lineup does not name the member off their record, though the entry is theirs', () => {
    expect(viewerSideOf(matches[0]!, { playerId: IN, entryId: ENTRY })).toBeNull();
    expect(viewerSideOf(matches[2]!, { playerId: IN, entryId: ENTRY })).toBe('a');
    expect(viewerSideOf(matches[3]!, { playerId: IN, entryId: ENTRY })).toBe('a');
  });

  it('keeps every match for the partner who stayed', () => {
    for (const match of matches) expect(viewerSideOf(match, { playerId: PARTNER, entryId: ENTRY })).toBe('a');
  });

  it('reads a side with no lineup key by its entry, when only the opponent was subbed', () => {
    const opponentSubbed = m({ id: 'x', aId: 'theirs', bId: ENTRY, winnerId: ENTRY, lineup: { a: ['gone'] } });
    expect(viewerSideOf(opponentSubbed, { playerId: IN, entryId: ENTRY })).toBe('b');
  });
});

describe('viewerEventRecord', () => {
  it('counts only what the outgoing member played', () => {
    const r = viewerEventRecord(matches, { playerId: OUT, entryId: null });
    expect(r).toMatchObject({ played: 2, won: 1, lost: 1, pointsFor: 36, pointsAgainst: 31 });
    expect(r.last?.matchId).toBe('r2');
  });

  it('counts only what the incoming member played', () => {
    const r = viewerEventRecord(matches, { playerId: IN, entryId: ENTRY });
    expect(r).toMatchObject({ played: 1, won: 1, lost: 0, pointsFor: 21, pointsAgainst: 19 });
    expect(r.last?.matchId).toBe('r3');
  });

  it('is the entry record when nobody was subbed', () => {
    const plain = matches.map((x) => ({ ...x, lineup: null }));
    expect(viewerEventRecord(plain, { playerId: IN, entryId: ENTRY })).toMatchObject({ played: 3, won: 2, lost: 1 });
  });
});

describe('parseLineup', () => {
  it('reads the two sides and drops anything else', () => {
    expect(parseLineup({ a: ['x', 3], c: ['y'] })).toEqual({ a: ['x'] });
    expect(parseLineup(null)).toBeNull();
    expect(parseLineup([])).toBeNull();
    expect(parseLineup({})).toBeNull();
  });
});
