export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { ExpectedError, clubToday, selectInChunks, selectPagesUpTo, toCsv } from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { resolveAuditWindow } from '@/lib/audit-scope';
import {
  EXPORT_ROW_CAP,
  SIGNIN_FUNCTION,
  exportFilename,
  exportHeader,
  fetchSignInsUpTo,
  isMissingFunctionError,
  mapConsoleRow,
  mapNotificationRow,
  mapSignInRow,
  mapTournamentRow,
  resolveLogType,
  sourcesForLogType,
  truncationNoticeRow,
  type ConsoleExportRow,
  type ExportSource,
  type NotificationExportRow,
  type TournamentExportRow,
} from '@/lib/audit-export';

/**
 * THE AUDIT LOG, AS A FILE.
 *
 * A ROUTE RATHER THAN A SERVER ACTION, because a download is a response: it
 * needs its own Content-Type, its own Content-Disposition and its own caching
 * rules, and a server action returns a value to a React tree. The panel links
 * straight at it.
 *
 * IT RE-ASKS THE QUESTION THE MIDDLEWARE ALREADY ASKED. `/api/audit/export` is
 * in SECTION_CAPABILITY, so the edge has already checked `audit.export.read`
 * before this function runs, and it is checked again here anyway. That is the
 * rule app/audit/page.tsx states for itself and the reason the gate string in
 * capability-gates.ts names this handler rather than the route: an audit
 * surface names who did what to whom, so it is the last thing in the console
 * that should rely on a match having happened upstream.
 */

