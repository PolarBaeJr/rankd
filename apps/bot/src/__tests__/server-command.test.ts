import { describe, it, expect, vi, beforeEach } from 'vitest';

// /server: a server's own settings (00302). What is pinned is who may, and that
// every write names the server it was typed in and nothing else.

const { fetchServerSettings, writeServerSettings, checkDiscordManager } = vi.hoisted(() => ({
  fetchServerSettings: vi.fn(),
  writeServerSettings: vi.fn(),
  checkDiscordManager: vi.fn(),
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

import { COMMAND_DEFINITIONS, canManageServer, dispatch } from '../commands.js';

const MANAGE_SERVER = String(1n << 5n);
const CHANNEL = '123456789012345678';

async function run(
  sub: string,
  args: { name: string; type: number; value: unknown }[] = [],
  context: Record<string, unknown> = {}
) {
  const reply = (await dispatch('server', [{ name: sub, type: 1, options: args }] as never, {
    discordUserId: '42',
    guildId: 'theirs',
    permissions: MANAGE_SERVER,
    ...context,
  } as never)) as unknown as { data: { content: string } };
  return reply.data.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchServerSettings.mockResolvedValue({ servers: [] });
  writeServerSettings.mockResolvedValue({ ok: true });
  checkDiscordManager.mockResolvedValue(null);
});

describe('/server definition', () => {
  it('is for server admins and never in DMs', () => {
    const definition = COMMAND_DEFINITIONS.find((c) => c.name === 'server') as Record<string, unknown>;
    expect(definition.default_member_permissions).toBe('32');
    expect(definition.dm_permission).toBe(false);
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

describe('/server in somebody else\'s server', () => {
  it('lets their admin set the log, for that server only, with no club account', async () => {
    const reply = await run('log', [{ name: 'channel', type: 7, value: CHANNEL }]);
    expect(writeServerSettings).toHaveBeenCalledWith(
      { discordUserId: '42', guildId: 'theirs' },
      { serverLogChannelId: CHANNEL }
    );
    expect(checkDiscordManager).not.toHaveBeenCalled();
    expect(reply).toContain(`<#${CHANNEL}>`);
  });

  it('switches the scam guard on and off', async () => {
    await run('scam_guard', [{ name: 'enabled', type: 5, value: true }]);
    await run('scam_guard', [{ name: 'enabled', type: 5, value: false }]);
    expect(writeServerSettings.mock.calls.map((call) => call[1])).toEqual([{ scamGuard: true }, { scamGuard: false }]);
  });

  it('refuses somebody without Manage Server, even if the command was opened to them', async () => {
    const reply = await run('log_off', [], { permissions: '0' });
    expect(reply).toContain('Manage Server');
    expect(writeServerSettings).not.toHaveBeenCalled();
  });
});

describe('/server in a club server', () => {
  it('also needs the club check before it writes anything', async () => {
    checkDiscordManager.mockResolvedValue('not_linked');
    const reply = await run('scam_guard', [{ name: 'enabled', type: 5, value: false }], { guildId: 'club' });
    expect(checkDiscordManager).toHaveBeenCalledWith({ discordUserId: '42', guildId: 'club' });
    expect(writeServerSettings).not.toHaveBeenCalled();
    expect(reply).toContain('/link');
  });

  it('writes once the club check passes', async () => {
    await run('log_off', [], { guildId: 'club' });
    expect(writeServerSettings).toHaveBeenCalledWith({ discordUserId: '42', guildId: 'club' }, { serverLogChannelId: null });
  });
});

describe('/server show', () => {
  it("reads this server's row and no other", async () => {
    fetchServerSettings.mockResolvedValue({
      servers: [
        { guildId: 'club', serverLogChannelId: '111111111111111111', scamGuard: true },
        { guildId: 'theirs', serverLogChannelId: null, scamGuard: false },
      ],
    });
    const reply = await run('show');
    expect(reply).toContain('**Server log:** off');
    expect(reply).toContain('**Scam guard:** off');
    expect(reply).not.toContain('111111111111111111');
  });
});
