import { Card } from '@badminton/ui';
import {
  buildRunningAreaPath,
  buildRunningPath,
  buildRunningTotal,
  computeRunningScale,
  type Payment,
} from '@/lib/charts';
import { DUES_SPLIT_LABELS, buildDuesSplit } from '@/lib/dues-split';
import {
  ChartFigure,
  ChartNote,
  MICRO,
  RUNNING_BOX,
  RunningTotalChart,
  SplitBar,
  clubDayOf,
  money,
} from '@/components/charts';
import { CardHeading } from './card-heading';

/**
 * HOW COLLECTION IS GOING — the Club fees tab's chart panel.
 *
 * TWO QUESTIONS AN OFFICER ACTUALLY ASKS, and they are different questions:
 *
 *   "Have we got the money in?"   the split — a level.
 *   "Has collection stalled?"     the curve — a rate.
 *
 * The stat strip above answers neither. It counts PEOPLE (paid / outstanding /
 * waived), and the treasurer booking a gym needs dollars; forty members paid out
 * of ninety is not half the money when the two tiers are priced differently.
 * Neither figure below restates a number already on the screen.
 *
 * BEHIND `fees.clubfees.read` AND NOTHING ELSE, and it costs no query at all:
 * every row it draws was already fetched to render the fee table. See the note
 * on the fetch in page.tsx.
 *
 * DUES ONLY. `club_fees` has held entry fees and reinstatements since 00094 and
 * they answer to `tournaments.fees.read` and `fees.reinstatements.read` — other
 * people's books. This panel never sees them: the page's fee query filters
 * `fee_type = 'dues'`, and a chart splitting that table by kind is the leak
 * getClubFeeIncome's comment exists to refuse. Even a zeroed bar for a ledger
 * you may not see would disclose that it is empty.
 */

/** A dues row, as the fee table already holds it. */
export interface DuesRow {
  amount_cents: number | null;
  paid_at: string | null;
}

export function CollectionCharts({
  seasonName,
  isPast,
  collectedCents,
  sfuRecCents = 0,
  outstandingCents,
  payments,
}: {
  seasonName: string;
  /** A finished term — see the note on `outstandingCents`. */
  isPast: boolean;
  /** Every paid dues row, summed. The same set, and the same fold, the
   *  dashboard's dues figure comes from, so the two cannot disagree. */
  collectedCents: number;
  /**
   * Paid dues Campus Rec collected, from the same fold (LedgerRead.collectedBySfuRec).
   * Not in `collectedCents` or `payments`; drawn as its own segment so the
   * billable total still counts those members as paid. See lib/dues-split.ts.
   */
  sfuRecCents?: number;
  /**
   * What is still owed, or NULL when the question cannot be answered honestly.
   *
   * NULL ON A CLOSED TERM, deliberately. "Still owed" is priced from TODAY's
   * roster against the season's fee columns — there is no stored record of who
   * was billable in a term that has ended, so on a finished season the figure
   * asserts a debt from members who may have joined since and omits members who
   * have left. A count carrying that approximation is one thing; a dollar
   * figure labelled as owed is a number somebody would act on. The page follows
   * the rule it already applies to the Add-fee control: browsing a finished
   * term is for reading its books.
   */
  outstandingCents: number | null;
  /** The dated amounts behind `collectedCents`, for the curve. */
  payments: Payment[];
}) {
  const dues =
    outstandingCents === null
      ? null
      : buildDuesSplit({ collectedCents, sfuRecCents, outstandingCents });
  const split = dues?.split ?? null;

  const points = buildRunningTotal(payments, clubDayOf);
  const scale = computeRunningScale(points, RUNNING_BOX);

  return (
    <Card padding={false}>
      <CardHeading
        title="Collection"
        sub={`How much of ${seasonName}'s dues is in, and when it arrived.`}
      />
      <div className="space-y-5 px-4 py-4">
        {/* SplitBar is the one shape in the kit that draws something for
            nothing — a zero total renders an empty track with em-dashes where
            the shares go, rather than returning null the way BarRows and
            ColumnChart do. So the empty state is said in words here. */}
        {split === null ? (
          <div className="space-y-2">
            <ChartFigure label="Collected" value={money(collectedCents)} tone="var(--color-success)" />
            {sfuRecCents > 0 && (
              <ChartFigure
                label={DUES_SPLIT_LABELS.sfuRec}
                value={money(sfuRecCents)}
                tone="var(--color-info)"
              />
            )}
            <ChartNote>
              {seasonName} is closed, so what is still owed cannot be worked out from the
              current roster. This is what was taken in.
            </ChartNote>
          </div>
        ) : split.total === 0 ? (
          <ChartNote>
            Nobody is billable for {seasonName} yet and nothing has been paid, so there is
            nothing to divide. Members become due when they are approved as competitive or
            recreational and are not fee-exempt.
          </ChartNote>
        ) : (
          <>
            <ChartFigure
              label="Billable this season"
              value={money(split.total)}
              sub={`${Math.round(dues!.paidPct)}% of the term's dues are in.`}
            />
            {/* Collected plus still owed IS a real quantity — the season's
                billable total — which is what makes this a split rather than
                two bars. The two tones are the ones the console already uses
                for the pair: money in is success, money owed is the warning
                tone the Outstanding stat cell turns. Dues Campus Rec collected,
                when there are any, are a third segment in the neutral tone:
                paid, but not the club's money. See lib/dues-split.ts. */}
            <SplitBar split={split} tones={dues!.tones} format={money} />
          </>
        )}

        <div className="space-y-3 border-t border-[var(--border)] pt-4">
          <p className={MICRO}>When it came in</p>
          {payments.length === 0 && sfuRecCents > 0 ? (
            <ChartNote>
              Every dues payment recorded against {seasonName} so far was collected by
              Campus Rec, so there is nothing the club collected to chart yet.
            </ChartNote>
          ) : payments.length === 0 ? (
            <ChartNote>
              No dues have been recorded against {seasonName} yet. The line starts once two
              days of payments exist.
            </ChartNote>
          ) : scale ? (
            <RunningTotalChart
              points={points}
              scale={scale}
              linePath={buildRunningPath(points, scale)}
              areaPath={buildRunningAreaPath(points, scale)}
              tone="var(--color-success)"
              noun={['payment', 'payments']}
              label={`Dues the club collected for ${seasonName}: ${money(collectedCents)} across ${points.length} days, running total.`}
            />
          ) : (
            <ChartNote>
              Every payment so far landed on one day, so there is no line to draw yet. A
              running total needs two.
            </ChartNote>
          )}
        </div>
      </div>
    </Card>
  );
}
