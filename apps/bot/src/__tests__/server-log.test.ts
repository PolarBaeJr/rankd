import { describe, expect, it, vi } from 'vitest';
import {
  MessageCache,
  createServerLog,
  describeDispatch,
  intentsFor,
  nonceFor,
  parseServerLogScopes,
  type ServerLogScope,
} from '../server-log.js';

const NOW = new Date('2026-10-20T18:00:00Z');

function context(scopes: ServerLogScope[], cache = new MessageCache()) {
  return { cache, scopes: new Set(scopes), logChannelId: 'log', now: NOW };
}

const created = (id: string, content = 'buy crypto now', extra: Record<string, unknown> = {}) => ({
  id,
  guild_id: 'g',
  channel_id: 'general',
  author: { id: 'spammer' },
  content,
  attachments: [],
  ...extra,
});

describe('scopes', () => {
  it('parses the env list, ignoring case and junk, and content implies messages', () => {
    const { scopes, unknown } = parseServerLogScopes(' Moderation, content ,bogus');
    expect([...scopes].sort()).toEqual(['content', 'messages', 'moderation']);
    expect(unknown).toEqual(['bogus']);
  });

  it('unset is no scopes and no intents', () => {
    expect(parseServerLogScopes(undefined).scopes.size).toBe(0);
    expect(intentsFor(new Set())).toBe(0);
  });

  it('maps each scope to its intent', () => {
    expect(intentsFor(new Set<ServerLogScope>(['moderation', 'members', 'messages', 'content']))).toBe(
      (1 << 2) | (1 << 1) | (1 << 9) | (1 << 15)
    );
  });

  it('makes a nonce Discord accepts, the same for the same event', () => {
    expect(nonceFor('delete:1')).toHaveLength(25);
    expect(nonceFor('delete:1')).toBe(nonceFor('delete:1'));
    expect(nonceFor('delete:1')).not.toBe(nonceFor('delete:2'));
  });
});

