// The server log: one embed in a Discord channel for what happens in the
// server itself. Moderation and settings changes come from Discord's own audit
// log; joins, leaves, deleted and edited messages come from the gateway.
//
// This is a different channel from audit.ts's. That one records the work the
// BOT does; this one records what PEOPLE do in the server. Both follow the same
// first rule: a log entry never fails anything, and every failure here is
// logged and dropped.
//
// ---- WHAT IS SWITCHED ON ----
//
// DISCORD_SERVER_LOG is a comma list of scopes, and each scope costs a gateway
// intent. Unset means no scopes and intents 0, exactly the bot it was before:
//
//   moderation  GUILD_MODERATION. Discord's audit log as it happens: bans,
//               kicks, timeouts, role and channel changes, messages deleted
//               by a moderator. Not privileged. Needs View Audit Log.
//   members     GUILD_MEMBERS, PRIVILEGED. Joins and leaves (the audit log
//               records neither).
//   messages    GUILD_MESSAGES. Deleted and edited messages, by author and
//               channel. Not privileged.
//   content     MESSAGE_CONTENT, PRIVILEGED. Adds the TEXT of a deleted or
//               edited message to its entry. Without it the entry names who
//               and where, never what.
//   scam        No intent of its own; switches on messages and content. The
//               scam guard (scam-guard.ts): soft-bans an account that sprays
//               the same post across channels, and flags a lone giveaway post.
//
// A privileged scope that is not ticked in the developer portal gets close code
// 4014; gateway.ts then reconnects with no intents, so the bot stays online and
// the log goes quiet with a line in the container log saying why.
//
// ---- WHERE IT POSTS ----
//
// Each server picks its own log channel with /server log, kept in
// discord_server_settings (00302). The scopes above are the bot's, the same for
// every server; the channel is the server's. An event is only ever posted in
// the server it happened in, and a server with no channel gets nothing.
//
// ---- DUPLICATES ----
//
// Every replica holds its own gateway socket and receives every event, and a
// rolling replace runs two replicas on purpose (gateway.ts). Each entry is
// posted with a nonce derived from the EVENT and `enforce_nonce: true`, so
// Discord keeps the first and drops the rest for the same author within a few
// minutes. That is the whole dedupe; there is no shared state.
//
// ---- DELETED MESSAGES ----
//
// MESSAGE_DELETE carries ids only. What was said, and who said it, comes from
// a bounded in-memory cache of recent messages. A message older than the
// process, or pushed out of the cache, is logged as "not cached". Content is
// held only while the `content` scope is on.

import { createHash } from 'node:crypto';
import type { DiscordApi } from './discord-api.js';
import type { Embed } from './audit.js';

export type ServerLogScope = 'moderation' | 'members' | 'messages' | 'content' | 'scam';

const SCOPE_INTENTS: Record<ServerLogScope, number> = {
  moderation: 1 << 2, // GUILD_MODERATION
  members: 1 << 1, // GUILD_MEMBERS
  messages: 1 << 9, // GUILD_MESSAGES
  content: 1 << 15, // MESSAGE_CONTENT
  scam: 0, // its intents come from the messages and content it implies
};

const SCOPES = Object.keys(SCOPE_INTENTS) as ServerLogScope[];

export function parseServerLogScopes(raw: string | undefined): {
  scopes: Set<ServerLogScope>;
  unknown: string[];
} {
  const scopes = new Set<ServerLogScope>();
  const unknown: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if ((SCOPES as string[]).includes(name)) scopes.add(name as ServerLogScope);
    else unknown.push(name);
  }
  // The guard reads what people post, so it needs their text.
  if (scopes.has('scam')) scopes.add('content');
  // Content is the text of messages; on its own it has no messages to read.
  if (scopes.has('content')) scopes.add('messages');
  return { scopes, unknown };
}

export function intentsFor(scopes: ReadonlySet<ServerLogScope>): number {
  let intents = 0;
  for (const scope of scopes) intents |= SCOPE_INTENTS[scope];
  return intents;
}

/** Discord takes a nonce of at most 25 characters. */
export function nonceFor(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 25);
}

// ---- the message cache ----

export interface CachedMessage {
  authorId: string;
  channelId: string;
  /** Only held while the content scope is on. */
  content: string | null;
  attachments: number;
  /** A bot's or webhook's message: never logged, only remembered so its delete is not. */
  bot?: boolean;
}

export class MessageCache {
  private readonly entries = new Map<string, CachedMessage>();

  constructor(private readonly limit = 5000) {}

  set(id: string, message: CachedMessage): void {
    this.entries.delete(id);
    this.entries.set(id, message);
    // A Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(id: string): CachedMessage | undefined {
    return this.entries.get(id);
  }

