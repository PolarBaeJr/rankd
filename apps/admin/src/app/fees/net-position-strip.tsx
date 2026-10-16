import { Atomic } from '@badminton/ui';
import { formatExpenseCategory } from '@badminton/shared';
import type { SeasonFinances } from '@/lib/season-finance';

/**
 * "Are we in the positives?" — the club owner's actual question, answered at
 * the top of the money page whichever tab is open.
 *
 * Presentational only. Every figure comes from the SeasonFinances object the
 * page already fetched; nothing here sums a row. Two pages independently
 * summing money is how the income figure came to read $0.00 while the money sat
 * in the database, and a component that does its own arithmetic is a third.
 *
 * Drawn as the console's `.stat-strip` rather than as three cards. The design
 * guidance reserves card chrome for content and asks for headline figures as a
 * hairline-divided row of bare label/value pairs — the same primitive the
 * dashboard already uses for its counts, so the two money summaries in the
 * console now read as one thing seen twice rather than as two designs.
 *
 * The one place this departs from `.stat-strip`: the shipped `.stat-value` rule
 * sets `--display`, and every figure here is money. Money is compared digit by
 * digit between rows, so it is `--mono` throughout the console and overriding
 * the font here is what keeps the three totals column-aligned with the amounts
 * in the ledgers below them.
 */

const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

/** `.stat-value`, but in mono — see the note above about money vs. display. */
const VALUE = 'stat-value is-money';

export function NetPositionStrip({
  finances,
  seasonName,
}: {
  finances: SeasonFinances;
  seasonName: string;
}) {
  const { income, expenseCents, expensesByCategory, netCents } = finances;
  const inTheRed = netCents < 0;

  return (
    <div className="space-y-3">
      <div className="stat-strip">
        <div>
          <p className="stat-label">In</p>
          <p className={`${VALUE} text-[var(--color-success)]`}>
            <Atomic>{money(income.totalCents)}</Atomic>
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            Fees, tournaments, reinstatements and other income
          </p>
        </div>
        <div>
          <p className="stat-label">Out</p>
          <p className={`${VALUE} text-[var(--color-danger)]`}>
            <Atomic>-{money(expenseCents)}</Atomic>
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-2">Shuttles, courts, equipment, food</p>
        </div>
        {/* The headline. A minus sign is easy to miss at a glance, so the
            sub-line says which side of zero this is in words as well. */}
        <div>
          <p className="stat-label">Net · {seasonName}</p>
          <p
            className={`${VALUE} ${
              inTheRed ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
            }`}
          >
            <Atomic>
              {inTheRed ? '-' : ''}
              {money(netCents)}
            </Atomic>
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            {inTheRed ? 'Spending more than the club has taken in' : 'In the positives'}
          </p>
        </div>
        {/* Fees paid on the Campus Rec website. Those members are paid, but
            Campus Rec took the money, so it is in neither In nor Net and is shown here
            on its own. Only when there is some: a $0.00 cell for a route the
            club may never use is noise. */}
        {income.collectedBySfuRecCents > 0 && (
          <div>
            <p className="stat-label">Collected by Campus Rec</p>
            <p className={VALUE}>
              <Atomic>{money(income.collectedBySfuRecCents)}</Atomic>
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-2">Not counted in In or Net</p>
          </div>
        )}
      </div>

      {/* Where the money went. Rendered from the same rows that produced the
          expense total, so the parts always add up to the whole.
          Square hairline tags rather than filled pills: the design language is
          flat and sharp, and a row of rounded chips was the one piece of this
          page borrowing a shape nothing else here uses. */}
      {expensesByCategory.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {expensesByCategory.map(({ category, cents }) => (
            <span
              key={category}
              className="text-xs px-2 py-1 border border-[var(--border)] text-[var(--text-secondary)]"
            >
              {formatExpenseCategory(category)}{' '}
              <Atomic className="font-mono text-[var(--text-muted)]">{money(cents)}</Atomic>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
