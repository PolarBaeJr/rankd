'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Select, useConfirm } from '@badminton/ui';
import { formatDateTime } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { removeClubEventSignup } from '@/lib/actions/club-events';
import { undoImportedEntry } from '@/lib/actions/registration-imports';
import { pairMutualPartners } from '@/lib/actions/club-event-partners';
import type { PartnerAdvice } from '@/lib/partner-check';
import { PartnerCheckLine } from '@/components/partner-notes/PartnerCheckLine';
import { PartnerChoiceDialog, type PartnerOption } from '@/components/partner-notes/PartnerChoiceDialog';
import { ContestedPartnerDialog } from '@/components/partner-notes/ContestedPartnerDialog';
import { SIGNUP_SORT_KEY, SIGNUP_SORT_OPTIONS, parseSignupSort, sortEntries, type SignupSortOrder } from '@/lib/entry-sort';

/**
 * One person on the list. Members and the Google Form's non-members are one
 * list, newest sign-up first by default, and the officer can re-sort it by
 * time or name: the club treats them the same way at the door.
 * A guest carries the Form entry that put them here (removing them is that
 * entry's Undo) or none, for a walk-in, who is dealt with at the door.
 * The partner check (00311) comes alongside, keyed by `key`: what the Form's
 * answer named (00299) as typed, the desk's choice, and what is wrong with it.
 * A member row can be a guest record (00292), such as somebody an officer added
 * by hand (00306) with the answers they gave.
 */
export type ClubEventSignupRow =
  | {
      kind: 'member';
      key: string;
      player_id: string;
      name: string;
      created_at: string;
      fee?: { amountCents: number | null; paid: boolean } | null;
      guest?: boolean;
      answers?: Record<string, string> | null;
    }
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
    };

function money(cents: number | null): string {
  return cents === null ? 'TBD' : `$${(cents / 100).toFixed(2)}`;
}

export function ClubEventSignupsTable({
  eventId,
  rows,
  canRemove,
  partners = {},
  partnerOptions = [],
  canEditPartner = false,
  canPair = false,
}: {
  eventId: string;
  rows: ClubEventSignupRow[];
  canRemove: boolean;
  /** The partner check per row key (00311). */
  partners?: Record<string, PartnerAdvice>;
  /** Everybody signed up, for the partner picker. */
  partnerOptions?: PartnerOption[];
  canEditPartner?: boolean;
  /** The event runs as a doubles tournament and the viewer may pair there. */
  canPair?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [removing, setRemoving] = useState<string | null>(null);
  const [choosingFor, setChoosingFor] = useState<ClubEventSignupRow | null>(null);
  const [resolvingFor, setResolvingFor] = useState<ClubEventSignupRow | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);
  // Remembered per device, read after mount so the server render matches.
  const [order, setOrder] = useState<SignupSortOrder>('newest');
  useEffect(() => {
    try {
      const saved = parseSignupSort(window.localStorage.getItem(SIGNUP_SORT_KEY));
      if (saved) setOrder(saved);
    } catch { /* no storage: newest first */ }
  }, []);
  function pickSort(next: SignupSortOrder) {
    setOrder(next);
    try { window.localStorage.setItem(SIGNUP_SORT_KEY, next); } catch { /* not remembered */ }
  }

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

  async function handlePair(row: ClubEventSignupRow, advice: PartnerAdvice) {
    if (!advice.mutualPair) return;
    setPairing(row.key);
    try {
      const result = await pairMutualPartners(eventId, advice.mutualPair.playerId, advice.mutualPair.partnerPlayerId);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast(`${row.name} and ${advice.mutualPair.partnerName} are paired.`, 'success');
      router.refresh();
    } finally {
      setPairing(null);
    }
  }

  if (rows.length === 0) {
    return <p className="px-5 pb-5 text-sm text-[var(--mute)]">Nobody has signed up yet.</p>;
  }
  return (
    <>
      {rows.length > 1 && (
        <div className="flex justify-end px-5 pb-3">
          <Select
            variant="bare"
            aria-label="Sort sign-ups"
            value={order}
            onChange={(e) => pickSort(e.target.value as SignupSortOrder)}
            options={SIGNUP_SORT_OPTIONS}
            className="h-9 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-xs text-[var(--text-primary)] hover:border-[var(--border-hover)]"
          />
        </div>
      )}
      <ul className="divide-y divide-[var(--line)]">
        {sortEntries(rows, order, { id: (r) => r.key, signedUpAt: (r) => r.created_at, name: (r) => r.name }).map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm text-[var(--ink)]">{row.name}</span>
                {row.kind === 'guest' && (
                  <Badge variant="neutral">{row.walkIn ? 'Walk-in' : 'Non-member'}</Badge>
                )}
                {row.kind === 'member' && row.guest && <Badge variant="neutral">Guest</Badge>}
              </div>
              {row.kind === 'guest' && row.email && (
                <div className="truncate text-xs text-[var(--ink-2)]">{row.email}</div>
              )}
              <PartnerCheckLine
                advice={partners[row.key]}
                onResolve={canPair && row.kind === 'member' ? () => setResolvingFor(row) : undefined}
              />
              {row.kind === 'member' &&
                row.answers &&
                Object.entries(row.answers).map(([question, answer]) => (
                  <div key={question} className="text-xs text-[var(--mute)]">
                    {question}: <span className="text-[var(--ink-2)]">{answer}</span>
                  </div>
                ))}
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--mute)]">
                {row.kind === 'guest' && !row.walkIn ? 'Google Form' : 'Signed up'} {formatDateTime(row.created_at)}
                {row.kind === 'guest' && row.waiverSigned !== null && (
                  <> · Waiver {row.waiverSigned ? 'signed' : 'not signed'}</>
                )}
                {row.fee && (
                  <>
                    {' '}
                    · {money(row.fee.amountCents)} {row.fee.paid ? 'paid' : 'unpaid'}
                  </>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canPair && partners[row.key]?.mutualPair && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handlePair(row, partners[row.key]!)}
                  loading={pairing === row.key}
                >
                  Pair
                </Button>
              )}
              {canEditPartner && partners[row.key] && (
                <Button variant="secondary" size="sm" onClick={() => setChoosingFor(row)}>
                  Partner
                </Button>
              )}
              {canRemove && (row.kind === 'member' || row.entryId) && (
                <Button variant="secondary" size="sm" onClick={() => handleRemove(row)} loading={removing === row.key}>
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {choosingFor && partners[choosingFor.key] && (
        <PartnerChoiceDialog
          clubEventId={eventId}
          personKey={choosingFor.key}
          name={choosingFor.name}
          wrote={partners[choosingFor.key]!.wrote}
          preselect={partners[choosingFor.key]!.preselect}
          options={partnerOptions}
          onClose={() => setChoosingFor(null)}
        />
      )}
      {resolvingFor && resolvingFor.kind === 'member' && partners[resolvingFor.key] && (
        <ContestedPartnerDialog
          clubEventId={eventId}
          targetPlayerId={resolvingFor.player_id}
          targetName={resolvingFor.name}
          advice={partners[resolvingFor.key]!}
          onClose={() => setResolvingFor(null)}
        />
      )}
    </>
  );
}
