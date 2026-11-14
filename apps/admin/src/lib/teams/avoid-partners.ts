import { NO_AVOID_LIST, type AvoidPartnerCheck } from '@badminton/shared';
import type { createAdminClient } from '../supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Who should not be paired at this event. The one loader for the avoid hook:
 * the drop-in avoid list is wanted but not built, so until it is this says
 * nobody, and every caller already passes its answer to the planner and the
 * server-side checks.
 */
export async function loadAvoidPartnerCheck(_adminClient: AdminClient, _eventId: string): Promise<AvoidPartnerCheck> {
  return NO_AVOID_LIST;
}
