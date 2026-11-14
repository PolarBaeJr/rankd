import { describe, expect, it } from 'vitest';
import { confirmationCounts, entryConfirmationState } from '../confirmation-badges';
import type { ConfirmationRow } from '../tournament-types';

const row = (player: string, entry: string, status: ConfirmationRow['status'], pair = false): ConfirmationRow => ({
  player_id: player,
  participant_id: pair ? null : entry,
  pair_id: pair ? entry : null,
  status,
});

describe('entryConfirmationState', () => {
  it('keeps a pair when either partner confirmed', () => {
    const rows = [row('a', 'pair-1', 'pending', true), row('b', 'pair-1', 'confirmed', true)];
    expect(entryConfirmationState(rows, 'pair-1', true)).toBe('confirmed');
  });

  it('says released, not reached, or waiting, and nothing for an entry never asked', () => {
    expect(entryConfirmationState([row('a', 'p1', 'released')], 'p1', false)).toBe('released');
    expect(entryConfirmationState([row('a', 'p1', 'unreached')], 'p1', false)).toBe('unreached');
    expect(entryConfirmationState([row('a', 'p1', 'pending')], 'p1', false)).toBe('waiting');
    expect(entryConfirmationState([row('a', 'p1', 'void')], 'p1', false)).toBeNull();
    expect(entryConfirmationState([], 'p1', false)).toBeNull();
  });
});

describe('confirmationCounts', () => {
  it('counts each asked entry once', () => {
    const rows = [row('a', 'p1', 'confirmed'), row('b', 'p2', 'pending'), row('c', 'p3', 'unreached')];
    expect(confirmationCounts(rows, ['p1', 'p2', 'p3', 'p4'], false)).toEqual({ confirmed: 1, waiting: 1, released: 0, unreached: 1, asked: 3 });
  });
});
