'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { ExpectedError, isUuid } from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';
import { requirePlayer, runAction, type ActionResult } from './actions/_shared';
import { loadOwnImportEntry } from './registration-import';

// "NOT ME" ON A GOOGLE FORM ENTRY (00283). Somebody typed this member's email
// into a club form. The entry is refused, never entered, and the exec who bound
// the form (or the admins) is alerted. The entry id is checked against the
// signed-in member, so nobody can refuse another member's entry.
//
// The two confirm actions live beside the self-entry paths they reuse, in
// tournament-actions.ts and club-event-actions.ts.

export async function rejectImportedEntry(entryId: string): Promise<ActionResult> {
  return runAction(() => rejectImportedEntryImpl(entryId));
}

async function rejectImportedEntryImpl(entryId: string): Promise<void> {
  if (!isUuid(entryId)) throw new ExpectedError('That entry could not be found.');
  const player = await requirePlayer();
  const service = createServiceRoleClient();
  const entry = await loadOwnImportEntry(service, entryId, player.id);
  if (entry.status !== 'awaiting_member') throw new ExpectedError('This entry is no longer waiting for you.');

  const { data, error } = await service.rpc('reject_registration_import_entry', {
    p_entry_id: entryId,
    p_player_id: player.id,
  });
  if (error) {
    Sentry.captureException(error, { tags: { action: 'rejectImportedEntry' } });
    throw new ExpectedError('That did not go through. Please try again shortly.');
  }
  const result = data as { ok?: boolean; reason?: string } | null;
  if (!result?.ok) {
    throw new ExpectedError(
      result?.reason === 'not_waiting' ? 'This entry is no longer waiting for you.' : 'That entry could not be found.',
    );
  }
  revalidatePath(`/registrations/${entryId}`);
  revalidatePath('/notifications');
}
