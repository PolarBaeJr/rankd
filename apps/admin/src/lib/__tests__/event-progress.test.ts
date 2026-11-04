import { describe, it, expect } from 'vitest';
import { eventMatchProgress, poolMatchesUndecided } from '../event-progress';

const match = (status: string, over: Record<string, unknown> = {}) => ({
  status, is_bye: false, participant_a_id: 'a', participant_b_id: 'b', pair_a_id: null, pair_b_id: null, ...over,
});

describe('eventMatchProgress', () => {
  it('counts a voided match as decided', () => {
    expect(eventMatchProgress([match('completed'), match('voided'), match('walkover')], false))
      .toEqual({ total: 3, undecided: 0, decided: 3 });
  });

  it('does not wait on an unused bracket slot', () => {
    const empty = match('pending', { participant_a_id: null, participant_b_id: null });
    expect(eventMatchProgress([match('completed'), empty], false)).toEqual({ total: 2, undecided: 0, decided: 2 });
  });

  it('counts a live, ready or disputed match as undecided', () => {
    expect(eventMatchProgress([match('live'), match('ready'), match('disputed'), match('completed')], false))
      .toEqual({ total: 4, undecided: 3, decided: 1 });
  });

  it('counts a bye as decided', () => {
    expect(eventMatchProgress([match('pending', { is_bye: true, participant_b_id: null })], false).undecided).toBe(0);
  });

  it('reads the pair sides on a doubles event', () => {
    const pairMatch = match('pending', { participant_a_id: null, participant_b_id: null, pair_a_id: 'p1', pair_b_id: 'p2' });
    expect(eventMatchProgress([pairMatch], true).undecided).toBe(1);
    expect(eventMatchProgress([pairMatch], false).undecided).toBe(0);
  });
});

describe('poolMatchesUndecided', () => {
  it('matches the knockout draw: voided and byes are played out, empty slots are not waited on', () => {
    expect(poolMatchesUndecided([
      match('completed'),
      match('voided'),
      match('pending', { is_bye: true }),
      match('pending', { participant_a_id: null, participant_b_id: null }),
      match('live'),
    ], false)).toBe(1);
  });
});
