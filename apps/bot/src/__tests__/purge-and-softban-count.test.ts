import { describe, it, expect, vi } from 'vitest';
import { recallPurge, rememberPurge } from '../purge-memory.js';
import { banThenUnban, onSoftBan } from '../moderation.js';
import { describeDispatch, MessageCache } from '../server-log.js';

// A /purge is logged by Discord under the bot; the log names who ran it.
// Every soft ban that lands is announced, so the trap warning can count it.

describe('purge attribution', () => {
  it('remembers who purged a channel for a few minutes', () => {
    rememberPurge('c1', 'mod', 1_000);
    expect(recallPurge('c1', 1_000 + 60_000)).toBe('mod');
    expect(recallPurge('c1', 1_000 + 6 * 60_000)).toBeNull();
    expect(recallPurge('other', 1_000)).toBeNull();
  });

  it('logs the bot\'s bulk delete as by whoever purged, in the channel', () => {
    rememberPurge('chan', 'mod');
    const entry = describeDispatch(
      'GUILD_AUDIT_LOG_ENTRY_CREATE',
      { id: 'a1', guild_id: 'g', action_type: 73, user_id: 'bot', target_id: 'chan', options: { count: '10' } },
      { cache: new MessageCache(), scopes: new Set(['moderation']), logChannelId: 'log', now: new Date() } as never
    );
    expect(entry?.embed.description).toContain('**By:** <@mod>');
    expect(entry?.embed.description).toContain('**In:** <#chan>');
    expect(entry?.actorId).toBe('mod');
  });
});

describe('soft ban listener', () => {
  it('fires once the ban lands, and not when it is refused', async () => {
    const heard: string[] = [];
    onSoftBan((guildId) => heard.push(guildId));
    const api = { banMember: vi.fn(async () => 'ok' as const), unbanMember: vi.fn(async () => 'ok' as const) };
    await banThenUnban(api, { guildId: 'g1', targetId: 'u', deleteSeconds: 0, reason: 'r', liftReason: 'l', sleep: async () => {} });
    const refused = { banMember: vi.fn(async () => 'forbidden' as const), unbanMember: vi.fn(async () => 'ok' as const) };
    await banThenUnban(refused, { guildId: 'g2', targetId: 'u', deleteSeconds: 0, reason: 'r', liftReason: 'l', sleep: async () => {} });
    expect(heard).toEqual(['g1']);
  });
});
