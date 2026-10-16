'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@badminton/ui';
import { confirmImportedTournamentEntry } from '@/lib/tournament-actions';
import { confirmImportedClubEventEntry } from '@/lib/club-event-actions';
import { rejectImportedEntry } from '@/lib/registration-import-actions';
import { useToast } from '@/components/toast-provider';
import { EventWaiverConsent } from '@/app/tournaments/[id]/EventWaiverConsent';
import { SoloEntryConsent } from '@/app/tournaments/[id]/SoloEntryConsent';

// Confirm or "Not me" for an entry a Google Form asked for. The boxes are the
// same ones the event page's Enter dialog shows, and the server refuses without
// them in the same way, so a form never stands in for the member's own consent.

export function ConfirmImportForm({
  entryId,
  kind,
  waiverText,
  doubles,
  partnerName,
  doneHref,
}: {
  entryId: string;
  kind: 'tournament' | 'club_event';
  waiverText: string | null;
  doubles: boolean;
  partnerName: string | null;
  doneHref: string;
}) {
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [doublesAccepted, setDoublesAccepted] = useState(false);
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  const needsWaiver = kind === 'tournament' && !!waiverText;
  const needsDoubles = kind === 'tournament' && doubles;
  const ready = (!needsWaiver || waiverAccepted) && (!needsDoubles || doublesAccepted);

  async function confirm() {
    setBusy('confirm');
    try {
      if (kind === 'tournament') {
        const res = await confirmImportedTournamentEntry(entryId, {
          eventWaiverAccepted: waiverAccepted,
          soloEntryAcknowledged: doublesAccepted,
        });
        if (!res.ok) {
          toast(res.error, 'error');
          return;
        }
        toast(
          res.data.paired
            ? 'You are entered with your partner'
            : res.data.status === 'awaiting_partner'
              ? 'You are entered. You are paired once your partner confirms'
              : 'You are entered',
          'success',
        );
      } else {
        const res = await confirmImportedClubEventEntry(entryId);
        if (!res.ok) {
          toast(res.error, 'error');
          return;
        }
        toast('You are signed up', 'success');
      }
      router.push(doneHref);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy('reject');
    try {
      const res = await rejectImportedEntry(entryId);
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      toast('Thanks. You were not entered, and the club has been told.', 'success');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {needsWaiver && (
        <EventWaiverConsent text={waiverText!} accepted={waiverAccepted} onAcceptedChange={setWaiverAccepted} />
      )}
      {needsDoubles &&
        (partnerName ? (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5 }}>
            <input
              type="checkbox"
              checked={doublesAccepted}
              onChange={(e) => setDoublesAccepted(e.target.checked)}
              style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
            />
            <span>
              I understand that if {partnerName} does not confirm their own response, I stay in this
              doubles event on my own and the exec may pair me with another member.
            </span>
          </label>
        ) : (
          <SoloEntryConsent accepted={doublesAccepted} onAcceptedChange={setDoublesAccepted} />
        ))}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={confirm} loading={busy === 'confirm'} disabled={!ready || busy !== null}>
          Confirm
        </Button>
        <Button variant="secondary" onClick={reject} loading={busy === 'reject'} disabled={busy !== null}>
          Not me
        </Button>
      </div>
    </div>
  );
}
