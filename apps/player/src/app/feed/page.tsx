import { createServerSupabaseClient, getViewer } from '@/lib/supabase-server';
import { getCheckinSettings } from '@/lib/checkin-settings';
import {
  CLUB_TIMEZONE,
  describeMatchShape,
  clubToday,
  formatRelativeTime,
  formatTime,
  getAccountStanding,
  getCheckinWindow,
  isCheckinOpen,
  pickOne,
  featureGate,
  featureAccessFor,
  scopeToActiveSeason,
  selectAllInChunks,
  wallClockToUtc,
  windowState,
  checkinWindowNotice,
  type AttendanceStatus,
  type FeatureId,
  type SessionIntent,
} from '@badminton/shared';
import * as Sentry from '@sentry/nextjs';
import { Fragment } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Calendar } from 'lucide-react';
import { PageHeader, AvatarChip } from '@badminton/ui';
import { PasskeyNudge } from '@/components/passkey-nudge';
import { LiveRating } from '@/components/live-rating';
import { LiveFeed } from '@/components/live-matches';
import { LiveTournament } from '../tournaments/live-tournament';
import { ActiveTournamentCard, type ActiveEntry } from './active-tournament';
import { ActivityPanel, type RiverItem } from './activity-panel';
import { ClubEventAgendaRow, TournamentAgendaRow } from './agenda-rows';
import { WeekStrip } from './week-strip';
import { SessionCard, type SessionCardSession } from '../sessions/session-card';
import { SubscribeAllButton } from '../sessions/subscribe-all';
import { DeepLinkScroll } from '../sessions/deep-link-scroll';
import { MonthCalendar } from '../sessions/month-calendar';
import {
  attendanceStreak,
  describeMatch,
  groupByDay,
  seasonWeek,
  type RiverPerson,
} from '@/lib/feed-activity';
import { isUnderWay, runningEvents, type FeedTournament } from '@/lib/feed-tournament';
import { countEnteredPlayers, occupiesAPlace } from '@/lib/tournament-index';
import { loadEntryWindows, windowsFor, type EntryWindows } from '@/lib/tournament-windows';
import { isAddressedTo, withVisibleAnnouncements } from '@/lib/announcement-visibility';
import { onVisibleTracks } from '@/lib/session-track-filter';
import { getFeatureFlags } from '@/lib/feature-gate';
import { PaymentBanner } from '@/components/payment-banner';
import { attendeeCountsBySession } from '@/lib/session-attendee-counts';
import {
  CALENDAR_WEEKDAYS,
  addDaysISO,
  describeMyState,
  isStillUpcoming,
  tallyBySession,
  wasPresent,
} from '@/lib/schedule';
import {
  buildAgenda,
  buildWeekStrip,
  type AgendaSession,
  type CalendarClubEventRow,
  type CalendarTournamentRow,
} from '@/lib/calendar-items';
import {
  calendarSessionsQuery,
  calendarTournamentsQuery,
  clubEventsCalendarQuery,
  mySignupsQuery,
  openSessionsQuery,
} from '@/lib/home-schedule-queries';
import { buildCalendarPageData, type CalendarSessionWithSeason } from '@/lib/calendar-page-data';

type PlayerEmbed = { id: string; full_name: string | null; handle: string | null; avatar_url: string | null };
type MatchParticipantRow = {
  team_side: 'a' | 'b';
  win_flag: boolean | null;
  rating_delta: number | null;
  post_rating: number | null;
  player: PlayerEmbed | PlayerEmbed[] | null;
};
type MatchRow = {
  id: string;
  played_at: string | null;
  match_type: string;
  format: string;
  games_per_match: number | null;
  points_per_game: number | null;
  score_summary: string | null;
  match_participants: MatchParticipantRow[] | null;
};
type OpenSessionRow = SessionCardSession & AgendaSession;
type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  created_at: string;
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  author: { full_name: string | null } | { full_name: string | null }[] | null;
};

function toPerson(raw: PlayerEmbed | null): RiverPerson | null {
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.full_name ?? 'Someone',
    handle: raw.handle ?? null,
    avatarUrl: raw.avatar_url ?? null,
  };
}

