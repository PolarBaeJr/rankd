'use client';

import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button, Input } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { friendlyPasskeyError } from '@/lib/passkey/errors';
import { withBase } from '@/lib/base-path';
import { BLOCKED_CEREMONY_ERROR, isBlockedCeremony } from '@/lib/passkey-client';

// The name field and Add button that enrol a console passkey. Used by
// Settings and by /passkey-required, which differ only in what happens after.
export function AddConsolePasskey({ onAdded }: { onAdded: () => void }) {
  const { toast } = useToast();
  const [nickname, setNickname] = useState('');
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    setAdding(true);
    try {
      // withBase, not a bare path: fetch() does not apply Next's basePath, so
      // on the path-mounted console this would hit the player app instead.
      const optRes = await fetch(withBase('/api/passkey/register/options'), { method: 'POST' });
      if (!optRes.ok) {
        const body = await optRes.json().catch(() => null);
        throw new Error(body?.error || 'Could not start passkey enrollment');
      }
      const optionsJSON = await optRes.json();

      const startedAt = Date.now();
      const attestation = await startRegistration({ optionsJSON }).catch((err: unknown) => {
        throw isBlockedCeremony(err, Date.now() - startedAt) ? new Error(BLOCKED_CEREMONY_ERROR) : err;
      });

      const verifyRes = await fetch(withBase('/api/passkey/register/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential: attestation,
          nickname: nickname.trim() || undefined,
        }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => null);
        throw new Error(body?.error || 'Passkey enrollment failed');
      }

      toast('Passkey added', 'success');
      setNickname('');
      onAdded();
    } catch (err) {
      toast(friendlyPasskeyError(err, 'Passkey enrollment failed'), 'error');
    }
    setAdding(false);
  }

  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--bg-primary)] p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <Input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="Name this device, e.g. Work laptop"
          aria-label="Passkey name (optional)"
          maxLength={64}
        />
      </div>
      <Button onClick={handleAdd} loading={adding}>
        Add passkey
      </Button>
    </div>
  );
}
