'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** How often an open page re-reads its courts, in case Realtime misses a change. */
const POLL_MS = 5000;

/**
 * Re-reads the courts when the page comes back into view, and every few
 * seconds while it is in view. A helper's phone locks between matches, and a
 * hidden page hears nothing from Realtime (the browser throttles it), so
 * without the first the court shown on waking is the one from before the lock.
 * The second covers a Realtime channel that dropped while the page was open.
 * A refresh keeps a half-typed score: the form's state is the client's.
 */
export function RefreshOnReturn() {
  const router = useRouter();

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  return null;
}
