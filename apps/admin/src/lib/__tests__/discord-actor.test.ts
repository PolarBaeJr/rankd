import { describe, it, expect, beforeEach, vi } from 'vitest';

// CONSOLE COMMANDS ON DISCORD: the actor seam in getAuthenticatedConsolePlayer.
//
// Inside discordActorStore the gate loads the linked exec's row by id instead
// of reading a cookie, then runs the SAME standing and capability checks, and
// the Discord passkey policy in place of the cookie step-up. Outside the store
// nothing changes: no cookie, no console.

const state = vi.hoisted(() => ({
  players: {} as Record<string, Record<string, unknown>>,
  passkeyCount: 0 as number | null,
  passkeyError: null as { message: string } | null,
  grace: null as { started_at: string } | null,
  graceError: null as { message: string } | null,
  cookieReads: 0,
  getUserCalls: 0,
}));

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

vi.mock('next/headers', () => ({
  cookies: async () => {
    state.cookieReads += 1;
    return { getAll: () => [], get: () => undefined, set: () => {} };
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        state.getUserCalls += 1;
        return { data: { user: null } };
      },
    },
  }),
}));

vi.mock('@supabase/supabase-js', () => {
  const chain = (table: string) => {
    const filters: Record<string, unknown> = {};
    const self: Record<string, unknown> = {
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return self;
      },
      maybeSingle: async () => {
        if (table === 'players') return { data: state.players[filters.id as string] ?? null, error: null };
        if (table === 'console_passkey_grace') return { data: state.grace, error: state.graceError };
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ count: state.passkeyError ? null : state.passkeyCount, error: state.passkeyError }),
    };
    return self;
  };
  return {
    createClient: () => ({
      from: (table: string) => ({ select: () => chain(table) }),
    }),
  };
});

vi.mock('@sentry/nextjs', () => ({ setUser: vi.fn(), captureException: vi.fn() }));

import { requireCapability, getAuthenticatedAdmin } from '../supabase-server';
import { discordActorStore, discordPasskeyPolicy, DISCORD_PASSKEY_REQUIRED } from '../discord-actor';

const EXEC = 'exec-1';

function asDiscord<T>(fn: () => Promise<T>, playerId = EXEC): Promise<T> {
  return discordActorStore.run({ playerId, discordUserId: '123456789012345678' }, fn);
}

beforeEach(() => {
  state.players = {
    [EXEC]: {
      id: EXEC,
      user_id: 'user-1',
      role: 'player',
      is_exec: true,
      status: 'competitive',
      active_flag: true,
      is_banned: false,
    },
  };
  state.passkeyCount = 1;
  state.passkeyError = null;
  state.grace = null;
  state.graceError = null;
  state.cookieReads = 0;
  state.getUserCalls = 0;
});

describe('the Discord actor seam', () => {
  it('admits a linked exec with a console passkey, as that exec, without reading a cookie', async () => {
    const player = await asDiscord(() => requireCapability('players.read'));
    expect(player.id).toBe(EXEC);
    expect(state.getUserCalls).toBe(0);
    // assertPasskeyVerified reads the cookie jar; the Discord path never does.
    expect(state.cookieReads).toBe(0);
  });

  it('refuses a banned exec with the console wording', async () => {
    state.players[EXEC]!.is_banned = true;
    await expect(asDiscord(() => requireCapability('players.read'))).rejects.toMatchObject({
      message: 'Account suspended pending reinstatement',
      code: 'ACC-103',
    });
  });

  it('refuses a suspended exec', async () => {
    state.players[EXEC]!.status = 'suspended';
    await expect(asDiscord(() => requireCapability('players.read'))).rejects.toMatchObject({
      code: 'ACC-102',
    });
  });

  it('denies a capability with the same text the console shows', async () => {
    // An unrestricted exec baseline is reads only; creating a session is an
    // assignment, so the console says to ask an admin.
    await expect(asDiscord(() => requireCapability('sessions.create.write'))).rejects.toMatchObject({
      message: 'Your permissions do not include this. Ask an admin.',
      code: 'AUTH-104',
    });
  });

  it('refuses a player id with no row', async () => {
    await expect(asDiscord(() => requireCapability('players.read'), 'nobody')).rejects.toMatchObject({
      code: 'ACC-105',
    });
  });

  it('runs nothing as the exec outside the store: the cookie path still decides', async () => {
    await expect(requireCapability('players.read')).rejects.toMatchObject({ code: 'AUTH-101' });
    expect(state.getUserCalls).toBe(1);
  });

  it('applies the passkey policy even when skipPasskey is asked for', async () => {
    state.passkeyCount = 0;
    state.grace = null;
    await expect(asDiscord(() => getAuthenticatedAdmin({ skipPasskey: true }))).rejects.toMatchObject({
      code: 'AUTH-104',
    });
    state.players[EXEC]!.role = 'admin';
    await expect(asDiscord(() => getAuthenticatedAdmin({ skipPasskey: true }))).rejects.toMatchObject({
      message: DISCORD_PASSKEY_REQUIRED,
      code: 'AUTH-105',
    });
  });
});

describe('discordPasskeyPolicy', () => {
  const player = { id: EXEC, user_id: 'user-1' };
  const client = async () => (await import('../supabase-server')).createAdminClient();

  it('allows an exec with an enrolled console passkey', async () => {
    state.passkeyCount = 1;
    expect(await discordPasskeyPolicy(player, await client())).toBe('allowed');
  });

  it('allows an exec with no passkey inside the grace window', async () => {
    state.passkeyCount = 0;
    state.grace = { started_at: daysAgo(3) };
    expect(await discordPasskeyPolicy(player, await client())).toBe('allowed');
  });

  it('refuses once the grace window has run out', async () => {
    state.passkeyCount = 0;
    state.grace = { started_at: daysAgo(30) };
    expect(await discordPasskeyPolicy(player, await client())).toBe('passkey_required');
  });

  it('refuses an exec who never opened the console (no grace row)', async () => {
    state.passkeyCount = 0;
    state.grace = null;
    expect(await discordPasskeyPolicy(player, await client())).toBe('passkey_required');
  });

  it('fails closed with AUTH-103 when the passkey count cannot be read', async () => {
    state.passkeyError = { message: 'boom' };
    await expect(discordPasskeyPolicy(player, await client())).rejects.toMatchObject({ code: 'AUTH-103' });
  });

  it('fails closed with AUTH-103 when the grace row cannot be read', async () => {
    state.passkeyCount = 0;
    state.graceError = { message: 'boom' };
    await expect(discordPasskeyPolicy(player, await client())).rejects.toMatchObject({ code: 'AUTH-103' });
  });
});
