import Link from 'next/link';
import { Card } from '@badminton/ui';
import { formatExpenseCategory, formatOtherIncomeCategory } from '@badminton/shared';
import {
  buildBars,
  buildRunningAreaPath,
  buildRunningPath,
  buildRunningTotal,
  computeRunningScale,
  type Payment,
} from '@/lib/charts';
import type { LedgerRead } from '@/lib/season-income';
import { DUES_SPLIT_LABELS, buildDuesSplit } from '@/lib/dues-split';
import type { SeasonExpenses } from '@/lib/season-finance';
import {
  BarRows,
  ChartFigure,
  ChartNote,
  RUNNING_BOX,
  RunningTotalChart,
  SplitBar,
  clubDayOf,
  money,
} from '@/components/charts';

/**
 * THE FINANCE PANELS OF THE DASHBOARD, ONE PER CAPABILITY.
 *
 * Every component here is handed data that has ALREADY been fetched under the
 * capability that owns it. Not one of them asks the permission model anything,
 * and not one of them fetches: the gate is the fetch, in dashboard/page.tsx and
 * lib/dashboard-finance.ts, because a hidden panel whose query still ran has
 * already shipped the club's books into the RSC payload. Four live leaks of
 * exactly that shape have been found in this console, including one that put
 * the club's price list in front of anyone holding fees.expenses.read.
 *
 * SO THE PANELS ARE DELIBERATELY DUMB, and the money never crosses a boundary
 * here: there is no component below that adds two ledgers together. The net
 * position — the one figure that spans every book — takes its numbers from
 * getSeasonFinances under fees.netposition.read and from nothing else, so a
 * viewer holding a single ledger read cannot reconstruct a total out of the
 * panels they were given.
 *
 * WHAT A SECOND AREA WOULD NEED, AND WHERE IT WOULD LIVE. Not here. The shapes
 * these panels are made of are in @/components/charts and the maths is in
 * @/lib/charts, both area-agnostic and both meant for /fees, /sessions,
 * /players, /seasons, /tournaments, /ratings and /audit as much as for this
 * page. THIS file is the money-specific composition: which tone, which label,
 * which sentence when the ledger is empty. An attendance panel is the same four
 * primitives with a different fetch in front of them and a different set of
 * words around them, and it belongs beside its own screen or beside this one —
 * never inside the primitives.
 */

/** The season a panel is reporting on, as the page already holds it. */
export interface PanelSeason {
  id: string;
  name: string;
}

const SECTION =
  'font-[family-name:var(--display)] text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]';
const MICRO = 'font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]';

function PanelHead({ title, aside }: { title: string; aside?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
      <h2 className={SECTION}>{title}</h2>
      {aside && <span className={MICRO}>{aside}</span>}
    </div>
  );
}

/**
 * ONE LEDGER, DRAWN: a headline, a running total across the term, and where the
 * money went.
 *
 * The three readings come from ONE fetch of ONE ledger — see the note on
 * LedgerRead in lib/season-income.ts — so the last point of the curve is the
 * headline figure by construction rather than by coincidence.
 *
 * THE CHART IS OMITTED, NOT FAKED, when the ledger has fewer than two payment
 * days. computeRunningScale returns null there, and a single day stretched
 * across the box would draw a flat line reading "nothing happened all term"
 * over a ledger where everything happened at once. The figures stay and a line
 * of prose says why there is no curve.
 */
export function LedgerChartPanel({
  title,
  figureLabel,
  ledger,
  tone,
  categoryLabel,
  breakdownLabel,
  emptyNote,
  footer,
  href,
}: {
  title: string;
  figureLabel: string;
  ledger: { total: number; payments: Payment[]; byCategory: { category: string; cents: number }[] };
  /** A CSS colour token — the one tone the whole panel is drawn in. */
  tone: string;
  categoryLabel: (stored: string) => string;
  breakdownLabel: string;
  /** What to say when the ledger holds nothing at all. Names what would fill it. */
  emptyNote: string;
  footer?: React.ReactNode;
  href: string;
}) {
  const points = buildRunningTotal(ledger.payments, clubDayOf);
  const scale = computeRunningScale(points, RUNNING_BOX);
  const bars = buildBars(
    ledger.byCategory.map((part) => ({ label: categoryLabel(part.category), cents: part.cents })),
  );
  const dayCount = points.length;

  return (
    <Card padding={false}>
      <PanelHead
        title={title}
        aside={dayCount > 0 ? `${dayCount} ${dayCount === 1 ? 'day' : 'days'}` : undefined}
      />
      <div className="space-y-5 px-4 py-4">
        {ledger.payments.length === 0 ? (
          <ChartNote>{emptyNote}</ChartNote>
        ) : (
          <>
            <Link href={href} className="block transition-colors hover:opacity-80">
              <ChartFigure label={figureLabel} value={money(ledger.total)} tone={tone} />
            </Link>

            {scale ? (
              <RunningTotalChart
                points={points}
                scale={scale}
                linePath={buildRunningPath(points, scale)}
                areaPath={buildRunningAreaPath(points, scale)}
                tone={tone}
                noun={['payment', 'payments']}
                label={`${figureLabel}: ${money(ledger.total)} across ${dayCount} days, running total.`}
              />
            ) : (
              <ChartNote>
                Every payment so far landed on one day, so there is no line to draw yet. A
                running total needs two.
              </ChartNote>
            )}

            {bars.length > 0 && (
              <div className="space-y-3 border-t border-[var(--border)] pt-4">
                <p className={MICRO}>{breakdownLabel}</p>
                <BarRows rows={bars} tone={tone} />
              </div>
            )}
          </>
        )}

        {footer}
      </div>
    </Card>
  );
}

