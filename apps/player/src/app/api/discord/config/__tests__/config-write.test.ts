import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/config is what /setup calls to save a guild's role map.
//
// Validation here is a security boundary, not hygiene. This endpoint decides
// WHICH Discord role the bot hands to everyone the app says qualifies, so a
// role id that reaches the database unchecked is a role handed to every exec
// in the server. "It came from our own bot" is not the same claim as "the data
// is ours": the bot builds this payload out of names it read from somebody
// else's guild.

const upsertGuilds = vi.fn();
const upsertRoles = vi.fn();
const upsertSettings = vi.fn();

// The caller check has its own tests; here every caller may.
const { checkDiscordManager } = vi.hoisted(() => ({
  checkDiscordManager: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; refusal: string }),
}));
vi.mock('@/lib/discord-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discord-manager')>()),
  checkDiscordManager,
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => ({
      upsert:
        table === 'discord_guilds'
          ? upsertGuilds
          : table === 'discord_guild_roles'
            ? upsertRoles
            : upsertSettings,
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  }),
}));

import { POST } from '../route';

const GUILD = '123456789012345678';
const ROLE = '987654321098765432';

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/config', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    // Every bot write names who ran the command and where (discord-manager.ts).
    body: JSON.stringify(
      body && typeof body === 'object' && !Array.isArray(body)
        ? { discordUserId: '111111111111111111', guildId: '222222222222222222', ...body }
        : body
    ),
  });
}

const VALID = { guildId: GUILD, roles: { linked: ROLE } };

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  upsertGuilds.mockReset().mockResolvedValue({ error: null });
  upsertRoles.mockReset().mockResolvedValue({ error: null });
  upsertSettings.mockReset().mockResolvedValue({ error: null });
});

describe('auth', () => {
  it('refuses without the service secret', async () => {
    const res = await POST(post(VALID, 'Bearer wrong'));
    expect(res.status).toBe(401);
    expect(upsertRoles).not.toHaveBeenCalled();
  });

  it('refuses when the secret is not configured at all — fails closed', async () => {
    delete process.env.DISCORD_SERVICE_SECRET;
    const res = await POST(post(VALID));
    expect(res.status).toBe(401);
    expect(upsertRoles).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('accepts a well-formed payload', async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, guildId: GUILD, roles: 1 });
  });

  it('rejects a role name the schema does not allow', async () => {
    // Mirrors the CHECK in 00167. Without this the write fails at the database
    // with a constraint error the operator never sees.
    const res = await POST(post({ guildId: GUILD, roles: { admin: ROLE } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_role', detail: 'admin' });
    expect(upsertRoles).not.toHaveBeenCalled();
  });

  it.each([
    ['not a snowflake', 'not-an-id'],
    ['too short', '123'],
    ['injection-shaped', "1' OR '1'='1"],
    ['empty', ''],
  ])('rejects a role id that is %s', async (_label, bad) => {
    const res = await POST(post({ guildId: GUILD, roles: { linked: bad } }));
    expect(res.status).toBe(400);
    expect(upsertRoles).not.toHaveBeenCalled();
  });

  it('rejects a malformed guild id', async () => {
    const res = await POST(post({ guildId: 'nope', roles: { linked: ROLE } }));
    expect(res.status).toBe(400);
  });

  // An empty map creates a guild row with no roles, which GET filters out --
  // so it would read as "setup succeeded" while changing nothing.
  it('rejects an empty role map', async () => {
    const res = await POST(post({ guildId: GUILD, roles: {} }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no_roles' });
  });

  it('rejects a roles array masquerading as an object', async () => {
    const res = await POST(post({ guildId: GUILD, roles: [] }));
    expect(res.status).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/discord/config', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
        body: 'not json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('rejects a malformed audit channel id', async () => {
    const res = await POST(post({ ...VALID, auditChannelId: 'nope' }));
    expect(res.status).toBe(400);
    expect(upsertSettings).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  it('writes the guild before the roles, because of the foreign key', async () => {
    const order: string[] = [];
    upsertGuilds.mockImplementation(async () => (order.push('guild'), { error: null }));
    upsertRoles.mockImplementation(async () => (order.push('roles'), { error: null }));
    await POST(post(VALID));
    expect(order).toEqual(['guild', 'roles']);
  });

  it('only touches settings when an audit channel is supplied', async () => {
    await POST(post(VALID));
    expect(upsertSettings).not.toHaveBeenCalled();
    await POST(post({ ...VALID, auditChannelId: '111111111111111111' }));
    expect(upsertSettings).toHaveBeenCalled();
  });

  it('reports a failed write as 503 rather than claiming success', async () => {
    upsertRoles.mockResolvedValue({ error: { message: 'permission denied' } });
    const res = await POST(post(VALID));
    expect(res.status).toBe(503);
  });

  it('does not write roles when the guild write failed', async () => {
    upsertGuilds.mockResolvedValue({ error: { message: 'nope' } });
    const res = await POST(post(VALID));
    expect(res.status).toBe(503);
    expect(upsertRoles).not.toHaveBeenCalled();
  });
});

describe('the caller check', () => {
  it('refuses a caller the club does not allow, and writes nothing', async () => {
    checkDiscordManager.mockResolvedValueOnce({ ok: false, refusal: 'not_permitted' });
    const response = await POST(post({ guildId: '222222222222222222', roles: { member: '333333333333333333' } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'not_permitted' });
  });
});
