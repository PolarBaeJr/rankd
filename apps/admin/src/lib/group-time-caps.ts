import { capReached, readReleaseFlags, scopeLocked, type CappableMatch, type GroupTimeCap } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';

// The group time caps of an event (00331) that are reached: applied, or due
// and waiting for the minute job. Empty with group_time_cap off or before the
// migration, which is what the console did before caps.
export async function readReachedTimeCaps(
  client: ReturnType<typeof createAdminClient>,
  eventId: string,
): Promise<GroupTimeCap[]> {
  if (!(await readReleaseFlags(client)).group_time_cap) return [];
  const { data, error } = await client.from('stage_group_time_caps')
    .select('id, stage, pool_number, group_number, cap_at, applied_at')
    .eq('event_id', eventId);
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code ?? '')) return [];
    throw new Error(`Could not read the group time caps: ${error.message}`);
  }
  const now = new Date();
  return ((data ?? []) as GroupTimeCap[]).filter((cap) => capReached(cap, now));
}

export const TIME_CAP_LOCKED = 'This group\'s time cap has passed, so its table stands.';

export function lockedByTimeCap(caps: readonly GroupTimeCap[], match: CappableMatch): boolean {
  return scopeLocked(caps, match, new Date());
}
