import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from './supabase-server';
import { accessLevelFor, isAdminRole, isInGoodStanding, permissionsOf, permits } from './permissions';

type AdminClient = ReturnType<typeof createAdminClient>;

// WHO HEARS THAT A POST IS READY: the results to copy (00333) and a set of
// social slides. The two marketing portfolios seeded in 00237 carry
// announcements.socialposts.read, and so does anybody an admin grants it to.
//
// NOT permits() ALONE. The capability is a read, so every officer holds it
// through the floor, and asking permits() would notify the whole committee. A
// recipient is somebody GIVEN it: the grant on their row, or one of the two
// portfolios as their label, and then permits() to honour a revoke and their
// standing. An admin holds everything by level and is notified only when
// granted explicitly, or as the fallback below.
//
// NOBODY HOLDING IT IS NOT NOBODY TOLD. With no holder the notice goes to the
// admins, so a post is never ready for nobody.

export const SOCIAL_POSTS_CAPABILITY = 'announcements.socialposts.read' as const;

export const MARKETING_BASELINE_IDS = [
  '5eed0060-0000-4000-8000-000000000204',
  '5eed0060-0000-4000-8000-000000000206',
] as const;

const COLUMNS =
  'id, role, is_exec, is_trainer, is_banned, status, active_flag, permission_role, permission_grants, permission_revokes, permission_baseline_id';

interface RecipientRow {
  id: string;
  role: string | null;
  is_exec: boolean | null;
  is_trainer: boolean | null;
  is_banned: boolean | null;
  status: string | null;
  active_flag: boolean | null;
  permission_role: string | null;
  permission_grants: string[] | null;
  permission_revokes: string[] | null;
  permission_baseline_id: string | null;
}

export function isMarketingHolder(row: RecipientRow): boolean {
  if (!isInGoodStanding(row)) return false;
  const given =
    (row.permission_grants ?? []).includes(SOCIAL_POSTS_CAPABILITY) ||
    (MARKETING_BASELINE_IDS as readonly string[]).includes(row.permission_baseline_id ?? '');
  if (!given) return false;
  if ((row.permission_revokes ?? []).includes(SOCIAL_POSTS_CAPABILITY)) return false;
  const level = accessLevelFor(row);
  return permits(level, permissionsOf(level, row), SOCIAL_POSTS_CAPABILITY);
}

/**
 * The player ids to notify, holders first and admins when there are none.
 * Empty only when nothing could be read, which is reported.
 */
export async function loadMarketingRecipients(adminClient: AdminClient): Promise<string[]> {
  const [granted, labelled] = await Promise.all([
    adminClient.from('players').select(COLUMNS).contains('permission_grants', [SOCIAL_POSTS_CAPABILITY]),
    adminClient.from('players').select(COLUMNS).in('permission_baseline_id', [...MARKETING_BASELINE_IDS]),
  ]);
  if (granted.error || labelled.error) {
    Sentry.captureException(
      new Error(`Marketing recipients could not be read: ${(granted.error ?? labelled.error)!.message}`),
    );
  }
  const holders = new Set<string>();
  for (const row of [...(granted.data ?? []), ...(labelled.data ?? [])] as unknown as RecipientRow[]) {
    if (isMarketingHolder(row)) holders.add(row.id);
  }
  if (holders.size > 0) return [...holders];

  const { data: admins, error } = await adminClient
    .from('players')
    .select(COLUMNS)
    .in('role', ['admin', 'super_admin']);
  if (error) {
    Sentry.captureException(new Error(`Admin fallback recipients could not be read: ${error.message}`));
    return [];
  }
  return ((admins ?? []) as unknown as RecipientRow[])
    .filter((row) => isAdminRole(row.role) && isInGoodStanding(row))
    .map((row) => row.id);
}