/**
 * MONEY OUT — the panel behind `fees.expenses.read`, and the one the club owner
 * was actually looking at.
 *
 * A member narrowed to the Finance role holds `fees.page`,
 * `fees.expenses.read` and `fees.expenses.add.write` and NOTHING ELSE in the
 * money area: dues, other income and the net position are each their own
 * capability and each admin-only. So this is the whole of what the club's
 * finance exec may honestly be shown, and every figure on it comes out of
 * the expense half of club_ledger.
 */
export function ExpensePanel({
  season,
  expenses,
}: {
  season: PanelSeason;
  expenses: SeasonExpenses;
}) {
  return (
    <LedgerChartPanel
      title={`${season.name} · Money out`}
      figureLabel="Spent this season"
      ledger={{
        total: expenses.expenseCents,
        payments: expenses.payments,
        byCategory: expenses.expensesByCategory,
      }}
      tone="var(--color-danger)"
      categoryLabel={formatExpenseCategory}
      breakdownLabel="Where it went"
      emptyNote={`Nothing has been filed against ${season.name} yet. Expenses appear here as they are recorded, and the chart starts once two days of them exist.`}
      href="/finances#expenses"
      footer={
        // WHO IS STILL OUT OF POCKET. Net position is an accrual figure and
        // says nothing about this — see the reimbursement note in
        // lib/season-finance.ts — so the one surface an exec who fronts money
        // lands on is the one place it is worth saying.
        //
        // Rendered only when somebody IS owed. A "$0.00 owed" row is a warning
        // nobody can act on, which the console's guidelines rule out outright.
        expenses.owedToExecsCount > 0 ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-[var(--border)] pt-4">
            <span className={MICRO}>
              Owed back to {expenses.owedToExecsCount === 1 ? 'an exec' : 'execs'}
            </span>
            <span className="font-mono text-sm font-medium text-[var(--color-warning)]">
              {money(expenses.owedToExecsCents)}
            </span>
            <p className="w-full text-xs text-[var(--text-muted)]">
              {expenses.owedToExecsCount}{' '}
              {expenses.owedToExecsCount === 1 ? 'expense is' : 'expenses are'} still
              unreimbursed. The season is charged for them either way.
            </p>
          </div>
        ) : undefined
      }
    />
  );
}

/** Donations, grants and socials — the panel behind `fees.otherincome.read`. */
export function OtherIncomePanel({
  season,
  ledger,
}: {
  season: PanelSeason;
  ledger: LedgerRead;
}) {
  return (
    <LedgerChartPanel
      title={`${season.name} · Other income`}
      figureLabel="Taken in this season"
      ledger={ledger}
      tone="var(--color-success)"
      categoryLabel={formatOtherIncomeCategory}
      breakdownLabel="Where it came from"
      emptyNote={`No donation, grant or social has been recorded against ${season.name} yet.`}
      href="/finances#income"
    />
  );
}

/**
 * SEASON DUES: COLLECTED AGAINST STILL OWED — the panel behind
 * `fees.clubfees.read`.
 *
 * DUES ONLY, AND THE LABEL SAYS SO. Since 00094 one table holds dues, entry
 * fees and reinstatements, and it is tempting to draw all three side by side —
 * but `fee_type` is a permission boundary as well as a filter: entry money
 * answers to `tournaments.fees.read` and reinstatements to
 * `fees.reinstatements.read`, either of which this viewer may not hold. A
 * "fees by kind" chart under this capability would hand a dues reader two of
 * somebody else's books, which is the leak the per-ledger reads exist to stop.
 *
 * THIS ONE IS A REAL PART-OF-A-WHOLE, unlike the net position beside it.
 * Collected plus outstanding IS a quantity: the season's billable total, the
 * price list across every member who owes. So it is drawn as one track divided,
 * which answers "how far through collection are we" at a glance in a way two
 * bars on a shared scale do not. Income and expenditure sum to nothing at all,
 * which is why that pair stays as bars — see the note on buildSplit.
 *
 * The percentages are of that billable total and are printed beside each
 * figure, so nobody has to measure a 6% sliver by eye.
 *
 * Dues Campus Rec collected are a third segment when there are any: those members
 * are paid, but the money is not the club's. See lib/dues-split.ts.
 */
