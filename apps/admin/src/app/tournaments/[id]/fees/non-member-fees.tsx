'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button } from '@badminton/ui';
import { PAYMENT_METHODS } from '@badminton/shared';
import { markNonMemberFeePaid, markNonMemberFeeUnpaid } from '@/lib/actions/registration-imports';

// Entry fees owed by non-members a Google Form entered (00283). They have no
// account, so the row carries the name and email the form gave and is settled
// by its own id. Kept apart from the members' table above because that table,
// its bulk bar and its dialogs are all keyed by player id.

export interface NonMemberFeeRow {
  id: string;
  name: string;
  email: string | null;
  amountCents: number | null;
  paid: boolean;
  waived: boolean;
  method: string | null;
}

const METHODS = PAYMENT_METHODS.filter((m) => m.value !== 'custom');

export function NonMemberFees({
  rows,
  canMarkPaid,
  canMarkUnpaid,
}: {
  rows: NonMemberFeeRow[];
  canMarkPaid: boolean;
  canMarkUnpaid: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<string>(METHODS[0]?.value ?? 'e_transfer');

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? 'Something went wrong');
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {canMarkPaid && (
        <label className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          Paid by
          <select
            className="min-h-[36px] px-2 bg-[var(--bg-surface)] border border-[var(--border)] text-sm text-[var(--text-primary)]"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            disabled={pending}
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--text-muted)]">
            <tr>
              <th className="px-4 py-2">Non-member</th>
              <th className="px-4 py-2">Amount</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-2">
                  <div>{row.name}</div>
                  {row.email && <div className="text-xs text-[var(--text-muted)] break-all">{row.email}</div>}
                </td>
                <td className="px-4 py-2 font-mono">
                  {row.amountCents == null ? 'No amount' : `$${(row.amountCents / 100).toFixed(2)}`}
                </td>
                <td className="px-4 py-2">
                  <Badge variant={row.waived ? 'neutral' : row.paid ? 'success' : 'warning'}>
                    {row.waived ? 'Waived' : row.paid ? 'Paid' : 'Outstanding'}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {!row.paid && !row.waived && canMarkPaid && (
                    <Button size="sm" disabled={pending} onClick={() => run(() => markNonMemberFeePaid(row.id, method))}>
                      Mark paid
                    </Button>
                  )}
                  {row.paid && !row.waived && canMarkUnpaid && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => run(() => markNonMemberFeeUnpaid(row.id))}
                    >
                      Mark unpaid
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
