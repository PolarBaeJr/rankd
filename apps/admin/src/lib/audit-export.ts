// HOW THE AUDIT TRAIL BECOMES A FILE. Pure, React-free and framework-free, the
// same discipline ./audit-log-view.ts keeps and for the same reason: every
// function here is a claim about what a downloaded CSV says, and a claim about
// a file is only checkable if it can be made without a request, a database or a
// browser. ./__tests__/audit-export.test.ts is where the claims are checked.
//
// FOUR SOURCES, ONE SHAPE. `public.audit_logs` (what an officer did in the
// console), the GoTrue sign-in log through the 00257 function,
// `public.tournament_audit_log` and `public.notifications`. They are four
// different tables with four different vocabularies, and the reader wants one
// spreadsheet they can sort by time. So each one is mapped onto the same fixed
// column list, every mapper emits the SAME NUMBER OF CELLS, and the columns
// that do not apply to a source are empty rather than absent. A ragged row is
// silent corruption in a CSV: every cell after the short one shifts a column
// left, and nothing anywhere reports it.
//
// ------------------------------------------------------------------
// `old_value` AND `new_value` ARE NOT EXPORTED, UNDER ANY FLAG
// ------------------------------------------------------------------
// They are the only two columns of `audit_logs` this file deliberately refuses,
// and there is no parameter that turns them on. Four admin actions read the
// whole player row with select('*') and wrote it into `old_value`, so those
// columns hold complete member records: first_name, last_name, full_name,
// display_name, handle, email, phone, avatar_url, exec_photo_url, bio,
// exec_bio, user_id and notification_preferences. That list is not a guess, it
// is the exact key list `public.strip_identity_keys` removes in
// 00155_deletion_reaches_the_audit_trails.sql, written because those two
// columns were the place a deleted member's email address survived the promise
// that it had been erased. Putting them in a file any exec can download, mail
// on and keep would be the single worst thing this feature could do, and it
// would undo 00155 without touching it.
//
// ------------------------------------------------------------------
// ONE CLOCK
// ------------------------------------------------------------------
// Every timestamp in the file goes through formatClubTimestamp below, including
// the sign-in rows, which is why the 00257 function returns a raw timestamptz
// rather than the pre-formatted local string the script it came from produces.
// Postgres tzdata and Node ICU tzdata can disagree about Vancouver after
// 2026-11-01, when British Columbia stops falling back, and two clocks in one
// document would put rows an hour apart in the same column with nothing to
// explain it.

// Deep paths, not the barrel: this module is unit-tested without a request, and
// '@badminton/shared' re-exports the mail sender with its Resend and Supabase
// clients attached. Same reason ./private-notes.ts imports query-chunks by
// path.
import { CLUB_TIMEZONE } from '@badminton/shared/src/utils/constants';
import { CLUB_PERMANENT_OFFSET_FROM } from '@badminton/shared/src/utils/session-window';
import { selectPagesUpTo, type ChunkResult } from '@badminton/shared/src/utils/query-chunks';
import { actionLabel, entryKind, isDegradedEntry } from './audit-log-view';
// TYPE-ONLY, and it has to stay that way. supabase-server.ts reaches for
// next/headers and the passkey cookie machinery at import time; a value import
// here would drag all of it into tests that have no request to read cookies
// from. `import type` is erased entirely.
import type { createAdminClient } from './supabase-server';

/* -------------------------------------------------------------------------- */
/* Which log                                                                   */
/* -------------------------------------------------------------------------- */

export const LOG_TYPES = ['console', 'signins', 'tournaments', 'notifications', 'all'] as const;
export type LogType = (typeof LOG_TYPES)[number];

/**
 * What the selector calls each type.
 *
 * "In-app notifications", not "Notifications sent". `public.notifications` is
 * in-app rows with no send receipt of any kind: a row here means the club
 * queued a notice for a member, not that anything reached them. "Notifications
 * sent" would be read as "emails sent", which is a different table, a different
 * question and an answer this file cannot give.
 */
export const LOG_TYPE_LABELS: Record<LogType, string> = {
  console: 'Console edits',
  signins: 'Sign-ins',
  tournaments: 'Tournament actions',
  notifications: 'In-app notifications',
  all: 'Everything',
};

/** The four real tables. `all` is a request for all of them, not a fifth one. */
export type ExportSource = Exclude<LogType, 'all'>;

/**
 * Which tables a request touches.
 *
 * `all` is spelled out rather than derived from LOG_TYPES so that adding a
 * sixth selector option does not silently widen every existing download.
 */
