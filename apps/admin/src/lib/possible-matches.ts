import * as Sentry from '@sentry/nextjs';
import { isWorthAsking, matchExistingPeople, type DuplicateStrength } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import { memberIdentifier } from './member-identifier';

// "DID YOU MEAN" BEFORE A SECOND RECORD IS MADE.
//
// Nothing checked whether a person already had a record before the console or
// the event desk made one, so the same human ended up on the roster twice. The
// two creation actions ask this first and, when it finds somebody, hand the
// matches back instead of creating; the officer then picks the existing record
// or presses Create anyway, which is an explicit input the action reads. Only
// strong and likely matches stop a create: a shared surname and initial is too
// common to ask about.
//
// FAILS OPEN. The check is advice, so a failed read is reported and the create
// goes ahead, rather than the desk being unable to add anybody.

export interface ExistingMatch {
  id: string;
  name: string;
  /** The handle as @handle, else the member code, else null. */
  identifier: string | null;
  strength: DuplicateStrength;
  reasons: string[];
}

export async function existingPeopleLike(
  adminClient: ReturnType<typeof createAdminClient>,
  typed: { full_name: string; email?: string | null },
): Promise<ExistingMatch[]> {
  const { data, error } = await adminClient
    .from('players')
    .select('id, first_name, last_name, full_name, handle, email, member_code, phone')
    .limit(5000);
  if (error) {
    Sentry.captureException(error, { tags: { step: 'existing-people-like' } });
    return [];
  }
  const rows = data ?? [];
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  return matchExistingPeople(typed, rows)
    .filter((match) => isWorthAsking(match.strength))
    .slice(0, 5)
    .map((match) => {
      const row = byId.get(match.id)!;
      return {
        id: match.id,
        name: row.full_name?.trim() ? (row.full_name as string) : 'No name yet',
        identifier: memberIdentifier(row),
        strength: match.strength,
        reasons: match.reasons,
      };
    });
}