export default async function FeedPage() {
  const supabase = await createServerSupabaseClient();

  // THE VIEWER, THE CLUB FEATURE SWITCHES AND THE ACTIVE SEASON, TOGETHER.
  // None depends on another, and awaiting them in turn was two whole extra
  // round trips on the app's landing page. A signed-out caller wastes two
  // reads before the redirect, which is cheaper than every member paying the
  // wait.
  //
  // The season scopes the header eyebrow, the schedule and the notice, exactly
  // as /sessions and /announcements already scope themselves; it is needed
  // before the batch below because three of its queries use the id.
  const [{ player }, features, { data: activeSeason }] = await Promise.all([
    getViewer(),
    getFeatureFlags(),
    supabase
      .from('seasons')
      .select('id, name, start_date, end_date')
      .eq('active_flag', true)
      .maybeSingle(),
  ]);
  if (!player) redirect('/login');

  // THE CLUB FEATURE SWITCHES. A card belonging to a switched-off feature is
  // dropped, the same as its nav item, unless the viewer holds its
  // `page.access.<id>` key and can still open its pages. The older reads still
  // run and this only decides what is drawn; the schedule's own reads are
  // skipped outright while their switch is off.
  const access = featureAccessFor(player);
  const on = (id: FeatureId) => featureGate(features[id], access.includes(id)) !== 'redirect';
  const sessionsOn = on('sessions');
  const eventsOn = on('events');
  const tournamentsOn = on('tournaments');
  const scheduleOn = sessionsOn || eventsOn || tournamentsOn;

  // ONE clock reading per render, and a PINNED club date from it. clubToday
  // applies the fixed UTC-7 from 2026-11-01 whatever tzdata the host carries,
  // so the agenda, the week strip, the month grid and the tournament banner all
  // agree about what today is.
  const now = new Date();
  const todayKey = clubToday(now);
  const nowIso = now.toISOString();

  const inActiveSeason = <T extends { or: (f: string) => T }>(q: T): T =>
    activeSeason ? q.or(`season_id.eq.${activeSeason.id},season_id.is.null`) : q;

  // THE RIVER IS BUILT HERE AND NOT INLINE, and not through inActiveSeason
  // either. Its select is by far the widest on this page — a two-level embed
  // with five columns under it — and passing that chain through the generic
  // above makes tsc give up with "type instantiation is excessively deep",
  // which is the same wall discord-profile.ts documents hitting. A plain const
  // and a conditional .or() is the same filter with none of the inference.
  //
  // SCOPED, and it was the only card on this page that was not. Everything
  // else here is season-filtered, so on the first day of a term the feed drew
  // an empty session list above a river of last term's results. Worse than the
  // inconsistency: the river renders `rating_delta` and `post_rating`, and a
  // post_rating from before a rollover is measured against a ladder that no
  // longer exists, so it read as a current standing.
  //
  // The nullable shape, matching the sessions above: `matches.season_id` really
  // can be NULL, because submit_match_result stamps it from an unguarded
  // `WHERE active_flag LIMIT 1` and a result entered between terms gets none.
  // Excluding those would hide a real match from the club's own feed forever.
  const riverBase = supabase
    .from('matches')
    .select(`
      id, played_at, match_type, format, games_per_match, points_per_game, score_summary,
      match_participants(team_side, win_flag, rating_delta, post_rating,
        player:players(id, full_name, handle, avatar_url))
    `)
    .eq('result_status', 'confirmed')
    .not('played_at', 'is', null);
  const riverQuery = (
    activeSeason
      ? riverBase.or(`season_id.eq.${activeSeason.id},season_id.is.null`)
      : riverBase
  )
    .order('played_at', { ascending: false })
    .limit(15);

  // The club events window: from the start of the active term, or 60 days
  // back with no term running. Through wallClockToUtc, never a Date built from
  // the host's clock, for the same 2026-11-01 reason as todayKey.
  const eventsFrom = (activeSeason?.start_date as string | undefined) ?? addDaysISO(todayKey, -60);
  const [efY, efM, efD] = eventsFrom.split('-').map(Number) as [number, number, number];
  const eventsLowerBound = wallClockToUtc(efY, efM, efD, 0, 0).toISOString();

  // A read whose feature is off is not sent at all.
  const skipped = Promise.resolve({ data: [] as never[], error: null });

  const [
    pastSessionsRes,
    myAttendanceRes,
    announcementsRes,
    recentMatchesRes,
    pendingChallengesRes,
    liveTournamentsRes,
    openSessionsRes,
    calendarSessionsRes,
    myRsvpRes,
    clubEventsRes,
    mySignupsRes,
    calendarTournamentsRes,
    checkinSettings,
  ] = await Promise.all([
    // The sessions the streak counts down through: already happened, and ones
    // this member was eligible for. Being ineligible for a session is not the
    // same as not turning up to it, so the track filter is what keeps the
    // streak honest.
    onVisibleTracks(
      inActiveSeason(
        supabase
          .from('sessions')
          .select('id, date')
          .lt('date', todayKey),
      ),
      player.status,
    )
      .order('date', { ascending: false })
      .limit(20),
    // Every status, not only the present ones: the session cards need
    // `no_show` and `excused` to retire their RSVP controls. The streak filters
    // to present below.
    supabase
      .from('session_attendance')
      .select('session_id, status')
      .eq('player_id', player.id),
    // Three rather than one, because target_audience cannot be filtered in the
    // query (it is matched against the viewer's own division below) and the
    // newest row might not be for them.
    //
    // withVisibleAnnouncements applies expiry AND the 00085 season shape — the
    // same filter /announcements runs, from the same module, so the home screen
    // and the news screen cannot disagree about whether a notice is retired.
    // NOT inActiveSeason() above: that is the sessions shape (a nullable
    // season_id) and it would match no evergreen announcement at all.
    withVisibleAnnouncements(
      supabase
        .from('announcements')
        // Unhinted embed: `announcements` has exactly one foreign key to
        // `players` (author_id), so PostgREST resolves it without a constraint
        // name — and a constraint name guessed from the schema would only fail
        // at runtime if it were wrong.
        .select('id, title, body, created_at, target_audience, author:players(full_name)')
        .eq('status', 'published'),
      nowIso,
      activeSeason?.id,
    )
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(3),
    // The river's own query, run against `matches` rather than against this
    // member's `match_participants`, for two reasons: the feed shows the CLUB's
    // results and not only the member's own, and a top-level query is the only
    // one PostgREST will order by played_at — ordering by an embedded to-one
    // relation is silently a no-op.
    // Built above, where the reason it is season-scoped is written down.
    riverQuery,
    supabase
      .from('challenge_participants')
      // NOT `created_at` on the outer row: challenge_participants has no such
      // column (id, challenge_id, player_id, role, team_side,
      // confirmation_status, responded_at). PostgREST answered 400 to the whole
      // request, supabase-js resolved rather than rejected, and `?? []` turned
      // it into "no pending challenges" for every member. The timestamp this
      // needs is the challenge's own, which is selected below.
      .select('id, challenge:challenges(id, type, format, games_per_match, points_per_game, created_at, creator:players!challenges_created_by_fkey(id, full_name, handle, avatar_url))')
      .eq('player_id', player.id)
      .eq('confirmation_status', 'pending')
      .limit(5),
    // ---- IS THE CLUB PLAYING A TOURNAMENT RIGHT NOW (wave 1 of 2) --------
    //
    // The three cheap conditions are pushed into the query and the expensive one
    // is not:
    //   status = 'active'      — 'draft' is unpublished, 'completed' and
    //                            'archived' are over. Only 'active' can be on.
    //   suspended_at IS NULL   — a suspended tournament refuses registration
    //                            and self check-in server-side, so announcing it
    //                            as running would be an invitation to a refusal.
    //                            Filtered rather than selected; PostgREST
    //                            filters on unselected columns happily and
    //                            `authenticated` may read it either way.
    //   the active season      — same rule as the sessions and announcements
    //                            above, via the same shared helper /tournaments
    //                            uses.
    //
    // The DATE bound is applied in JS instead, in isUnderWay(). It is
    // `(end_date ?? start_date) >= todayKey`, and PostgREST has no COALESCE in a
    // filter, so expressing it here would mean a second `.or()` on a query that
    // already has one from scopeToActiveSeason — two `or` params that get ANDed
    // in a way nobody reading this would predict. The row count this leaves to
    // JS is the active season's 'active' tournaments, which is one on production
    // and will not be many.
    //
    // NAMED COLUMNS, NOT `*`, for the reason the event page gives at length:
    // these tables carry exec-written free text (`suspension_reason` here,
    // `notes` and `pair_name` below) that 00117/00118 moved out but deliberately
    // did not drop. Every column named here was verified readable by the
    // `authenticated` ROLE against the production database on 2026-08-17, with
    // has_column_privilege() and then again by running these selects under
    // `SET LOCAL ROLE authenticated` — not by reading the migrations, which is
    // how the four screens in 00115 were lost. `end_date` is the only one no
    // other player-app query names, and it is the one that was checked hardest.
    scopeToActiveSeason(
      supabase
        .from('tournaments')
        .select('id, name, start_date, end_date, tournament_events(id, event_type, status)')
        .eq('status', 'active')
        .is('suspended_at', null),
      activeSeason?.id,
    ).order('start_date', { ascending: true }),
    // ---- THE SCHEDULE -------------------------------------------------------
    // Built in lib/home-schedule-queries.ts, where home-schedule-query.test.ts
    // pins every select string and filter.
    sessionsOn ? openSessionsQuery(supabase, activeSeason?.id, player.status) : skipped,
    sessionsOn ? calendarSessionsQuery(supabase, activeSeason?.id, player.status) : skipped,
    sessionsOn
      ? supabase.from('session_rsvp').select('session_id, intent').eq('player_id', player.id)
      : skipped,
    eventsOn ? clubEventsCalendarQuery(supabase, eventsLowerBound) : skipped,
    eventsOn ? mySignupsQuery(supabase, player.id) : skipped,
    tournamentsOn ? calendarTournamentsQuery(supabase, activeSeason?.id) : skipped,
    // The live window tunables, so a card's Check In button and "Opens at"
    // agree with session_checkin_open(). Never throws; falls back itself.
    getCheckinSettings(),
  ]);

  // THE SAME TREATMENT THE TOURNAMENT READ GETS BELOW, AND FOR THE SAME REASON
  // — see the long note at `liveTournamentsRes`. This is the landing surface, so
  // a refused read must not become an error screen; but a bare `?? []` here is
  // what let a `pending_approval` member be shown a feed with no next session
  // and a broken attendance streak for months, because the track filter sent a
  // `player_status` value into a `session_group` column and PostgREST answered
  // 400. Report it, degrade to no card, and let somebody find out.
  //
  // The schedule's reads follow the same rule with one difference: a failed
  // SESSIONS read is said on screen, because "No sessions yet" over twelve open
  // sessions is a confident lie. A failed events or tournaments read drops
  // those rows and says so in one line; a failed attendance, RSVP or sign-up
  // read costs a chip, as it always did on /sessions.
  for (const [action, res] of [
    ['feed:pastSessions', pastSessionsRes],
    ['feed:myAttendance', myAttendanceRes],
    ['feed:openSessions', openSessionsRes],
    ['feed:calendarSessions', calendarSessionsRes],
    ['feed:myRsvp', myRsvpRes],
    ['feed:clubEvents', clubEventsRes],
    ['feed:mySignups', mySignupsRes],
    ['feed:calendarTournaments', calendarTournamentsRes],
  ] as const) {
    if (res.error) {
      Sentry.captureException(new Error(res.error.message), {
        extra: { action, details: res.error.details },
      });
    }
  }
  const scheduleError = Boolean(openSessionsRes.error || calendarSessionsRes.error);
  const clubEventsError = Boolean(clubEventsRes.error);
  const tournamentsError = Boolean(calendarTournamentsRes.error);

  const pastSessions = (pastSessionsRes.data ?? []) as { id: string }[];
  const myAttendance = (myAttendanceRes.data ?? []) as { session_id: string; status: string }[];
  const attendedIds = new Set(myAttendance.filter((r) => wasPresent(r.status)).map((r) => r.session_id));
  const streak = attendanceStreak(pastSessions, attendedIds);
  const myStatusBySession = new Map<string, AttendanceStatus>(
    myAttendance.map((r) => [r.session_id, r.status as AttendanceStatus]),
  );
  const myIntentBySession = new Map<string, SessionIntent>(
    ((myRsvpRes.data ?? []) as { session_id: string; intent: string }[]).map((r) => [
      r.session_id,
      r.intent as SessionIntent,
    ]),
  );
  const mySignedUp = new Set(((mySignupsRes.data ?? []) as { event_id: string }[]).map((r) => r.event_id));

  const openSessions = (openSessionsRes.data ?? []) as unknown as OpenSessionRow[];
  const calendarSessions = (calendarSessionsRes.data ?? []) as unknown as CalendarSessionWithSeason[];
  const clubEvents = (clubEventsRes.data ?? []) as unknown as CalendarClubEventRow[];
  const calendarTournaments = (calendarTournamentsRes.data ?? []) as unknown as CalendarTournamentRow[];

  // ---- IS THE CLUB PLAYING A TOURNAMENT RIGHT NOW (wave 2 of 2) ------------
  //
  // *** WHY THIS IS NEITHER `unwrap` NOR A BARE `?? []`. ***
  //
  // The event page wraps its reads in `unwrap`, which RAISES on res.error. That
  // is right there and wrong here: this is the app's LANDING SURFACE, reached by
  // every member on every visit, and a 403 on a tournament column would turn the
  // front door into an error screen over a card that is absent 360 days a year.
  //
  // A bare `?? []` is the other failure and the one this repository keeps
  // paying for: a rejected PostgREST request RESOLVES rather than rejects, so
  // `?? []` renders a 403 as "no tournament is on" — indistinguishable from the
  // truth, silent, and permanent. 00115 is the write-up of that emptying five
  // screens.
  //
  // So: check res.error explicitly, report it to Sentry the way first-signin.ts
  // and reactivate.ts report their soft failures, and degrade to no card. The
  // feed still renders; somebody finds out.
  let liveTournaments: FeedTournament[] = [];
  if (liveTournamentsRes.error) {
    Sentry.captureException(new Error(liveTournamentsRes.error.message), {
      extra: { action: 'feed:activeTournaments', details: liveTournamentsRes.error.details },
    });
  } else {
    liveTournaments = ((liveTournamentsRes.data ?? []) as unknown as FeedTournament[])
      .map((t) => ({ ...t, tournament_events: t.tournament_events ?? [] }))
      .filter((t) => isUnderWay(t, todayKey));
  }

  // Every running event across every running tournament, in ONE pair of round
  // trips rather than a pair per tournament. Same two-wave shape /tournaments
  // uses for `countedEventIds`, and the same two column lists, so both screens
  // are asking the database the same question.
  //
  // BOTH TABLES, ALWAYS, and not as a belt-and-braces gesture. Since 00102 a
  // member enters a DOUBLES event alone and an exec pairs them later, so a
  // doubles entrant may own a `tournament_participants` row and no
  // `tournament_pairs` row at all. Checking only pairs for a doubles event would
  // tell a genuinely entered member they are not in it — the exact bug the event
  // page documents having had ("This was `!doubles` on the grounds that a
  // doubles entrant had no participant row"). Neither table is consulted
  // per-format here; both are read and both are searched.
  if (!on('tournaments')) liveTournaments = [];
  const runningEventIds = liveTournaments.flatMap((t) => runningEvents(t).map((e) => e.id));

  let tournamentEntryRows: Array<{ event_id: string; player_id: string; status: string }> = [];
  let tournamentPairRows: Array<{ event_id: string; player1_id: string; player2_id: string; status: string }> = [];

  // The upcoming open sessions, by the same rule the agenda applies below
  // (buildAgenda): kept until their check-in window closes. Only these carry
  // a card, so only these need a count.
  const upcomingIds = openSessions
    .filter((s) => isStillUpcoming(getCheckinWindow(s, checkinSettings).closesAt, now))
    .map((s) => s.id);

  // WAVE 2 SHARES ITS ROUND TRIP with the cards' counts, so the page is still
  // three rounds deep: seasons, the batch above, and this.
  //
  // The counts are scoped to the cards and paged, exactly as /sessions did it:
  // an unscoped read of either table truncates silently at PGRST_DB_MAX_ROWS.
  // `as never` is the cast /sessions carries for the same TS2589.
  const [entryResults, checkedInBySession, goingRes, feedWindows] = await Promise.all([
    runningEventIds.length > 0
      ? Promise.all([
          supabase
            .from('tournament_participants')
            .select('event_id, player_id, status')
            .in('event_id', runningEventIds),
          supabase
            .from('tournament_pairs')
            .select('event_id, player1_id, player2_id, status')
            .in('event_id', runningEventIds),
        ])
      : Promise.resolve(null),
    attendeeCountsBySession(supabase as never, upcomingIds),
    selectAllInChunks<{ session_id: string }>(upcomingIds, (batch, from, to) =>
      supabase
        .from('session_rsvp')
        .select('session_id')
        .in('session_id', batch)
        .eq('intent', 'going')
        .order('session_id')
        .range(from, to) as never,
    ),
    // The running events' check-in windows (00276), for the card's wording
    // only. Display, so a failed read degrades to no window and is reported.
    runningEventIds.length > 0
      ? loadEntryWindows(supabase, {
          eventIds: runningEventIds,
          tournamentIds: liveTournaments.map((t) => t.id),
        }).catch((err: unknown): EntryWindows | null => {
          Sentry.captureException(err, { extra: { action: 'feed:entryWindows' } });
          return null;
        })
      : Promise.resolve(null),
  ]);
  if (goingRes.error) {
    Sentry.captureException(new Error(goingRes.error.message), {
      extra: { action: 'feed:goingCounts' },
    });
  }
  const goingBySession = tallyBySession(goingRes.data);

  if (entryResults) {
    const [pRes, prRes] = entryResults;
    // Same explicit-error rule as above, for the same reason — but the DEGRADED
    // STATE IS DIFFERENT, and that is the point of handling the two waves
    // separately. Wave 1 failing means "we do not know whether a tournament is
    // on", so there is no card to draw. Wave 2 failing means "we know one is on
    // but not who is in it", and a card drawn anyway would silently demote every
    // entrant to the not-entered branch — telling a member standing in the gym
    // that they are not entered in the event they are about to play. That is
    // worse than no card, so the card is dropped whole rather than shown wrong.
    if (pRes.error || prRes.error) {
      const failed = pRes.error ?? prRes.error!;
      Sentry.captureException(new Error(failed.message), {
        extra: { action: 'feed:activeTournamentEntries', details: failed.details },
      });
      tournamentEntryRows = [];
      tournamentPairRows = [];
      liveTournaments = [];
    } else {
      tournamentEntryRows = (pRes.data ?? []) as typeof tournamentEntryRows;
      tournamentPairRows = (prRes.data ?? []) as typeof tournamentPairRows;
    }
  }


  /** The viewer's own standing in one running event, or null if they are not in
   *  it. `occupiesAPlace` rather than a fresh status check, so this agrees with
   *  the "Current tournaments" section on /tournaments about the same member: a withdrawn
   *  or disqualified entry is not an entry. */
  const myEntryIn = (eventId: string): ActiveEntry['mine'] => {
    const solo = tournamentEntryRows.find(
      (r) => r.event_id === eventId && r.player_id === player.id && occupiesAPlace(r.status),
    );
    if (solo) return { checkedIn: solo.status === 'checked_in' };
    const pair = tournamentPairRows.find(
      (r) =>
        r.event_id === eventId &&
        (r.player1_id === player.id || r.player2_id === player.id) &&
        occupiesAPlace(r.status),
    );
    if (pair) return { checkedIn: pair.status === 'checked_in' };
    return null;
  };

  /** One running event's check-in window (00276), for the card's wording. */
  const checkinWindowOf = (eventId: string, tournamentId: string): Pick<ActiveEntry, 'checkinWindow' | 'checkinNotice'> => {
    if (!feedWindows) return {};
    const w = windowsFor(feedWindows, eventId, tournamentId).checkin;
    return { checkinWindow: windowState(w.opens_at, w.closes_at, now), checkinNotice: checkinWindowNotice(w, now) };
  };

  // RLS only checks status='published'. Expiry and season are filtered in the
  // query above; audience is the one part that cannot be, because it is matched
  // against a value on the viewer rather than on the row.
  const notice = ((on('announcements') ? announcementsRes.data ?? [] : []) as unknown as AnnouncementRow[]).find((a) =>
    isAddressedTo(a, player),
  );
  const noticeAuthor = pickOne(notice?.author ?? null);

  const standing = getAccountStanding(player);
  const isApproved = standing.ok;

  // ---- the river -------------------------------------------------------
  const matchItems: RiverItem[] = ((recentMatchesRes.data ?? []) as unknown as MatchRow[])
    .map((m): RiverItem | null => {
      const rows = m.match_participants ?? [];
      const winners = rows.filter((p) => p.win_flag === true);
      const losers = rows.filter((p) => p.win_flag === false);
      const winnerPeople = winners.map((p) => toPerson(pickOne(p.player))).filter((p): p is RiverPerson => !!p);
      const loserPeople = losers.map((p) => toPerson(pickOne(p.player))).filter((p): p is RiverPerson => !!p);

      const sentence = describeMatch({ winners: winnerPeople, losers: loserPeople }, player.id);
      if (!sentence || !m.played_at) return null;

      const mineRow = rows.find((p) => pickOne(p.player)?.id === player.id);
      const mine = !!mineRow;
      const iWon = mineRow?.win_flag === true;

      // The avatar and the handle belong to the OTHER person the sentence
      // names — the opponent on the reader's own rows, the winner on everyone
      // else's. Hanging the reader's own handle off "You beat Marcus Ng" would
      // read as Marcus's handle, and the red spine already says whose row it
      // is, so their own face there would be redundant as well as confusing.
      const face = mine ? (iWon ? loserPeople[0] : winnerPeople[0]) : winnerPeople[0];
      if (!face) return null;

      const formatLabel = describeMatchShape({ match_format: m.format, games_per_match: m.games_per_match, points_per_game: m.points_per_game });
      const meta = [
        m.match_type === 'doubles' ? 'Doubles' : 'Singles',
        m.score_summary || formatLabel,
        formatRelativeTime(m.played_at),
      ]
        .filter(Boolean)
        .join(' · ');

      return {
        kind: 'match',
        id: m.id,
        at: m.played_at,
        mine,
        sentence,
        meta,
        face,
        // ONLY the reader's own figures. An absolute rating printed beside
        // another member's name publishes the one number hide_from_leaderboard
        // exists to let them withhold, and this query has no way to honour that
        // flag — get_leaderboard() is where that filtering lives, and it is not
        // reachable from a match row. The mockup's "+14 over 817" is on a row
        // about the reader, so nothing is lost. Everyone else's result is
        // already fully described by the score in the meta line.
        delta: mine ? (mineRow?.rating_delta ?? null) : null,
        rating: mine ? (mineRow?.post_rating ?? null) : null,
        // Another member's row goes to that member's profile; the reader's own
        // goes to their stats. Sending everything to /my-stats meant tapping
        // "Jordan Lee beat Priya Patel" landed you on your own numbers.
        href: mine && on('my_stats') ? '/my-stats' : `/leaderboard/${face.id}`,
      };
    })
    .filter((i): i is RiverItem => i !== null);

  const challengeItems: RiverItem[] = (on('challenges') ? pendingChallengesRes.data ?? [] : [])
    .map((pc): RiverItem | null => {
      const c = pickOne(pc.challenge as unknown as Record<string, unknown> | null) as Record<string, unknown> | null;
      if (!c) return null;
      const creator = toPerson(pickOne(c.creator as PlayerEmbed | PlayerEmbed[] | null));
      if (!creator) return null;
      const at = c.created_at as string;
      if (!at) return null;
      return {
        kind: 'challenge',
        id: pc.id as string,
        at,
        mine: true,
        sentence: `${creator.name} wants to play you`,
        meta: ['Challenge', describeMatchShape({ match_format: c.format as string, games_per_match: c.games_per_match as number | null, points_per_game: c.points_per_game as number | null })]
          .filter(Boolean)
          .join(' · '),
        face: creator,
        href: `/challenges/${c.id as string}`,
      };
    })
    .filter((i): i is RiverItem => i !== null);

  const sections = groupByDay<RiverItem>([...matchItems, ...challengeItems], now, CLUB_TIMEZONE);
  const seasonWeekNo = activeSeason?.start_date ? seasonWeek(activeSeason.start_date, now, CLUB_TIMEZONE) : null;
  const eyebrow = [activeSeason?.name, seasonWeekNo ? `Week ${seasonWeekNo}` : null].filter(Boolean).join(' · ') || 'The club';

  // ---- the schedule ----------------------------------------------------
  const agenda = buildAgenda({
    sessions: openSessions,
    clubEvents,
    tournaments: calendarTournaments,
    now,
    todayISO: todayKey,
    checkinSettings,
    liveTournamentIds: new Set(liveTournaments.map((t) => t.id)),
  });
  // Up next shows the next two weeks; later dates fold under Show more. The
  // cut is by date, not count, so the week strip's #day- anchors (this week
  // only) always land on an open row.
  const agendaCutoff = addDaysISO(todayKey, 14);
  const agendaSoonAll = agenda.filter((day) => day.dateISO < agendaCutoff);
  // Never fold everything: a quiet fortnight still shows the next three dates.
  const agendaSoon = agendaSoonAll.length >= 3 ? agendaSoonAll : agenda.slice(0, 3);
  const agendaLater = agenda.slice(agendaSoon.length);
  const laterCount = agendaLater.length;
  const upcoming = agenda.flatMap((day) =>
    day.sessions.flatMap((entry) => (entry.kind === 'session' ? [entry.session] : [])),
  );
  const upcomingCount = upcoming.length;
  const hasCard = new Set(upcoming.map((s) => s.id));
  const isMineState = (id: string) => {
    const state = describeMyState(myStatusBySession.get(id), myIntentBySession.get(id));
    return state === 'going' || state === 'checked_in' || state === 'attended';
  };
  const myUpcomingCount = upcoming.filter((s) => isMineState(s.id)).length;
  const upcomingEventCount = agenda.reduce(
    (n, day) => n + day.sessions.filter((entry) => entry.kind === 'club_event').length,
    0,
  );
  // The accent goes on the soonest night dated today or later, as on /sessions.
  const nextSessionId = (upcoming.find((s) => s.date >= todayKey) ?? upcoming[0])?.id;

  const { calendarItems, months, initialIndex: initialMonth, legend } = buildCalendarPageData({
    sessions: calendarSessions,
    clubEvents,
    tournaments: calendarTournaments,
    activeSeason: activeSeason
      ? {
          id: activeSeason.id as string,
          start_date: (activeSeason.start_date as string | null) ?? null,
          end_date: (activeSeason.end_date as string | null) ?? null,
        }
      : null,
    todayISO: todayKey,
    isMineSession: isMineState,
    signedUpEvents: mySignedUp,
    sessionHref: (id) => (hasCard.has(id) ? `#session-${id}` : null),
    sessionsOn,
    eventsOn,
    tournamentsOn,
  });
  const week = buildWeekStrip(calendarItems, todayKey);
  const agendaDates = new Set(agenda.map((day) => day.dateISO));

  const upNextSub = [
    upcomingCount > 0
      ? `${upcomingCount} session${upcomingCount === 1 ? '' : 's'} coming up`
      : null,
    myUpcomingCount > 0 ? `you're in for ${myUpcomingCount}` : null,
    upcomingEventCount > 0 ? `${upcomingEventCount} club event${upcomingEventCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // The reader's own aggregate record. getViewer() already selects
  // `ratings(*)`, so this is free — no extra round trip, and no whole-club
  // get_leaderboard() fetch just to print one member's numbers. It is the
  // member's OWN row, so hide_from_leaderboard does not apply: that flag
  // governs what everyone else sees.
  const rating = (Array.isArray(player.ratings) ? player.ratings[0] : player.ratings) as
    | {
        singles_elo: number | null;
        doubles_elo: number | null;
        singles_wins: number | null;
        singles_losses: number | null;
        doubles_wins: number | null;
        doubles_losses: number | null;
        singles_provisional: boolean | null;
        doubles_provisional: boolean | null;
      }
    | null
    | undefined;
  const played =
    (rating?.singles_wins ?? 0) +
    (rating?.singles_losses ?? 0) +
    (rating?.doubles_wins ?? 0) +
    (rating?.doubles_losses ?? 0);

  // One day of the agenda. Shared by the first fortnight and the folded
  // remainder so both render identically.
  const renderAgendaDay = (day: (typeof agenda)[number]) => (
    <div
      key={day.dateISO}
      id={`day-${day.dateISO}`}
      className={`sched-day${day.isToday ? ' is-today' : ''}`}
    >
      <div className="sched-day-rail">
        <div className="sched-day-label">{day.label}</div>
        <div className="sched-day-date">{day.dateLabel}</div>
      </div>
      <div className="sched-day-list">
        {day.sessions.map((entry) => {
          if (entry.kind === 'club_event') {
            return (
              <ClubEventAgendaRow
                key={entry.key}
                event={entry.event}
                going={mySignedUp.has(entry.event.id)}
              />
            );
          }
          if (entry.kind === 'tournament') {
            return <TournamentAgendaRow key={entry.key} tournament={entry.tournament} todayISO={todayKey} />;
          }
          const session = entry.session;
          const canCheckIn = isCheckinOpen(session, now, checkinSettings);
          const { opensAt } = getCheckinWindow(session, checkinSettings);
          let windowLabel: string | undefined;
          // Only for nights still ahead, as on /sessions.
          if (!canCheckIn && session.date >= todayKey) {
            if (opensAt && now < opensAt) {
              const opensLocal = opensAt.toLocaleTimeString('en-GB', {
                timeZone: CLUB_TIMEZONE,
                hourCycle: 'h23',
                hour: '2-digit',
                minute: '2-digit',
              });
              windowLabel = `Opens at ${formatTime(opensLocal)}`;
            } else {
              windowLabel = 'Check-in closed';
            }
          }
          return (
            <SessionCard
              key={entry.key}
              session={session}
              myStatus={myStatusBySession.get(session.id) ?? null}
              myIntent={myIntentBySession.get(session.id) ?? null}
              checkedInCount={checkedInBySession[session.id] ?? 0}
              goingCount={goingBySession[session.id] ?? 0}
              canCheckIn={canCheckIn}
              windowLabel={windowLabel}
              isNext={session.id === nextSessionId}
              standingOk={isApproved}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <div data-screen-label="Feed" className="wide-page">
      {/* The You card below reads the member's own `ratings` row, and a
          confirm entered on somebody else's phone left it stale. Mounted
          unconditionally: it is a filter on ONE row, it fires only when this
          member's own rating moves, and when it does the activity river is
          stale for the same reason. */}
      <LiveRating playerId={player.id} />
      {/* The river itself, and the pending-challenges block in it. This is
          the ONE page in the app that revalidatePath never reaches for a
          result (lib/actions/matches.ts revalidates /challenges,
          /challenges/[id], /leaderboard and /my-stats and not this), so
          without this listener the activity is stale for everybody including
          the member who just submitted the result that belongs in it.

          Unfiltered on `matches`, deliberately: a feed of the club's last
          fifteen results is a screen about everybody, and `matches` has no
          player column to filter on in any case. See live-matches.tsx. */}
      <LiveFeed playerId={player.id} />
      {/* Calendar links, pushes and old /sessions?s= URLs arrive here as
          /feed?s=<id>; this scrolls to that session's card. */}
      <DeepLinkScroll />
      <PageHeader
        eyebrow={eyebrow.toUpperCase()}
        title="Feed"
        actions={
          <AvatarChip name={player.full_name} id={player.id} src={player.avatar_url} size="md" ring />
        }
        className="feed-header"
      />

      {/* Kept against the mockup. Hiding the gated controls without saying
          why leaves a member staring at a schedule they cannot act on, and it
          is what stops a suspended account being offered a control
          requirePlayer() is certain to refuse. */}
      {!isApproved && (
        <div className="card-base" style={{ marginBottom: 20, borderLeft: '3px solid var(--gold)' }}>
          <h3 className="card-title" style={{ marginBottom: 6 }}>
            {standing.block === 'pending_approval' ? 'Waiting on approval' : 'Account suspended'}
          </h3>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
            {standing.detail} You can still see the schedule and the feed. RSVP and check-in open once
            your account is in good standing.
          </p>
        </div>
      )}

      {/* Unpaid fees, with the way to pay them. Renders nothing when there is
          nothing owed, a receipt is already in, or the read fails. */}
      {isApproved && on('fees') && <PaymentBanner player={player} />}

      {/* ── A TOURNAMENT IS ON ────────────────────────────────────
          Full width, above the schedule, so a member standing in the gym
          sees it first at every width. */}
      {liveTournaments.length > 0 && (
        <div className="feed-col home-banners">
          {liveTournaments.map((t) => {
            const running = runningEvents(t);
            const eventIds = running.map((e) => e.id);
            return (
              // A FRAGMENT, NOT A WRAPPER DIV. `.feed-col > * { min-width: 0 }`
              // only reaches DIRECT children, and that rule is the one thing
              // standing between a long exec-typed tournament name and a document
              // that scrolls sideways. A wrapper would absorb it and leave the
              // card itself with the flex default of `min-width: auto`.
              // LiveTournament renders null, so the fragment costs no element.
              <Fragment key={t.id}>
                {/* THE SAME MECHANISM THE TOURNAMENT PAGES USE, not a new one:
                    LiveTournament coalesces at 700ms and calls router.refresh(),
                    which re-runs this server component and re-derives the card
                    from the viewer's own credentials.

                    `draw` IS OMITTED (it defaults false). That is the whole
                    argument in ./active-tournament: this card prints nothing off
                    `tournament_matches`, so a match-level filter would wake the
                    busiest screen in the app on every score to redraw an
                    identical card. What the card DOES show is covered without
                    it — an event going live or completing arrives on
                    `tournament_events` (watched tournament-wide, so an event
                    ADDED mid-tournament is caught too), and a check-in arrives
                    on `tournament_participants` / `tournament_pairs`, which are
                    watched per event id. Since 00120 an entry REMOVED arrives as
                    an UPDATE on `tournament_events`, which the same
                    tournament-wide listener already hears.

                    The channel name is unique per surface, which live-tournament
                    requires: `/tournaments/[id]` holds `player-tournament-${id}`
                    and the event page holds `player-tournament-event-${eventId}`,
                    so this one is prefixed `feed-` to match the app's other feed
                    channel (`feed-matches`). Several of these mount on one socket
                    — @supabase/ssr 0.5.2 caches the browser client in a module
                    singleton (`cachedBrowserClient`), so createClient() returns
                    the same instance to every mount. */}
                <LiveTournament
                  channel={`feed-tournament-${t.id}`}
                  tournamentId={t.id}
                  eventIds={eventIds}
                />
                <ActiveTournamentCard
                  tournamentId={t.id}
                  name={t.name}
                  startDate={t.start_date}
                  todayKey={todayKey}
                  events={running.map(
                    (e): ActiveEntry => ({
                      eventId: e.id,
                      eventType: e.event_type,
                      status: e.status,
                      mine: myEntryIn(e.id),
                      ...checkinWindowOf(e.id, t.id),
                    }),
                  )}
                  // Distinct PEOPLE, not rows: a member in both the singles and
                  // the doubles is one player, and a pair is two. Counted with
                  // the same helper /tournaments counts its hero's field with, so
                  // the two screens cannot print different numbers for the same
                  // tournament. Scoped to the RUNNING events only — somebody
                  // entered in a sibling event that has already finished is not
                  // playing right now.
                  entered={countEnteredPlayers(
                    tournamentEntryRows.filter((r) => eventIds.includes(r.event_id)),
                    tournamentPairRows.filter((r) => eventIds.includes(r.event_id)),
                  )}
                />
              </Fragment>
            );
          })}
        </div>
      )}

      {/* THE SHAPE OF THIS SCREEN. The schedule is the main column and the
          club's activity sits beside it from 1101px up. Below that the DOM
          order is the phone's order: the week strip, then Up next with
          tonight's card and its check-in first, then activity. Nothing
          reorders, so check-in near the top on a phone follows from the
          markup rather than from a media query. */}
      <div className={scheduleOn ? 'home-grid' : 'home-grid is-single'}>
        {scheduleOn && (
          <section className="home-main" aria-label="Schedule">
            <div className="home-week" data-tour="week-strip">
              <WeekStrip days={week} linkedDates={agendaDates} />
            </div>

            {/* Desktop only; the week strip stands in for it on a phone. Above
                Up next so the calendar is the first thing on the page. */}
            <section className="home-month" aria-label="Month calendar" data-tour="month-calendar">
              <MonthCalendar
                months={months}
                initialIndex={initialMonth}
                weekdays={CALENDAR_WEEKDAYS}
                legend={legend}
              />
            </section>

            <section data-tour="up-next">
              <div className="card-head">
                <div>
                  <h2 className="card-title">Up next</h2>
                  <div className="card-sub">{upNextSub ? `${upNextSub}.` : 'Nothing on the calendar.'}</div>
                </div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {/* The month grid is desktop only here; /calendar is the
                      same grid on a page of its own, phones included. */}
                  <Link href="/calendar" className="btn btn-ghost press" style={{ fontSize: 13 }}>
                    Full calendar
                  </Link>
                  {(sessionsOn || eventsOn) && <SubscribeAllButton />}
                </div>
              </div>

              {scheduleError ? (
                // A refused sessions read, said as such. The empty state below
                // would tell a member there is nothing on when there may be
                // twelve open nights.
                <div className="card-base">
                  <div className="empty">
                    <div className="empty-title">We could not load the schedule</div>
                    <div className="empty-hint">Refresh the page to try again.</div>
                  </div>
                </div>
              ) : agenda.length === 0 ? (
                <div className="card-base" style={{ padding: 0 }}>
                  <div className="empty">
                    <div className="empty-icon"><Calendar size={20} /></div>
                    {/* An empty schedule has different causes and a member
                        cannot tell them apart from a blank card, so each says
                        which one it is. */}
                    <div className="empty-title">
                      {!sessionsOn ? 'Nothing coming up' : activeSeason ? 'No sessions yet' : 'No season is running'}
                    </div>
                    <div className="empty-hint">
                      {!sessionsOn
                        ? 'Club events and tournaments show up here when the exec posts them.'
                        : activeSeason
                          ? `Nothing has been posted for ${activeSeason.name} yet. New practices show up here as soon as the exec adds them. Watch announcements.`
                          : 'Sessions appear here once the exec opens a new term. Watch announcements for the start date.'}
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  {agendaSoon.map(renderAgendaDay)}
                  {agendaLater.length > 0 && (
                    // The rest of the term folds away so the list does not bury
                    // the side column and the calendar. DeepLinkScroll opens it
                    // when a /feed?s= link targets a card inside.
                    <details className="home-more">
                      <summary>
                        Show {laterCount} more {laterCount === 1 ? 'date' : 'dates'}
                      </summary>
                      {agendaLater.map(renderAgendaDay)}
                    </details>
                  )}
                </div>
              )}

              {clubEventsError && (
                <p className="home-note">Club events could not be loaded right now.</p>
              )}
              {tournamentsError && (
                <p className="home-note">Tournaments could not be loaded right now.</p>
              )}
            </section>

          </section>
        )}

        <aside className="home-side">
          {/* Renders nothing unless this account has no passkey yet and the
              device supports them, so it self-retires once everyone is
              enrolled. Beside the schedule rather than above it, where it
              pushed tonight's card down. */}
          <PasskeyNudge />

          <ActivityPanel
            sections={sections}
            notice={
              notice
                ? {
                    title: notice.title,
                    body: notice.body,
                    createdAt: notice.created_at,
                    authorName: noticeAuthor?.full_name ?? null,
                  }
                : null
            }
            week={seasonWeekNo}
            showChallengeCta={isApproved && on('challenges')}
            announcementsOn={on('announcements')}
          />

          {/* YOU. Every figure comes off the `ratings` row getViewer() already
              loads, plus the streak. Deliberately not here: ladder position,
              which needs the whole club's get_leaderboard() and returns nothing
              for a member who has set hide_from_leaderboard. */}
          <div className="card-base">
            <div className="wide-cap">You</div>
            <div className="wide-figures">
              {sessionsOn && (
                <div className="stat">
                  <div className="stat-label">Streak</div>
                  <div className="stat-value mono" style={{ fontSize: 24 }}>{streak}</div>
                </div>
              )}
              {played > 0 && (
                <>
                  <div className="stat">
                    <div className="stat-label">Singles</div>
                    <div className="stat-value mono" style={{ fontSize: 24 }}>
                      {rating?.singles_elo ?? 'None'}
                    </div>
                    {/* "Provisional" leads the sub-line, the way /my-stats and
                        the ladder both write it. */}
                    <div className="wide-item-sub" style={{ marginTop: 2 }}>
                      {rating?.singles_provisional ? 'Provisional · ' : ''}
                      {rating?.singles_wins ?? 0}W · {rating?.singles_losses ?? 0}L
                    </div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Doubles</div>
                    <div className="stat-value mono" style={{ fontSize: 24 }}>
                      {rating?.doubles_elo ?? 'None'}
                    </div>
                    <div className="wide-item-sub" style={{ marginTop: 2 }}>
                      {rating?.doubles_provisional ? 'Provisional · ' : ''}
                      {rating?.doubles_wins ?? 0}W · {rating?.doubles_losses ?? 0}L
                    </div>
                  </div>
                </>
              )}
            </div>
            {played === 0 && (
              <p className="wide-note">
                No rated matches yet. Your singles and doubles ratings start level and move the
                first time a result is confirmed.
              </p>
            )}
            {on('my_stats') && (
              <Link href="/my-stats" className="btn btn-ghost btn-sm" style={{ marginTop: 12 }}>
                My stats
              </Link>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
