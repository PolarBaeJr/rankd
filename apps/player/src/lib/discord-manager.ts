import type { createServiceRoleClient } from '@/lib/supabase-server';
import { resolveDiscordOfficer } from '@/lib/discord-officer';

// Who may change how the bot is set up for the club: /setup and /config.
//
// THE BOT RUNS IN ANY SERVER. Anyone may add it to their own server and use
// it there. What they must never do is change the club's setup from there:
// the relay channels, the log channels and the ping roles are one set for the
// whole club (discord_settings has no guild column), so a server admin who ran
// /config in their own server would otherwise point the club's moderation log
// at their own channel. Discord's admin rights in THAT server say nothing about
// the club.
//
// So both commands ask two questions, and both answers come from the club's
// records rather than from Discord:
//
//   1. The caller's linked club account holds `platform.settings.write`, the
//      capability the console's settings require.
//   2. The server is one the club has connected (a discord_guilds row), except
//      for /setup, which is how a server gets connected and so is the one
//      command allowed in a new one, still behind (1).

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export type ManagerRefusal = 'not_linked' | 'not_permitted' | 'server_not_connected' | 'unavailable';

export type ManagerCheck = { ok: true } | { ok: false; refusal: ManagerRefusal };

export async function checkDiscordManager(
  supabase: ServiceClient,
  input: { discordUserId: string; guildId: string; setup?: boolean }
): Promise<ManagerCheck> {
  const officer = await resolveDiscordOfficer(supabase, input.discordUserId, 'platform.settings.write');
  if (!officer.ok) return officer;
  if (input.setup) return { ok: true };

  const { data, error } = await supabase
    .from('discord_guilds')
    .select('guild_id')
    .eq('guild_id', input.guildId)
    .eq('enabled', true)
    .maybeSingle();
  if (error) {
    // Named, never read as "not connected": a failed read is not an answer.
    console.error('[discord] manager guild read failed:', error.message);
    return { ok: false, refusal: 'unavailable' };
  }
  return data ? { ok: true } : { ok: false, refusal: 'server_not_connected' };
}

/** Pulls the caller and the server out of a bot request body. */
export function managerInput(body: unknown): { discordUserId: string; guildId: string } | null {
  const { discordUserId, guildId } = (body ?? {}) as { discordUserId?: unknown; guildId?: unknown };
  if (typeof discordUserId !== 'string' || !/^\d{5,25}$/.test(discordUserId)) return null;
  if (typeof guildId !== 'string' || !/^\d{5,25}$/.test(guildId)) return null;
  return { discordUserId, guildId };
}
