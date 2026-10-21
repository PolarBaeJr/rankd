import { CLUB_WALL_CLOCK_PATTERN, utcToClubWallClock, type ClubEventSignupState } from '@badminton/shared';

// What the members' club event pages read and say, shared by the list and the
// detail page. Explicit columns, never `*`: created_by is not a member's
// business, and the player app never selects it.
export const CLUB_EVENT_COLUMNS =
  'id, title, kind, description, location, starts_at, ends_at, capacity, cost_cents, signup_opens_at, signup_closes_at, status, cancelled_reason';

// What the schedule on /feed needs to place an event on a day and link to it.
// Narrower again: no description, and never created_by.
export const CLUB_EVENT_CALENDAR_COLUMNS = 'id, title, kind, location, starts_at, ends_at, status';

export type ClubEventRow = {
  id: string;
  title: string;
  kind: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  capacity: number | null;
  cost_cents: number | null;
  signup_opens_at: string | null;
  signup_closes_at: string | null;
  status: string;
  cancelled_reason: string | null;
};

export const SIGNUP_STATE_LABEL: Record<ClubEventSignupState, string> = {
  going: 'You are going',
  open: 'Sign-ups open',
  full: 'Full',
  not_open_yet: 'Sign-ups not open yet',
  closed: 'Sign-ups closed',
  started: 'Started',
  cancelled: 'Cancelled',
};

/**
 * An instant as the club's wall clock, in the pieces a date block shows:
 * `{ weekday: 'TUE', month: 'NOV', day: 3, date: 'Tue, Nov 3', time: '7:30 PM' }`.
 * Through the club wall clock, never the server's zone (see
 * clubWallClockToUtc).
 */
export function clubDateParts(iso: string) {
  const m = CLUB_WALL_CLOCK_PATTERN.exec(utcToClubWallClock(iso));
  const at = m
    ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])))
    : new Date(iso);
  const part = (options: Intl.DateTimeFormatOptions) => at.toLocaleString('en-US', { ...options, timeZone: 'UTC' });
  return {
    weekday: part({ weekday: 'short' }).toUpperCase(),
    month: part({ month: 'short' }).toUpperCase(),
    day: Number(part({ day: 'numeric' })),
    date: part({ weekday: 'short', month: 'short', day: 'numeric' }),
    time: part({ hour: 'numeric', minute: '2-digit' }),
  };
}

/** A Google Calendar "add event" link for a club event, from its UTC instants. */
export function googleCalendarLink(event: Pick<ClubEventRow, 'title' | 'starts_at' | 'ends_at' | 'location' | 'description'>) {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ends = event.ends_at ?? new Date(new Date(event.starts_at).getTime() + 2 * 3_600_000).toISOString();
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${stamp(event.starts_at)}/${stamp(ends)}`,
    location: event.location ?? '',
    details: event.description ?? '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
