import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// PINS THE WEB SIGN-IN ROUTE'S RESPONSES, BRANCH BY BRANCH.
//
// The verification body of this route was lifted into lib/passkey/
// login-assertion.ts so the native-app route could share it. A lift like that
// is exactly where a status code or a message quietly changes: the counter-CAS
// failure answering "Passkey verification failed" where every other refusal
// says "Passkey sign-in failed" is the kind of detail that survives a reading
// and not a refactor. So every branch is asserted by status, exact body, and
// the challenge cookie being cleared, and this file was green against the
// route BEFORE the extraction as well as after.
//
// It also pins that the web route passes ONE origin, the web one, as a plain
// string. The Android apk-key-hash origins belong to the app route only; an
// array arriving here would mean a native app's assertion could mint a
// browser cookie session.

const verifyAuthenticationResponse = vi.fn();
const verifyOtp = vi.fn();
const rpc = vi.fn();
const getUserById = vi.fn();
const generateLink = vi.fn();

let stored: Record<string, unknown> | null = null;
let player: Record<string, unknown> | null = null;
let counterRows: { id: string }[] | null = [];
let counterErr: unknown = null;
let cookieValue: string | undefined;

vi.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: (...args: unknown[]) => verifyAuthenticationResponse(...args),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: { setAll: (c: unknown[]) => void } }) => ({
    auth: {
      verifyOtp: async (args: unknown) => {
        const result = await verifyOtp(args);
        if (!result.error) {
          opts.cookies.setAll([{ name: 'sb-badminton-auth-token', value: 'session', options: { path: '/' } }]);
        }
        return result;
      },
    },
  }),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'player_passkey_challenge' && cookieValue !== undefined ? { name, value: cookieValue } : undefined,
    getAll: () => [],
  }),
}));

// createServiceRoleClient is called more than once per request. Every call
// returns a client reading the same module-level state, so the tests hold
// whether the route shares one client or builds several.
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { admin: { getUserById, generateLink } },
    from: (table: string) => {
      if (table === 'passkey_credentials') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stored, error: null }) }) }),
          update: () => ({
            eq: () => ({ eq: () => ({ select: async () => ({ data: counterRows, error: counterErr }) }) }),
          }),
        };
      }
      if (table === 'players') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: player, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import type { NextResponse } from 'next/server';
import { signPayload } from '@/lib/passkey/cookie';
import { PASSKEY_CHALLENGE_COOKIE } from '@/lib/passkey/config';

const CREDENTIAL = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} };

