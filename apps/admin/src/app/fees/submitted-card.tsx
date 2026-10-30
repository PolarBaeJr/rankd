import { formatPaymentMethod } from '@badminton/shared';
import { Badge, TableCard, Atomic } from '@badminton/ui';
import { receiptCheckNote, type PendingSubmission } from '@/lib/fee-submissions';
import type { FeeTableGroup, FeeTableRow } from './fee-table';
import { KeptScreenshotActions, SubmissionActions } from './submission-actions';

// PAYMENT RECEIPTS WAITING FOR AN EXEC (00248, 00253): dues and club events,
// oldest first. "Paid by" is what the member's browser read off the receipt;
// Unclear when it could not tell, and confirming then asks. Drawn as the To
// review view of the /fees list, only for a holder of
// fees.clubfees.markpaid.write, the capability that settles them; tournament
// entries are on their own page.
//
// The server reads each new receipt itself (00297) and confirms the routine
// ones. A row waiting here says "Checking..." while that read runs, or why it
// was held. The ones it confirmed are not listed: the owner found the list
// noise, and a confirmed fee is undone from the member's fee like any other.
//
// These are row builders for FeeTable rather than a card of their own, so the
// receipts share the list's search and View menu. The page fetches the
// submissions (loadPendingSubmissions) behind the same capability.

const money = (cents: number | null) => (cents != null ? `$${(cents / 100).toFixed(2)}` : 'No amount');

// Split by where the money went. An e-transfer lands in the club's own account,
// so it is checked against the club's bank. An Campus Rec purchase is paid to
// Campus Rec and never reaches the club, so it is checked against Campus Rec's records.
// Unclear receipts sit apart until an exec picks the method on confirm.
export const RECEIPT_GROUPS: FeeTableGroup[] = [
  { id: 'e_transfer', title: 'E-transfer', sub: "Paid into the club's account. Check each against the club's bank." },
  { id: 'sfu_rec', title: 'Campus Rec', sub: 'Paid to Campus Rec, not to the club. Check each against Campus Rec.' },
  { id: 'unclear', title: 'Method unclear', sub: 'The receipt did not say how it was paid. Confirming asks which.' },
];

const paidBy = (method: string | null) =>
  method ? formatPaymentMethod(method) : <Badge variant="warning">Unclear</Badge>;

