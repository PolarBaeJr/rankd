'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@badminton/ui';
import type { LogType } from '@/lib/audit-export';

/**
 * Which log the DOWNLOAD covers.
 *
 * Modelled on components/season-select.tsx and deliberately simpler: five
 * fixed options, so there is no search box and nothing to filter. What it keeps
 * from that component is the one thing that is not obvious.
 *
 * THE SELECTION IS BUILT FROM THE EXISTING PARAMETERS, never from the path
 * alone. Rebuilding the URL from a base path threw away every other query
 * parameter, and on this page in particular it cleared the season and range
 * that were the reason somebody was looking. That bug is recorded in
 * season-select.tsx and it is the same bug here.
 *
 * The selection lives in the URL rather than in React state because the band
 * around it is server-rendered: the download link has to carry the same
 * parameters, and a scoped export has to be a link somebody can send.
 */
export function LogTypeSelect({
  options,
  selected,
  triggerClassName,
}: {
  options: readonly { value: LogType; label: string }[];
  selected: LogType;
  /** Merged over the trigger's own classes, for a caller that joins it to other controls. */
  triggerClassName?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function choose(value: LogType) {
    setOpen(false);
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    // `console` is the default, so the canonical URL for it carries no `log`.
    if (value === 'console') next.delete('log');
    else next.set('log', value);
    const qs = next.toString();
    router.push(qs ? `/audit?${qs}` : '/audit');
  }

  const current = options.find((o) => o.value === selected) ?? options[0];

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex h-9 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-xs text-[var(--text-primary)] hover:border-[var(--border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
          triggerClassName,
        )}
      >
        <span className="text-[var(--text-muted)]">Download</span>
        <span className="font-semibold">{current?.label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-[60] mt-1 w-56 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] shadow-lg"
          role="listbox"
        >
          <div className="py-1">
            {options.map((option) => {
              const isSelected = option.value === selected;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => choose(option.value)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--bg-elevated)]"
                >
                  <Check
                    className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-[var(--color-accent)]' : 'opacity-0'}`}
                  />
                  <span className="flex-1 truncate text-[var(--text-primary)]">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
