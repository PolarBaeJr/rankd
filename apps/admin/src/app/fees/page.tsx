import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { PastSeasonNotice, resolveSeasonScope } from '@/components/season-scope';
import { SeasonSelect } from '@/components/season-select';
import { Badge, Card, AvatarChip, EmptyState, PageHeader, TableCard, Atomic } from '@badminton/ui';
import { formatPaymentMethod } from '@badminton/shared';
import type { Season } from '@badminton/shared';
import { RowSelectCheckbox, SelectAllCheckbox } from '@/components/selection';
import { isWaivedFee, summariseFeeCollection } from '@/lib/fee-status';
import type { FeeRowState } from '@/lib/fee-bulk-eligibility';
import { loadDuesRoster } from '@/lib/dues-roster';
import { loadOutstandingMembers, loadPendingSubmissions } from '@/lib/fee-submissions';
import {
  FEE_LIST_CAPABILITIES,
  FEE_VIEWS,
  FINANCES_CAPABILITIES,
  legacyTabRedirect,
  resolveFeeView,
  type FeeViewId,
} from '@/lib/fee-views';
import { FeeActions, AddManualFee, RemoveManualFee, MarkNamedFeePaid } from './fee-actions';
import { BulkFeeActions } from './bulk-fee-actions';
import { PastePayments } from './paste-payments';
import { ReinstatementsCard } from './reinstatements-card';
import { CardHeading } from './card-heading';
import { FeeTable, type FeeTableRow } from './fee-table';
import { FeeViewMenu } from './fee-view-menu';
import {
  KEPT_HEAD,
  RECEIPT_COLGROUP,
  RECEIPT_GROUPS,
  RECEIPT_HEAD,
  RECEIPT_TABLE_CLASS,
  keptRows,
  receiptRows,
  reviewAction,
} from './submitted-card';
import { OUTSTANDING_HEAD, outstandingRows, remindUnpaidAction } from './outstanding-card';
import { loadRegistrationImports } from '@/lib/registration-imports';
import { readerStatus } from '@/lib/google-forms';
import { FormImportCard } from '@/components/registration-import/FormImportCard';

// THE MEMBER-FEE LIST: one list, like /players, with a search and a View menu.
// It used to be five tabs, two of them other ledgers; Other income, Expenses
// and the money summary are on /finances now, and an old ?tab=income or
// ?tab=expenses link is sent there.
//
// Each view is a server render of its own rows (the view is in the URL, so the
// rows you are not looking at are never sent), and each FETCH below is gated
// on its own capability, never only its panel:
//
//   All, Paid, Waived, Unpaid   fees.clubfees.read
//   To review, Form screenshots fees.clubfees.markpaid.write
//
// fees.page buys the page and nothing on it. An officer on the floor holds no
// capability that puts anything here, so they are sent on to /finances, where
// the expense ledger they do hold lives.

/** Card identity line: the same avatar + name + sub-line the Player cell shows. */
function personTitle(name: string, sub: string, avatarUrl?: string | null, id?: string) {
  return (
    <div className="flex items-center gap-3">
      <AvatarChip name={name} src={avatarUrl ?? undefined} size="sm" id={id} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{name}</p>
        <p className="text-xs font-normal text-[var(--text-muted)]">{sub}</p>
      </div>
    </div>
  );
}

const rowState = (paid: boolean, waived: boolean): FeeRowState => (paid ? 'paid' : waived ? 'waived' : 'unpaid');