export function sourcesForLogType(type: LogType): readonly ExportSource[] {
  return type === 'all' ? ['console', 'signins', 'tournaments', 'notifications'] : [type];
}

/**
 * The type a `?log=` parameter means.
 *
 * Anything unrecognised is `console`, which is the same never-a-dead-end rule
 * resolveTab() follows in ./audit-log-view.ts. A query string is something
 * somebody can type, a link can carry stale, and a future build can rename; the
 * answer to all three is the default view, never an error page and never an
 * empty file.
 */
export function resolveLogType(param: string | undefined | null): LogType {
  return (LOG_TYPES as readonly string[]).includes(param ?? '') ? (param as LogType) : 'console';
}

/* -------------------------------------------------------------------------- */
/* The columns                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The file's columns, in order.
 *
 * `ref` is the row's own uuid and it is here because the screen shows
 * shortRef(id) in a REF column: a CSV that cannot be joined back to the row the
 * reader is looking at is a weaker document than one that can, and the uuid is
 * the only reference this schema actually has.
 *
 * `email` is appended only when emails are revealed, and it is the LAST column
 * for that reason: a file with it and a file without it agree cell for cell up
 * to the end, so two downloads of the same window can be diffed.
 */
export const EXPORT_HEADER = [
  'occurred_at',
  'source',
  'kind',
  'actor',
  'action',
  'target_type',
  'target_id',
  'detail',
  'ref',
] as const;

export const EMAIL_COLUMN = 'email';

/** The header for one request. One argument, so the two cannot drift apart. */
export function exportHeader(revealEmails: boolean): readonly string[] {
  return revealEmails ? [...EXPORT_HEADER, EMAIL_COLUMN] : [...EXPORT_HEADER];
}

/**
 * "2026-09-21 19:04:00", in the club's timezone, whatever zone the container
 * runs in.
 *
 * BUILT FROM formatToParts, never by slicing a string and never by a bare
 * toLocaleString. The containers run UTC, so an unqualified format reads the
 * HOST zone and an evening at the club comes out as the next morning: that is
 * F-022 in a different column, and dashboard/page.tsx passing CLUB_TIMEZONE
 * explicitly is the precedent this follows. Slicing the ISO string would be the
 * same bug with fewer steps.
 *
 * An unparseable value is returned VERBATIM rather than blanked, which is
 * relativeWhen()'s rule in ./audit-log-view.ts: a row with a timestamp nothing
 * can read is still a record of something happening, and a blank cell hides it.
 */
