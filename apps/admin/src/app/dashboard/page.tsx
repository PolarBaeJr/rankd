export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, atLeast, canAccess, effectiveCapabilities, permissionsOf, permits, sectionLabelFor } from '@/lib/permissions';
import { AvatarChip, Badge, Card, EmptyState, PageHeader, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import {
  ACTIVE_CHALLENGE_STATUSES,
  CLUB_TIMEZONE,
  EVENT_TYPE_LABELS,
  formatRelativeTime,
  getCheckinWindow,
  getMissingLegalDocuments,
  parseCheckinSettings,
  readFeatureFlags,
  wallClockToUtc,
} from '@badminton/shared';
import Link from 'next/link';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { PlayerActions } from '../players/player-actions';
import { adminNavItemOn, openableSections } from '@/components/nav-sections';
import { getSeasonFinances } from '@/lib/season-finance';
import { getDashboardFinances } from '@/lib/dashboard-finance';
import { getOutstandingClubFees } from '@/lib/fees-outstanding';
import { clubWeek } from '@/lib/club-week';
import { ActionLink } from './action-link';
import { money } from '@/components/charts';
import {
  ClubFeePanel,
  ExpensePanel,
  NetPositionPanel,
  OtherIncomePanel,
} from '@/components/dashboard/finance-panels';
import { getLadderSpread } from '@/lib/dashboard-ladder';
import { LadderPanel } from '@/components/dashboard/ladder-panel';
import type { PlayerEditRow } from '@/lib/player-edit-row';

/** A club-local wall clock reading of an instant — "19:00", never "02:00Z". */
const clubTime = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: CLUB_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

/** "MON" — the day somebody joined, read in the club's timezone, not the server's. */
const clubWeekday = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: CLUB_TIMEZONE, weekday: 'short' })
    .format(new Date(iso))
    .toUpperCase();

/** "3 Aug" — short enough for a micro-line, still club-local. */
const clubDay = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: CLUB_TIMEZONE, day: 'numeric', month: 'short' })
    .format(new Date(iso));

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

// Section heading inside a card. The console's cards carry a small uppercase
// display label, never an <h1> — PageHeader owns the only one on the page.
const SECTION = 'font-[family-name:var(--display)] text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]';
const MICRO = 'font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]';
const TH = 'px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]';
const TD = 'px-4 py-3 align-middle';

// Only needed to give the "no matches for you" branch of the fetch below a type
// to agree with — the admin client carries no generated Database type, so the
// real query's rows are untyped.
type MatchPlayer = { id: string; full_name: string; avatar_url: string | null };
// supabase-js types an embedded one-to-one as EITHER an object or an array
// depending on how it inferred the relationship, and for this select it infers
// the array. Both shapes are admitted here and normalised once, in describeMatch.
type MatchParticipant = {
  team_side: string;
  player?: MatchPlayer | MatchPlayer[] | null;
};
type DashboardMatch = {
  id: string;
  score_summary: string | null;
  result_status: string;
  match_type: string;
  event_type: string;
  created_at: string;
  match_participants?: MatchParticipant[] | null;
};

// The two columns that separate somebody waiting on an APPROVAL from somebody
// who signed in and never finished setup (00132). Its own type for the same
// reason as the rest here: the not-an-approver branch has to agree with the real
// one and there is no row to infer from.
type PendingApprovalFlags = {
  id: string;
  user_id: string | null;
  onboarding_completed: boolean | null;
};

// Same job for the pending-approvals query: it only needs a type so the
// not-an-approver branch agrees with the real one.
type PendingPlayer = PlayerEditRow & {
  full_name: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
  role: string;
  is_exec: boolean;
  is_trainer: boolean;
};

type Acceptance = { document: string; version: string; accepted_at: string };
type Joiner = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  joined_at: string;
  waiver_reset_at: string | null;
  waiver_acceptances?: Acceptance[] | null;
};

type TonightSession = {
  id: string;
  name: string | null;
  location: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  status: string;
};

