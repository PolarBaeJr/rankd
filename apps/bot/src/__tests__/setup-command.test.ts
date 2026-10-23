import { describe, it, expect, vi, beforeEach } from 'vitest';

// /setup in two kinds of server. Pinned: any server's admin can set their own
// server up with no club account and without touching the club's records; a
// club server (or one being connected with club:True) still needs the club
// check before any role is made, and gets the club checklist on top.

const api = vi.hoisted(() => ({
  checkDiscordManager: vi.fn(),
  writeGuildConfig: vi.fn(),
  writeServerRoleCatalog: vi.fn(),
  fetchDiscordSettings: vi.fn(),
  fetchServerSettings: vi.fn(),
  writeServerSettings: vi.fn(),
}));
const discord = vi.hoisted(() => ({
  getOwnRolePosition: vi.fn(),
  listGuildRoles: vi.fn(),
  createGuildRole: vi.fn(),
  createMessage: vi.fn(),
  getOwnPermissions: vi.fn(),
}));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  ...api,
}));

// 'club' is the club's main server; 'theirs' is somebody else's.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig: async () => ({ registry: new Map([['club', {}]]), auditChannelId: undefined }),
}));

vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    getOwnRolePosition = discord.getOwnRolePosition;
    listGuildRoles = discord.listGuildRoles;
    createGuildRole = discord.createGuildRole;
    createMessage = discord.createMessage;
    getOwnPermissions = discord.getOwnPermissions;
  },
}));

import { dispatch } from '../commands.js';

const MANAGE_SERVER = String(1n << 5n);
const LOG = '123456789012345678';

async function setup(args: { name: string; type: number; value: unknown }[], context: Record<string, unknown> = {}) {
  const reply = (await dispatch('setup', args as never, {
    discordUserId: '42',
    guildId: 'theirs',
    permissions: MANAGE_SERVER,
    ...context,
  } as never)) as unknown as { data: { content?: string; embeds?: { title?: string; description?: string }[] } };
  return { title: reply.data.embeds?.[0]?.title ?? '', text: reply.data.content ?? reply.data.embeds?.[0]?.description ?? '' };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'token';
  api.checkDiscordManager.mockResolvedValue(null);
  api.writeGuildConfig.mockResolvedValue({ ok: true });
  api.writeServerRoleCatalog.mockResolvedValue({ ok: true });
  api.fetchDiscordSettings.mockResolvedValue({ settings: {} });
  api.fetchServerSettings.mockResolvedValue({ servers: [] });
  api.writeServerSettings.mockResolvedValue({ ok: true });
  discord.getOwnRolePosition.mockResolvedValue(50);
  discord.listGuildRoles.mockResolvedValue([]);
  discord.createGuildRole.mockImplementation(async (_guild: string, name: string) => ({ id: `r-${name}`, name }));
  discord.createMessage.mockResolvedValue(true);
  // Everything but Ban Members.
  discord.getOwnPermissions.mockResolvedValue((1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 7n) | (1n << 28n));
});

describe("/setup in somebody else's server", () => {
  it('sets their log and scam guard with no club account, and makes no club roles', async () => {
    const { title, text } = await setup([
      { name: 'server_log', type: 7, value: LOG },
      { name: 'scam_guard', type: 5, value: true },
    ]);
    expect(title).toBe('Server set up');
    expect(api.checkDiscordManager).not.toHaveBeenCalled();
    expect(api.writeServerSettings).toHaveBeenCalledWith(
      { discordUserId: '42', guildId: 'theirs' },
      { serverLogChannelId: LOG, scamGuard: true }
    );
    expect(discord.createGuildRole).not.toHaveBeenCalled();
    expect(api.writeGuildConfig).not.toHaveBeenCalled();
    // The checklist says what is missing and what it stops.
    expect(text).toContain('**Ban Members**: the scam guard and /softban');
    expect(text).not.toContain('Manage Events');
  });

  it('refuses somebody without Manage Server', async () => {
    const { text } = await setup([{ name: 'scam_guard', type: 5, value: true }], { permissions: '0' });
    expect(text).toContain('Manage Server');
    expect(api.writeServerSettings).not.toHaveBeenCalled();
  });

  it('connecting it to the club still needs the club check, before any role', async () => {
    api.checkDiscordManager.mockResolvedValue('not_permitted');
    const { text } = await setup([{ name: 'club', type: 5, value: true }]);
    expect(api.checkDiscordManager).toHaveBeenCalledWith({ discordUserId: '42', guildId: 'theirs' }, { setup: true });
    expect(discord.createGuildRole).not.toHaveBeenCalled();
    expect(text).toContain('club execs');
  });
});

describe('/setup in the club server', () => {
  it('makes the club roles, then this server and the club checklist', async () => {
    api.fetchDiscordSettings.mockResolvedValue({ settings: { announcement_channel_id: '1' } });
    const { title, text } = await setup([{ name: 'scam_guard', type: 5, value: true }], { guildId: 'club' });
    expect(title).toBe('Club roles configured');
    expect(api.checkDiscordManager).toHaveBeenCalledWith({ discordUserId: '42', guildId: 'club' }, { setup: true });
    expect(api.writeGuildConfig).toHaveBeenCalled();
    expect(api.writeServerSettings).toHaveBeenCalledWith({ discordUserId: '42', guildId: 'club' }, { scamGuard: true });
    expect(text).toContain('__Club relays__');
    expect(text).toContain('**Channels not set**');
    expect(text).not.toMatch(/Channels not set[^\n]*Announcements/);
    expect(text).toContain('Manage Events');
  });

  it('refuses a Discord admin without the club check', async () => {
    api.checkDiscordManager.mockResolvedValue('not_linked');
    const { text } = await setup([], { guildId: 'club' });
    expect(text).toContain('/link');
    expect(discord.createGuildRole).not.toHaveBeenCalled();
  });
});
