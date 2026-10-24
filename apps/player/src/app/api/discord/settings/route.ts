import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { checkDiscordManager, managerInput } from '@/lib/discord-manager';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// The club's runtime settings for the Discord relays: which channel each one
// posts to, and the handful of values the schema has no column for.
//
// WHY THIS IS A SEPARATE ROUTE FROM /api/discord/config. That one writes the
// guild and its role mappings and refuses a payload with no roles in it
// (`no_roles`), which is right for /setup and useless here — changing the
// announcement channel is not a role change and must not require sending the
// role map along with it. It also only ever knew about `audit_channel_id`.
//
// SETTINGS ARE GLOBAL, NOT PER-GUILD. `discord_settings` has key as its whole
// primary key (00167) — there is no guild_id column. One club, one server per
// environment, so this is correct today; a second guild would need the table
// widened first, and this route rewritten with it. Deliberately not built for
// a shape that does not exist.
//
// Service-role and service-secret gated, same as every other route under
// /api/discord: there is no member session behind a bot request.

/**
 * EVERY KEY THAT MAY BE WRITTEN, AND HOW TO CHECK IT.
 *
 * A whitelist rather than "upsert whatever arrives", and that is the security
 * boundary of this route. `discord_settings` is service-role only and is read
 * by six different relays; an endpoint that accepted an arbitrary key would let
 * anything holding the service secret write config those relays trust — an
 * arbitrary-config-write primitive dressed up as a settings form.
 *
 * The bot has its own copy of this list to build the slash command from. That
 * duplication is intended: the bot's copy is a menu, this one is the rule, and
 * a bot rolled ahead of its player app must not be able to widen it.
 */
const SNOWFLAKE = /^\d{17,20}$/;

type Check = (value: string) => string | null;

const channel: Check = (v) => (SNOWFLAKE.test(v) ? null : 'not a channel id');
const role: Check = (v) => (SNOWFLAKE.test(v) ? null : 'not a role id');

const WRITABLE: Record<string, Check> = {
  announcement_channel_id: channel,
  session_ping_channel_id: channel,
  session_board_channel_id: channel,
  match_results_channel_id: channel,
  feedback_channel_id: channel,
  event_feedback_channel_id: channel,
  audit_channel_id: channel,
  // The server log is not here: it belongs to each server (server-settings).
  // Read by the session-pings route before it falls back to /rolepicker rows.
  session_ping_all_role_id: role,
  session_ping_competitive_role_id: role,
  session_ping_recreational_role_id: role,
  // The tournament times and location are not here since 00304: each
  // tournament keeps its own, set in the console or with /tourney details. The
  // tournament-events route still reads any old club-wide value as a fallback,
  // but nothing writes one any more.
  // The floor is not cosmetic: the ping job runs every five minutes, so a lead
  // time under that would be missed as often as it was hit.
  session_ping_lead_minutes: (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 5 && n <= 1440 ? null : 'must be 5-1440 minutes';
  },
};

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from('discord_settings').select('key, value');

  // NAMED, never degraded to an empty list. A failed PostgREST read arrives as
  // data:null with an error rather than throwing, and answering {} would tell
  // the club every relay is unconfigured — which is the exact screen they would
  // be looking at this for.
  if (error) {
    console.error('[discord] settings read failed:', error.message);
    return NextResponse.json({ error: 'settings_unavailable', detail: error.message }, { status: 503 });
  }

  const settings: Record<string, string> = {};
  for (const row of (data ?? []) as { key: string; value: string | null }[]) {
    // Only the keys this route governs. Anything else in the table is not
    // something /config can show or change, and listing it would invite it.
    if (row.key in WRITABLE && row.value !== null) settings[row.key] = row.value;
  }

  return NextResponse.json({ settings });
}

// A null value DELETES the key, and that is the whole reason the payload is a
// map of key to `string | null` rather than a map of key to string.
//
// Every relay treats a missing key as "not configured, post nothing". Without a
// way to send null, a club could switch a relay on and never off again: writing
// an empty string instead would leave `''` in the column, which `?? null` does
// not catch and `.trim() || null` catches only in the two routes that happen to
// spell it that way. Deleting the row is the one form every reader already
// agrees on.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { settings } = (body ?? {}) as { settings?: unknown };
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return NextResponse.json({ error: 'invalid_settings' }, { status: 400 });
  }

  // Only a club officer who may change settings, and (except for /setup)
  // only from a server the club has connected. See discord-manager.ts.
  const manager = managerInput(body);
  if (!manager) return NextResponse.json({ error: 'invalid_caller' }, { status: 400 });
  const managerCheck = await checkDiscordManager(createServiceRoleClient(), { ...manager });
  if (!managerCheck.ok) {
    return managerCheck.refusal === 'unavailable'
      ? NextResponse.json({ error: 'caller_unavailable' }, { status: 503 })
      : NextResponse.json({ error: managerCheck.refusal }, { status: 403 });
  }

  const entries = Object.entries(settings as Record<string, unknown>);
  if (entries.length === 0) {
    return NextResponse.json({ error: 'no_settings' }, { status: 400 });
  }

  const upserts: { key: string; value: string }[] = [];
  const deletes: string[] = [];

  // VALIDATED IN FULL BEFORE ANYTHING IS WRITTEN. A loop that wrote as it went
  // would leave a rejected payload half-applied, and "the announcement channel
  // moved but the match channel did not" is a state nobody asked for and the
  // error message would not describe.
  for (const [key, value] of entries) {
    const check = WRITABLE[key];
    if (!check) {
      return NextResponse.json({ error: 'unknown_setting', detail: key }, { status: 400 });
    }
    if (value === null) {
      deletes.push(key);
      continue;
    }
    if (typeof value !== 'string') {
      return NextResponse.json({ error: 'invalid_value', detail: key }, { status: 400 });
    }
    const trimmed = value.trim();
    const problem = check(trimmed);
    if (problem) {
      return NextResponse.json({ error: 'invalid_value', detail: `${key}: ${problem}` }, { status: 400 });
    }
    upserts.push({ key, value: trimmed });
  }

  const supabase = createServiceRoleClient();

  if (upserts.length > 0) {
    const { error } = await supabase.from('discord_settings').upsert(upserts, { onConflict: 'key' });
    if (error) {
      console.error('[discord] settings write failed:', error.message);
      return NextResponse.json({ error: 'write_failed', detail: error.message }, { status: 503 });
    }
  }

  if (deletes.length > 0) {
    const { error } = await supabase.from('discord_settings').delete().in('key', deletes);
    if (error) {
      console.error('[discord] settings delete failed:', error.message);
      return NextResponse.json({ error: 'write_failed', detail: error.message }, { status: 503 });
    }
  }

  return NextResponse.json({ ok: true, written: upserts.length, cleared: deletes.length });
}