export default async function DashboardPage({
  searchParams,
}: {
  // `?denied=` is set by the middleware when a console user asks for a section
  // they cannot open. Saying so once, here, is the difference between "the app
  // is broken" and "that part isn't yours" — a silent bounce reads as the first.
  searchParams?: Promise<{ denied?: string }>;
}) {
  const params = (await searchParams) ?? {};
  // Sanitised, never echoed. It is a URL anyone can type, so it is matched
  // against the console's own route map and discarded if it names nothing —
  // rendering it raw would put attacker-chosen text on the page.
  const deniedLabel = sectionLabelFor(params.denied);
  const supabase = createAdminClient();

  // ------------------------------------------------------------------------
  // WHO IS LOOKING, AND WHAT THEY MAY SEE
  //
  // THE DASHBOARD IS THE ONE SCREEN THAT AGGREGATES EVERY OTHER AREA, which
  // makes it the easiest place in the console to leak: every panel here is a
  // slice of a section that enforces its own gate, and a figure withheld on
  // /fees is still withheld when it is a stat cell.
  //
  // So every flag below asks for the capability that owns the DATA, not for
  // `isAdmin` and not for one blanket "can see the dashboard" flag, and every
  // flag gates a FETCH rather than a piece of markup. A hidden panel whose
  // query still ran has already shipped its rows into the RSC payload, where
  // anybody with devtools can read them — that is how four live leaks were
  // found across /fees, /sessions and /players, every one of them an
  // unconditional fetch feeding a conditional render.
  // ------------------------------------------------------------------------
  const [viewer, features] = await Promise.all([
    getAuthenticatedConsoleUser(),
    readFeatureFlags(supabase),
  ]);
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const held = effectiveCapabilities(level, permissions);

  // Sections. `canAccess` asks the same question the sidebar and the middleware
  // ask, through the same helper, so a panel here can never link somewhere that
  // bounces to /unauthorized. There is no `matches.read`, `sessions.read` or
  // `disputes.read` in the vocabulary — those areas have a page key and nothing
  // finer — so the page key IS the capability that owns their data.
  const showMatches = canAccess(level, permissions, '/matches');
  //
  // A club feature that is switched off loses its panels too, through the same
  // flags, so its fetches, its signposts and hasTiles below all move together,
  // unless the viewer holds its `page.access.<id>` key, exactly as in the nav.
  // Its page stays reachable by URL and says it is off.
  const showSessions = canAccess(level, permissions, '/sessions') && adminNavItemOn('/sessions', features, held);
  const showDisputes = canAccess(level, permissions, '/disputes');
  const showWalkovers = canAccess(level, permissions, '/walkovers');
  const showTournaments = canAccess(level, permissions, '/tournaments') && adminNavItemOn('/tournaments', features, held);
  const showChallenges = canAccess(level, permissions, '/challenges') && adminNavItemOn('/challenges', features, held);

  // NOT canAccess(…, '/players') — a COUNT of the members is roster data, and
  // the roster has its own capability. Reaching /players needs players.page,
  // which somebody may hold in order to add a member without browsing the club;
  // handing them the size of it would be the same leak, one figure at a time.
  const canReadRoster = permits(level, permissions, 'players.read');
  // Deciding a pending signup is exec work, and this gates a FETCH: anybody who
  // kept the panel without it would be handed the pending list and a dialog
  // whose every Save throws.
  const canApprove = permits(level, permissions, 'players.approve.write');
  // 00132. Owns the permission-review clause in the alert band and nothing else
  // on this page. Same capability the /permissions editor and the review's own
  // Restore control ask for, so the band never points somebody at a queue they
  // cannot clear.
  const canSetConsoleAccess = permits(level, permissions, 'players.consoleaccess.write');

  // NOT canAccess(level, …, '/fees'). Reaching /fees needs `fees.page`, which
  // buys the SECTION and no ledger in it — an exec holds it, and so does
  // anybody handed nothing but the ability to file an expense.
  const showFinances = permits(level, permissions, 'fees.netposition.read');
  // The club-fee ledger, which is what "fees outstanding" is a reading of, and
  // which also decides whether the season's PRICE LIST is selected at all —
  // see the season query below.
  const showClubFees = permits(level, permissions, 'fees.clubfees.read');
  // The ledgers underneath, one capability each. Each gates its own fetch
  // inside getDashboardFinances(), and each draws a chart of ITS OWN BOOK and
  // no other: somebody holding one of these must not be able to reconstruct a
  // figure from the ones they were not given, or the dashboard becomes a way
  // around /fees.
  const showExpenses = permits(level, permissions, 'fees.expenses.read');
  const showOtherIncome = permits(level, permissions, 'fees.otherincome.read');
  // An affordance rather than data: it opens /fees, where the form lives and
  // the action re-checks. Nothing is fetched for it.
  const canAddExpense = permits(level, permissions, 'fees.expenses.add.write');

  // DOES ANY PANEL ON THIS PAGE RENDER AT ALL?
  //
  // Somebody narrowed to the Finance role holds fees.page, fees.expenses.read
  // and fees.expenses.add.write, and not one flag above asks for any of them:
  // she signed in, landed here because this is where sign-in lands, and got a
  // header and nothing else. Being narrowed looked identical to the app being
  // broken.
  //
  // EVERYTHING IN THE NARROWED LANDING RENDERS ONLY WHEN THIS IS FALSE,
  // deliberately. An unrestricted exec holds fees.expenses.read — it is one of
  // the thirteen capabilities in EXEC_BASELINE — so a tile gated on the
  // capability alone would appear for every exec and admin in the club. There
  // is no capability that separates the Finance role from an ordinary exec
  // inside the fees area, and since 2026-09-19 there is LESS than none:
  // ROLE_DEFAULTS.finance is now exactly the floor's three fees capabilities,
  // the add write included, so the Finance role adds nothing an exec did not
  // already have. That makes the second condition the only one available: "no
  // panel of the ordinary dashboard is yours". It is a pure function of
  // level and permissions, decided before the first query, and no unrestricted
  // level can reach it.
  //
  // EVERY GATE THAT DRAWS A PANEL BELOW MUST BE IN THIS LIST, in both
  // directions: one missing here and a narrowed person gets the signpost AND a
  // panel; one left here after its panel is deleted and they get hasTiles with
  // nothing to show, which is the blank screen this branch exists to prevent.
  // The hand write-down in lib/__tests__/dashboard-landing.test.ts pins it.
  const hasTiles =
    canReadRoster || canApprove || showDisputes || showWalkovers || showMatches
    || showSessions || showTournaments || showChallenges || showFinances || showClubFees;

  // WHICH FEE CAPABILITIES CAN ACTUALLY REACH THE NARROWED LANDING, and it is
  // not all four. `fees.clubfees.read` and `fees.netposition.read` are both
  // terms of hasTiles above, so anybody holding either lands on the ORDINARY
  // dashboard by construction and their charts belong there — the dues panel
  // and the net-position panel are in the right rail. The two that survive into
  // the narrowed branch are the expense ledger (the Finance role's whole claim
  // on the money area) and other income.
  //
  // The old narrowed landing had a "Club fees" tile behind showClubFees, which
  // for this reason could never render: hasTiles was already true for anyone
  // who would have seen it.

  // Where such a person CAN go. Derived from the nav list through the same
  // canAccess() the sidebar and the middleware use, so a section added later
  // signposts itself with no list here to keep.
  const openSections = hasTiles
    ? []
    : openableSections(level, permissions).filter(
        (item) => item.href !== '/dashboard' && adminNavItemOn(item.href, features, held),
      );

  // ------------------------------------------------------------------------
  // THE SEASON, AND THE ONE COLUMN PAIR THAT IS NOT FURNITURE
  //
  // The name is page furniture — it is in the header eyebrow, it is on
  // /sessions for anybody who reaches that section, and the player app prints
  // it publicly. The two fee columns are NOT: they are the club's price list,
  // and a sibling agent found /fees shipping them to anybody who could read the
  // expense ledger. So the column list itself is chosen by the gate, and a
  // viewer without fees.clubfees.read never has the prices in their payload at
  // all — not hidden, absent.
  // ------------------------------------------------------------------------
  const { data: season } = await supabase
    .from('seasons')
    .select(showClubFees ? 'id, name, competitive_fee_cents, recreational_fee_cents' : 'id, name')
    .eq('active_flag', true)
    .maybeSingle<{
      id: string;
      name: string;
      competitive_fee_cents?: number;
      recreational_fee_cents?: number;
    }>();

  const week = clubWeek();
  // The club-local midnight that opens this week, as the UTC instant a
  // TIMESTAMPTZ comparison needs. `joined_at` is an instant, `week.start` is a
  // club calendar day, and wallClockToUtc is the repo's existing bridge between
  // the two (it is what the check-in window is built from). Doing this with
  // `new Date(week.start)` would parse the string as UTC midnight and count
  // Sunday evening's joiners into the wrong week for eight months of the year.
  const [wy, wm, wd] = week.start.split('-').map(Number) as [number, number, number];
  const weekStartInstant = wallClockToUtc(wy, wm, wd, 0, 0).toISOString();

  // Gate the FETCHES, not just the panels.
  const noCount = Promise.resolve({ count: null as number | null });
  const noRows = <T,>() => Promise.resolve({ data: null as T[] | null });

  const [
    { count: totalMembers },
    { count: activeMembers },
    { data: pendingApprovalFlags },
    { count: openDisputes },
    { count: pendingWalkovers },
    { count: sessionsThisWeek },
    { count: matchesLogged },
    { count: unsettledMatches },
    { count: activeTournaments },
    { count: activeChallenges },
    { data: pendingPlayersList },
    { data: unconfirmedMatches },
    { data: joiners },
    { data: legalDocs },
  ] = await Promise.all([
    // ---- players.read ----------------------------------------------------
    canReadRoster
      ? supabase.from('players').select('id', { count: 'exact', head: true }).neq('status', 'pending_approval')
      : noCount,
    canReadRoster
      ? supabase.from('players').select('id', { count: 'exact', head: true }).neq('status', 'pending_approval').eq('active_flag', true)
      : noCount,

    // ---- players.approve.write -------------------------------------------
    // Approving is exec work, so the COUNT of people waiting on a decision is
    // exec work too. It used to ride on the roster flag, which is trainer
    // level, so a trainer saw how many decisions they cannot make.
    //
    // 00132 CHANGED THE SHAPE OF THIS QUERY, not just its filter. A stub created
    // at first sign-in is 'pending_approval' too, but nobody is waiting on an
    // exec's decision about it — the member has not finished setup, and there is
    // nothing here for an approver to do. Counting them would put a number in
    // "Needs you" that the Approve button cannot reduce. They have their own
    // queue on /players?tab=incomplete.
    //
    // Excluding them needs BOTH user_id and onboarding_completed (a pre-added
    // roster row is `user_id IS NULL, onboarding_completed = false` and DOES
    // belong here; only `user_id IS NOT NULL, onboarding_completed = false` is a
    // stub), and no single-column predicate separates the two. That would mean
    // an `.or()` — and an `.or()` on a `head: true` count is the exact
    // combination that silently returned 0 on this self-hosted PostgREST and
    // made "Needs Attention" show 0 while listing pending players. So this
    // fetches the two columns and counts in JS instead. The set is the approval
    // queue, which an exec is expected to keep near empty; the limit is there so
    // a neglected one cannot become an unbounded read.
    canApprove
      ? supabase
          .from('players')
          .select('id, user_id, onboarding_completed')
          .eq('status', 'pending_approval')
          .limit(500)
      : noRows<PendingApprovalFlags>(),

    // ---- disputes.page / walkovers.page ----------------------------------
    showDisputes
      ? supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open')
      : noCount,
    showWalkovers
      ? supabase.from('walkovers').select('id', { count: 'exact', head: true }).eq('status', 'pending')
      : noCount,

    // ---- sessions.page ---------------------------------------------------
    // Between two club-local calendar days, compared as strings against a DATE
    // column, so no timezone enters the query. See lib/club-week.ts.
    showSessions
      ? supabase.from('sessions').select('id', { count: 'exact', head: true }).gte('date', week.start).lte('date', week.end)
      : noCount,

    // ---- matches.page ----------------------------------------------------
    // Scoped to the active season when there is one: the page is framed as a
    // term ("CONSOLE · SPRING 2026") and a lifetime total under a term heading
    // is a figure that answers a question nobody asked.
    showMatches
      ? (season
          ? supabase.from('matches').select('id', { count: 'exact', head: true }).eq('result_status', 'confirmed').eq('season_id', season.id)
          : supabase.from('matches').select('id', { count: 'exact', head: true }).eq('result_status', 'confirmed'))
      : noCount,

    // How many results are actually unsettled, which is NOT the length of the
    // capped list of rows below — the card header prints the total and the
    // table shows the six most recent of it.
    //
    // DELIBERATELY NOT SEASON-SCOPED, unlike the count above it. "Matches
    // logged" is a term figure in a term-framed strip; a result nobody has
    // agreed on is work waiting on an officer no matter which term it was
    // played in, and scoping it would hide the oldest and most stuck rows —
    // precisely the ones somebody needs to see.
    showMatches
      ? supabase.from('matches').select('id', { count: 'exact', head: true }).in('result_status', ['pending_confirmation', 'disputed'])
      : noCount,

    // ---- tournaments.page / challenges.page ------------------------------
    //
    // SEASON-SCOPED, and it follows "matches logged" above rather than
    // "unsettled results" below. The distinction the two comments draw is
    // between a TERM FIGURE and a BACKLOG, and "in play" is the first: it is a
    // present-tense claim, made under a heading that names the term, on a strip
    // whose next card says "FALL 2026 · NET POSITION". An `active` tournament
    // left over from Summer made that card read "there is a tournament running
    // right now" on the first day of a new season, which was simply not true —
    // it was a test event nobody closed.
    //
    // Nothing is hidden by this. A stale `active` row is still first in the
    // list on /tournaments, which this number links to, and that page is where
    // somebody goes to close it. The dashboard's job here is to answer "is
    // anything on court this term", not to keep score of unfinished admin.
    showTournaments
      ? (season
          ? supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('status', 'active').eq('season_id', season.id)
          : supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('status', 'active'))
      : noCount,
    showChallenges
      ? supabase.from('challenges').select('id', { count: 'exact', head: true }).in('status', [...ACTIVE_CHALLENGE_STATUSES])
      : noCount,

    // ---- the pending-signup rows -----------------------------------------
    canApprove
      ? supabase
          .from('players')
          // The flag columns are here for the Edit dialog, which reads them to
          // seed its controls — it would otherwise open showing "None" for an
          // exec's console access and offer to take it away.
          .select('id, full_name, email, avatar_url, created_at, status, active_flag, role, is_exec, is_trainer, fee_exempt, membership_type')
          .eq('status', 'pending_approval')
          // Same exclusion as the count above (00132), and it must be the same
          // or the header prints one number over a list of another. Safe as an
          // `.or()` here because this is a LIST query — the shape that returned
          // 0 silently on this PostgREST was `.or()` on a `head: true` count.
          .or('onboarding_completed.is.true,user_id.is.null')
          .order('created_at', { ascending: false })
          .limit(6)
      : noRows<PendingPlayer>(),

    // ---- the unconfirmed-match rows --------------------------------------
    // Participant names and avatars come with the match because they ARE the
    // match — /matches shows the same names under the same capability. This is
    // not a roster read: it is bounded by the rows on screen and reaches no
    // member who is not in one of them.
    showMatches
      ? supabase
          .from('matches')
          .select('id, score_summary, result_status, match_type, event_type, created_at, match_participants(team_side, player:players(id, full_name, avatar_url))')
          .in('result_status', ['pending_confirmation', 'disputed'])
          .order('created_at', { ascending: false })
          .limit(6)
      : noRows<DashboardMatch>(),

    // ---- this week's joiners ---------------------------------------------
    canReadRoster
      ? supabase
          .from('players')
          .select('id, full_name, avatar_url, joined_at, waiver_reset_at, waiver_acceptances(document, version, accepted_at)')
          .neq('status', 'pending_approval')
          .gte('joined_at', weekStartInstant)
          .order('joined_at', { ascending: false })
          .limit(6)
      : noRows<Joiner>(),

    // The current document versions the waiver badges are measured against.
    // Nothing outside those badges reads them, so there is no round trip when
    // there is no joiner list.
    canReadRoster
      ? supabase.from('legal_documents').select('document, version, reacceptance_required_since')
      : noRows<{ document: string; version: string; reacceptance_required_since: string | null }>(),
  ]);

  // ---- players.read, again ------------------------------------------------
  // ------------------------------------------------------------------------
  // ONE ROUND OF FETCHES, NOT SEVEN
  //
  // Every figure below answers to the season and to the viewer's capabilities,
  // and both of those were settled before any of it ran. None of these queries
  // was ever waiting on another's ANSWER - each was only waiting on the `await`
  // written above it, which is a different thing and was costing a serial round
  // trip apiece on the one page every officer lands on first.
  //
  // The single ordering that is real is the check-in pair further down: it
  // needs tonight's session id, so it stays behind in a round of its own.
  //
  // The gates are unchanged. Each clause still fetches only for the capability
  // that owns the figure it feeds, and a viewer without it still gets no row in
  // their payload rather than a hidden card.
  // ------------------------------------------------------------------------
  const [
    ladder,
    { count: privilegeReviews },
    { data: nextSession },
    outstandingCents,
    finances,
    ledgers,
  ] = await Promise.all([
    // The ladder's shape. Same capability as the roster counts above and the
    // same rule: the gate is the fetch, so a viewer without players.read has no
    // ratings in their payload at all rather than a hidden card. Being a helper
    // rather than a query builder is no reason to serialise it - it returns a
    // promise like everything else here.
    canReadRoster ? getLadderSpread(supabase) : null,

    // Permission reviews left by a roster claim. A COUNT QUERY OF ITS OWN, and
    // small: the partial index players_privilege_claim_review_idx (00132) covers
    // exactly this predicate, and the answer is 0 on almost every load.
    //
    // Gated on players.consoleaccess.write rather than on the roster read,
    // matching the rule the rest of this band follows - every clause is gated on
    // the capability that owns the figure in it, or the band leaks the counts the
    // panels hide, one sentence at a time. Restoring a review sets a console
    // level, so that is the capability that owns this number.
    canSetConsoleAccess
      ? supabase
          .from('players')
          .select('id', { count: 'exact', head: true })
          .not('privilege_claim_review', 'is', null)
      : { count: 0 },

    // TONIGHT - one query, two answers.
    //
    // The next session on or after today. When its date IS today it is tonight's
    // session; when it is not, there is no session tonight and this is the next
    // one, which is the thing an officer wanted to know instead. Asking twice
    // would be two round trips for one line of text.
    showSessions
      ? supabase
          .from('sessions')
          .select('id, name, location, date, start_time, end_time, status')
          .gte('date', week.today)
          .order('date', { ascending: true })
          .order('start_time', { ascending: true, nullsFirst: false })
          .limit(1)
          .maybeSingle<TonightSession>()
      : { data: null },

    // Fees outstanding - an AMOUNT, and the only figure on this page assembled
    // from two tables. The arithmetic lives in lib/fees-outstanding.ts with a
    // test on it rather than here; see the note in that file.
    showClubFees && season && season.competitive_fee_cents != null && season.recreational_fee_cents != null
      ? getOutstandingClubFees(supabase, {
          id: season.id,
          competitive_fee_cents: season.competitive_fee_cents,
          recreational_fee_cents: season.recreational_fee_cents,
        })
      : null,

    // Finance snapshot for the active season: money in, money out, and the net.
    // The net is the headline because it is the question the club owner actually
    // asks; income alone reads like good news no matter what has been spent.
    //
    // Every ledger, via the shared helper. Income used to be summed inline from
    // club_fees only, so recorded reinstatement and tournament money read as
    // $0.00 - and it was wrong here AND on /fees because each page did its own
    // arithmetic. Net is computed in exactly one place for the same reason.
    showFinances && season ? getSeasonFinances(supabase, { id: season.id }) : null,

    // The per-ledger charts' rows: one query per ledger this person may read AND
    // will actually be shown, and none at all for the rest, decided inside
    // getDashboardFinances.
    //
    // `&& !hasTiles` on two of the three is not a second permission check - it is
    // WHERE THE PANEL IS DRAWN. The expense and other-income panels belong to the
    // narrowed landing, so fetching their rows for an admin whose dashboard is
    // full of panels would be a query nobody renders and a ledger in the payload
    // for no reason. The dues panel is the mirror image: showClubFees is a term of
    // hasTiles, so its panel is an ordinary-dashboard panel and its fetch is
    // conditioned on the capability alone.
    //
    // The season goes in rather than being looked up again in there - it was
    // fetched above for the header eyebrow before either branch of this page
    // decided anything, so re-selecting it was a round trip for a row already in
    // hand. `null` (no active term) still means no ledgers and no figures.
    getDashboardFinances(
      supabase,
      season && { id: season.id, name: season.name },
      {
        // NOT `&& !hasTiles`. These two used to be, which wired both ledger
        // charts to the narrowed landing only - so the people most likely to
        // want them, the officers who can see everything, were the one group
        // that never got them. The owner spotted it: Money out rendered for a
        // finance-scoped exec and vanished for an admin.
        //
        // The capability is the whole gate. Whether the viewer also has tiles
        // says nothing about whether they may see the club's books.
        expenses: showExpenses,
        clubFees: showClubFees,
        otherIncome: showOtherIncome,
      },
    ),
  ]);

  const seasonIncomeCents = finances?.income.totalCents ?? 0;
  const seasonExpenseCents = finances?.expenseCents ?? 0;
  const seasonNetCents = finances?.netCents ?? 0;
  const seasonSfuRecCents = finances?.income.collectedBySfuRecCents ?? 0;

  // 00132. The same predicate /players uses for its Needs Attention tab, so the
  // band and the queue it links to can never disagree about how many people are
  // actually waiting on a decision.
  const pendingPlayers = (pendingApprovalFlags ?? []).filter(
    (p) => p.user_id === null || p.onboarding_completed === true,
  ).length;

  const isTonight = Boolean(nextSession && nextSession.date === week.today);

  // session_checkin_open() reads these two tunables out of platform_settings on
  // every call and is the enforcement source of truth; getCheckinWindow mirrors
  // it. Fetched rather than taken from the TypeScript fallback so the DOORS
  // line agrees with the gate the player app will actually hit - the fallback
  // is a guess, and platform_settings is admin-editable.
  const [{ data: checkinSetting }, { count: checkedIn }] = await Promise.all([
    isTonight
      ? supabase.from('platform_settings').select('value').eq('key', 'session_attendance').maybeSingle()
      : Promise.resolve({ data: null as { value: unknown } | null }),
    // 'checked_in' and 'present' are both in the room; 'no_show' and 'excused'
    // are not. A bare row count would print the no-shows as attendance.
    isTonight && nextSession
      ? supabase
          .from('session_attendance')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', nextSession.id)
          .in('status', ['checked_in', 'present'])
      : noCount,
  ]);

  const doorsAt =
    isTonight && nextSession
      ? getCheckinWindow(nextSession, parseCheckinSettings(checkinSetting?.value ?? null)).opensAt
      : null;

  // ------------------------------------------------------------------------
  // SHAPING
  // ------------------------------------------------------------------------
  const joinerRows = (joiners ?? []).map((player) => {
    const acceptances = (player.waiver_acceptances ?? []) as Acceptance[];
    // The same predicate the roster uses, through the same shared helper, so a
    // member cannot read "No waiver" here and "Good standing" on /players.
    const waiverCurrent =
      (legalDocs?.length ?? 0) > 0 &&
      getMissingLegalDocuments(legalDocs ?? [], acceptances, new Date(), player.waiver_reset_at).length === 0;
    // The version and the date they signed it. Both were already fetched for
    // the badge above and were unreachable anywhere in the console — an officer
    // asked "which waiver did they sign, and when" and had nowhere to look.
    // Free here, so it is shown here.
    const waiver = acceptances
      .filter((a) => a.document === 'waiver')
      .sort((a, b) => b.accepted_at.localeCompare(a.accepted_at))[0];
    return { player, waiverCurrent, waiver };
  });

  const joinersWithoutWaiver = joinerRows.filter((r) => !r.waiverCurrent).length;

  // ------------------------------------------------------------------------
  // THE ALERT BAND
  //
  // Every clause is omitted individually at zero, and every clause is gated on
  // the capability that owns the figure in it — an ungated clause would leak
  // the counts the panels hide, one sentence at a time. The band itself is not
  // rendered when there is nothing in it: a "0 pending · 0 open" band is a
  // warning nobody can act on, and the guidelines forbid it outright.
  //
  // The waiver clause is scoped to THIS WEEK'S JOINERS and says so. A club-wide
  // unsigned count would be a full roster scan with nested acceptances for one
  // sentence, and that scan is not worth a line of text.
  // ------------------------------------------------------------------------
  const alertTerms = [
    // FIRST, ahead of the approval queue, and that ordering is the whole point
    // of adding it here rather than leaving it as a tab badge. This is a member
    // who has LOST or been refused console access without asking for it — the
    // failure that went unnoticed for a day because nothing said it out loud —
    // and it is rarer and more consequential than an approval. It also decides
    // where Review goes, below.
    canSetConsoleAccess && (privilegeReviews ?? 0) > 0
      ? `${privilegeReviews} permission ${plural(privilegeReviews!, 'review')} from a roster claim`
      : null,
    canApprove && pendingPlayers > 0
      ? `${pendingPlayers} pending ${plural(pendingPlayers, 'approval')}`
      : null,
    showDisputes && (openDisputes ?? 0) > 0
      ? `${openDisputes} open ${plural(openDisputes!, 'dispute')}`
      : null,
    showWalkovers && (pendingWalkovers ?? 0) > 0
      ? `${pendingWalkovers} pending ${plural(pendingWalkovers!, 'walkover')}`
      : null,
    canReadRoster && joinersWithoutWaiver > 0
      ? `${joinersWithoutWaiver} new ${plural(joinersWithoutWaiver, 'member')} without a waiver`
      : null,
  ].filter(Boolean) as string[];

  // Where Review goes. Always a door this person can open, in the order the
  // clauses are written, so the button never lands on /unauthorized. The
  // /players fallback is the waiver clause's own door and is only reached when
  // that clause is the band's only one — and it required players.read, which
  // the resolver cannot grant without players.page.
  const reviewHref = canSetConsoleAccess && (privilegeReviews ?? 0) > 0
    ? '/players?tab=permissions'
    : canApprove && pendingPlayers > 0
    ? '/players?tab=attention'
    : showDisputes && (openDisputes ?? 0) > 0
      ? '/disputes'
      : showWalkovers && (pendingWalkovers ?? 0) > 0
        ? '/walkovers'
        : '/players';

  // ONE PRIMARY ACTION, and only if this person can actually perform it. A red
  // button is the loudest thing on the screen; pointing it at a section that
  // will refuse the viewer is worse than having no button. Each destination is
  // the section that owns the control, and each capability implies that
  // section's page key (the resolver prunes anything whose area page is
  // missing), so none of these can 404 into /unauthorized.
  //
  // GATED ON hasTiles, and that is the load-bearing part. The narrowed landing
  // has its own single call to action, so this one has to belong to the
  // ordinary dashboard or there are two accents on one screen — and the club's
  // rule is that a second red button means one of them is wrong.
  //
  // Excluding fees.expenses.add.write from the pick order is NOT enough on its
  // own, which is exactly the trap the page/read split sets. `players.create
  // .write` needs `players.page`; hasTiles asks for `players.read`. A
  // hand-picked set of players.page + players.create.write + fees.page +
  // fees.expenses.add.write, with no read anywhere, therefore lands on the
  // narrowed landing AND would have drawn "Add a member" in red above it.
  const primaryAction = !hasTiles
    ? null
    : permits(level, permissions, 'matches.create.write')
      ? { href: '/matches', label: 'Log a match' }
      : permits(level, permissions, 'sessions.create.write')
        ? { href: '/sessions', label: 'New session' }
        : permits(level, permissions, 'players.create.write')
          ? { href: '/players', label: 'Add a member' }
          : null;

  const eyebrow = season ? `Console · ${season.name}` : 'Console';

  // Panels, decided before the grid so an empty column collapses rather than
  // leaving a 2fr gap beside a lone card.
  //
  // EVERY TERM HERE MUST ALWAYS DRAW SOMETHING. These are the same flags
  // hasTiles is built from, so a term that can render nothing on a quiet day —
  // a card gated on its data arriving rather than on the capability — would
  // give a narrowed viewer hasTiles and a blank screen, which is the exact
  // state the narrowed landing exists to prevent. That is why the approvals,
  // results, tonight, joiners and net-position cards each render their own
  // empty state instead of disappearing.
  const hasLeft = canApprove || showMatches;
  // showClubFees joins this list because the dues panel is now a card in the
  // rail rather than only a cell in the strip. It was already a term of
  // hasTiles, so nothing about who lands where has moved.
  const hasRight =
    showSessions || canReadRoster || showTournaments || showChallenges || showFinances
    || showClubFees;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={eyebrow}
        title="Dashboard"
        sub="Everything waiting on an officer today."
        watermark="D"
        actions={
          primaryAction ? (
            <ActionLink href={primaryAction.href}>{primaryAction.label}</ActionLink>
          ) : undefined
        }
      />

      {/* WHY YOU LANDED HERE. The middleware sends a console user who asked for
          a section they cannot open to this page rather than to /unauthorized —
          they belong in the console, just not in that part of it. Saying so once
          is what stops a narrowed officer concluding their account is broken.
          A red mark, not a warning band: the refusal itself is worth noticing,
          but nothing is broken and the surface stays neutral. role=status
          because the eyebrow that used to carry this meaning is gone and the
          icon is decorative — without it a screen reader gets the sentence with
          no signal that it is a refusal. */}
      {deniedLabel && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-danger)]" aria-hidden />
          <span className="text-sm text-[var(--text-secondary)]">
            “{deniedLabel}” is not part of your access, so you are on the dashboard instead.
          </span>
        </div>
      )}

      {/* THE ALERT BAND. One bordered row, warning tones over a 6% wash —
          color-mix rather than a `/6` opacity modifier, because Tailwind v3
          silently drops `/opacity` on a var() arbitrary colour and compiles the
          wash to nothing at all. */}
      {alertTerms.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border border-[color-mix(in_oklab,var(--color-warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_6%,transparent)] px-4 py-3">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-warning)]">
            Needs you
          </span>
          <p className="min-w-[12rem] flex-1 text-sm text-[var(--color-warning)]">
            {alertTerms.join(' · ')}
          </p>
          <ActionLink href={reviewHref} variant="ghost">Review</ActionLink>
        </div>
      )}

      {/* THE STAT STRIP. Bare number/label pairs, hairline above, below and
          between — `.stat-strip` in globals.css, the same strip /fees and
          /players use. Every cell links to the section it counts, and a cell
          the viewer may not see is OMITTED rather than zeroed: a hollow figure
          that bounces to /unauthorized is worse than no figure. The strip is
          grid-auto-flow:column, so the survivors simply widen. */}
      {(canReadRoster || showSessions || showClubFees || showMatches) && (
        <div className="stat-strip">
          {canReadRoster && (
            <Link href="/players" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Members</p>
              <p className="stat-value">{totalMembers ?? 0}</p>
            </Link>
          )}
          {/* NOT "active this term". `active_flag` is the club's own active
              marker on the roster row; nothing in the schema records activity
              against a TERM, and a count derived from this season's attendance
              would be sessions-area data behind a roster capability. The label
              says what the column means. */}
          {canReadRoster && (
            <Link href="/players" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Active roster</p>
              <p className="stat-value">{activeMembers ?? 0}</p>
            </Link>
          )}
          {showSessions && (
            <Link href="/sessions" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Sessions this week</p>
              <p className="stat-value">{sessionsThisWeek ?? 0}</p>
            </Link>
          )}
          {/* Rendered for the capability, not for the figure. A null here means
              there is no active season to collect for, which is a real answer
              and gets an em dash — dropping the cell instead would leave the
              strip empty for somebody whose only capability is this one, and an
              empty strip is two hairlines with nothing between them. */}
          {showClubFees && (
            <Link href="/fees" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Fees outstanding</p>
              <p className={`stat-value is-money ${(outstandingCents ?? 0) > 0 ? 'text-[var(--color-warning)]' : ''}`}>
                {outstandingCents === null ? '—' : <Atomic>{money(outstandingCents)}</Atomic>}
              </p>
            </Link>
          )}
          {showMatches && (
            <Link href="/matches" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Matches logged</p>
              <p className="stat-value">{matchesLogged ?? 0}</p>
            </Link>
          )}
        </div>
      )}

      {(hasLeft || hasRight) && (
        <div
          className={`grid grid-cols-1 items-start gap-5 ${
            hasLeft && hasRight ? 'lg:grid-cols-[2fr_1fr]' : ''
          }`}
        >
          {/* ---------------------------------------------------------------
              LEFT — the work queue
              --------------------------------------------------------------- */}
          {hasLeft && (
            <div className="space-y-5">
              {/* PENDING APPROVALS — the signups an officer decides. Rendered
                  even when the list is empty, with an EmptyState rather than
                  nothing: "there is nobody waiting" and "this is not yours to
                  see" are different states, and a panel that vanishes on a
                  quiet day makes the second unreadable. */}
              {canApprove && (
                <div data-tour="pending-approvals">
                <Card padding={false}>
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>Pending approvals</h2>
                    <span className={MICRO}>
                      {/* The TRUE total, not the length of the capped list
                          below it. The table shows the six most recent; a
                          header reading "6 waiting" when twelve people are
                          would be a figure that quietly contradicts /players. */}
                      {pendingPlayers} waiting
                    </span>
                  </div>
                  {pendingPlayersList && pendingPlayersList.length > 0 ? (
                    <ResponsiveTable
                      cards={pendingPlayersList.map((player) => (
                        <TableCard
                          key={player.id}
                          title={
                            <Link href={`/players/${player.id}`} className="flex items-center gap-2 hover:text-[var(--color-accent)]">
                              <AvatarChip src={player.avatar_url} name={player.full_name} size="sm" id={player.id} />
                              {player.full_name}
                            </Link>
                          }
                          fields={[
                            { label: 'Email', value: player.email, wide: true },
                            { label: 'Submitted', value: formatRelativeTime(player.created_at) },
                          ]}
                          actions={
                            <PlayerActions
                              mode="edit"
                              playerId={player.id}
                              playerName={player.full_name}
                              playerData={player}
                              isAdmin={atLeast(level, 'admin')}
                              canApprove={canApprove}
                            />
                          }
                        />
                      ))}
                    >
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-[var(--border)]">
                            <th className={TH}>Member</th>
                            <th className={TH}>Submitted</th>
                            <th className={`${TH} text-right`}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pendingPlayersList.map((player) => (
                            <tr key={player.id} className="border-t border-[var(--border)] first:border-t-0">
                              <td className={TD}>
                                {/* A SIBLING of the Edit button, never wrapped
                                    around it: a <button> inside an <a> is
                                    unreachable by keyboard and is read as one
                                    control by a screen reader. */}
                                <Link href={`/players/${player.id}`} className="flex min-w-0 items-center gap-3 hover:text-[var(--color-accent)]">
                                  <AvatarChip src={player.avatar_url} name={player.full_name} size="sm" id={player.id} />
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm text-[var(--text-primary)]">{player.full_name}</span>
                                    <span className={`block truncate ${MICRO}`}>{player.email}</span>
                                  </span>
                                </Link>
                              </td>
                              <td className={`${TD} font-mono text-xs text-[var(--text-muted)]`}>
                                {formatRelativeTime(player.created_at)}
                              </td>
                              {/* 44px floor on the row-action slot — officers
                                  tap these holding a phone and a clipboard. */}
                              <td className={`${TD} text-right [&_button]:min-h-[44px] [&_button]:min-w-[44px]`}>
                                <div className="flex justify-end">
                                  <PlayerActions
                                    mode="edit"
                                    playerId={player.id}
                                    playerName={player.full_name}
                                    playerData={player}
                                    isAdmin={atLeast(level, 'admin')}
                                    canApprove={canApprove}
                                  />
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ResponsiveTable>
                  ) : (
                    <div className="px-4">
                      <EmptyState title="Nobody is waiting" description="Every signup has been decided." />
                    </div>
                  )}
                </Card>
                </div>
              )}

              {/* AWAITING CONFIRMATION — results the club has not agreed on
                  yet. NOT called "approvals": there is no admin action that
                  confirms a match. Confirmation is the opponent's, in the
                  player app, and lib/actions/matches.ts has void and convert
                  and nothing that says yes. So the row offers Open and no
                  Approve button — a control whose action does not exist is
                  worse than an omitted one. */}
              {showMatches && (
                <Card padding={false}>
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>Awaiting confirmation</h2>
                    <span className={MICRO}>{unsettledMatches ?? 0} waiting</span>
                  </div>
                  {unconfirmedMatches && unconfirmedMatches.length > 0 ? (
                    <ResponsiveTable
                      cards={unconfirmedMatches.map((match) => {
                        const m = describeMatch(match);
                        return (
                          <TableCard
                            key={match.id}
                            title={
                              <span className="flex items-center gap-2">
                                {m.lead && (
                                  <AvatarChip src={m.lead.avatar_url} name={m.lead.full_name} size="sm" id={m.lead.id} />
                                )}
                                {m.title}
                              </span>
                            }
                            value={<Atomic separator=",">{match.score_summary ?? '—'}</Atomic>}
                            badges={match.result_status === 'disputed' ? <Badge variant="danger">Dispute</Badge> : undefined}
                            fields={[
                              { label: 'Kind', value: m.kind },
                              { label: 'Submitted', value: formatRelativeTime(match.created_at) },
                            ]}
                            actions={
                              <ActionLink href={match.result_status === 'disputed' && showDisputes ? '/disputes' : '/matches'} variant="ghost">
                                Open
                              </ActionLink>
                            }
                          />
                        );
                      })}
                    >
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-[var(--border)]">
                            <th className={TH}>Match</th>
                            <th className={TH}>Score</th>
                            <th className={TH}>Submitted</th>
                            <th className={`${TH} text-right`}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unconfirmedMatches.map((match) => {
                            const m = describeMatch(match);
                            return (
                              <tr key={match.id} className="border-t border-[var(--border)] first:border-t-0">
                                <td className={TD}>
                                  <div className="flex min-w-0 items-center gap-3">
                                    {m.lead && (
                                      <AvatarChip src={m.lead.avatar_url} name={m.lead.full_name} size="sm" id={m.lead.id} />
                                    )}
                                    <div className="min-w-0">
                                      <p className="truncate text-sm text-[var(--text-primary)]">{m.title}</p>
                                      <p className={`truncate ${MICRO}`}>{m.kind}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className={`${TD} font-mono text-sm text-[var(--text-primary)]`}>
                                  <Atomic separator=",">{match.score_summary ?? '—'}</Atomic>
                                </td>
                                <td className={`${TD} font-mono text-xs text-[var(--text-muted)]`}>
                                  {formatRelativeTime(match.created_at)}
                                </td>
                                <td className={`${TD} text-right`}>
                                  <div className="flex items-center justify-end gap-2">
                                    {match.result_status === 'disputed' && <Badge variant="danger">Dispute</Badge>}
                                    <ActionLink href={match.result_status === 'disputed' && showDisputes ? '/disputes' : '/matches'} variant="ghost">
                                      Open
                                    </ActionLink>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </ResponsiveTable>
                  ) : (
                    <div className="px-4">
                      <EmptyState title="Every result is settled" description="No match is waiting on a confirmation." />
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------------
              RIGHT — tonight, and the term at a glance
              --------------------------------------------------------------- */}
          {hasRight && (
            <div className="space-y-5">
              {/* TONIGHT.
                  NO DENOMINATOR, NO METER, NO "SPOTS LEFT". The mockup showed
                  "CHECKED IN OF 36", a twelve-block capacity meter and
                  "6 SPOTS LEFT". `sessions` has no capacity column, no waitlist
                  table and no court column — the only `court` in the schema is
                  on tournament_matches, and `session_caps` in platform_settings
                  is the cap on RATED MATCHES PER PLAYER per session, not a door
                  capacity. There is nothing to divide by, and a denominator
                  computed from RSVPs or from the roster would be the same
                  invention with more steps. The bare count is the true figure,
                  so the bare count is what is shown. */}
              {showSessions && (
                <Card padding={false}>
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>
                      {isTonight && nextSession
                        ? `Tonight · ${nextSession.location}`
                        : 'Next session'}
                    </h2>
                  </div>
                  <div className="px-4 py-4">
                    {isTonight && nextSession ? (
                      <>
                        <div className="flex items-end gap-3">
                          <span className="font-mono text-[40px] font-bold leading-none tracking-tight text-[var(--text-primary)]">
                            {checkedIn ?? 0}
                          </span>
                          <span className={`${MICRO} mb-1`}>Checked in</span>
                        </div>
                        <p className={`mt-4 ${MICRO}`}>
                          {[
                            doorsAt ? `Doors ${clubTime(doorsAt)}` : null,
                            nextSession.status === 'open' ? 'Check-in open' : 'Session closed',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </>
                    ) : nextSession ? (
                      <div className="space-y-1">
                        <p className="text-sm text-[var(--text-primary)]">No session tonight.</p>
                        <p className={MICRO}>
                          Next · {clubWeekday(`${nextSession.date}T12:00:00Z`)} {clubDay(`${nextSession.date}T12:00:00Z`)} · {nextSession.location}
                        </p>
                      </div>
                    ) : (
                      // A plain line rather than EmptyState: this card is one
                      // column of a 1fr track, and EmptyState's illustration
                      // block is taller than the card it would sit in.
                      <p className="text-sm text-[var(--text-muted)]">No session is on the calendar.</p>
                    )}
                  </div>
                </Card>
              )}

              {/* NEW THIS WEEK. The waiver VERSION and the date it was signed
                  sit under the badge: both were already fetched to compute the
                  badge, and a sibling found they had become unreachable
                  anywhere in the console. */}
              {canReadRoster && (
                <Card padding={false}>
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>New this week</h2>
                  </div>
                  {joinerRows.length > 0 ? (
                    <div className="divide-y divide-[var(--border)]">
                      {joinerRows.map(({ player, waiverCurrent, waiver }) => (
                        <div key={player.id} className="flex items-center justify-between gap-3 px-4 py-3">
                          <Link href={`/players/${player.id}`} className="flex min-w-0 items-center gap-3 hover:text-[var(--color-accent)]">
                            <AvatarChip src={player.avatar_url} name={player.full_name} size="sm" id={player.id} />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-[var(--text-primary)]">{player.full_name}</span>
                              <span className={`block truncate ${MICRO}`}>
                                Joined {clubWeekday(player.joined_at)}
                                {waiverCurrent && waiver ? ` · ${waiver.version} · ${clubDay(waiver.accepted_at)}` : ''}
                              </span>
                            </span>
                          </Link>
                          <Badge variant={waiverCurrent ? 'success' : 'warning'}>
                            {waiverCurrent ? 'Waiver ok' : 'No waiver'}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="px-4 py-4 text-sm text-[var(--text-muted)]">
                      No member has joined this week.
                    </p>
                  )}
                </Card>
              )}

              {/* IN PLAY. Two counts that each belong to their own section, so
                  each row is gated separately and the card is omitted when
                  neither is the viewer's. */}
              {(showTournaments || showChallenges) && (
                <Card padding={false}>
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>In play</h2>
                  </div>
                  <div className="divide-y divide-[var(--border)]">
                    {showTournaments && (
                      <Link href="/tournaments" className="flex items-baseline justify-between px-4 py-3 hover:bg-[var(--surface-2)] transition-colors">
                        <span className={MICRO}>Tournaments</span>
                        <span className="font-mono text-2xl font-bold leading-none text-[var(--text-primary)]">
                          {activeTournaments ?? 0}
                        </span>
                      </Link>
                    )}
                    {showChallenges && (
                      <Link href="/challenges" className="flex items-baseline justify-between px-4 py-3 hover:bg-[var(--surface-2)] transition-colors">
                        <span className={MICRO}>Challenges</span>
                        <span className="font-mono text-2xl font-bold leading-none text-[var(--text-primary)]">
                          {activeChallenges ?? 0}
                        </span>
                      </Link>
                    )}
                  </div>
                </Card>
              )}

              {/* NET POSITION. In, out, and whether the club is in the
                  positives — the question the club owner actually asks; income
                  alone reads like good news no matter what has been spent. The
                  two figures under the headline are now BARS on a shared scale
                  as well as numbers, which is the whole difference between
                  "$155.00 in · $564.00 out" and seeing at a glance that the
                  term is running at a loss.
                  Rendered for the capability rather than for the season, so
                  somebody whose only panel this is cannot be handed a blank
                  page in the gap between two terms. */}
              {showFinances && (
                <NetPositionPanel
                  season={season && { id: season.id, name: season.name }}
                  incomeCents={seasonIncomeCents}
                  expenseCents={seasonExpenseCents}
                  netCents={seasonNetCents}
                  collectedBySfuRecCents={seasonSfuRecCents}
                />
              )}

              {/* SEASON DUES — collected against still owed, on one scale.
                  Behind fees.clubfees.read, which is the capability that owns
                  BOTH halves: the collected figure is that ledger summed, and
                  the outstanding figure is the season's price list against the
                  members who have not paid. Neither is fetched without it.
                  Dues only, never split by fee_type — entry money and
                  reinstatements are separate capabilities' books. */}
              {showClubFees && (
                <ClubFeePanel
                  season={season && { id: season.id, name: season.name }}
                  collectedCents={ledgers?.clubFees?.total ?? null}
                  sfuRecCents={ledgers?.clubFees?.collectedBySfuRec ?? 0}
                  outstandingCents={outstandingCents}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* THE LADDER'S SHAPE. Full width rather than in the rail: a distribution
          is read across, and fourteen bins in a 1fr column are three pixels
          each. Behind players.read, which is in TRAINER_BASELINE — so this is
          the one chart on the page every console user sees. */}
      {ladder && <LadderPanel spread={ladder} />}

      {/* THE NARROWED LANDING. Every panel above belongs to a capability this
          person does not hold, so rather than a header over an empty page they
          get CHARTS OF THE BOOKS THEY MAY SEE, the one thing they may file, and
          — as a footer, not as the page — the doors that will actually open.
          It used to be that signpost and nothing else, under the heading
          "Nothing here needs you", which was the club owner's complaint: the
          finance exec can see the club's entire spend, and the screen she lands
          on told her there was nothing for her.

          Each panel is present only because its own read was held and its own
          query ran. A null ledger here means nothing was fetched, not that a
          card was hidden. */}
      {!hasTiles && (
        <div className="space-y-5">
          {/* One column at a time: these panels carry a chart each, and a chart
              320 units wide squeezed into a third of a laptop is a texture. Two
              across on a wide screen, stacked on a phone. */}
          {ledgers && (ledgers.expenses || ledgers.otherIncome) && (
            <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
              {ledgers.expenses && (
                <ExpensePanel season={ledgers.season} expenses={ledgers.expenses} />
              )}
              {ledgers.otherIncome && (
                <OtherIncomePanel season={ledgers.season} ledger={ledgers.otherIncome} />
              )}
            </div>
          )}

          {/* NO SEASON, BUT STILL A LEDGER READ. getDashboardFinances returns
              null between terms because every book is keyed by season_id, and a
              person whose only panel is a ledger chart would otherwise get the
              signpost alone again — the exact screen this branch replaced. Said
              in words instead, and it is the same sentence the net-position and
              dues panels give for the same state. */}
          {!ledgers && (showExpenses || showOtherIncome) && (
            <Card>
              <p className="text-sm text-[var(--text-muted)]">
                No season is active, so there is nothing to add up yet. The club&apos;s books
                are kept per term, and this fills in as soon as one is running.
              </p>
            </Card>
          )}

          {/* Offered on the write alone, with no season and no ledger behind
              it: somebody may be able to file an expense and to see none, which
              is the state /fees was reshaped to support. */}
          {canAddExpense && (
            <Link href="/fees?tab=expenses" className="group block">
              <Card className="flex flex-wrap items-center justify-between gap-4 transition-colors hover:border-[var(--border-hover)]">
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">Paid for something out of pocket?</p>
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                    File it against the season so the club has a record of the spend and can pay you back.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                  Add an expense <ArrowUpRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
              </Card>
            </Link>
          )}

          {/* THE SIGNPOST, DEMOTED TO A FOOTER.
              Still derived from the nav list through the same canAccess() the
              sidebar and the middleware use. It keeps EmptyState's full voice
              only when it is the whole page — somebody granted nothing but
              /settings has no chart and no ledger, and for them "there is
              nothing here" IS the honest answer. Above a chart it would
              contradict the chart, so it becomes a hairline row of doors. */}
          {openSections.length > 0 &&
            (ledgers || canAddExpense ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-[var(--border)] pt-5">
                <span className={MICRO}>Also open to you</span>
                {openSections.map(({ href, label, icon: Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    className="inline-flex min-h-[44px] items-center gap-2 border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                ))}
              </div>
            ) : (
              <Card>
                <EmptyState
                  title="Nothing here needs you"
                  description="Your console access covers part of the club's work. These are the sections you can open."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      {openSections.map(({ href, label, icon: Icon }) => (
                        <Link
                          key={href}
                          href={href}
                          className="inline-flex min-h-[44px] items-center gap-2 border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
                        >
                          <Icon className="h-4 w-4" />
                          {label}
                        </Link>
                      ))}
                    </div>
                  }
                />
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Marcus Ng vs Kiera Watanabe" over "SINGLES · RATED CHALLENGE", plus the
 * member whose avatar leads the row.
 *
 * The embedded player arrives as an object or a one-element array depending on
 * how supabase-js inferred the relationship, so it is normalised here rather
 * than at four call sites.
 */
function describeMatch(match: DashboardMatch) {
  const participants = match.match_participants ?? [];
  const playerOf = (p: MatchParticipant): MatchPlayer | null =>
    (Array.isArray(p.player) ? p.player[0] : p.player) ?? null;
  const names = (side: string) =>
    participants
      .filter((p) => p.team_side === side)
      .map((p) => playerOf(p)?.full_name)
      .filter(Boolean)
      .join(' & ');

  const a = names('a');
  const b = names('b');
  const lead = participants.filter((p) => p.team_side === 'a').map(playerOf).find(Boolean) ?? null;

  const kindWords = [
    // 'singles' → 'Singles'. The desktop cell renders this uppercase, but the
    // mobile TableCard field does not, and a lowercase word beside a Title Case
    // one reads as a bug.
    match.match_type.charAt(0).toUpperCase() + match.match_type.slice(1),
    EVENT_TYPE_LABELS[match.event_type as keyof typeof EVENT_TYPE_LABELS] ?? match.event_type,
  ];

  return {
    title: a && b ? `${a} vs ${b}` : a || b || 'Unnamed match',
    kind: kindWords.join(' · '),
    lead,
  };
}
