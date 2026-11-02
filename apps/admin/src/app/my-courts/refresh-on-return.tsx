'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-reads the courts when the page comes back into view. A helper's phone
 * locks between matches, and a hidden page hears nothing from Realtime (the
 * browser throttles it), so without this the court shown on waking is the one
 * from before the lock. One refresh on return, rendered once per page.
 */
export function RefreshOnReturn() {
  const router = useRouter();

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [router]);

  return null;
}
