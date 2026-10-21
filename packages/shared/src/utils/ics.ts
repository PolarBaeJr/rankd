// Pure ICS (RFC 5545) generation for the per-player calendar feed and the
// per-session "Add to Calendar" download. No I/O here — callers fetch the
// sessions and serve/download the output. Session wall-clock times are
// club-local (CLUB_TIMEZONE); timed events are emitted as UTC instants so
// every calendar client renders them correctly regardless of device timezone.
import { CLUB_TIMEZONE } from './constants';
import {
  wallClockToUtc,
  FALLBACK_CHECKIN_SETTINGS,
  type CheckinSettings,
} from './session-window';
import {
  CLUB_EVENT_DEFAULT_DURATION_MINUTES,
  CLUB_EVENT_KIND_LABELS,
  type ClubEventKind,
} from './club-events';

export interface ICSSessionFields {
  id: string;
  name: string | null;
  date: string; // YYYY-MM-DD
  start_time: string | null; // HH:MM[:SS]
  end_time: string | null; // HH:MM[:SS]
  location: string;
  notes: string | null;
  updated_at: string;
}

export interface ICSClubEventFields {
  id: string;
  title: string;
  kind: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string;
  cancelled_reason: string | null;
  updated_at: string;
}

export interface ICSTournamentFields {
  id: string;
  name: string;
  start_date: string; // YYYY-MM-DD
  end_date: string | null; // YYYY-MM-DD
  status: string;
  updated_at: string;
}

// Escape TEXT property values (RFC 5545 §3.3.11). Backslash first so the
// escapes added for the other characters aren't themselves escaped.
export function escapeICSText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Fold a content line to 75 octets max (RFC 5545 §3.1): continuation lines
// are CRLF + a single space, and that space counts toward the 75. Folding is
// measured in UTF-8 octets, not characters, and never splits a code point.
export function foldICSLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const chunks: string[] = [];
  let current = '';
  let currentOctets = 0;
  for (const ch of line) {
    const chOctets = encoder.encode(ch).length;
    if (currentOctets + chOctets > 75) {
      chunks.push(current);
      current = ' ';
      currentOctets = 1;
    }
    current += ch;
    currentOctets += chOctets;
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

// "2026-07-16T01:30:00.000Z" -> "20260716T013000Z"
function formatUtcStamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function parseTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':');
  return { hour: Number(h), minute: Number(m ?? '0') };
}

// DTSTART/DTEND values for a session. Timed sessions get UTC ...Z stamps
// (end = end_time, else start + default duration); untimed sessions are
// all-day (VALUE=DATE), whose DTEND is exclusive per RFC 5545 — the next day.
export function formatICSDates(
  session: Pick<ICSSessionFields, 'date' | 'start_time' | 'end_time'>,
  settings: CheckinSettings = FALLBACK_CHECKIN_SETTINGS
): {
  start: string;
  end: string;
  allDay: boolean;
} {
  const [y, mo, d] = session.date.split('-').map(Number) as [number, number, number];

  if (session.start_time) {
    const start = parseTime(session.start_time);
    const startAt = wallClockToUtc(y, mo, d, start.hour, start.minute);
    let endAt: Date;
    if (session.end_time) {
      const end = parseTime(session.end_time);
      endAt = wallClockToUtc(y, mo, d, end.hour, end.minute);
    } else {
      endAt = new Date(startAt.getTime() + settings.defaultDurationMinutes * 60_000);
    }
    return { start: formatUtcStamp(startAt), end: formatUtcStamp(endAt), allDay: false };
  }

  // Date.UTC normalizes day overflow, so d + 1 rolls month/year correctly.
  const nextDay = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return {
    start: session.date.replace(/-/g, ''),
    end: nextDay.replace(/-/g, ''),
    allDay: true,
  };
}

