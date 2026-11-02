'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Card, ResponsiveTable, SearchFilter, filterRowsByPlayers } from '@badminton/ui';
import { SelectionProvider, type SelectableItem } from '@/components/selection';

export interface FeeTableRow {
  id: string;
  /** The name the search matches: the member's, or a manual entry's. */
  name: string;
  /** Matched too, so an admin can paste the address off an e-transfer. */
  email?: string | null;
  /**
   * Whether this row carries a checkbox. Manual entries do not, and
   * `visibleIds` must agree with which rows actually have one, or
   * SelectAllCheckbox ticks rows that show no box.
   */
  selectable: boolean;
  /** The `<tr>`, rendered on the server. */
  row: ReactNode;
  /** The `<TableCard>` shown below `md`, rendered on the server. */
  card: ReactNode;
  /** Which of `groups` the row is listed under, when the table is grouped. */
  group?: string;
}

export interface FeeTableGroup {
  id: string;
  title: string;
  sub: string;
}

/**
 * The Club fees table with a search over it, and the selection it feeds.
 *
 * THE PROVIDER LIVES HERE rather than in the page because select-all has to
 * mean "every member the search is showing", and only this component knows
 * which those are. `items` stays the whole fee list, so a member ticked before
 * the search hid them is still counted as hidden rather than dropped.
 *
 * Client-side over rows the page already fetched, the same trade
 * SearchableTable makes: no round trip per keystroke.
 */
export function FeeTable({
  items,
  rows,
  head,
  heading,
  empty,
  after,
  toolbar,
  groups,
  tableClassName = 'w-full',
  colgroup,
}: {
  items: SelectableItem[];
  rows: FeeTableRow[];
  /** The `<tr>` of `<th>`s. */
  head: ReactNode;
  /** The card's heading, above the search. */
  heading: ReactNode;
  /** Shown instead of the table when there is nothing to list at all. */
  empty: ReactNode;
  /** Rendered inside the provider after the card: the bulk action bar. */
  after?: ReactNode;
  /** Right of the search: the View menu. Drawn even over an empty list, or a
      view with nothing in it would leave no way to pick another. */
  toolbar?: ReactNode;
  /** One table per group, in this order, each under its own heading. A group
      with no row on screen is skipped. */
  groups?: FeeTableGroup[];
  tableClassName?: string;
  /** Fixed column widths, so grouped tables line up with each other. */
  colgroup?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const searchable = useMemo(
    () => rows.map((r) => ({ ...r, players: [r.name], meta: r.email ?? null })),
    [rows],
  );
  const visible = useMemo(() => filterRowsByPlayers(searchable, query), [searchable, query]);
  const visibleIds = useMemo(
    () => visible.filter((r) => r.selectable).map((r) => r.id),
    [visible],
  );

  const table = (shownRows: typeof visible) => (
    <ResponsiveTable cards={shownRows.map((r) => <Fragment key={r.id}>{r.card}</Fragment>)}>
      <table className={tableClassName}>
        {colgroup}
        <thead>{head}</thead>
        <tbody className="divide-y divide-[var(--border)]">
          {shownRows.map((r) => (
            <Fragment key={r.id}>{r.row}</Fragment>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );

  return (
    <SelectionProvider items={items} visibleIds={visibleIds}>
      <Card padding={false}>
        {heading}
        {/* Outside the branch below: a query that matches nothing must not
            take the field with it, or there is no way to undo it. Search left,
            View menu right, stacked on a phone, the /players layout. */}
        {(rows.length > 0 || toolbar) && (
          <div className="p-3 border-b border-[var(--border)] flex flex-col gap-3 md:flex-row md:items-center">
            {rows.length > 0 && (
              <SearchFilter
                className="w-full md:max-w-[360px]"
                value={query}
                onChange={setQuery}
                label="Search fees by member name or email"
                placeholder="Search by name or email"
                resultCount={visible.length}
                noun="entry"
                nounPlural="entries"
              />
            )}
            {toolbar && <div className="min-w-0 md:ml-auto">{toolbar}</div>}
          </div>
        )}
        {rows.length === 0 ? (
          empty
        ) : visible.length === 0 ? (
          <p className="py-8 px-4 text-center text-[var(--text-muted)] [overflow-wrap:anywhere]">
            No entries match “{query}”
          </p>
        ) : groups ? (
          groups.map((group) => {
            const inGroup = visible.filter((r) => r.group === group.id);
            if (inGroup.length === 0) return null;
            return (
              <section key={group.id} className="border-t border-[var(--border)] first:border-t-0">
                <div className="px-4 pt-4 pb-2">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    {group.title} <span className="font-normal text-[var(--text-muted)]">({inGroup.length})</span>
                  </h3>
                  <p className="text-xs text-[var(--text-muted)]">{group.sub}</p>
                </div>
                {table(inGroup)}
              </section>
            );
          })
        ) : (
          table(visible)
        )}
      </Card>
      {after}
    </SelectionProvider>
  );
}
