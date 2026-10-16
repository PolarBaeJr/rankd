import { isExpectedFailure, isSelfReactivatable } from '@badminton/shared';
import type { createServiceRoleClient } from '@/lib/supabase-server';
import { assertPlayerStanding } from '@/lib/actions/_shared';
import { assertFeatureOn } from '@/lib/feature-gate';
import { evaluateLegalGate } from '@/lib/legal-gate';

// The member-facing twin of discord-officer.ts. /challenge acts AS the member
// who typed it, so the caller's Discord id is resolved to their club account
// here, through player_discord_links, and nowhere else. The bot's service
// secret proves the request came from the bot, not who typed the command.

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

/**
 * The same shape getCurrentPlayer() returns on the web (the whole players row,
 * its ratings and its legal acceptances), so the standing, feature and waiver
 * checks the web runs can run on it unchanged.
 */
export type DiscordMember = Record<string, unknown> & {
  id: string;
  full_name: string;
  status: string;
  is_banned: boolean | null;
  active_flag: boolean | null;
  waiver_reset_at?: string | null;
  waiver_acceptances?: { document: string; version: string; accepted_at: string }[] | null;
};

export type MemberCheck =
  | { ok: true; player: DiscordMember }
  | { ok: false; refusal: 'not_linked' | 'unavailable' };

export async function resolveDiscordMember(
  supabase: ServiceClient,
  discordUserId: string
): Promise<MemberCheck> {
  const { data: link, error: linkError } = await supabase
    .from('player_discord_links')
    .select('player_id, players!inner(*, ratings(*), waiver_acceptances(document, version, accepted_at))')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();

  if (linkError) {
    // NAMED, never degraded to "no link": telling a linked member to run /link
    // would send them to a command that then refuses them as already linked.
    console.error('[discord] member read failed:', linkError.message);
    return { ok: false, refusal: 'unavailable' };
  }

  const player = ((link as unknown as { players?: unknown } | null)?.players ??
    null) as DiscordMember | null;
  if (!player) return { ok: false, refusal: 'not_linked' };
  return { ok: true, player };
}

/**
 * Discord ids to player ids, for the OTHER people a command names (opponent,
 * partners). An id with no link is simply absent from the map; a failed read
 * is 'unavailable', never an empty map.
 */
export async function resolveLinkedPlayerIds(
  supabase: ServiceClient,
  discordUserIds: string[]
): Promise<Map<string, string> | 'unavailable'> {
  if (discordUserIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('player_discord_links')
    .select('discord_user_id, player_id')
    .in('discord_user_id', discordUserIds);
  if (error) {
    console.error('[discord] linked player read failed:', error.message);
    return 'unavailable';
  }
  return new Map(
    ((data ?? []) as { discord_user_id: string; player_id: string }[]).map((row) => [
      row.discord_user_id,
      row.player_id,
    ])
  );
}

/**
 * Why a linked member may not play from Discord right now. A closed set: the
 * bot matches on the code and writes its own sentence for each.
 *
 *   lapsed       deactivated by the inactivity sweep. The web reactivates on
 *                sign-in; Discord does not write that, so it sends them there.
 *   standing     pending approval, suspended, banned, or asked to be deleted.
 *   feature_off  the club has switched the feature off (challenges, or fees).
 *   waiver       a current legal document is not accepted.
 */
export type PlayRefusal = 'not_linked' | 'lapsed' | 'standing' | 'feature_off' | 'waiver';

/**
 * Everything the web checks before a member action, for a caller resolved
 * from Discord, in the order requirePlayer() checks it. 'unavailable' means a
 * read failed and the route answers 503; it is never a refusal.
 *
 * The defaults are a challenge's checks. `feature` is the switch the web action
 * asserts, and `waiver` whether it also asserts the current legal documents:
 * a challenge does, sending a fee receipt (/receipt) does not.
 */
export async function resolveDiscordPlayer(
  supabase: ServiceClient,
  discordUserId: string,
  checks: { feature?: 'challenges' | 'fees'; waiver?: boolean } = {}
): Promise<
  | { ok: true; player: DiscordMember }
  | { ok: false; refusal: PlayRefusal }
  | { ok: false; refusal: 'unavailable' }
> {
  const member = await resolveDiscordMember(supabase, discordUserId);
  if (!member.ok) return member;
  const player = member.player;

  try {
    assertPlayerStanding(player);
  } catch (err) {
    if (isExpectedFailure(err)) return { ok: false, refusal: 'standing' };
    throw err;
  }
  if (player.active_flag === false) {
    return {
      ok: false,
      refusal: isSelfReactivatable(player as Parameters<typeof isSelfReactivatable>[0]) ? 'lapsed' : 'standing',
    };
  }

  try {
    await assertFeatureOn(checks.feature ?? 'challenges', player as Parameters<typeof assertFeatureOn>[1]);
  } catch (err) {
    if (isExpectedFailure(err)) return { ok: false, refusal: 'feature_off' };
    throw err;
  }

  if (checks.waiver === false) return { ok: true, player };

  // evaluateLegalGate directly rather than assertCurrentWaiver, so a failed
  // read is a 503 and not a sentence telling the member to sign something.
  const gate = await evaluateLegalGate(supabase, player);
  if (gate.status === 'unavailable') return { ok: false, refusal: 'unavailable' };
  if (gate.missing.length > 0) return { ok: false, refusal: 'waiver' };

  return { ok: true, player };
}
