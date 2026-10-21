import { formatPaymentMethod } from '@badminton/shared';
import { Badge, Card, EmptyState, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { createAdminClient } from '@/lib/supabase-server';
import { loadPendingSubmissions, type PendingSubmission } from '@/lib/fee-submissions';
import { CardHeading } from './card-heading';
import { KeptScreenshotActions, SubmissionActions } from './submission-actions';

// PAYMENT RECEIPTS WAITING FOR AN EXEC (00248, 00253): dues and club events,
// oldest first. "Paid by" is what the member's browser read off the receipt;
// Unclear when it could not tell, and confirming then asks. Rendered only for a holder of fees.clubfees.markpaid.write,
// the capability that settles them; tournament entries are on their own page.

const money = (cents: number | null) => (cents != null ? `$${(cents / 100).toFixed(2)}` : 'No amount');

// Split by where the money went. An e-transfer lands in the club's own account,
// so it is checked against the club's bank. An Campus Rec purchase is paid to
// Campus Rec and never reaches the club, so it is checked against Campus Rec's records.
// Unclear receipts sit apart until an exec picks the method on confirm.
const RECEIPT_GROUPS: { method: PendingSubmission['method']; title: string; sub: string }[] = [
  { method: 'e_transfer', title: 'E-transfer', sub: "Paid into the club's account. Check each against the club's bank." },
  { method: 'sfu_rec', title: 'Campus Rec', sub: 'Paid to Campus Rec, not to the club. Check each against Campus Rec.' },
  { method: null, title: 'Method unclear', sub: 'The receipt did not say how it was paid. Confirming asks which.' },
];

const paidBy = (method: string | null) =>
  method ? formatPaymentMethod(method) : <Badge variant="warning">Unclear</Badge>;

export async function SubmittedCard() {
  const admin = createAdminClient();
  const [submissions, kept] = await Promise.all([
    loadPendingSubmissions(admin, 'club'),
    loadPendingSubmissions(admin, 'club', 'keptFromForm'),
  ]);

  return (
    <Card padding={false}>
      <CardHeading
        title="Submitted receipts"
        sub="Receipts members sent, grouped by where the money went. Confirm or reject each one."
      />
      {submissions.length === 0 ? (
        <EmptyState title="Nothing waiting" description="No member has a receipt waiting for review." />
      ) : (
        RECEIPT_GROUPS.map((group) => {
          const inGroup = submissions.filter((s) => s.method === group.method);
          if (inGroup.length === 0) return null;
          return (
            <section key={group.title} className="border-t border-[var(--border)]">
              <div className="px-4 pt-4 pb-2">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  {group.title} <span className="font-normal text-[var(--text-muted)]">({inGroup.length})</span>
                </h3>
                <p className="text-xs text-[var(--text-muted)]">{group.sub}</p>
              </div>
              <ReceiptTable submissions={inGroup} />
            </section>
          );
        })
      )}
      {kept.length > 0 && <KeptScreenshots kept={kept} />}
    </Card>
  );
}

// Confirmed receipts from a Google Form whose screenshot is still on file
// (00288): kept as proof of payment, erased one by one when the person who
// sent it asks through the privacy address. Erasing leaves the fee paid.
function KeptScreenshots({ kept }: { kept: PendingSubmission[] }) {
  return (
    <section className="border-t border-[var(--border)]">
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Form screenshots on file <span className="font-normal text-[var(--text-muted)]">({kept.length})</span>
        </h3>
        <p className="text-xs text-[var(--text-muted)]">
          Confirmed payments from a Google Form. Kept as proof of payment; erase one when its sender asks. The payment stays recorded.
        </p>
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {kept.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)]">{s.playerName}</p>
              <p className="text-xs text-[var(--text-muted)]">
                {[s.playerEmail, s.line, money(s.amountCents)].filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="flex items-center whitespace-nowrap">
              <KeptScreenshotActions submissionId={s.id} memberName={s.playerName} proofHref={`/fees/proof/${s.id}`} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}


function ReceiptTable({ submissions }: { submissions: PendingSubmission[] }) {
  return (
    <ResponsiveTable
      cards={submissions.map((s) => (
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
            { label: 'Paid by', value: paidBy(s.method) },
            { label: 'Reference', value: <Atomic className="font-mono text-xs">{s.reference ?? 'None sent'}</Atomic> },
            { label: 'Sent', value: new Date(s.submittedAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) },
          ]}
          actions={
            <SubmissionActions
              submissionId={s.id}
              memberName={s.playerName}
              line={s.line}
              amount={money(s.amountCents)}
              reference={s.reference}
              proofHref={s.hasScreenshot ? `/fees/proof/${s.id}` : null}
              method={s.method}
              feeType={s.feeType}
              fromForm={s.fromForm}
              readableScreenshot={s.readableScreenshot}
            />
          }
        />
      ))}
    >
      {/* Fixed widths so the columns line up from one method group to the next. */}
      <table className="w-full min-w-[60rem] table-fixed">
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[20%]" />
          <col className="w-[9%]" />
          <col className="w-[10%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
          <col className="w-[20%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Member</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">For</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Paid by</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Reference</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Sent</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {submissions.map((s) => (
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
              </td>
              <td className="px-4 py-3 text-right">
                <Atomic className="font-mono text-[var(--text-primary)]">{money(s.amountCents)}</Atomic>
              </td>
              <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">{paidBy(s.method)}</td>
              <td className="px-4 py-3">
                <Atomic className="font-mono text-xs">{s.reference ?? 'None sent'}</Atomic>
              </td>
              <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                {new Date(s.submittedAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' })}
              </td>
              <td className="px-4 py-3">
                {/* A form receipt carries five controls; they wrap rather than scroll the table. */}
                <div className="flex flex-wrap items-center justify-end gap-y-1">
                  <SubmissionActions
                    submissionId={s.id}
                    memberName={s.playerName}
                    line={s.line}
                    amount={money(s.amountCents)}
                    reference={s.reference}
                    proofHref={s.hasScreenshot ? `/fees/proof/${s.id}` : null}
                    method={s.method}
                    feeType={s.feeType}
                    fromForm={s.fromForm}
                    readableScreenshot={s.readableScreenshot}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
