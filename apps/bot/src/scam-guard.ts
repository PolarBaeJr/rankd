// Auto mod (the "scam guard" in the code and the database): stops an account
// that sprays the same post across the server's channels, the way a hacked
// account does ("gifting free stuff, DM me" with a few crypto screenshots, in
// every channel at once), plus whatever else a server switched on.
//
// ---- THE RULES (each server's own, 00303, each switched on or off) ----
//
// TRAP CHANNELS. Channels nobody should post in. Any post there is caught and
// deleted. A bot spraying every channel walks into one on its first message.
//
// THE SERVER'S WORDS. A post with one in it is deleted and logged, or also
// punished, or only flagged, as the server chose. Matched as whole words,
// ignoring case, so "free" does not catch "freedom".
//
// THE SPRAY. A member saying "giving away free shuttles" with two photos is a
// real member. What a person almost never does is post the same thing in
// several channels within a minute or two. So, with the server's numbers
// (defaults 3 channels in 2 minutes):
//
//   - the same post in that many channels within the window: caught.
//   - the same post in one channel fewer (never under 2), when it also reads
//     like a giveaway and carries a picture or a link: caught.
//
// "The same post" is its fingerprint: the text folded to lowercase letters and
// digits, plus the size and type of each attachment. Image-only spam has no
// text, so the attachments carry it.
//
// SUSPECTS. One post that reads like a giveaway and carries pictures, a link or
// crypto words: a "possible scam" entry in the server log, and nothing else.
// An officer decides.
//
// ---- WHO IT NEVER TOUCHES ----
//
// The server owner, bots and webhooks, and anybody holding a role with Manage
// Messages, Kick, Ban or Administrator. And anybody whose top role is at or
// above the bot's, because Discord would refuse anyway.
//
// ---- WHAT A CATCH GETS (the server's automod_action) ----
//
//   timeout_then_softban  (the default) the first catch gets a timeout and the
//                         copies deleted. The same account caught again within
//                         STRIKE_MS gets a soft ban. The account is usually a
//                         real member's, so the first answer stops it without
//                         kicking them.
//   timeout               only ever the timeout.
//   softban               a soft ban at once (moderation.ts): ban, deleting
//                         their last hour of messages, then unban so the
//                         invite still works. One hour, not /softban's default
//                         day, so the member's own day of messages survives.
//   flag                  a log entry and nothing else.
//
// Not a timeout and then a soft ban together: the ban removes the member, and
// the timeout with them, so the pair would be a soft ban with extra steps.
//
// The strikes live in memory, so a restart forgets them and the next catch is
// a first one again. That errs towards the lighter answer, which is the safe
// side. The reason on every action names the rule, so Discord's audit log
// shows why. Each account is acted on at most once per window, or a
// ten-channel spray would be ten actions.
//
// Two replicas each hold a gateway socket and both see the post. Both may
// act; a timeout, a ban, an unban and a delete are idempotent, and the log
// entry is deduped by nonce like every other server log entry. Their strike
// memories are separate, so a second catch can meet a replica that did not
// see the first: again the lighter answer.
//
// Only where the server switched it on (/config automod, 00302). The bot runs
// anywhere, and acting on people in somebody else's server needs their yes.

import type { DiscordApi } from './discord-api.js';
import type { DiscordRole } from './setup.js';
import { banThenUnban, topPosition } from './moderation.js';
import type { ServerLogEntry } from './server-log.js';
import type { AutomodAction, AutomodWordsAction } from './api.js';

/** What a server gets before it changes anything (00303's column defaults). */
export const DEFAULT_RULES: GuardRules = {
  action: 'timeout_then_softban',
  timeoutMinutes: 60,
  spray: true,
  channels: 3,
  windowMinutes: 2,
  flagSuspects: true,
  words: [],
  wordsAction: 'delete',
  trapChannelIds: [],
  trapAction: 'softban',
};
// The longest window a server may choose. Every account's recent posts are
// held this long, whatever its own server picked.
const MAX_WINDOW_MS = 10 * 60_000;
// How long a timeout counts against an account under timeout_then_softban.
export const STRIKE_MS = 24 * 3_600_000;
const DELETE_SECONDS = 3600;
const ROLES_TTL_MS = 5 * 60_000;
// Fewer letters than this, with nothing attached, is too little to call two
// posts the same ("hi", "lol").
const MIN_TEXT = 12;
const MAX_TRACKED_ACCOUNTS = 5000;

