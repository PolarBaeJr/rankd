import Link from 'next/link';
import { unwrap } from '@badminton/shared';
import { Atomic, Badge } from '@badminton/ui';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import {
  canUploadReceipt,
  headlineAmount,
  headlineBadge,
  money,
  outstandingFooter,
  receiptMeta,
  settlementOf,
  summariseFees,
  type FeeLine,
} from '@/lib/fees';
import { latestSubmission, readOwnFees, seasonFeeFor, type OwnFeeRow } from '@/lib/member-fees';
import { EtransferForm } from './etransfer-form';

// A MEMBER'S OWN STATEMENT, and the way to pay it. This was /fees; that route
// now redirects here. Rendered only for an approved member with the fees
// switch on (the page decides).
//
// Every read is the SESSION client, so RLS says "yours only" as well as the
// explicit player filter: club_fees_select_own, fee_submissions_select_own,
// and club_events' member read for the event names.

type Season = {
  id: string;
  name: string;
  end_date: string | null;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
};

type Player = {
  id: string;
  status: string;
  is_exec: boolean | null;
  fee_exempt: boolean | null;
};

/** A line of the statement, with what sending a receipt for it needs. */
type PayLine = FeeLine & { feeId: string | null; duesSeasonId: string | null; row: OwnFeeRow | undefined };

