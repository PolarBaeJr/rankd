import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RULES,
  STRIKE_MS,
  SprayTracker,
  createScamGuard,
  type GuardRules,
  fingerprint,
  matchWord,
  isModerator,
  isSuspect,
  readMessage,
  type ScamMessage,
} from '../scam-guard.js';
import { intentsFor, parseServerLogScopes } from '../server-log.js';
import type { ServerLogEntry } from '../server-log.js';

const WINDOW_MS = DEFAULT_RULES.windowMinutes * 60_000;
const BAIT = 'Gifting free stuff to the first 5 people, DM me!';
const PHOTOS = [
  { size: 48211, content_type: 'image/png' },
  { size: 50133, content_type: 'image/png' },
];

let nextId = 0;
const raw = (channel: string, extra: Record<string, unknown> = {}) => ({
  id: `m${(nextId += 1)}`,
  guild_id: 'club',
  channel_id: channel,
  author: { id: 'hacked' },
  member: { roles: [] },
  content: BAIT,
  attachments: PHOTOS,
  ...extra,
});

function message(channel: string, extra: Record<string, unknown> = {}): ScamMessage {
  const read = readMessage(raw(channel, extra));
  if (!read) throw new Error('fixture did not parse');
  return read;
}

describe('scam scope', () => {
  it('switches on the messages and content it reads, and adds no intent of its own', () => {
    const { scopes } = parseServerLogScopes('scam');
    expect([...scopes].sort()).toEqual(['content', 'messages', 'scam']);
    expect(intentsFor(scopes)).toBe((1 << 9) | (1 << 15));
  });
});

describe('fingerprint', () => {
  it('ignores case, punctuation and mentions, so a light reword is still the same post', () => {
    const a = fingerprint({
      text: 'Gifting FREE stuff!! <@123> dm me',
      attachments: [],
    });
    const b = fingerprint({
      text: 'gifting free stuff dm me',
      attachments: [],
    });
    expect(a).toBe(b);
  });

  it('carries image-only posts by their attachments', () => {
    expect(fingerprint({ text: '', attachments: [{ size: 10, type: 'image/png' }] })).toBe('|10:image/png');
  });

  it('is null for a short text with nothing attached', () => {
    expect(fingerprint({ text: 'hi all', attachments: [] })).toBeNull();
  });
});

describe('isSuspect', () => {
  it('flags a giveaway with pictures, a link or crypto words', () => {
    expect(
      isSuspect({
        text: BAIT,
        attachments: [
          { size: 1, type: 'a' },
          { size: 2, type: 'b' },
        ],
      })
    ).toBe(true);
    expect(isSuspect({ text: 'free nitro https://example.test', attachments: [] })).toBe(true);
    expect(isSuspect({ text: 'giving away my bitcoin profits', attachments: [] })).toBe(true);
  });

  it('leaves an ordinary post alone, even one about free things', () => {
    expect(
      isSuspect({
        text: 'Free play on Friday, bring a racket',
        attachments: [],
      })
    ).toBe(false);
    expect(
      isSuspect({
        text: 'check out my new racket',
        attachments: [
          { size: 1, type: 'a' },
          { size: 2, type: 'b' },
        ],
      })
    ).toBe(false);
  });
});

describe('isModerator', () => {
  const roles = [
    { id: 'mod', name: 'Mod', position: 5, permissions: String(1n << 13n) },
    { id: 'member', name: 'Member', position: 1, permissions: '0' },
  ];
  it('is true for a role with Manage Messages, false for a plain one', () => {
    expect(isModerator(['mod'], roles)).toBe(true);
    expect(isModerator(['member'], roles)).toBe(false);
    expect(isModerator([], roles)).toBe(false);
  });
});

