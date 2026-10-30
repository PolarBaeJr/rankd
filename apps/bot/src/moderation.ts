// /softban: remove somebody from the server and delete what they posted, then
// let them back in. A ban that deletes their recent messages, followed at once
// by an unban, so the invite still works for them.
//
// THIS IS A DISCORD ACTION, NOT A CLUB ONE. It never touches the app: the
// club's own ban (players.status, 00140 onward) is console-only and is a
// different thing. A soft-banned member keeps their account, their link and
// their roles in the app; they lose their Discord roles because leaving the
// server drops them, and the nightly sync gives them back if they rejoin.
//
// THE AUTHORITY IS DISCORD'S OWN BAN PERMISSION, on /setup's argument for
// MANAGE_GUILD: whoever holds Ban Members can already do this by hand. Two
// checks make the bot no stronger than its caller:
//
//  - the caller's permissions, as Discord sent them on the interaction, must
//    include Ban Members (or Administrator). default_member_permissions only
//    sets the default; a server admin can open the command to anyone.
//  - the caller must outrank the target, as Discord would require of a human.
//    Without it, a moderator could soft-ban somebody above them by borrowing
//    the bot's position.
//
// No DM to the person: the bot sends no DMs.

import type { DiscordApi } from './discord-api.js';
import type { DiscordRole } from './setup.js';

const BAN_MEMBERS = 1n << 2n;
const ADMINISTRATOR = 1n << 3n;

/** The delete window choices, in seconds. Discord's maximum is seven days. */
export const SOFTBAN_WINDOWS = [
  { name: 'Last hour', value: '3600' },
  { name: 'Last day', value: '86400' },
  { name: 'Last 7 days', value: '604800' },
] as const;

const DEFAULT_WINDOW_SECONDS = 86400;
const UNBAN_ATTEMPTS = 3;

export function canBan(permissions: string | null | undefined): boolean {
  if (!permissions) return false;
  try {
    const mask = BigInt(permissions);
    return (mask & (BAN_MEMBERS | ADMINISTRATOR)) !== 0n;
  } catch {
    return false;
  }
}

/** The highest position among `roleIds`; 0 (@everyone) when they hold none. */
export function topPosition(roleIds: readonly string[], roles: readonly DiscordRole[]): number {
  const held = new Set(roleIds);
  return roles.filter((r) => held.has(r.id)).reduce((top, r) => Math.max(top, r.position), 0);
}

export function windowSeconds(value: string | undefined): number {
  const allowed = SOFTBAN_WINDOWS.map((w) => Number(w.value));
  const n = Number(value);
  return allowed.includes(n) ? n : DEFAULT_WINDOW_SECONDS;
}

export function describeWindow(seconds: number): string {
  return SOFTBAN_WINDOWS.find((w) => Number(w.value) === seconds)?.name.toLowerCase() ?? `${seconds}s`;
}

export interface SoftbanInput {
  guildId: string;
  callerId: string;
  callerRoles: readonly string[];
  callerPermissions: string | null | undefined;
  targetId: string;
  deleteSeconds: number;
  reason: string;
}

export type SoftbanOutcome =
  | { ok: true; unbanned: true }
  // The ban landed and the unban did not: they are BANNED until somebody
  // lifts it by hand. The one outcome that must be shouted.
  | { ok: true; unbanned: false }
  | { ok: false; message: string };

export async function softban(
  api: Pick<
    DiscordApi,
    | 'getBotUserId'
    | 'getGuildOwnerId'
    | 'getMemberRoles'
    | 'listGuildRoles'
    | 'getOwnRolePosition'
    | 'banMember'
    | 'unbanMember'
  >,
  input: SoftbanInput,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<SoftbanOutcome> {
  if (!canBan(input.callerPermissions)) {
    return { ok: false, message: 'You need the Ban Members permission in this server to soft-ban.' };
  }
  if (input.targetId === input.callerId) {
    return { ok: false, message: "You can't soft-ban yourself." };
  }
  const [botId, ownerId] = await Promise.all([api.getBotUserId(), api.getGuildOwnerId(input.guildId)]);
  if (input.targetId === botId) return { ok: false, message: "I can't soft-ban myself." };
  if (input.targetId === ownerId) {
    return { ok: false, message: "The server owner can't be soft-banned." };
  }

  // Null means they are not in the server. A ban still deletes their messages
  // then, and there is no rank to compare.
  const targetRoles = await api.getMemberRoles(input.guildId, input.targetId);
  if (targetRoles) {
    const roles = await api.listGuildRoles(input.guildId);
    const targetTop = topPosition(targetRoles, roles);
    if (input.callerId !== ownerId && topPosition(input.callerRoles, roles) <= targetTop) {
      return {
        ok: false,
        message: 'Their highest role is the same as or above yours, so you cannot soft-ban them.',
      };
    }
    if ((await api.getOwnRolePosition(input.guildId)) <= targetTop) {
      return {
        ok: false,
        message: "Their highest role is at or above mine, so Discord won't let me ban them.",
      };
    }
  }

  const result = await banThenUnban(api, {
    guildId: input.guildId,
    targetId: input.targetId,
    deleteSeconds: input.deleteSeconds,
    reason: `Soft ban by ${input.callerId}: ${input.reason}`,
    liftReason: `Soft ban: lifting it (${input.callerId})`,
    sleep,
  });
  if (result === 'ok' || result === 'not_lifted') return { ok: true, unbanned: result === 'ok' };
  return {
    ok: false,
    message:
      result === 'forbidden'
        ? "Discord refused the ban. I need the Ban Members permission, and my role above theirs."
        : 'The ban did not go through, so nothing changed. Try again in a moment.',
  };
}

type SoftBanListener = (guildId: string) => void;
const softBanListeners: SoftBanListener[] = [];

/**
 * Called after every soft ban whose ban landed, from /softban and auto mod
 * alike (index.ts counts them on the trap channel warnings).
 */
export function onSoftBan(listener: SoftBanListener): void {
  softBanListeners.push(listener);
}

/**
 * The soft ban itself, with no checks on who asked: a ban that deletes the
 * last `deleteSeconds` of messages, then the unban, retried. /softban runs its
 * caller checks first; scam-guard.ts runs its own.
 *
 * 'not_lifted' means the ban went through and every unban failed, so they are
 * still banned and somebody has to lift it by hand.
 */
export async function banThenUnban(
  api: Pick<DiscordApi, 'banMember' | 'unbanMember'>,
  input: {
    guildId: string;
    targetId: string;
    deleteSeconds: number;
    reason: string;
    liftReason: string;
    sleep: (ms: number) => Promise<void>;
  }
): Promise<'ok' | 'not_lifted' | 'forbidden' | 'failed'> {
  const banned = await api.banMember(input.guildId, input.targetId, input.deleteSeconds, input.reason);
  if (banned !== 'ok') return banned === 'forbidden' ? 'forbidden' : 'failed';
  for (const listener of softBanListeners) {
    try {
      listener(input.guildId);
    } catch (error) {
      console.error('[bot] soft ban listener failed:', error);
    }
  }
  for (let attempt = 1; attempt <= UNBAN_ATTEMPTS; attempt += 1) {
    const result = await api.unbanMember(input.guildId, input.targetId, input.liftReason);
    // not_found means there is no ban to lift, which is the state we wanted.
    if (result === 'ok' || result === 'not_found') return 'ok';
    if (attempt < UNBAN_ATTEMPTS) await input.sleep(1000 * attempt);
  }
  return 'not_lifted';
}
