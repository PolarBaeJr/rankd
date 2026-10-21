'use client';

import { useMemo, useState } from 'react';
import { Button, normalizeSearchQuery } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';

// THE DOOR LIST. One screen for whoever stands at the entrance: everyone
// expected, who is here, who is still missing, a name search, and one tap to
// check someone in or undo it. Club events and tournaments both render it; the
// caller supplies the rows and the write.
//
// Each tap updates the row at once and puts it back if the write is refused,
// so a queue at the door is not held up by a round trip per person.

export interface CheckInRow {
  key: string;
  name: string;
  /** A short second line: the events entered, "Guest", a partner. */
  detail?: string;
  here: boolean;
  /** Why this row's button is off right now (check-in closed for its event). */
  blockedReason?: string;
}

type Filter = 'missing' | 'here' | 'all';

export function CheckInList({
  rows: initialRows,
  canWrite,
  onToggle,
  emptyText = 'Nobody has signed up yet.',
}: {
  rows: CheckInRow[];
  canWrite: boolean;
  /** Returns an error message, or null when the write landed. */
  onToggle: (row: CheckInRow, here: boolean) => Promise<string | null>;
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

  const hereCount = rows.filter((row) => row.here).length;
  const visible = useMemo(() => {
    const needle = normalizeSearchQuery(query);
    return rows
      .filter((row) => (filter === 'all' ? true : filter === 'here' ? row.here : !row.here))
      .filter((row) => !needle || normalizeSearchQuery(row.name).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, filter, query]);

  async function toggle(row: CheckInRow) {
    const here = !row.here;
    setBusy((prev) => new Set(prev).add(row.key));
    setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, here } : r)));
    try {
      const error = await onToggle(row, here);
      if (error) {
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, here: row.here } : r)));
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

  if (rows.length === 0) {
    return <p className="px-5 pb-5 text-sm text-[var(--mute)]">{emptyText}</p>;
  }

  const tabs: { id: Filter; label: string }[] = [
    { id: 'missing', label: `Not here (${rows.length - hereCount})` },
    { id: 'here', label: `Here (${hereCount})` },
    { id: 'all', label: `All (${rows.length})` },
  ];

  return (
    <div>
      <div className="px-5 pb-3">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="text-2xl font-bold text-[var(--ink)]">
            {hereCount} <span className="text-sm font-normal text-[var(--mute)]">of {rows.length} here</span>
          </span>
        </div>
        <div
          className="mb-3 h-2 overflow-hidden rounded-full bg-[var(--line)]"
          role="progressbar"
          aria-valuenow={hereCount}
          aria-valuemin={0}
          aria-valuemax={rows.length}
          aria-label={`${hereCount} of ${rows.length} checked in`}
        >
          <div
            className="h-full rounded-full bg-[var(--color-success)] transition-all duration-300"
            style={{ width: `${(hereCount / rows.length) * 100}%` }}
          />
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a name"
          aria-label="Search a name"
          className="mb-3 w-full rounded-md border border-[var(--line)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--mute)]"
        />
        <div className="flex flex-wrap gap-2" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              onClick={() => setFilter(tab.id)}
              className={`rounded-full border px-3 py-1 text-xs ${
                filter === tab.id
                  ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--bg-card)]'
                  : 'border-[var(--line)] text-[var(--ink-2)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-[var(--mute)]">
          {query ? 'No one by that name here.' : filter === 'missing' ? 'Everyone is here.' : 'No one yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--line)]">
          {visible.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm text-[var(--ink)]">{row.name}</div>
                {row.detail && <div className="truncate text-xs text-[var(--mute)]">{row.detail}</div>}
                {row.blockedReason && (
                  <div className="truncate text-xs text-[var(--color-warning)]">{row.blockedReason}</div>
                )}
              </div>
              {canWrite && (
                <Button
                  variant={row.here ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={() => toggle(row)}
                  loading={busy.has(row.key)}
                  disabled={!!row.blockedReason}
                  className="shrink-0"
                >
                  {row.here ? 'Undo' : 'Check in'}
                </Button>
              )}
              {!canWrite && row.here && <span className="text-xs text-[var(--color-success)]">Here</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
