export const dynamic = 'force-dynamic';
import Link from 'next/link';
import QRCode from 'qrcode';
import { Button, Card, EmptyState, PageHeader } from '@badminton/ui';
import { QrCode } from 'lucide-react';
import {
  CLUB_TIMEZONE,
  clubToday,
  getCheckinWindow,
  parseCheckinSettings,
  scopeToActiveSeason,
  type AttendanceStatus,
  type SessionGroupInput,
  selectAllInChunks,
} from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { PastSeasonNotice, resolveSeasonScope } from '@/components/season-scope';
import { SeasonSelect } from '@/components/season-select';
import { isWaivedFee } from '@/lib/fee-status';
import { CreateSessionForm, SessionCardMenu, AttendanceDialog, CheckinQrDialog } from './actions';
import { SessionTable, type SessionRow } from './session-table';
import { SelectionProvider } from '@/components/selection';
import { BulkSessionActions } from './bulk-session-actions';
import { TonightCheckin, DoorFeed, type DoorFeedEntry } from './tonight';
import { LiveAttendance } from './live-attendance';
import { TurnoutPanel, type TurnoutNight } from './turnout-panel';

// ---------------------------------------------------------------------------
// Formatters. All wall-clock reasoning on this page is club-local: the club is
// in Vancouver, the officer reading it is standing in the gym, and "tonight"
// has to mean tonight there rather than wherever the server happens to be.
// ---------------------------------------------------------------------------

const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const CLOCK_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: CLUB_TIMEZONE,
});

/** 24-hour wall clock from a `TIME` column. The console compares these down a
 *  column, so they are zero-padded and never 12-hour. */
function hhmm(time: string | null): string | null {
  if (!time) return null;
  const [h, m] = time.split(':');
  return `${(h ?? '00').padStart(2, '0')}:${(m ?? '00').padStart(2, '0')}`;
}

/** Club sessions after this hour are "tonight"; anything earlier on the same
 *  date is "today". The club runs weekday evenings, but the schema does not
 *  stop anybody booking a Saturday morning, and calling a 10:00 session
 *  TONIGHT on the screen an officer works the door from is exactly the kind of
 *  wrong this page cannot afford. */
const EVENING_HOUR = 17;

/** Relative day where it helps, absolute otherwise — the mockup's rule. Past
 *  dates never go relative: "3 days ago" is not how anybody refers to a
 *  session they are looking up. */
function dayLabel(date: string, today: string, startTime: string | null): string {
  if (date === today) {
    // No start time means no way to tell a morning session from an evening
    // one, and the club's ordinary case is the evening.
    if (!startTime) return 'Tonight';
    return Number(startTime.slice(0, 2)) >= EVENING_HOUR ? 'Tonight' : 'Today';
  }
  const dayMs = 86400000;
  const diff = Math.round((Date.parse(date) - Date.parse(today)) / dayMs);
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return DAY_FMT.format(new Date(`${date}T00:00:00Z`));
}

function timeLabel(start: string | null, end: string | null): string {
  const s = hhmm(start);
  const e = hhmm(end);
  if (s && e) return `${s}–${e}`;
  if (s) return s;
  return 'Time not set';
}

// toFixed(2), NOT toFixed(0). The door badge is the only surface in the app
// that rounded to the dollar: a $25.50 season fee read "$26" to the officer on
// the door while the member's own /fees screen, /admin/fees and every receipt
// line said $25.50. An officer collecting the badge figure over-charges by
// fifty cents and the ledger disagrees with the till.
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Which week of the term this is. Purely for the header eyebrow, and dropped
 * entirely when it cannot be computed honestly — a season with no start date,
 * or a date before the term began, prints "SCHEDULE" and nothing more rather
 * than "WEEK NAN" or "WEEK 0".
 */
