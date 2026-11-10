import { describe, expect, it } from 'vitest';
import { closesWithFinalEvent, openEventCount } from '../tournament-close';

describe('closesWithFinalEvent', () => {
  it('closes an active tournament once its last open event is completed', () => {
    expect(closesWithFinalEvent('active', ['completed'])).toBe(true);
    expect(closesWithFinalEvent('active', ['completed', 'completed', 'completed'])).toBe(true);
  });

  it('stays open while any event is not completed', () => {
    expect(closesWithFinalEvent('active', ['completed', 'live'])).toBe(false);
    expect(closesWithFinalEvent('active', ['completed', 'registration'])).toBe(false);
  });

  it('leaves a tournament with no events, or one not active, alone', () => {
    expect(closesWithFinalEvent('active', [])).toBe(false);
    expect(closesWithFinalEvent('draft', ['completed'])).toBe(false);
    expect(closesWithFinalEvent('completed', ['completed'])).toBe(false);
    expect(closesWithFinalEvent(null, ['completed'])).toBe(false);
  });
});

describe('openEventCount', () => {
  it('counts every event not completed', () => {
    expect(openEventCount(['completed', 'live', 'checkin', 'registration'])).toBe(3);
    expect(openEventCount([])).toBe(0);
  });
});
