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
    expect(entry?.embed.description).toContain('buy crypto now');
    expect(entry?.actorId).toBe('spammer');
    expect(entry?.embed.footer?.text).toBe('Author: spammer | Message ID: m1');

    const noText = context(['messages']);
    describeDispatch('MESSAGE_CREATE', created('m2'), noText);
    const bare = describeDispatch('MESSAGE_DELETE', { id: 'm2', guild_id: 'g', channel_id: 'general' }, noText);
    expect(bare?.embed.description).toContain('<@spammer>');
    expect(bare?.embed.description).not.toContain('crypto');
  });

  it('still logs a delete it has no copy of, saying where and that the rest is unknown', () => {
    const ctx = context(['messages', 'content']);
    const entry = describeDispatch('MESSAGE_DELETE', { id: 'x', guild_id: 'g', channel_id: 'general' }, ctx);
    expect(entry?.embed.title).toBe('Message deleted');
    expect(entry?.embed.description).toContain('<#general>');
    expect(entry?.embed.description).toContain('before I last restarted');
  });

  it("skips a bot's own deletes, DMs and the log channel itself", () => {
    const ctx = context(['messages', 'content']);

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
    expect(entry?.embed.fields?.map((f) => [f.name, f.value])).toEqual([
      ['Before', 'hello'],
      ['After', 'goodbye'],
    ]);
    expect(entry?.embed.description).toContain('**From:** <@spammer>');
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
    expect(entry?.embed.description).toContain('**By:** <@mod>');
    expect(entry?.actorId).toBe('mod');
    expect(entry?.embed.description).toContain('**On:** <@spammer>');
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
    expect(roles?.embed.description).toBe('<@m> **was given the** `Exec` **role**');
    expect(roles?.embed.title).toBeUndefined();
    expect(roles?.actorId).toBe('mod');
    expect(roles?.embed.footer?.text).toBe('ID: m');

    const nick = describeDispatch(
      'GUILD_AUDIT_LOG_ENTRY_CREATE',
      {
        id: 'a4',
        guild_id: 'g',
        action_type: 24,
        user_id: 'mod',
        target_id: 'm',
        changes: [
          { key: 'nick', new_value: 'Starfish' },
          { key: '$remove', new_value: [{ id: 'r2', name: 'Land Crab' }] },
        ],
      },
      context(['moderation'])
    );
    expect(nick?.embed.description).toBe('<@m> **was removed from the** `Land Crab` **role**\n<@m> **nickname changed**');
    expect(nick?.embed.fields?.map((f) => [f.name, f.value])).toEqual([
      ['Before', 'None'],
      ['After', 'Starfish'],
    ]);

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

  it("posts each server's events in that server's own channel, and nothing for a server with none", async () => {
    const createMessage = vi.fn(async () => true);
    const channels: Record<string, string> = { b: 'b-log' };
    const serverLog = createServerLog({
      api: { createMessage },
      scopes: new Set<ServerLogScope>(['moderation']),
      resolveChannel: async (guildId) => channels[guildId] ?? null,
      log: () => {},
      now: () => NOW,
    });
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', { id: 'a1', guild_id: 'a', action_type: 22 });
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', { id: 'b1', guild_id: 'b', action_type: 22 });
    serverLog.post('a', { key: 'scam-a', embed: { title: 'Scam spray caught', color: 0 } });
    serverLog.post('b', { key: 'scam-b', embed: { title: 'Scam spray caught', color: 0 } });
    await serverLog.drain();
    const posted = createMessage.mock.calls.map((call) => (call as unknown[])[0]);
    expect(posted).toEqual(['b-log', 'b-log']);
  });

  it('writes each person\'s name beside the mention, looked up once', async () => {
    const createMessage = vi.fn(async () => true);
    const getUserName = vi.fn(async (id: string) => (id === '397613147483144192' ? 'Matt_*' : null));
    const serverLog = createServerLog({
      api: { createMessage, getUserName },
      scopes: new Set<ServerLogScope>(['moderation']),
      resolveChannel: async () => 'log',
      log: () => {},
      now: () => NOW,
    });
    // A ban: the person who did it heads the entry; anyone else in it is
    // named beside their mention.
    const ban = { id: 'a9', guild_id: 'g', action_type: 22, user_id: '111111111111111111', target_id: '397613147483144192' };
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', ban);
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', {
      ...ban,
      id: 'a10',
      user_id: '397613147483144192',
      target_id: '111111111111111111',
    });
    await serverLog.drain();
    type Posted = { embeds: { description: string; author?: { name: string }; timestamp?: string }[] };
    const first = (createMessage.mock.calls[0] as unknown[])[1] as Posted;
    expect(first.embeds[0]?.description).toContain('**On:** **Matt\\_\\*** (<@397613147483144192>)');
    // Unknown to Discord: no header, and the bare mention stays.
    expect(first.embeds[0]?.author).toBeUndefined();
    const second = (createMessage.mock.calls[1] as unknown[])[1] as Posted;
    expect(second.embeds[0]?.author?.name).toBe('Matt_*');
    expect(second.embeds[0]?.description).toContain('**By:** <@397613147483144192>');
    expect(second.embeds[0]?.timestamp).toBeTruthy();
    expect(getUserName).toHaveBeenCalledTimes(2);
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

describe('who deleted a message', () => {
  const recent = () => String((BigInt(Date.now() - 1420070400000) << 22n));

  async function deleteWith(audits: unknown) {
    const createMessage = vi.fn(async () => true);
    const listMessageDeleteAudits = vi.fn(async () => audits as never);
    const getUserName = vi.fn(async (id: string) => (id === 'mod' ? 'Mod' : 'Spammer'));
    const serverLog = createServerLog({
      api: { createMessage, getUserName, listMessageDeleteAudits },
      scopes: new Set<ServerLogScope>(['messages', 'content', 'moderation']),
      resolveChannel: async () => 'log',
      log: () => {},
      now: () => NOW,
      auditDelayMs: 0,
    });
    serverLog.onDispatch('MESSAGE_CREATE', created('d1', 'rude'));
    serverLog.onDispatch('MESSAGE_DELETE', { id: 'd1', guild_id: 'g', channel_id: 'general' });
    await serverLog.drain();
    const posted = (createMessage.mock.calls[0] as unknown[])[1] as {
      embeds: { description: string; author?: { name: string } }[];
    };
    return posted.embeds[0];
  }

  it("names the moderator who deleted somebody's message, from a fresh audit entry", async () => {
    const embed = await deleteWith([
      { id: recent(), userId: 'mod', targetId: 'spammer', channelId: 'general', count: 1 },
    ]);
    expect(embed?.author?.name).toBe('Mod');
    expect(embed?.description).toContain('**Deleted by:** <@mod>');
    expect(embed?.description).toContain('rude');
  });

  it('heads it with the author, naming nobody else, when there is no fresh entry', async () => {
    // An old entry for the same person and channel is somebody's earlier delete.
    const embed = await deleteWith([{ id: '1000', userId: 'mod', targetId: 'spammer', channelId: 'general', count: 1 }]);
    expect(embed?.author?.name).toBe('Spammer');
    expect(embed?.description).not.toContain('Deleted by');
  });

  it('still posts when the audit log cannot be read', async () => {
    const embed = await deleteWith(null);
    expect(embed?.description).toContain('rude');
  });
});

describe('role changes, stacked', () => {
  const roleChange = (id: string, target: string, changes: unknown[], user = 'mod') => ({
    id,
    guild_id: 'g',
    action_type: 25,
    user_id: user,
    target_id: target,
    changes,
  });
  const add = (...names: string[]) => ({ key: '$add', new_value: names.map((name) => ({ id: name, name })) });
  const remove = (...names: string[]) => ({ key: '$remove', new_value: names.map((name) => ({ id: name, name })) });

  function stacker() {
    const createMessage = vi.fn(async () => true);
    const serverLog = createServerLog({
      api: { createMessage },
      scopes: new Set<ServerLogScope>(['moderation']),
      resolveChannel: async () => 'log',
      log: () => {},
      now: () => NOW,
      stackMs: 60_000,
    });
    const posted = () =>
      createMessage.mock.calls.map((call) => ((call as unknown[])[1] as { embeds: { description: string }[] }).embeds[0]);
    return { serverLog, posted };
  }

  it("puts one member's changes in a burst into one entry, Added and Removed", async () => {
    const { serverLog, posted } = stacker();
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', roleChange('1', 'm', [add('Exec')]));
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', roleChange('2', 'm', [add('Coach'), remove('Land Crab')]));
    await serverLog.drain();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]?.description).toBe('<@m> **roles changed**\n**Added:** `Exec`, `Coach`\n**Removed:** `Land Crab`');
  });

  it('turns a mass removal into one entry listing the members', async () => {
    const { serverLog, posted } = stacker();
    for (const member of ['a', 'b', 'c']) {
      serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', roleChange(`r${member}`, member, [remove('Land Crab')]));
    }
    await serverLog.drain();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]?.description).toBe(
      "**3 members' roles changed**\n**Removed:** `Land Crab`\n\n**Members:** <@a>, <@b>, <@c>"
    );
  });

  it('lists each member when their changes differ, keeps separate people apart, and drops an undone change', async () => {
    const { serverLog, posted } = stacker();
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', roleChange('1', 'a', [add('Exec')]));
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', roleChange('2', 'b', [remove('Coach')]));
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', roleChange('3', 'c', [add('Exec')], 'other-mod'));
    serverLog.onDispatch('GUILD_AUDIT_LOG_ENTRY_CREATE', roleChange('4', 'c', [remove('Exec')], 'other-mod'));
    await serverLog.drain();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]?.description).toBe("**2 members' roles changed**\n\n<@a>: added `Exec`\n<@b>: removed `Coach`");
  });
});