const th = 'px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase';
const sentOn = (s: PendingSubmission) =>
  new Date(s.submittedAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

/** The Review button and its dialog, for a receipt. Also drawn on a fee's own row in the list. */
export function reviewAction(s: PendingSubmission) {
  return (
    <SubmissionActions
      submissionId={s.id}
      memberName={s.playerName}
      line={s.line}
      amount={money(s.amountCents)}
      amountCents={s.amountCents}
      receiptAmountCents={s.receiptAmountCents}
      reference={s.reference}
      proofHref={s.hasScreenshot ? `/fees/proof/${s.id}` : null}
      method={s.method}
      feeType={s.feeType}
      fromForm={s.fromForm}
      readableScreenshot={s.readableScreenshot}
    />
  );
}

// Fixed widths so the columns line up from one method group to the next.
export const RECEIPT_TABLE_CLASS = 'w-full min-w-[60rem] table-fixed';
export const RECEIPT_COLGROUP = (
  <colgroup>
    <col className="w-[20%]" />
    <col className="w-[20%]" />
    <col className="w-[9%]" />
    <col className="w-[10%]" />
    <col className="w-[11%]" />
    <col className="w-[10%]" />
    <col className="w-[20%]" />
  </colgroup>
);
export const RECEIPT_HEAD = (
  <tr className="border-b border-[var(--border)]">
    <th className={`${th} text-left`}>Member</th>
    <th className={`${th} text-left`}>For</th>
    <th className={`${th} text-right`}>Amount</th>
    <th className={`${th} text-left`}>Paid by</th>
    <th className={`${th} text-left`}>Reference</th>
    <th className={`${th} text-left`}>Sent</th>
    <th className={`${th} text-right`}>Actions</th>
  </tr>
);

/** One row per receipt waiting, grouped by RECEIPT_GROUPS on `method`. */
export function receiptRows(submissions: PendingSubmission[]): FeeTableRow[] {
  return submissions.map((s) => ({
    id: s.id,
    name: s.playerName,
    email: s.playerEmail,
    selectable: false,
    group: s.method ?? 'unclear',
    card: (
      <TableCard
        key={s.id}
        title={
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">{s.playerName}</p>
            <p className="text-xs font-normal text-[var(--text-muted)]">{s.line}</p>
          </div>
        }
        value={<Atomic>{money(s.amountCents)}</Atomic>}
        badges={s.withdrawn ? <Badge variant="warning">Withdrawn</Badge> : undefined}
        fields={[
          ...(receiptCheckNote(s) ? [{ label: 'Check', value: receiptCheckNote(s) }] : []),
          { label: 'Paid by', value: s.fromForm ? `${paidBy(s.method)}, from the Google Form` : paidBy(s.method) },
          { label: 'Reference', value: <Atomic className="font-mono text-xs">{s.reference ?? 'None sent'}</Atomic> },
          { label: 'Sent', value: sentOn(s) },
        ]}
        actions={reviewAction(s)}
      />
    ),
    row: (
      <tr key={s.id} className="hover:bg-[var(--border-hover)] transition-colors">
        <td className="px-4 py-3">
          <p className="text-sm font-medium text-[var(--text-primary)]">{s.playerName}</p>
          {s.playerEmail && <p className="text-xs text-[var(--text-muted)]">{s.playerEmail}</p>}
        </td>
        <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
          {s.line}
          {/* The member left the event after sending this. The fee
              was kept because money may have moved: an exec's call. */}
          {s.withdrawn && (
            <span className="ml-2">
              <Badge variant="warning">Withdrawn</Badge>
            </span>
          )}
          {receiptCheckNote(s) && <p className="text-xs text-[var(--text-muted)]">{receiptCheckNote(s)}</p>}
        </td>
        <td className="px-4 py-3 text-right">
          <Atomic className="font-mono text-[var(--text-primary)]">{money(s.amountCents)}</Atomic>
        </td>
        <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
          {paidBy(s.method)}
          {s.fromForm && <p className="text-xs text-[var(--text-muted)]">From the Google Form</p>}
        </td>
        <td className="px-4 py-3">
          <Atomic className="font-mono text-xs">{s.reference ?? 'None sent'}</Atomic>
        </td>
        <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">{sentOn(s)}</td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end">{reviewAction(s)}</div>
        </td>
      </tr>
    ),
  }));
}

// Confirmed receipts from a Google Form whose screenshot is still on file
// (00288): kept as proof of payment, erased one by one when the person who
// sent it asks through the privacy address. Erasing leaves the fee paid.
export const KEPT_HEAD = (
  <tr className="border-b border-[var(--border)]">
    <th className={`${th} text-left`}>Sender</th>
    <th className={`${th} text-left`}>For</th>
    <th className={`${th} text-right`}>Amount</th>
    <th className={`${th} text-right`}>Actions</th>
  </tr>
);

export function keptRows(kept: PendingSubmission[]): FeeTableRow[] {
  return kept.map((s) => {
    const actions = (
      <KeptScreenshotActions submissionId={s.id} memberName={s.playerName} proofHref={`/fees/proof/${s.id}`} />
    );
    return {
      id: s.id,
      name: s.playerName,
      email: s.playerEmail,
      selectable: false,
      card: (
        <TableCard
          key={s.id}
          title={
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)]">{s.playerName}</p>
              <p className="text-xs font-normal text-[var(--text-muted)]">{s.playerEmail ?? s.line}</p>
            </div>
          }
          value={<Atomic>{money(s.amountCents)}</Atomic>}
          fields={[{ label: 'For', value: s.line }]}
          actions={actions}
        />
      ),
      row: (
        <tr key={s.id} className="hover:bg-[var(--border-hover)] transition-colors">
          <td className="px-4 py-3">
            <p className="text-sm font-medium text-[var(--text-primary)]">{s.playerName}</p>
            {s.playerEmail && <p className="text-xs text-[var(--text-muted)]">{s.playerEmail}</p>}
          </td>
          <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">{s.line}</td>
          <td className="px-4 py-3 text-right">
            <Atomic className="font-mono text-[var(--text-primary)]">{money(s.amountCents)}</Atomic>
          </td>
          <td className="px-4 py-3">
            <div className="flex items-center justify-end whitespace-nowrap">{actions}</div>
          </td>
        </tr>
      ),
    };
  });
}
