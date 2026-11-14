import { describe, it, expect } from 'vitest';
import {
  ATTENDANCE_POLICY_TEXT,
  DEFAULT_CHECKIN_CUTOFF_MINUTES,
  DEFAULT_CONFIRM_DEADLINE_HOURS,
  DEFAULT_CONFIRM_OPENS_HOURS,
  checkinCutoffInstant,
  confirmationWindow,
  eventStartInstant,
} from '../event-standard';

describe('eventStartInstant', () => {
  it('starts at 09:00 club time when the tournament has no start time', () => {
    expect(eventStartInstant('2026-11-21', null).toISOString()).toBe('2026-11-21T16:00:00.000Z');
    expect(eventStartInstant('2026-11-21', undefined).toISOString()).toBe('2026-11-21T16:00:00.000Z');
  });

  it('pins -07:00 from 2026-11-01, as club_local_instant does', () => {
    expect(eventStartInstant('2026-11-01', '10:00:00').toISOString()).toBe('2026-11-01T17:00:00.000Z');
    expect(eventStartInstant('2027-01-15', '18:30').toISOString()).toBe('2027-01-16T01:30:00.000Z');
  });

  it('reads Vancouver daylight time before 2026-11-01', () => {
    expect(eventStartInstant('2026-10-31', '10:00:00').toISOString()).toBe('2026-10-31T17:00:00.000Z');
  });
});

describe('confirmationWindow', () => {
  const start = new Date('2026-11-21T17:00:00.000Z');

  it('opens 48 hours and closes 24 hours before the start by default', () => {
    expect(DEFAULT_CONFIRM_OPENS_HOURS).toBe(48);
    expect(DEFAULT_CONFIRM_DEADLINE_HOURS).toBe(24);
    const { opensAt, deadlineAt } = confirmationWindow(start);
    expect(opensAt.toISOString()).toBe('2026-11-19T17:00:00.000Z');
    expect(deadlineAt.toISOString()).toBe('2026-11-20T17:00:00.000Z');
  });

  it('takes the event\'s own hours', () => {
    const { opensAt, deadlineAt } = confirmationWindow(start, 72, 12);
    expect(opensAt.toISOString()).toBe('2026-11-18T17:00:00.000Z');
    expect(deadlineAt.toISOString()).toBe('2026-11-21T05:00:00.000Z');
  });
});

describe('checkinCutoffInstant', () => {
  it('closes check-in 15 minutes before the start by default', () => {
    expect(DEFAULT_CHECKIN_CUTOFF_MINUTES).toBe(15);
    const start = eventStartInstant('2026-11-21', '10:00');
    expect(checkinCutoffInstant(start).toISOString()).toBe('2026-11-21T16:45:00.000Z');
    expect(checkinCutoffInstant(start, 30).toISOString()).toBe('2026-11-21T16:30:00.000Z');
  });
});

describe('ATTENDANCE_POLICY_TEXT', () => {
  it('states the policy with no em dash', () => {
    expect(ATTENDANCE_POLICY_TEXT).toContain('warning');
    expect(ATTENDANCE_POLICY_TEXT).toContain('restricted from future events');
    expect(ATTENDANCE_POLICY_TEXT).not.toContain('\u2014');
  });
});
