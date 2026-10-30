import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { discordServiceUnauthorized, isAuthorizedDiscordService } from '@/lib/discord-service-auth';
import { checkDiscordManager, managerInput } from '@/lib/discord-manager';

export const dynamic = 'force-dynamic';

// Settings that belong to one Discord server rather than to the club (00302):
// where that server's log posts, whether the scam guard acts there, and how
// (00303: what it does, and what counts as a spray).
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

const AUTOMOD_ACTIONS = ['timeout_then_softban', 'timeout', 'softban', 'flag'] as const;
const AUTOMOD_WORDS_ACTIONS = ['delete', 'punish', 'flag'] as const;
const MAX_WORDS = 100;
const MAX_WORD_LENGTH = 30;
const MAX_TRAP_CHANNELS = 10;

// The same bounds as 00303's CHECKs, so a bad value is a named 400 here
// rather than a constraint error from the write.
const NUMBER_FIELDS = {
  automodTimeoutMinutes: { column: 'automod_timeout_minutes', min: 1, max: 10080 },
  automodSprayChannels: { column: 'automod_spray_channels', min: 2, max: 10 },
  automodSprayWindowMinutes: { column: 'automod_spray_window_minutes', min: 1, max: 10 },
} as const;
const SWITCH_FIELDS = {
  scamGuard: 'scam_guard',
  automodSpray: 'automod_spray',
  automodFlagSuspects: 'automod_flag_suspects',
} as const;
const CHOICE_FIELDS = {
  automodAction: { column: 'automod_action', allowed: AUTOMOD_ACTIONS },
  automodWordsAction: { column: 'automod_words_action', allowed: AUTOMOD_WORDS_ACTIONS },
  automodTrapAction: { column: 'automod_trap_action', allowed: AUTOMOD_ACTIONS },
} as const;

// One literal, not concatenated, so the client can still type the rows.
const COLUMNS =
  'guild_id, server_log_channel_id, scam_guard, automod_action, automod_timeout_minutes, automod_spray, automod_spray_channels, automod_spray_window_minutes, automod_flag_suspects, automod_words, automod_words_action, automod_trap_channel_ids, automod_trap_action';

export interface ServerSettings {
  guildId: string;
  serverLogChannelId: string | null;
  /** Auto mod's master switch (00302's name for it). */
  scamGuard: boolean;
  automodAction: (typeof AUTOMOD_ACTIONS)[number];
  automodTimeoutMinutes: number;
  automodSpray: boolean;
  automodSprayChannels: number;
  automodSprayWindowMinutes: number;
  automodFlagSuspects: boolean;
  automodWords: string[];
  automodWordsAction: (typeof AUTOMOD_WORDS_ACTIONS)[number];
  automodTrapAction: (typeof AUTOMOD_ACTIONS)[number];
  automodTrapChannelIds: string[];
}

/** A word list as stored: trimmed, lowercased, unique, no blanks. Null when it is not a list of short words. */
function cleanWords(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_WORDS) return null;
  const words = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const word = item.trim().toLowerCase();
    if (word.length > MAX_WORD_LENGTH) return null;
    if (word) words.add(word);
  }
  return [...words];
}

/** Every server's row. Few enough to send whole; the bot holds them for a minute. */
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const { data, error } = await createServiceRoleClient()
    .from('discord_server_settings')
    .select(COLUMNS);
  // Named, never an empty list: no rows would read as "nobody has a log".
  if (error) {
    console.error('[discord] server settings read failed:', error.message);
    return NextResponse.json({ error: 'server_settings_unavailable' }, { status: 503 });
  }
  const servers: ServerSettings[] = (data ?? []).map((row) => ({
    guildId: row.guild_id,
    serverLogChannelId: row.server_log_channel_id,
    scamGuard: row.scam_guard,
    automodAction: row.automod_action as ServerSettings['automodAction'],
    automodTimeoutMinutes: row.automod_timeout_minutes,
    automodSpray: row.automod_spray,
    automodSprayChannels: row.automod_spray_channels,
    automodSprayWindowMinutes: row.automod_spray_window_minutes,
    automodFlagSuspects: row.automod_flag_suspects,
    automodWords: row.automod_words,
    automodWordsAction: row.automod_words_action as ServerSettings['automodWordsAction'],
    automodTrapAction: row.automod_trap_action as ServerSettings['automodTrapAction'],
    automodTrapChannelIds: row.automod_trap_channel_ids,
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
  const fields = body as Record<string, unknown>;

  const write: Record<string, string | number | boolean | string[] | null> = {};
  const { serverLogChannelId } = fields;
  if (serverLogChannelId !== undefined) {
    if (serverLogChannelId !== null && (typeof serverLogChannelId !== 'string' || !SNOWFLAKE.test(serverLogChannelId))) {
      return NextResponse.json({ error: 'invalid_channel' }, { status: 400 });
    }
    write.server_log_channel_id = serverLogChannelId;
  }
  for (const [field, column] of Object.entries(SWITCH_FIELDS)) {
    const value = fields[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return NextResponse.json({ error: `invalid_${column}` }, { status: 400 });
    write[column] = value;
  }
  for (const [field, spec] of Object.entries(CHOICE_FIELDS)) {
    const value = fields[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !(spec.allowed as readonly string[]).includes(value)) {
      return NextResponse.json({ error: `invalid_${spec.column}` }, { status: 400 });
    }
    write[spec.column] = value;
  }
  for (const [field, spec] of Object.entries(NUMBER_FIELDS)) {
    const value = fields[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max) {
      return NextResponse.json({ error: `invalid_${spec.column}` }, { status: 400 });
    }
    write[spec.column] = value;
  }
  if (fields.automodWords !== undefined) {
    const words = cleanWords(fields.automodWords);
    if (!words) return NextResponse.json({ error: 'invalid_automod_words' }, { status: 400 });
    write.automod_words = words;
  }
  if (fields.automodTrapChannelIds !== undefined) {
    const ids = fields.automodTrapChannelIds;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_TRAP_CHANNELS ||
      !ids.every((id) => typeof id === 'string' && SNOWFLAKE.test(id))
    ) {
      return NextResponse.json({ error: 'invalid_automod_trap_channel_ids' }, { status: 400 });
    }
    write.automod_trap_channel_ids = [...new Set(ids as string[])];
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