describe('MessageCache', () => {
  it('drops the oldest past its limit', () => {
    const cache = new MessageCache(2);
    for (const id of ['1', '2', '3']) cache.set(id, { authorId: 'a', channelId: 'c', content: null, attachments: 0 });
    expect(cache.get('1')).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});

describe('describeDispatch', () => {
  it('logs a deleted message with its author, and its text only with the content scope', () => {
    const withText = context(['messages', 'content']);
    describeDispatch('MESSAGE_CREATE', created('m1'), withText);
    const entry = describeDispatch('MESSAGE_DELETE', { id: 'm1', guild_id: 'g', channel_id: 'general' }, withText);
    expect(entry?.key).toBe('delete:m1');
    expect(entry?.embed.description).toContain('<@spammer>');
    expect(entry?.embed.description).toContain('> buy crypto now');

    const noText = context(['messages']);
    describeDispatch('MESSAGE_CREATE', created('m2'), noText);
    const bare = describeDispatch('MESSAGE_DELETE', { id: 'm2', guild_id: 'g', channel_id: 'general' }, noText);
    expect(bare?.embed.description).toContain('<@spammer>');
    expect(bare?.embed.description).not.toContain('crypto');
  });

  it('skips uncached deletes, bots, DMs and the log channel itself', () => {
    const ctx = context(['messages', 'content']);
    expect(describeDispatch('MESSAGE_DELETE', { id: 'x', guild_id: 'g', channel_id: 'general' }, ctx)).toBeNull();

    describeDispatch('MESSAGE_CREATE', created('b1', 'beep', { author: { id: 'bot', bot: true } }), ctx);
    expect(describeDispatch('MESSAGE_DELETE', { id: 'b1', guild_id: 'g', channel_id: 'general' }, ctx)).toBeNull();

    describeDispatch('MESSAGE_CREATE', created('l1', 'hi', { channel_id: 'log' }), ctx);
    expect(describeDispatch('MESSAGE_DELETE', { id: 'l1', guild_id: 'g', channel_id: 'log' }, ctx)).toBeNull();

    expect(describeDispatch('MESSAGE_DELETE', { id: 'dm', channel_id: 'dm' }, ctx)).toBeNull();
  });

  it('logs an edit with before and after, and ignores a link preview update', () => {
    const ctx = context(['messages', 'content']);
    describeDispatch('MESSAGE_CREATE', created('e1', 'hello'), ctx);
    expect(
      describeDispatch('MESSAGE_UPDATE', { ...created('e1', 'hello'), edited_timestamp: null }, ctx)
    ).toBeNull();
    const entry = describeDispatch(
      'MESSAGE_UPDATE',
      { ...created('e1', 'goodbye'), edited_timestamp: '2026-10-20T18:01:00Z' },
      ctx
    );
    expect(entry?.embed.description).toContain('> hello');
    expect(entry?.embed.description).toContain('> goodbye');
  });

  it('counts a bulk delete by author', () => {
    const ctx = context(['messages']);
    describeDispatch('MESSAGE_CREATE', created('k1'), ctx);
    describeDispatch('MESSAGE_CREATE', created('k2'), ctx);
    const entry = describeDispatch(
      'MESSAGE_DELETE_BULK',
      { ids: ['k1', 'k2', 'k3'], guild_id: 'g', channel_id: 'general' },
      ctx
    );
    expect(entry?.embed.title).toBe('3 messages deleted at once');
    expect(entry?.embed.description).toContain('<@spammer>: 2');
  });

  it('gives a join the account age', () => {
    const entry = describeDispatch(
      'GUILD_MEMBER_ADD',
      { guild_id: 'g', user: { id: '175928847299117063' }, joined_at: '2026-10-20T18:00:00Z' },
      context(['members'])
    );
    expect(entry?.embed.title).toBe('Member joined');
    expect(entry?.embed.description).toMatch(/Account created <t:\d+:R>/);
  });

  it('renders an audit log ban with who did it, the target and the reason', () => {
    const entry = describeDispatch(
      'GUILD_AUDIT_LOG_ENTRY_CREATE',
      {
        id: 'a1',
        guild_id: 'g',
        action_type: 22,
        user_id: 'mod',
        target_id: 'spammer',
        reason: encodeURIComponent('Soft ban by mod: spam'),
      },
      context(['moderation'])
    );
    expect(entry?.key).toBe('audit:a1');
    expect(entry?.embed.title).toBe('Member banned');
    expect(entry?.embed.description).toContain('By <@mod>');
    expect(entry?.embed.description).toContain('On <@spammer>');
    expect(entry?.embed.fields?.[0]?.value).toBe('Soft ban by mod: spam');
  });

  it('renders role changes and timeouts readably', () => {
    const roles = describeDispatch(
      'GUILD_AUDIT_LOG_ENTRY_CREATE',
      {
        id: 'a2',
        guild_id: 'g',
        action_type: 25,
        user_id: 'mod',
        target_id: 'm',
        changes: [{ key: '$add', new_value: [{ id: 'r1', name: 'Exec' }] }],
      },
      context(['moderation'])
    );
    expect(roles?.embed.description).toContain('added <@&r1>');

    const timeout = describeDispatch(
      'GUILD_AUDIT_LOG_ENTRY_CREATE',
      {
        id: 'a3',
        guild_id: 'g',
        action_type: 24,
        user_id: 'mod',
        target_id: 'm',
        changes: [{ key: 'communication_disabled_until', new_value: '2026-10-21T18:00:00Z' }],
      },
      context(['moderation'])
    );
    expect(timeout?.embed.description).toContain('timed out until <t:');
  });
});

describe('createServerLog', () => {
  it('posts with a nonce and no pings, and stays quiet with no channel', async () => {
    const createMessage = vi.fn(async () => true);
    let channel: string | null = null;
    const serverLog = createServerLog({
      api: { createMessage },
      scopes: new Set<ServerLogScope>(['moderation']),
      resolveChannel: async () => channel,
      log: () => {},
      now: () => NOW,
    });
    const ban = { id: 'a1', guild_id: 'g', action_type: 22, user_id: 'mod', target_id: 's' };

    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', ban);
    await serverLog.drain();
    expect(createMessage).not.toHaveBeenCalled();

    channel = 'log';
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', ban);
    serverLog.onDispatch('TYPING_START', {});
    await serverLog.drain();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith(
      'log',
      expect.objectContaining({
        nonce: nonceFor('audit:a1'),
        enforce_nonce: true,
        allowed_mentions: { parse: [] },
      })
    );
  });

  it('drops past the queue limit and says how many', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createMessage = vi.fn(async () => {
      await gate;
      return true;
    });
    const serverLog = createServerLog({
      api: { createMessage },
      scopes: new Set<ServerLogScope>(['moderation']),
      resolveChannel: async () => 'log',
      log: () => {},
      maxQueue: 2,
    });
    for (let i = 0; i < 5; i += 1) {
      serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', { id: `a${i}`, guild_id: 'g', action_type: 22 });
    }
    release();
    await serverLog.drain();
    const contents = createMessage.mock.calls.map((call) => (call as unknown[])[1] as { content?: string });
    expect(contents.some((c) => c.content?.startsWith('3 server log entries were dropped'))).toBe(true);
  });
});
