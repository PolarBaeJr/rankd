import { describe, it, expect, vi, beforeEach } from 'vitest';

// /api/discord/server-settings: one Discord server's own settings (00302).
// Pinned: a club server needs the club check as well, any other server does
// not; the row written is always the caller's server; bad values never land.

let clubGuilds: string[] = [];
let rows: Record<string, unknown>[] = [];
const upserted = vi.fn();

const { checkDiscordManager } = vi.hoisted(() => ({
  checkDiscordManager: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; refusal: string }),
}));
vi.mock('@/lib/discord-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discord-manager')>()),
  checkDiscordManager,
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === 'discord_guilds') {
        let guildId = '';
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            if (column === 'guild_id') guildId = String(value);
            return query;
          },
          maybeSingle: async () => ({ data: clubGuilds.includes(guildId) ? { guild_id: guildId } : null, error: null }),
        };
        return query;
      }
      return {
        select: async () => ({ data: rows, error: null }),
        upsert: async (row: unknown) => {
          upserted(row);
          return { error: null };
        },
      };
    },
  }),
}));

import { GET, POST } from '../route';

const THEIRS = '222222222222222222';
const CLUB = '333333333333333333';
const CHANNEL = '444444444444444444';

function post(body: Record<string, unknown>) {
  return new Request('http://localhost/api/discord/server-settings', {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ discordUserId: '111111111111111111', guildId: THEIRS, ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clubGuilds = [CLUB];
  rows = [];
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
});

describe('GET', () => {
  it('lists every server, and refuses without the service secret', async () => {
    rows = [
      {
        guild_id: CLUB,
        server_log_channel_id: CHANNEL,
        scam_guard: true,
        automod_action: 'timeout_then_softban',
        automod_timeout_minutes: 60,
        automod_spray: true,
        automod_spray_channels: 3,
        automod_spray_window_minutes: 2,
        automod_flag_suspects: true,
        automod_words: ['nitro'],
        automod_words_action: 'delete',
        automod_trap_channel_ids: [CHANNEL],
      },
    ];
    const response = await GET(new Request('http://localhost/api/discord/server-settings', { headers: { authorization: 'Bearer test-secret' } }));
    expect(await response.json()).toEqual({
      servers: [
        {
          guildId: CLUB,
          serverLogChannelId: CHANNEL,
          scamGuard: true,
          automodAction: 'timeout_then_softban',
          automodTimeoutMinutes: 60,
          automodSpray: true,
          automodSprayChannels: 3,
          automodSprayWindowMinutes: 2,
          automodFlagSuspects: true,
          automodWords: ['nitro'],
          automodWordsAction: 'delete',
          automodTrapChannelIds: [CHANNEL],
        },
      ],
    });
    expect((await GET(new Request('http://localhost/api/discord/server-settings'))).status).toBe(401);
  });
});

describe('POST', () => {
  it("writes somebody else's server with no club check", async () => {
    const response = await POST(post({ serverLogChannelId: CHANNEL }));
    expect(response.status).toBe(200);
    expect(checkDiscordManager).not.toHaveBeenCalled();
    expect(upserted).toHaveBeenCalledWith(expect.objectContaining({ guild_id: THEIRS, server_log_channel_id: CHANNEL }));
  });

  it('needs the club check in a club server, and writes nothing when it fails', async () => {
    checkDiscordManager.mockResolvedValueOnce({ ok: false, refusal: 'not_linked' });
    const response = await POST(post({ guildId: CLUB, scamGuard: false }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'not_linked' });
    expect(upserted).not.toHaveBeenCalled();
  });

  it('switches the log off with null and leaves an unnamed setting alone', async () => {
    await POST(post({ serverLogChannelId: null }));
    const written = upserted.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.server_log_channel_id).toBeNull();
    expect('scam_guard' in written).toBe(false);
  });

  it('writes every auto mod setting, cleaning the word list', async () => {
    await POST(
      post({
        automodAction: 'timeout',
        automodTimeoutMinutes: 30,
        automodSpray: false,
        automodSprayChannels: 2,
        automodSprayWindowMinutes: 5,
        automodFlagSuspects: false,
        automodWords: [' Nitro ', 'nitro', '', 'FREE STEAM'],
        automodWordsAction: 'punish',
        automodTrapChannelIds: [CHANNEL, CHANNEL],
      })
    );
    expect(upserted).toHaveBeenCalledWith(
      expect.objectContaining({
        automod_action: 'timeout',
        automod_timeout_minutes: 30,
        automod_spray: false,
        automod_spray_channels: 2,
        automod_spray_window_minutes: 5,
        automod_flag_suspects: false,
        automod_words: ['nitro', 'free steam'],
        automod_words_action: 'punish',
        automod_trap_channel_ids: [CHANNEL],
      })
    );
  });

  it('refuses an unknown action, a number out of range, or a bad list', async () => {
    expect((await POST(post({ automodAction: 'ban' }))).status).toBe(400);
    expect((await POST(post({ automodWordsAction: 'timeout' }))).status).toBe(400);
    expect((await POST(post({ automodSprayChannels: 1 }))).status).toBe(400);
    expect((await POST(post({ automodSprayWindowMinutes: 11 }))).status).toBe(400);
    expect((await POST(post({ automodTimeoutMinutes: 2.5 }))).status).toBe(400);
    expect((await POST(post({ automodWords: ['x'.repeat(31)] }))).status).toBe(400);
    expect((await POST(post({ automodWords: 'nitro' }))).status).toBe(400);
    expect((await POST(post({ automodTrapChannelIds: ['general'] }))).status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });

  it('refuses a bad channel, a bad switch, or nothing to change', async () => {
    expect((await POST(post({ serverLogChannelId: 'general' }))).status).toBe(400);
    expect((await POST(post({ scamGuard: 'yes' }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });
});