describe('SprayTracker', () => {
  it('calls the same post in three channels a spray', () => {
    const tracker = new SprayTracker();
    const plain = {
      content: 'join my server for exclusive deals today',
      attachments: [],
    };
    expect(tracker.verdict(message('a', plain), 0).kind).toBe('none');
    expect(tracker.verdict(message('b', plain), 1000).kind).toBe('none');
    expect(tracker.verdict(message('c', plain), 2000)).toMatchObject({
      kind: 'spray',
      channels: 3,
    });
  });

  it('calls a giveaway with pictures in two channels a spray', () => {
    const tracker = new SprayTracker();
    expect(tracker.verdict(message('a'), 0).kind).toBe('suspect');
    expect(tracker.verdict(message('b'), 1000)).toMatchObject({
      kind: 'spray',
      channels: 2,
    });
  });

  it("follows the server's own channel count and window", () => {
    const tracker = new SprayTracker();
    const plain = { content: 'join my server for exclusive deals today', attachments: [] };
    const strict = { ...DEFAULT_RULES, channels: 2, windowMinutes: 10 };
    expect(tracker.verdict(message('a', plain), 0, strict).kind).toBe('none');
    // Eight minutes later: outside the default window, inside this one.
    expect(tracker.verdict(message('b', plain), 8 * 60_000, strict)).toMatchObject({ kind: 'spray', channels: 2 });
    const loose = { ...DEFAULT_RULES, channels: 5 };
    const other = new SprayTracker();
    for (const channel of ['a', 'b', 'c', 'd']) {
      expect(other.verdict(message(channel, plain), 0, loose).kind).toBe('none');
    }
    expect(other.verdict(message('e', plain), 0, loose).kind).toBe('spray');
  });

  it('hands back every copy, so a timeout can delete them', () => {
    const tracker = new SprayTracker();
    tracker.verdict(message('a', { id: 'first' }), 0);
    const verdict = tracker.verdict(message('b', { id: 'second' }), 1000);
    expect(verdict.kind === 'spray' && verdict.copies).toEqual([
      { channelId: 'a', messageId: 'first' },
      { channelId: 'b', messageId: 'second' },
    ]);
  });

  it('does not count one channel twice, or posts outside the window', () => {
    const tracker = new SprayTracker();
    const plain = {
      content: 'join my server for exclusive deals today',
      attachments: [],
    };
    tracker.verdict(message('a', plain), 0);
    tracker.verdict(message('a', plain), 500);
    tracker.verdict(message('b', plain), WINDOW_MS + 1000);
    expect(tracker.verdict(message('c', plain), WINDOW_MS + 1001).kind).toBe('none');
  });

  it('keeps accounts apart', () => {
    const tracker = new SprayTracker();
    const plain = {
      content: 'join my server for exclusive deals today',
      attachments: [],
    };
    tracker.verdict(message('a', { ...plain, author: { id: 'one' } }), 0);
    tracker.verdict(message('b', { ...plain, author: { id: 'two' } }), 0);
    expect(tracker.verdict(message('c', { ...plain, author: { id: 'three' } }), 0).kind).toBe('none');
  });
});

describe('matchWord', () => {
  it('matches whole words and phrases, ignoring case, and not inside other words', () => {
    expect(matchWord('Get FREE Nitro here', ['nitro'])).toBe('nitro');
    expect(matchWord('free steam keys!', ['steam keys'])).toBe('steam keys');
    expect(matchWord('my nitrogen tank', ['nitro'])).toBeNull();
    expect(matchWord('anything', [])).toBeNull();
    expect(matchWord('a.b c', ['a.b'])).toBe('a.b');
    expect(matchWord('axb c', ['a.b'])).toBeNull();
  });
});

describe('readMessage', () => {
  it('skips bots, webhooks and DMs', () => {
    expect(readMessage(raw('a', { author: { id: 'x', bot: true } }))).toBeNull();
    expect(readMessage(raw('a', { webhook_id: 'w' }))).toBeNull();
    expect(readMessage(raw('a', { guild_id: undefined }))).toBeNull();
  });
});

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    getBotUserId: vi.fn(async () => 'bot'),
    getGuildOwnerId: vi.fn(async () => 'owner'),
    listGuildRoles: vi.fn(async () => [
      { id: 'mod', name: 'Mod', position: 5, permissions: String(1n << 2n) },
      { id: 'member', name: 'Member', position: 1, permissions: '0' },
      { id: 'top', name: 'Top', position: 9, permissions: '0' },
    ]),
    getOwnRolePosition: vi.fn(async () => 8),
    banMember: vi.fn(async () => 'ok' as const),
    unbanMember: vi.fn(async () => 'ok' as const),
    timeoutMember: vi.fn(async () => 'ok' as const),
    deleteMessage: vi.fn(async () => true),
    ...overrides,
  };
}

