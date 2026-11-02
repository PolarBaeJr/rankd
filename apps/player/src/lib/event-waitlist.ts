import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { doublesDrawSlots, ensureEntryFees, isOutOfEvent, wouldExceedCapacity } from '@badminton/shared';

/**
 * The per-event waitlist (00278), read and filled ON ITS OWN.
 *
 * Images update before migrations run, so the columns, the table and the
 * functions can all be missing. Every read here is separate from the page's
 * own selects, so a database without 00278 is "no waitlist" rather than a
 * broken page, and a fill that cannot run never fails the action that freed
 * the place.
 *
 * NOT 'use server': every export of such a module is a public action.
 */

function isColumnMissing(error: { code?: string } | null): boolean {
  return !!error && ['42703', 'PGRST204'].includes(error.code ?? '');
}

/** The waitlist table or functions are unknown to this database: 00278 is pending. */
export function isWaitlistMissing(error: { code?: string } | null | undefined): boolean {
  return !!error && ['42883', 'PGRST202', '42P01', 'PGRST205'].includes(error.code ?? '');
}

export interface MyWaitlistState {
  enabled: boolean;
  autoPromote: boolean;
  /** Everybody waiting for this event right now. */
  waitingCount: number;
  /** This member's place in the queue, 1 first, or null when not waiting. */
  myPosition: number | null;
  /** No room for one more entrant, by the slot rule enter_tournament_event uses. */
  full: boolean;
  /** How many members may wait at once (00312), or null for no limit. */
  limit: number | null;
  /** As many members are waiting as the limit allows: nobody else can join. */
  waitlistLimitReached: boolean;
}

/**
 * The event's waitlist limit (00312), read on its own so a database without
 * the column is "no limit". Never throws: any failed read is no limit too, and
 * join_event_waitlist still refuses under its lock.
 */