/** Everything that is not the file: plain text, never cached, never HTML. */
function plain(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const logType = resolveLogType(params.get('log'));
  const seasonParam = params.get('season') ?? undefined;
  const fullHistory = params.get('range') === 'all';

  // CAUGHT, NOT LET THROUGH. requireCapability THROWS ExpectedError; an uncaught
  // throw inside a route handler is a 500 with an HTML error page as its body,
  // which is not a refusal anybody can read and is not what a fetch of a CSV
  // should ever receive. The refusal message is the one the rest of the console
  // shows for the same denial, so somebody turned away is told what would have
  // been enough. app/api/passkey/register/options/route.ts is the precedent for
  // the shape.
  let viewer;
  try {
    viewer = await requireCapability('audit.export.read');
  } catch (err) {
    return plain(err instanceof ExpectedError ? err.message : 'Not authorized', 403);
  }

  // THE SECOND GATE, asked in the page's own style rather than with a second
  // requireCapability: this one does not refuse the request, it narrows the
  // file. Same shape accounts/page.tsx uses to decide which halves of itself to
  // fetch.
  const level = accessLevelFor(viewer);
  const canSeeSignins = permits(level, permissionsOf(level, viewer), 'audit.signins.read');

  // Asking for the sign-in log by name without the key is a refusal, because
  // there is nothing left to serve. Asking for everything without it is not:
  // the other three sources are still theirs, and the filename says what is
  // missing.
  if (logType === 'signins' && !canSeeSignins) {
    return plain('The sign-in log needs the audit.signins.read capability.', 403);
  }
  const signinsOmitted = logType === 'all' && !canSeeSignins;
  const sources = sourcesForLogType(logType).filter((s) => s !== 'signins' || canSeeSignins);

  // `?emails=1` IS IGNORED WITHOUT THE SIGN-IN KEY, here as on the page. The
  // email column exists only because the sign-in log carries one, so revealing
  // it to somebody who may not read that source would be a column of addresses
  // with no source to have come from.
  const revealEmails = params.get('emails') === '1' && canSeeSignins;

  try {
    const supabase = createAdminClient();

    // The window is resolved from the same function the page uses, over the
    // same season list. Not because the arithmetic is hard, but because two
    // copies of a timezone bound is F-022 and the file is read side by side
    // with the screen it came from. See lib/audit-scope.ts.
    const { data: seasons, error: seasonsError } = await supabase
      .from('seasons')
      .select('id, name, start_date, end_date, active_flag')
      .order('start_date', { ascending: false });
    // A failed PostgREST read arrives as an empty list, not as a throw, so an
    // unchecked error here would silently scope the whole file to the last 30
    // days and label it so.
    if (seasonsError) throw new Error(`seasons: ${seasonsError.message}`);

    const { since, until, scopeLabel } = resolveAuditWindow(seasons, seasonParam, fullHistory);

    const rows: (readonly unknown[])[] = [];
    // Collected separately and appended at the very end. Sorted in with
    // everything else they would scatter through the file by their empty
    // timestamp and stop reading as one disclosure.
    const notices: (readonly unknown[])[] = [];

    // The two bounds are re-applied per source rather than through a helper.
    // PostgREST's builder types are parameterised on the ROW, so a helper
    // taking "anything with .gte and .lt" cannot be written without erasing the
    // column names it is there to check. Two lines, three times, is the cheaper
    // answer than a generic that has to be cast to compile.

    // PAGED, not one .limit(EXPORT_ROW_CAP): db-max-rows truncates a single
    // request at 1,000 rows without an error, so a single read could never
    // reach EXPORT_ROW_CAP and a count against it would never fire.
    // selectPagesUpTo reads one row past the cap, so `truncated` means more
    // rows really matched.
    // Each source orders on (created_at, id) so a row cannot move between pages.
    const capped = (source: ExportSource, truncated: boolean) => {
      if (truncated) notices.push(truncationNoticeRow(source, revealEmails));
    };

    if (sources.includes('console')) {
      // A literal select string, never a template: PostgREST's client parses it
      // IN THE TYPE SYSTEM and can only do that for a literal.
      const { data, error, truncated } = await selectPagesUpTo<ConsoleExportRow>((from, to) => {
        let query = supabase
          .from('audit_logs')
          .select('id, created_at, action_type, target_type, target_id, reason, actor:players!audit_logs_actor_id_fkey(full_name)')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
        if (since) query = query.gte('created_at', since);
        if (until) query = query.lt('created_at', until);
        return query.range(from, to) as never;
      }, EXPORT_ROW_CAP);
      if (error) throw new Error(`audit_logs: ${error.message}`);
      const entries = data ?? [];

      // PUT A NAME ON THE ROWS THAT ARE ABOUT A PERSON, exactly as the page
      // does. `target_id` is a bare uuid against a table named only by
      // `target_type`, so there is no FK and no embed that resolves it, and
      // `player` is the commonest target and the one where the uuid is least
      // use. CHUNKED because PostgREST puts `in=(…)` in the QUERY STRING and a
      // few thousand uuids is a request line a proxy truncates without saying
      // so. This fetch is capped at 5000 rows, which is ten times the page's
      // worst case, so the chunking matters more here than it does there.
      const subjectIds = [
        ...new Set(
          entries
            .filter((row) => row.target_type === 'player' && row.target_id)
            .map((row) => row.target_id as string),
        ),
      ];
      // The error is dropped HERE and only here, the same trade the page makes:
      // an unresolved name degrades to a target type and a uuid, which is what
      // the file already says for a member who has since been removed. Refusing
      // the whole download because one name lookup failed would be worse.
      const { data: people } = await selectInChunks<{ id: string; full_name: string }>(
        subjectIds,
        (ids) => supabase.from('players').select('id, full_name').in('id', ids) as never,
      );
      const names = new Map((people ?? []).map((p) => [p.id, p.full_name]));

      for (const row of entries) {
        rows.push(
          mapConsoleRow(
            {
              ...row,
              subject: row.target_id
                ? (() => {
                    const full_name = names.get(row.target_id);
                    return full_name ? { full_name } : null;
                  })()
                : null,
            },
            revealEmails,
          ),
        );
      }
      capped('console', truncated);
    }

    if (sources.includes('signins')) {
      const { data, error, truncated } = await fetchSignInsUpTo(supabase, { from: since, to: until }, EXPORT_ROW_CAP);
      if (error) {
        // The one failure that is not a failure: 00257 is applied by hand, so
        // this console runs against databases that have never heard of the
        // function. Said in a sentence naming the file, with a 503 rather than
        // a 500, because the state is temporary and nothing is broken.
        if (isMissingFunctionError(error, SIGNIN_FUNCTION)) {
          return plain(
            'The sign-in log needs migration 00257, which has not been applied to this database. The other log types still download.',
            503,
          );
        }
        throw new Error(`${SIGNIN_FUNCTION}: ${error.message}`);
      }
      const entries = data ?? [];
      for (const row of entries) rows.push(mapSignInRow(row, revealEmails));
      capped('signins', truncated);
    }

    if (sources.includes('tournaments')) {
      const { data, error, truncated } = await selectPagesUpTo<TournamentExportRow>((from, to) => {
        let query = supabase
          .from('tournament_audit_log')
          .select('id, created_at, action, details, tournament_id, event_id, match_id, actor:players!tournament_audit_log_performed_by_fkey(full_name)')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
        if (since) query = query.gte('created_at', since);
        if (until) query = query.lt('created_at', until);
        return query.range(from, to) as never;
      }, EXPORT_ROW_CAP);
      if (error) throw new Error(`tournament_audit_log: ${error.message}`);
      // An EMBED, not selectInChunks: `performed_by` has a real foreign key to
      // `players`, so PostgREST resolves the name in the same statement and the
      // query-string length problem never arises.
      const entries = data ?? [];
      for (const row of entries) rows.push(mapTournamentRow(row, revealEmails));
      capped('tournaments', truncated);
    }

    if (sources.includes('notifications')) {
      const { data, error, truncated } = await selectPagesUpTo<NotificationExportRow>((from, to) => {
        let query = supabase
          .from('notifications')
          .select('id, created_at, type, title, player_id, recipient:players!notifications_player_id_fkey(full_name)')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
        if (since) query = query.gte('created_at', since);
        if (until) query = query.lt('created_at', until);
        return query.range(from, to) as never;
      }, EXPORT_ROW_CAP);
      if (error) throw new Error(`notifications: ${error.message}`);
      const entries = data ?? [];
      for (const row of entries) rows.push(mapNotificationRow(row, revealEmails));
      capped('notifications', truncated);
    }

    // Newest first across every source, which is the order the screen shows and
    // the only order in which a merged file reads as one trail. The first cell
    // is a club-local `YYYY-MM-DD HH:MM:SS` written by one formatter, so a
    // string comparison IS a chronological one.
    rows.sort((a, b) => String(b[0] ?? '').localeCompare(String(a[0] ?? '')));

    // THE BYTE ORDER MARK GOES ON HERE, not inside toCsv(). Without it Excel on
    // Windows reads the file as the system codepage and mangles every accented
    // name in it, which is silent corruption of the exact thing the file is
    // for. Keeping it out of the serializer leaves that function byte-exact and
    // testable, and leaves a machine consumer a way to get clean bytes.
    const body = '﻿' + toCsv(exportHeader(revealEmails), [...rows, ...notices]);

    return new NextResponse(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // `attachment`, never `inline`: this is a document somebody is keeping,
        // not a page. The player app's calendar route is inline because a feed
        // is subscribed to rather than saved, and it is a response-shape
        // reference here rather than a model for anything else.
        'Content-Disposition': `attachment; filename="${exportFilename(logType, scopeLabel, clubToday(), signinsOmitted)}"`,
        // Officer names, member names and sign-in times. This must never sit in
        // a shared cache, and `no-store` is the only header that says so to
        // every layer between here and the browser.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    // NEVER AN EMPTY 200. A zero-row CSV with a valid header is indistinguishable
    // from a season in which nothing happened, and that is the one answer an
    // accountability document must not give by accident.
    Sentry.captureException(err, { extra: { route: 'audit-export', log: logType } });
    return plain('The export could not be built. The failure has been reported.', 500);
  }
}
