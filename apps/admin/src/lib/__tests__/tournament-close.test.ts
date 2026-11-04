import { describe, expect, it } from 'vitest';
import { closesWithLastEvent, openEventCount } from '../tournament-close';

describe('closesWithLastEvent', () => {
  it('closes an active tournament once its last open event is completed', () => {
    expect(closesWithLastEvent('active', ['completed'])).toBe(true);
    expect(closesWithLastEvent('active', ['completed', 'completed', 'completed'])).toBe(true);
  });

  it('stays open while any event is not completed', () => {
    expect(closesWithLastEvent('active', ['completed', 'live'])).toBe(false);
    expect(closesWithLastEvent('active', ['completed', 'registration'])).toBe(false);
  });

  it('leaves a tournament with no events, or one not active, alone', () => {
    expect(closesWithLastEvent('active', [])).toBe(false);
    expect(closesWithLastEvent('draft', ['completed'])).toBe(false);
    expect(closesWithLastEvent('completed', ['completed'])).toBe(false);
    expect(closesWithLastEvent(null, ['completed'])).toBe(false);
  });
});

describe('openEventCount', () => {
  it('counts every event not completed', () => {
    expect(openEventCount(['completed', 'live', 'checkin', 'registration'])).toBe(3);
    expect(openEventCount([])).toBe(0);
  });
});
