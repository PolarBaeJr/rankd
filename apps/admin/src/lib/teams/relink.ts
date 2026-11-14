import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from '../supabase-server';
import { releaseFlagOn } from '../release-flags';

type AdminClient = ReturnType<typeof createAdminClient>;

// THE CONFIRMATION ROWS FOLLOW THE ENTRY (00334). Every path that forms,
// splits or changes a team calls this after its write has committed: Add pair,
// Auto pair, unpair, swap, and the teams tools. Best effort: a failure is
// reported and swallowed, because the pairing has already happened and must
// not read as refused. A database without 00334 has no function to call, and
// that is a no-op.
//
// NOT 'use server': every export of such a module is a public action.

const MISSING_FUNCTION = new Set(['PGRST202', '42883']);

/** Repoint the members' confirmation rows to their current entries. Never throws. */
export async function relinkConfirmations(adminClient: AdminClient, eventId: string, playerIds: readonly (string | null | undefined)[]): Promise<void> {
  const ids = [...new Set(playerIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  try {
    if (!(await releaseFlagOn('entry_confirmation'))) return;
    const { error } = await adminClient.rpc('relink_event_confirmations', { p_event_id: eventId, p_player_ids: ids });
    if (error && !MISSING_FUNCTION.has(error.code ?? '')) {
      Sentry.captureException(error, { tags: { action: 'relinkConfirmations' } });
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { action: 'relinkConfirmations' } });
  }
}
