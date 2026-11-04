'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { withBase } from '@/lib/base-path';
import {
  DEFER_RETRY_MS,
  PROBE_MS,
  QUIET_REFRESH_EVENT,
  fingerprintChanged,
  mayRefreshNow,
  readScreenState,
} from '@/lib/quiet-refresh';

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
 *
 * QUIET (kill switch quiet_refresh): the same two triggers ask the probe
 * route instead, and refresh only when its fingerprint differs from the one
 * this render was drawn from. A Realtime nudge (LiveTournament with `quiet`)
 * asks the probe as well, so the echo of this screen's own save, already
 * drawn, refreshes nothing. A refresh that is due waits while someone is typing, has a
 * dialog or menu open, or is saving, and goes the moment they are done.
 */
export function RefreshOnReturn({ quiet }: { quiet?: { probe: string; fingerprint: string | null } }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  const lastRef = useRef(0);
  const shownRef = useRef(quiet?.fingerprint ?? '');
  const probe = quiet?.probe ?? null;

  useEffect(() => {
    pendingRef.current = isPending;
  }, [isPending]);

  useEffect(() => {
    shownRef.current = quiet?.fingerprint ?? '';
  }, [quiet?.fingerprint]);

  useEffect(() => {
    if (probe) return;
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
  }, [router, probe]);

  useEffect(() => {
    if (!probe) return;
    let due = false;
    let probing = false;
    let again = false;
    let retry: number | undefined;
    let stopped = false;

    const flush = () => {
      window.clearTimeout(retry);
      retry = undefined;
      if (!due || stopped) return;
      if (pendingRef.current || !mayRefreshNow(readScreenState(document))) {
        retry = window.setTimeout(flush, DEFER_RETRY_MS);
        return;
      }
      due = false;
      lastRef.current = Date.now();
      startTransition(() => router.refresh());
    };
    const check = async () => {
      if (due) { flush(); return; }
      if (probing || pendingRef.current) { again = true; return; }
      again = false;
      probing = true;
      let probed: string | null = null;
      try {
        const res = await fetch(withBase(probe), { cache: 'no-store' });
        if (res.ok) probed = ((await res.json()) as { fingerprint?: string | null }).fingerprint ?? null;
      } catch {
        probed = null;
      }
      probing = false;
      if (stopped) return;
      if (fingerprintChanged(shownRef.current, probed)) {
        due = true;
        flush();
      } else if (again) {
        void check();
      }
    };
    const onNudge = () => void check();
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRef.current >= MIN_GAP_MS) void check();
    };
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void check();
    }, PROBE_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(QUIET_REFRESH_EVENT, onNudge);
    return () => {
      stopped = true;
      window.clearInterval(poll);
      window.clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(QUIET_REFRESH_EVENT, onNudge);
    };
  }, [router, probe]);

  return null;
}