  take(id: string): CachedMessage | undefined {
    const message = this.entries.get(id);
    this.entries.delete(id);
    return message;
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---- rendering ----

const COLOR_MODERATION = 0xe67e22;
const COLOR_REMOVAL = 0xe74c3c;
const COLOR_JOIN = 0x2ecc71;
const COLOR_NEUTRAL = 0x95a5a6;
const COLOR_EDIT = 0x3498db;

/** Discord's audit log action types, in the club's words. */
const AUDIT_ACTIONS: Record<number, string> = {
  1: 'Server settings changed',
  10: 'Channel created',
  11: 'Channel changed',
  12: 'Channel deleted',
  13: 'Channel permission added',
  14: 'Channel permission changed',
  15: 'Channel permission removed',
  20: 'Member kicked',
  21: 'Members pruned',
  22: 'Member banned',
  23: 'Member unbanned',
  24: 'Member changed',
  25: 'Member roles changed',
  26: 'Member moved between voice channels',
  27: 'Member disconnected from voice',
  28: 'Bot added',
  30: 'Role created',
  31: 'Role changed',
  32: 'Role deleted',
  40: 'Invite created',
  41: 'Invite changed',
  42: 'Invite deleted',
  50: 'Webhook created',
  51: 'Webhook changed',
  52: 'Webhook deleted',
  60: 'Emoji created',
  61: 'Emoji changed',
  62: 'Emoji deleted',
  72: 'Message deleted by a moderator',
  73: 'Messages bulk deleted',
  74: 'Message pinned',
  75: 'Message unpinned',
  80: 'Integration added',
  81: 'Integration changed',
  82: 'Integration removed',
  90: 'Sticker created',
  91: 'Sticker changed',
  92: 'Sticker deleted',
  100: 'Event created',
  101: 'Event changed',
  102: 'Event deleted',
  110: 'Thread created',
  111: 'Thread changed',
  112: 'Thread deleted',
  121: 'Command permissions changed',
  140: 'AutoMod rule created',
  141: 'AutoMod rule changed',
  142: 'AutoMod rule deleted',
  143: 'AutoMod blocked a message',
  144: 'AutoMod flagged a message',
  145: 'AutoMod timed out a member',
};

const MEMBER_TARGET_ACTIONS = new Set([20, 22, 23, 24, 25, 26, 27, 72, 143, 144, 145]);
const CHANNEL_TARGET_ACTIONS = new Set([10, 11, 12, 13, 14, 15, 110, 111, 112]);
const ROLE_TARGET_ACTIONS = new Set([30, 31, 32]);
const REMOVAL_ACTIONS = new Set([12, 20, 21, 22, 32, 72, 73, 145]);

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Every line quoted, so a multi-line message cannot break out of the quote. */
function quoted(body: string): string {
  return clip(body, 1000)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function auditTarget(actionType: number, targetId: string | null | undefined): string | null {
  if (!targetId) return null;
  if (MEMBER_TARGET_ACTIONS.has(actionType)) return `<@${targetId}>`;
  if (CHANNEL_TARGET_ACTIONS.has(actionType)) return `<#${targetId}>`;
  if (ROLE_TARGET_ACTIONS.has(actionType)) return `<@&${targetId}>`;
  return `\`${targetId}\``;
}

interface AuditChange {
  key: string;
  old_value?: unknown;
  new_value?: unknown;
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return 'none';
  // Role adds and removes arrive as [{ id, name }].
  if (Array.isArray(value) && value.every((v) => v && typeof v === 'object' && 'id' in v)) {
    return value.map((v) => `<@&${String((v as { id: unknown }).id)}>`).join(' ');
  }
  if (typeof value === 'string') return clip(value, 100);
  return clip(JSON.stringify(value), 100);
}

function changeLine(change: AuditChange): string {
  if (change.key === '$add') return `added ${renderValue(change.new_value)}`;
  if (change.key === '$remove') return `removed ${renderValue(change.new_value)}`;
  if (change.key === 'communication_disabled_until') {
    const until = typeof change.new_value === 'string' ? Date.parse(change.new_value) : NaN;
    return Number.isFinite(until)
      ? `timed out until <t:${Math.floor(until / 1000)}:f>`
      : 'timeout removed';
  }
  return `${change.key}: ${renderValue(change.old_value)} -> ${renderValue(change.new_value)}`;
}

/** Role names from an audit $add/$remove ([{ id, name }]), as plain text. */
function roleList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((role) => {
    const { id, name } = (role ?? {}) as { id?: unknown; name?: unknown };
    const text = typeof name === 'string' && name ? name : String(id ?? 'a role');
    return clip(text.replace(/`/g, "'"), 100);
  });
}

function nickText(value: unknown): string {
  return typeof value === 'string' && value ? clip(value, 100) : 'None';
}

/** When a Discord account was made, read off its snowflake. */
function accountCreated(userId: string): number | null {
  try {
    return Number((BigInt(userId) >> 22n) + 1420070400000n);
  } catch {
    return null;
  }
}

/** When a snowflake id was made, in ms. */
function snowflakeTime(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
}

/** A user mention, not a role one (<@&id>). */
const USER_MENTION = /<@!?(\d{17,20})>/g;

/** A name as plain text, so a name like *x* or a backtick cannot restyle the entry. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_`~|>#\[\]()-]/g, (c) => `\\${c}`);
}

export interface ServerLogEntry {
  /** Unique per event; becomes the nonce. */
  key: string;
  embed: Embed;
  /** Who did it: their name and picture head the entry. */
  actorId?: string;
  /** A deleted message's author and channel, for finding out who deleted it. */
  deleted?: { authorId: string | null; channelId: string };
}

export interface DescribeContext {
  cache: MessageCache;
  scopes: ReadonlySet<ServerLogScope>;
  /** The log channel. Events in it are never logged, or the log feeds itself. */
  logChannelId: string;
  now: Date;
}

/**
 * Turn one gateway dispatch into a log entry, or null when it is not one.
 * Also keeps the message cache current, which is why MESSAGE_CREATE is here
 * even though it never produces an entry.
 */
export function describeDispatch(
  type: string,
  raw: unknown,
  context: DescribeContext
): ServerLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const guildId = typeof d.guild_id === 'string' ? d.guild_id : null;
  // DMs carry no guild and are nobody's server.
  if (!guildId) return null;
  const timestamp = context.now.toISOString();
  const keepContent = context.scopes.has('content');

  switch (type) {
    case 'MESSAGE_CREATE': {
      const author = d.author as { id?: string; bot?: boolean } | undefined;
      if (!author?.id || typeof d.id !== 'string' || typeof d.channel_id !== 'string') return null;
      // Bots and webhooks are held as a marker only: their deletes are the bot
      // tidying up (the session board replaces its own messages), and without
      // the marker they would look like an unknown message deleted.
      if (author.bot || d.webhook_id) {
        context.cache.set(d.id, { authorId: author.id, channelId: d.channel_id, content: null, attachments: 0, bot: true });
        return null;
      }
      context.cache.set(d.id, {
        authorId: author.id,
        channelId: d.channel_id,
        content: keepContent && typeof d.content === 'string' ? d.content : null,
        attachments: Array.isArray(d.attachments) ? d.attachments.length : 0,
      });
      return null;
    }

    case 'MESSAGE_UPDATE': {
      if (typeof d.id !== 'string' || typeof d.channel_id !== 'string') return null;
      if (d.channel_id === context.logChannelId) return null;
      const author = d.author as { id?: string; bot?: boolean } | undefined;
      if (author?.bot || d.webhook_id) return null;
      const cached = context.cache.get(d.id);
      // Discord sends an update when a link preview unfurls, with nothing
      // edited. Only a changed text, read with the content scope, is an edit.
      if (!keepContent || typeof d.content !== 'string') return null;
      if (cached && cached.content === d.content) return null;
      const authorId = author?.id ?? cached?.authorId;
      if (!authorId) return null;
      context.cache.set(d.id, {
        authorId,
        channelId: d.channel_id,
        content: d.content,
        attachments: cached?.attachments ?? 0,
      });
      const link = `https://discord.com/channels/${guildId}/${d.channel_id}/${d.id}`;
      return {
        key: `edit:${d.id}:${String(d.edited_timestamp ?? d.content.length)}`,
        actorId: authorId,
        embed: {
          title: 'Message edited',
          description: `**From:** <@${authorId}>   **In:** <#${d.channel_id}>   [Jump to message](${link})`,
          color: COLOR_EDIT,
          fields: [
            { name: 'Before', value: cached?.content ? clip(cached.content, 1000) : '_not cached_', inline: false },
            { name: 'After', value: d.content ? clip(d.content, 1000) : '_empty_', inline: false },
          ],
          footer: { text: `Author: ${authorId} | Message ID: ${d.id}` },
          timestamp,
        },
      };
    }

    case 'MESSAGE_DELETE': {
      if (typeof d.id !== 'string' || typeof d.channel_id !== 'string') return null;
      if (d.channel_id === context.logChannelId) return null;
      const cached = context.cache.take(d.id);
      if (cached?.bot) return null;
      // Uncached means posted before the bot last started (the cache lives in
      // memory, and every update restarts it). Still worth an entry: what it
      // said is gone, but who removed it can still be found.
      if (!cached) {
        return {
          key: `delete:${d.id}`,
          deleted: { authorId: null, channelId: d.channel_id },
          embed: {
            title: 'Message deleted',
            description:
              `**In:** <#${d.channel_id}>\n\nIt was posted before I last restarted, so I do not know what it said.`,
            color: COLOR_REMOVAL,
            footer: { text: `Message ID: ${d.id}` },
            timestamp,
          },
        };
      }
      const body = keepContent ? (cached.content ? `\n\n${clip(cached.content, 3500)}` : '\n\n_no text_') : '';
      const files = cached.attachments
        ? `\n\n_${cached.attachments} attachment${cached.attachments === 1 ? '' : 's'}_`
        : '';
      return {
        key: `delete:${d.id}`,
        actorId: cached.authorId,
        deleted: { authorId: cached.authorId, channelId: d.channel_id },
        embed: {
          title: 'Message deleted',
          description: `**From:** <@${cached.authorId}>   **In:** <#${d.channel_id}>${body}${files}`,
          color: COLOR_REMOVAL,
          footer: { text: `Author: ${cached.authorId} | Message ID: ${d.id}` },
          timestamp,
        },
      };
    }

    case 'MESSAGE_DELETE_BULK': {
      const ids = Array.isArray(d.ids) ? d.ids.filter((id): id is string => typeof id === 'string') : [];
      if (ids.length === 0 || typeof d.channel_id !== 'string') return null;
      if (d.channel_id === context.logChannelId) return null;
      const authors = new Map<string, number>();
      for (const id of ids) {
        const cached = context.cache.take(id);
        if (cached && !cached.bot) authors.set(cached.authorId, (authors.get(cached.authorId) ?? 0) + 1);
      }
      const byAuthor = [...authors.entries()]
        .slice(0, 20)
        .map(([authorId, count]) => `<@${authorId}>: ${count}`)
        .join('\n');
      return {
        key: `bulk:${[...ids].sort()[0]}:${ids.length}`,
        embed: {
          title: `${ids.length} messages deleted at once`,
          description:
            `In <#${d.channel_id}>` + (byAuthor ? `\n\n${byAuthor}` : '\n\nNone of them were cached.'),
          color: COLOR_REMOVAL,
          timestamp,
        },
      };
    }

    case 'GUILD_MEMBER_ADD': {
      const user = d.user as { id?: string; bot?: boolean } | undefined;
      if (!user?.id) return null;
      const created = accountCreated(user.id);
      return {
        key: `join:${guildId}:${user.id}:${String(d.joined_at ?? '')}`,
        embed: {
          title: user.bot ? 'Bot joined' : 'Member joined',
          description:
            `<@${user.id}>` +
            // A brand-new account is the usual shape of a spammer, so its age
            // is the one thing worth putting on a join.
            (created ? `\nAccount created <t:${Math.floor(created / 1000)}:R>` : ''),
          color: COLOR_JOIN,
          footer: { text: `User ${user.id}` },
          timestamp,
        },
      };
    }

    case 'GUILD_MEMBER_REMOVE': {
      const user = d.user as { id?: string } | undefined;
      if (!user?.id) return null;
      // No timestamp on a leave, so the minute stands in for one: replicas
      // agree on it, and somebody leaving twice in a minute is one entry.
      const minute = Math.floor(context.now.getTime() / 60_000);
      return {
        key: `leave:${guildId}:${user.id}:${minute}`,
        embed: {
          title: 'Member left',
          // A kick or a ban also removes, and the audit log names who did it.
          description: `<@${user.id}>\nA kick or ban shows as its own entry.`,
          color: COLOR_NEUTRAL,
          footer: { text: `User ${user.id}` },
          timestamp,
        },
      };
    }

    case 'GUILD_AUDIT_LOG_ENTRY_CREATE': {
      if (typeof d.id !== 'string') return null;
      const actionType = typeof d.action_type === 'number' ? d.action_type : -1;
      // A moderator deleting a message: the delete entry itself names them
      // (see the poster), so a second entry would only repeat it.
      if (actionType === 72 && context.scopes.has('messages')) return null;
      const actorId = typeof d.user_id === 'string' ? d.user_id : undefined;
      const targetId = typeof d.target_id === 'string' ? d.target_id : null;
      const target = auditTarget(actionType, targetId);
      const changes = Array.isArray(d.changes) ? (d.changes as AuditChange[]) : [];
      const fields: { name: string; value: string; inline: boolean }[] = [];
      const reasonField = typeof d.reason === 'string' && d.reason
        ? [{ name: 'Reason', value: clip(decodeReason(d.reason), 1000), inline: false }]
        : [];
      const footer = targetId ? { text: `ID: ${targetId}` } : undefined;
      const color = REMOVAL_ACTIONS.has(actionType) ? COLOR_REMOVAL : COLOR_MODERATION;

      // A member's roles or nickname read as a sentence about them, headed by
      // whoever made the change.
      if ((actionType === 25 || actionType === 24) && target) {
        const roleChanges = changes.filter((change) => change.key === '$add' || change.key === '$remove');
        const nick = changes.find((change) => change.key === 'nick');
        const others = changes.filter((change) => change !== nick && !roleChanges.includes(change));
        const sentences = roleChanges.flatMap((change) =>
          roleList(change.new_value).map((role) =>
            change.key === '$add'
              ? `${target} **was given the** \`${role}\` **role**`
              : `${target} **was removed from the** \`${role}\` **role**`
          )
        );
        if (nick) {
          sentences.push(`${target} **nickname changed**`);
          fields.push(
            { name: 'Before', value: nickText(nick.old_value), inline: false },
            { name: 'After', value: nickText(nick.new_value), inline: false }
          );
        }
        sentences.push(...others.slice(0, 6).map((change) => `${target} ${changeLine(change)}`));
        if (sentences.length > 0) {
          return {
            key: `audit:${d.id}`,
            actorId,
            embed: {
              description: sentences.slice(0, 20).join('\n'),
              color,
              fields: [...fields, ...reasonField],
              footer,
              timestamp,
            },
          };
        }
      }

      const lines = changes.slice(0, 8).map(changeLine);
      if (changes.length > 8) lines.push(`...and ${changes.length - 8} more`);
      const options = d.options as { channel_id?: string; count?: string } | undefined;
      const where = options?.channel_id ? `\n**In:** <#${options.channel_id}>` : '';
      const count = options?.count ? ` (${options.count})` : '';
      return {
        key: `audit:${d.id}`,
        actorId,
        embed: {
          title: (AUDIT_ACTIONS[actionType] ?? `Server change (action ${actionType})`) + count,
          description:
            `**By:** ${actorId ? `<@${actorId}>` : 'someone'}` +
            (target ? `\n**On:** ${target}` : '') +
            where +
            (lines.length ? `\n\n${lines.join('\n')}` : ''),
          color,
          fields: reasonField.length ? reasonField : undefined,
          footer,
          timestamp,
        },
      };
    }

    default:
      return null;
  }
}

/** The bot URL-encodes its own reasons (discord-api.ts); show them readable. */
function decodeReason(reason: string): string {
  try {
    return decodeURIComponent(reason);
  } catch {
    return reason;
  }
}

// ---- the poster ----

export interface ServerLogOptions {
  /** getUserName is optional: without it, people show as a bare mention. */
  api: Pick<DiscordApi, 'createMessage'> &
    Partial<Pick<DiscordApi, 'getUserName' | 'getUserProfile' | 'listMessageDeleteAudits' | 'postMessage' | 'editMessage'>>;
  scopes: ReadonlySet<ServerLogScope>;
  /**
   * Where this server's log posts, or null while that server has none
   * (/config server_log). Each server has its own (00302), so an event is only ever posted in
   * the server it happened in.
   */
  resolveChannel: (guildId: string) => Promise<string | null>;
  log?: (line: string) => void;
  now?: () => Date;
  /** Past this many waiting entries, new ones are counted and dropped. */
  maxQueue?: number;
  /** How long a delete waits for Discord to write its audit entry. */
  auditDelayMs?: number;
  /**
   * Role changes by one person go in one entry: posted at the first change,
   * then edited to the full list once this long passes with no more.
   */
  stackMs?: number;
}

export interface ServerLog {
  onDispatch(type: string, data: unknown): void;
  /** Post an entry built elsewhere (the scam guard), on the same queue and rules. */
  post(guildId: string, entry: ServerLogEntry): void;
  /** For tests: resolves once everything queued so far is posted. */
  drain(): Promise<void>;
}

const LOGGED_TYPES = new Set([
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
  'MESSAGE_DELETE_BULK',
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_REMOVE',
  'GUILD_AUDIT_LOG_ENTRY_CREATE',
]);

export function createServerLog(options: ServerLogOptions): ServerLog {
  const {
    api,
    scopes,
    resolveChannel,
    log = (line: string) => console.error(line),
    now = () => new Date(),
    maxQueue = 200,
    auditDelayMs = 1500,
    stackMs = 5000,
  } = options;
  const cache = new MessageCache();
  // Posts go one at a time. Discord allows about five a channel every five
  // seconds and createMessage waits out a 429, so a serial chain is the rate
  // limiter; a burst (a raid, a purge) queues instead of being refused.
  let chain: Promise<void> = Promise.resolve();
  let waiting = 0;
  let dropped = 0;
  // Each server's channel as last resolved, for when a lookup fails.
  const lastChannel = new Map<string, string | null>();
  const guildOf = (data: unknown): string | null => {
    const guildId = (data as { guild_id?: unknown } | null)?.guild_id;
    return typeof guildId === 'string' ? guildId : null;
  };

  function enqueue(type: string, data: unknown, built?: ServerLogEntry) {
    if (waiting >= maxQueue) {
      dropped += 1;
      return;
    }
    waiting += 1;
    // The event is described when its turn comes, but the clock is read now.
    const at = now();
    // Discord writes the audit entry for a delete just after the delete
    // itself, so the look-up waits a moment. Started now, so a run of deletes
    // waits once together rather than once each in the queue.
    const settled = type === 'MESSAGE_DELETE' ? new Promise((resolve) => setTimeout(resolve, auditDelayMs)) : null;
    chain = chain.then(async () => {
      try {
        // DMs carry no server and are nobody's log.
        const guildId = guildOf(data);
        if (!guildId) return;
        const channelId = await resolveChannel(guildId).catch(() => lastChannel.get(guildId) ?? null);
        lastChannel.set(guildId, channelId);
        if (!channelId) {
          // A server with no log. The cache still has to follow along, or a
          // later delete has no author once it sets one.
          if (!built) describeDispatch(type, data, { cache, scopes, logChannelId: '', now: at });
          return;
        }
        const described = built ?? describeDispatch(type, data, { cache, scopes, logChannelId: channelId, now: at });
        if (!described) return;
        if (settled && described.deleted) {
          await settled;
          await nameDeleter(guildId, described);
        }
        const entry = await withNames(described);
        if (dropped > 0) {
          await api.createMessage(channelId, {
            content: `${dropped} server log entr${dropped === 1 ? 'y was' : 'ies were'} dropped: too many at once.`,
            allowed_mentions: { parse: [] },
          });
          dropped = 0;
        }
        const ok = await api.createMessage(channelId, {
          embeds: [entry.embed],
          // Mentions render but never ping: a log must not notify the people in it.
          allowed_mentions: { parse: [] },
          nonce: nonceFor(entry.key),
          enforce_nonce: true,
        });
        if (!ok) log(`[server-log] Discord refused a ${type} entry; check the bot can post there`);
      } catch (error) {
        log(`[server-log] ${type} failed: ${String(error)}`);
      } finally {
        waiting -= 1;
      }
    });
  }

  /** Run some posting work on the same queue, once the server's log channel is known. */
  function enqueueTask(label: string, guildId: string, work: (channelId: string) => Promise<void>) {
    chain = chain.then(async () => {
      try {
        const channelId = await resolveChannel(guildId).catch(() => lastChannel.get(guildId) ?? null);
        lastChannel.set(guildId, channelId);
        if (channelId) await work(channelId);
      } catch (error) {
        log(`[server-log] ${label} failed: ${String(error)}`);
      }
    });
  }

  // A mention in an embed only shows a name when the reader's Discord already
  // knows that user; otherwise it shows the raw <@id>. So each person's name is
  // written beside the mention, looked up once and held for an hour.
  type Profile = { name: string; avatarUrl: string | null };
  const names = new Map<string, { profile: Profile | null; at: number }>();
  async function profileOf(userId: string): Promise<Profile | null> {
    const held = names.get(userId);
    if (held && Date.now() - held.at < 3_600_000) return held.profile;
    let profile: Profile | null = null;
    try {
      if (api.getUserProfile) profile = await api.getUserProfile(userId);
      else if (api.getUserName) {
        const name = await api.getUserName(userId);
        profile = name ? { name, avatarUrl: null } : null;
      }
    } catch {
      profile = held?.profile ?? null;
    }
    if (names.size >= 2000) names.clear();
    names.set(userId, { profile, at: Date.now() });
    return profile;
  }
  async function nameOf(userId: string): Promise<string | null> {
    return (await profileOf(userId))?.name ?? null;
  }
  // Each delete audit entry's count as last seen, so a moderator's second
  // delete (which bumps the count rather than writing a new entry) is noticed.
  const auditCounts = new Map<string, number>();
  async function nameDeleter(guildId: string, entry: ServerLogEntry): Promise<void> {
    const deleted = entry.deleted;
    if (!deleted || !api.listMessageDeleteAudits) return;
    const audits = await api.listMessageDeleteAudits(guildId).catch(() => null);
    if (!audits) return;
    const fresh = audits.find((audit) => {
      if (audit.channelId !== deleted.channelId) return false;
      if (deleted.authorId && audit.targetId !== deleted.authorId) return false;
      const seen = auditCounts.get(audit.id);
      if (seen !== undefined) return audit.count > seen;
      // Never seen: it counts only if it was written just now.
      return Date.now() - snowflakeTime(audit.id) < 15_000;
    });
    if (auditCounts.size > 500) auditCounts.clear();
    for (const audit of audits) auditCounts.set(audit.id, audit.count);
    // No fresh entry: Discord writes none when people delete their own.
    if (!fresh?.userId) return;
    entry.actorId = fresh.userId;
    const by = `   **Deleted by:** <@${fresh.userId}>`;
    let description = entry.embed.description ?? '';
    if (!deleted.authorId && fresh.targetId) {
      description = description.replace('**In:**', `**From:** <@${fresh.targetId}>   **In:**`);
    }
    const firstBreak = description.indexOf('\n');
    entry.embed.description =
      firstBreak === -1 ? description + by : description.slice(0, firstBreak) + by + description.slice(firstBreak);
  }

  async function withNames(entry: ServerLogEntry): Promise<ServerLogEntry> {
    const embed: Embed = { ...entry.embed, timestamp: entry.embed.timestamp ?? now().toISOString() };
    if (entry.actorId) {
      const actor = await profileOf(entry.actorId);
      if (actor) embed.author = { name: actor.name, icon_url: actor.avatarUrl ?? undefined };
    }
    entry = { ...entry, embed };
    const texts = [entry.embed.description ?? '', ...(entry.embed.fields ?? []).map((f) => f.value)];
    const ids = new Set<string>();
    for (const text of texts) for (const match of text.matchAll(USER_MENTION)) ids.add(match[1] as string);
    if (ids.size === 0) return entry;
    // The person in the header is named there already; their mention stays bare.
    if (entry.embed.author && entry.actorId) ids.delete(entry.actorId);
    const found = new Map<string, string>();
    for (const id of [...ids].slice(0, 10)) {
      const name = await nameOf(id);
      if (name) found.set(id, name);
    }
    const named = (text: string) =>
      text.replace(USER_MENTION, (mention, id: string) =>
        found.has(id) ? `**${escapeMarkdown(found.get(id) as string)}** (${mention})` : mention
      );
    return {
      ...entry,
      embed: {
        ...entry.embed,
        description: entry.embed.description === undefined ? undefined : named(entry.embed.description),
        fields: entry.embed.fields?.map((f) => ({ ...f, value: named(f.value) })),
      },
    };
  }

  // ---- role changes, stacked ----
  interface RoleStack {
    guildId: string;
    actorId: string | null;
    firstAuditId: string;
    entries: number;
    startedAt: number;
    members: Map<string, { added: string[]; removed: string[] }>;
    reason: string | null;
    timer: ReturnType<typeof setTimeout> | null;
    /** Bumped by every change; the entry is edited when it is ahead of what was posted. */
    version: number;
    posted: { channelId: string; messageId: string | null; version: number } | null;
  }
  const roleStacks = new Map<string, RoleStack>();

  /** A plain role change (nothing but roles added or removed), or null. */
  function roleChangeOf(data: unknown): { guildId: string; actorId: string | null; auditId: string; targetId: string; added: string[]; removed: string[]; reason: string | null } | null {
    const d = data as Record<string, unknown> | null;
    if (!d || d.action_type !== 25 || typeof d.id !== 'string' || typeof d.target_id !== 'string') return null;
    const guildId = guildOf(d);
    const changes = Array.isArray(d.changes) ? (d.changes as AuditChange[]) : [];
    if (!guildId || changes.length === 0 || changes.some((c) => c.key !== '$add' && c.key !== '$remove')) return null;
    return {
      guildId,
      actorId: typeof d.user_id === 'string' ? d.user_id : null,
      auditId: d.id,
      targetId: d.target_id,
      added: changes.filter((c) => c.key === '$add').flatMap((c) => roleList(c.new_value)),
      removed: changes.filter((c) => c.key === '$remove').flatMap((c) => roleList(c.new_value)),
      reason: typeof d.reason === 'string' && d.reason ? decodeReason(d.reason) : null,
    };
  }

  function stackRoleChange(change: NonNullable<ReturnType<typeof roleChangeOf>>) {
    const key = `${change.guildId}:${change.actorId ?? ''}`;
    let stack = roleStacks.get(key);
    if (!stack) {
      stack = {
        guildId: change.guildId,
        actorId: change.actorId,
        firstAuditId: change.auditId,
        entries: 0,
        startedAt: Date.now(),
        members: new Map(),
        reason: null,
        timer: null,
        version: 0,
        posted: null,
      };
      roleStacks.set(key, stack);
      postRoleStack(stack);
    }
    stack.version += 1;
    stack.entries += 1;
    stack.reason = change.reason ?? stack.reason;
    const member = stack.members.get(change.targetId) ?? { added: [], removed: [] };
    for (const role of change.added) {
      // Added back after being removed in the same burst: no net change.
      if (member.removed.includes(role)) member.removed = member.removed.filter((r) => r !== role);
      else if (!member.added.includes(role)) member.added.push(role);
    }
    for (const role of change.removed) {
      if (member.added.includes(role)) member.added = member.added.filter((r) => r !== role);
      else if (!member.removed.includes(role)) member.removed.push(role);
    }
    stack.members.set(change.targetId, member);
    if (stack.timer) clearTimeout(stack.timer);
    // Held until the burst goes quiet, but never more than a minute.
    const wait = Date.now() - stack.startedAt > 60_000 ? 0 : stackMs;
    stack.timer = setTimeout(() => flushRoleStack(key), wait);
  }

  /** The first change posts at once, so the log is never behind by the wait. */
  function postRoleStack(stack: RoleStack) {
    enqueueTask('role changes', stack.guildId, async (channelId) => {
      const built = describeRoleStack(stack);
      if (!built) return;
      const entry = await withNames(built);
      const payload = { embeds: [entry.embed], allowed_mentions: { parse: [] }, nonce: nonceFor(entry.key), enforce_nonce: true };
      const messageId = api.postMessage
        ? await api.postMessage(channelId, payload)
        : (await api.createMessage(channelId, payload), null);
      stack.posted = { channelId, messageId, version: stack.version };
    });
  }

  /** Once the burst is quiet, the posted entry is edited to hold all of it. */
  function flushRoleStack(key: string) {
    const stack = roleStacks.get(key);
    if (!stack) return;
    roleStacks.delete(key);
    if (stack.timer) clearTimeout(stack.timer);
    enqueueTask('role changes', stack.guildId, async (channelId) => {
      const posted = stack.posted;
      if (posted && posted.version >= stack.version) return;
      const built = describeRoleStack(stack);
      if (!built) return;
      const entry = await withNames(built);
      if (posted?.messageId && api.editMessage) {
        await api.editMessage(posted.channelId, posted.messageId, { embeds: [entry.embed], allowed_mentions: { parse: [] } });
        return;
      }
      // The first post failed or cannot be edited: post the whole burst instead.
      await api.createMessage(channelId, {
        embeds: [entry.embed],
        allowed_mentions: { parse: [] },
        nonce: nonceFor(`${entry.key}:final`),
        enforce_nonce: true,
      });
    });
  }

  const roleNames = (roles: string[]) => roles.map((role) => `\`${role}\``).join(', ');

  function describeRoleStack(stack: RoleStack): ServerLogEntry | null {
    const members = [...stack.members.entries()].filter(([, m]) => m.added.length || m.removed.length);
    if (members.length === 0) return null;
    const lists = (m: { added: string[]; removed: string[] }) =>
      [m.added.length ? `**Added:** ${roleNames(m.added)}` : '', m.removed.length ? `**Removed:** ${roleNames(m.removed)}` : '']
        .filter(Boolean)
        .join('\n');
    let description: string;
    let footer: string;
    if (members.length === 1) {
      const [memberId, change] = members[0] as [string, { added: string[]; removed: string[] }];
      description = `<@${memberId}> **roles changed**\n${lists(change)}`;
      footer = `ID: ${memberId}`;
    } else {
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((role) => b.includes(role));
      const [, first] = members[0] as [string, { added: string[]; removed: string[] }];
      const alike = members.every(([, m]) => same(m.added, first.added) && same(m.removed, first.removed));
      const shown = members.slice(0, 60);
      const more = members.length > shown.length ? `\n...and ${members.length - shown.length} more` : '';
      description = alike
        ? `**${members.length} members' roles changed**\n${lists(first)}\n\n**Members:** ${shown.map(([id]) => `<@${id}>`).join(', ')}${more}`
        : `**${members.length} members' roles changed**\n\n` +
          shown
            .map(
              ([id, m]) =>
                `<@${id}>: ` +
                [m.added.length ? `added ${roleNames(m.added)}` : '', m.removed.length ? `removed ${roleNames(m.removed)}` : '']
                  .filter(Boolean)
                  .join('; ')
            )
            .join('\n') +
          more;
      footer = `${members.length} members`;
    }
    return {
      key: `roles:${stack.firstAuditId}:${stack.entries}`,
      actorId: stack.actorId ?? undefined,
      embed: {
        description: clip(description, 4000),
        color: COLOR_MODERATION,
        fields: stack.reason ? [{ name: 'Reason', value: clip(stack.reason, 1000), inline: false }] : undefined,
        footer: { text: footer },
      },
    };
  }

  return {
    onDispatch(type, data) {
      if (!LOGGED_TYPES.has(type)) return;
      if (type === 'GUILD_AUDIT_LOG_ENTRY_CREATE' && scopes.has('moderation')) {
        const roleChange = roleChangeOf(data);
        if (roleChange) {
          stackRoleChange(roleChange);
          return;
        }
      }
      // A new message only feeds the cache. Done at once rather than queued, so
      // a busy channel cannot fill the queue with work that posts nothing.
      if (type === 'MESSAGE_CREATE') {
        const guildId = guildOf(data);
        const logChannelId = (guildId && lastChannel.get(guildId)) || '';
        describeDispatch(type, data, { cache, scopes, logChannelId, now: now() });
        return;
      }
      enqueue(type, data);
    },
    post(guildId, entry) {
      enqueue('scam guard', { guild_id: guildId }, entry);
    },
    drain: () => {
      for (const key of [...roleStacks.keys()]) flushRoleStack(key);
      return chain;
    },
  };
}
