import { describe, it, expect } from 'vitest';
import {
  escapeICSText,
  foldICSLine,
  formatICSDates,
  sessionToVEvent,
  clubEventToVEvent,
  tournamentToVEvent,
  buildICSCalendar,
  type ICSClubEventFields,
  type ICSSessionFields,
} from '../ics';
import { SESSION_DEFAULT_DURATION_MINUTES } from '../constants';

// All expected instants below are UTC equivalents of America/Vancouver
// wall-clock times: PDT = UTC-7 (summer), PST = UTC-8 (winter).

function makeSession(overrides: Partial<ICSSessionFields> = {}): ICSSessionFields {
  return {
    id: 'abc-123',
    name: 'Ladder Night',
    date: '2026-07-15',
    start_time: '18:30:00',
    end_time: '21:00:00',
    location: 'Example Gym',
    notes: null,
    updated_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('escapeICSText', () => {
  it('escapes backslash, semicolon, comma, and newlines', () => {
    expect(escapeICSText('a\\b')).toBe('a\\\\b');
    expect(escapeICSText('a;b')).toBe('a\\;b');
    expect(escapeICSText('a,b')).toBe('a\\,b');
    expect(escapeICSText('a\nb\r\nc')).toBe('a\\nb\\nc');
  });

  it('escapes backslashes before adding new ones', () => {
    expect(escapeICSText('\\;')).toBe('\\\\\\;');
  });
});

describe('foldICSLine', () => {
  it('leaves short lines alone', () => {
    expect(foldICSLine('SUMMARY:Practice')).toBe('SUMMARY:Practice');
  });

  it('folds long lines at 75 octets with CRLF + space continuation', () => {
    const line = 'DESCRIPTION:' + 'x'.repeat(200);
    const folded = foldICSLine(line);
    for (const chunk of folded.split('\r\n')) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(75);
    }
    // Continuation lines start with exactly one space; unfolding restores the original.
    expect(folded.split('\r\n').slice(1).every((c) => c.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('never splits a multi-byte character across the fold', () => {
    const line = 'SUMMARY:' + '羽'.repeat(50); // 3 octets each
    const folded = foldICSLine(line);
    for (const chunk of folded.split('\r\n')) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });
});

describe('sessionToVEvent', () => {
  it('emits UTC stamps for a summer (PDT, UTC-7) timed session', () => {
    const lines = sessionToVEvent(makeSession());
    expect(lines).toContain('DTSTART:20260716T013000Z'); // 18:30 PDT
    expect(lines).toContain('DTEND:20260716T040000Z'); // 21:00 PDT
  });

  it('emits UTC stamps for a winter (PST, UTC-8) timed session', () => {
    const lines = sessionToVEvent(makeSession({ date: '2026-01-15' }));
    expect(lines).toContain('DTSTART:20260116T023000Z'); // 18:30 PST
    expect(lines).toContain('DTEND:20260116T050000Z'); // 21:00 PST
  });

  it('defaults a missing end_time to start + the configured default duration', () => {
    const lines = sessionToVEvent(makeSession({ end_time: null }));
    expect(lines).toContain('DTSTART:20260716T013000Z'); // 18:30 PDT
    // Derived, not hardcoded: default_duration_minutes is admin-editable in
    // platform_settings, so a literal DTEND here rots when prod is retuned.
    const start = Date.parse('2026-07-16T01:30:00.000Z');
    const end = new Date(start + SESSION_DEFAULT_DURATION_MINUTES * 60_000);
    const stamp = end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(lines).toContain(`DTEND:${stamp}`);
  });

  it('emits an all-day event with exclusive next-day DTEND when untimed', () => {
    const lines = sessionToVEvent(makeSession({ start_time: null, end_time: null }));
    expect(lines).toContain('DTSTART;VALUE=DATE:20260715');
    expect(lines).toContain('DTEND;VALUE=DATE:20260716');
  });

  it('rolls the all-day DTEND across month boundaries', () => {
    const { end, allDay } = formatICSDates({ date: '2026-07-31', start_time: null, end_time: null });
    expect(allDay).toBe(true);
    expect(end).toBe('20260801');
  });

  it('has a stable UID and an updated_at-derived SEQUENCE', () => {
    const session = makeSession();
    const lines = sessionToVEvent(session);
    expect(lines).toContain('UID:abc-123@club-ladder');
    const seq = Math.floor(Date.parse(session.updated_at) / 1000);
    expect(lines).toContain(`SEQUENCE:${seq}`);
    // Same input -> identical output (feed refreshes must not churn events).
    expect(sessionToVEvent(session)).toEqual(lines);
  });

  it('falls back to "Practice Session" and escapes text fields', () => {
    const lines = sessionToVEvent(
      makeSession({ name: null, location: 'Gym; Court 1', notes: 'Bring shuttles,\nplease' })
    );
    expect(lines).toContain('SUMMARY:Practice Session');
    expect(lines).toContain('LOCATION:Gym\\; Court 1');
    expect(lines).toContain('DESCRIPTION:Bring shuttles\\,\\nplease');
  });

  it('emits a URL line pointing at the session when a baseUrl is given', () => {
    const lines = sessionToVEvent(makeSession(), 'https://x.test');
    expect(lines).toContain('URL:https://x.test/feed?s=abc-123');
  });

  it('omits the URL line when no baseUrl is given', () => {
    const lines = sessionToVEvent(makeSession());
    expect(lines.some((l) => l.startsWith('URL:'))).toBe(false);
  });
});

describe('buildICSCalendar', () => {
  it('wraps events in a VCALENDAR with CRLF endings and feed metadata', () => {
    const ics = buildICSCalendar([makeSession()]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:Club Ladder\r\n');
    expect(ics).toContain('X-WR-TIMEZONE:America/Vancouver\r\n');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n');
    expect(ics).toContain('BEGIN:VEVENT\r\n');
    // No bare LF anywhere.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('threads a baseUrl through to each event when provided', () => {
    const ics = buildICSCalendar([makeSession()], { baseUrl: 'https://x.test' });
    expect(ics).toContain('URL:https://x.test/feed?s=abc-123\r\n');
  });
});

function makeClubEvent(overrides: Partial<ICSClubEventFields> = {}): ICSClubEventFields {
  return {
    id: 'ev-1',
    title: 'Club Social',
    kind: 'social',
    description: null,
    location: 'Student Union',
    starts_at: '2026-10-15T02:30:00Z',
    ends_at: '2026-10-15T05:00:00Z',
    status: 'published',
    cancelled_reason: null,
    updated_at: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('clubEventToVEvent', () => {
  it('uses its own UID namespace, distinct from a session with the same id', () => {
    const lines = clubEventToVEvent(makeClubEvent({ id: 'abc-123' }));
    expect(lines).toContain('UID:club-event-abc-123@club-ladder');
    expect(sessionToVEvent(makeSession({ id: 'abc-123' }))).toContain('UID:abc-123@club-ladder');
  });

  it('stamps DTSTART and DTEND straight from the stored instants', () => {
    const lines = clubEventToVEvent(makeClubEvent());
    expect(lines).toContain('DTSTART:20261015T023000Z');
    expect(lines).toContain('DTEND:20261015T050000Z');
  });

  it('ends a default duration after the start when there is no end time', () => {
    const lines = clubEventToVEvent(makeClubEvent({ ends_at: null }));
    expect(lines).toContain('DTEND:20261015T043000Z');
  });

  it('marks a published event CONFIRMED with a plain summary', () => {
    const lines = clubEventToVEvent(makeClubEvent());
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines).toContain('SUMMARY:Club Social');
    expect(lines.some((l) => l.includes('Cancelled'))).toBe(false);
  });

  it('marks a cancelled event CANCELLED, says so in the summary and gives the reason', () => {
    const lines = clubEventToVEvent(makeClubEvent({ status: 'cancelled', cancelled_reason: 'Hall closed' }));
    expect(lines).toContain('STATUS:CANCELLED');
    expect(lines).toContain('SUMMARY:Cancelled: Club Social');
    expect(lines).toContain('DESCRIPTION:Social\\nCancelled: Hall closed');
  });

  it('omits LOCATION when there is none', () => {
    const lines = clubEventToVEvent(makeClubEvent({ location: null }));
    expect(lines.some((l) => l.startsWith('LOCATION:'))).toBe(false);
  });

  it('links to the event page when a baseUrl is given', () => {
    expect(clubEventToVEvent(makeClubEvent(), 'https://x.test')).toContain('URL:https://x.test/events/ev-1');
    expect(clubEventToVEvent(makeClubEvent()).some((l) => l.startsWith('URL:'))).toBe(false);
  });

  it('escapes commas and semicolons in the title', () => {
    const lines = clubEventToVEvent(makeClubEvent({ title: 'Food, drinks; games' }));
    expect(lines).toContain('SUMMARY:Food\\, drinks\\; games');
  });
});

describe('buildICSCalendar with club events', () => {
  it('includes club events passed alongside the sessions', () => {
    const ics = buildICSCalendar([], { clubEvents: [makeClubEvent()] });
    expect(ics).toContain('UID:club-event-ev-1@club-ladder\r\n');
    expect(ics).toContain('SUMMARY:Club Social\r\n');
  });

  it('is unchanged for a sessions-only caller', () => {
    const session = makeSession();
    expect(buildICSCalendar([session], { clubEvents: [] })).toBe(buildICSCalendar([session]));
    expect(buildICSCalendar([session])).not.toContain('club-event-');
  });
});

describe('tournamentToVEvent', () => {
  const makeTournament = (over: Partial<Parameters<typeof tournamentToVEvent>[0]> = {}) => ({
    id: 't-1',
    name: 'Fall Open',
    start_date: '2026-11-14',
    end_date: '2026-11-14' as string | null,
    status: 'active',
    updated_at: '2026-10-01T12:00:00.000Z',
    ...over,
  });

  it('is an all-day event ending the next day for a one-day tournament', () => {
    const lines = tournamentToVEvent(makeTournament());
    expect(lines).toContain('DTSTART;VALUE=DATE:20261114');
    expect(lines).toContain('DTEND;VALUE=DATE:20261115');
  });

  it('ends the day after the last day of a multi-day tournament (exclusive end)', () => {
    const lines = tournamentToVEvent(makeTournament({ start_date: '2026-11-28', end_date: '2026-12-01' }));
    expect(lines).toContain('DTSTART;VALUE=DATE:20261128');
    expect(lines).toContain('DTEND;VALUE=DATE:20261202');
  });

  it('reads a missing end date, or one before the start, as one day', () => {
    expect(tournamentToVEvent(makeTournament({ end_date: null }))).toContain('DTEND;VALUE=DATE:20261115');
    expect(tournamentToVEvent(makeTournament({ end_date: '2026-11-01' }))).toContain('DTEND;VALUE=DATE:20261115');
  });

  it('crosses a year boundary', () => {
    expect(tournamentToVEvent(makeTournament({ start_date: '2026-12-31', end_date: null }))).toContain(
      'DTEND;VALUE=DATE:20270101',
    );
  });

  it('has its own UID namespace and no location', () => {
    const lines = tournamentToVEvent(makeTournament());
    expect(lines).toContain('UID:tournament-t-1@club-ladder');
    expect(lines.some((l) => l.startsWith('LOCATION'))).toBe(false);
  });

  it('escapes the name and links the tournament page', () => {
    const lines = tournamentToVEvent(makeTournament({ name: 'Doubles, mixed; open' }), 'https://x.test');
    expect(lines).toContain('SUMMARY:Doubles\\, mixed\\; open');
    expect(lines).toContain('URL:https://x.test/tournaments/t-1');
  });

  it('is included by buildICSCalendar', () => {
    const ics = buildICSCalendar([], { tournaments: [makeTournament()] });
    expect(ics).toContain('UID:tournament-t-1@club-ladder');
  });
});
