'use client';

import { useState } from 'react';
import { Button, Dialog } from '@badminton/ui';
import { MarkReimbursed } from './finance-actions';
import { detailsFromStored, detailsShare, dollars, shareSummary, type StoredExpenseDetails } from './expense-details-fields';

/**
 * An expense's receipt pages, items and share, in one dialog (00313).
 *
 * Rendered only for a viewer who can READ the ledger (ledger-card.tsx), the
 * same gate as the routes the pages load from: looking at the receipt is
 * reading the row, and the exec who is owed the money is exactly who needs to
 * check it. The pages are <img> tags on the console's own route, so nothing
 * loads until the dialog opens (Dialog renders nothing while closed), and
 * withBase because an unprefixed /fees/... is a LIVE ROUTE ON THE PLAYER APP.
 * A PDF opens in a new tab: the browser's own viewer shows it better than an
 * image of it would.
 *
 * No path reaches here: the routes resolve the attachment, or the ledger row,
 * themselves.
 */
export function ExpenseReceiptViewer({
  title,
  details,
  amountCents,
  reimburse,
}: {
  title: string;
  details: Omit<StoredExpenseDetails, 'receipts'> & {
    receipts: { key: string; href: string; imageSrc: string; content_type: string; position: number }[];
  };
  amountCents: number;
  /** Present = this viewer may settle it and it is still owed. */
  reimburse?: { id: string; payerId: string; payerName: string };
}) {
  const [open, setOpen] = useState(false);
  const receipts = [...details.receipts].sort((a, b) => a.position - b.position);
  const items = [...details.items].sort((a, b) => a.position - b.position);
  const share = detailsShare(
    detailsFromStored({ ...details, receipts: [] }),
  );

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {receipts.length > 0 ? `Receipts (${receipts.length})` : 'Items'}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} size="wide">
        <div className="space-y-4">
          {(details.vendor || details.receipt_total_cents !== null) && (
            <p className="text-sm text-[var(--text-secondary)]">
              {[details.vendor, details.receipt_total_cents !== null ? `Receipt total ${dollars(details.receipt_total_cents)}` : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}

          {receipts.map((r, i) =>
            r.content_type === 'application/pdf' ? (
              <a
                key={r.key}
                href={r.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm text-[var(--color-accent)] underline"
              >
                Page {i + 1}: open the PDF
              </a>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={r.key}
                src={r.imageSrc}
                alt={`Receipt page ${i + 1}`}
                loading="lazy"
                className="max-w-full border border-[var(--border)]"
              />
            ),
          )}

          {items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pr-2 font-medium">For</th>
                  <th className="pr-2 font-medium">Item</th>
                  <th className="pr-2 font-medium">Tax code</th>
                  <th className="text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.position}>
                    <td className="pr-2 text-[var(--text-secondary)]">{it.is_club ? 'Club' : 'Personal'}</td>
                    <td className="pr-2">
                      {it.description}
                      {it.quantity != null && <span className="text-[var(--text-muted)]"> ×{Number(it.quantity)}</span>}
                    </td>
                    <td className="pr-2 text-[var(--text-secondary)]">{it.tax_code ?? ''}</td>
                    <td className="text-right font-mono">
                      {dollars(it.line_total_cents)}
                      {it.discount_cents !== 0 && (
                        <span className="block text-xs text-[var(--text-muted)]">{dollars(it.discount_cents)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {share ? (
            <div className="space-y-1 text-sm text-[var(--text-secondary)]">
              {shareSummary(share, details.receipt_total_cents, items.every((it) => it.is_club)).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">Amount {dollars(amountCents)}.</p>
          )}

          {reimburse && (
            <MarkReimbursed
              id={reimburse.id}
              payerId={reimburse.payerId}
              payerName={reimburse.payerName}
              amountCents={amountCents}
            />
          )}
        </div>
      </Dialog>
    </>
  );
}