export async function MemberSection({
  player,
  season,
  etransferEmail,
  sfssPurchaseUrl,
}: {
  player: Player;
  season: Season | null;
  etransferEmail: string | null;
  sfssPurchaseUrl: string | null;
}) {
  const supabase = await createServerSupabaseClient();
  const exempt = Boolean(player.is_exec || player.fee_exempt);
  const feeRows = await readOwnFees(supabase, player.id);

  const lines: PayLine[] = [];
  let seasonLine: FeeLine | null = null;

  // ── Club dues ─────────────────────────────────────────────────────────
  // One row per member per season (club_fees_dues_player_season_key). A member
  // with no row yet owes the season's price by status, keyed on the season.
  if (season && !exempt) {
    const clubFee = feeRows.find((f) => f.fee_type === 'dues' && f.season_id === season.id);
    const { paid, waived } = settlementOf(clubFee ?? {});
    const line: PayLine = {
      key: clubFee?.id ?? `season-${season.id}`,
      kind: 'season',
      name: `${season.name} membership`,
      owedCents: clubFee?.paid_at != null ? clubFee.amount_cents : (clubFee?.amount_cents ?? seasonFeeFor(player.status, season)),
      recordedCents: clubFee?.amount_cents ?? null,
      paid,
      waived,
      paidAt: clubFee?.paid_at ?? null,
      method: clubFee?.method ?? null,
      reference: clubFee?.reference ?? null,
      feeId: clubFee?.id ?? null,
      duesSeasonId: clubFee ? null : season.id,
      row: clubFee,
    };
    seasonLine = line;
    lines.push(line);
  }

  // ── Tournament entries and club events, named ─────────────────────────
  // A fee row knows which tournament or event it is for, not what it is
  // called. One read each for the names; a name the member can no longer read
  // falls back to a generic label rather than dropping a real fee.
  const entryFees = feeRows.filter((f) => f.fee_type === 'tournament' && f.tournament_id);
  const eventFees = feeRows.filter((f) => f.fee_type === 'event' && f.club_event_id);
  const [tournaments, events] = await Promise.all([
    entryFees.length > 0
      ? supabase
          .from('tournaments')
          .select('id, name')
          .in('id', [...new Set(entryFees.map((f) => f.tournament_id as string))])
          .then((r) => unwrap<{ id: string; name: string }[]>(r))
      : Promise.resolve([] as { id: string; name: string }[]),
    eventFees.length > 0
      ? supabase
          .from('club_events')
          .select('id, title')
          .in('id', [...new Set(eventFees.map((f) => f.club_event_id as string))])
          .then((r) => unwrap<{ id: string; title: string }[]>(r))
      : Promise.resolve([] as { id: string; title: string }[]),
  ]);
  const tournamentName = new Map(tournaments.map((t) => [t.id, t.name]));
  const eventName = new Map(events.map((e) => [e.id, e.title]));

  const fromRow = (fee: OwnFeeRow, kind: FeeLine['kind'], name: string): PayLine => {
    const { paid, waived } = settlementOf(fee);
    return {
      key: fee.id,
      kind,
      name,
      owedCents: fee.amount_cents,
      recordedCents: fee.amount_cents,
      paid,
      waived,
      paidAt: fee.paid_at,
      method: fee.method,
      reference: fee.reference,
      feeId: fee.id,
      duesSeasonId: null,
      row: fee,
    };
  };

  lines.push(
    ...entryFees
      .map((f) => fromRow(f, 'tournament', tournamentName.get(f.tournament_id as string) ?? 'Tournament entry'))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ...eventFees
      .map((f) => fromRow(f, 'event', eventName.get(f.club_event_id as string) ?? 'Club event'))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Charged regardless of exemption: a reinstatement is not a due.
    ...feeRows.filter((f) => f.fee_type === 'reinstatement').map((f) => fromRow(f, 'reinstatement', 'Reinstatement fee')),
  );

  const summary = summariseFees(lines, { exempt });
  const badge = headlineBadge(summary);
  const footer = outstandingFooter(seasonLine, season?.end_date);
  const outstanding = summary.outstanding as PayLine[];
  const duesOutstanding = outstanding.some((l) => l.kind === 'season');

  return (
    <>
      {/* ── OUTSTANDING ───────────────────────────────────────────── */}
      <section className="card-base fees-outstanding" data-tour="membership-statement">
        <div className="fees-label">Outstanding</div>
        <div className="fees-figure-row">
          <div className="fees-figure">{headlineAmount(summary)}</div>
          <Badge variant={badge.tone}>{badge.label}</Badge>
        </div>
        {summary.unknownCount > 0 && (
          <p className="fees-caveat">
            Plus {summary.unknownCount} {summary.unknownCount === 1 ? 'entry' : 'entries'} with no price
            recorded yet.
          </p>
        )}
        {exempt && (
          <p className="fees-caveat">
            {player.is_exec ? (
              <>
                Club and competition fees are not charged to the{' '}
                <Link href="/exec" className="fees-link">
                  executive team
                </Link>
                .
              </>
            ) : (
              'You have been exempted from club and competition fees.'
            )}
          </p>
        )}
        {footer && <div className="fees-foot">{footer}</div>}
      </section>

      {/* ── PAY ───────────────────────────────────────────────────── */}
      {outstanding.length > 0 && (
        <section id="pay" className="fees-section" style={{ scrollMarginTop: 80, order: 1 }}>
          <h2 className="fees-section-label">Pay and send your receipt</h2>
          {etransferEmail || duesOutstanding ? (
            <p className="fees-note" style={{ marginTop: 0 }}>
              {etransferEmail && (
                <>
                  Send each amount by Interac e-Transfer to <Atomic>{etransferEmail}</Atomic>.{' '}
                </>
              )}
              {duesOutstanding && (
                <>
                  Your membership can {etransferEmail ? 'also ' : ''}be bought on the{' '}
                  {sfssPurchaseUrl ? (
                    <a
                      href={sfssPurchaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="fees-link"
                    >
                      Campus Rec website
                    </a>
                  ) : (
                    'Campus Rec website'
                  )}
                  .{' '}
                </>
              )}
              Upload a screenshot of the e-Transfer confirmation or the Campus Rec receipt, with its
              reference or receipt number. The site works out which it is, and an exec checks it and
              marks the fee paid.
            </p>
          ) : (
            <p className="fees-note" style={{ marginTop: 0 }}>
              Ask an exec how to pay.
            </p>
          )}
          <ul className="fees-receipts">
            {outstanding.map((l) => {
              const latest = latestSubmission(l.row);
              const waiting = latest?.status === 'submitted';
              const payable = l.kind !== 'reinstatement' && l.owedCents != null;
              const uploadable = canUploadReceipt({
                kind: l.kind,
                owedCents: l.owedCents,
                waiting,
                etransferConfigured: etransferEmail != null,
              });
              return (
                <li key={l.key} className="fees-receipt" style={{ display: 'block' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <div className="fees-receipt-name">{l.name}</div>
                    <div className="fees-receipt-amount">{money(l.owedCents)}</div>
                  </div>
                  <div className="fees-receipt-meta">
                    {waiting && 'Submitted, awaiting confirmation'}
                    {latest?.status === 'rejected' && `Rejected: ${latest.reject_reason ?? ''}`}
                    {l.kind === 'reinstatement' && 'Settled with an exec'}
                    {l.kind !== 'reinstatement' && l.owedCents == null && 'No price recorded yet. Ask an exec.'}
                    {payable && !waiting && !uploadable && 'Ask an exec how to pay this one.'}
                    {waiting && latest?.reference && (
                      <>
                        {' · '}
                        <Atomic>{latest.reference}</Atomic>
                      </>
                    )}
                  </div>
                  {uploadable && (
                    <EtransferForm
                      feeId={l.feeId}
                      duesSeasonId={l.duesSeasonId}
                      dues={l.kind === 'season'}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ── RECEIPTS ──────────────────────────────────────────────── */}
      <section className="fees-section">
        <h2 className="fees-section-label">Receipts</h2>
        {summary.receipts.length === 0 ? (
          <p className="fees-empty">
            Nothing recorded yet. An exec marks a fee paid once they have the money, and it appears here.
          </p>
        ) : (
          <ul className="fees-receipts">
            {summary.receipts.map((l) => {
              const meta = receiptMeta(l);
              return (
                <li key={l.key} className="fees-receipt">
                  <div className="fees-receipt-main">
                    <div className="fees-receipt-name">{l.name}</div>
                    <div className="fees-receipt-meta">
                      {meta.text}
                      {meta.reference && (
                        <>
                          {meta.text && ' · '}
                          <Atomic>{meta.reference}</Atomic>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="fees-receipt-side">
                    <div className="fees-receipt-amount">{money(l.recordedCents)}</div>
                    <div className={l.waived ? 'fees-receipt-state is-waived' : 'fees-receipt-state'}>
                      {l.waived ? 'WAIVED' : 'PAID'}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="fees-closing">
        IF PAYING IS A PROBLEM, WRITE TO{' '}
        <Link href="/exec" className="fees-link">
          THE EXEC
        </Link>
        .
        <br />
        HARDSHIP REQUESTS ARE ROUTINE AND PRIVATE.
      </p>
    </>
  );
}
