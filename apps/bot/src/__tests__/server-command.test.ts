import { describe, it, expect, vi, beforeEach } from 'vitest';

// /config server_log and /config scam_guard: a server's own settings (00302).
// What is pinned is who may, that every write names the server it was typed
// in and nothing else, and that a server outside the club gets only these.

const { fetchServerSettings, writeServerSettings, checkDiscordManager, createMessage } = vi.hoisted(() => ({
  fetchServerSettings: vi.fn(),
  writeServerSettings: vi.fn(),
  checkDiscordManager: vi.fn(),
  createMessage: vi.fn(),
}));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchServerSettings,
  writeServerSettings,
  checkDiscordManager,
}));

// 'club' is one of the club's servers; 'theirs' is somebody else's.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig: async () => ({ registry: new Map([['club', {}]]), auditChannelId: undefined }),
}));

vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    createMessage = createMessage;
  },
}));

import { COMMAND_DEFINITIONS, canManageServer, dispatch } from '../commands.js';

const MANAGE_SERVER = String(1n << 5n);
const CHANNEL = '123456789012345678';

interface Reply {
  data: { content?: string; embeds?: { description?: string }[] };
}

async function run(
  sub: string,
  args: { name: string; type: number; value: unknown }[] = [],
  context: Record<string, unknown> = {}
) {
  const reply = (await dispatch('config', [{ name: sub, type: 1, options: args }] as never, {
    discordUserId: '42',
    guildId: 'theirs',
    permissions: MANAGE_SERVER,
    ...context,
  } as never)) as unknown as Reply;
  return reply.data.content ?? reply.data.embeds?.[0]?.description ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'token';
  fetchServerSettings.mockResolvedValue({ servers: [] });
  writeServerSettings.mockResolvedValue({ ok: true });
  checkDiscordManager.mockResolvedValue(null);
  createMessage.mockResolvedValue(true);
});

describe('/config definition', () => {
  it('carries the per-server settings, and there is no separate /server', () => {
    const config = COMMAND_DEFINITIONS.find((c) => c.name === 'config') as { options: { name: string }[] };
    expect(config.options.map((o) => o.name)).toEqual(expect.arrayContaining(['server_log', 'scam_guard']));
    expect(COMMAND_DEFINITIONS.find((c) => c.name === 'server')).toBeUndefined();
  });
});

describe('canManageServer', () => {
  it('needs Manage Server or Administrator, and a missing mask is no', () => {
    expect(canManageServer(MANAGE_SERVER)).toBe(true);
    expect(canManageServer(String(1n << 3n))).toBe(true);
    expect(canManageServer('0')).toBe(false);
    expect(canManageServer(null)).toBe(false);
    expect(canManageServer('junk')).toBe(false);
  });
});

describe("/config in somebody else's server", () => {
  it('lets their admin set the log once a post there works, with no club account', async () => {
    const reply = await run('server_log', [{ name: 'channel', type: 7, value: CHANNEL }]);
    expect(createMessage).toHaveBeenCalledWith(CHANNEL, expect.anything());
    expect(writeServerSettings).toHaveBeenCalledWith(
      { discordUserId: '42', guildId: 'theirs' },
      { serverLogChannelId: CHANNEL }
    );
    expect(checkDiscordManager).not.toHaveBeenCalled();
    expect(reply).toContain(`<#${CHANNEL}>`);
  });

  it('saves nothing when the bot cannot post in the channel', async () => {
    createMessage.mockResolvedValue(false);
    await run('server_log', [{ name: 'channel', type: 7, value: CHANNEL }]);
    expect(writeServerSettings).not.toHaveBeenCalled();
  });

  it('turns the log off and the scam guard on and off', async () => {
    await run('server_log', [{ name: 'off', type: 5, value: true }]);
    await run('scam_guard', [{ name: 'enabled', type: 5, value: true }]);
    await run('scam_guard', [{ name: 'enabled', type: 5, value: false }]);
    expect(writeServerSettings.mock.calls.map((call) => call[1])).toEqual([
      { serverLogChannelId: null },
      { scamGuard: true },
      { scamGuard: false },
    ]);
  });

  it('refuses somebody without Manage Server, even if the command was opened to them', async () => {
    const reply = await run('server_log', [{ name: 'off', type: 5, value: true }], { permissions: '0' });
    expect(reply).toContain('Manage Server');
    expect(writeServerSettings).not.toHaveBeenCalled();
  });

  it("refuses the club's own setup there, and show lists only this server", async () => {
    expect(await run('channels')).toContain("the club's setup");
    fetchServerSettings.mockResolvedValue({
      servers: [
        { guildId: 'club', serverLogChannelId: '111111111111111111', scamGuard: true },
        { guildId: 'theirs', serverLogChannelId: null, scamGuard: false },
      ],
    });
    const shown = await run('show');
    expect(shown).toContain('**Scam guard**: off');
    expect(shown).not.toContain('111111111111111111');
    expect(checkDiscordManager).not.toHaveBeenCalled();
  });
});

describe('/config in a club server', () => {
  it('also needs the club check before it writes anything', async () => {
    checkDiscordManager.mockResolvedValue('not_linked');
    const reply = await run('scam_guard', [{ name: 'enabled', type: 5, value: false }], { guildId: 'club' });
    expect(checkDiscordManager).toHaveBeenCalledWith({ discordUserId: '42', guildId: 'club' });
    expect(writeServerSettings).not.toHaveBeenCalled();
    expect(reply).toContain('/link');
  });

  it('writes once the club check passes', async () => {
    await run('server_log', [{ name: 'off', type: 5, value: true }], { guildId: 'club' });
    expect(writeServerSettings).toHaveBeenCalledWith({ discordUserId: '42', guildId: 'club' }, { serverLogChannelId: null });
  });
});
