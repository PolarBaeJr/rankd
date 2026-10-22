'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown } from 'lucide-react';

// The roster's views as one menu of ticks: the roster shows everybody in any
// ticked view. Every view starts ticked except Guests, who are Form entrants and
// not members. The URL (/players?show=a,b) stays the one place the choice lives,
// so a link to /players?tab=attention from the dashboard still opens that one
// view (the page reads `tab` as a single tick).

export type RosterView = { id: string; label: string; count: number };

export function RosterViewMenu({
  views,
  selected,
  defaults,
  shown,
}: {
  views: RosterView[];
  /** The ticked view ids. */
  selected: string[];
  /** What an untouched /players ticks: every view but Guests. */
  defaults: string[];
  /** Rows the current ticks show. */
  shown: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<string[]>(selected);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setTicked(selected), [selected]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function apply(next: string[]) {
    setTicked(next);
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
    // The default ticks get the bare URL, so a bookmark of /players follows any
    // later change to what the default is.
    router.push(same(next, defaults) ? '/players' : `/players?show=${next.join(',')}`, { scroll: false });
  }

  function toggle(id: string) {
    apply(ticked.includes(id) ? ticked.filter((t) => t !== id) : [...ticked, id]);
  }

  const allIds = views.map((v) => v.id);
  const everything = allIds.every((id) => ticked.includes(id));
  const sameAsDefault = defaults.length === ticked.length && defaults.every((id) => ticked.includes(id));
  const label =
    ticked.length === 0
      ? 'Nothing ticked'
      : everything
        ? 'All'
        : sameAsDefault
          ? 'All but guests'
          : ticked.length === 1
            ? (views.find((v) => v.id === ticked[0])?.label ?? ticked[0])
            : `${ticked.length} views`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-h-[44px] w-full items-center gap-3 rounded-[8px] border bg-[var(--bg-surface)] px-3 text-sm text-[var(--text-primary)] transition-colors sm:w-60 ${
          open
            ? 'border-[var(--color-accent)]'
            : 'border-[var(--border)] hover:border-[var(--border-hover)]'
        }`}
      >
        <span className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">View</span>
        <span className="flex-1 truncate text-left">{label}</span>
        <span className="font-mono text-xs text-[var(--text-muted)]">{shown}</span>
        <ChevronDown
          className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Roster views"
          className="absolute right-0 z-50 mt-1.5 w-full overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)] py-1 shadow-lg sm:w-60"
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={everything}
            onClick={() => apply(everything ? defaults : allIds)}
            className="flex min-h-[40px] w-full items-center gap-2 border-b border-[var(--border)] px-3 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <TickBox on={everything} />
            <span className="flex-1">All</span>
          </button>
          {views.map((v) => {
            const on = ticked.includes(v.id);
            return (
              <button
                key={v.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggle(v.id)}
                className={`flex min-h-[40px] w-full items-center gap-2 px-3 text-left text-sm transition-colors hover:bg-[var(--bg-elevated)] ${
                  on ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <TickBox on={on} />
                <span className="flex-1">{v.label}</span>
                <span className="font-mono text-xs text-[var(--text-muted)]">{v.count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TickBox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border ${
        on ? 'border-[var(--color-accent)] bg-[var(--color-accent)]' : 'border-[var(--border-hover)]'
      }`}
    >
      {on && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
    </span>
  );
}
