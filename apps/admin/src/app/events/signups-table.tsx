'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, useConfirm } from '@badminton/ui';
import { formatDateTime } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { removeClubEventSignup } from '@/lib/actions/club-events';
import { undoImportedEntry } from '@/lib/actions/registration-imports';

/**
 * One person on the list. Members and the Google Form's non-members are one
 * list, in sign-up order: the club treats them the same way at the door.
 * A guest carries the Form entry that put them here (removing them is that
 * entry's Undo) or none, for a walk-in, who is dealt with at the door.
 * `partner` is the preferred partner the Form's answer named (00299), as typed.
 */
export type ClubEventSignupRow =
  | { kind: 'member'; key: string; player_id: string; name: string; created_at: string; partner?: string | null }
  | {
      kind: 'guest';
      key: string;
      name: string;
      created_at: string;
      email: string | null;
      walkIn: boolean;
      entryId: string | null;
      waiverSigned: boolean | null;
      fee: { amountCents: number | null; paid: boolean } | null;
      partner?: string | null;
    };

function money(cents: number | null): string {
  return cents === null ? 'TBD' : `$${(cents / 100).toFixed(2)}`;
}

export function ClubEventSignupsTable({
  eventId,
  rows,
  canRemove,
}: {
  eventId: string;
  rows: ClubEventSignupRow[];
  canRemove: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [removing, setRemoving] = useState<string | null>(null);

  async function handleRemove(row: ClubEventSignupRow) {
    const ok = await confirm(
      row.kind === 'member'
        ? {
            title: 'Remove this member?',
            message: `${row.name} is taken off the list. They are not notified.`,
            confirmLabel: 'Remove',
            danger: true,
          }
        : {
            title: 'Remove this guest?',
            message: `${row.name} is taken off the list, and an unpaid fee the Form created is removed. A paid fee stops the removal.`,
            confirmLabel: 'Remove',
            danger: true,
          },
    );
    if (!ok) return;
    setRemoving(row.key);
    try {
      const result =
        row.kind === 'member'
          ? await removeClubEventSignup(eventId, row.player_id)
          : await undoImportedEntry(row.entryId!);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast(`${row.name} removed`, 'success');
      router.refresh();
    } finally {
      setRemoving(null);
    }
  }

  if (rows.length === 0) {
    return <p className="px-5 pb-5 text-sm text-[var(--mute)]">Nobody has signed up yet.</p>;
  }
  return (
    <ul className="divide-y divide-[var(--line)]">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm text-[var(--ink)]">{row.name}</span>
              {row.kind === 'guest' && (
                <Badge variant="neutral">{row.walkIn ? 'Walk-in' : 'Non-member'}</Badge>
              )}
            </div>
            {row.kind === 'guest' && row.email && (
              <div className="truncate text-xs text-[var(--ink-2)]">{row.email}</div>
            )}
            {row.partner && <div className="truncate text-xs text-[var(--mute)]">Partner: {row.partner}</div>}
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--mute)]">
              {row.kind === 'guest' && !row.walkIn ? 'Google Form' : 'Signed up'} {formatDateTime(row.created_at)}
              {row.kind === 'guest' && row.waiverSigned !== null && (
                <> · Waiver {row.waiverSigned ? 'signed' : 'not signed'}</>
              )}
              {row.kind === 'guest' && row.fee && (
                <>
                  {' '}
                  · {money(row.fee.amountCents)} {row.fee.paid ? 'paid' : 'unpaid'}
                </>
              )}
            </div>
          </div>
          {canRemove && (row.kind === 'member' || row.entryId) && (
            <Button variant="secondary" size="sm" onClick={() => handleRemove(row)} loading={removing === row.key}>
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
