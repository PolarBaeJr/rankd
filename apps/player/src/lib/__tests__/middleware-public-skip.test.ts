import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * THE MIDDLEWARE MUST NOT ASK GOTRUE ANYTHING ON A PUBLIC PATH.
 *
 * public-paths.test.ts asserts which paths are public. It cannot assert what
 * this file exists for: that being public actually SAVES the round trip. Those
 * are different claims, and only this one is about the middleware.
 *
 * Both gates in middleware.ts are guarded by `!isPublic`, so `user` was never
 * read on a public request -- yet every public request still built a Supabase
 * client and awaited auth.getUser(). Signed out that is nearly free (no cookie,
 * so supabase-js fails locally). Signed in it was a real GoTrue round trip,
 * measured elsewhere in this repo at 48-126ms, paid on /leaderboard and then
 * paid AGAIN in the root layout, which runs in a different runtime and cannot
 * reuse it.
 *
 * WHAT IS ASSERTED IS THE ABSENCE OF A CALL, which is worth stating plainly
 * because absence is the easy thing to assert vacuously. createServerClient is
 * mocked to a spy that throws if anyone builds a client; the non-public cases
 * at the bottom are what prove the spy is wired up and would have fired. A
 * regression that moved getUser() back above the isPublic check would fail the
 * public cases here and nowhere else in the suite.
 */

const createServerClient = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => createServerClient(...args),
}));

// The real module reads process.env at call time; the middleware only reaches
// it on a non-public path, which is itself part of what this file checks.
vi.mock('@badminton/shared/src/utils/supabase-url', () => ({
  getServerSupabaseUrl: () => 'http://supabase.test',
}));

import { NextRequest } from 'next/server';
import { middleware } from '../../middleware';

/**
 * A client whose auth answers "signed out" and whose PostgREST calls answer
 * empty. Enough for the middleware to run its gates to completion.
 */
function stubClient(user: { id: string } | null) {
  return {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: () => ({
      select: () => ({
        maybeSingle: async () => ({ data: { onboarding_completed: true }, error: null }),
      }),
    }),
  };
}

function request(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(new URL(path, 'https://example.com'), { headers });
}

beforeEach(() => {
  createServerClient.mockReset();
  createServerClient.mockImplementation(() => stubClient(null));
});

describe('the middleware skips the auth round trip on public paths', () => {
  // The page routes anyone may read, plus the machine routes that carry their
  // own credential -- a bearer secret or a signed token -- and never had a
  // session for getUser() to find in the first place.
  const publicPaths = [
    '/',
    '/leaderboard',
    '/legal',
    '/legal/waiver',
    '/login',
    '/signup',
    '/auth/callback',
    '/exec',
    '/unsubscribe',
    '/api/calendar/abc',
    '/api/passkey/login',
    '/api/passkey/app/login/verify',
    '/.well-known/assetlinks.json',
    '/api/discord/handles',
    '/tournaments/checkin',
    '/guest-waiver',
    '/guest-waiver/abc',
  ];

  it.each(publicPaths)('builds no Supabase client for %s', async (path) => {
    const response = await middleware(request(path));
    expect(createServerClient).not.toHaveBeenCalled();
    // Passed through, not redirected. A 307 here would mean the early return
    // landed in the wrong place and took the login gate with it.
    expect(response.status).toBe(200);
  });

  it('skips it for a SIGNED-IN visitor too, which is the case that was costly', async () => {
    // The saving is not about anonymous traffic. A member with a live session
    // reading /leaderboard is who was paying for the discarded round trip.
    await middleware(request('/leaderboard', 'sb-badminton-auth-token=base64-session-value'));
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('still clears a duplicated host-only auth cookie on the way past', async () => {
    // The early return goes through finish(), and this is the only thing
    // finish() does. Returning supabaseResponse directly would silently drop
    // the cookie-migration cleanup on every public request -- which is most of
    // them for a signed-out visitor, so it would take a long time to notice.
    //
    // RE-IMPORTED UNDER A STUBBED ENV, which is the only way to see this at
    // all: duplicateAuthCookieClears is a no-op unless AUTH_COOKIE_DOMAIN is
    // set, and that constant is read once at module load. Asserting under the
    // default test env would have passed on an empty header list forever and
    // proved nothing -- which is exactly what the first draft of this did.
    vi.stubEnv('NEXT_PUBLIC_AUTH_COOKIE_DOMAIN', '.example.com');
    vi.resetModules();
    try {
      const { middleware: scoped } = await import('../../middleware');
      const dupe = 'sb-badminton-auth-token=a; sb-badminton-auth-token=b';
      const response = await scoped(request('/leaderboard', dupe));
      const setCookie = response.headers.getSetCookie().join('\n');
      expect(setCookie).toContain('sb-badminton-auth-token=');
      expect(setCookie).toMatch(/Max-Age=0/i);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('and still runs it everywhere else', () => {
  // THE CONTROL FOR THE ABOVE. Without these, `not.toHaveBeenCalled()` would
  // also pass if the mock were misnamed and the spy never wired to anything.
  const gatedPaths = ['/feed', '/profile', '/checkin/abc', '/link/abc', '/api/sessions', '/api/passkey/app/register/options'];

  it.each(gatedPaths)('builds a Supabase client for %s', async (path) => {
    await middleware(request(path));
    expect(createServerClient).toHaveBeenCalledTimes(1);
  });

  it('redirects a signed-out visitor off a gated page', async () => {
    const response = await middleware(request('/feed'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('carries a check-in token through the sign-in redirect', async () => {
    // Unchanged by this edit, and asserted here because /checkin/<token> is the
    // path most likely to be mistaken for public: it is scanned by someone who
    // is very often signed out.
    // CHECKIN_TOKEN_REGEX is 48 hex chars; a shorter token is silently dropped
    // from the redirect rather than rejected, so the length matters here.
    const token = 'a'.repeat(48);
    const response = await middleware(request(`/checkin/${token}`));
    expect(response.headers.get('location')).toContain(`checkin=${token}`);
  });
});
