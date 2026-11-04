'use client';

import { useState } from 'react';
import { Button, Checkbox, Dialog, Input, PlayerPicker } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { addOnTheSpot, type OnTheSpotResult } from '@/lib/tournament-actions/on-the-spot';
import { onTheSpotChecksIn, onTheSpotMessage } from '@/lib/on-the-spot';

interface Props {
  eventId: string;
  eventStatus: string;
  isDoubles: boolean;
  players: Array<{ id: string; full_name: string; avatar_url?: string | null; handle?: string | null }>;
  /** Players already entered, left out of both pickers. */
  takenPlayerIds: ReadonlySet<string>;
  onClose: () => void;
  /** After a save: the caller refreshes, and goes on to place a late team. */
  onAdded: (result: OnTheSpotResult) => void;
}

/** Add on the spot: whoever is standing at the desk, a member or a guest by name. */
export function AddOnTheSpotDialog({ eventId, eventStatus, isDoubles, players, takenPlayerIds, onClose, onAdded }: Props) {
  const [kind, setKind] = useState<'member' | 'guest'>('member');
  const [playerId, setPlayerId] = useState('');
  const [guestName, setGuestName] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [chargeFee, setChargeFee] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const options = players
    .filter((p) => !takenPlayerIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.full_name, avatarUrl: p.avatar_url, handle: p.handle ?? null }));
  const ready = kind === 'member' ? playerId !== '' : guestName.trim() !== '';

  async function save() {
    if (!ready) return;
    setSaving(true);
    const res = await addOnTheSpot({
      eventId,
      playerId: kind === 'member' ? playerId : null,
      guestName: kind === 'guest' ? guestName.trim() : null,
      partnerId: isDoubles && partnerId ? partnerId : null,
      chargeFee,
    });
    setSaving(false);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(onTheSpotMessage(res.data), res.data.waiverUnsigned ? 'error' : 'success');
    onAdded(res.data);
  }

  return (
    <Dialog open onClose={onClose} title="Add on the spot">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="flex gap-2" role="radiogroup" aria-label="Who is being added">
          <Button type="button" size="sm" variant={kind === 'member' ? 'primary' : 'ghost'} aria-pressed={kind === 'member'} onClick={() => setKind('member')}>
            Member
          </Button>
          <Button type="button" size="sm" variant={kind === 'guest' ? 'primary' : 'ghost'} aria-pressed={kind === 'guest'} onClick={() => setKind('guest')}>
            Guest
          </Button>
        </div>
        {kind === 'member' ? (
          <PlayerPicker
            label="Member"
            placeholder="Search by name or @handle"
            value={playerId}
            onChange={setPlayerId}
            players={options.filter((o) => o.id !== partnerId)}
          />
        ) : (
          <Input
            label="Guest name"
            value={guestName}
            maxLength={120}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder="Their full name"
            autoFocus
          />
        )}
        {isDoubles && (
          <div className="space-y-1">
            <PlayerPicker
              label="Partner (optional)"
              placeholder="Search by name or @handle"
              value={partnerId}
              onChange={setPartnerId}
              players={options.filter((o) => o.id !== playerId)}
            />
            {!partnerId && (
              <p className="text-xs text-[var(--text-muted)]">Leave it empty to add them alone and pair them later.</p>
            )}
          </div>
        )}
        <Checkbox
          label="Charge the event fee"
          showLabel
          checked={chargeFee}
          onChange={setChargeFee}
        />
        <p className="text-xs text-[var(--text-muted)]">
          {chargeFee ? 'They will show as owing the event fee.' : 'No fee is recorded for them.'}
          {onTheSpotChecksIn(eventStatus) && ' They are checked in as soon as they are added, unless their waiver is not signed.'}
        </p>
        <div className="flex justify-between gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving} disabled={!ready}>Add</Button>
        </div>
      </form>
    </Dialog>
  );
}
