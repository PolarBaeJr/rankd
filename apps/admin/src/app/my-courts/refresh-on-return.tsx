'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/** How often an open page re-reads its courts, in case Realtime misses a change. */
const POLL_MS = 15000;
/** A return to the page this soon after the last refresh does not refresh again. */
const MIN_GAP_MS = 2000;

/**
 * Re-reads the courts when the page comes back into view, and every fifteen
 * seconds while it is in view. A helper's phone locks between matches, and a
 * hidden page hears nothing from Realtime (the browser throttles it), so
 * without the first the court shown on waking is the one from before the lock.
 * The second covers a Realtime channel that dropped while the page was open;
 * Realtime itself carries the fast updates. A tick is skipped while the last
 * refresh is still rendering, so a slow page never stacks refreshes.
 * A refresh keeps a half-typed score: the form's state is the client's.
 */
export function RefreshOnReturn() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  const lastRef = useRef(0);

  useEffect(() => {
    pendingRef.current = isPending;
  }, [isPending]);

  useEffect(() => {
    const refresh = () => {
      if (pendingRef.current) return;
      lastRef.current = Date.now();
      startTransition(() => router.refresh());
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRef.current >= MIN_GAP_MS) refresh();
    };
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  return null;
}
