'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronDown } from 'lucide-react';

// The roster's views as one menu rather than a strip of tabs: there are up to
// nine of them now, and a strip that scrolls sideways hides the ones an officer
// is looking for. Each item is a link, so the URL (/players?tab=...) stays the
// one place the view lives, and a middle-click still opens one in a new tab.

export type RosterView = { id: string; label: string; count: number };

const HIDDEN_LABELS: Record<string, string> = {
  guests: 'Guests',
  incomplete: 'Incomplete',
  permissions: 'Permission review',
};

export function RosterViewMenu({ views, current }: { views: RosterView[]; current: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // A view hidden at zero (Guests, Incomplete) can still be opened by URL; name
  // it rather than claiming to be on the first one.
  const active = views.find((v) => v.id === current) ?? { id: current, label: HIDDEN_LABELS[current] ?? current, count: 0 };

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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-h-[44px] w-full items-center gap-3 rounded-[8px] border bg-[var(--bg-surface)] px-3 text-sm text-[var(--text-primary)] transition-colors sm:w-60 ${
          open
            ? 'border-[var(--color-accent)]'
            : 'border-[var(--border)] hover:border-[var(--border-hover)]'
        }`}
      >
        <span className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">View</span>
        <span className="flex-1 truncate text-left">{active?.label}</span>
        <span className="font-mono text-xs text-[var(--text-muted)]">{active?.count}</span>
        <ChevronDown
          className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-full overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)] py-1 shadow-lg sm:w-60"
        >
          {views.map((v) => {
            const selected = v.id === active?.id;
            return (
              <Link
                key={v.id}
                role="menuitem"
                href={`/players?tab=${v.id}`}
                aria-current={selected ? 'page' : undefined}
                onClick={() => setOpen(false)}
                // The view you are on gets the console's red rule on its left,
                // the same marker the top bar and the old tab strip use.
                className={`flex min-h-[40px] items-center gap-2 border-l-2 px-3 text-sm transition-colors ${
                  selected
                    ? 'border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)] text-[var(--text-primary)]'
                    : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span className="flex-1">{v.label}</span>
                <span className="font-mono text-xs text-[var(--text-muted)]">{v.count}</span>
                <Check className={`h-3.5 w-3.5 ${selected ? 'text-[var(--color-accent)]' : 'invisible'}`} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
