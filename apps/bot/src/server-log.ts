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
//
// A privileged scope that is not ticked in the developer portal gets close code
// 4014; gateway.ts then reconnects with no intents, so the bot stays online and
// the log goes quiet with a line in the container log saying why.
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

export type ServerLogScope = 'moderation' | 'members' | 'messages' | 'content';

const SCOPE_INTENTS: Record<ServerLogScope, number> = {
  moderation: 1 << 2, // GUILD_MODERATION
  members: 1 << 1, // GUILD_MEMBERS
  messages: 1 << 9, // GUILD_MESSAGES
  content: 1 << 15, // MESSAGE_CONTENT
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

/** When a Discord account was made, read off its snowflake. */
function accountCreated(userId: string): number | null {
  try {
    return Number((BigInt(userId) >> 22n) + 1420070400000n);
  } catch {
    return null;
  }
}

export interface ServerLogEntry {
  /** Unique per event; becomes the nonce. */
  key: string;
  embed: Embed;
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
      // Bots and webhooks are not cached: their deletes are the bot tidying up
      // (the session board replaces its own messages) and would be noise.
      if (!author?.id || author.bot || d.webhook_id) return null;
      if (typeof d.id !== 'string' || typeof d.channel_id !== 'string') return null;
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
        embed: {
          title: 'Message edited',
          description:
            `<@${authorId}> in <#${d.channel_id}>\n\n**Before**\n` +
            (cached?.content ? quoted(cached.content) : '_not cached_') +
            `\n\n**After**\n${d.content ? quoted(d.content) : '_empty_'}`,
          color: COLOR_EDIT,
          fields: [{ name: 'Message', value: link, inline: false }],
          timestamp,
        },
      };
    }

    case 'MESSAGE_DELETE': {
      if (typeof d.id !== 'string' || typeof d.channel_id !== 'string') return null;
      if (d.channel_id === context.logChannelId) return null;
      const cached = context.cache.take(d.id);
      // Uncached means older than the process, or a bot's own message. Either
      // way there is nothing to say about it but its id, which helps nobody.
      if (!cached) return null;
      const body = keepContent
        ? cached.content
          ? `\n\n${quoted(cached.content)}`
          : '\n\n_no text_'
        : '';
      const files = cached.attachments
        ? `\n${cached.attachments} attachment${cached.attachments === 1 ? '' : 's'}`
        : '';
      return {
        key: `delete:${d.id}`,
        embed: {
          title: 'Message deleted',
          description: `<@${cached.authorId}> in <#${d.channel_id}>${body}${files}`,
          color: COLOR_REMOVAL,
          footer: { text: `Message ${d.id}` },
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
        if (cached) authors.set(cached.authorId, (authors.get(cached.authorId) ?? 0) + 1);
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
      const actor = typeof d.user_id === 'string' ? `<@${d.user_id}>` : 'Someone';
      const target = auditTarget(actionType, d.target_id as string | null | undefined);
      const changes = Array.isArray(d.changes) ? (d.changes as AuditChange[]) : [];
      const lines = changes.slice(0, 8).map(changeLine);
      if (changes.length > 8) lines.push(`...and ${changes.length - 8} more`);
      const options = d.options as { channel_id?: string; count?: string } | undefined;
      const where = options?.channel_id ? ` in <#${options.channel_id}>` : '';
      const count = options?.count ? ` (${options.count})` : '';
      const fields = typeof d.reason === 'string' && d.reason
        ? [{ name: 'Reason', value: clip(decodeReason(d.reason), 1000), inline: false }]
        : undefined;
      return {
        key: `audit:${d.id}`,
        embed: {
          title: (AUDIT_ACTIONS[actionType] ?? `Server change (action ${actionType})`) + count,
          description:
            `By ${actor}` +
            (target ? `\nOn ${target}` : '') +
            where +
            (lines.length ? `\n\n${lines.join('\n')}` : ''),
          color: REMOVAL_ACTIONS.has(actionType) ? COLOR_REMOVAL : COLOR_MODERATION,
          fields,
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
  api: Pick<DiscordApi, 'createMessage'>;
  scopes: ReadonlySet<ServerLogScope>;
  /** The channel to post in, or null while it is not configured. */
  resolveChannel: () => Promise<string | null>;
  log?: (line: string) => void;
  now?: () => Date;
  /** Past this many waiting entries, new ones are counted and dropped. */
  maxQueue?: number;
}

export interface ServerLog {
  onDispatch(type: string, data: unknown): void;
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
  } = options;
  const cache = new MessageCache();
  // Posts go one at a time. Discord allows about five a channel every five
  // seconds and createMessage waits out a 429, so a serial chain is the rate
  // limiter; a burst (a raid, a purge) queues instead of being refused.
  let chain: Promise<void> = Promise.resolve();
  let waiting = 0;
  let dropped = 0;
  let lastChannel: string | null = null;
  let warnedUnset = false;

  function enqueue(type: string, data: unknown) {
    if (waiting >= maxQueue) {
      dropped += 1;
      return;
    }
    waiting += 1;
    // The event is described when its turn comes, but the clock is read now.
    const at = now();
    chain = chain.then(async () => {
      try {
        const channelId = await resolveChannel().catch(() => lastChannel);
        lastChannel = channelId;
        if (!channelId) {
          if (!warnedUnset) {
            log('[server-log] no server_log_channel_id set (/config server_log): nothing is posted');
            warnedUnset = true;
          }
          // The cache still has to follow along, or a later delete has no author.
          describeDispatch(type, data, { cache, scopes, logChannelId: '', now: at });
          return;
        }
        warnedUnset = false;
        const entry = describeDispatch(type, data, { cache, scopes, logChannelId: channelId, now: at });
        if (!entry) return;
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

  return {
    onDispatch(type, data) {
      if (!LOGGED_TYPES.has(type)) return;
      // A new message only feeds the cache. Done at once rather than queued, so
      // a busy channel cannot fill the queue with work that posts nothing.
      if (type === 'MESSAGE_CREATE') {
        describeDispatch(type, data, { cache, scopes, logChannelId: lastChannel ?? '', now: now() });
        return;
      }
      enqueue(type, data);
    },
    drain: () => chain,
  };
}
