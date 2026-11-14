import { describe, it, expect } from 'vitest';
import { capCovers, capReached, scopeLocked, type GroupTimeCap } from '../time-cap';

const cap = (over: Partial<GroupTimeCap>): GroupTimeCap => ({
  id: 'cap', stage: 1, pool_number: null, group_number: null, cap_at: '2026-11-14T20:40:00Z', applied_at: null, ...over,
});
const match = (stage: number, pool: number, group: number) => ({ stage, pool_number: pool, group_number: group });

describe('a time cap', () => {
  it('covers its group, its pool or its whole stage, and never another stage', () => {
    expect(capCovers(cap({ pool_number: 1, group_number: 2 }), match(1, 1, 2))).toBe(true);
    expect(capCovers(cap({ pool_number: 1, group_number: 2 }), match(1, 1, 3))).toBe(false);
    expect(capCovers(cap({ pool_number: 1 }), match(1, 1, 3))).toBe(true);
    expect(capCovers(cap({ pool_number: 1 }), match(1, 2, 1))).toBe(false);
    expect(capCovers(cap({}), match(1, 2, 1))).toBe(true);
    expect(capCovers(cap({}), match(2, 1, 1))).toBe(false);
  });

  it('is reached once applied, or once its time passes before the minute job runs', () => {
    expect(capReached(cap({}), new Date('2026-11-14T20:39:59Z'))).toBe(false);
    expect(capReached(cap({}), new Date('2026-11-14T20:40:00Z'))).toBe(true);
    expect(capReached(cap({ cap_at: '2026-11-14T23:00:00Z', applied_at: '2026-11-14T20:00:00Z' }), new Date('2026-11-14T20:01:00Z'))).toBe(true);
  });

  it('locks only the scope of a reached cap', () => {
    const caps = [cap({ pool_number: 1, group_number: 1 }), cap({ pool_number: 2, cap_at: '2026-11-14T23:00:00Z' })];
    const now = new Date('2026-11-14T21:00:00Z');
    expect(scopeLocked(caps, match(1, 1, 1), now)).toBe(true);
    expect(scopeLocked(caps, match(1, 2, 1), now)).toBe(false);
  });
});
