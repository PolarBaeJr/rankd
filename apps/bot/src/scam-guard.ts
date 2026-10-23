// The scam guard: soft-ban an account that sprays the same post across the
// server's channels, the way a hacked account does ("gifting free stuff, DM
// me" with a few crypto screenshots, in every channel at once).
//
// ---- WHAT TRIPS IT ----
//
// THE SPRAY, NOT THE WORDS. A member saying "giving away free shuttles" with
// two photos is a real member, and a soft ban kicks them and deletes what they
// posted. What a person almost never does is post the same thing in several
// channels within a minute or two. So:
//
//   - the same post in SPRAY_CHANNELS (3) channels within the window: soft ban.
//   - the same post in 2 channels, when it also reads like a giveaway and
//     carries a picture or a link: soft ban.
//   - one post that reads like a giveaway and carries pictures, a link or
//     crypto words: a "suspected" entry in the server log, and nothing else.
//     An officer decides.
//
// "The same post" is its fingerprint: the text folded to lowercase letters and
// digits, plus the size and type of each attachment. Image-only spam has no
// text, so the attachments carry it.
//
// ---- WHO IT NEVER TOUCHES ----
//
// The server owner, bots and webhooks, and anybody holding a role with Manage
// Messages, Kick, Ban or Administrator. And anybody whose top role is at or
// above the bot's, because Discord would refuse the ban anyway.
//
// ---- WHAT IT DOES ----
//
// A soft ban (moderation.ts): ban, deleting their last hour of messages, then
// unban at once so the invite still works. One hour, not /softban's default
// day, because the account is usually a real member's and their own day of
// messages should survive. The reason names the rule, so Discord's audit log
// (and the server log's moderation scope) shows why. Each account is acted on
// at most once per COOLDOWN, or a ten-channel spray would be ten bans.
//
// Two replicas each hold a gateway socket and both see the spray. Both may
// ban; a ban and an unban are idempotent, and the log entry is deduped by
// nonce like every other server log entry.
//
// Club servers only. The bot runs anywhere, and somebody else's server is
// theirs to moderate.

import type { DiscordApi } from './discord-api.js';
import type { DiscordRole } from './setup.js';
import { banThenUnban, topPosition } from './moderation.js';
import type { ServerLogEntry } from './server-log.js';

export const SPRAY_WINDOW_MS = 2 * 60_000;
export const SPRAY_CHANNELS = 3;
const COOLDOWN_MS = 10 * 60_000;
const DELETE_SECONDS = 3600;
const ROLES_TTL_MS = 5 * 60_000;
// Below this many folded characters, text alone is not a fingerprint ("hi").
const MIN_TEXT = 12;
const MAX_TRACKED_ACCOUNTS = 5000;

const KICK_MEMBERS = 1n << 1n;
const BAN_MEMBERS = 1n << 2n;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_MESSAGES = 1n << 13n;
const MODERATOR = KICK_MEMBERS | BAN_MEMBERS | ADMINISTRATOR | MANAGE_MESSAGES;

const COLOR_ACTION = 0xe74c3c;
const COLOR_SUSPECT = 0xf1c40f;

const GIVEAWAY = /\b(giv(e|es|ing)\s*away|giveaways?|gift(s|ing|ed)?|free(bies?)?|first come)\b/i;
const CRYPTO =
  /\b(crypto|bitcoin|btc|eth(ereum)?|usdt|nfts?|airdrops?|wallet|binance|coinbase|metamask|invest(ing|ment)?|profits?|trading)\b/i;
const LINK = /https?:\/\/|discord\.gg\/|\bwww\./i;

export interface ScamMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  memberRoles: string[];
  text: string;
  attachments: { size: number; type: string }[];
}

/** A guild MESSAGE_CREATE in the shape the guard reads, or null when it is not one. */
export function readMessage(raw: unknown): ScamMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const author = d.author as { id?: unknown; bot?: unknown } | undefined;
  if (typeof author?.id !== 'string' || author.bot || d.webhook_id) return null;
  if (typeof d.id !== 'string' || typeof d.channel_id !== 'string' || typeof d.guild_id !== 'string') {
    return null;
  }
  const member = d.member as { roles?: unknown } | undefined;
  const attachments = Array.isArray(d.attachments) ? (d.attachments as Record<string, unknown>[]) : [];
  return {
    id: d.id,
    guildId: d.guild_id,
    channelId: d.channel_id,
    authorId: author.id,
    memberRoles: Array.isArray(member?.roles)
      ? member.roles.filter((r): r is string => typeof r === 'string')
      : [],
    text: typeof d.content === 'string' ? d.content : '',
    attachments: attachments.map((a) => ({
      size: typeof a.size === 'number' ? a.size : 0,
      type: typeof a.content_type === 'string' ? a.content_type : '',
    })),
  };
}

