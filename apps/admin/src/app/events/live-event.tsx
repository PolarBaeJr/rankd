'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveChannel } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';

/**
 * Keeps a club event's console page current while somebody else changes it: a
 * member signing up from the app, a Form import, a waitlist move, another exec
 * checking people in.
 *
 * It listens to club_event_activity (00301), a one-row-per-event signal with no
 * person in it, rather than the sign-up tables: those are readable only by
 * their own member or the service role, so a subscription to them would hear
 * nothing. On a signal the page refreshes and the server re-reads everything
 * with the viewer's own permissions, as the door list does (live-attendance).
 *
 * Before 00301 is applied the subscription succeeds and never fires, and the
 * page behaves as it did.
 */

/** A Form import or a burst of check-ins at the door is one refresh. */
const COALESCE_MS = 400;

export function LiveEvent({ eventId, channel: channelName }: { eventId: string; channel: string }) {
  const router = useRouter();
  // Re-reads when the socket comes back, so changes made during an outage
  // still show up.
  const subscribe = useLiveChannel(() => router.refresh());

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`${channelName}-${eventId}`);
    let timer: ReturnType<typeof setTimeout> | undefined;

    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'club_event_activity', filter: `event_id=eq.${eventId}` },
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => router.refresh(), COALESCE_MS);
      },
    );

    const stopWatching = subscribe(channel);

    return () => {
      clearTimeout(timer);
      // Before removeChannel, so the teardown is not read as an outage.
      stopWatching();
      void supabase.removeChannel(channel);
    };
  }, [channelName, eventId, router, subscribe]);

  return null;
}
