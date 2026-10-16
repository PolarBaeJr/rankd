'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { cn, Select } from '@badminton/ui';
import type { ScopeSeason } from './season-scope';

/**
 * Pick which season a page is showing.
 *
 * Was a row of chips, one per season. That is fine for three and unusable for
 * a club that has been running five years: the row wraps to several lines,
 * pushes the page content down on every scoped page, and finding a particular
 * term means reading every label.
 *
 * Built on the shared Select, so it has the same list, keyboard handling and
 * phone picker as every other dropdown in the console. Search matches the name
 * and the dates independently, so "2027", "fall" and "fall 27" all find Fall
 * 2027. Worth having because season names sort badly: "Fall 2026" comes before
 * "Spring 2026" alphabetically, which is backwards, so scanning a long list is
 * genuinely slow.
 *
 * The selection lives in the URL rather than in React state: these pages are
 * server components that re-query per season, so it has to survive a
 * navigation, and it makes a particular term a link somebody can send.
 */
export function SeasonSelect({
  seasons,
  selected,
  basePath,
  className,
}: {
  seasons: ScopeSeason[];
  selected: ScopeSeason | null;
  /** e.g. "/sessions": the active season is the bare path, others carry ?season= */
  basePath: string;
  /** Merged over the default classes (tailwind-merge, so a later class wins). */
  className?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function choose(s: ScopeSeason) {
    // Change the season and NOTHING ELSE. Rebuilding the URL from basePath
    // alone threw away every other query parameter: picking a season while
    // reading /fees?tab=expenses dropped you back on the Club fees tab, and on
    // /audit it cleared the filters that were the reason for looking.
    // The active season is still the bare path, so the canonical URL for "now"
    // has no ?season= on it.
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    if (s.active_flag) next.delete('season');
    else next.set('season', s.id);
    const qs = next.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  // Nothing to choose between.
  if (seasons.length < 2) return null;

  return (
    <Select
      variant="bare"
      searchable
      searchPlaceholder="Search seasons…"
      listMinWidth={256}
      aria-label="Season"
      value={selected?.id ?? ''}
      options={seasons.map((s) => ({
        value: s.id,
        label: s.name,
        badge: s.active_flag ? 'Now' : undefined,
        keywords: `${s.start_date ?? ''} ${s.end_date ?? ''}`,
      }))}
      onValueChange={(id) => {
        const s = seasons.find((x) => x.id === id);
        if (s) choose(s);
      }}
      renderValue={() => (
        <>
          <span
            aria-hidden
            className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
          >
            Season
          </span>
          <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--border)]" />
          <span className="truncate font-semibold text-[var(--text-primary)]">{selected?.name ?? 'All'}</span>
          {selected?.active_flag && (
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success)_14%,transparent)]">
              Now
            </span>
          )}
        </>
      )}
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] pl-3 pr-2 text-sm hover:border-[var(--border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
        className,
      )}
    />
  );
}