function weekOfSeason(startDate: string | null, today: string): number | null {
  if (!startDate) return null;
  const days = Math.floor((Date.parse(today) - Date.parse(startDate)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.floor(days / 7) + 1;
}

/** Monday of the club week containing `today`, as YYYY-MM-DD. */
function weekStart(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** A stat-strip cell. Bare number over label, and it links to the thing it
 *  counts — there is no per-session route, so these are anchors on this page
 *  rather than invented URLs.
 *
 *  The mono lives on a child span rather than on `.stat-value`. The shipped
 *  rule sets `--display`, and `.stat-strip .stat-value` is two classes deep so
 *  a Tailwind `font-mono` on the same element loses to it — but a direct rule
 *  on a CHILD beats what that child inherits, so this needs no CSS change and
 *  no borrowing of `.is-money`, which means something else. */
function Stat({ label, value, href }: { label: string; value: React.ReactNode; href?: string }) {
  const body = (
    <>
      <p className="stat-label">{label}</p>
      <p className="stat-value">
        <span className="font-mono tracking-[-0.03em]">{value}</span>
      </p>
    </>
  );
  return href ? <Link href={href}>{body}</Link> : <div>{body}</div>;
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;

  // WHO IS LOOKING, asked before anything is read. Middleware already maps
  // /sessions to `sessions.page`, but a page that renders the club's roll —
  // and, for some viewers, what each of them owes — must not depend on
  // middleware having been reached. Same shape as /fees and /legal.
  const viewer = await requireCapability('sessions.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);

  // EVERY CONTROL ON ITS OWN CAPABILITY. Not one `canManage`: the server
  // actions have always re-checked these individually, so a menu built on a
  // single flag offers three controls that bounce to whoever holds the fourth.
  const canCreate = may('sessions.create.write');
  const canMarkAttendance = may('sessions.attendance.write');
  const canIssueToken = may('sessions.checkin.token.write');
  const menuCan = {
    update: may('sessions.update.write'),
    reminders: may('sessions.reminders.write'),
    archive: may('sessions.archive.write'),
    delete: may('sessions.delete.write'),
  };
  // The three bulk controls are the three capabilities, and holding none of them
  // means the checkbox column is never drawn — the same rule /players follows.
  // Which of the three buttons appears is answered again inside the bar; this
  // only decides whether there is anything to select for. `update` belongs here
  // because bulk Edit is on it: leave it out and an officer who may edit a
  // session gets no checkboxes and no bar, with nothing saying why.
  const canBulk = menuCan.update || menuCan.archive || menuCan.delete;
  // What a confirmation calls each night. The name alone is not enough — a club
  // runs "Tuesday Drop-in" every week of the term, so a list of eleven
  // identically-named rows would tell the reader nothing about WHICH eleven.
  const selectableSessions = (list: SessionRow[]) =>
    list.map((r) => ({ id: r.id, label: `${r.name} · ${r.dayLabel} ${r.timeLabel}` }));
  // WHAT A MEMBER OWES IS NOT SESSION DATA. The door feed shows a fee badge
  // beside each person walking in, which means whoever is working the door
  // reads the club's debt list — so it asks for the capability that gates the
  // club-fee roster on /fees, and not for anything in the sessions area.
  //
  // EXEC_BASELINE holds `fees.expenses.read` and NOT `fees.clubfees.read`, so
  // an exec on the door sees no fee badges. That is the intended answer, not an
  // oversight: "may see the expense ledger" was never "may see who has not
  // paid". Unchanged by the baseline narrowing — the expense READ is one of the
  // twelve that survived, and the club-fee read was never reachable below admin
  // except by an explicit grant.
  const showFees = may('fees.clubfees.read');

  const supabase = createAdminClient();
  const today = clubToday();

  // ---- THE QUERY BUDGET ---------------------------------------------------
  // THIS PAGE IS RE-RUN ON EVERY CHECK-IN. Marking somebody present calls
  // router.refresh() (sessions/actions.tsx), and live-attendance.tsx nudges the
  // same refresh on every realtime event, so a 60-person queue re-renders this
  // server component 60 times PER OPEN CONSOLE at the door.
  //
  // Every read below used to be its own `await`, one after the next, so each of
  // those refreshes was eleven serial round trips to Postgres — most of them
  // waiting on a query that needed nothing from the one before it. The reads
  // are now issued in the three groups that genuinely depend on each other:
  // seasons first, then everything keyed on the season, then everything keyed
  // on the sessions it returned. Same queries, same results, a third of the
  // wall clock, and the concurrency is bounded by the group sizes rather than
  // by the roster.
  //
  // ---- seasons ------------------------------------------------------------
  // The season picker is page furniture, not a ledger, and start_date is what
  // the header eyebrow counts weeks from.
  const { data: allSeasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag')
    .order('start_date', { ascending: false });
  const { seasons: seasonList, selected: scopedSeason, isPast } =
    resolveSeasonScope(allSeasons, seasonParam);

  // ---- sessions -----------------------------------------------------------
  // Ascending, because this page is now read forwards: the next few nights
  // first and the term's archive underneath.
  //
  // Sessions with NO season are included deliberately: they are unassigned, not
  // "in another season", and filtering them out would strand them somewhere
  // with no page that lists them. When no season is active at all the filter is
  // skipped entirely — hiding the whole schedule because nobody pressed
  // "activate" is worse than showing too much.
  const { data: sessions } = await scopeToActiveSeason(
    supabase.from('sessions').select('*'),
    scopedSeason?.id,
  ).order('date', { ascending: true });
  type SessionRecord = NonNullable<typeof sessions>[number];
  const sessionIds = (sessions ?? []).map((s) => s.id as string);

  // ---- attendance and RSVPs ----------------------------------------------
  // SCOPED TO THE SESSIONS ON SCREEN. These two reads used to fetch every row
  // in the table with no filter at all, which meant the term's no-show count —
  // and the average this page now prints — were computed over the club's entire
  // history while claiming to describe one season.
  // The embed NAMES ITS CONSTRAINT. session_attendance has two foreign keys to
  // players — player_id and marked_by — so a bare `players(...)` is ambiguous
  // and PostgREST answers 300 Multiple Choices rather than picking one. That
  // failure is invisible from here: supabase-js resolves instead of rejecting,
  // so `data` was null and `?? []` below turned it into "nobody attended". The
  // whole door list, the turnout panel and the checked-in-today stat all read
  // this map, so every one of them silently showed an empty club.
  //
  // SCOPING WAS ONLY HALF OF IT. `sessionIds` is every session in the scoped
  // season, so this read is one-to-many by construction: a full term of sixty
  // nights at forty members is 2,400 rows, and production sets
  // PGRST_DB_MAX_ROWS=1000. PostgREST truncates at that number WITHOUT an
  // error, so the door list, the turnout panel and the term's no-show average
  // were all computed over whichever thousand rows came back first.
  //
  // selectAllInChunks fixes both limits at once and they are genuinely
  // different: chunkIds keeps the `.in()` inside the 8,192-byte request line
  // (a season past 110 sessions would otherwise 414), and the paging inside
  // each chunk is what defeats db-max-rows. selectInChunks alone does only the
  // first, which is why it is not the helper used here.
  // ISSUED TOGETHER. Both are keyed on the same sessionIds and neither reads
  // the other, so awaiting them one after the other spent a whole round trip
  // for nothing — on a page the door re-runs on EVERY check-in (see the note on
  // the query budget above the seasons read).
  const [
    { data: attendanceRows, error: attendanceError },
    { data: rsvpRows },
  ] = await Promise.all([
    selectAllInChunks<{
    session_id: string;
    player_id: string;
    checked_in_at: string | null;
    status: string;
    marked_by: string | null;
    marked_at: string | null;
      players: { full_name: string; avatar_url: string | null } | null;
    }>(sessionIds, (batch, from, to) =>
      supabase
        .from('session_attendance')
        .select(
          'session_id, player_id, checked_in_at, status, marked_by, marked_at, players!session_attendance_player_id_fkey(full_name, avatar_url)',
        )
        .in('session_id', batch)
        // A range request over an unordered result is not a stable window: two
        // pages can overlap or skip rows outright, which would show up here as a
        // member missing from the door list rather than as an error.
        .order('session_id')
        .order('player_id')
        .range(from, to) as never,
    ),
    // Same two limits, same helper — see the note above.
    selectAllInChunks<{
      session_id: string;
      intent: string;
      players: { full_name: string } | null;
    }>(sessionIds, (batch, from, to) =>
      supabase
        .from('session_rsvp')
        .select('session_id, intent, players(full_name)')
        .in('session_id', batch)
        .order('session_id')
        .order('player_id')
        .range(from, to) as never,
    ),
  ]);

  // Deliberately not thrown: a broken read must not take the sessions page down
  // at the door. But it must never be silent again either — the bug above cost
  // a live debugging session precisely because nothing anywhere said "300".
  if (attendanceError) {
    console.error('[sessions] attendance read failed:', attendanceError.message);
  }

  // ---- the walk-in roster -------------------------------------------------
  // ONLY FOR SOMEBODY WHO MAY MARK ATTENDANCE. This list feeds exactly one
  // control — the PlayerPicker inside the attendance dialog — and it was
  // fetched for every viewer the section admitted and handed to a client
  // component, so the club's whole active roster crossed into the RSC payload
  // for a viewer with no way to use it. Same class as the two leaks found on
  // /fees.
  //
  // ISSUED WITH THE TWO BELOW. None of these three reads anything the others
  // produce; they were three serial round trips purely because they were
  // written in the order the page renders them. Declared as promises here and
  // awaited together at the end of the group, which keeps each one next to the
  // note explaining why it is gated the way it is.
  const activePlayersQuery = canMarkAttendance
    ? supabase
        .from('players')
        .select('id, full_name, avatar_url')
        .eq('active_flag', true)
        // 00132. active_flag alone stopped being enough the moment a `players`
        // row could exist before onboarding: a stub is active_flag = TRUE by
        // default, and it would appear in the "add attendee" picker as a
        // nameless row. Marking one present would also file attendance against
        // somebody with no waiver, which is the thing check-in exists to check.
        .or('onboarding_completed.is.true,user_id.is.null')
        .order('full_name')
    : Promise.resolve({ data: [] as { id: string; full_name: string; avatar_url: string | null }[] });

  // ---- QR check-in tokens -------------------------------------------------
  // ONLY FOR SOMEBODY WHO MAY ISSUE ONE. A token is the check-in secret: anyone
  // holding the URL can put it in front of a room. It is also RLS-denied to
  // everybody (00024) precisely so it cannot be read by accident — and this
  // page then read it with the service-role client for every viewer and shipped
  // the URL into a client component. The capability that MINTS a token is the
  // one that may see it.
  const checkinTokensQuery = canIssueToken
    ? supabase.from('session_checkin_tokens').select('session_id, token')
    : Promise.resolve({ data: [] as { session_id: string; token: string }[] });

  // ---- the check-in window ------------------------------------------------
  // session_checkin_open() reads these two tunables out of platform_settings on
  // every call and is the enforcement source of truth; getCheckinWindow mirrors
  // it. Fetched rather than taken from the TypeScript fallback so the line this
  // page prints agrees with the gate the player app will actually hit.
  const checkinSettingQuery = supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'session_attendance')
    .maybeSingle();

  const [{ data: activePlayers }, { data: checkinTokens }, { data: checkinSetting }] =
    await Promise.all([activePlayersQuery, checkinTokensQuery, checkinSettingQuery]);
  const checkinSettings = parseCheckinSettings(checkinSetting?.value ?? null);

  // ------------------------------------------------------------------------
  // Shaping
  // ------------------------------------------------------------------------
  type AttendeeEntry = {
    player_id: string;
    full_name: string;
    avatar_url: string | null;
    checked_in_at: string;
    status: AttendanceStatus;
    marked_by: string | null;
    marked_at: string | null;
  };

  // supabase-js types an embedded one-to-one as either an object or an array
  // depending on how it infers the relationship, so both shapes are unwrapped.
  function embedded<T extends object>(value: unknown): T | null {
    if (Array.isArray(value)) return (value[0] as T) ?? null;
    return (value as T) ?? null;
  }

  const attendanceMap: Record<string, AttendeeEntry[]> = {};
  for (const row of attendanceRows ?? []) {
    const player = embedded<{ full_name: string; avatar_url: string | null }>(row.players);
    const sid = row.session_id as string;
    (attendanceMap[sid] ??= []).push({
      player_id: row.player_id as string,
      full_name: player?.full_name ?? 'Unknown',
      avatar_url: player?.avatar_url ?? null,
      checked_in_at: row.checked_in_at as string,
      status: row.status as AttendanceStatus,
      marked_by: row.marked_by as string | null,
      marked_at: row.marked_at as string | null,
    });
  }

  const rsvpMap: Record<string, { going: string[]; declined: string[] }> = {};
  for (const row of rsvpRows ?? []) {
    const player = embedded<{ full_name: string }>(row.players);
    const sid = row.session_id as string;
    (rsvpMap[sid] ??= { going: [], declined: [] })[row.intent as 'going' | 'declined'].push(
      player?.full_name ?? 'Unknown',
    );
  }

  // Hosts. `sessions.host_player_id` is stamped with whoever CREATED the
  // session (lib/actions/sessions.ts) and there is no control anywhere that
  // reassigns it — updateSession does not write the column. So this column is
  // labelled HOST rather than "DOOR", and there is no "Assign door" button:
  // offering one would imply a write that does not exist. The FK is ON DELETE
  // SET NULL, so "Unassigned" is a state that genuinely occurs.
  const hostIds = [
    ...new Set((sessions ?? []).map((s) => s.host_player_id as string | null).filter(Boolean)),
  ] as string[];
  const { data: hostRows } = hostIds.length
    ? await supabase.from('players').select('id, full_name, avatar_url').in('id', hostIds)
    : { data: [] };
  const hostById = new Map(
    (hostRows ?? []).map((h) => [
      h.id as string,
      { id: h.id as string, name: h.full_name as string, avatarUrl: (h.avatar_url as string | null) ?? null },
    ]),
  );

  // QR images are built here, server-side, so the qrcode library never reaches
  // the client bundle. Only open sessions get one — nothing else can be checked
  // into, so rendering a code for them would just be noise. `checkinTokens` is
  // already empty for a viewer who may not issue them, so this loop produces
  // nothing for them either.
  const playerBaseUrl = process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000';
  const openSessionIds = new Set(
    (sessions ?? []).filter((s) => s.status === 'open').map((s) => s.id as string),
  );
  const qrEntries = await Promise.all(
    (checkinTokens ?? [])
      .filter((row) => openSessionIds.has(row.session_id as string))
      .map(async (row): Promise<[string, { url: string; svg: string }]> => {
        const url = `${playerBaseUrl}/checkin/${row.token}`;
        return [
          row.session_id as string,
          { url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, width: 320 }) },
        ];
      }),
  );
  const qrBySession = Object.fromEntries(qrEntries);

  const upcoming = (sessions ?? []).filter((s) => (s.date as string) >= today);
  const earlier = (sessions ?? []).filter((s) => (s.date as string) < today).reverse();
  const tonightSessions = (sessions ?? []).filter((s) => (s.date as string) === today);

  // ---- the fee lookup behind the door feed --------------------------------
  // Gated on the FETCH, not on the badge. And the payer predicate is the same
  // one /fees uses — active competitive/recreational members who are neither
  // exec nor fee-exempt — because printing "OWES $40" beside an exec at the
  // door would be worse than printing nothing at all.
  //
  // Two whole queries rather than one with a conditional column list: the
  // supabase-js select string is parsed at COMPILE time to type the row, and a
  // ternary yields a union it cannot parse as either branch.
  //
  // All three reads also need a SEASON: a club fee belongs to one, and with no
  // season in scope there is no ledger to be unpaid against. Without that
  // clause the feed would badge every arrival "Unpaid" on the strength of rows
  // that do not exist.
  const feeSeasonId = scopedSeason?.id ?? null;
  const readFees = showFees && feeSeasonId !== null;
  //
  // ISSUED TOGETHER, for the reason given in the query-budget note at the top:
  // all three are gated on the same `readFees` and none reads the others, so
  // three serial round trips bought nothing. They are still written as three
  // ternaries because of the compile-time select parsing described just above.
  const [{ data: feeSeason }, { data: payers }, { data: feeRows }] = await Promise.all([
    readFees
      ? supabase
          .from('seasons')
          .select('competitive_fee_cents, recreational_fee_cents')
          .eq('id', feeSeasonId)
          .maybeSingle()
      : Promise.resolve({
          data: null as { competitive_fee_cents: number; recreational_fee_cents: number } | null,
        }),
    readFees
      ? supabase
          .from('players')
          .select('id, status')
          .in('status', ['competitive', 'recreational'])
          .eq('is_exec', false)
          .eq('fee_exempt', false)
          // Guests (00292) owe no dues: they are entered in one event, not members.
          .eq('is_guest', false)
      : Promise.resolve({ data: [] as { id: string; status: string }[] }),
    readFees
      ? supabase
          .from('club_fees')
          .select('player_id, paid_at, method')
          .eq('season_id', feeSeasonId)
          // Dues only (00094). The door badge answers "has this member paid for
          // the term", and feeByPlayer keys on player_id — an entry fee in the
          // same table would answer in a season fee's place.
          .eq('fee_type', 'dues')
      : Promise.resolve({ data: [] as { player_id: string | null; paid_at: string | null; method: string | null }[] }),
  ]);
  const payerStatus = new Map((payers ?? []).map((p) => [p.id as string, p.status as string]));
  const feeByPlayer = new Map(
    (feeRows ?? []).filter((f) => f.player_id != null).map((f) => [f.player_id as string, f]),
  );

  function feeFor(playerId: string): DoorFeedEntry['fee'] {
    const status = payerStatus.get(playerId);
    // Not on the fee roster at all. Nothing is owed, so nothing is said — which
    // is a different thing from the badge being withheld.
    if (!status) return null;
    const fee = feeByPlayer.get(playerId);
    if (isWaivedFee(fee)) return { state: 'waived' };
    if (fee?.paid_at) return { state: 'paid' };
    const cents =
      status === 'competitive'
        ? (feeSeason?.competitive_fee_cents as number | null)
        : (feeSeason?.recreational_fee_cents as number | null);
    // No price on the season means no amount to name. Still outstanding, just
    // said without a figure rather than with a made-up one.
    return { state: 'owes', amount: cents == null ? undefined : money(cents) };
  }

  // ---- tonight ------------------------------------------------------------
  // A `session_attendance` row is not the same thing as somebody turning up:
  // 'no_show' and 'excused' are marks an officer puts on the roll for people
  // who did NOT come (00008). Counting rows would have made the no-show column
  // and the turnout column count the same people twice, and put a no-show in a
  // feed titled "just scanned in".
  const arrived = (a: AttendeeEntry) => a.status === 'checked_in' || a.status === 'present';
  const countArrived = (sessionId: string) => (attendanceMap[sessionId] ?? []).filter(arrived).length;

  const tonightAttendees = tonightSessions
    .flatMap((s) => attendanceMap[s.id as string] ?? [])
    .filter(arrived);
  const tonightSignedUp = tonightSessions.reduce(
    (n, s) => n + (rsvpMap[s.id as string]?.going.length ?? 0),
    0,
  );
  const doorFeed: DoorFeedEntry[] = [...tonightAttendees]
    .sort((a, b) => Date.parse(b.checked_in_at) - Date.parse(a.checked_in_at))
    .slice(0, 12)
    .map((a) => ({
      playerId: a.player_id,
      name: a.full_name,
      avatarUrl: a.avatar_url,
      timeLabel: CLOCK_FMT.format(new Date(a.checked_in_at)),
      // 'checked_in' is the self-scan status the QR route writes (00008);
      // anything else was put there by an officer.
      viaQr: a.status === 'checked_in',
      fee: readFees ? feeFor(a.player_id) : null,
    }));

  // "DOORS CLOSE IN 42 MIN", from the same window the RLS gate enforces. The
  // first OPEN session tonight with a start time wins — the club runs one night
  // at a time, a session with no time has no window to describe, and
  // session_checkin_open() refuses a closed session outright, so quoting a
  // window for one would describe a door the player app has already shut.
  // "Tonight" only when everything on today's schedule is actually an evening.
  // ONE NIGHT AT A TIME IS AN ASSUMPTION, not a constraint: `sessions` permits
  // two rows on one date, in which case this card sums both counts and the door
  // line below describes the first open one. That is the club's shape today and
  // the honest reading of the mockup's single "TONIGHT" card.
  const todayIsEvening = tonightSessions.every(
    (s) => !s.start_time || Number((s.start_time as string).slice(0, 2)) >= EVENING_HOUR,
  );
  const tonightHeading = todayIsEvening ? 'Tonight · Check-in' : 'Today · Check-in';

  const windowSession = tonightSessions.find((s) => s.start_time && s.status === 'open');
  let doorLine: string | null = null;
  if (!windowSession && tonightSessions.some((s) => s.status !== 'open')) {
    doorLine = 'Doors closed';
  }
  if (windowSession) {
    const { opensAt, closesAt } = getCheckinWindow(
      {
        date: windowSession.date as string,
        start_time: windowSession.start_time as string | null,
        end_time: windowSession.end_time as string | null,
        status: windowSession.status as string,
      },
      checkinSettings,
    );
    const now = Date.now();
    const mins = (t: number) => Math.max(0, Math.round((t - now) / 60000));
    if (opensAt && now < opensAt.getTime()) doorLine = `Doors open in ${mins(opensAt.getTime())} min`;
    else if (now < closesAt.getTime()) doorLine = `Doors close in ${mins(closesAt.getTime())} min`;
    else doorLine = 'Doors closed';
  }

  // ---- the stat strip -----------------------------------------------------
  // FOUR CELLS, NOT FIVE. "COURTS BOOKED" is dropped outright: `sessions` has
  // no court column and nothing else in the schema counts courts, so the number
  // could only have been invented. Everything below is a count of rows this
  // page has already read.
  const thisWeekStart = weekStart(today);
  const thisWeekCount = (sessions ?? []).filter((s) => {
    const d = s.date as string;
    return d >= thisWeekStart && Date.parse(d) - Date.parse(thisWeekStart) < 7 * 86400000;
  }).length;
  const checkedInTonight = tonightAttendees.length;
  // The average is over nights that actually happened. A session nobody
  // attended — one that was cancelled on the day, or never had its roll taken —
  // would otherwise drag the mean down while describing nothing.
  const playedSessions = earlier.filter((s) => countArrived(s.id as string) > 0);
  const avgAttendance = playedSessions.length
    ? Math.round(
        playedSessions.reduce((n, s) => n + countArrived(s.id as string), 0) / playedSessions.length,
      )
    : null;
  const noShows = (attendanceRows ?? []).filter((r) => r.status === 'no_show').length;

  // ---- the turnout series -------------------------------------------------
  // FOLDED FROM ROWS ALREADY ON THE PAGE, and costing no query: `sessions` and
  // `attendanceMap` are both fetched above under `sessions.page` for the table
  // and the stat strip. The panel takes every session in scope and decides for
  // itself which are drawable — a night that has not happened yet and a night
  // with no roll taken are excluded for different reasons and it says which.
  //
  // Every status is passed through, not just the arrivals: the second bucket is
  // "marked and did not come", so the panel needs the whole roll to have a
  // denominator at all.
  const turnoutNights: TurnoutNight[] = (sessions ?? []).map((s) => ({
    id: s.id as string,
    date: s.date as string,
    track: (s.track as string | null) ?? null,
    statuses: (attendanceMap[s.id as string] ?? []).map((a) => a.status),
  }));

  const week = weekOfSeason(scopedSeason?.start_date ?? null, today);
  const eyebrow = week ? `Schedule · Week ${week}` : 'Schedule';

  /** One row's worth of controls, each on its own capability. */
  function rowActions(session: SessionRecord, isTonight: boolean) {
    const id = session.id as string;
    const qr = qrBySession[id];
    return (
      <>
        <AttendanceDialog
          sessionId={id}
          attendees={attendanceMap[id] ?? []}
          players={activePlayers ?? []}
          canWrite={canMarkAttendance}
          variant={isTonight ? 'secondary' : 'ghost'}
          label={isTonight ? 'Open door list' : 'Door list'}
        />
        {session.status === 'open' &&
          (canIssueToken ? (
            <CheckinQrDialog sessionId={id} url={qr?.url ?? null} svg={qr?.svg ?? null} />
          ) : (
            // THE BUTTON THAT USED TO NOT EXIST. `sessions.checkin.token.write`
            // is not in EXEC_BASELINE, and CheckinQrDialog is the ONLY caller of
            // getOrCreateSessionCheckinToken — so an exec without it cannot
            // cause a session's code to exist, and until now discovered that as
            // an absence: no button, no message, nothing to search for. Two of
            // the five execs on production are in exactly that state.
            //
            // A disabled control instead. It occupies the same place in the row
            // as the real one, so the officer sees that a thing belongs here and
            // is told what to ask for, rather than concluding at 19:00 with
            // thirty people queueing that the feature was removed.
            //
            // DELIBERATELY NOT A WIDENING OF THE BASELINE. Making it work would
            // mean putting a write into a list the club owner defined as
            // "read everything, write nothing" (access-level.ts:456,
            // 00105_console_access_capability.sql:54), and the floor sits under
            // every composed exec — so it would also hand the QR to Finance,
            // Internal and External, none of whom run the door. The fix for the
            // two affected people is a grant on /permissions.
            <Button variant="ghost" disabled className="cursor-not-allowed"
              title="Generating a check-in code needs the sessions.checkin.token.write permission. An admin can grant it on the Permissions page.">
              <QrCode className="w-3.5 h-3.5" />
              <span>Check-in QR</span>
            </Button>
          ))}
        <SessionCardMenu
          session={{
            id,
            name: session.name as string | null,
            date: session.date as string,
            start_time: session.start_time as string | null,
            end_time: session.end_time as string | null,
            location: session.location as string,
            notes: session.notes as string | null,
            status: session.status as string,
            track: session.track as SessionGroupInput,
            // From the same select('*') as the rest; simply absent until
            // migration 00116 is applied, which the dialog reads as false.
            require_scan_to_check_in: session.require_scan_to_check_in as boolean | null | undefined,
          }}
          can={menuCan}
        />
      </>
    );
  }

  function toRow(session: SessionRecord): SessionRow {
    const id = session.id as string;
    const date = session.date as string;
    return {
      id,
      name: (session.name as string | null) || 'Untitled session',
      dayLabel: dayLabel(date, today, session.start_time as string | null),
      timeLabel: timeLabel(session.start_time as string | null, session.end_time as string | null),
      venue: session.location as string,
      signedUp: rsvpMap[id]?.going.length ?? 0,
      checkedIn: countArrived(id),
      host: hostById.get(session.host_player_id as string) ?? null,
      closed: session.status !== 'open',
      actions: rowActions(session, date === today),
    };
  }

  const upcomingRows = upcoming.map(toRow);
  const earlierRows = earlier.map(toRow);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={eyebrow}
        title="Sessions"
        sub="Who is on the door, who is turning up."
        watermark="S"
        actions={canCreate ? <CreateSessionForm /> : undefined}
      />

      <div className="space-y-2">
        <SeasonSelect seasons={seasonList} selected={scopedSeason} basePath="/sessions" />
        {isPast && scopedSeason && <PastSeasonNotice season={scopedSeason} />}
      </div>

      {/* Bare number/label pairs, hairline above and below, no card chrome —
          the console's stat strip. Each cell links to the block it counts;
          there is no per-session route to link to, so these are anchors. */}
      <div className="stat-strip">
        <Stat label="This week" value={thisWeekCount} href="#upcoming" />
        {/* "Today" rather than the mockup's "TONIGHT": this counts every
            session on today's date, and the club is free to book a morning. */}
        <Stat label="Checked in today" value={checkedInTonight} href="#tonight" />
        <Stat label="Avg attendance" value={avgAttendance ?? '—'} href="#earlier" />
        <Stat label="No-shows · term" value={noShows} href="#earlier" />
      </div>

      {/* Directly under the strip, and full width. Two of the four cells above
          are a mean and a term total, and this is the shape behind both — a
          reader who has just seen "AVG 15" is exactly the reader asking whether
          it is fifteen every week or twenty falling to ten. Full width because
          ten ticks with a weekday under each do not fit in the door column. */}
      <TurnoutPanel
        nights={turnoutNights}
        today={today}
        seasonName={scopedSeason?.name ?? null}
      />

      <div className="grid gap-5 items-start lg:grid-cols-[2fr_1fr]">
        {/* Left: the schedule. */}
        <div className="space-y-5">
          {/* The anchor sits on a wrapper rather than on the Card: Card takes
              children/className/padding and nothing else, and packages/ui is
              not this change's to widen. */}
          {/* ONE PROVIDER PER TABLE, so the two selections are separate. They
              are two different decisions — closing the nights still to come is
              not the same act as tidying the ones already played — and a single
              selection spanning both would let one Close reach across the
              boundary the page draws between them. `visibleIds` is the whole
              list because this table has no client-side filter: everything it
              holds is on screen. */}
          <div id="upcoming" className="scroll-mt-6" data-tour="sessions-upcoming">
            <SelectionProvider
              items={selectableSessions(upcomingRows)}
              visibleIds={upcomingRows.map((r) => r.id)}
            >
            <Card padding={false}>
              {upcomingRows.length > 0 ? (
                <SessionTable
                  rows={upcomingRows}
                  heading="Upcoming"
                  count={`Next ${upcomingRows.length} session${upcomingRows.length === 1 ? '' : 's'}`}
                  selectable={canBulk}
                />
              ) : (
                <div className="p-6">
                  <EmptyState
                    title="Nothing scheduled"
                    description={
                      canCreate
                        ? 'No sessions on or after today in this season. Create one from the button above.'
                        : 'No sessions on or after today in this season.'
                    }
                  />
                </div>
              )}
            </Card>
            {canBulk && (
              <BulkSessionActions canEdit={menuCan.update} canArchive={menuCan.archive} canDelete={menuCan.delete} />
            )}
            </SelectionProvider>
          </div>

          {/* The term's archive stays on the page. Marking a no-show after the
              fact, or fixing one, is ordinary work and this is the only route
              in the console that can open a past session's door list — slicing
              the page down to the next few nights would have taken that away
              without saying so. */}
          {earlierRows.length > 0 && (
            <div id="earlier" className="scroll-mt-6">
              <SelectionProvider
                items={selectableSessions(earlierRows)}
                visibleIds={earlierRows.map((r) => r.id)}
              >
              <Card padding={false}>
                <SessionTable
                  rows={earlierRows}
                  heading="Earlier this season"
                  count={`${earlierRows.length} session${earlierRows.length === 1 ? '' : 's'}`}
                  selectable={canBulk}
                />
              </Card>
              {canBulk && (
                <BulkSessionActions canEdit={menuCan.update} canArchive={menuCan.archive} canDelete={menuCan.delete} />
              )}
              </SelectionProvider>
            </div>
          )}
        </div>

        {/* Right: the door. */}
        <div className="space-y-5">
          {/* Renders nothing. It subscribes to tonight's attendance rows and
              re-runs this component when one moves, so the count above, the
              feed below, every row's checked-in figure and the turnout panel
              all re-derive together from the one read rather than drifting
              apart. Scoped to today's sessions — an exec is watching tonight's
              door, not the season's. Inert until 00112 is applied. */}
          <LiveAttendance sessionIds={tonightSessions.map((s) => s.id as string)} />

          <div id="tonight" className="scroll-mt-6" data-tour="door-tonight">
            <Card padding={false}>
              <TonightCheckin
                heading={tonightHeading}
                sessionName={
                  tonightSessions.length
                    ? tonightSessions
                        .map((s) => (s.name as string | null) || 'Untitled session')
                        .join(' · ')
                    : null
                }
                checkedIn={checkedInTonight}
                signedUp={tonightSignedUp}
                doorLine={doorLine}
              />
            </Card>
          </div>

          <Card padding={false}>
            <DoorFeed entries={doorFeed} showFees={showFees} />
          </Card>
        </div>
      </div>
    </div>
  );
}
