import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { discordServiceUnauthorized, isAuthorizedDiscordService } from '@/lib/discord-service-auth';
import { checkDiscordManager, managerInput } from '@/lib/discord-manager';

export const dynamic = 'force-dynamic';

// Settings that belong to one Discord server rather than to the club (00302):
// where that server's log posts, and whether the scam guard acts there.
//
// WHO MAY WRITE. The bot only sends a write for somebody holding Manage Server
// in the server they typed it in, and always names that server, never one the
// caller chose. That is enough in a server of their own. In one of the CLUB'S
// servers it is not: the log there carries the text of deleted messages, and
// "a Discord admin is not enough" is the rule /config already keeps. So a club
// server also needs the caller's linked club account to pass the same check as
// /config (discord-manager.ts).
//
// Service-secret gated like every route under /api/discord.

const SNOWFLAKE = /^\d{17,20}$/;

export interface ServerSettings {
  guildId: string;
  serverLogChannelId: string | null;
  scamGuard: boolean;
}

/** Every server's row. Few enough to send whole; the bot holds them for a minute. */
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const { data, error } = await createServiceRoleClient()
    .from('discord_server_settings')
    .select('guild_id, server_log_channel_id, scam_guard');
  // Named, never an empty list: no rows would read as "nobody has a log".
  if (error) {
    console.error('[discord] server settings read failed:', error.message);
    return NextResponse.json({ error: 'server_settings_unavailable' }, { status: 503 });
  }
  const servers: ServerSettings[] = (data ?? []).map((row) => ({
    guildId: row.guild_id,
    serverLogChannelId: row.server_log_channel_id,
    scamGuard: row.scam_guard,
  }));
  return NextResponse.json({ servers });
}

/**
 * One server's change. `serverLogChannelId: null` switches its log off; a key
 * left out is left alone.
 */
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const caller = managerInput(body);
  if (!caller || !SNOWFLAKE.test(caller.guildId)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { serverLogChannelId, scamGuard } = body as { serverLogChannelId?: unknown; scamGuard?: unknown };

  const write: { server_log_channel_id?: string | null; scam_guard?: boolean } = {};
  if (serverLogChannelId !== undefined) {
    if (serverLogChannelId !== null && (typeof serverLogChannelId !== 'string' || !SNOWFLAKE.test(serverLogChannelId))) {
      return NextResponse.json({ error: 'invalid_channel' }, { status: 400 });
    }
    write.server_log_channel_id = serverLogChannelId;
  }
  if (scamGuard !== undefined) {
    if (typeof scamGuard !== 'boolean') return NextResponse.json({ error: 'invalid_scam_guard' }, { status: 400 });
    write.scam_guard = scamGuard;
  }
  if (Object.keys(write).length === 0) return NextResponse.json({ error: 'nothing_to_change' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const { data: club, error: clubError } = await supabase
    .from('discord_guilds')
    .select('guild_id')
    .eq('guild_id', caller.guildId)
    .eq('enabled', true)
    .maybeSingle();
  if (clubError) {
    console.error('[discord] server settings guild read failed:', clubError.message);
    return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
  }
  if (club) {
    const check = await checkDiscordManager(supabase, caller);
    if (!check.ok) {
      if (check.refusal === 'unavailable') return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
      return NextResponse.json({ error: check.refusal }, { status: 403 });
    }
  }

  const { error } = await supabase
    .from('discord_server_settings')
    .upsert({ guild_id: caller.guildId, ...write, updated_at: new Date().toISOString() }, { onConflict: 'guild_id' });
  if (error) {
    console.error('[discord] server settings write failed:', error.message);
    return NextResponse.json({ error: 'server_settings_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
