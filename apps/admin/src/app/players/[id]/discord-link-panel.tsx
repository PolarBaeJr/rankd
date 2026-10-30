'use client';

import { useState } from 'react';
import { Button, Input, Textarea } from '@badminton/ui';
import {
  previewDiscordForceLink,
  forceLinkDiscordAccount,
  type DiscordForceLinkPreview,
} from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';

/**
 * Attaches a Discord account to this member without the member.
 *
 * THE SERVER ACTION IS THE GATE, not this component.
 * forceLinkDiscordAccount re-checks `players.discordlink.write`, re-validates
 * the id and re-reads both rows for itself, and it trusts nothing the preview
 * returned. Everything here is ergonomics: it avoids drawing a control that is
 * guaranteed to fail, and it stops an officer confirming a link the preview has
 * already said would be refused. Deleting all of it would change what the
 * console looks like and not what it permits.
 *
 * Preview-then-confirm, modelled on MergePlayersButton, because the act has no
 * undo the console can offer: the account this displaces loses its club roles
 * on the next sweep and the console holds no Discord token to put them back.
 * The preview is cleared on every keystroke in the id box, so Confirm can only
 * ever act on a preview taken of exactly the id now in it.
 */
export function DiscordLinkPanel({
  playerId,
  playerName,
  linked,
}: {
  playerId: string;
  playerName: string;
  /** Whether a Discord account is linked now, which only changes the button's words. */
  linked: boolean;
}) {
  const [discordUserId, setDiscordUserId] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<DiscordForceLinkPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [linking, setLinking] = useState(false);
  // The boxes stay hidden until the officer asks to link, like every other
  // section's Edit.
  const [choosing, setChoosing] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleCheck() {
    setChecking(true);
    setPreview(null);
    const res = await previewDiscordForceLink(playerId, discordUserId);
    if (!res.ok) { toast(res.error, 'error'); setChecking(false); return; }
    setPreview(res.data);
    setChecking(false);
  }

  async function handleLink() {
    setLinking(true);
    const res = await forceLinkDiscordAccount(playerId, discordUserId, reason);
    if (!res.ok) { toast(res.error, 'error'); setLinking(false); return; }
    toast(
      res.data.displacedDiscordUserId
        ? 'Discord account linked. The account it replaced loses its club roles on the next sweep.'
        : 'Discord account linked',
      'success',
    );
    setLinking(false);
    setDiscordUserId('');
    setReason('');
    setPreview(null);
    setChoosing(false);
    router.refresh();
  }

  function handleCancel() {
    setDiscordUserId('');
    setReason('');
    setPreview(null);
    setChoosing(false);
  }

  // A conflict is not something the officer can confirm through. The other
  // member has to be unlinked first, and the UNIQUE index would refuse this
  // anyway, so the button stays disabled rather than offering a doomed write.
  const conflict = Boolean(preview?.conflictPlayerId);

  if (!choosing) {
    return (
      <div className="pt-4">
        <Button variant="secondary" onClick={() => setChoosing(true)}>
          {linked ? 'Link a different account' : 'Link a Discord account'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4">
      <Input
        label="Discord user ID"
        value={discordUserId}
        onChange={(e) => { setDiscordUserId(e.target.value); setPreview(null); }}
        placeholder="214300000000000000"
      />
      <Textarea
        label="Why this is being linked by hand"
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="They cannot run /link themselves because…"
      />

      {preview && conflict && (
        <div className="flex gap-2 p-3 rounded-lg border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--color-danger)] mt-0.5" />
          <span className="text-[var(--text-secondary)]">
            That Discord account is already linked to{' '}
            <span className="text-[var(--text-primary)]">
              {preview.conflictPlayerName ?? 'another member'}
            </span>
            . Disconnect it first with <span className="text-[var(--text-primary)]">/forceunlink</span>{' '}
            in Discord: one Discord account belongs to one member.
          </span>
        </div>
      )}

      {preview && !conflict && preview.currentDiscordUserId && (
        <div className="flex gap-2 p-3 rounded-lg border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--color-danger)] mt-0.5" />
          <span className="text-[var(--text-secondary)]">
            {playerName} is already linked to{' '}
            <span className="font-mono text-[var(--text-primary)]">
              {preview.currentDiscordUserId}
            </span>
            . Linking this one replaces it, and that account loses its club roles on the next
            sweep. Nothing here can give them back.
          </span>
        </div>
      )}

      {preview && !conflict && !preview.currentDiscordUserId && (
        <p className="text-sm text-[var(--color-success)]">
          {preview.targetName} has no Discord account linked. This will be their first.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={handleCancel} disabled={linking}>
          Cancel
        </Button>
        {preview === null ? (
          <Button onClick={handleCheck} disabled={!discordUserId.trim() || checking}>
            {checking ? 'Checking…' : 'Check'}
          </Button>
        ) : (
          <Button
            variant="danger"
            onClick={handleLink}
            disabled={linking || conflict || !reason.trim()}
          >
            {linking ? 'Linking…' : preview.currentDiscordUserId ? 'Replace link' : 'Link account'}
          </Button>
        )}
      </div>
    </div>
  );
}
