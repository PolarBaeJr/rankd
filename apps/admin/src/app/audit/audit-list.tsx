'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Atomic, AvatarChip, Badge, Card, EmptyState, ResponsiveTable, SearchFilter, Select, Tabs, TableCard } from '@badminton/ui';
import { formatDateTime } from '@badminton/shared';
import { AUDIT_PAYLOAD_DROPPED_NOTE } from '@/lib/audit-policy';
import {
  ALL_GROUP,
  abbreviateActor,
  actionLabel,
  actionTone,
  buildTabs,
  relativeWhen,
  resolveTab,
  shortRef,
  isDegradedEntry,
  visibleLogs,
  type AuditLogEntry,
  type SortOrder,
} from '@/lib/audit-log-view';

export type AuditLogRow = AuditLogEntry;

const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

const COLUMNS = ['When', 'Action', 'Subject', 'Officer', 'Reason', 'Ref'];

const th =
  'px-4 py-3 text-left font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]';

/** `session_attendance` → `Session attendance`. The raw value, made readable. */
function subjectLabel(targetType: string | null): string {
  if (!targetType) return 'System';
  const words = targetType.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What the entry is ABOUT.
 *
 * A name and a face when the page could resolve one, and the target's type plus
 * its short reference otherwise — which is everything the schema knows for the
 * nineteen target types that are not players. The two forms sit in one column
 * on purpose: the question is always "what was this done to", and splitting it
 * by whether we happen to have a name would make the column two columns.
 */
function Subject({ log }: { log: AuditLogRow }) {
  if (log.subject) {
    return (
      <span className="flex items-center gap-2">
        <AvatarChip
          name={log.subject.full_name}
          src={log.subject.avatar_url}
          id={log.target_id ?? undefined}
          size="xs"
        />
        <span className="text-[var(--text-primary)]">{log.subject.full_name}</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span>{subjectLabel(log.target_type)}</span>
      {log.target_id && (
        <span className="font-mono text-xs text-[var(--text-muted)]" title={log.target_id}>
          {shortRef(log.target_id)}
        </span>
      )}
    </span>
  );
}

/**
 * The reason, in full, wherever it appears.
 *
 * Capped in WIDTH and left to wrap — never `truncate`, never `line-clamp`. Every
 * privileged action on this console makes an officer type this sentence, and a
 * screen that then shows the first forty characters of it has thrown away the
 * only thing the requirement was for. A four-line row is the correct rendering.
 */
function Reason({ reason }: { reason: string | null }) {
  if (!reason) {
    return (
      <span className="text-[var(--text-muted)]" title="No reason was recorded for this entry">
        —
      </span>
    );
  }
  if (!isDegradedEntry({ reason })) return <>{reason}</>;

  // A degraded entry: the first write was refused and the fact was re-recorded
  // without its payload. The officer's own words are still here — they were
  // carried into the retry deliberately — but everything else the entry would
  // have held is gone. Showing the raw marker inline would put a database
  // error message in the middle of a sentence a human typed, so the words are
  // shown as words and the marker becomes a badge with the error in its title.
  const cut = reason.indexOf(`[${AUDIT_PAYLOAD_DROPPED_NOTE}:`);
  const words = reason.slice(0, cut).trim();
  const marker = reason.slice(cut);

  return (
    <>
      {words ? <>{words} </> : null}
      <span
        title={`This entry is incomplete. The original write was refused and only the fact was recorded. ${marker}`}
        className="whitespace-nowrap"
      >
        <Badge variant="warning">Detail lost</Badge>
      </span>
    </>
  );
}

export function AuditList({
  logs,
  scopeLabel,
  scope,
  exportControls,
  exportNote,
}: {
  logs: AuditLogRow[];
  /** What the rows are scoped to, for the footer: a season name, or the window. */
  scopeLabel: string;
  /** The season picker and the full-history escape, rendered by the page. */
  scope: ReactNode;
  /** The download unit, for a viewer who may export. */
  exportControls?: ReactNode;
  /** One line under the band saying what the download does and does not cover. */
  exportNote?: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<string>(ALL_GROUP);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortOrder>('newest');

  // `now` drives the relative timestamps and is deliberately null on the first
  // render. This component server-renders, and the server's clock and timezone
  // are not the reader's: computing "Yesterday" there and "Today" in the browser
  // is a hydration mismatch AND a wrong label on an audit log. So the first
  // paint shows the absolute timestamp, and the relative reading arrives on
  // mount, in the reader's own timezone.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  // Auto-refresh: router.refresh() re-runs the server fetch without resetting
  // the tab, query or sort. Skipped while the tab is hidden. `now` is advanced
  // on the same beat, or "Today 23:58" would still say Today well into tomorrow.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date());
      if (!document.hidden) router.refresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [router]);

  // The filter's options come from the rows the SEASON gave us, before the
  // search narrows them — so typing does not make tabs appear and disappear
  // under the cursor, and the counts stay a description of the term.
  const tabs = useMemo(() => buildTabs(logs), [logs]);
  const activeTab = resolveTab(tabs, tab);

  // Commit the fallback rather than only rendering it. Without this the state
  // still holds the tab that vanished: pick Money, change to a season with no
  // fee activity (the view correctly falls back to All), change to one that has
  // some — and Money comes back on its own, having never been re-selected. A
  // filter that reinstates itself is worse than one that forgets.
  useEffect(() => {
    if (tab !== activeTab) setTab(activeTab);
  }, [tab, activeTab]);

  const rows = useMemo(
    () => visibleLogs(logs, { tab: activeTab, query, order: sort }),
    [logs, activeTab, query, sort]
  );

  // Absolute time is the value of record; the relative reading is a convenience
  // laid over it. Both are always available — one drawn, one in the tooltip.
  const exact = (iso: string) => formatDateTime(iso);
  const when = (iso: string) => (now ? relativeWhen(iso, now) : exact(iso));

  return (
    <div className="space-y-4">
      {/* Control band, two rows. The first filters the list on the client:
          search, the activity tabs and the sort. The second is what the
          server answered for: the scope, and the download on the right. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchFilter
            value={query}
            onChange={setQuery}
            label="Search the audit log by action, officer, subject or reason"
            placeholder="Search the log"
            resultCount={rows.length}
            noun="entry"
            nounPlural="entries"
            className="min-w-0 flex-1 basis-[240px] [&>div]:h-9 [&>div]:min-h-9"
          />
          <Tabs variant="subtle" tabs={tabs} activeTab={activeTab} onChange={setTab} />
          {/* Wrapped: a bare Select puts className on its trigger, inside a
              span of its own, so the push to the right has to sit out here. */}
          <div className="ml-auto">
            <Select
              variant="bare"
              aria-label="Sort audit entries"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortOrder)}
              options={SORT_OPTIONS}
              className="h-9 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-xs text-[var(--text-primary)] hover:border-[var(--border-hover)]"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{scope}</div>
          {exportControls}
        </div>
        {exportNote && (
          <p className="text-[11px] leading-tight text-[var(--text-muted)]">{exportNote}</p>
        )}
      </div>

      <Card padding={false} className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={query ? 'Nothing matches that search' : 'No entries in this period'}
            description={
              query
                ? 'The log holds everything that happened; only this search came up empty.'
                : 'Privileged actions are recorded here the moment they happen.'
            }
          />
        ) : (
          <ResponsiveTable
            cards={rows.map((log) => (
              <TableCard
                key={log.id}
                title={
                  <time
                    dateTime={log.created_at}
                    className="font-mono"
                    // Both readings are formatted in the reader's timezone, and
                    // the server prerenders this component in the container's —
                    // UTC. The two disagree by design, so the client's answer is
                    // the right one and React is told to take it rather than to
                    // warn. `dateTime` carries the unambiguous instant either way.
                    suppressHydrationWarning
                  >
                    {when(log.created_at)}
                  </time>
                }
                badges={<Badge variant={actionTone(log.action_type)}>{actionLabel(log.action_type)}</Badge>}
                fields={[
                  { label: 'Subject', wide: true, value: <Subject log={log} /> },
                  {
                    // The phone card writes the officer out in full: there is no
                    // column width to fight for here, and the hover that reveals
                    // the abbreviation on a desktop does not exist on a phone.
                    label: 'Officer',
                    value: log.actor?.full_name ?? 'System',
                  },
                  {
                    label: 'Ref',
                    value: (
                      <Atomic className="font-mono text-xs text-[var(--text-muted)]">
                        {shortRef(log.id)}
                      </Atomic>
                    ),
                  },
                  {
                    // The exact timestamp gets its own field rather than a
                    // tooltip: there is nothing to hover on a phone, and
                    // "2 days ago" alone is not a record of when something
                    // happened. Full width so it never has to wrap.
                    label: 'Recorded',
                    wide: true,
                    value: (
                      <time
                        dateTime={log.created_at}
                        className="whitespace-nowrap"
                        suppressHydrationWarning
                      >
                        {exact(log.created_at)}
                      </time>
                    ),
                  },
                  { label: 'Reason', wide: true, value: <Reason reason={log.reason} /> },
                ]}
              />
            ))}
          >
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {COLUMNS.map((col) => (
                    <th key={col} scope="col" className={col === 'Ref' ? `${th} text-right` : th}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows.map((log) => (
                  <tr key={log.id} className="transition-colors hover:bg-white/[0.03]">
                    <td className="whitespace-nowrap px-4 py-3.5 align-top">
                      <time
                        dateTime={log.created_at}
                        title={exact(log.created_at)}
                        className="font-mono text-xs text-[var(--text-secondary)]"
                        suppressHydrationWarning
                      >
                        {when(log.created_at)}
                      </time>
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      <Badge variant={actionTone(log.action_type)}>{actionLabel(log.action_type)}</Badge>
                    </td>
                    <td className="px-4 py-3.5 align-top text-sm text-[var(--text-secondary)]">
                      <Subject log={log} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5 align-top">
                      {/* Abbreviated to keep the column narrow enough that Reason
                          gets the room; the full name is one hover away, and is
                          written out in full on the phone card. */}
                      <span
                        className="font-mono text-xs text-[var(--text-primary)]"
                        title={log.actor?.full_name ?? 'Recorded by a scheduled job, not a person'}
                      >
                        {abbreviateActor(log.actor?.full_name)}
                      </span>
                    </td>
                    <td className="max-w-[340px] px-4 py-3.5 align-top text-sm leading-snug text-[var(--text-secondary)]">
                      <Reason reason={log.reason} />
                    </td>
                    <td className="px-4 py-3.5 text-right align-top" title={log.id}>
                      <Atomic className="font-mono text-xs text-[var(--text-muted)]">
                        {shortRef(log.id)}
                      </Atomic>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        )}

        {/* The card's own footer says what is on screen and what this table is.
            The immutability line is not decoration: audit_logs carries a SELECT
            and an INSERT policy and nothing else (00005_rls), and TRUNCATE was
            revoked from every application role (00072). Somebody reading a row
            they dislike should know, without asking, that it cannot be removed.

            It says DELETED and not "append-only", because append-only would be
            a stronger claim than the schema makes and it is not true: merging
            two members runs `UPDATE audit_logs SET actor_id` in a SECURITY
            DEFINER function (00026, 00079), which bypasses RLS entirely. So a
            row's ACTOR can be repointed — deliberately, so the history follows
            the surviving member — while the row itself cannot be deleted. That
            is the whole promise this footer is allowed to make. Do not read the
            policy list above as proof of immutability, and do not put the word
            back. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Showing {rows.length} of {logs.length} · {scopeLabel}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Entries cannot be deleted
          </span>
        </div>
      </Card>
    </div>
  );
}