// One session -> unfolded VEVENT content lines. Callers fold and join
// (buildICSCalendar does both). UID is stable per session so calendar clients
// update events in place; SEQUENCE bumps whenever the row is touched.
export function sessionToVEvent(
  session: ICSSessionFields,
  baseUrl?: string,
  settings: CheckinSettings = FALLBACK_CHECKIN_SETTINGS
): string[] {
  const { start, end, allDay } = formatICSDates(session, settings);
  const updated = new Date(session.updated_at);
  const stamp = formatUtcStamp(updated);

  const lines = [
    'BEGIN:VEVENT',
    `UID:${session.id}@club-ladder`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SEQUENCE:${Math.floor(updated.getTime() / 1000)}`,
    allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`,
    allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`,
    `SUMMARY:${escapeICSText(session.name ?? 'Practice Session')}`,
    `LOCATION:${escapeICSText(session.location)}`,
  ];
  if (session.notes) lines.push(`DESCRIPTION:${escapeICSText(session.notes)}`);
  // URL is a URI value, not TEXT, so it is not run through escapeICSText —
  // both baseUrl (env var) and session.id (uuid) are already URI-safe.
  if (baseUrl) lines.push(`URL:${baseUrl}/feed?s=${session.id}`);
  lines.push('END:VEVENT');
  return lines;
}

// One club event -> unfolded VEVENT content lines. Club events are stored as
// instants, so DTSTART/DTEND are stamped straight from them with no wall-clock
// conversion. The UID has its own `club-event-` namespace so it can never
// collide with a session's, and it never changes for the life of the event.
//
// A cancelled event stays in the feed with STATUS:CANCELLED so calendar apps
// strike it through, and its SUMMARY says so too, because some subscription
// clients ignore STATUS. A live one says CONFIRMED explicitly, so reinstating
// an event propagates.
export function clubEventToVEvent(ev: ICSClubEventFields, baseUrl?: string): string[] {
  const updated = new Date(ev.updated_at);
  const stamp = formatUtcStamp(updated);
  const startAt = new Date(ev.starts_at);
  const endAt = ev.ends_at
    ? new Date(ev.ends_at)
    : new Date(startAt.getTime() + CLUB_EVENT_DEFAULT_DURATION_MINUTES * 60_000);
  const cancelled = ev.status === 'cancelled';

  const lines = [
    'BEGIN:VEVENT',
    `UID:club-event-${ev.id}@club-ladder`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SEQUENCE:${Math.floor(updated.getTime() / 1000)}`,
    `DTSTART:${formatUtcStamp(startAt)}`,
    `DTEND:${formatUtcStamp(endAt)}`,
    `SUMMARY:${escapeICSText(cancelled ? `Cancelled: ${ev.title}` : ev.title)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
  ];
  if (ev.location) lines.push(`LOCATION:${escapeICSText(ev.location)}`);
  const description = [
    CLUB_EVENT_KIND_LABELS[ev.kind as ClubEventKind] ?? null,
    ev.description,
    cancelled && ev.cancelled_reason ? `Cancelled: ${ev.cancelled_reason}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  if (description) lines.push(`DESCRIPTION:${escapeICSText(description)}`);
  if (baseUrl) lines.push(`URL:${baseUrl}/events/${ev.id}`);
  lines.push('END:VEVENT');
  return lines;
}

// YYYY-MM-DD plus n days, as the YYYYMMDD a VALUE=DATE property takes. UTC
// date maths on the date alone, so no timezone can move the day.
function icsDatePlusDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10).replace(/-/g, '');
}

// One tournament -> unfolded VEVENT content lines. A tournament is ALL DAY on
// every day it runs: DTSTART is its start date and DTEND the day after its end
// date, because an all-day DTEND is exclusive (RFC 5545). A missing end, or an
// end before the start, is read as a one-day event. The UID has its own
// `tournament-` namespace beside `club-event-`, and no LOCATION: a tournament
// row names no venue.
export function tournamentToVEvent(t: ICSTournamentFields, baseUrl?: string): string[] {
  const updated = new Date(t.updated_at);
  const stamp = formatUtcStamp(updated);
  const last = t.end_date && t.end_date > t.start_date ? t.end_date : t.start_date;
  const lines = [
    'BEGIN:VEVENT',
    `UID:tournament-${t.id}@club-ladder`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SEQUENCE:${Math.floor(updated.getTime() / 1000)}`,
    `DTSTART;VALUE=DATE:${icsDatePlusDays(t.start_date, 0)}`,
    `DTEND;VALUE=DATE:${icsDatePlusDays(last, 1)}`,
    `SUMMARY:${escapeICSText(t.name)}`,
  ];
  if (baseUrl) lines.push(`URL:${baseUrl}/tournaments/${t.id}`);
  lines.push('END:VEVENT');
  return lines;
}

// Full VCALENDAR document, CRLF line endings, lines folded to 75 octets.
export function buildICSCalendar(
  sessions: ICSSessionFields[],
  opts?: {
    baseUrl?: string;
    settings?: CheckinSettings;
    clubEvents?: ICSClubEventFields[];
    tournaments?: ICSTournamentFields[];
  }
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Club Ladder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Club Ladder',
    `X-WR-TIMEZONE:${CLUB_TIMEZONE}`,
    // Both spellings of "refresh hourly": REFRESH-INTERVAL is RFC 7986,
    // X-PUBLISHED-TTL is the legacy Apple/Outlook equivalent.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...sessions.flatMap((s) => sessionToVEvent(s, opts?.baseUrl, opts?.settings)),
    ...(opts?.clubEvents ?? []).flatMap((e) => clubEventToVEvent(e, opts?.baseUrl)),
    ...(opts?.tournaments ?? []).flatMap((t) => tournamentToVEvent(t, opts?.baseUrl)),
    'END:VCALENDAR',
  ];
  return lines.map(foldICSLine).join('\r\n') + '\r\n';
}
