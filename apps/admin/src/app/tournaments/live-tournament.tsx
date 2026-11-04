'use client';

import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveChannel } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';
import { QUIET_REFRESH_EVENT } from '@/lib/quiet-refresh';

/**
 * WATCHING A DRAW MOVE, FROM THE CONSOLE SIDE.
 *
 * A tournament is run by more than one exec. One works the scoring table for
 * the men's singles while another runs the mixed doubles from a laptop across
 * the gym, and a third has the tournament overview open to see which events
 * have finished. `revalidateEventPaths()` at the end of every action covers
 * whichever of them made the write and nobody else, so the other two were
 * reading a screen that had stopped moving — and unlike a member refreshing a
 * bracket out of impatience, an exec acting on a stale draw generates the next
 * round against the wrong occupants.
 *
 * NUDGE, DO NOT MERGE. The callback calls router.refresh() rather than pushing
 * the payload into local state. Three reasons, in order of how much they
 * matter:
 *
 *   1. CAPABILITY, and it bites harder here than on the player side. The socket
 *      payload is whatever RLS lets through, and RLS on all four of these
 *      tables is `TO authenticated USING (true)` — every signed-in member can
 *      read every row. What THIS console shows is decided per viewer by the
 *      permission stack: entering a score, seeding a draw, editing a settled
 *      result and finalising an event are four separate capabilities, and a
 *      trainer holding none of them sees the same tabs read-only. Re-running
 *      the server component re-derives every one of those gates from the
 *      viewer's own credentials, so a live update cannot become a route to
 *      something a static render withheld. Hand-merging rows would put that
 *      decision on the client, where it does not belong.
 *
 *   2. DERIVED NUMBERS. One score entry moves the match card, the next round's
 *      occupants, the standings tab, the leaderboard tab's points, the
 *      entrant's final position and sometimes the event's status. They are all
 *      folded out of one read in page.tsx and handed to EventControlCenter as
 *      props; a refresh re-derives every one of them from that single source
 *      instead of leaving six copies to drift apart.
 *
 *   3. NAMES. These rows carry ids. Every tab shows names because the SERVER
 *      joins `players` when it re-renders. There is nothing to merge.
 *
 * DELIBERATELY A SECOND COPY of apps/player/src/app/tournaments/
 * live-tournament.tsx rather than one component in @badminton/ui, and for the
 * same reason the two publication guard tests are a deliberate pair: each
 * app's guard scans only its OWN src tree, so a shared component in a package
 * would be invisible to BOTH of them — a subscription no test can see, which
 * is precisely the failure mode this whole area exists to prevent. The two
 * files also resolve different `@/lib/supabase-browser` modules.
 *
 * *** INERT UNTIL THE PUBLICATION SAYS SO. *** None of these four tables is a
 * member of `supabase_realtime` until 00113 is applied, and a subscription to
 * an unpublished table SUCCEEDS and then never fires — .subscribe() resolves,
 * the callback never runs, nothing errors. That is the exact silent failure
 * 00036 was written to fix, and 00112 the most recent repeat. Until the owner
 * runs 00113 this component does nothing whatsoever.
 *
 * THE SCORING EXEC GETS THESE TOO, and that is checked rather than assumed.
 * enterMatchResult writes tournament_matches three times or more, so the
 * browser that entered the score also receives a refresh ~700ms after the one
 * ScoreEntryDialog already fires — landing, quite routinely, while that exec is
 * opening the next match's dialog. It is harmless here because nothing on this
 * screen is re-keyed by data: EventControlCenter renders each tab with no `key`
 * at all, the tabs key their rows on `m.id` / `e.id` / `s.id`, and the dialog's
 * open state (`scoreMatch`) lives in BracketTab and RoundRobinTab, which
 * router.refresh() re-renders without remounting. A half-typed score survives.
 * The same check on /sessions is what put stable keys in SessionTable, and it
 * has to be redone by anyone who adds a `key` derived from match data here.
 *
 * THE OTHER WAY THIS CAN GO QUIET, which no test can see: the console's pages
 * read with createAdminClient() (service role, RLS bypassed) while this
 * subscribes with the browser anon client, which is subject to the four
 * `_select` policies above. So the render needs no Supabase session and the
 * socket does. It has one: requireCapability() authenticates through
 * supabase.auth.getUser() on the shared auth cookie, and supabase-browser.ts is
 * built with the same AUTH_COOKIE_OPTIONS, so the browser client resolves the
 * same GoTrue session the server just checked.
 */