function guardWith(api: ReturnType<typeof fakeApi>, servers = ['club'], rules: Partial<GuardRules> = {}) {
  const reports: { guildId: string; entry: ServerLogEntry }[] = [];
  const trapCatches: { channelId: string; action: string }[] = [];
  const clock = { at: Date.parse('2026-10-22T18:00:00Z') };
  const guard = createScamGuard({
    api,
    rulesFor: async (guildId) => (servers.includes(guildId) ? { ...DEFAULT_RULES, ...rules } : null),
    report: (guildId, entry) => reports.push({ guildId, entry }),
    onTrapCaught: (_guildId, channelId, action) => trapCatches.push({ channelId, action }),
    log: () => {},
    now: () => new Date((clock.at += 1000)),
    sleep: async () => {},
  });
  return { guard, reports, clock, trapCatches };
}

const outcome = (reports: { entry: ServerLogEntry }[]) => reports.at(-1)?.entry.embed.fields?.[0]?.value ?? '';

describe('createScamGuard', () => {
  it('times a first spray out, once, deletes its copies, and reports it', async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api);
    for (const channel of ['a', 'b', 'c', 'd']) guard.onMessage(raw(channel));
    await guard.drain();
    expect(api.timeoutMember).toHaveBeenCalledTimes(1);
    const [, who, until, reason] = api.timeoutMember.mock.calls[0] as unknown as [string, string, Date, string];
    expect(who).toBe('hacked');
    expect(until.getTime() - Date.parse('2026-10-22T18:00:00Z')).toBe(2000 + 60 * 60_000);
    expect(reason).toContain('Auto mod');
    expect(api.banMember).not.toHaveBeenCalled();
    // The two copies the verdict saw, then the two that were already on their way.
    expect(api.deleteMessage).toHaveBeenCalledTimes(4);
    const titles = reports.map((r) => r.entry.embed.title);
    expect(titles).toEqual(['Auto mod: possible scam post (no action taken)', 'Auto mod caught a spray']);
    expect(outcome(reports)).toMatch(/^Timed out for 1 hour .*soft-banned/);
  });

  it('soft-bans the same account spraying again within a day, and not after', async () => {
    const api = fakeApi();
    const { guard, reports, clock } = guardWith(api);
    for (const channel of ['a', 'b']) guard.onMessage(raw(channel));
    await guard.drain();
    clock.at += 2 * 3_600_000;
    for (const channel of ['a', 'b']) guard.onMessage(raw(channel));
    await guard.drain();
    expect(api.banMember).toHaveBeenCalledTimes(1);
    expect(api.banMember).toHaveBeenCalledWith('club', 'hacked', 3600, expect.stringContaining('again after a timeout'));
    expect(outcome(reports)).toMatch(/^Caught again after a timeout, so soft-banned/);

    const later = fakeApi();
    const second = guardWith(later);
    for (const channel of ['a', 'b']) second.guard.onMessage(raw(channel));
    await second.guard.drain();
    second.clock.at += STRIKE_MS + 60_000;
    for (const channel of ['a', 'b']) second.guard.onMessage(raw(channel));
    await second.guard.drain();
    expect(later.banMember).not.toHaveBeenCalled();
    expect(later.timeoutMember).toHaveBeenCalledTimes(2);
  });

  it('does what the server chose: soft-ban at once, timeout only, or only flag', async () => {
    const softbanApi = fakeApi();
    const softban = guardWith(softbanApi, ['club'], { action: 'softban' });
    for (const channel of ['a', 'b']) softban.guard.onMessage(raw(channel));
    await softban.guard.drain();
    expect(softbanApi.banMember).toHaveBeenCalledTimes(1);
    expect(softbanApi.timeoutMember).not.toHaveBeenCalled();
    expect(outcome(softban.reports)).toMatch(/^soft-banned/);

    const timeoutApi = fakeApi();
    const timeoutOnly = guardWith(timeoutApi, ['club'], { action: 'timeout', timeoutMinutes: 30 });
    for (const channel of ['a', 'b']) timeoutOnly.guard.onMessage(raw(channel));
    await timeoutOnly.guard.drain();
    timeoutOnly.clock.at += 3_600_000;
    for (const channel of ['a', 'b']) timeoutOnly.guard.onMessage(raw(channel));
    await timeoutOnly.guard.drain();
    expect(timeoutApi.timeoutMember).toHaveBeenCalledTimes(2);
    expect(timeoutApi.banMember).not.toHaveBeenCalled();
    expect(outcome(timeoutOnly.reports)).toMatch(/^Timed out for 30 minutes/);
    expect(outcome(timeoutOnly.reports)).not.toMatch(/soft-banned/);

    const flagApi = fakeApi();
    const flag = guardWith(flagApi, ['club'], { action: 'flag' });
    for (const channel of ['a', 'b']) flag.guard.onMessage(raw(channel));
    await flag.guard.drain();
    expect(flagApi.timeoutMember).not.toHaveBeenCalled();
    expect(flagApi.banMember).not.toHaveBeenCalled();
    expect(flagApi.deleteMessage).not.toHaveBeenCalled();
    expect(outcome(flag.reports)).toMatch(/^No action taken: this server only flags/);
  });

  it('says what is missing when Discord refuses the timeout', async () => {
    const api = fakeApi({ timeoutMember: vi.fn(async () => 'forbidden' as const) });
    const { guard, reports } = guardWith(api);
    for (const channel of ['a', 'b']) guard.onMessage(raw(channel));
    await guard.drain();
    expect(outcome(reports)).toMatch(/Moderate Members/);
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it('never acts in a server that has not switched it on', async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api, ['other']);
    for (const channel of ['a', 'b', 'c']) guard.onMessage(raw(channel));
    await guard.drain();
    expect(api.timeoutMember).not.toHaveBeenCalled();
    expect(api.banMember).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it('leaves moderators and the owner alone', async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api);
    for (const channel of ['a', 'b', 'c']) guard.onMessage(raw(channel, { member: { roles: ['mod'] } }));
    for (const channel of ['a', 'b', 'c']) guard.onMessage(raw(channel, { author: { id: 'owner' } }));
    await guard.drain();
    expect(api.timeoutMember).not.toHaveBeenCalled();
    expect(api.banMember).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it('reports instead of acting on someone ranked at or above the bot', async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api);
    for (const channel of ['a', 'b']) guard.onMessage(raw(channel, { member: { roles: ['top'] } }));
    await guard.drain();
    expect(api.timeoutMember).not.toHaveBeenCalled();
    expect(api.banMember).not.toHaveBeenCalled();
    expect(outcome(reports)).toMatch(/at or above mine/);
  });

  it('says so loudly when the unban never lands', async () => {
    const api = fakeApi({ unbanMember: vi.fn(async () => 'failed' as const) });
    const { guard, reports } = guardWith(api, ['club'], { action: 'softban' });
    for (const channel of ['a', 'b']) guard.onMessage(raw(channel));
    await guard.drain();
    expect(api.unbanMember).toHaveBeenCalledTimes(3);
    expect(outcome(reports)).toMatch(/still BANNED/);
  });

  it('only flags a lone giveaway post', async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api);
    guard.onMessage(raw('a'));
    guard.onMessage(
      raw('a', {
        content: 'unrelated chatter about the next session',
        attachments: [],
      })
    );
    await guard.drain();
    expect(api.timeoutMember).not.toHaveBeenCalled();
    expect(api.banMember).not.toHaveBeenCalled();
    expect(reports.map((r) => r.entry.embed.title)).toEqual(['Auto mod: possible scam post (no action taken)']);
  });

  it('catches any post in a trap channel, deleting it, and deletes later ones too', async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api, ['club'], { trapChannelIds: ['trap'], trapAction: 'timeout_then_softban' });
    guard.onMessage(raw('trap', { content: 'hello', attachments: [] }));
    await guard.drain();
    guard.onMessage(raw('trap', { content: 'hello again', attachments: [] }));
    await guard.drain();
    expect(api.timeoutMember).toHaveBeenCalledTimes(1);
    expect(api.deleteMessage).toHaveBeenCalledTimes(2);
    expect(reports.map((r) => r.entry.embed.title)).toEqual(['Auto mod: post in a trap channel']);
    expect(outcome(reports)).toMatch(/^Timed out for 1 hour and the post is deleted/);
  });

  it("leaves a moderator's post in a trap channel alone", async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api, ['club'], { trapChannelIds: ['trap'] });
    guard.onMessage(raw('trap', { member: { roles: ['mod'] } }));
    await guard.drain();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it("deletes a post with one of the server's words, or punishes, or only flags, as chosen", async () => {
    const chatter = { content: 'anyone want free nitro', attachments: [] };
    const deleteApi = fakeApi();
    const deleting = guardWith(deleteApi, ['club'], { words: ['nitro'] });
    deleting.guard.onMessage(raw('a', chatter));
    await deleting.guard.drain();
    expect(deleteApi.deleteMessage).toHaveBeenCalledWith('a', expect.any(String));
    expect(deleteApi.timeoutMember).not.toHaveBeenCalled();
    expect(deleting.reports.map((r) => [r.entry.embed.title, r.entry.embed.fields?.[0]?.value])).toEqual([
      ['Auto mod: blocked word', 'Deleted.'],
    ]);

    const punishApi = fakeApi();
    const punishing = guardWith(punishApi, ['club'], { words: ['nitro'], wordsAction: 'punish' });
    punishing.guard.onMessage(raw('a', chatter));
    await punishing.guard.drain();
    expect(punishApi.deleteMessage).toHaveBeenCalledTimes(1);
    expect(punishApi.timeoutMember).toHaveBeenCalledTimes(1);

    const flagApi = fakeApi();
    const flagging = guardWith(flagApi, ['club'], { words: ['nitro'], wordsAction: 'flag' });
    flagging.guard.onMessage(raw('a', chatter));
    await flagging.guard.drain();
    expect(flagApi.deleteMessage).not.toHaveBeenCalled();
    expect(outcome(flagging.reports)).toMatch(/only flags its words/);
  });

  it('does nothing about a spray or a giveaway post when those rules are off', async () => {
    const api = fakeApi();
    const { guard, reports } = guardWith(api, ['club'], { spray: false, flagSuspects: false });
    for (const channel of ['a', 'b', 'c', 'd']) guard.onMessage(raw(channel));
    await guard.drain();
    expect(api.timeoutMember).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it('soft-bans a post in a trap channel by default, whatever the other catches get, and counts it', async () => {
    const api = fakeApi();
    const { guard, reports, trapCatches } = guardWith(api, ['club'], { trapChannelIds: ['trap'], action: 'timeout' });
    guard.onMessage(raw('trap', { content: 'hello', attachments: [] }));
    await guard.drain();
    expect(api.banMember).toHaveBeenCalledTimes(1);
    expect(api.timeoutMember).not.toHaveBeenCalled();
    expect(outcome(reports)).toMatch(/^soft-banned/);
    expect(trapCatches).toEqual([{ channelId: 'trap', action: 'softban' }]);
  });

  it('does not count a trap catch that came to nothing', async () => {
    const api = fakeApi({ banMember: vi.fn(async () => 'forbidden' as const) });
    const { guard, trapCatches } = guardWith(api, ['club'], { trapChannelIds: ['trap'] });
    guard.onMessage(raw('trap', { content: 'hello', attachments: [] }));
    await guard.drain();
    expect(trapCatches).toEqual([]);
  });
});
