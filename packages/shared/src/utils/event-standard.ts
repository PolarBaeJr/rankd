import { wallClockToUtc } from './session-window';

// THE EVENT STANDARD (00324 to 00326): the club's rules for every tournament
// event, as the numbers and the sentence both apps use. The database holds the
// same arithmetic in event_start_instant (00325); these are the copies the
// screens show, so a time on the page is the time the job acts at.

/** Said at sign-up, in the warning notice, and on the confirm page. */
export const ATTENDANCE_POLICY_TEXT =
  'No-shows, or leaving without telling the organizers, get a warning and may be restricted from future events.';

/** The confirmation opens this many hours before the start. */
export const DEFAULT_CONFIRM_OPENS_HOURS = 48;
/** An entry not confirmed this many hours before the start is released. */
export const DEFAULT_CONFIRM_DEADLINE_HOURS = 24;
/** Check-in closes this many minutes before the start. */
export const DEFAULT_CHECKIN_CUTOFF_MINUTES = 15;

/** A tournament with no start time starts at this club-local hour, as in SQL. */
const FALLBACK_START = { hour: 9, minute: 0 };

/**
 * The instant a tournament starts: its start date at its start time, club
 * time, or 09:00 when it has no start time. Through wallClockToUtc, so a date
 * from 2026-11-01 is pinned at -07:00 exactly as club_local_instant is.
 */
export function eventStartInstant(startDate: string, startsTime: string | null | undefined): Date {
  const [year, month, day] = startDate.slice(0, 10).split('-').map(Number) as [number, number, number];
  let { hour, minute } = FALLBACK_START;
  if (startsTime) {
    const [h, m] = startsTime.split(':');
    hour = Number(h);
    minute = Number(m ?? '0');
  }
  return wallClockToUtc(year, month, day, hour, minute);
}

/** When the confirmation opens and when an unconfirmed entry is released. */
export function confirmationWindow(
  start: Date,
  opensHours: number = DEFAULT_CONFIRM_OPENS_HOURS,
  deadlineHours: number = DEFAULT_CONFIRM_DEADLINE_HOURS,
): { opensAt: Date; deadlineAt: Date } {
  return {
    opensAt: new Date(start.getTime() - opensHours * 3_600_000),
    deadlineAt: new Date(start.getTime() - deadlineHours * 3_600_000),
  };
}

/** Check-in closes this long before the start. */
export function checkinCutoffInstant(start: Date, minutes: number = DEFAULT_CHECKIN_CUTOFF_MINUTES): Date {
  return new Date(start.getTime() - minutes * 60_000);
}
