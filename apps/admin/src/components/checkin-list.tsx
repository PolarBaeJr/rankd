'use client';

import { useMemo, useState } from 'react';
import { Check, CheckCircle, Clock, Undo2, UserX, Users } from 'lucide-react';
import { AvatarChip, Badge, Button, SearchFilter, Tabs, normalizeSearchQuery } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';

// THE DOOR LIST. One screen for whoever stands at the entrance: everyone
// expected, who is here, who is still missing, a name search, and one tap to
// check someone in or undo it. Club events and tournaments both render it; the
// caller supplies the rows and the write.
//
// Each tap updates the row at once and puts it back if the write is refused,
// so a queue at the door is not held up by a round trip per person.
//
// A caller that passes onNoShow (club events, 00294) also gets a No-show
// button and tab. A no-show is not expected any more, so the counts leave
// them out.

export interface CheckInRow {
  key: string;
  name: string;
  /** A short second line: the events entered, "Guest", a partner. */
  detail?: string;
  here: boolean;
  /** Why this row's button is off right now (check-in closed for its event). */
  blockedReason?: string;
  /** Signed up and marked as not coming (00294). */
  noShow?: boolean;
}

type Filter = 'missing' | 'here' | 'noshow' | 'all';

export function CheckInList({
  rows: initialRows,
  canWrite,
  onToggle,
  onNoShow,
  actions,
  emptyText = 'Nobody has signed up yet.',
}: {
  rows: CheckInRow[];
  canWrite: boolean;
  /** Returns an error message, or null when the write landed. */
  onToggle: (row: CheckInRow, here: boolean) => Promise<string | null>;
  /** Marks or unmarks a no-show; same contract as onToggle. */
  onNoShow?: (row: CheckInRow, noShow: boolean) => Promise<string | null>;
  /** Buttons for the toolbar, next to the search (Add walk-in). */
  actions?: React.ReactNode;
  emptyText?: string;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState(initialRows);
  const [filter, setFilter] = useState<Filter>('missing');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // A refresh from the server (another exec at the door, a member's own QR
  // check-in) replaces the local rows, except ones with a write in flight.
  const [seen, setSeen] = useState(initialRows);
  if (seen !== initialRows) {
    setSeen(initialRows);
    setRows(initialRows.map((row) => (busy.has(row.key) ? rows.find((r) => r.key === row.key) ?? row : row)));
  }

  const expected = rows.filter((row) => !row.noShow);
  const hereCount = expected.filter((row) => row.here).length;
  const noShowCount = rows.length - expected.length;
  const visible = useMemo(() => {
    const needle = normalizeSearchQuery(query);
    const matches: Record<Filter, (row: CheckInRow) => boolean> = {
      missing: (row) => !row.here && !row.noShow,
      here: (row) => row.here,
      noshow: (row) => !!row.noShow,
      all: () => true,
    };
    return rows
      .filter(matches[filter])
      .filter((row) => !needle || normalizeSearchQuery(row.name).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, filter, query]);

  async function write(row: CheckInRow, change: Partial<CheckInRow>, send: () => Promise<string | null>) {
    setBusy((prev) => new Set(prev).add(row.key));
    setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, ...change } : r)));
    try {
      const error = await send();
      if (error) {
        setRows((prev) => prev.map((r) => (r.key === row.key ? row : r)));
        toast(error, 'error');
      }
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(row.key);
        return next;
      });
    }
  }

  // Checking in somebody marked a no-show clears the mark, as the action does.
  const toggle = (row: CheckInRow) =>
    write(row, row.here ? { here: false } : { here: true, noShow: false }, () => onToggle(row, !row.here));
  const markNoShow = (row: CheckInRow, noShow: boolean) =>
    onNoShow && write(row, { noShow }, () => onNoShow(row, noShow));

  if (rows.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5">
        <p className="text-sm text-[var(--text-muted)]">{emptyText}</p>
        {actions}
      </div>
    );
  }

  const missingCount = expected.length - hereCount;
  const percent = expected.length === 0 ? 0 : Math.round((hereCount / expected.length) * 100);

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 px-5 pb-4">
        <Tile icon={<CheckCircle className="h-4 w-4" />} label="Here" value={hereCount} color="var(--color-success)" />
        <Tile icon={<Clock className="h-4 w-4" />} label="Not here" value={missingCount} color="var(--color-warning)" />
        <Tile icon={<Users className="h-4 w-4" />} label="Expected" value={expected.length} color="var(--color-info)" />
      </div>
      <div className="px-5 pb-4">
        <div className="mb-1.5 flex justify-between text-xs text-[var(--text-muted)]">
          <span>Arrived</span>
          <span className="font-mono">{percent}%</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-elevated)]"
          role="progressbar"
          aria-valuenow={hereCount}
          aria-valuemin={0}
          aria-valuemax={expected.length}
          aria-label={`${hereCount} of ${expected.length} checked in`}
        >
          <div
            className="h-full rounded-full bg-[var(--color-success)] transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t border-[var(--border)] px-5 py-4 sm:flex-row sm:items-center">
        <SearchFilter
          value={query}
          onChange={setQuery}
          label="Search the check-in list by name"
          placeholder="Search a name"
          resultCount={visible.length}
          noun="person"
          nounPlural="people"
          className="flex-1"
        />
        <Tabs
          variant="subtle"
          activeTab={filter}
          onChange={(id) => setFilter(id as Filter)}
          tabs={[
            { id: 'missing', label: 'Not here', count: missingCount },
            { id: 'here', label: 'Here', count: hereCount },
            ...(onNoShow ? [{ id: 'noshow', label: 'No-show', count: noShowCount }] : []),
            { id: 'all', label: 'All', count: rows.length },
          ]}
        />
        {actions}
      </div>
      {visible.length === 0 ? (
        <p className="border-t border-[var(--border)] px-5 py-8 text-center text-sm text-[var(--text-muted)]">
          {query
            ? 'No one by that name here.'
            : filter === 'missing'
              ? 'Everyone is here.'
              : filter === 'noshow'
                ? 'No no-shows.'
                : 'No one yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {visible.map((row) => (
            <li
              key={row.key}
              className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-[var(--bg-elevated)]"
            >
              <AvatarChip name={row.name} id={row.key} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--text-primary)]">{row.name}</div>
                {(row.detail || row.blockedReason) && (
                  <div className="truncate text-xs text-[var(--text-muted)]">
                    {row.detail}
                    {row.detail && row.blockedReason && ' · '}
                    {row.blockedReason && <span className="text-[var(--color-warning)]">{row.blockedReason}</span>}
                  </div>
                )}
              </div>
              {row.here && (
                <Badge variant="success" className="hidden sm:inline-flex">
                  Here
                </Badge>
              )}
              {row.noShow && <Badge variant="danger">No-show</Badge>}
              {canWrite && onNoShow && !row.here && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => markNoShow(row, !row.noShow)}
                  disabled={busy.has(row.key) || !!row.blockedReason}
                  className="shrink-0"
                  aria-label={row.noShow ? `Undo no-show for ${row.name}` : `Mark ${row.name} as a no-show`}
                >
                  {row.noShow ? (
                    <>
                      <Undo2 className="h-3.5 w-3.5" /> Not a no-show
                    </>
                  ) : (
                    <>
                      <UserX className="h-3.5 w-3.5" /> No-show
                    </>
                  )}
                </Button>
              )}
              {canWrite && (
                <Button
                  variant={row.here ? 'ghost' : 'primary'}
                  size="sm"
                  onClick={() => toggle(row)}
                  loading={busy.has(row.key)}
                  disabled={!!row.blockedReason}
                  className="w-[104px] shrink-0"
                >
                  {row.here ? (
                    <>
                      <Undo2 className="h-3.5 w-3.5" /> Undo
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" /> Check in
                    </>
                  )}
                </Button>
              )}
              {!canWrite && row.here && (
                <Badge variant="success" className="sm:hidden">
                  Here
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The event page's stat tile (EventHeader), so the door list reads as part of
// the same console.
function Tile({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
      <div className="mb-1 flex items-center gap-1.5" style={{ color }}>
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-wider">{label}</span>
      </div>
      <p className="font-mono text-2xl font-bold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}
