import Link from 'next/link';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { PastSeasonNotice, resolveSeasonScope } from '@/components/season-scope';
import { SeasonSelect } from '@/components/season-select';
import { Card, EmptyState, PageHeader } from '@badminton/ui';
import type { Season } from '@badminton/shared';
import type { FeeStatusRow } from '@/lib/fee-status';
import { getSeasonFinances } from '@/lib/season-finance';
import { foldLedgerRows } from '@/lib/season-income';
import { outstandingClubFeeCents } from '@/lib/fees-outstanding';
import { loadDuesRoster } from '@/lib/dues-roster';
import { LedgerCard } from '@/app/fees/ledger-card';
import { NetPositionStrip } from '@/app/fees/net-position-strip';
import { NetPositionChart } from '@/app/fees/net-position-chart';
import { CollectionCharts } from '@/app/fees/collection-charts';
import { ScrollToSection } from './scroll-to-section';

// THE CLUB'S MONEY OTHER THAN THE FEE LIST: the net position, how dues
// collection is going, expenses and other income. These were tabs on /fees
// until the fee list grew views of its own; they are one page now, stacked,
// with no tabs, so the summary sits above the two ledgers it adds up.
//
// Same section as /fees (fees.page opens both), and the same rule: fees.page
// buys the page and nothing on it. Each section asks for its OWN read and skips
// its FETCH without it, never only its panel, because a panel hidden over a
// query that still ran ships the figures into the RSC payload. An officer on
// the floor holds fees.expenses.read and fees.expenses.add.write and nothing
// else here, and gets the Expenses section and nothing else.
//
// The two ledgers carry ids (#expenses, #income), so an old /fees?tab= link
// and the dashboard's panels land on the right one.
export default async function FinancesPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const params = await searchParams;

  const viewer = await requireCapability('fees.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);
  const showExpenses = may('fees.expenses.read');
  const showClubFees = may('fees.clubfees.read');
  const showOtherIncome = may('fees.otherincome.read');
  const showNetPosition = may('fees.netposition.read');
  // WHICH LEDGER CONTROLS ARE OFFERED, asked one capability at a time. Each
  // control names the capability its own action re-checks, so the two agree by
  // construction rather than by two people remembering one rule.
  const expenseWrites = {
    add: may('fees.expenses.add.write'),
    update: may('fees.expenses.update.write'),
    reimburse: may('fees.expenses.reimburse.write'),
    remove: may('fees.expenses.remove.write'),
  };
  const incomeWrites = {
    add: may('fees.otherincome.add.write'),
    // The income ledger has no payer, so nothing to edit in place and nothing
    // to settle: removeOtherIncome is the only write on a row.
    update: false,
    reimburse: false,
    remove: may('fees.otherincome.remove.write'),
  };
  const offerExpenses = showExpenses || expenseWrites.add;
  const offerIncome = showOtherIncome || incomeWrites.add;

  // WHAT THE PAGE IS CALLED, asked of the capabilities rather than of the level.
  // "Finances" is only honest when there is more than the expense ledger to
  // reach; somebody who can reach that one alone is looking at a page about
  // spending, and the heading says so.
  const onlyExpenses = offerExpenses && !offerIncome && !showNetPosition && !showClubFees;
  const pageTitle = onlyExpenses ? 'Expenses' : 'Finances';
  const pageWatermark = onlyExpenses ? 'E' : 'F';

  const supabase = createAdminClient();

  // Every season, so a finished term's books stay reachable. The price list is
  // not a secret (get_active_season() is granted to anon), so the columns are
  // selected unconditionally, as /fees does.
  const { data: allSeasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag, competitive_fee_cents, recreational_fee_cents')
    .order('start_date', { ascending: false });
  const { seasons: seasonList, selected: scopedSeason, isPast } =
    resolveSeasonScope(allSeasons, params.season);
  const season = scopedSeason as Season | null;

  if (!season) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="No season" title={pageTitle} watermark={pageWatermark} />
        <Card>
          {/* No season means no net position either: club_ledger is
              season_id NOT NULL (00073, kept by 00159). The way out is offered
              to whoever can actually take it. */}
          <EmptyState
            title="No active season"
            description={
              onlyExpenses
                ? 'Expenses follow the active season. One needs to be activated before spending can be recorded.'
                : 'Other income and expenses follow the active season. Create and activate a season to start tracking money in and out.'
            }
            action={
              may('seasons.page') ? (
                <Link href="/seasons" className="text-[var(--color-accent)] font-medium">
                  Go to Seasons
                </Link>
              ) : undefined
            }
          />
        </Card>
      </div>
    );
  }

  // Everything in and everything out for this season, through the single
  // helper the dashboard calls too. Not fetched at all without the net-position
  // read: this one call reads every income ledger the club has.
  const finances = showNetPosition ? await getSeasonFinances(supabase, season) : null;

  // THE COLLECTION CHARTS, out of the dues roster /fees lists, behind the same
  // read. PAID ROWS ONLY, which is exactly the set getClubFeeLedger fetches, so
  // the chart's headline and the dashboard's cannot drift. `method` is in the
  // roster's select, so the fold also sets aside the dues Campus Rec collected.
  const roster = showClubFees ? await loadDuesRoster(supabase, season) : null;
  const collected = roster ? foldLedgerRows(roster.fees.filter((f) => f.paid_at)) : null;
  // Not offered for a closed term. See the note on `outstandingCents` in
  // app/fees/collection-charts.tsx: the figure is priced from TODAY's roster,
  // which is not the population that was billable in a season that has ended.
  const outstandingCents =
    roster && !isPast
      ? outstandingClubFeeCents(
          roster.players,
          roster.feeByPlayer as ReadonlyMap<string, FeeStatusRow | undefined>,
          season,
        )
      : null;

  // A heading id lands under the sticky top bar unless the scroll stops short.
  const anchor = 'scroll-mt-[calc(var(--console-header-h)+var(--sticky-gap))]';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${season.name} · ${
          season.active_flag ? 'Current' : isPast ? 'Closed' : 'Not active'
        }`}
        title={pageTitle}
        watermark={pageWatermark}
        sub={onlyExpenses ? 'Money the club has spent this season' : undefined}
      />

      <div className="space-y-2">
        <SeasonSelect seasons={seasonList} selected={scopedSeason} basePath="/finances" />
        {isPast && scopedSeason && <PastSeasonNotice season={scopedSeason} />}
      </div>

      {/* "Are we in the positives", for this instant and over time. */}
      {finances && <NetPositionStrip finances={finances} seasonName={season.name} />}
      {finances && <NetPositionChart finances={finances} seasonName={season.name} />}

      {/* Dollars, where the fee list's View counts people. Forty of ninety
          members paid is not half the money when the two tiers are priced
          differently. */}
      {collected && (
        <CollectionCharts
          seasonName={season.name}
          isPast={isPast}
          collectedCents={collected.total}
          sfuRecCents={collected.collectedBySfuRec}
          outstandingCents={outstandingCents}
          payments={collected.payments}
        />
      )}

      {/* Rendered when the viewer may SEE the ledger or ADD to it: the two are
          separate permissions, and the second without the first gets the Add
          control with the rows withheld. */}
      {offerExpenses && (
        <div id="expenses" className={anchor}>
          <LedgerCard
            kind="expense"
            seasonId={season.id}
            seasonName={season.name}
            canRead={showExpenses}
            canWrite={expenseWrites}
          />
        </div>
      )}

      {offerIncome && (
        <div id="income" className={anchor}>
          <LedgerCard
            kind="income"
            seasonId={season.id}
            seasonName={season.name}
            canRead={showOtherIncome}
            canWrite={incomeWrites}
          />
        </div>
      )}
      <ScrollToSection />
    </div>
  );
}
