// The month grid's data, shared by /feed and /calendar so the two can never
// disagree about what is on a day. Pure, like ./calendar-items: the page hands
// in its rows, its one pinned club date and the switches it read.

import {
  clubEventCalendarItem,
  compareCalendarItems,
  sessionCalendarItem,
  tournamentCalendarItems,
  type CalendarClubEventRow,
  type CalendarItem,
  type CalendarSessionRow,
  type CalendarTone,
  type CalendarTournamentRow,
} from './calendar-items';
import { buildCalendarMonth, calendarMonthKeys, initialMonthIndex, type CalendarMonth } from './schedule';

export type CalendarSessionWithSeason = CalendarSessionRow & { season_id: string | null };

export interface CalendarPageInput {
  sessions: readonly CalendarSessionWithSeason[];
  clubEvents: readonly CalendarClubEventRow[];
  tournaments: readonly CalendarTournamentRow[];
  activeSeason: { id: string; start_date: string | null; end_date: string | null } | null;
  todayISO: string;
  /** Going, checked in or attended. */
  isMineSession: (id: string) => boolean;
  /** Club events this member has signed up for. */
  signedUpEvents: ReadonlySet<string>;
  /** Where a session on the grid links to, or null for plain text. */
  sessionHref: (id: string) => string | null;
  sessionsOn: boolean;
  eventsOn: boolean;
  tournamentsOn: boolean;
}

export interface CalendarPageData {
  calendarItems: CalendarItem[];
  monthKeys: string[];
  months: CalendarMonth<CalendarItem>[];
  initialIndex: number;
  legend: CalendarTone[];
}

export function buildCalendarPageData(input: CalendarPageInput): CalendarPageData {
  const { activeSeason, todayISO } = input;
  const calendarItems: CalendarItem[] = [
    ...input.sessions.map((s) => ({
      ...sessionCalendarItem(s, { mine: input.isMineSession(s.id), hasCard: false }),
      href: input.sessionHref(s.id),
    })),
    ...input.clubEvents.map((e) => clubEventCalendarItem(e, { mine: input.signedUpEvents.has(e.id) })),
    ...input.tournaments.flatMap((t) => tournamentCalendarItems(t)),
  ].sort(compareCalendarItems);

  // The month nav is bounded to what was loaded: the active term end to end,
  // plus a month of its own for anything outside it (calendarMonthKeys).
  const seasonSessionDates = activeSeason
    ? input.sessions.filter((s) => s.season_id === activeSeason.id).map((s) => s.date)
    : [];
  const looseDates = [
    ...input.sessions.filter((s) => !activeSeason || s.season_id !== activeSeason.id).map((s) => s.date),
    ...calendarItems.filter((i) => i.kind !== 'session').map((i) => i.date),
  ];
  const monthKeys = calendarMonthKeys(
    activeSeason?.start_date ? { startISO: activeSeason.start_date, endISO: activeSeason.end_date ?? null } : null,
    seasonSessionDates,
    looseDates,
    todayISO,
  );
  const months = monthKeys.map((key) => buildCalendarMonth(key, calendarItems, todayISO));
  const legend: CalendarTone[] = [
    ...(input.sessionsOn ? (['open', 'closed'] as const) : []),
    ...(input.eventsOn ? (['club'] as const) : []),
    ...(input.tournamentsOn ? (['tournament'] as const) : []),
  ];
  return { calendarItems, monthKeys, months, initialIndex: initialMonthIndex(monthKeys, todayISO), legend };
}
