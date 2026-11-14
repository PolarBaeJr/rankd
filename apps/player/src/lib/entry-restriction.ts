import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { ExpectedError, formatClubEventTime } from '@badminton/shared';

/**
 * An exec's restriction on entering events (00324), read at entry.
 *
 * FAILS CLOSED on a real error: a restriction that cannot be read is not
 * evidence there is none, and the cost of refusing is one retry. A database
 * without 00324 has no restrictions, so the missing table is "none".
 *
 * An exec adding the member at the desk does not come through here.
 *
 * NOT 'use server': every export of such a module is a public action.
 */

export interface ActiveEntryRestriction {
  id: string;
  endsAt: string | null;
}

export async function activeEntryRestriction(
  service: SupabaseClient,
  playerId: string,
): Promise<ActiveEntryRestriction | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = await service
    .from('event_entry_restrictions')
    .select('id, ends_at')
    .eq('player_id', playerId)
    .is('lifted_at', null)
    .lte('starts_at', nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .order('ends_at', { ascending: false, nullsFirst: true })
    .limit(1);
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code ?? '')) return null;
    Sentry.captureException(error, { tags: { action: 'activeEntryRestriction' } });
    throw new ExpectedError('Cannot check your entry right now, please try again shortly.');
  }
  const row = (data ?? [])[0] as { id: string; ends_at: string | null } | undefined;
  return row ? { id: row.id, endsAt: row.ends_at } : null;
}

export function entryRestrictionMessage(restriction: ActiveEntryRestriction): string {
  return restriction.endsAt
    ? `You cannot enter events until ${formatClubEventTime(restriction.endsAt)} after missed events. Contact an exec.`
    : 'You cannot enter events until an exec lifts it, after missed events. Contact an exec.';
}

/** Refuses a restricted member. */
export async function assertNoEntryRestriction(service: SupabaseClient, playerId: string): Promise<void> {
  const restriction = await activeEntryRestriction(service, playerId);
  if (restriction) throw new ExpectedError(entryRestrictionMessage(restriction));
}
