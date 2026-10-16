import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { Card, Badge, AvatarChip, PageHeader, ResponsiveTable, TableCard } from '@badminton/ui';
import { unwrap, quoteEntryFee, selectInChunks, loadEntryMemberships, formatMembershipType, AppError } from '@badminton/shared';
import { RowSelectCheckbox, SelectAllCheckbox, SelectionProvider } from '@/components/selection';
import { isWaivedFee } from '@/lib/fee-status';
import type { FeeRowState } from '@/lib/fee-bulk-eligibility';
import type { TournamentFeeTier, ClubFee, Player, MembershipType } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { TournamentFeeActions } from './tournament-fee-actions';
import { BulkTournamentFeeActions } from './bulk-tournament-fee-actions';
import { NonMemberFees, type NonMemberFeeRow } from './non-member-fees';
import { SubmissionActions } from '../../../fees/submission-actions';
import { loadPendingSubmissions } from '@/lib/fee-submissions';

/** Card identity line: the same avatar + name + email the Player cell shows. */
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

export default async function TournamentFeesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Entry money is its own capability, in nobody's baseline — defence in depth
  // beyond the middleware gate, which asks the same question about the route.
  const viewer = await requireCapability('tournaments.fees.read');
  // The two bulk controls are the two capabilities, one apiece — the same rule
  // /sessions and /fees follow. Which of the two buttons appears is answered
  // again inside the bar, and again per record by the actions themselves. The
  // gate above is still the only thing that decides who reads this page.
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(level, viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);
  const bulkCan = {
    markPaid: may('tournaments.fees.markpaid.write'),
    markUnpaid: may('tournaments.fees.markunpaid.write'),
  };
  // E-transfer receipts waiting on this tournament's entries (00248), read
  // only for whoever may settle them.
  const canReview = may('tournaments.fees.markpaid.write');
  const supabase = createAdminClient();

  const { data: tournament } = await supabase.from('tournaments').select('id, name, season_id').eq('id', id).single();
  if (!tournament) notFound();

  const tiers = unwrap(
    await supabase
      .from('tournament_fee_tiers')
      .select('id, tournament_id, name, amount_cents, is_default, sort_order, applies_to, created_at')
      .eq('tournament_id', id)
      .order('sort_order'),
    'TRN-104',
  ) as TournamentFeeTier[];
  const tierById = new Map(tiers.map((t) => [t.id, t]));

  // Owed list: every player entered in any of this tournament's events, from
  // both singles participants and doubles pairs, excluding withdrawn entries.
  const events = unwrap(
    await supabase.from('tournament_events').select('id').eq('tournament_id', id),
    'TRN-104',
  );
  const eventIds = events.map((e) => e.id);

  const playerIds = new Set<string>();
  if (eventIds.length > 0) {
    const [participants, pairs] = await Promise.all([
      supabase
        .from('tournament_participants')
        .select('player_id')
        .in('event_id', eventIds)
        .neq('status', 'withdrawn'),
      supabase
        .from('tournament_pairs')
        .select('player1_id, player2_id')
        .in('event_id', eventIds)
        .neq('status', 'withdrawn'),
    ]);
    for (const row of participants.data ?? []) playerIds.add(row.player_id);
    // An external team (00269) has no member ids and owes the club nothing here.
    for (const row of pairs.data ?? []) {
      if (row.player1_id) playerIds.add(row.player1_id);
      if (row.player2_id) playerIds.add(row.player2_id);
    }
  }

  const liveEntrants = new Set(playerIds);

  // Entry fees off the club's one ledger (00094), which is also where the
  // /fees page and the member's own screen read them — so "who has paid for
  // this tournament" and "what does this member owe" can no longer disagree.
  // fee_type is not optional: without it this reads every member's dues and
  // every reinstatement in the club through a capability that buys neither.
  const ledger = unwrap(
    await supabase
      .from('club_fees')
      .select('id, player_id, manual_name, manual_email, tier_id, amount_cents, paid_at, method')
      .eq('tournament_id', id)
      .eq('fee_type', 'tournament'),
    'TRN-104',
  ) as (Pick<ClubFee, 'id' | 'player_id' | 'tier_id' | 'amount_cents' | 'paid_at' | 'method'> & {
    manual_name: string | null;
    manual_email: string | null;
  })[];
  // A non-member a Google Form entered (00283) owes a NAMED row: player_id is
  // null. Everything below is keyed by player id, so those rows are split off
  // here and listed in their own section rather than read as a null member.
  const fees = ledger.filter((f) => f.player_id != null);
  const nonMemberFees: NonMemberFeeRow[] = ledger
    .filter((f) => f.player_id == null)
    .map((f) => {
      const waived = isWaivedFee(f);
      return {
        id: f.id,
        name: f.manual_name ?? 'A non-member',
        email: f.manual_email,
        amountCents: f.amount_cents,
        paid: Boolean(f.paid_at) && !waived,
        waived,
        method: f.method,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const feeByPlayer = new Map(fees.map((f) => [f.player_id, f]));
  const submissionByPlayer = new Map(
    (canReview ? await loadPendingSubmissions(supabase, { tournamentId: id }) : []).map((s) => [s.playerId, s]),
  );
  const money = (cents: number | null) => (cents != null ? `$${(cents / 100).toFixed(2)}` : 'No amount');
  const reviewControls = (playerName: string, playerId: string) => {
    const s = submissionByPlayer.get(playerId);
    return s ? (
      <SubmissionActions
        submissionId={s.id}
        memberName={playerName}
        line={`${tournament.name} entry`}
        amount={money(s.amountCents)}
        reference={s.reference}
        proofHref={s.hasScreenshot ? `/tournaments/${id}/fees/proof/${s.id}` : null}
        method={s.method}
        feeType="tournament"
      />
    ) : null;
  };

  // WHO IS ON THIS PAGE: everyone currently entered, PLUS everyone who has a
  // fee row for this tournament whether or not they still are.
  //
  // The second half is not tidiness. Self-withdrawal is allowed right up until
  // the draw is published, and a withdrawal does not cancel the fee — an entry
  // that was made is a fact, and a ledger that deletes its own rows when
  // somebody changes their mind cannot be reconciled. The member's own /fees
  // screen reads the ledger and shows it, so a row this page hid would be money
  // one side could see and the other side could not settle. The exemptions are
  // applied the same way and for the same reason: an entrant promoted to exec
  // after entering keeps the fee they already owe.
  for (const fee of fees) playerIds.add(fee.player_id as string);

  // Chunked, and re-sorted here: the per-chunk `.order('full_name')` orders
  // within a request, so the concatenation has to be sorted again.
  const roster = (unwrap(
    await selectInChunks(Array.from(playerIds), (ids) =>
      supabase
        .from('players')
        // membership_type is what DECIDES the price (00094): the tiers name
        // membership groups, and selectFeeTier reads this column to pick one.
        // Without it every row on this page — and every dialog opened from one
        // — falls back to the tournament's default tier, which on the live
        // tournament is the $25 External price for members who owe $15.
        .select('id, full_name, email, avatar_url, is_exec, fee_exempt, membership_type')
        .in('id', ids)
        .order('full_name') as never
    ),
    'TRN-104',
  ) as (Pick<Player, 'id' | 'full_name' | 'email' | 'avatar_url'> & {
    is_exec: boolean; fee_exempt: boolean; membership_type: MembershipType | null;
  })[]).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const players = roster.filter(
    (p) => feeByPlayer.has(p.id) || (!p.is_exec && !p.fee_exempt),
  );

  // THE GROUP EACH MEMBER ENTERS AS (00260), which is what prices an entry that
  // has no ledger row yet: membership_type corrected by this season's club fee.
  // The dialogs opened from each row get it too, so the price they prefill is
  // the price ensureEntryFees would have written.
  const effectiveById = await loadEntryMemberships(supabase, tournament.season_id, players);
  if (!effectiveById) throw new AppError('TRN-105');
  const groupOf = (p: (typeof players)[number]) => effectiveById.get(p.id) ?? p.membership_type;
  // Said beside the tier when the club fee changed the group, so the price is
  // not a mystery to the exec reading it. Only for a quote, never a ledger row:
  // a recorded price is a snapshot and the group today did not set it.
  const groupNote = (p: (typeof players)[number], source: string) => {
    const group = groupOf(p);
    if (source === 'ledger' || group === (p.membership_type ?? 'internal')) return null;
    if (group !== 'internal') return `Fee unpaid: priced as ${formatMembershipType(group)}`;
    return p.is_exec || p.fee_exempt ? 'Exempt: priced as Internal' : 'Club fee paid: priced as Internal';
  };

  // WAIVED IS NOT PAID, and this page was the last fee surface in the app that
  // said otherwise — a waiver is stored as a paid row with amount_cents 0 and
  // method 'waived' (fee-status.ts), so `Boolean(paid_at)` rendered a green
  // "Paid · $0.00" for a fee the club deliberately wrote off. /admin/fees and
  // the member's own screen have both read it correctly for a while; this now
  // agrees with them.
  const stateOf = (fee?: { paid_at: string | null; method: string | null }) => {
    const waived = isWaivedFee(fee);
    return { waived, paid: Boolean(fee?.paid_at) && !waived };
  };

  const paidCount = players.filter((p) => stateOf(feeByPlayer.get(p.id)).paid).length;
  const waivedCount = players.filter((p) => stateOf(feeByPlayer.get(p.id)).waived).length;
  const outstandingCount = players.length - paidCount - waivedCount;

  // WHAT IS SELECTABLE, and `items` / `visibleIds` have to agree with which rows
  // actually carry a checkbox or SelectAllCheckbox ticks rows that have none.
  // Every row of this table is one entrant and every one of them is selectable,
  // withdrawn entries included — their fee is still on the books, which is the
  // whole reason they are on the page. `visibleIds` is the lot because this table
  // has no client-side filter: everything it holds is on screen. Keyed by PLAYER
  // id, since that plus the tournament is what the actions take.
  const selectableEntrants = players.map((p) => ({ id: p.id, label: p.full_name }));
  // AND THERE HAS TO BE SOMETHING TO SELECT: a tournament nobody owes for renders
  // "No players owe fees" under an otherwise empty table, and a select-all box
  // above that has nothing to tick.
  const canBulk = (bulkCan.markPaid || bulkCan.markUnpaid) && selectableEntrants.length > 0;
  // The same paid/waived flags each row renders from, as a map for the bulk bar.
  // A SNAPSHOT, used only to say how many of a selection an action applies to and
  // to grey out a button that applies to none of it — never to filter the ids
  // that are sent. See lib/fee-bulk-eligibility for why that distinction matters.
  //
  // AN ENTRANT WITH NO LEDGER ROW READS AS 'unpaid' HERE — stateOf() takes an
  // undefined fee and reports neither paid nor waived — so Mark Paid counts them
  // as eligible and the dialog can say "All N selected." That count is honest:
  // the action really will record a payment for them. The PRICE it records is the
  // known exception — with no row there is no snapshot to keep, so it falls back
  // to this tournament's is_default tier rather than their membership's tier,
  // which the single-row dialog would have used. Stated in full, with why it is
  // not fixed, in lib/actions/bulk.ts.
  const feeStates: Record<string, FeeRowState> = {};
  for (const p of players) {
    const { paid, waived } = stateOf(feeByPlayer.get(p.id));
    feeStates[p.id] = waived ? 'waived' : paid ? 'paid' : 'unpaid';
  }

  return (
    <div className="space-y-6">
      <Link href={`/tournaments/${id}`} className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors rounded">
        <ArrowLeft className="w-4 h-4" />
        Back to Tournament
      </Link>

      <PageHeader className="no-period" title={`${tournament.name}: Fees`} watermark="F" />

      <TournamentFeeActions mode="tiers" tournamentId={id} tiers={tiers} />

      {/* Summary */}
      {/* Paid + Waived + Outstanding = the rows in the table below, by
          construction — Outstanding is the remainder rather than its own test,
          the same shape /admin/fees uses. Waived appears only when the club has
          actually waived somebody. */}
      <div className={`grid gap-4 ${waivedCount > 0 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Paid</p>
          <p className="text-2xl font-bold font-mono text-[var(--color-success)]">{paidCount}</p>
        </Card>
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Outstanding</p>
          {/* Amber only when there is something to act on. A permanently amber
              zero trains people to ignore the colour that matters. */}
          <p className={`text-2xl font-bold font-mono ${outstandingCount > 0 ? 'text-[var(--color-warning)]' : ''}`}>
            {outstandingCount}
          </p>
        </Card>
        {waivedCount > 0 && (
          <Card>
            <p className="text-xs text-[var(--text-muted)] uppercase">Waived</p>
            <p className="text-2xl font-bold font-mono">{waivedCount}</p>
          </Card>
        )}
      </div>

      {/* Fee Table */}
      {/* THE PROVIDER, THE TABLE AND THE BAR, in that order — the shape /sessions
          uses. The provider goes round both because the checkboxes the server
          renders inside the rows read it from where they land, and the bar reads
          the same selection back out. */}
      <SelectionProvider items={selectableEntrants} visibleIds={selectableEntrants.map((e) => e.id)}>
      <Card padding={false}>
        <ResponsiveTable
          cards={players.map((player) => {
            const fee = feeByPlayer.get(player.id);
            const { paid, waived } = stateOf(fee);
            // ONE DERIVATION, shared with the dialog this row opens. The old
            // fallback was the tournament's default tier regardless of who the
            // member is; quoteEntryFee asks selectFeeTier, which is the rule the
            // fee was actually written by.
            const quote = quoteEntryFee(groupOf(player), tiers, fee);
            const tier = quote.tierId ? tierById.get(quote.tierId) : null;
            const owedCents = quote.amountCents;
            const note = groupNote(player, quote.source);
            return (
              <TableCard
                key={player.id}
                title={
                  <div className="flex items-center gap-3">
                    {canBulk && <RowSelectCheckbox id={player.id} label={player.full_name} />}
                    {personTitle(
                      player.full_name,
                      // Says WHY somebody with no live entry is on the list, rather
                      // than leaving an exec to wonder.
                      liveEntrants.has(player.id) ? player.email ?? '' : 'Withdrawn · fee still on the books',
                      player.avatar_url,
                      player.id,
                    )}
                  </div>
                }
                value={owedCents != null ? `$${(owedCents / 100).toFixed(2)}` : '-'}
                badges={
                  <>
                    <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                      {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                    </Badge>
                    {submissionByPlayer.has(player.id) && <Badge variant="neutral">Submitted</Badge>}
                    {note && <Badge variant="neutral">{note}</Badge>}
                  </>
                }
                fields={[
                  { label: 'Tier', value: tier?.name ?? '-' },
                  { label: 'Method', value: (paid && fee?.method) || '-' },
                ]}
                actions={
                  <>
                    {reviewControls(player.full_name, player.id)}
                    <TournamentFeeActions
                      mode="mark"
                      tournamentId={id}
                      playerId={player.id}
                      playerName={player.full_name}
                      tiers={tiers}
                      paid={paid}
                      waived={waived}
                      membershipType={groupOf(player)}
                      fee={fee ?? null}
                    />
                  </>
                }
              />
            );
          })}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {canBulk && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase w-px">
                    <SelectAllCheckbox noun="entrant" />
                  </th>
                )}
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Player</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Tier</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {players.map((player) => {
                const fee = feeByPlayer.get(player.id);
                const { paid, waived } = stateOf(fee);
                // Same derivation as the card above — see the note there.
                const quote = quoteEntryFee(groupOf(player), tiers, fee);
                const tier = quote.tierId ? tierById.get(quote.tierId) : null;
                const owedCents = quote.amountCents;
                const note = groupNote(player, quote.source);
                return (
                  <tr key={player.id} className="hover:bg-[var(--border-hover)] transition-colors">
                    {canBulk && (
                      <td className="px-4 py-3 w-px">
                        <RowSelectCheckbox id={player.id} label={player.full_name} />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <AvatarChip name={player.full_name} src={player.avatar_url} size="sm" id={player.id} />
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">{player.full_name}</p>
                          <p className="text-xs text-[var(--text-muted)]">
                            {liveEntrants.has(player.id) ? player.email : 'Withdrawn · fee still on the books'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                        {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                      </Badge>
                      {submissionByPlayer.has(player.id) && (
                        <span className="ml-2">
                          <Badge variant="neutral">Submitted</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {tier?.name ?? '-'}
                      {note && <p className="text-xs text-[var(--text-muted)]">{note}</p>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-[var(--text-primary)]">
                        {owedCents != null ? `$${(owedCents / 100).toFixed(2)}` : '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {(paid && fee?.method) || '-'}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {reviewControls(player.full_name, player.id)}
                      <TournamentFeeActions
                        mode="mark"
                        tournamentId={id}
                        playerId={player.id}
                        playerName={player.full_name}
                        tiers={tiers}
                        paid={paid}
                        waived={waived}
                        membershipType={groupOf(player)}
                        fee={fee ?? null}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveTable>
        {players.length === 0 && (
          <p className="text-center text-[var(--text-muted)] py-8">No players owe fees for this tournament</p>
        )}
      </Card>
      {nonMemberFees.length > 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
            Non-member entries <span className="font-normal text-[var(--text-muted)]">({nonMemberFees.length})</span>
          </h2>
          <NonMemberFees rows={nonMemberFees} canMarkPaid={bulkCan.markPaid} canMarkUnpaid={bulkCan.markUnpaid} />
        </Card>
      )}
      {canBulk && (
        <BulkTournamentFeeActions
          tournamentId={id}
          states={feeStates}
          canMarkPaid={bulkCan.markPaid}
          canMarkUnpaid={bulkCan.markUnpaid}
        />
      )}
      </SelectionProvider>
    </div>
  );
}
