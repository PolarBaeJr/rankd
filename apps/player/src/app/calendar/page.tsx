import * as Sentry from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { PageHeader } from '@badminton/ui';
import {
  clubToday,
  featureAccessFor,
  featureGate,
  wallClockToUtc,
  type AttendanceStatus,
  type FeatureId,
  type SessionIntent,
} from '@badminton/shared';
import { createServerSupabaseClient, getViewer } from '@/lib/supabase-server';
import { getFeatureFlags } from '@/lib/feature-gate';
import { CALENDAR_WEEKDAYS, addDaysISO, describeMyState } from '@/lib/schedule';
import type { CalendarClubEventRow, CalendarTournamentRow } from '@/lib/calendar-items';
import {
  calendarSessionsQuery,
  calendarTournamentsQuery,
  clubEventsCalendarQuery,
  mySignupsQuery,
} from '@/lib/home-schedule-queries';
import { buildCalendarPageData, type CalendarSessionWithSeason } from '@/lib/calendar-page-data';
import { MonthCalendar } from '../sessions/month-calendar';
import { SubscribeAllButton } from '../sessions/subscribe-all';

// The month grid on a page of its own. On /feed it is desktop only (the week
// strip stands in for it on a phone); here it is the whole page at every width.
// Same reads and the same derivation as /feed, through home-schedule-queries
// and calendar-page-data, so the two can never disagree about a day.
//
// A session links to its card on /feed, which DeepLinkScroll scrolls to. Only
// an open session still to come has a card there, so nothing else links.

export default async function CalendarPage() {
  const supabase = await createServerSupabaseClient();
  const [{ player }, features, { data: activeSeason }] = await Promise.all([
    getViewer(),
    getFeatureFlags(),
    supabase.from('seasons').select('id, name, start_date, end_date').eq('active_flag', true).maybeSingle(),
  ]);
  if (!player) redirect('/login');

  const access = featureAccessFor(player);
  const on = (id: FeatureId) => featureGate(features[id], access.includes(id)) !== 'redirect';
  const sessionsOn = on('sessions');
  const eventsOn = on('events');
  const tournamentsOn = on('tournaments');

  const todayKey = clubToday(new Date());
  // Same club events window as /feed: the start of the active term, or 60 days
  // back with no term running, through wallClockToUtc.
  const eventsFrom = (activeSeason?.start_date as string | undefined) ?? addDaysISO(todayKey, -60);
  const [efY, efM, efD] = eventsFrom.split('-').map(Number) as [number, number, number];
  const eventsLowerBound = wallClockToUtc(efY, efM, efD, 0, 0).toISOString();

  const skipped = Promise.resolve({ data: [] as never[], error: null });
  const [sessionsRes, attendanceRes, rsvpRes, clubEventsRes, signupsRes, tournamentsRes] = await Promise.all([
    sessionsOn ? calendarSessionsQuery(supabase, activeSeason?.id, player.status) : skipped,
    sessionsOn
      ? supabase.from('session_attendance').select('session_id, status').eq('player_id', player.id)
      : skipped,
    sessionsOn ? supabase.from('session_rsvp').select('session_id, intent').eq('player_id', player.id) : skipped,
    eventsOn ? clubEventsCalendarQuery(supabase, eventsLowerBound) : skipped,
    eventsOn ? mySignupsQuery(supabase, player.id) : skipped,
    tournamentsOn ? calendarTournamentsQuery(supabase, activeSeason?.id) : skipped,
  ]);

  for (const [action, res] of [
    ['calendar:sessions', sessionsRes],
    ['calendar:attendance', attendanceRes],
    ['calendar:rsvp', rsvpRes],
    ['calendar:clubEvents', clubEventsRes],
    ['calendar:signups', signupsRes],
    ['calendar:tournaments', tournamentsRes],
  ] as const) {
    if (res.error) {
      Sentry.captureException(new Error(res.error.message), { extra: { action, details: res.error.details } });
    }
  }
  // A refused read is said, not drawn as an empty month.
  const readFailed = Boolean(sessionsRes.error || clubEventsRes.error || tournamentsRes.error);

  const sessions = (sessionsRes.data ?? []) as unknown as CalendarSessionWithSeason[];
  const statusBySession = new Map(
    ((attendanceRes.data ?? []) as { session_id: string; status: string }[]).map((r) => [
      r.session_id,
      r.status as AttendanceStatus,
    ]),
  );
  const intentBySession = new Map(
    ((rsvpRes.data ?? []) as { session_id: string; intent: string }[]).map((r) => [
      r.session_id,
      r.intent as SessionIntent,
    ]),
  );
  const isMineSession = (id: string) => {
    const state = describeMyState(statusBySession.get(id), intentBySession.get(id));
    return state === 'going' || state === 'checked_in' || state === 'attended';
  };
  const withCard = new Set(sessions.filter((s) => s.status === 'open' && s.date >= todayKey).map((s) => s.id));

  const { months, initialIndex, legend } = buildCalendarPageData({
    sessions,
    clubEvents: (clubEventsRes.data ?? []) as unknown as CalendarClubEventRow[],
    tournaments: (tournamentsRes.data ?? []) as unknown as CalendarTournamentRow[],
    activeSeason: activeSeason
      ? {
          id: activeSeason.id as string,
          start_date: (activeSeason.start_date as string | null) ?? null,
          end_date: (activeSeason.end_date as string | null) ?? null,
        }
      : null,
    todayISO: todayKey,
    isMineSession,
    signedUpEvents: new Set(((signupsRes.data ?? []) as { event_id: string }[]).map((r) => r.event_id)),
    sessionHref: (id) => (withCard.has(id) ? `/feed?s=${id}` : null),
    sessionsOn,
    eventsOn,
    tournamentsOn,
  });

  const eyebrow = (activeSeason?.name as string | undefined) ?? 'The club';

  return (
    <div>
      <PageHeader
        eyebrow={eyebrow.toUpperCase()}
        title="Calendar"
        actions={sessionsOn || eventsOn ? <SubscribeAllButton /> : undefined}
      />
      {readFailed && (
        <p className="muted" style={{ marginBottom: 12 }}>
          Part of the schedule could not be loaded. Refresh the page to try again.
        </p>
      )}
      <section aria-label="Month calendar">
        <MonthCalendar months={months} initialIndex={initialIndex} weekdays={CALENDAR_WEEKDAYS} legend={legend} />
      </section>
    </div>
  );
}
