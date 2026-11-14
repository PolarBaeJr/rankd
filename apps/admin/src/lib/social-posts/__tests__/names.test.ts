import { describe, it, expect } from 'vitest';
import { HIDDEN_MEMBER, publicPairName, publicPersonName } from '../names';

describe('public names (owner, 2026-11-14)', () => {
  it('a member appears by full name', () => {
    expect(publicPersonName({ full_name: 'Avery Placeholder' })).toBe('Avery Placeholder');
  });

  it('hidden, deleting or guest is "A member"', () => {
    expect(publicPersonName({ full_name: 'Avery Placeholder', hide_from_leaderboard: true })).toBe(HIDDEN_MEMBER);
    expect(publicPersonName({ full_name: 'Avery Placeholder', deletion_requested_at: '2026-11-01T00:00:00Z' })).toBe(HIDDEN_MEMBER);
    expect(publicPersonName({ full_name: 'Avery Placeholder', is_guest: true })).toBe(HIDDEN_MEMBER);
    expect(publicPersonName(null)).toBe(HIDDEN_MEMBER);
  });

  it('an external name is shown as entered, and a pair joins both', () => {
    expect(publicPairName({ player1_id: 'p1', player1: { full_name: 'Avery Placeholder' }, player2_id: null, external2_name: 'Blake Visitor' }))
      .toBe('Avery Placeholder & Blake Visitor');
    expect(publicPairName({ player1_id: 'p1', player1: [{ full_name: 'Avery Placeholder', is_guest: true }], player2_id: 'p2', player2: { full_name: 'Casey Placeholder' } }))
      .toBe('A member & Casey Placeholder');
  });
});
