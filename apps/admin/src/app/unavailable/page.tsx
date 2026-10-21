'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { createClient } from '@/lib/supabase-browser';
// Deep import, not the '@badminton/shared' barrel — see the player middleware.
import { signOutThisDevice } from '@badminton/shared/src/utils/sign-out';
import { Button } from '@badminton/ui';
import { KeyRound, LogOut } from 'lucide-react';
import { friendlyPasskeyError } from '@/lib/passkey/errors';
import { withBase } from '@/lib/base-path';
import { BLOCKED_CEREMONY_ERROR, isBlockedCeremony } from '@/lib/passkey-client';
import { sanitizeNext } from '@/lib/safe-next';


function UnavailableContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [noCredentials, setNoCredentials] = useState(false);
  // The middleware sends an exec here when it cannot read their permissions at
  // all, because that is not a decision about them — it is the console being
  // unable to make one — and /unauthorized would say the opposite. This page's
  // default copy is about passkeys, so without a reason an exec would be told
  // to confirm a passkey they have already confirmed and would go looking for a
  // security problem instead of an outage.
  const isPermissionsOutage = searchParams.get('reason') === 'permissions';
  // Same idea, different lookup: the middleware could not find out whether this
  // admin has an enrolled passkey. It used to answer "no" and wave them
  // through, which switched the console's second factor off for everybody
  // whenever the database was unwell. Now it holds the door and says so — and
  // the passkey prompt below is still the way back in, because confirming a
  // passkey does not need that lookup to have worked.
  const isPasskeyOutage = searchParams.get('reason') === 'passkey-unavailable';

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.replace('/login');
    });
  }, [router]);

  async function handlePasskeyLogin() {
    setLoading(true);
    setError('');
    try {
      // withBase, not a bare path: fetch() does not apply Next's basePath, so
      // on the path-mounted console this would hit the player app instead.
      const optRes = await fetch(withBase('/api/passkey/auth/options'), { method: 'POST' });
      if (optRes.status === 400) {
        setNoCredentials(true);
        return;
      }
      if (!optRes.ok) throw new Error('Could not start passkey login');
      const optionsJSON = await optRes.json();

      const startedAt = Date.now();
      const assertion = await startAuthentication({ optionsJSON }).catch((err: unknown) => {
        throw isBlockedCeremony(err, Date.now() - startedAt) ? new Error(BLOCKED_CEREMONY_ERROR) : err;
      });

      const verifyRes = await fetch(withBase('/api/passkey/auth/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: assertion }),
      });
      if (!verifyRes.ok) throw new Error('Passkey verification failed');

      router.replace(sanitizeNext(searchParams.get('next')));
    } catch (err) {
      setError(friendlyPasskeyError(err, 'Passkey login failed'));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignOut() {
    await signOutThisDevice(createClient().auth);
    window.location.href = withBase('/login');
  }

  if (isPermissionsOutage || isPasskeyOutage) {
    return (
      <div className="min-h-screen flex items-center bg-[var(--bg-primary)]">
        <div className="max-w-xl w-full mx-auto px-6">
          <div className="page-eyebrow">
            <span className="bar" />
            Console unavailable
          </div>
          <h1 className="page-title">
            {isPasskeyOutage ? "We can't check your passkey" : "We can't check your permissions"}
          </h1>
          <p className="page-sub">
            {isPasskeyOutage
              ? 'The console could not read whether your account has a passkey enrolled, so it is holding the door rather than guessing. Nothing has changed about your account.'
              : 'The console could not read what you have access to, so it is holding the door rather than guessing. Nothing has changed about your account.'}
          </p>
          <div className="mt-8 space-y-6">
            <p className="text-sm text-[var(--text-muted)] max-w-[52ch]">
              Try again in a moment. If it keeps happening, tell an admin — they can still
              get in, and this is the message they need to hear.
            </p>
            <div className="flex items-center gap-3">
              <Button onClick={() => router.replace(sanitizeNext(searchParams.get('next')))}>
                Try again
              </Button>
              <Button variant="ghost" onClick={handleSignOut}>
                <LogOut className="w-4 h-4" />
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center bg-[var(--bg-primary)]">
      <div className="max-w-xl w-full mx-auto px-6">
        <div className="page-eyebrow">
          <span className="bar" />
          Security check
        </div>
        <h1 className="page-title">Passkey required</h1>
        <p className="page-sub">
          This account is protected by a passkey. Confirm it&apos;s you to reach the admin console.
        </p>

        {noCredentials ? (
          <div className="mt-8 space-y-6">
            <p className="text-sm text-[var(--text-muted)] max-w-[52ch]">
              No passkey is enrolled for this account, but access still requires one.
              Sign out and back in, or contact another admin if this persists.
            </p>
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4" />
              Sign out
            </Button>
          </div>
        ) : (
          <div className="mt-8 space-y-4">
            <div className="flex items-center gap-3">
              <Button onClick={handlePasskeyLogin} loading={loading}>
                <KeyRound className="w-4 h-4" />
                Log in with passkey
              </Button>
              <Button variant="ghost" onClick={handleSignOut}>
                <LogOut className="w-4 h-4" />
                Sign out
              </Button>
            </div>
            {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function UnavailablePage() {
  return (
    <Suspense fallback={null}>
      <UnavailableContent />
    </Suspense>
  );
}
