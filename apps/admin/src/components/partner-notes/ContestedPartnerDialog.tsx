'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Select } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { resolveContestedPartner, type ContestPick } from '@/lib/actions/club-event-partners';
import type { PartnerAdvice } from '@/lib/partner-check';

/**
 * Somebody asked for by two or more people (00311). The officer picks who
 * partners them, or lets the server pick at random; the others stay waiting
 * for a partner.
 */
export function ContestedPartnerDialog({
  clubEventId,
  targetPlayerId,
  targetName,
  advice,
  onClose,
}: {
  clubEventId: string;
  targetPlayerId: string;
  targetName: string;
  advice: PartnerAdvice;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [chosen, setChosen] = useState(advice.pairable[0]?.playerId ?? '');
  const [busy, setBusy] = useState<'choose' | 'random' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(pick: ContestPick) {
    setBusy(pick.mode);
    setError(null);
    try {
      const result = await resolveContestedPartner(clubEventId, targetPlayerId, pick);
      if (!result.ok) return setError(result.error);
      toast(`${result.data.winnerName} and ${targetName} are paired.`, 'success');
      onClose();
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Who partners ${targetName}?`}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => resolve({ mode: 'random' })}
            loading={busy === 'random'}
            disabled={busy !== null || advice.pairable.length === 0}
          >
            Pick at random
          </Button>
          <Button
            onClick={() => resolve({ mode: 'choose', requesterPlayerId: chosen })}
            loading={busy === 'choose'}
            disabled={busy !== null || !chosen}
          >
            Pair them
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--ink-2)]">
          Requested by {advice.requestedBy.join(', ')}. The one picked is paired with {targetName} in the
          tournament; the others stay waiting for a partner.
        </p>
        <Select
          label="Partner"
          value={chosen}
          onValueChange={setChosen}
          options={advice.pairable.map((person) => ({ value: person.playerId, label: person.name }))}
        />
        {advice.unpairable.length > 0 && (
          <ul className="space-y-1 text-xs text-[var(--mute)]">
            {advice.unpairable.map((person) => (
              <li key={person.name}>
                {person.name} cannot be paired: {person.reason}.
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    </Dialog>
  );
}
