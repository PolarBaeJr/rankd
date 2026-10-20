import type { PlayerStatus } from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';

/**
 * The ladder profile of somebody who is not you.
 *
 * FIX-LIST #11. `players.status` is a SELECT grant `authenticated` holds, and
 * the enum it carries is not one vocabulary but two: `competitive` /
 * `recreational` are the member's own competitive track, and `suspended` /
 * `pending_approval` are moderation decisions the club made ABOUT them.
 * /leaderboard/[playerId] read the column with the member's own key and drew
 * whichever value came back as a pill, so tapping a name in the feed told you
 * that the club had suspended that person.
 *
 * 00032's header says it withheld every moderation flag — `is_banned`,
 * `ban_reason`, `fee_exempt` were all correctly revoked. `status` was left
 * granted because of its other half, and the moderation half rode along.
 *
 * The fix is the shape challengeable-opponents.ts already uses for `is_banned`:
 * read on the server with the service-role key and COLLAPSE the value before it
 * leaves this module, so what reaches the component cannot say `suspended` at
 * all. That also frees the grant — after this, nothing in either app reads
 * `players.status` through the anon key, so 00151 can revoke it without a
 * single read going 403. (The admin console reads players exclusively through
 * createAdminClient(); the player app's other status readers — the calendar
 * feed, passkey login, reactivate, listChallengeableOpponents — are already
 * service-role.)
 */
export interface PublicProfile {
  id: string;
  full_name: string;
  avatar_url: string | null;
  bio: string | null;
  hide_from_leaderboard: boolean;
  /**
   * The status this particular viewer is entitled to see, already decided.
   * Null means "draw no pill" — either the member is in a moderation state and
   * the viewer is not entitled to know, or the value is one this app does not
   * recognise. The component renders it and asks no further questions.
   */
  visibleStatus: PlayerStatus | null;
}

/** The half of the enum that is the member's own competitive track. */
export const PUBLIC_TRACKS = ['competitive', 'recreational'] as const;

/**
 * Own row (and the console's own admins, who read it in the console anyway)
 * see the real value — hiding a suspension from the suspended member would be
 * a bug, not a privacy feature, and it is exactly the carve-out #14's
 * `hidesRatings` makes. Everyone else sees the track or nothing.
 */
export function statusForViewer(
  status: string | null | undefined,
  selfOrAdmin: boolean,
): PlayerStatus | null {
  if (!status) return null;
  if (selfOrAdmin) return status as PlayerStatus;
  return (PUBLIC_TRACKS as readonly string[]).includes(status)
    ? (status as PlayerStatus)
    : null;
}

/** The row rule of `players_select` (00005_rls.sql), re-applied by hand. */
export function mayViewRow(
  status: string | null | undefined,
  isSelf: boolean,
  isAdmin: boolean,
): boolean {
  return status !== 'pending_approval' || isSelf || isAdmin;
}

export interface ProfileViewer {
  id?: string | null;
  role?: string | null;
}

export async function getPublicProfile(
  playerId: string,
  viewer: ProfileViewer | null,
): Promise<PublicProfile | null> {
  const { data, error } = await createServiceRoleClient()
    .from('players')
    .select('id, full_name, avatar_url, status, bio, hide_from_leaderboard, is_guest')
    .eq('id', playerId)
    .maybeSingle();

  if (error || !data) return null;

  // THE SERVICE-ROLE KEY SKIPS RLS AS WELL AS THE COLUMN GRANTS, so every row
  // filter players_select applied has to be re-applied here or this "privacy
  // fix" would publish rows the member client could not reach: pending-approval
  // members are visible only to themselves and to admins.
  const isSelf = !!viewer?.id && viewer.id === data.id;
  const isAdmin = viewer?.role === 'admin';
  if (!mayViewRow(data.status, isSelf, isAdmin)) return null;
  // A guest (00292) is a Google Form entrant, not a member: no public profile.
  if (data.is_guest && !isAdmin) return null;

  return {
    id: data.id,
    full_name: data.full_name,
    avatar_url: data.avatar_url ?? null,
    bio: data.bio ?? null,
    hide_from_leaderboard: data.hide_from_leaderboard === true,
    visibleStatus: statusForViewer(data.status, isSelf || isAdmin),
  };
}