async function readWaitlistLimit(client: SupabaseClient, eventId: string): Promise<number | null> {
  try {
    const { data, error } = await client
      .from('tournament_events')
      .select('waitlist_limit' as never)
      .eq('id', eventId)
      .maybeSingle();
    if (error) return null;
    return (data as { waitlist_limit?: number | null } | null)?.waitlist_limit ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the event's waitlist is at its limit (00312). Never throws: false on
 * any failed read, so it only ever changes what a refusal says.
 */
export async function waitlistLimitReached(client: SupabaseClient, eventId: string): Promise<boolean> {
  try {
    const limit = await readWaitlistLimit(client, eventId);
    if (limit === null) return false;
    const { count, error } = await client
      .from('tournament_event_waitlist')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .eq('status', 'waiting');
    if (error) return false;
    return (count ?? 0) >= limit;
  } catch {
    return false;
  }
}

/**
 * Whether one more entrant would put the event over its limit: rows for
 * singles, pairs plus one slot per two loose entrants for doubles, withdrawn
 * and disqualified not counted. The function decides under its lock; this is
 * only which button to show.
 */
async function eventIsFull(
  client: SupabaseClient,
  eventId: string,
  max: number | null,
  doubles: boolean,
): Promise<boolean> {
  if (max === null || max <= 0) return false;
  const [loose, pairs] = await Promise.all([
    client.from('tournament_participants').select('status').eq('event_id', eventId),
    doubles ? client.from('tournament_pairs').select('status').eq('event_id', eventId) : null,
  ]);
  if (loose.error) throw new Error(`Could not count the entrants: ${loose.error.message}`);
  if (pairs?.error) throw new Error(`Could not count the pairs: ${pairs.error.message}`);
  const live = (rows: Array<{ status: string | null }> | null) =>
    (rows ?? []).filter((r) => !isOutOfEvent(r.status)).length;
  const unpaired = live(loose.data as Array<{ status: string | null }> | null);
  if (!doubles) return unpaired >= max;
  const formed = live((pairs?.data ?? null) as Array<{ status: string | null }> | null);
  return wouldExceedCapacity(doublesDrawSlots(formed, unpaired), doublesDrawSlots(formed, unpaired + 1), max);
}

/**
 * The event's waitlist settings and where this member stands in it. Null when
 * the database has no waitlist yet. Any other failed read throws: a queue that
 * could not be read is not an empty one.
 */
export async function getMyWaitlistState(
  client: SupabaseClient,
  eventId: string,
  playerId: string | null,
  entry: { max: number | null; doubles: boolean },
): Promise<MyWaitlistState | null> {
  const { data: ev, error: evError } = await client
    .from('tournament_events')
    .select('waitlist_enabled, waitlist_auto_promote')
    .eq('id', eventId)
    .maybeSingle();
  if (evError) {
    if (isColumnMissing(evError)) return null;
    throw new Error(`Could not read the waitlist settings: ${evError.message}`);
  }
  const settings = ev as { waitlist_enabled?: boolean; waitlist_auto_promote?: boolean } | null;
  if (!settings) return null;

  const { data: rows, error } = await client
    .from('tournament_event_waitlist')
    .select('player_id')
    .eq('event_id', eventId)
    .eq('status', 'waiting')
    .order('joined_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) {
    if (isWaitlistMissing(error)) return null;
    throw new Error(`Could not read the waitlist: ${error.message}`);
  }
  const queue = (rows ?? []) as Array<{ player_id: string }>;
  const index = playerId ? queue.findIndex((r) => r.player_id === playerId) : -1;
  const enabled = settings.waitlist_enabled === true;
  const limit = await readWaitlistLimit(client, eventId);
  return {
    enabled,
    autoPromote: settings.waitlist_auto_promote !== false,
    waitingCount: queue.length,
    myPosition: index >= 0 ? index + 1 : null,
    full: enabled ? await eventIsFull(client, eventId, entry.max, entry.doubles) : false,
    limit,
    waitlistLimitReached: limit !== null && queue.length >= limit,
  };
}

/** What fill_event_from_waitlist and join_event_waitlist report as promoted. */
export interface WaitlistPromotion {
  player_id: string;
  participant_id: string;
}

/**
 * Settle the entry fee for everybody a fill promoted. ensureEntryFees never
 * throws, because the promotion has already committed.
 */
export async function settleWaitlistPromotions(
  client: SupabaseClient,
  tournamentId: string | null | undefined,
  promoted: ReadonlyArray<WaitlistPromotion> | null | undefined,
): Promise<number> {
  const list = promoted ?? [];
  if (list.length === 0 || !tournamentId) return 0;
  await ensureEntryFees(client, tournamentId, list.map((p) => p.player_id));
  return list.length;
}

/**
 * After a member's own withdrawal frees a place, hand it to the head of the
 * waitlist when the event promotes automatically. A separate step that never
 * fails the withdrawal: anything that goes wrong is logged and swallowed.
 * p_actor is null because nobody at a desk promoted them.
 */
export async function fillFromWaitlistAfterFree(client: SupabaseClient, eventId: string): Promise<number> {
  try {
    const { data: ev, error: evError } = await client
      .from('tournament_events')
      .select('waitlist_enabled, waitlist_auto_promote')
      .eq('id', eventId)
      .maybeSingle();
    if (evError) {
      if (!isColumnMissing(evError)) Sentry.captureException(evError);
      return 0;
    }
    const settings = ev as { waitlist_enabled?: boolean; waitlist_auto_promote?: boolean } | null;
    if (!settings?.waitlist_enabled || !settings.waitlist_auto_promote) return 0;

    const { data, error } = await client.rpc('fill_event_from_waitlist', {
      p_event_id: eventId,
      p_actor: null,
      p_waitlist_id: null,
    });
    if (error) {
      Sentry.captureException(new Error(
        isWaitlistMissing(error)
          ? `Waitlist fill skipped, migration 00278 is not applied: ${error.message}`
          : `Waitlist fill failed: ${error.message}`,
      ));
      return 0;
    }
    const result = data as { tournament_id?: string; promoted?: WaitlistPromotion[] } | null;
    return await settleWaitlistPromotions(client, result?.tournament_id, result?.promoted);
  } catch (err) {
    Sentry.captureException(err);
    return 0;
  }
}
