import { describe, it, expect } from 'vitest';
import { clockHHMM, describeTournamentTimes, parseTournamentDetails } from '../tournament-details';

describe('clockHHMM', () => {
  it('reads the HH:MM:SS PostgREST returns for a time column', () => {
    expect(clockHHMM('09:30:00')).toBe('09:30');
    expect(clockHHMM('18:00')).toBe('18:00');
  });

  it('is null for blank or malformed values', () => {
    expect(clockHHMM(null)).toBeNull();
    expect(clockHHMM('')).toBeNull();
    expect(clockHHMM('9:00')).toBeNull();
    expect(clockHHMM('24:00')).toBeNull();
  });
});

describe('parseTournamentDetails', () => {
  it('turns blanks into nulls and trims the location', () => {
    expect(parseTournamentDetails({ starts_time: '', ends_time: ' ', location: '  ' })).toEqual({
      ok: true,
      details: { starts_time: null, ends_time: null, location: null },
    });
    expect(parseTournamentDetails({ starts_time: '09:00:00', location: ' Central Gym ' })).toEqual({
      ok: true,
      details: { starts_time: '09:00', ends_time: null, location: 'Central Gym' },
    });
  });

  it('refuses a malformed time, an end at or before the start, and a long location', () => {
    expect(parseTournamentDetails({ starts_time: '7pm' }).ok).toBe(false);
    expect(parseTournamentDetails({ starts_time: '10:00', ends_time: '10:00' }).ok).toBe(false);
    expect(parseTournamentDetails({ starts_time: '10:00', ends_time: '09:00' }).ok).toBe(false);
    expect(parseTournamentDetails({ location: 'x'.repeat(201) }).ok).toBe(false);
    expect(parseTournamentDetails({ location: 'x'.repeat(200) }).ok).toBe(true);
  });
});

describe('describeTournamentTimes', () => {
  it('says what is set and nothing when neither is', () => {
    expect(describeTournamentTimes('09:00:00', '18:00:00')).toBe('09:00 to 18:00');
    expect(describeTournamentTimes('09:00', null)).toBe('from 09:00');
    expect(describeTournamentTimes(null, '18:00')).toBe('until 18:00');
    expect(describeTournamentTimes(null, null)).toBeNull();
  });
});
