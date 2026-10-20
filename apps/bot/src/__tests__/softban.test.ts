import { describe, expect, it, vi } from 'vitest';
import { canBan, softban, topPosition, windowSeconds, type SoftbanInput } from '../moderation.js';
import type { DiscordRole } from '../setup.js';
import type { RoleCallResult } from '../discord-api.js';

const ROLES: DiscordRole[] = [
  { id: 'everyone', name: '@everyone', position: 0 },
  { id: 'member', name: 'Member', position: 1 },
  { id: 'mod', name: 'Mod', position: 5 },
  { id: 'bot', name: 'Bot', position: 8 },
  { id: 'admin', name: 'Admin', position: 10 },
];

function fakeApi(overrides: {
  targetRoles?: string[] | null;
  ban?: RoleCallResult;
  unban?: RoleCallResult[];
} = {}) {
  const unbans = [...(overrides.unban ?? ['ok'])];
  return {
    getBotUserId: vi.fn(async () => 'bot-user'),
    getGuildOwnerId: vi.fn(async () => 'owner'),
    getMemberRoles: vi.fn(async () =>
      overrides.targetRoles === undefined ? ['member'] : overrides.targetRoles
    ),
    listGuildRoles: vi.fn(async () => ROLES),
    getOwnRolePosition: vi.fn(async () => 8),
    banMember: vi.fn(async () => overrides.ban ?? 'ok'),
    unbanMember: vi.fn(async () => unbans.shift() ?? 'failed'),
  };
}

const INPUT: SoftbanInput = {
  guildId: 'g',
  callerId: 'caller',
  callerRoles: ['mod'],
  callerPermissions: String(1n << 2n),
  targetId: 'spammer',
  deleteSeconds: 86400,
  reason: 'posting random links',
};

const noSleep = async () => {};

describe('canBan', () => {
  it('accepts Ban Members or Administrator, nothing else', () => {
    expect(canBan(String(1n << 2n))).toBe(true);
    expect(canBan(String(1n << 3n))).toBe(true);
    expect(canBan(String(1n << 5n))).toBe(false);
    expect(canBan(null)).toBe(false);
    expect(canBan('not a number')).toBe(false);
  });
});

describe('topPosition and windowSeconds', () => {
  it('is the highest held role, 0 with none', () => {
    expect(topPosition(['member', 'mod'], ROLES)).toBe(5);
    expect(topPosition([], ROLES)).toBe(0);
  });

  it('only takes the offered windows, defaulting to a day', () => {
    expect(windowSeconds('604800')).toBe(604800);
    expect(windowSeconds('999999')).toBe(86400);
    expect(windowSeconds(undefined)).toBe(86400);
  });
});

describe('softban', () => {
  it('bans with the delete window, then unbans', async () => {
    const api = fakeApi();
    const outcome = await softban(api, INPUT, noSleep);
    expect(outcome).toEqual({ ok: true, unbanned: true });
    expect(api.banMember).toHaveBeenCalledWith('g', 'spammer', 86400, expect.stringContaining('posting random links'));
    expect(api.unbanMember).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller without Ban Members, before touching Discord', async () => {
    const api = fakeApi();
    const outcome = await softban(api, { ...INPUT, callerPermissions: '0' }, noSleep);
    expect(outcome.ok).toBe(false);
    expect(api.banMember).not.toHaveBeenCalled();
  });

  it('refuses self, the bot and the owner', async () => {
    for (const targetId of ['caller', 'bot-user', 'owner']) {
      const api = fakeApi();
      const outcome = await softban(api, { ...INPUT, targetId }, noSleep);
      expect(outcome.ok).toBe(false);
      expect(api.banMember).not.toHaveBeenCalled();
    }
  });

  it('refuses a target ranked at or above the caller', async () => {
    const api = fakeApi({ targetRoles: ['mod'] });
    const outcome = await softban(api, INPUT, noSleep);
    expect(outcome.ok).toBe(false);
    expect(api.banMember).not.toHaveBeenCalled();
  });

  it('lets the owner act on anyone below the bot', async () => {
    const api = fakeApi({ targetRoles: ['mod'] });
    const outcome = await softban(api, { ...INPUT, callerId: 'owner', callerRoles: [] }, noSleep);
    expect(outcome).toEqual({ ok: true, unbanned: true });
  });

  it('refuses a target the bot cannot outrank', async () => {
    const api = fakeApi({ targetRoles: ['admin'] });
    const outcome = await softban(api, { ...INPUT, callerId: 'owner' }, noSleep);
    expect(outcome.ok).toBe(false);
    expect(api.banMember).not.toHaveBeenCalled();
  });

  it('still bans someone who already left the server', async () => {
    const api = fakeApi({ targetRoles: null });
    const outcome = await softban(api, INPUT, noSleep);
    expect(outcome).toEqual({ ok: true, unbanned: true });
  });

  it('changes nothing when the ban fails', async () => {
    const api = fakeApi({ ban: 'forbidden' });
    const outcome = await softban(api, INPUT, noSleep);
    expect(outcome.ok).toBe(false);
    expect(api.unbanMember).not.toHaveBeenCalled();
  });

  it('retries the unban, and says so when it never lands', async () => {
    const api = fakeApi({ unban: ['failed', 'failed', 'failed'] });
    const outcome = await softban(api, INPUT, noSleep);
    expect(outcome).toEqual({ ok: true, unbanned: false });
    expect(api.unbanMember).toHaveBeenCalledTimes(3);
  });

  it('recovers on a later unban attempt', async () => {
    const api = fakeApi({ unban: ['failed', 'ok'] });
    const outcome = await softban(api, INPUT, noSleep);
    expect(outcome).toEqual({ ok: true, unbanned: true });
  });
});
