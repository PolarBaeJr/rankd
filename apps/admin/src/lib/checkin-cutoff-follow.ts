import * as Sentry from '@sentry/nextjs';
import { checkinCutoffInstant, eventStartInstant } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import { getReleaseFlags } from './release-flags';

type Admin = ReturnType<typeof createAdminClient>;

/** The tournament fields the check-in close is worked out from. */
export interface TournamentStart {
  start_date?: string | null;
  starts_time?: string | null;
  checkin_closes_at?: string | null;
}

/** Events still before their draw, whose check-in close can still matter. */
const BEFORE_THE_DRAW = ['registration', 'checkin'];

/** The default close for a start, or null when the start has no time of day. */
export function defaultCutoff(start: TournamentStart): string | null {
  if (!start.start_date || !start.starts_time) return null;
  return checkinCutoffInstant(eventStartInstant(start.start_date, start.starts_time)).toISOString();
}

/**
 * THE CHECK-IN CLOSE FOLLOWS THE START (checkin_cutoff_default). A new event
 * gets "15 minutes before the start" stamped as its own close, so when the
 * tournament's date or time changes that stamp would be left behind: moving
 * an event a day earlier left its close a day after the event, and the
 * no-show release would never have run on the day.
 *
 * Only a close that is still the default moves: one equal to the old start's
 * cutoff, or none at all where the old start had no time (the creation path
 * stamps nothing then). A close an exec set by hand is theirs and stays, as
 * does every event already drawn. A tournament-wide close set on the
 * tournament itself wins over the default, so then nothing is stamped.
 *
 * Returns how many events moved. Never throws: the tournament edit has
 * already been saved, and a failure here is reported, not raised.
 */
export async function followStartWithCheckinCutoff(
  adminClient: Admin,
  tournamentId: string,
  before: TournamentStart,
  after: TournamentStart,
): Promise<number> {
  try {
    const flags = await getReleaseFlags();
    if (!flags.checkin_cutoff_default) return 0;

    const oldCutoff = defaultCutoff(before);
    const newCutoff = after.checkin_closes_at ? null : defaultCutoff(after);
    if (oldCutoff === newCutoff) return 0;

    const { data: events, error } = await adminClient
      .from('tournament_events')
      .select('id, status, checkin_closes_at, external_event')
      .eq('tournament_id', tournamentId)
      .in('status', BEFORE_THE_DRAW);
    if (error) throw error;

    const oldInstant = oldCutoff ? Date.parse(oldCutoff) : null;
    const onTheDefault = (events ?? []).filter((event) => {
      const own = event.checkin_closes_at as string | null;
      if (own === null) return oldCutoff === null && !before.checkin_closes_at;
      return oldInstant !== null && Date.parse(own) === oldInstant;
    });
    if (onTheDefault.length === 0) return 0;

    const { error: updateError } = await adminClient
      .from('tournament_events')
      .update({ checkin_closes_at: newCutoff })
      .in('id', onTheDefault.map((event) => event.id as string));
    if (updateError) throw updateError;
    return onTheDefault.length;
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'checkin-cutoff-follow' }, extra: { tournamentId } });
    return 0;
  }
}
