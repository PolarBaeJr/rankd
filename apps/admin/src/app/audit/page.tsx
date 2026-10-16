export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { selectInChunks } from '@badminton/shared';
import Link from 'next/link';
import { AuditList, type AuditLogRow } from './audit-list';
import { LogTypeSelect } from './log-type-select';
import { countDegraded } from '@/lib/audit-log-view';
import { resolveAuditWindow } from '@/lib/audit-scope';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { withBase } from '@/lib/base-path';
import { SeasonSelect } from '@/components/season-select';
import {
  LOG_TYPES,
  LOG_TYPE_LABELS,
  SIGNIN_FUNCTION,
  fetchSignIns,
  isMissingFunctionError,
  resolveLogType,
} from '@/lib/audit-export';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; season?: string; log?: string; emails?: string }>;
}) {
  const params = await searchParams;
  const { range, season, log, emails } = params;
  const fullHistory = range === 'all';
  const logType = resolveLogType(log);
  // Same capability middleware resolves for '/audit', re-asked at the fetch. An
  // audit trail names who did what to whom, so it is the last page that should
  // rely on a route match having happened upstream.
  const viewer = await requireCapability('audit.page');

  // THE EXPORT BAND'S TWO KEYS, asked here so the page draws only what this
  // person may actually use. Offering a control that answers 403 is worse than
  // not offering it: the officer reads a refusal as a bug and asks an admin to
  // check a flag that is already correct.
  const viewerLevel = accessLevelFor(viewer);
  const viewerPermissions = permissionsOf(viewerLevel, viewer);
  const canExport = permits(viewerLevel, viewerPermissions, 'audit.export.read');
  const canSeeSignins = permits(viewerLevel, viewerPermissions, 'audit.signins.read');

  const supabase = createAdminClient();

  // The seasons themselves are the navigation. An audit trail is read to answer
  // "what happened during X" — a term, a tournament, a season somebody is
  // querying — and a rolling 30-day window cannot answer that question at all:
  // it silently ends mid-season and has no relationship to anything the club
  // recognises.
  const { data: seasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag')
    .order('start_date', { ascending: false });

  // The whole scope, from one helper, because /api/audit/export answers the
  // same question for the same parameters and the file is read beside the
  // screen it came from. Two copies of a timezone bound is F-022 exactly, and a
  // route that resolved the season for itself could disagree with this page
  // about WHICH term is selected while agreeing about the arithmetic. See
  // lib/audit-scope.ts.
  const { seasons: allSeasons, selectedSeason, since, until, scopeLabel } =
    resolveAuditWindow(seasons, season, fullHistory);

  // Caps keep the payload bounded either way.
  let query = supabase
    .from('audit_logs')
    .select('*, actor:players!audit_logs_actor_id_fkey(full_name)')
    .order('created_at', { ascending: false })
    .limit(fullHistory ? 1000 : 500);
  if (since) query = query.gte('created_at', since);
  if (until) query = query.lt('created_at', until);

  const { data: logs } = await query;
  const rows = (logs ?? []) as AuditLogRow[];

  // Put a NAME on the rows that are about a person.
  //
  // `target_id` is a bare uuid against a table named only by `target_type`, so
  // there is no join that resolves all of them — but `player` is by far the
  // commonest target and the one where the uuid is least use: "PLAYER BANNED /
  // 4b1c2d3e" answers nothing anybody opens this page to ask. Only that one
  // type is resolved; every other target keeps its type and short reference,
  // which is all the schema actually knows.
  //
  // Chunked because this fetch is capped at 500-1000 rows and PostgREST puts
  // `in=(…)` in the QUERY STRING: a few hundred uuids is a URL long enough to
  // be truncated or refused by a proxy, and the failure is silent — missing
  // names rather than an error.
  //
  // This page diagnosed that and chunked by hand at 100. It is now the shared
  // helper, derived from the measured 8 KB request-line limit — the same defect
  // was live at a dozen other call sites, including the one that kills push for
  // the whole club.
  const subjectIds = [
    ...new Set(
      rows
        .filter((log) => log.target_type === 'player' && log.target_id)
        .map((log) => log.target_id as string)
    ),
  ];
  // The error is deliberately dropped HERE, at the call site, and only here:
  // an unresolved name degrades to "PLAYER BANNED / 4b1c2d3e", which is the
  // same thing this page already renders for a member who has since been
  // removed. Refusing to draw the accountability log because one name lookup
  // failed would be the wrong trade.
  const { data: fetched } = await selectInChunks<{
    id: string;
    full_name: string;
    avatar_url: string | null;
  }>(subjectIds, (ids) =>
    supabase.from('players').select('id, full_name, avatar_url').in('id', ids) as never
  );
  const subjects = new Map<string, { full_name: string; avatar_url: string | null }>();
  for (const player of fetched ?? []) {
    subjects.set(player.id, { full_name: player.full_name, avatar_url: player.avatar_url });
  }
  // A player who has since been removed or merged away has no row to resolve.
  // The entry stays exactly as it is, subject-less — deleting the person does
  // not delete the record of what was done to them.
  const withSubjects = rows.map((log) => ({
    ...log,
    subject: (log.target_id && subjects.get(log.target_id)) || null,
  }));

  const degraded = countDegraded(rows);

  // WHICH TYPES THIS PERSON MAY DOWNLOAD. The sign-ins option is absent rather
  // than disabled for somebody without the key: a greyed control on an audit
  // page invites the question "why can that person see this exists", and the
  // route refuses it anyway.
  const exportOptions = LOG_TYPES.filter((type) => type !== 'signins' || canSeeSignins).map(
    (type) => ({ value: type, label: LOG_TYPE_LABELS[type] }),
  );
  // A `?log=signins` typed by hand resolves to a type the selector does not
  // offer, so the band falls back to the default rather than showing a
  // selection this person cannot act on.
  const selectedLogType =
    logType === 'signins' && !canSeeSignins ? 'console' : logType;
  const wantsSignins = selectedLogType === 'signins' || selectedLogType === 'all';
  // `?emails=1` is ignored without the sign-in key, here as in the route: the
  // email column exists only because the sign-in log carries one.
  const revealEmails = emails === '1' && canSeeSignins;

  // IS 00257 THERE? Asked only when the selected type needs it, with a limit of
  // one row that is thrown away. The default view is `console`, which issues
  // ZERO extra queries, and that matters: /audit already carries four auth
  // round trips per page and this would be a fifth on every load for a question
  // almost nobody is asking.
  let signinsMissing = false;
  if (canExport && canSeeSignins && wantsSignins) {
    const { error } = await fetchSignIns(supabase, { from: since, to: until, limit: 1 });
    signinsMissing = isMissingFunctionError(error, SIGNIN_FUNCTION);
  }

  // NAMED PARAMETERS HERE, a copy in the emails toggle below, and the
  // difference is the destination rather than an inconsistency. A link back to
  // this page has to carry parameters this file does not know about, because
  // dropping one silently changes what somebody was looking at. A link at the
  // route handler has to carry only what that handler reads: it resolves the
  // same window from the same four, and anything else forwarded is a parameter
  // travelling to a place that will never look at it.
  const exportQuery = new URLSearchParams();
  if (selectedLogType !== 'console') exportQuery.set('log', selectedLogType);
  // The season is forwarded EXACTLY as it arrived, blank included. The route
  // resolves the window from the same helper this page did, so passing the
  // parameter rather than the resolved season is what keeps the two answers the
  // same one.
  if (season) exportQuery.set('season', season);
  if (fullHistory) exportQuery.set('range', 'all');
  if (revealEmails) exportQuery.set('emails', '1');
  const exportHref = withBase(`/api/audit/export?${exportQuery.toString()}`);

  // The emails toggle COPIES the incoming params and flips one, rather than
  // rebuilding the URL from the handful it happens to know about. Rebuilding is
  // correct only for as long as this list stays complete, and the moment a
  // fifth param is added the toggle silently drops it: that is precisely the
  // bug recorded at season-select.tsx:72-77, where rebuilding cleared the audit
  // filters that were the reason somebody was on the page. Copying cannot
  // develop that defect, so it is the shape to use even while the two would
  // behave identically.
  const emailsQuery = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      typeof v === 'string' ? [[k, v] as [string, string]] : [],
    ),
  );
  if (revealEmails) emailsQuery.delete('emails');
  else emailsQuery.set('emails', '1');
  const emailsHref = `/audit?${emailsQuery.toString()}`;

  return (
    <div className="space-y-6">
      {/* ACCOUNTABILITY, not "audit": the eyebrow says what the page is FOR.
          Every other console screen is a place to do something; this one exists
          so that what was done can be read back. */}
      <PageHeader
        eyebrow="Accountability"
        title="Audit log"
        sub="Who did what, when, and the reason they typed."
        watermark="A"
      />

      {/* AUDIT HEALTH, stated on the page rather than only in a policy document.
          This trail is best effort: a write that the database refuses is
          reported to Sentry and retried without its payload, never thrown,
          because throwing after the mutation has already landed makes an
          officer repeat an action that in fact succeeded. The club accepted
          that trade on 2026-08-29 — see docs/ops/audit-policy.md.

          What the reader is owed in exchange is knowing when it has bitten. A
          degraded entry is a real fact with its detail missing, and it is
          counted here and badged in the list.

          The honest limit, which is why this line is unconditional: an entry
          lost ENTIRELY leaves no row, so no screen can count it. Zero degraded
          entries means none were degraded, not that none were lost. */}
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">
        This log is best effort. A refused write is retried without its detail
        rather than blocking the action it records, so an entry can be real and
        incomplete at once
        {degraded > 0 ? (
          <>
            {' — '}
            <strong className="text-[var(--color-warning)]">
              {degraded} {degraded === 1 ? 'entry' : 'entries'}
            </strong>{' '}
            in this view {degraded === 1 ? 'is' : 'are'} marked{' '}
            <span className="whitespace-nowrap">&ldquo;Detail lost&rdquo;</span>
          </>
        ) : null}
        . An entry lost outright leaves no row at all, so it cannot appear here.
      </p>

      <AuditList
        logs={withSubjects}
        scopeLabel={scopeLabel}
        // Rendered here and passed down: the season picker is driven by the URL
        // (it re-queries on the server), while the tab, search and sort are
        // client state over the rows it returned.
        scope={
          <>
            <SeasonSelect
              seasons={allSeasons}
              selected={selectedSeason}
              basePath="/audit"
              className="rounded-md text-xs"
            />
            <Link
              href={fullHistory ? '/audit' : '/audit?range=all'}
              className="inline-flex h-9 items-center whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
            >
              {fullHistory ? 'Back to season' : 'Full history'}
            </Link>
          </>
        }
        // THE EXPORT UNIT, drawn only for somebody who may run a download: the
        // type, the email opt-in and the download, joined into one control.
        exportControls={
          canExport ? (
            <div className="inline-flex h-9 items-stretch rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] [&>*+*]:border-l [&>*+*]:border-[var(--border)]">
              <LogTypeSelect
                options={exportOptions}
                selected={selectedLogType}
                triggerClassName="h-full rounded-none rounded-l-md border-0"
              />

              {/* The email opt-in, as a URL parameter rather than client
                  state: it keeps the band server-rendered, and it makes a
                  particular export a link somebody can send. Offered only
                  alongside a type that HAS emails, because the column comes
                  from the sign-in log and nowhere else. */}
              {canSeeSignins && wantsSignins && (
                <Link
                  href={emailsHref}
                  className={`inline-flex items-center whitespace-nowrap px-3 text-xs transition-colors ${revealEmails ? 'text-[var(--color-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                >
                  {revealEmails ? 'Emails included' : 'Include emails'}
                </Link>
              )}

              {/* A PLAIN ANCHOR THROUGH withBase(), not a <Link> and not a
                  bare '/api/...' string. Next prefixes <Link> and the
                  router but never a raw string, and the console is mounted
                  at /admin on the PLAYER app's origin: an unprefixed path
                  here is not a 404, it is a live route on a different
                  container. See lib/base-path.ts. */}
              {signinsMissing ? (
                <span className="inline-flex items-center whitespace-nowrap px-3 text-xs text-[var(--color-warning)]">
                  Download unavailable
                </span>
              ) : (
                <a
                  href={exportHref}
                  className="inline-flex items-center whitespace-nowrap rounded-r-md px-3 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--border-hover)]"
                >
                  Download CSV
                </a>
              )}
            </div>
          ) : null
        }
        // THE SELECTOR IS HONEST ONLY IF THE PAGE SAYS WHAT IT DOES NOT
        // CHANGE. It sits beside filters that all rewrite the table, and this
        // one does not touch it.
        exportNote={
          canExport
            ? signinsMissing
              ? 'Sign-ins need migration 00257, which has not been applied yet. The other types still download.'
              : 'The list always shows console edits. The selector scopes the download.'
            : null
        }
      />
    </div>
  );
}
