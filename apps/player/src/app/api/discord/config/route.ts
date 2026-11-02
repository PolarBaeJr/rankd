import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { checkDiscordManager, managerInput } from '@/lib/discord-manager';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

/** A guild the bot should manage, and the role ids to use in it. */
interface GuildConfig {
  guildId: string;
  roles: Record<string, string>;
}

// The bot's runtime configuration: which servers it manages, which role ids map
// to which managed role, and where to write the audit log.
//
// These live in the database rather than the bot's env because they change
// while the code stands still — somebody creates a role, moves the audit
// channel, or the club adds a second server. Behind env each of those needs the
// container recreated, and a deploy that CLONES the previous container's env
// rather than re-reading the env file makes an env edit exactly the change that
// has silently failed to land before.
//
// Service-role and service-secret gated, same as /api/discord/members: there is
// no member session behind a bot request, and nothing here is any member's
// business.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const supabase = createServiceRoleClient();

  const [guildsResult, rolesResult, settingsResult] = await Promise.all([
    supabase.from('discord_guilds').select('guild_id, enabled'),
    supabase.from('discord_guild_roles').select('guild_id, role_name, role_id'),
    supabase.from('discord_settings').select('key, value'),
  ]);

  // ALL THREE are named rather than swallowed, and the reason is the one that
  // has bitten this project repeatedly: a failed PostgREST read arrives as an
  // EMPTY LIST, never an exception. Without these branches an unmigrated
  // database would answer "no guilds configured", the bot would report a
  // successful sweep over zero servers, and nothing anywhere would say why.
  for (const [what, result] of [
    ['guilds', guildsResult],
    ['roles', rolesResult],
    ['settings', settingsResult],
  ] as const) {
    if (result.error) {
      console.error(`[discord] config ${what} read failed:`, result.error.message);
      return NextResponse.json(
        { error: 'config_unavailable', detail: result.error.message },
        { status: 503 }
      );
    }
  }

  const enabled = new Set(
    (guildsResult.data ?? []).filter((g) => g.enabled).map((g) => g.guild_id)
  );

  const byGuild = new Map<string, Record<string, string>>();
  for (const row of rolesResult.data ?? []) {
    // A role row for a disabled or deleted guild is skipped rather than
    // resurrecting it. `enabled` is how a server is parked without losing the
    // nine role ids somebody typed in off Discord's UI.
    if (!enabled.has(row.guild_id)) continue;
    const roles = byGuild.get(row.guild_id) ?? {};
    roles[row.role_name] = row.role_id;
    byGuild.set(row.guild_id, roles);
  }

  const guilds: GuildConfig[] = [...enabled]
    // A guild with no roles yet is omitted, not sent as an empty map. The bot
    // treats an empty role map as "manage this server, apply nothing", which
    // would strip every managed role from everybody in it.
    .filter((guildId) => byGuild.has(guildId))
    .map((guildId) => ({ guildId, roles: byGuild.get(guildId) ?? {} }));

  const settings = new Map((settingsResult.data ?? []).map((s) => [s.key, s.value]));

  return NextResponse.json({
    guilds,
    auditChannelId: settings.get('audit_channel_id') ?? null,
  });
}

/** Mirrors the CHECK on discord_guild_roles.role_name (migration 00167). */
const MANAGED_ROLE_NAMES = new Set([
  'linked', 'session_staff', 'vp', 'executives',
  'competitive', 'recreation', 'internal', 'alumni', 'external',
]);

/** Discord snowflakes. Same shape the migration's CHECK enforces. */
const SNOWFLAKE = /^[0-9]{5,25}$/;