export function formatClubTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  // Past the cutover the club clock is UTC-07:00 all year, and whether the
  // runtime's tzdata knows that depends on the Node build (2026a does not,
  // 2026b does), so it is not asked. clubToday()'s rule, in session-window.
  const pinned = new Date(at.getTime() - 7 * 60 * 60_000).toISOString();
  if (pinned.slice(0, 10) >= CLUB_PERMANENT_OFFSET_FROM) {
    return `${pinned.slice(0, 10)} ${pinned.slice(11, 19)}`;
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

/* -------------------------------------------------------------------------- */
/* The rows each source hands over                                             */
/* -------------------------------------------------------------------------- */

/** One `public.audit_logs` row, with the two names the page already resolves. */
export interface ConsoleExportRow {
  id: string;
  created_at: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  actor: { full_name: string } | null;
  /** The person the row is ABOUT, when the target is a player that still exists. */
  subject?: { full_name: string } | null;
}

/**
 * One row of `public.export_auth_signins`, HAND WRITTEN.
 *
 * It is not in `Database` and cannot be until the owner applies 00257, because
 * `database.gen.ts` is generated by reading a live database. Declaring the shape
 * here and casting at the single call site in fetchSignIns() below is the whole
 * of the workaround; the client's generic is deliberately NOT widened, because
 * a widened generic would stop type-checking every other table too. Regenerate
 * the types after the migration is applied and read the diff.
 */
export interface SignInRow {
  entry_id: string;
  occurred_at: string;
  /** The raw GoTrue action, exactly as the log holds it. */
  action: string;
  /** The classification: `passkey login`, `email code requested`, and so on. */
  what: string;
  person: string;
  email: string;
  provider: string;
}

/** One `public.tournament_audit_log` row, with the officer's name embedded. */
export interface TournamentExportRow {
  id: string;
  created_at: string | null;
  action: string;
  details: unknown;
  tournament_id: string | null;
  event_id: string | null;
  match_id: string | null;
  actor: { full_name: string } | null;
}

/** One `public.notifications` row, with the recipient's name embedded. */
export interface NotificationExportRow {
  id: string;
  created_at: string;
  type: string;
  title: string;
  player_id: string;
  recipient: { full_name: string } | null;
}

/* -------------------------------------------------------------------------- */
/* The mappers                                                                 */
/* -------------------------------------------------------------------------- */

/** How much of a `details` blob survives into a cell. */
const DETAIL_MAX = 500;

const truncate = (text: string) =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;

/**
 * An officer's console edit.
 *
 * THE FULL NAME, not abbreviateActor()'s "A. Mercer". The abbreviation exists
 * for a table cell at table density and the screen carries the full name in the
 * cell's `title` anyway; in a file there is no width problem, and two officers
 * sharing an initial is exactly the ambiguity an audit trail must not
 * introduce.
 *
 * THE FULL UUID in target_id, not shortRef(). The short form is for quoting out
 * loud; the file is for looking something up.
 *
 * `action` is actionLabel(), so the CSV says what the screen said. A reader
 * comparing the two should not have to translate.
 */
export function mapConsoleRow(row: ConsoleExportRow, revealEmails: boolean): readonly unknown[] {
  // A degraded entry is a real fact with its detail missing: the write was
  // refused, reported to Sentry and retried without its payload rather than
  // thrown. Saying so in the cell is the whole point of ./audit-policy.ts, and
  // printing the sentinel reason raw would look like an officer typed it.
  const base = isDegradedEntry(row) ? 'Detail lost' : row.reason ?? '';
  // Prefixed with WHO it was about, when the page resolved a name. "PLAYER
  // BANNED / 4b1c2d3e" answers nothing anybody opens this file to ask, and the
  // subject is not otherwise a column.
  const detail = row.subject?.full_name ? `re: ${row.subject.full_name} - ${base}` : base;

  const cells = [
    formatClubTimestamp(row.created_at),
    'console',
    entryKind(row.action_type),
    // A null actor is a scheduled job or a database trigger, not a missing
    // name. Same answer abbreviateActor() gives.
    row.actor?.full_name ?? 'System',
    actionLabel(row.action_type),
    row.target_type ?? '',
    row.target_id ?? '',
    detail,
    row.id,
  ];
  // No email column has anything to put here: `audit_logs` names an officer and
  // a target by id, never by address. An empty cell keeps the row the same
  // width as a sign-in row.
  return revealEmails ? [...cells, ''] : cells;
}

/**
 * One authentication event.
 *
 * BOTH `action` AND `what`, deliberately. The raw GoTrue value goes in the
 * action column and 00257's classification in the kind column, because
 * `user_recovery_requested` is written for two different events and naming
 * either one alone would be a claim the log does not support. Side by side, the
 * reader can see the judgement and the value it was made from.
 *
 * NO TARGET ID. An auth user uuid in a file any exec can download is a
 * re-identification key across every table that stores one, and there is
 * nothing a reader of this file could do with it. The entry id in `ref` is
 * enough to find the row again.
 *
 * NO IP EITHER, and that is a finding rather than an omission: `ip_address` is
 * blank on all 1768 rows on production and `payload->>'ip'` is null on all
 * 1768, because GoTrue behind this proxy records no address. A permanently
 * empty column would tell an officer the club tracks addresses and has lost
 * them.
 */
export function mapSignInRow(row: SignInRow, revealEmails: boolean): readonly unknown[] {
  const cells = [
    formatClubTimestamp(row.occurred_at),
    'signins',
    row.what,
    // Already '(no player name)' when the uuid resolved to nobody: 00257 says
    // so rather than returning a blank, so an unresolved person cannot be read
    // as a missing value.
    row.person,
    row.action,
    'auth',
    '',
    row.provider,
    row.entry_id,
  ];
  return revealEmails ? [...cells, row.email] : cells;
}

/**
 * One tournament action.
 *
 * `kind` IS ALWAYS `console`. Every writer of this table is a server action
 * behind a `tournaments.*` capability, so there is no self-service or
 * authentication half of it to distinguish, and leaving the column blank would
 * read as "unclassified" rather than "all one thing".
 *
 * THE MOST SPECIFIC TARGET WINS: a match, else an event, else the tournament.
 * All three columns are nullable and a match row carries all three, so taking
 * the first non-null in that order is what makes the cell say the thing that
 * actually happened rather than the thing it happened inside.
 *
 * `details` is JSON, truncated. What the writers put in it is ids, scores,
 * counts, seed totals and the reason an officer typed: see the `details:`
 * arguments in lib/tournament-actions/. No name and no contact data reaches it,
 * which is why the blob is stringified rather than reduced to its keys.
 */
export function mapTournamentRow(row: TournamentExportRow, revealEmails: boolean): readonly unknown[] {
  const [targetType, targetId] = row.match_id
    ? ['match', row.match_id]
    : row.event_id
      ? ['event', row.event_id]
      : row.tournament_id
        ? ['tournament', row.tournament_id]
        : ['', ''];

  const cells = [
    formatClubTimestamp(row.created_at),
    'tournaments',
    'console',
    row.actor?.full_name ?? 'System',
    actionLabel(row.action),
    targetType,
    targetId,
    row.details === null || row.details === undefined ? '' : truncate(JSON.stringify(row.details)),
    row.id,
  ];
  return revealEmails ? [...cells, ''] : cells;
}

/**
 * One in-app notification.
 *
 * `actor` IS `System` because the table has no actor column at all: a
 * notification is written by whatever code path had a reason to, and the row
 * does not record which. Inventing an actor from the notification's `type`
 * would be a claim the schema cannot back.
 *
 * `body` IS OMITTED, deliberately. It is the message text sent to one member,
 * and it adds nothing to the question this file exists to answer: that a notice
 * about a fee went out on a date is the accountability fact, and the sentence
 * inside it is correspondence. `read_flag` is omitted for the same reason in
 * the other direction: whether somebody opened their notifications is about
 * them, not about the club's conduct.
 */
export function mapNotificationRow(row: NotificationExportRow, revealEmails: boolean): readonly unknown[] {
  const detail = row.recipient?.full_name ? `to: ${row.recipient.full_name} - ${row.title}` : row.title;
  const cells = [
    formatClubTimestamp(row.created_at),
    'notifications',
    row.type,
    'System',
    'NOTIFICATION SENT',
    'player',
    row.player_id,
    detail,
    row.id,
  ];
  return revealEmails ? [...cells, ''] : cells;
}

/* -------------------------------------------------------------------------- */
/* Caps and the disclosure                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many rows one source may contribute.
 *
 * The page caps at 500 and 1000 because that is a payload a browser has to
 * render; this is a file, and the numbers that bound it are different. The
 * whole of `auth.audit_log_entries` is 1768 rows today and grows by perhaps 50
 * a week, so 5000 per source outlasts several years of the club before it ever
 * bites. The ceiling on the other side is the render thread: five sources at
 * 5000 rows of roughly 150 bytes is a 3 MB worst case built in memory on the
 * ONE Next thread this console has, which is affordable and would not be at ten
 * times the number.
 */
export const EXPORT_ROW_CAP = 5000;

export const TRUNCATION_NOTICE =
  'TRUNCATED AT 5000 ROWS - narrow the season and download again';

/**
 * The row that says the file is incomplete.
 *
 * A HEADER NOBODY READS IS NOT A DISCLOSURE. An HTTP header, a filename or a
 * line on the page all vanish the moment the file is forwarded, and the reader
 * of a truncated export has no way to tell it apart from a quiet season. A row
 * inside the file travels with it, survives being opened in Excel and sorts
 * with everything else.
 *
 * It carries `source = export` and `kind = notice` so that nobody filtering the
 * file by source mistakes it for an event, and names the source that ran out in
 * the target_type column.
 */
export function truncationNoticeRow(source: ExportSource, revealEmails: boolean): readonly unknown[] {
  const cells = ['', 'export', 'notice', 'System', 'TRUNCATED', source, '', TRUNCATION_NOTICE, ''];
  return revealEmails ? [...cells, ''] : cells;
}

/* -------------------------------------------------------------------------- */
/* The filename                                                                */
/* -------------------------------------------------------------------------- */

const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * "audit-console-fall-2026-2026-09-21.csv".
 *
 * `signinsOmitted` IS IN THE NAME AND HAS TO BE. When somebody without
 * `audit.signins.read` asks for everything, they get everything except the
 * sign-in trail, and a silently shorter file is a lie: it looks exactly like an
 * export of a club where nobody signed in. The filename is the one piece of
 * this that the reader sees before they open it and that survives being
 * forwarded, so that is where it says so.
 */
export function exportFilename(
  type: LogType,
  scopeLabel: string,
  today: string,
  signinsOmitted = false,
): string {
  const label = type === 'all' && signinsOmitted ? 'all-no-signins' : type;
  return `${['audit', label, slug(scopeLabel), slug(today)].filter(Boolean).join('-')}.csv`;
}

/* -------------------------------------------------------------------------- */
/* Reaching the sign-in log                                                    */
/* -------------------------------------------------------------------------- */

/** The shape of a PostgREST failure, as much of it as anything here reads. */
export interface QueryError {
  code?: string | null;
  message?: string | null;
}

/**
 * "PostgREST/Postgres has never heard of this FUNCTION."
 *
 * The sibling of isMissingTableError() in ./private-notes.ts, and a different
 * family from it. That one answers "the table is not there yet" with PGRST205,
 * PGRST202 and 42P01; this one is a function missing from the schema cache,
 * which PostgREST reports as PGRST202, and an undefined function that gets past
 * the cache, which Postgres raises as 42883.
 *
 * WHY IT MATTERS HERE: 00257 is applied by hand, so this console is routinely
 * deployed against a database that has never heard of export_auth_signins. The
 * four other log types need no function at all and must keep working. What this
 * predicate buys is the difference between "the migration is not applied yet",
 * which is a sentence naming the file, and every other failure.
 *
 * EVERYTHING ELSE IS THE CALLER'S PROBLEM, which is the entire point of naming
 * codes rather than catching broadly. A blanket catch would mean that once
 * 00257 is applied, a genuine failure (a permission, a connection, a timeout)
 * ends as a cheerful empty export, and the reader concludes nobody signed in.
 */
export function isMissingFunctionError(
  error: QueryError | null | undefined,
  fn: string,
): boolean {
  if (!error) return false;
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  // Backstop for a client that surfaces the message without a code, the same
  // shape isMissingTableError() uses and for the same reason.
  const message = error.message ?? '';
  return message.includes(fn) && /schema cache|does not exist/i.test(message);
}

export const SIGNIN_FUNCTION = 'export_auth_signins';

/**
 * Call 00257's function.
 *
 * WHY A CAST AT ALL. The audit page probes with a limit of one to find out
 * whether the migration is applied, and `supabase.rpc('export_auth_signins',
 * …)` fails type-check on the FUNCTION NAME argument, not merely on the return
 * value, so an `as SignInRow[]` at the call site would not compile. The
 * download reads through fetchSignInsUpTo below, which carries the only other
 * cast. Both go when database.gen.ts is regenerated after the owner applies
 * 00257.
 */
export async function fetchSignIns(
  client: ReturnType<typeof createAdminClient>,
  window: { from: string | null; to: string | null; limit: number },
): Promise<{ data: SignInRow[] | null; error: QueryError | null }> {
  const untyped = client as unknown as {
    rpc(
      fn: string,
      args: Record<string, unknown>,
    ): PromiseLike<{ data: SignInRow[] | null; error: QueryError | null }>;
  };
  return untyped.rpc(SIGNIN_FUNCTION, {
    p_from: window.from,
    p_to: window.to,
    p_limit: window.limit,
  });
}

/**
 * The download's read of 00257's function: up to `maxRows` rows, paged, and
 * whether more matched. A single call is cut at db-max-rows (1,000) without an
 * error, whatever p_limit says, so the file would stop there and never say so.
 * p_limit is one past the cap so a truncated window is visible; PostgREST
 * orders and ranges the function's result, on (occurred_at, entry_id) so a row
 * cannot move between pages. The second cast in this file, for the same reason
 * as fetchSignIns' and with the builder methods the paging needs.
 */
export async function fetchSignInsUpTo(
  client: ReturnType<typeof createAdminClient>,
  window: { from: string | null; to: string | null },
  maxRows: number,
): Promise<{ data: SignInRow[] | null; error: QueryError | null; truncated: boolean }> {
  interface SignInQuery {
    order(column: string, options: { ascending: boolean }): SignInQuery;
    range(from: number, to: number): PromiseLike<ChunkResult<SignInRow>>;
  }
  const untyped = client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): SignInQuery;
  };
  return selectPagesUpTo<SignInRow>(
    (from, to) =>
      untyped
        .rpc(SIGNIN_FUNCTION, { p_from: window.from, p_to: window.to, p_limit: maxRows + 1 })
        .order('occurred_at', { ascending: false })
        .order('entry_id', { ascending: false })
        .range(from, to),
    maxRows,
  );
}