export interface GuardRules {
  action: AutomodAction;
  timeoutMinutes: number;
  spray: boolean;
  channels: number;
  windowMinutes: number;
  flagSuspects: boolean;
  words: readonly string[];
  wordsAction: AutomodWordsAction;
  trapChannelIds: readonly string[];
  /** What a post in a trap channel gets, apart from `action`. */
  trapAction: AutomodAction;
}

const KICK_MEMBERS = 1n << 1n;
const BAN_MEMBERS = 1n << 2n;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_MESSAGES = 1n << 13n;
const MODERATOR = KICK_MEMBERS | BAN_MEMBERS | ADMINISTRATOR | MANAGE_MESSAGES;

const COLOR_ACTION = 0xe74c3c;
const COLOR_SUSPECT = 0xf1c40f;

/** The giveaway words, as /config automod lists them. */
export const GIVEAWAY_WORDS = ['give away', 'giveaway', 'gift', 'free', 'freebie', 'first come'];
/** The crypto words, as /config automod lists them. */
export const CRYPTO_WORDS = [
  'crypto', 'bitcoin', 'btc', 'eth', 'usdt', 'nft', 'airdrop', 'wallet',
  'binance', 'coinbase', 'metamask', 'invest', 'profit', 'trading',
];

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first of the server's words in the text, as a whole word and ignoring case, or null. */
export function matchWord(text: string, words: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const word of words) {
    if (!word) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u');
    if (pattern.test(lower)) return word;
  }
  return null;
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

export type Verdict =
  | { kind: 'none' }
  | { kind: 'suspect' }
  // `copies` is every copy of the post in the window, for deleting.
  | { kind: 'spray'; channels: number; copies: { channelId: string; messageId: string }[] };

interface Seen {
  fingerprint: string;
  channelId: string;
  messageId: string;
  at: number;
}

/**
 * The spray tracker: per account, the fingerprints of its last few minutes of
 * posts. Pure apart from the clock it is handed.
 *
 * Recording and judging are separate because the rules are the server's, and
 * reading them is asynchronous: a post is recorded the moment it arrives, so
 * the order is right, and judged once its server's rules are in hand.
 */
export class SprayTracker {
  private readonly accounts = new Map<string, Seen[]>();

  record(message: ScamMessage, at: number): void {
    const key = `${message.guildId}:${message.authorId}`;
    const print = fingerprint(message);
    const recent = (this.accounts.get(key) ?? []).filter((seen) => at - seen.at < MAX_WINDOW_MS);
    if (print) recent.push({ fingerprint: print, channelId: message.channelId, messageId: message.id, at });
    // Re-inserted so the Map's first key is the account heard from longest ago.
    this.accounts.delete(key);
    if (recent.length) this.accounts.set(key, recent.slice(-30));
    while (this.accounts.size > MAX_TRACKED_ACCOUNTS) {
      const oldest = this.accounts.keys().next().value;
      if (oldest === undefined) break;
      this.accounts.delete(oldest);
    }
  }

  /** The verdict on a post already recorded at `at`, under one server's rules. */
  judge(message: ScamMessage, at: number, rules: Pick<GuardRules, 'channels' | 'windowMinutes'>): Verdict {
    const print = fingerprint(message);
    if (print) {
      const windowMs = Math.min(rules.windowMinutes * 60_000, MAX_WINDOW_MS);
      const copies = (this.accounts.get(`${message.guildId}:${message.authorId}`) ?? []).filter(
        (seen) => seen.fingerprint === print && seen.at <= at && at - seen.at < windowMs
      );
      const channels = new Set(copies.map((seen) => seen.channelId)).size;
      const found = copies.map(({ channelId, messageId }) => ({ channelId, messageId }));
      if (channels >= rules.channels) return { kind: 'spray', channels, copies: found };
      const carriesBait = message.attachments.length > 0 || LINK.test(message.text);
      if (channels >= Math.max(2, rules.channels - 1) && carriesBait && looksLikeGiveaway(message.text)) {
        return { kind: 'spray', channels, copies: found };
      }
    }
    return isSuspect(message) ? { kind: 'suspect' } : { kind: 'none' };
  }