/** Long enough to fold one result into one re-render, and it has to be: a
 *  single score entry writes tournament_matches at least three times (the
 *  result, then the elo snapshot, then the advancement into the next round)
 *  and touches tournament_participants on the way, while regenerating a draw
 *  inserts every match in the event in a loop. Short enough that an exec
 *  watching the screen reads it as immediate. */
const COALESCE_MS = 700;

export function LiveTournament({
  channel: channelName,
  tournamentId,
  eventIds,
  draw = false,
  quiet = false,
}: {
  /** UNIQUE PER SURFACE, so the tournament page and one of its event pages
   *  never share a topic. */
  channel: string;
  /** Watched whole: one listener covers every event in this tournament. */
  tournamentId: string;
  /** The events whose ENTRY LISTS this surface shows. */
  eventIds: string[];
  /** Also watch the matches of those events. True only where a draw is drawn —
   *  the tournament overview lists events and counts and would otherwise be
   *  woken by every score in every event it is merely summarising. */
  draw?: boolean;
  /** Kill switch quiet_refresh: hand each nudge to the page's RefreshOnReturn,
   *  which waits until nobody is typing, in a dialog or saving. */
  quiet?: boolean;
}) {
  const router = useRouter();
  const refresh = useCallback(() => {
    if (quiet) window.dispatchEvent(new Event(QUIET_REFRESH_EVENT));
    else router.refresh();
  }, [quiet, router]);

  // AND THE SAME NUDGE WHEN THE CHANNEL ITSELF COMES BACK. This is the console
  // half of the surface that opens the most bindings anywhere — three per event
  // plus the tournament-wide one — and Realtime caps how many a connection will
  // accept; past the cap the server's binding list disagrees with the client's,
  // supabase-js unsubscribes the WHOLE channel, and it says so only through the
  // status callback. A draw screen at the scoring table that has quietly gone
  // dead is worse here than on a phone: this is where the next round is called
  // from. Nothing replays the gap, so recovery re-fetches. See
  // use-live-channel.ts.
  // A recovery re-reads at once, quiet or not: it is rare, and the gap it
  // covers is unknown.
  const subscribe = useLiveChannel(() => router.refresh());

  // THE DEPENDENCY IS THE JOINED KEY, NOT THE ARRAY. `eventIds` is built by a
  // .map() in the server component, so it is a new array identity on every
  // render — depending on it directly would tear the channel down and open a
  // fresh one each time React re-rendered, which is how twenty channels happen
  // without anybody forgetting a cleanup.
  const key = eventIds.join(',');

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(channelName);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const nudge = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, COALESCE_MS);
    };

    // ONE LISTENER PER FILTER. postgres_changes takes a single filter
    // expression, so several events means several .on() calls — on one
    // channel, which is one socket. The filters are what keep the exec running
    // Saturday's mixed doubles from being woken by the men's singles two
    // courts over, and they are about noise rather than exposure: RLS already
    // decides what a subscriber may see, and here it lets every signed-in
    // member see everything.
    //
    // EVERY EVENT, AND SINCE 00120 THE DELETES TOO. `event: '*'` because a
    // score, a walkover, a void, a check-in, a seeding change and a status
    // transition all move what these tabs print.
    //
    // A DELETE USED NOT TO ARRIVE AT ALL: under default replica identity the
    // WAL's old tuple carries the primary key alone, so neither `event_id` nor
    // `tournament_id` is there for `filter` to match on. 00113 worked through
    // the four delete paths and judged the gap survivable, correctly for three
    // of them. 00120 closes the rest, and by three different routes because the
    // four paths are not one problem:
    //
    //   * AN ENTRY REMOVED during registration or check-in — the one 00113
    //     named as genuinely lost — now arrives as an UPDATE on
    //     `tournament_events`, which the tournament-wide listener below is
    //     already watching. A statement-level trigger touches the parent
    //     event's updated_at, and the refresh re-reads the entry list without
    //     the removed row. The delete event itself is still never delivered and
    //     does not need to be: nothing here reads a payload, it only refreshes.
    //     THE PRICE, quantified: removing an entrant from one event now also
    //     nudges a screen watching a SIBLING event of the same tournament. No
    //     other tournament, and no other screen in the club, hears anything.
    //
    //   * AN EVENT DELETED during registration now routes on its own —
    //     `tournament_events` is set to REPLICA IDENTITY FULL, which is safe
    //     there because every column is an id, a number, or a value picked from
    //     a fixed menu.
    //
    //   * CLEARING AN EVENT'S MATCHES to rebuild them needed nothing and got
    //     nothing: it is followed immediately by INSERTs, which DO route
    //     because an insert's tuple is the new row.
    //
    // THE ENTRY TABLES ARE DELIBERATELY LEFT ON DEFAULT REPLICA IDENTITY, which
    // is why the trigger exists at all. tournament_participants and
    // tournament_pairs still carry the `notes` column 00118 privatised but did
    // not drop, and tournament_pairs carries `pair_name`; FULL on either would
    // put an exec's disqualification reason on the wire in the delete path.
    // Both apps' guard tests pin that.
    //
    // KEEP THIS PROSE OUT OF THE CONFIG OBJECTS. The publication guards
    // (lib/__tests__/realtime-publication.test.ts in both apps) read each table
    // name out of the 400 characters following each postgres_changes literal,
    // so a long comment between the two hides the subscription from the very
    // test that exists to notice it. It did exactly that once, which is how
    // this note got here — and the name is written WITHOUT its quotes in this
    // sentence for the same family of reason, since the guard scans for the
    // quoted form and would otherwise open a scan position on a comment.

    // TOURNAMENT-WIDE, and the only one of the four that can be. This is the
    // one table carrying `tournament_id`, so a single listener covers every
    // event under it — including one that does not exist yet, which a
    // per-event `id=eq.` filter would miss. An exec adding an event while
    // another has the overview open is a change that overview has to show.
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'tournament_events',
        filter: `tournament_id=eq.${tournamentId}`,
      },
      nudge,
    );

    for (const eventId of key === '' ? [] : key.split(',')) {
      // BOTH ENTRY TABLES, ALWAYS. A singles event has participants and no
      // pairs, a doubles event has pairs and no participants, and a surface
      // that subscribed only to whichever one it happened to be rendering
      // would be live for half the club's events. Subscribing to both costs a
      // listener that never fires on the other kind of event.
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_participants',
          filter: `event_id=eq.${eventId}`,
        },
        nudge,
      );

      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_pairs',
          filter: `event_id=eq.${eventId}`,
        },
        nudge,
      );

      if (draw) {
        channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tournament_matches',
            filter: `event_id=eq.${eventId}`,
          },
          nudge,
        );
      }
    }

    const stopWatching = subscribe(channel);

    return () => {
      // The timer as well as the channel: a refresh queued a moment before the
      // exec navigated away would otherwise fire against an unmounted tree.
      clearTimeout(timer);
      // BEFORE removeChannel, not after: removing a channel unsubscribes it,
      // which delivers CLOSED to the status callback, and a watcher still
      // listening would read this teardown as an outage and queue a rebuild.
      stopWatching();
      void supabase.removeChannel(channel);
    };
  }, [channelName, tournamentId, key, draw, refresh, subscribe]);

  return null;
}
