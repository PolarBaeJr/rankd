import * as Sentry from '@sentry/nextjs';
import { ExpectedError } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Who of these members is under an exec's entry restriction (00324) now.
 *
 * The player app's own check (apps/player/src/lib/entry-restriction.ts) reads
 * the same rows for one member at a time; this reads a batch for the teams
 * builder, which applies restrictions to desk pairing because the owner asked
 * (wave 1 exempts the ordinary desk add).
 *
 * FAILS CLOSED: a restriction that cannot be read is not evidence there is
 * none. A database without 00324 has no restrictions.
 *
 * NOT 'use server': every export of such a module is a public action.
 */
export async function loadRestrictedPlayerIds(adminClient: AdminClient, playerIds: readonly string[]): Promise<Set<string>> {
  if (playerIds.length === 0) return new Set();
  const nowIso = new Date().toISOString();
  const { data, error } = await adminClient
    .from('event_entry_restrictions')
    .select('player_id')
    .in('player_id', [...playerIds])
    .is('lifted_at', null)
    .lte('starts_at', nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`);
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code ?? '')) return new Set();
    Sentry.captureException(error, { tags: { action: 'loadRestrictedPlayerIds' } });
    throw new ExpectedError('Could not check entry restrictions. Nothing was changed, try again.');
  }
  return new Set((data ?? []).map((row) => row.player_id));
}