// Write the guild's role map, for /setup.
//
// This endpoint decides WHICH Discord role the bot hands to everyone who
// qualifies, so every field is validated here rather than trusted because it
// came from our own bot: the bot builds this payload from names it read out of
// somebody's guild, and "the caller is our code" is not the same claim as "the
// data is ours".
//
// UPSERT ONLY — it never deletes a role mapping. /setup sends what it could
// resolve, and a role it could not resolve this run (two roles with the same
// name, one moved above the bot) must not erase a mapping that was working
// yesterday. Removing one is a deliberate DELETE by a human.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { guildId, label, roles, auditChannelId } = (body ?? {}) as {
    guildId?: unknown; label?: unknown; roles?: unknown; auditChannelId?: unknown;
  };

  if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) {
    return NextResponse.json({ error: 'invalid_guild_id' }, { status: 400 });
  }
  if (label !== undefined && typeof label !== 'string') {
    return NextResponse.json({ error: 'invalid_label' }, { status: 400 });
  }
  if (auditChannelId !== undefined && (typeof auditChannelId !== 'string' || !SNOWFLAKE.test(auditChannelId))) {
    return NextResponse.json({ error: 'invalid_audit_channel_id' }, { status: 400 });
  }
  if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) {
    return NextResponse.json({ error: 'invalid_roles' }, { status: 400 });
  }

  // Only a club officer who may change settings, and (except for /setup)
  // only from a server the club has connected. See discord-manager.ts.
  const manager = managerInput(body);
  if (!manager) return NextResponse.json({ error: 'invalid_caller' }, { status: 400 });
  const managerCheck = await checkDiscordManager(createServiceRoleClient(), { ...manager, setup: true });
  if (!managerCheck.ok) {
    return managerCheck.refusal === 'unavailable'
      ? NextResponse.json({ error: 'caller_unavailable' }, { status: 503 })
      : NextResponse.json({ error: managerCheck.refusal }, { status: 403 });
  }

  const entries = Object.entries(roles as Record<string, unknown>);
  // An empty map would create a guild row with no roles, which the GET above
  // filters out anyway — so it would look like /setup succeeded and changed
  // nothing. Refused instead.
  if (entries.length === 0) {
    return NextResponse.json({ error: 'no_roles' }, { status: 400 });
  }
  for (const [name, id] of entries) {
    if (!MANAGED_ROLE_NAMES.has(name)) {
      return NextResponse.json({ error: 'unknown_role', detail: name }, { status: 400 });
    }
    if (typeof id !== 'string' || !SNOWFLAKE.test(id)) {
      return NextResponse.json({ error: 'invalid_role_id', detail: name }, { status: 400 });
    }
  }

  const supabase = createServiceRoleClient();

  // The guild row first: discord_guild_roles has a FK onto it, so the reverse
  // order fails outright rather than half-applying.
  const guildWrite = await supabase
    .from('discord_guilds')
    .upsert({ guild_id: guildId, ...(label ? { label } : {}) }, { onConflict: 'guild_id' });
  if (guildWrite.error) {
    console.error('[discord] config guild write failed:', guildWrite.error.message);
    return NextResponse.json({ error: 'write_failed', detail: guildWrite.error.message }, { status: 503 });
  }

  const roleWrite = await supabase
    .from('discord_guild_roles')
    .upsert(
      entries.map(([role_name, role_id]) => ({ guild_id: guildId, role_name, role_id: role_id as string })),
      { onConflict: 'guild_id,role_name' }
    );
  if (roleWrite.error) {
    console.error('[discord] config role write failed:', roleWrite.error.message);
    return NextResponse.json({ error: 'write_failed', detail: roleWrite.error.message }, { status: 503 });
  }

  if (auditChannelId !== undefined) {
    const settingWrite = await supabase
      .from('discord_settings')
      .upsert({ key: 'audit_channel_id', value: auditChannelId }, { onConflict: 'key' });
    if (settingWrite.error) {
      console.error('[discord] audit channel write failed:', settingWrite.error.message);
      return NextResponse.json({ error: 'write_failed', detail: settingWrite.error.message }, { status: 503 });
    }
  }

  return NextResponse.json({ ok: true, guildId, roles: entries.length });
}