function req(body: unknown = { credential: CREDENTIAL }) {
  return new Request('https://example.test/api/passkey/login/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(body?: unknown) {
  const { POST } = await import('../route');
  const res = await POST(req(body));
  return { res, json: await res.json() };
}

function cleared(res: NextResponse) {
  return res.cookies.get(PASSKEY_CHALLENGE_COOKIE)?.value === '';
}

const SIGN_IN_FAILED = { error: 'Passkey sign-in failed' };

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example.test');
  vi.stubEnv('NEXT_PUBLIC_PASSKEY_RP_ID', 'example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.test/supabase');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');

  verifyAuthenticationResponse.mockReset();
  verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0 } });
  verifyOtp.mockReset();
  verifyOtp.mockResolvedValue({ error: null });
  rpc.mockReset();
  rpc.mockResolvedValue({ data: true, error: null });
  getUserById.mockReset();
  getUserById.mockResolvedValue({ data: { user: { email: 'member@example.test', banned_until: null } }, error: null });
  generateLink.mockReset();
  generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'hashed' } }, error: null });

  stored = { id: 'row-1', credential_id: 'cred-1', public_key: 'AAAA', counter: 0, transports: null, player_id: 'p1' };
  player = { id: 'p1', user_id: 'u1', status: 'active' };
  counterRows = [{ id: 'row-1' }];
  counterErr = null;
  cookieValue = await signPayload({ challenge: 'chal-1', type: 'login' }, 300);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/passkey/login/verify', () => {
  it('signs in: 200 { ok: true }, clears the challenge, writes the session cookie', async () => {
    const { res, json } = await post();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(cleared(res)).toBe(true);
    expect(res.headers.getSetCookie().join('\n')).toContain('sb-badminton-auth-token=session');
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hashed', type: 'magiclink' });
  });

  it('claims the challenge for the player_login purpose', async () => {
    await post();
    expect(rpc).toHaveBeenCalledWith('consume_passkey_challenge', expect.objectContaining({ p_purpose: 'player_login' }));
  });

  it('verifies against the web origin only, as a plain string', async () => {
    await post();
    const args = verifyAuthenticationResponse.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.expectedOrigin).toBe('https://example.test');
    expect(args.expectedChallenge).toBe('chal-1');
    expect(args.expectedRPID).toBe('example.test');
  });

  it('answers 503 when passkeys are not configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PASSKEY_COOKIE_SECRET', '');
    const { res, json } = await post();
    expect(res.status).toBe(503);
    expect(json).toEqual({ error: 'Passkeys are not configured' });
  });

  const refusals: [string, () => void | Promise<void>, unknown?][] = [
    ['a malformed body', () => {}, '{not json'],
    ['a body with no credential id', () => {}, { credential: {} }],
    ['no challenge cookie', () => { cookieValue = undefined; }],
    ['a tampered challenge cookie', () => { cookieValue = `${cookieValue}x`; }],
    ['a challenge cookie minted for another flow', async () => {
      cookieValue = await signPayload({ challenge: 'chal-1', type: 'register' }, 300);
    }],
    ['an app_login token presented as the cookie', async () => {
      cookieValue = await signPayload({ challenge: 'chal-1', type: 'app_login' }, 300);
    }],
    ['a challenge already spent', () => { rpc.mockResolvedValue({ data: false, error: null }); }],
    ['a challenge claim that errors', () => { rpc.mockResolvedValue({ data: null, error: { message: 'x' } }); }],
    ['an unknown credential id', () => { stored = null; }],
    ['a signature that throws', () => { verifyAuthenticationResponse.mockRejectedValue(new Error('bad')); }],
    ['a signature that does not verify', () => {
      verifyAuthenticationResponse.mockResolvedValue({ verified: false, authenticationInfo: { newCounter: 0 } });
    }],
    ['a regressed signature counter', () => {
      stored = { ...stored!, counter: 5 };
      verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });
    }],
    ['a player with no linked auth user', () => { player = { id: 'p1', user_id: null, status: 'active' }; }],
    ['no player row', () => { player = null; }],
    ['an auth lookup error', () => { getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'x' } }); }],
    ['an auth user with no email', () => { getUserById.mockResolvedValue({ data: { user: { email: null } }, error: null }); }],
  ];

  it.each(refusals)('refuses %s with a uniform 400', async (_label, arrange, body) => {
    await arrange();
    const { res, json } = await post(body);
    expect(res.status).toBe(400);
    expect(json).toEqual(SIGN_IN_FAILED);
    expect(cleared(res)).toBe(true);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('refuses a banned account with 403', async () => {
    getUserById.mockResolvedValue({
      data: { user: { email: 'member@example.test', banned_until: '2999-01-01T00:00:00Z' } },
      error: null,
    });
    const { res, json } = await post();
    expect(res.status).toBe(403);
    expect(json).toEqual(SIGN_IN_FAILED);
    expect(cleared(res)).toBe(true);
  });

  it('answers the counter-CAS miss with its own message', async () => {
    counterRows = [];
    const { res, json } = await post();
    expect(res.status).toBe(400);
    expect(json).toEqual({ error: 'Passkey verification failed' });
    expect(cleared(res)).toBe(true);
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('answers a counter-CAS error the same way', async () => {
    counterRows = null;
    counterErr = { message: 'x' };
    const { res, json } = await post();
    expect(res.status).toBe(400);
    expect(json).toEqual({ error: 'Passkey verification failed' });
  });

  it('answers 500 when no sign-in token can be minted', async () => {
    generateLink.mockResolvedValue({ data: { properties: {} }, error: null });
    const { res, json } = await post();
    expect(res.status).toBe(500);
    expect(json).toEqual(SIGN_IN_FAILED);
    expect(cleared(res)).toBe(true);
  });

  it('answers 500 when the token cannot be redeemed for a session', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'x' } });
    const { res, json } = await post();
    expect(res.status).toBe(500);
    expect(json).toEqual(SIGN_IN_FAILED);
    expect(cleared(res)).toBe(true);
  });
});