export function ClubFeePanel({
  season,
  collectedCents,
  sfuRecCents = 0,
  outstandingCents,
}: {
  season: PanelSeason | null;
  collectedCents: number | null;
  /** LedgerRead.collectedBySfuRec off the same dues read as collectedCents. */
  sfuRecCents?: number;
  outstandingCents: number | null;
}) {
  const dues =
    collectedCents === null || outstandingCents === null
      ? null
      : buildDuesSplit({ collectedCents, sfuRecCents, outstandingCents });
  const split = dues?.split ?? null;

  return (
    <Card padding={false}>
      <PanelHead title={season ? `${season.name} · Season dues` : 'Season dues'} />
      <div className="px-4 py-4">
        {!season || !split ? (
          // Rendered for the CAPABILITY rather than for the season, so somebody
          // whose only panel this is cannot be handed a blank page in the gap
          // between two terms.
          <ChartNote>No season is active, so there is nothing to collect for yet.</ChartNote>
        ) : split.total === 0 ? (
          <ChartNote>
            {season.name} has no dues on it — nobody has paid and nobody is billable yet.
          </ChartNote>
        ) : (
          <Link href="/fees" className="block space-y-4">
            <ChartFigure
              label="Billable this season"
              value={money(split.total)}
              sub={`${Math.round(dues!.paidPct)}% of the term's dues are in.`}
            />
            {/* The tones the console already uses for this pair: money in is
                success, money still owed is the warning tone the Fees
                outstanding stat cell turns above. Campus Rec money, when there is
                some, sits between them in the neutral tone. */}
            <SplitBar split={split} tones={dues!.tones} format={money} />
          </Link>
        )}
      </div>
    </Card>
  );
}

/**
 * IN, OUT AND THE DIFFERENCE — the panel behind `fees.netposition.read`.
 *
 * This is the only capability that may read every book, so it is the only place
 * on the dashboard where two ledgers are compared. The bars share a scale and
 * each keeps its figure; the net is the headline because it is the question the
 * club owner actually asks, and income alone reads like good news no matter
 * what has been spent.
 */
export function NetPositionPanel({
  season,
  incomeCents,
  expenseCents,
  netCents,
  collectedBySfuRecCents = 0,
}: {
  season: PanelSeason | null;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  /** SeasonIncome.collectedBySfuRecCents. In neither incomeCents nor netCents. */
  collectedBySfuRecCents?: number;
}) {
  const bars = buildBars([
    { label: 'In', cents: incomeCents },
    { label: 'Out', cents: expenseCents },
  ]);

  return (
    <Card padding={false}>
      <PanelHead title={season ? `${season.name} · Net position` : 'Net position'} />
      {season ? (
        <Link
          href="/finances"
          className="block space-y-4 px-4 py-4 transition-colors hover:bg-[var(--surface-2)]"
        >
          <ChartFigure
            label="Net"
            // Signed on purpose: clamping at zero would hide the one answer the
            // club owner asked for.
            value={`${netCents < 0 ? '-' : ''}${money(netCents)}`}
            tone={netCents < 0 ? 'var(--color-danger)' : 'var(--color-success)'}
          />
          <div className="space-y-4 border-t border-[var(--border)] pt-4">
            <BarRows rows={bars.slice(0, 1)} tone="var(--color-success)" />
            <BarRows rows={bars.slice(1)} tone="var(--color-danger)" />
          </div>
          {/* Paid fees Campus Rec took rather than the club. Beside the bars, not
              one of them: it is not money in, so it must not share their scale
              or read as part of the net. Only when there is some. */}
          {collectedBySfuRecCents > 0 && (
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-[var(--border)] pt-4">
              <span className={MICRO}>{DUES_SPLIT_LABELS.sfuRec}</span>
              <span className="font-mono text-sm font-medium text-[var(--text-secondary)]">
                {money(collectedBySfuRecCents)}
              </span>
              <p className="w-full text-xs text-[var(--text-muted)]">Not counted in In or Net.</p>
            </div>
          )}
        </Link>
      ) : (
        <div className="px-4 py-4">
          <ChartNote>No season is active, so there is nothing to add up yet.</ChartNote>
        </div>
      )}
    </Card>
  );
}
