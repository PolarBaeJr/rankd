import { Badge, TableCard, Atomic, AvatarChip } from '@badminton/ui';
import { duesFor, type OutstandingMember, type PendingSubmission } from '@/lib/fee-submissions';
import type { FeeTableRow } from './fee-table';
import { FeeActions, MarkNamedFeePaid, RemoveManualFee } from './fee-actions';
import { RemindButton } from './submission-actions';
import { reviewAction } from './submitted-card';

// WHO STILL OWES, for the season in view (00248): roster dues and club-event
// lines, one row per member, drawn as the Unpaid view of the /fees list. A
// holder of fees.clubfees.markpaid.write gets the reminders, and only for the
// running season; a reminder is an in-app notification and nothing else.
//
// Row builders for FeeTable rather than a card of their own. The page fetches
// the members (loadOutstandingMembers) behind fees.clubfees.read.

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function remindedText(at: Date | null, now: Date): string | null {
  if (!at) return null;
  const days = Math.floor((now.getTime() - at.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Reminded today';
  return `Reminded ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

type OutstandingSeason = {
  id: string;
  name: string;
  active_flag: boolean;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
};

/** A named dues row nobody has paid yet: a Google Form's non-member, or a fee added by hand. */
export type UnpaidNamedFee = {
  id: string;
  manual_name: string | null;
  manual_email: string | null;
  amount_cents: number | null;
};

const th = 'px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase';

export const OUTSTANDING_HEAD = (
  <tr className="border-b border-[var(--border)]">
    <th className={`${th} text-left`}>Member</th>
    <th className={`${th} text-left`}>Owes for</th>
    <th className={`${th} text-right`}>Amount</th>
    <th className={`${th} text-left`}>Status</th>
    <th className={`${th} text-right`}>Actions</th>
  </tr>
);

/** "Remind unpaid", for the list's heading: everybody a reminder is due to. */
export function remindUnpaidAction(members: OutstandingMember[], remindable: boolean) {
  const due = members.filter((m) => m.decision.remind).map((m) => m.id);
  return remindable && due.length > 0 ? (
    <RemindButton
      playerIds={due}
      label="Remind unpaid"
      noun={`${due.length} ${due.length === 1 ? 'member' : 'members'}`}
    />
  ) : undefined;
}

export function outstandingRows({
  members,
  named,
  season,
  now,
  canRemind,
  canMarkPaid,
  pendingByFee,
}: {
  members: OutstandingMember[];
  named: UnpaidNamedFee[];
  season: OutstandingSeason;
  now: Date;
  canRemind: boolean;
  canMarkPaid: boolean;
  /** Receipts waiting, by fee id: a line with one gets its Review button. */
  pendingByFee: ReadonlyMap<string, PendingSubmission>;
}): FeeTableRow[] {
  const remindable = canRemind && season.active_flag;

  const state = (m: OutstandingMember) => {
    if (m.decision.remind === false && m.decision.reason === 'submitted') {
      return <Badge variant="neutral">Receipt sent</Badge>;
    }
    return <Badge variant="warning">Unpaid</Badge>;
  };
  const note = (m: OutstandingMember) => {
    const parts = [
      m.pending && m.decision.remind ? 'A receipt is waiting on one line' : null,
      remindedText(m.remindedAt, now),
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  };
  const actions = (m: OutstandingMember) => {
    const reviews = canMarkPaid
      ? m.lines.flatMap((l) => {
          const waiting = l.feeId ? pendingByFee.get(l.feeId) : undefined;
          return waiting ? [<span key={waiting.id}>{reviewAction(waiting)}</span>] : [];
        })
      : [];
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {reviews}
        {m.lines.some((l) => l.feeType === 'dues') && (
          <FeeActions
            playerId={m.id}
            playerName={m.fullName}
            seasonId={season.id}
            seasonName={season.name}
            defaultFeeCents={duesFor(m.status, season)}
            paid={false}
            waived={false}
          />
        )}
        {remindable && m.decision.remind ? (
          <RemindButton playerIds={[m.id]} label="Remind" noun={m.fullName} />
        ) : null}
      </div>
    );
  };

  const memberRows = members.map((m) => ({
    id: m.id,
    name: m.fullName,
    email: m.email,
    selectable: false,
    card: (
      <TableCard
        key={m.id}
        title={
          <div className="flex items-center gap-3">
            <AvatarChip name={m.fullName} src={m.avatarUrl ?? undefined} size="sm" id={m.id} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)]">{m.fullName}</p>
              <p className="text-xs font-normal text-[var(--text-muted)]">{m.lines.map((l) => l.name).join(', ')}</p>
            </div>
          </div>
        }
        value={<Atomic>{money(m.totalCents)}</Atomic>}
        badges={state(m)}
        fields={note(m) ? [{ label: 'Reminder', value: note(m) }] : undefined}
        actions={actions(m)}
      />
    ),
    row: (
      <tr key={m.id} className="hover:bg-[var(--border-hover)] transition-colors">
        <td className="px-4 py-3">
          <div className="flex items-center gap-3">
            <AvatarChip name={m.fullName} src={m.avatarUrl ?? undefined} size="sm" id={m.id} />
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{m.fullName}</p>
              {m.email && <p className="text-xs text-[var(--text-muted)]">{m.email}</p>}
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
          {m.lines.map((l) => (
            <span key={l.feeId ?? l.name} className="block">
              {l.name}
              {l.amountCents != null ? ` · ${money(l.amountCents)}` : ' · no amount'}
              {l.pending ? ' · receipt sent' : ''}
            </span>
          ))}
        </td>
        <td className="px-4 py-3 text-right">
          <Atomic className="font-mono text-[var(--text-primary)]">{money(m.totalCents)}</Atomic>
        </td>
        <td className="px-4 py-3">
          {state(m)}
          {note(m) && <p className="text-xs text-[var(--text-muted)] mt-1">{note(m)}</p>}
        </td>
        <td className="px-4 py-3 text-right">{actions(m)}</td>
      </tr>
    ),
  }));

  // Named rows owe dues too, and settle the same way they do under All. They
  // have no account, so no reminder can reach them.
  const namedRows = named.map((fee) => {
    const name = fee.manual_name ?? '';
    const amount = fee.amount_cents != null ? money(fee.amount_cents) : 'No amount';
    const waiting = canMarkPaid ? pendingByFee.get(fee.id) : undefined;
    const controls = (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {waiting && reviewAction(waiting)}
        {canMarkPaid && (
          <MarkNamedFeePaid id={fee.id} name={name} seasonName={season.name} amountCents={fee.amount_cents} />
        )}
        <RemoveManualFee id={fee.id} name={name} />
      </div>
    );
    return {
      id: fee.id,
      name,
      email: fee.manual_email,
      selectable: false,
      card: (
        <TableCard
          key={fee.id}
          title={
            <div className="flex items-center gap-3">
              <AvatarChip name={name} size="sm" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">{name}</p>
                <p className="text-xs font-normal text-[var(--text-muted)]">{fee.manual_email ?? 'Manual entry'}</p>
              </div>
            </div>
          }
          value={<Atomic>{amount}</Atomic>}
          badges={<Badge variant="warning">Unpaid</Badge>}
          fields={[{ label: 'Owes for', value: `${season.name} dues` }]}
          actions={controls}
        />
      ),
      row: (
        <tr key={fee.id} className="hover:bg-[var(--border-hover)] transition-colors">
          <td className="px-4 py-3">
            <div className="flex items-center gap-3">
              <AvatarChip name={name} size="sm" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{name}</p>
                <p className="text-xs text-[var(--text-muted)]">{fee.manual_email ?? 'Manual entry'}</p>
              </div>
            </div>
          </td>
          <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
            {season.name} dues{waiting ? ' · receipt sent' : ''}
          </td>
          <td className="px-4 py-3 text-right">
            <Atomic className="font-mono text-[var(--text-primary)]">{amount}</Atomic>
          </td>
          <td className="px-4 py-3">
            <Badge variant="warning">Unpaid</Badge>
          </td>
          <td className="px-4 py-3 text-right">{controls}</td>
        </tr>
      ),
    };
  });

  return [...memberRows, ...namedRows];
}