/** The post with everything but its substance folded away, or null when there is too little to go on. */
export function fingerprint(message: Pick<ScamMessage, 'text' | 'attachments'>): string | null {
  const text = message.text
    .toLowerCase()
    .replace(/<[@#&!:a-z0-9_]+>/g, '') // mentions and custom emoji
    .replace(/[^a-z0-9]+/g, '');
  const files = message.attachments.map((a) => `${a.size}:${a.type}`).sort();
  if (files.length === 0 && text.length < MIN_TEXT) return null;
  return `${text}|${files.join(',')}`;
}

export function looksLikeGiveaway(text: string): boolean {
  return GIVEAWAY.test(text);
}

/** One message on its own: worth a "suspected" log entry, never a ban. */
export function isSuspect(message: Pick<ScamMessage, 'text' | 'attachments'>): boolean {
  if (!looksLikeGiveaway(message.text)) return false;
  return message.attachments.length >= 2 || LINK.test(message.text) || CRYPTO.test(message.text);
}

export function isModerator(roleIds: readonly string[], roles: readonly DiscordRole[]): boolean {
  const held = new Set(roleIds);
  return roles.some((role) => {
    if (!held.has(role.id) || !role.permissions) return false;
    try {
      return (BigInt(role.permissions) & MODERATOR) !== 0n;
    } catch {
      return false;
    }
  });
}

export type Verdict = { kind: 'none' } | { kind: 'suspect' } | { kind: 'spray'; channels: number };

interface Seen {
  fingerprint: string;
  channelId: string;
  at: number;
}

/**
 * The spray tracker: per account, the fingerprints of its last few minutes of
 * posts. Pure apart from the clock it is handed.
 */
export class SprayTracker {
  private readonly accounts = new Map<string, Seen[]>();

  verdict(message: ScamMessage, at: number): Verdict {
    const key = `${message.guildId}:${message.authorId}`;
    const print = fingerprint(message);
    const recent = (this.accounts.get(key) ?? []).filter((seen) => at - seen.at < SPRAY_WINDOW_MS);
    if (print) recent.push({ fingerprint: print, channelId: message.channelId, at });
    // Re-inserted so the Map's first key is the account heard from longest ago.
    this.accounts.delete(key);
    if (recent.length) this.accounts.set(key, recent.slice(-20));
    while (this.accounts.size > MAX_TRACKED_ACCOUNTS) {
      const oldest = this.accounts.keys().next().value;
      if (oldest === undefined) break;
      this.accounts.delete(oldest);
    }

    if (print) {
      const channels = new Set(
        recent.filter((seen) => seen.fingerprint === print).map((seen) => seen.channelId)
      ).size;
      if (channels >= SPRAY_CHANNELS) return { kind: 'spray', channels };
      const carriesBait = message.attachments.length > 0 || LINK.test(message.text);
      if (channels >= 2 && carriesBait && looksLikeGiveaway(message.text)) return { kind: 'spray', channels };
    }
    return isSuspect(message) ? { kind: 'suspect' } : { kind: 'none' };
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function quoted(text: string): string {
  if (!text.trim()) return '_no text_';
  return clip(text, 800)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export interface ScamGuardOptions {
  api: Pick<
    DiscordApi,
    'getBotUserId' | 'getGuildOwnerId' | 'listGuildRoles' | 'getOwnRolePosition' | 'banMember' | 'unbanMember'
  >;
  /** The club's connected servers. Anything else, or no answer, means hands off. */
  clubServers: () => Promise<ReadonlySet<string>>;
  /** Posts an entry to the server log of that guild. */
  report: (guildId: string, entry: ServerLogEntry) => void;
  log?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface ScamGuard {
  onMessage(data: unknown): void;
  /** For tests: resolves once every action started so far has finished. */
  drain(): Promise<void>;
}

export function createScamGuard(options: ScamGuardOptions): ScamGuard {
  const {
    api,
    clubServers,
    report,
    log = (line: string) => console.error(line),
    now = () => new Date(),
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const tracker = new SprayTracker();
  // Per verdict and account, when it last fired, so a spray is one action and
  // not one per channel.
  const lastActed = new Map<string, number>();
  const roleCache = new Map<string, { roles: DiscordRole[]; at: number }>();
  const pending = new Set<Promise<void>>();

  async function guildRoles(guildId: string): Promise<DiscordRole[]> {
    const cached = roleCache.get(guildId);
    if (cached && Date.now() - cached.at < ROLES_TTL_MS) return cached.roles;
    const roles = await api.listGuildRoles(guildId);
    roleCache.set(guildId, { roles, at: Date.now() });
    return roles;
  }

  async function handle(message: ScamMessage, verdict: Exclude<Verdict, { kind: 'none' }>, at: Date) {
    const servers = await clubServers().catch(() => null);
    if (!servers?.has(message.guildId)) return;
    const [roles, ownerId, botId] = await Promise.all([
      guildRoles(message.guildId),
      api.getGuildOwnerId(message.guildId),
      api.getBotUserId(),
    ]);
    if (message.authorId === ownerId || message.authorId === botId) return;
    if (isModerator(message.memberRoles, roles)) return;

    const timestamp = at.toISOString();
    const files = message.attachments.length
      ? `\n${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'}`
      : '';
    const body = `${quoted(message.text)}${files}`;

    if (verdict.kind === 'suspect') {
      report(message.guildId, {
        key: `scam-suspect:${message.id}`,
        embed: {
          title: 'Possible scam post (no action taken)',
          description: `<@${message.authorId}> in <#${message.channelId}>\n\n${body}`,
          color: COLOR_SUSPECT,
          footer: {
            text: `Reads like a giveaway. /softban them if it is a scam. Message ${message.id}`,
          },
          timestamp,
        },
      });
      return;
    }

    const where = `the same post in ${verdict.channels} channels within ${SPRAY_WINDOW_MS / 60_000} minutes`;
    let outcome: string;
    if ((await api.getOwnRolePosition(message.guildId)) <= topPosition(message.memberRoles, roles)) {
      outcome = 'Not soft-banned: their highest role is at or above mine. Remove them by hand.';
    } else {
      const result = await banThenUnban(api, {
        guildId: message.guildId,
        targetId: message.authorId,
        deleteSeconds: DELETE_SECONDS,
        reason: `Auto soft-ban (scam guard): ${where}`,
        liftReason: 'Auto soft-ban (scam guard): lifting it',
        sleep,
      });
      outcome =
        result === 'ok'
          ? 'Soft-banned: their last hour of messages is deleted and they can rejoin. If the account was hacked, tell them to change their password.'
          : result === 'not_lifted'
            ? 'They are still BANNED: the unban failed. Lift it in Server Settings, Bans.'
            : result === 'forbidden'
              ? 'Not soft-banned: Discord refused. I need the Ban Members permission.'
              : 'Not soft-banned: the ban did not go through.';
      if (result !== 'ok') log(`[scam-guard] ${message.guildId}/${message.authorId}: ${result}`);
    }
    report(message.guildId, {
      key: `scam-action:${message.guildId}:${message.authorId}:${message.id}`,
      embed: {
        title: 'Scam spray caught',
        description: `<@${message.authorId}> posted ${where}.\n\n${body}`,
        color: COLOR_ACTION,
        fields: [{ name: 'Outcome', value: outcome }],
        footer: { text: `User ${message.authorId}` },
        timestamp,
      },
    });
  }

  return {
    onMessage(data) {
      const message = readMessage(data);
      if (!message) return;
      const at = now();
      const verdict = tracker.verdict(message, at.getTime());
      if (verdict.kind === 'none') return;
      // Kept apart, so a suspect entry never holds back a later spray.
      const key = `${verdict.kind}:${message.guildId}:${message.authorId}`;
      const last = lastActed.get(key);
      if (last !== undefined && at.getTime() - last < COOLDOWN_MS) return;
      lastActed.set(key, at.getTime());
      if (lastActed.size > MAX_TRACKED_ACCOUNTS * 2) lastActed.clear();

      const job = handle(message, verdict, at)
        .catch((error) => log(`[scam-guard] ${message.guildId}/${message.authorId} failed: ${String(error)}`))
        .finally(() => pending.delete(job));
      pending.add(job);
    },
    drain: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