export default async function FeesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; view?: string; season?: string }>;
}) {
  const params = await searchParams;

  // requireCapability() is the gate: middleware already ran, but a page that
  // renders money must not depend on middleware having been reached.
  const viewer = await requireCapability('fees.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);

  // The two tabs that became their own page. Outside any try/catch, as every
  // redirect() must be: it works by throwing.
  const moved = legacyTabRedirect(params.tab, params.season);
  if (moved) redirect(moved);

  // Nothing on this page for them, and something on /finances: send them there
  // rather than draw a header over nothing. The season they asked for goes too.
  if (!FEE_LIST_CAPABILITIES.some(may) && FINANCES_CAPABILITIES.some(may)) {
    redirect(params.season !== undefined ? `/finances?season=${encodeURIComponent(params.season)}` : '/finances');
  }

  const showClubFees = may('fees.clubfees.read');
  const canMarkPaid = may('fees.clubfees.markpaid.write');
  const showReinstatements = may('fees.reinstatements.read');
  // Recording a reinstatement payment is its own capability, and the card is
  // drawn for a holder of the WRITE as well, with its rows withheld: the read
  // and the write are separate permissions and a card that simply vanishes
  // explains neither.
  const showReinstatementsCard = showReinstatements || may('fees.reinstatements.write');

  const supabase = createAdminClient();

  // Every season, so a finished term's books stay reachable. The price list is
  // not a secret (get_active_season() is granted to anon), so the two fee
  // columns are selected on every path; WHO HAS PAID is what is gated, by the
  // fetches below.
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
        <PageHeader eyebrow="No season" title="Fees" watermark="F" />
        <Card>
          <EmptyState
            title="No active season"
            description="Club fees follow the active season. Create and activate a season to start collecting dues."
            action={
              may('seasons.page') ? (
                <Link href="/seasons" className="text-[var(--color-accent)] font-medium">
                  Go to Seasons
                </Link>
              ) : undefined
            }
          />
        </Card>
        {/* Rendered here too, deliberately: a lapsed member coming back
            between terms is the ordinary reinstatement, and those rows would
            otherwise be unreachable for as long as the club is between
            seasons. The card runs its own fetch behind its own capability. */}
        {showReinstatementsCard && <ReinstatementsCard seasonId={null} canRead={showReinstatements} />}
      </div>
    );
  }

  const feeForStatus = (status: string) =>
    status === 'competitive' ? season.competitive_fee_cents : season.recreational_fee_cents;

  // Adding a fee by hand is offered only for the CURRENT season: a new fee
  // filed into a finished term lands outside the season being collected for.
  const showAddManualFee = may('fees.clubfees.addmanual.write') && !isPast;
  // Paste a list reads the roster (the club-fee read) and marks members paid
  // (markpaid). Offered on a finished term too, like the bulk bar.
  const showPastePayments = showClubFees && canMarkPaid;

  // THE THREE BULK CONTROLS ARE THE THREE CAPABILITIES, one apiece, the same
  // rule /players and /sessions follow. Not withheld on a finished term:
  // settling last term's dues late is ordinary work.
  const bulkCan = {
    markPaid: may('fees.clubfees.markpaid.write'),
    waive: may('fees.clubfees.waive.write'),
    markUnpaid: may('fees.clubfees.markunpaid.write'),
  };

  // THE FETCHES, each behind the capability its rows need. The View counts are
  // drawn on every view, so these run whichever view is open; the rows of the
  // views not open are built from them and never sent.
  const now = new Date();
  const [roster, outstanding, waitingReceipts] = await Promise.all([
    showClubFees ? loadDuesRoster(supabase, season) : null,
    showClubFees ? loadOutstandingMembers(supabase, season, now) : null,
    canMarkPaid
      ? Promise.all([
          loadPendingSubmissions(supabase, 'club'),
          loadPendingSubmissions(supabase, 'club', 'keptFromForm'),
        ])
      : null,
  ]);
  const players = roster?.players ?? [];
  const feeByPlayer = roster?.feeByPlayer ?? new Map<string | null, never>();
  const manualFees = roster?.manualFees ?? [];
  const outstandingMembers = outstanding ?? [];
  const submissions = waitingReceipts?.[0] ?? [];
  const kept = waitingReceipts?.[1] ?? [];
  // Receipts by the fee they are for, so a fee's own row can offer Review.
  const pendingByFee = new Map(submissions.map((s) => [s.feeId, s]));

  // Shared with waiveFee (lib/fee-status) so the page and the action cannot
  // drift on what "already waived" means.
  const isWaived = isWaivedFee;

  // One row per LINE OF THE ALL VIEW, each roster player's fee (or nothing)
  // followed by the named entries, so Paid and Waived are counted over the
  // same population with the same test as the rows they label.
  const collection = summariseFeeCollection([
    ...players.map((p) => feeByPlayer.get(p.id)),
    ...manualFees,
  ]);
  // A named row is never waived without being stamped paid, so unpaid is the
  // rows with no stamp at all.
  const unpaidNamed = manualFees.filter((f) => !f.paid_at);

  const counts: Record<FeeViewId, number> = {
    all: players.length + manualFees.length,
    review: submissions.length,
    unpaid: outstandingMembers.length + unpaidNamed.length,
    paid: collection.paid,
    waived: collection.waived,
    screenshots: kept.length,
  };
  // What this viewer may open, and what is offered right now: Waived and Form
  // screenshots are hidden while there are none.
  const permitted = FEE_VIEWS.map((v) => v.id).filter((id) => {
    if (id === 'review') return canMarkPaid;
    if (id === 'screenshots') return canMarkPaid && kept.length > 0;
    if (id === 'waived') return showClubFees && collection.waived > 0;
    return showClubFees;
  });
  const view = resolveFeeView(params, permitted, submissions.length > 0);

  // THE SEASON'S GOOGLE FORM (00290), beside the receipts it files. Linked and
  // read by whoever may settle those receipts, so only on To review. A
  // non-member's typed email is roster data, so it is kept only for a holder of
  // the club-fee read.
  const seasonForm =
    view === 'review' && canMarkPaid
      ? await loadRegistrationImports(supabase, 'season', season.id, { guestWaiversOn: false })
      : null;
  const seasonFormResponses = (seasonForm?.responses ?? []).map((r) => (showClubFees ? r : { ...r, email: null }));

  const rosterView = view === 'all' || view === 'paid' || view === 'waived';
  // Only the players this view lists are selectable, so select-all and the bar
  // count the rows on screen and nothing the view hides.
  const inView = (state: FeeRowState) =>
    view === 'all' || (view === 'paid' && state === 'paid') || (view === 'waived' && state === 'waived');
  const viewPlayers = rosterView
    ? players.filter((p) => {
        const fee = feeByPlayer.get(p.id);
        return inView(rowState(Boolean(fee?.paid_at) && !isWaived(fee), isWaived(fee)));
      })
    : [];

  // WHAT IS SELECTABLE, AND IT IS THE ROSTER PLAYERS AND NOTHING ELSE. The
  // named entries are keyed by FEE id, and not one of the three bulk actions
  // can touch them, so they get no checkbox. FeeTable derives `visibleIds`
  // from whatever its search is showing.
  const selectableMembers = viewPlayers.map((p) => ({ id: p.id, label: p.full_name }));
  // AND THERE HAS TO BE SOMETHING TO SELECT, or the column is a header
  // checkbox over rows that all render the empty spacer cell.
  const canBulkFees =
    rosterView && (bulkCan.markPaid || bulkCan.waive || bulkCan.markUnpaid) && selectableMembers.length > 0;
  // The paid/waived flags each row renders from, as a map for the bulk bar. A
  // SNAPSHOT, used only to say how many of a selection an action applies to;
  // see lib/fee-bulk-eligibility.
  const feeStates: Record<string, FeeRowState> = {};
  for (const p of viewPlayers) {
    const fee = feeByPlayer.get(p.id);
    feeStates[p.id] = isWaived(fee) ? 'waived' : fee?.paid_at ? 'paid' : 'unpaid';
  }

  // The rows of the roster views. Built only when one is open.
  const rosterRows: (FeeTableRow & { state: FeeRowState })[] = rosterView
    ? [
          ...players.map((player) => {
              const fee = feeByPlayer.get(player.id);
              const waived = isWaived(fee);
              const paid = Boolean(fee?.paid_at) && !waived;
              // A receipt waiting on this fee is reviewed from the row too.
              const waiting = fee && canMarkPaid ? pendingByFee.get(fee.id) : undefined;
            return {
              state: rowState(paid, waived),
              id: player.id,
              name: player.full_name,
              email: player.email,
              selectable: true,
              card: (
                <TableCard
                  key={player.id}
                  title={
                    <div className="flex items-center gap-3">
                      {canBulkFees && <RowSelectCheckbox id={player.id} label={player.full_name} />}
                      {personTitle(player.full_name, player.email, player.avatar_url, player.id)}
                    </div>
                  }
                  value={
                    <Atomic>
                      {paid && fee?.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                    </Atomic>
                  }
                  badges={
                    <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                      {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                    </Badge>
                  }
                  fields={[
                    { label: 'Method', value: paid && fee?.method ? formatPaymentMethod(fee.method) : '-' },
                    { label: 'Reference', value: paid && fee?.reference ? <Atomic className="font-mono text-xs">{fee.reference}</Atomic> : '-' },
                  ]}
                  actions={
                    <>
                      {waiting && reviewAction(waiting)}
                      <FeeActions
                        playerId={player.id}
                        playerName={player.full_name}
                        seasonId={season.id}
                        seasonName={season.name}
                        defaultFeeCents={feeForStatus(player.status)}
                        paid={paid}
                        waived={waived}
                      />
                    </>
                  }
                />
              ),
              row: (
                  <tr key={player.id} className="hover:bg-[var(--border-hover)] transition-colors">
                    {canBulkFees && (
                      <td className="px-4 py-3 w-px">
                        <RowSelectCheckbox id={player.id} label={player.full_name} />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <AvatarChip name={player.full_name} src={player.avatar_url} size="sm" id={player.id} />
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">{player.full_name}</p>
                          <p className="text-xs text-[var(--text-muted)]">{player.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                        {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* Atomic, like every other amount on this page: "$120.00"
                          breaking after the "$" in a narrow Amount column is the
                          exact bug this wrapper exists for. */}
                      <Atomic className="font-mono text-[var(--text-primary)]">
                        {paid && fee?.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                      </Atomic>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {paid && fee?.method ? formatPaymentMethod(fee.method) : '-'}
                      {paid && fee?.reference && (
                        <span className="block font-mono text-xs text-[var(--text-muted)]">{fee.reference}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        {waiting && reviewAction(waiting)}
                        <FeeActions
                          playerId={player.id}
                          playerName={player.full_name}
                          seasonId={season.id}
                          seasonName={season.name}
                          defaultFeeCents={feeForStatus(player.status)}
                          paid={paid}
                          waived={waived}
                        />
                      </div>
                    </td>
                  </tr>
              ),
            };
          }),
          ...manualFees.map((fee) => {
            // A named row is not paid by being named: a Google Form files an
            // unpaid one for a non-member's screenshot (00290), settled when an
            // exec confirms it under To review. Same test as a member's row.
            const waived = isWaived(fee);
            const paid = Boolean(fee.paid_at) && !waived;
            const markNamed = !paid && !waived && canMarkPaid ? (
              <MarkNamedFeePaid id={fee.id} name={fee.manual_name ?? ''} seasonName={season.name} amountCents={fee.amount_cents} />
            ) : null;
            const waiting = canMarkPaid ? pendingByFee.get(fee.id) : undefined;
            return {
            state: rowState(paid, waived),
            id: fee.id,
            name: fee.manual_name ?? '',
            selectable: false,
            card: (
              <TableCard
                key={fee.id}
                title={personTitle(fee.manual_name, 'Manual entry')}
                value={<Atomic>{paid && fee.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}</Atomic>}
                badges={
                  <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                    {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                  </Badge>
                }
                fields={[
                  { label: 'Email', value: fee.manual_email ?? '-' },
                  { label: 'Method', value: paid && fee.method ? formatPaymentMethod(fee.method) : '-' },
                  { label: 'Reference', value: paid && fee.reference ? <Atomic className="font-mono text-xs">{fee.reference}</Atomic> : '-' },
                ]}
                actions={<>{waiting && reviewAction(waiting)}{markNamed}<RemoveManualFee id={fee.id} name={fee.manual_name} /></>}
              />
            ),
            row: (
                <tr key={fee.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  {/* EMPTY, NOT MISSING. A manual entry has no player to act on
                      and so no checkbox — but the column exists in the header, and
                      a row one cell short would shift every value in it left. */}
                  {canBulkFees && <td className="px-4 py-3 w-px" />}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <AvatarChip name={fee.manual_name} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-[var(--text-primary)]">{fee.manual_name}</p>
                        {/* The email a later signup would claim this with (00252), when one was given. */}
                        <p className="text-xs text-[var(--text-muted)]">{fee.manual_email ?? 'Manual entry'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                      {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Atomic className="font-mono text-[var(--text-primary)]">
                      {paid && fee.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                    </Atomic>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {paid && fee.method ? formatPaymentMethod(fee.method) : '-'}
                    {paid && fee.reference && (
                      <span className="block font-mono text-xs text-[var(--text-muted)]">{fee.reference}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {waiting && reviewAction(waiting)}
                      {markNamed}
                      <RemoveManualFee id={fee.id} name={fee.manual_name} />
                    </div>
                  </td>
                </tr>
            ),
            };
          }),
      ]
    : [];

  const rows: FeeTableRow[] =
    view === 'review'
      ? receiptRows(submissions)
      : view === 'screenshots'
        ? keptRows(kept)
        : view === 'unpaid'
          ? outstandingRows({
              members: outstandingMembers,
              named: unpaidNamed,
              season,
              now,
              canRemind: canMarkPaid,
              canMarkPaid,
              pendingByFee,
            })
          : rosterRows.filter((r) => inView(r.state));

  const rosterHead = (
    <tr className="border-b border-[var(--border)]">
      {canBulkFees && (
        <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase w-px">
          <SelectAllCheckbox noun="member" />
        </th>
      )}
      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Player</th>
      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Status</th>
      <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
      <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
    </tr>
  );

  // What each view is called, says, and shows when it is empty.
  const VIEW_COPY: Record<FeeViewId, { title: string; sub: string; emptyTitle: string; emptyText: string }> = {
    all: {
      title: 'Club fees',
      sub: `Who owes dues for ${season.name}, and what has been collected.`,
      emptyTitle: 'Nobody owes fees yet',
      emptyText: `No member is due to pay for ${season.name}. Members become due when they are approved as competitive or recreational and are not fee-exempt.`,
    },
    review: {
      title: 'To review',
      sub: 'All receipts waiting, any season. Grouped by where the money went: approve or reject each one.',
      emptyTitle: 'Nothing waiting',
      emptyText: 'No member has a receipt waiting for review.',
    },
    unpaid: {
      title: 'Unpaid',
      sub: `Dues and club events unpaid for ${season.name}. Receipts waiting for review are under To review.`,
      emptyTitle: 'Nothing outstanding',
      emptyText: `Nobody owes dues or event fees for ${season.name}.`,
    },
    paid: {
      title: 'Paid',
      sub: `Dues paid for ${season.name}.`,
      emptyTitle: 'Nobody has paid yet',
      emptyText: `No dues have been recorded as paid for ${season.name}.`,
    },
    waived: {
      title: 'Waived',
      sub: `Dues waived for ${season.name}. A waived fee counts as neither paid nor outstanding.`,
      emptyTitle: 'Nothing waived',
      emptyText: `No dues have been waived for ${season.name}.`,
    },
    screenshots: {
      title: 'Form screenshots',
      sub: 'Confirmed payments from a Google Form. Kept as proof of payment; erase one when its sender asks. The payment stays recorded.',
      emptyTitle: 'No screenshots on file',
      emptyText: 'No Google Form screenshot is being kept.',
    },
  };

  return (
    <div className="space-y-6">
      {/* The eyebrow carries the scope: which term, and whether it is
          finished, is the first fact about every row on the screen. "Current"
          is asked of active_flag rather than of !isPast, since isPast is
          derived from the end date. */}
      <PageHeader
        eyebrow={`${season.name} · ${
          season.active_flag ? 'Current' : isPast ? 'Closed' : 'Not active'
        }`}
        title="Fees"
        watermark="F"
        // The fee amounts are club pricing, so the sub-line follows the
        // club-fee READ.
        sub={
          showClubFees
            ? `Competitive $${(season.competitive_fee_cents / 100).toFixed(2)} · Recreational $${(season.recreational_fee_cents / 100).toFixed(2)} per member`
            : undefined
        }
        actions={
          showAddManualFee || showPastePayments ? (
            <>
              {showPastePayments && (
                <PastePayments
                  seasonId={season.id}
                  seasonName={season.name}
                  competitiveFeeCents={season.competitive_fee_cents}
                  recreationalFeeCents={season.recreational_fee_cents}
                  canKeep={showAddManualFee}
                  canAttach={may('fees.clubfees.addmanual.write')}
                  canRemove={may('fees.clubfees.removemanual.write')}
                />
              )}
              {showAddManualFee && <AddManualFee seasonId={season.id} seasonName={season.name} />}
            </>
          ) : undefined
        }
      />

      <div className="space-y-2">
        <SeasonSelect seasons={seasonList} selected={scopedSeason} basePath="/fees" />
        {isPast && scopedSeason && <PastSeasonNotice season={scopedSeason} />}
      </div>

      {/* Add fee with no club-fee read behind it, and no receipts to settle
          either. An empty body reads as a broken page rather than a withheld
          one. Asked as the raw capability rather than through
          showAddManualFee, so browsing a finished term (where the control is
          withdrawn) does not take the explanation with it. */}
      {view === null && may('fees.clubfees.addmanual.write') && (
        <Card>
          <EmptyState
            title="Club fees are not shown to you"
            description={
              showAddManualFee
                ? `You can add a fee to ${season.name} by hand, but not browse who has paid.`
                : 'Who has paid their dues this season is not shown to you.'
            }
          />
        </Card>
      )}

      {view !== null && (
        // Keyed by view, so a typed search does not carry into a list it was
        // not typed for, the way /players keys its roster.
        <FeeTable
          key={view}
          items={selectableMembers}
          heading={
            <CardHeading
              title={VIEW_COPY[view].title}
              sub={VIEW_COPY[view].sub}
              action={view === 'unpaid' ? remindUnpaidAction(outstandingMembers, canMarkPaid && season.active_flag) : undefined}
            />
          }
          toolbar={
            <FeeViewMenu
              views={FEE_VIEWS.filter((v) => permitted.includes(v.id)).map((v) => ({
                id: v.id,
                label: v.label,
                count: counts[v.id],
              }))}
              selected={view}
              shown={rows.length}
            />
          }
          groups={view === 'review' ? RECEIPT_GROUPS : undefined}
          tableClassName={view === 'review' ? RECEIPT_TABLE_CLASS : undefined}
          colgroup={view === 'review' ? RECEIPT_COLGROUP : undefined}
          empty={<EmptyState title={VIEW_COPY[view].emptyTitle} description={VIEW_COPY[view].emptyText} />}
          head={
            view === 'review'
              ? RECEIPT_HEAD
              : view === 'screenshots'
                ? KEPT_HEAD
                : view === 'unpaid'
                  ? OUTSTANDING_HEAD
                  : rosterHead
          }
          rows={rows}
          after={
            canBulkFees ? (
              <BulkFeeActions
                seasonId={season.id}
                seasonName={season.name}
                states={feeStates}
                canMarkPaid={bulkCan.markPaid}
                canWaive={bulkCan.waive}
                canMarkUnpaid={bulkCan.markUnpaid}
              />
            ) : undefined
          }
        />
      )}

      {seasonForm && (
        <Card padding={false}>
          <CardHeading
            title="Google Form"
            sub={`A form whose e-transfer screenshots pay ${season.name} dues, member or not. Each one waits above for review.`}
          />
          <div className="p-4">
            <FormImportCard
              targetKind="season"
              targetId={season.id}
              bindings={seasonForm.bindings}
              consumers={seasonForm.consumers}
              entries={[]}
              responses={seasonFormResponses}
              canBind
              canUndo={false}
              migrationMissing="Linking a form to a season needs migration 00290."
              reader={readerStatus()}
            />
          </div>
        </Card>
      )}

      {/* A reinstatement IS a fee, so it stays on this page, but as its own
          card under the list on every view: it has its own capabilities, and
          the roster query's fee_type = 'dues' filter is what keeps it out of
          the list. Never merged into it. */}
      {showReinstatementsCard && (
        <ReinstatementsCard seasonId={season.id} canRead={showReinstatements} />
      )}
    </div>
  );
}
