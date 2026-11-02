'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronDown } from 'lucide-react';

// The fee list's views as one menu, the shape of the roster's View menu on
// /players but single-select: the list shows one view at a time. The URL
// (/fees?view=) is the one place the choice lives.
//
// No reopen-after-navigate here, unlike the roster's menu: that one stays open
// so several views can be ticked in one go, and a choice here is the whole
// choice, so the menu closing behind it is the point.

export type FeeView = { id: string; label: string; count: number };

export function FeeViewMenu({
  views,
  selected,
  shown,
}: {
  /** Only the views this viewer may open and that are offered now. */
  views: FeeView[];
  selected: string;
  /** Rows the current view shows. */
  shown: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  function choose(id: string) {
    setOpen(false);
    // The view is always written out, even for what is the default today: the
    // bare URL picks a default from what is waiting, and a view somebody chose
    // must not change under them when the last receipt is settled. The season
    // stays, and an old ?tab= goes, since an explicit view beats it anyway.
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    next.set('view', id);
    next.delete('tab');
    router.push(`/fees?${next.toString()}`, { scroll: false });
  }

  const label = views.find((v) => v.id === selected)?.label ?? selected;

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
          role="menu"
          aria-label="Fee views"
          className="absolute right-0 z-50 mt-1.5 w-full overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)] py-1 shadow-lg sm:w-60"
        >
          {views.map((v) => {
            const on = v.id === selected;
            return (
              <button
                key={v.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => choose(v.id)}
                // Form screenshots are confirmed payments kept as proof, not
                // part of the fee list, so a hairline sets them apart.
                className={`flex min-h-[40px] w-full items-center gap-2 px-3 text-left text-sm transition-colors hover:bg-[var(--bg-elevated)] ${
                  v.id === 'screenshots' ? 'border-t border-[var(--border)]' : ''
                } ${on ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              >
                <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {on && <Check className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={3} />}
                </span>
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
