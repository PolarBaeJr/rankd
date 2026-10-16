import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * THE NATIVE APP'S BEARER, AND THE ONE PLACE IT CHANGES WHO THE SERVER THINKS
 * IS ASKING.
 *
 * resolveAppActor turns `Authorization: Bearer <jwt>` into a verified user and
 * a Supabase client that carries the bearer. appActorStore is what makes the
 * website's own server actions act as that member: inside it,
 * createServerSupabaseClient returns the actor's client and never reads the
 * cookie store. next/headers is mocked to THROW, so any cookie read inside the
 * store fails the test rather than passing quietly on an empty jar.
 */

const createClient = vi.fn();
const getUser = vi.fn();
const cookies = vi.fn(async () => {
  throw new Error('cookies() must not be called for an app request');
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));

vi.mock('next/headers', () => ({
  cookies: () => cookies(),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => {
    throw new Error('the cookie client must not be built for an app request');
  },
}));

import { appActorStore, resolveAppActor } from '../app-actor';
import { createServerSupabaseClient } from '../supabase-server';

function request(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('Authorization', authorization);
  return new Request('https://site.example.invalid/api/app/actions/x', { method: 'POST', headers });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.invalid';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  delete process.env.SUPABASE_INTERNAL_URL;
  createClient.mockReset();
  getUser.mockReset();
  cookies.mockClear();
  createClient.mockImplementation(() => ({ auth: { getUser }, marker: 'actor-client' }));
});

describe('resolveAppActor', () => {
  it('is null with no Authorization header, and builds no client', async () => {
    expect(await resolveAppActor(request())).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(['Basic abc', 'Bearer', 'Bearer ', 'bearer abc', 'Bearer a b', 'Token abc'])(
    'is null for a malformed header %j',
    async (header) => {
      expect(await resolveAppActor(request(header))).toBeNull();
      expect(getUser).not.toHaveBeenCalled();
    },
  );

  it('is null when GoTrue refuses the token', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });
    expect(await resolveAppActor(request('Bearer eyJ.a.b'))).toBeNull();
  });

  it('is null when the user lookup throws', async () => {
    getUser.mockRejectedValue(new Error('network'));
    expect(await resolveAppActor(request('Bearer eyJ.a.b'))).toBeNull();
  });

  it('verifies the exact token and builds a client that carries it, with no session of its own', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    const actor = await resolveAppActor(request('Bearer eyJ.a.b'));
    expect(actor?.user).toEqual({ id: 'user-1' });
    expect(getUser).toHaveBeenCalledWith('eyJ.a.b');
    const [url, key, options] = createClient.mock.calls[0]!;
    expect(url).toBe('https://db.example.invalid');
    expect(key).toBe('anon');
    expect(options.global.headers).toEqual({ Authorization: 'Bearer eyJ.a.b' });
    expect(options.auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  });
});

describe('createServerSupabaseClient inside the store', () => {
  it("returns the actor's client and never touches cookies()", async () => {
    const actorClient = { marker: 'actor-client' };
    const client = await appActorStore.run(
      { user: { id: 'user-1' } as never, supabase: actorClient as never },
      () => createServerSupabaseClient(),
    );
    expect(client).toBe(actorClient);
    expect(cookies).not.toHaveBeenCalled();
  });

  it('reads cookies outside the store, as the website always has', async () => {
    await expect(createServerSupabaseClient()).rejects.toThrow('cookies() must not be called');
    expect(cookies).toHaveBeenCalledTimes(1);
  });
});
