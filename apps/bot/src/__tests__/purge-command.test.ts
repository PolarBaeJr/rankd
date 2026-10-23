import { describe, it, expect, vi, beforeEach } from 'vitest';

// /purge: who may, what it skips (pinned, too old, other people's), and that
// it asks Discord for one delete call however many it takes.

const { listRecentMessages, deleteMessages, editDeferredReply } = vi.hoisted(() => ({
  listRecentMessages: vi.fn(),
  deleteMessages: vi.fn(),
  editDeferredReply: vi.fn(async () => true),
}));

vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  editDeferredReply,
  DiscordApi: class {
    listRecentMessages = listRecentMessages;
    deleteMessages = deleteMessages;
  },
}));

import * as commands from '../commands.js';
import { COMMAND_DEFINITIONS, dispatch, purgeTiming } from '../commands.js';

purgeTiming.gapMs = 0;
purgeTiming.startDelayMs = 0;

const MANAGE_MESSAGES = String(1n << 13n);
const DAY = 24 * 60 * 60 * 1000;

async function purge(
  options: { name: string; type: number; value: unknown }[],
  permissions = MANAGE_MESSAGES,
  deferred = true
) {
  const reply = (await dispatch('purge', options as never, {
    discordUserId: 'mod',
    guildId: 'g',
    channelId: 'c',
    permissions,
    ...(deferred ? { applicationId: 'app', interactionToken: 'tok' } : {}),
  } as never)) as unknown as { data: { content: string } };
  return reply.data.content;
}

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  authorId: 'a',
  at: Date.now() - 60_000,
  pinned: false,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'token';
  deleteMessages.mockResolvedValue('ok');
});

describe('/purge', () => {
  it('is hidden from people without Manage Messages, and refuses them anyway', async () => {
    const definition = COMMAND_DEFINITIONS.find((c) => c.name === 'purge') as { default_member_permissions?: string };
    expect(definition.default_member_permissions).toBe(MANAGE_MESSAGES);
    expect(await purge([{ name: 'count', type: 4, value: 5 }], '0')).toContain('Manage Messages');
    expect(listRecentMessages).not.toHaveBeenCalled();
  });

  it('deletes the latest N, keeping pinned ones and leaving ones Discord will not bulk delete', async () => {
    listRecentMessages.mockResolvedValue([
      message('1'),
      message('2', { pinned: true }),
      message('3'),
      message('4', { at: Date.now() - 20 * DAY }),
      message('5'),
    ]);
    const reply = await purge([{ name: 'count', type: 4, value: 3 }]);
    expect(deleteMessages).toHaveBeenCalledWith('c', ['1', '3'], 'Purge by mod');
    expect(reply).toContain('Deleted 2 messages.');
    expect(reply).toContain('1 older than 14 days was left');
  });

  it("deletes only one person's when a member is picked", async () => {
    listRecentMessages.mockResolvedValue([message('1', { authorId: 'b' }), message('2'), message('3', { authorId: 'b' })]);
    const reply = await purge([
      { name: 'count', type: 4, value: 10 },
      { name: 'member', type: 6, value: 'b' },
    ]);
    expect(deleteMessages).toHaveBeenCalledWith('c', ['1', '3'], 'Purge by mod');
    expect(reply).toContain('Deleted 2 messages from <@b>.');
  });

  it('says what is missing when Discord refuses', async () => {
    listRecentMessages.mockResolvedValue([message('1')]);
    deleteMessages.mockResolvedValue('forbidden');
    expect(await purge([{ name: 'count', type: 4, value: 1 }])).toContain('I need **Manage Messages**');
  });

  it('with include_old, bulk deletes the recent ones, then the old ones one at a time, and edits the reply', async () => {
    listRecentMessages.mockResolvedValue([message('1'), message('old1', { at: Date.now() - 20 * DAY }), message('old2', { at: Date.now() - 30 * DAY })]);
    const reply = await purge([
      { name: 'count', type: 4, value: 10 },
      { name: 'include_old', type: 5, value: true },
    ]);
    expect(reply).toContain('Now deleting 2 older ones one at a time');
    await commands.lastOldPurge;
    expect(deleteMessages.mock.calls.map((call) => call[1])).toEqual([['1'], ['old1'], ['old2']]);
    const final = (editDeferredReply.mock.calls.at(-1) as unknown[])[2] as { content: string };
    expect(final.content).toBe('Done: deleted 3 messages, 2 of them older than 14 days.');
  });

  it('with include_old and only old ones, makes no bulk call, and stops when refused', async () => {
    listRecentMessages.mockResolvedValue([message('old1', { at: Date.now() - 20 * DAY }), message('old2', { at: Date.now() - 30 * DAY })]);
    deleteMessages.mockResolvedValue('forbidden');
    await purge([
      { name: 'count', type: 4, value: 10 },
      { name: 'include_old', type: 5, value: true },
    ]);
    await commands.lastOldPurge;
    expect(deleteMessages).toHaveBeenCalledTimes(1);
    const final = (editDeferredReply.mock.calls.at(-1) as unknown[])[2] as { content: string };
    expect(final.content).toContain('2 could not be deleted: check I still have **Manage Messages**');
  });
});