  /** Record and judge in one step. */
  verdict(message: ScamMessage, at: number, rules: GuardRules = DEFAULT_RULES): Verdict {
    this.record(message, at);
    return this.judge(message, at, rules);
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
    | 'getBotUserId'
    | 'getGuildOwnerId'
    | 'listGuildRoles'
    | 'getOwnRolePosition'
    | 'banMember'
    | 'unbanMember'
    | 'timeoutMember'
    | 'deleteMessage'
  >;
  /** This server's rules, or null when it has not switched the guard on. No answer means hands off. */
  rulesFor: (guildId: string) => Promise<GuardRules | null>;
  /** Posts an entry to the server log of that guild. */
  report: (guildId: string, entry: ServerLogEntry) => void;
  /** An account was dealt with for posting in a trap channel: the channel's warning counts it. */
  onTrapCaught?: (guildId: string, channelId: string, action: AutomodAction) => void;
  log?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface ScamGuard {
  onMessage(data: unknown): void;
  /** For tests: resolves once every action started so far has finished. */
  drain(): Promise<void>;
}

function minutesText(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function createScamGuard(options: ScamGuardOptions): ScamGuard {
  const {
    api,
    rulesFor,
    report,
    onTrapCaught,
    log = (line: string) => console.error(line),
    now = () => new Date(),
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const tracker = new SprayTracker();
  // Per verdict and account, when it last fired, so a spray is one action and
  // not one per channel.
  const lastActed = new Map<string, number>();
  // Per account, when it was last timed out by the guard, for the second strike.
  const strikes = new Map<string, number>();
  // Per account, until when a copy arriving after its timeout is deleted on
  // sight: the copies already in flight when the timeout landed.
  const sweeping = new Map<string, number>();
  const roleCache = new Map<string, { roles: DiscordRole[]; at: number }>();
  const pending = new Set<Promise<void>>();

  async function guildRoles(guildId: string): Promise<DiscordRole[]> {
    const cached = roleCache.get(guildId);
    if (cached && Date.now() - cached.at < ROLES_TTL_MS) return cached.roles;
    const roles = await api.listGuildRoles(guildId);
    roleCache.set(guildId, { roles, at: Date.now() });
    return roles;
  }

  async function deleteCopies(copies: { channelId: string; messageId: string }[]): Promise<number> {
    let deleted = 0;
    for (const copy of copies) if (await api.deleteMessage(copy.channelId, copy.messageId)) deleted += 1;
    return deleted;
  }

  async function timeOut(
    message: ScamMessage,
    rules: GuardRules,
    copies: { channelId: string; messageId: string }[],
    why: string,
    at: Date,
    isSpray: boolean
  ): Promise<string> {
    const until = new Date(at.getTime() + rules.timeoutMinutes * 60_000);
    const result = await api.timeoutMember(message.guildId, message.authorId, until, `Auto mod: ${why}`);
    if (result !== 'ok') {
      log(`[scam-guard] ${message.guildId}/${message.authorId}: timeout ${result}`);
      return result === 'forbidden'
        ? 'Not timed out: Discord refused. I need the Moderate Members permission.'
        : 'Not timed out: the timeout did not go through.';
    }
    const account = `${message.guildId}:${message.authorId}`;
    strikes.set(account, at.getTime());
    if (strikes.size > MAX_TRACKED_ACCOUNTS) strikes.clear();
    let all = copies;
    if (isSpray) {
      sweeping.set(account, at.getTime() + Math.min(rules.windowMinutes * 60_000, MAX_WINDOW_MS));
      if (sweeping.size > MAX_TRACKED_ACCOUNTS) sweeping.clear();
      // Read again now the timeout has landed: copies that arrived while it
      // was on its way were recorded, but their own handling saw the cooldown.
      const landed = tracker.judge(message, now().getTime(), rules);
      if (landed.kind === 'spray') all = landed.copies;
    }
    const tidy = await tidyText(all);
    const next =
      rules.action === 'timeout_then_softban' ? ' If they are caught again within a day, they are soft-banned.' : '';
    return `Timed out for ${minutesText(rules.timeoutMinutes)}${tidy}.${next} If the account was hacked, tell them to change their password.`;
  }

  /** Deletes the copies, and says how that went as a clause starting " and". */
  async function tidyText(copies: { channelId: string; messageId: string }[]): Promise<string> {
    if (copies.length === 0) return '';
    const deleted = await deleteCopies(copies);
    const missed = copies.length - deleted;
    if (missed > 0) return ` and ${missed} of ${copies.length} posts could not be deleted (I need Manage Messages)`;
    return copies.length === 1 ? ' and the post is deleted' : ` and their ${deleted} copies are deleted`;
  }

  async function softBan(message: ScamMessage, why: string, repeat: boolean): Promise<string> {
    const result = await banThenUnban(api, {
      guildId: message.guildId,
      targetId: message.authorId,
      deleteSeconds: DELETE_SECONDS,
      reason: `Auto soft-ban (auto mod): ${why}${repeat ? ', again after a timeout' : ''}`,
      liftReason: 'Auto soft-ban (auto mod): lifting it',
      sleep,
    });
    if (result !== 'ok') log(`[scam-guard] ${message.guildId}/${message.authorId}: ${result}`);
    if (result === 'ok') strikes.delete(`${message.guildId}:${message.authorId}`);
    const because = repeat ? 'Caught again after a timeout, so ' : '';
    return result === 'ok'
      ? `${because}soft-banned: their last hour of messages is deleted and they can rejoin. If the account was hacked, tell them to change their password.`
      : result === 'not_lifted'
        ? 'They are still BANNED: the unban failed. Lift it in Server Settings, Bans.'
        : result === 'forbidden'
          ? 'Not soft-banned: Discord refused. I need the Ban Members permission.'
          : 'Not soft-banned: the ban did not go through.';
  }

  /** The server's answer to a catch, with the posts to delete. Returns the log's outcome line. */
  async function punish(
    message: ScamMessage,
    rules: GuardRules,
    roles: DiscordRole[],
    copies: { channelId: string; messageId: string }[],
    why: string,
    at: Date,
    isSpray: boolean
  ): Promise<string> {
    const account = `${message.guildId}:${message.authorId}`;
    if (rules.action === 'flag') {
      return 'No action taken: this server only flags. Use /softban if it is a scam.';
    }
    if ((await api.getOwnRolePosition(message.guildId)) <= topPosition(message.memberRoles, roles)) {
      return `No action taken: their highest role is at or above mine. Remove them by hand.`;
    }
    if (rules.action === 'softban') return softBan(message, why, false);
    if (rules.action === 'timeout_then_softban' && at.getTime() - (strikes.get(account) ?? -Infinity) < STRIKE_MS) {
      return softBan(message, why, true);
    }
    return timeOut(message, rules, copies, why, at, isSpray);
  }

  /** Whether this catch already fired for this account within the window. Checked and set with no await between. */
  function cooling(kind: string, account: string, rules: GuardRules, at: Date): boolean {
    const key = `${kind}:${account}`;
    const last = lastActed.get(key);
    if (last !== undefined && at.getTime() - last < Math.max(rules.windowMinutes * 60_000, 60_000)) return true;
    lastActed.set(key, at.getTime());
    if (lastActed.size > MAX_TRACKED_ACCOUNTS * 2) lastActed.clear();
    return false;
  }

  async function exempt(message: ScamMessage): Promise<DiscordRole[] | null> {
    const [roles, ownerId, botId] = await Promise.all([
      guildRoles(message.guildId),
      api.getGuildOwnerId(message.guildId),
      api.getBotUserId(),
    ]);
    if (message.authorId === ownerId || message.authorId === botId) return null;
    if (isModerator(message.memberRoles, roles)) return null;
    return roles;
  }

  async function handle(message: ScamMessage, at: Date) {
    const rules = await rulesFor(message.guildId).catch(() => null);
    if (!rules) return;
    const account = `${message.guildId}:${message.authorId}`;
    const timestamp = at.toISOString();
    const files = message.attachments.length
      ? `\n${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'}`
      : '';
    const body = `${quoted(message.text)}${files}`;
    const thisPost = [{ channelId: message.channelId, messageId: message.id }];
    const caught = (title: string, description: string, outcome: string) =>
      report(message.guildId, {
        key: `scam-action:${message.guildId}:${message.authorId}:${message.id}`,
        embed: {
          title,
          description: `${description}\n\n${body}`,
          color: COLOR_ACTION,
          fields: [{ name: 'Outcome', value: outcome }],
          footer: { text: `User ${message.authorId}` },
          timestamp,
        },
      });

    // A TRAP CHANNEL: anything posted there.
    if (rules.trapChannelIds.includes(message.channelId)) {
      const roles = await exempt(message);
      if (!roles) return;
      // Every post there goes, even one inside the cooldown.
      if (cooling('trap', account, rules, at)) {
        await api.deleteMessage(message.channelId, message.id);
        return;
      }
      const why = 'posted in a trap channel';
      const trapRules = { ...rules, action: rules.trapAction };
      const outcome = await punish(message, trapRules, roles, thisPost, why, at, false);
      caught('Auto mod: post in a trap channel', `<@${message.authorId}> posted in <#${message.channelId}>.`, outcome);
      if (trapRules.action === 'flag' || /^(Caught again|soft-banned|Timed out)/.test(outcome)) {
        onTrapCaught?.(message.guildId, message.channelId, trapRules.action);
      }
      return;
    }

    // ONE OF THE SERVER'S WORDS.
    const word = matchWord(message.text, rules.words);
    if (word) {
      const roles = await exempt(message);
      if (!roles) return;
      const where = `<@${message.authorId}> in <#${message.channelId}> used **${word}**.`;
      if (rules.wordsAction === 'flag') {
        caught('Auto mod: blocked word', where, 'No action taken: this server only flags its words.');
      } else if (rules.wordsAction === 'delete' || cooling('word', account, rules, at)) {
        const deleted = await api.deleteMessage(message.channelId, message.id);
        caught('Auto mod: blocked word', where, deleted ? 'Deleted.' : 'Not deleted: I need Manage Messages.');
      } else {
        await api.deleteMessage(message.channelId, message.id);
        caught('Auto mod: blocked word', where, await punish(message, rules, roles, [], `used a blocked word`, at, false));
      }
      return;
    }

    const verdict = tracker.judge(message, at.getTime(), {
      channels: rules.spray ? rules.channels : Number.POSITIVE_INFINITY,
      windowMinutes: rules.windowMinutes,
    });
    if (verdict.kind === 'none') return;
    if (verdict.kind === 'suspect' && !rules.flagSuspects) return;

    // Kept apart, so a suspect entry never holds back a later spray.
    if (cooling(verdict.kind, account, rules, at)) {
      // A copy that was already on its way when the timeout landed.
      if (verdict.kind === 'spray' && (sweeping.get(account) ?? 0) > at.getTime()) {
        await api.deleteMessage(message.channelId, message.id);
      }
      return;
    }
    const roles = await exempt(message);
    if (!roles) return;

    if (verdict.kind === 'suspect') {
      report(message.guildId, {
        key: `scam-suspect:${message.id}`,
        embed: {
          title: 'Auto mod: possible scam post (no action taken)',
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

    const why = `the same post in ${verdict.channels} channels within ${minutesText(rules.windowMinutes)}`;
    caught('Auto mod caught a spray', `<@${message.authorId}> posted ${why}.`,
      await punish(message, rules, roles, verdict.copies, why, at, true));
  }

  return {
    onMessage(data) {
      const message = readMessage(data);
      if (!message) return;
      const at = now();
      // Recorded now, in arrival order; judged once the server's rules are in.
      tracker.record(message, at.getTime());
      const job = handle(message, at)
        .catch((error) => log(`[scam-guard] ${message.guildId}/${message.authorId} failed: ${String(error)}`))
        .finally(() => pending.delete(job));
      pending.add(job);
    },
    drain: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
