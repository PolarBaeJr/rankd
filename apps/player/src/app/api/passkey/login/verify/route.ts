import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { parseOrThrow, AUTH_COOKIE_OPTIONS, hostOnlyAuthCookieClears } from '@badminton/shared';
import { getServerSupabaseUrl } from '@badminton/shared';
import { verifyLoginAssertion } from '@/lib/passkey/login-assertion';
import {
  getExpectedOrigin,
  isPasskeyConfigured,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_COOKIE_PATH,
} from '@/lib/passkey/config';

const bodySchema = z.object({
  credential: z.object({ id: z.string().min(1) }).passthrough(),
});

function clearChallengeCookie(response: NextResponse) {
  response.cookies.set(PASSKEY_CHALLENGE_COOKIE, '', { path: PASSKEY_COOKIE_PATH, maxAge: 0 });
}

// Deliberately uniform. Distinguishing "no such passkey" from "bad signature"
// would tell an unauthenticated caller which credential ids exist.
function fail(status = 400) {
  const response = NextResponse.json({ error: 'Passkey sign-in failed' }, { status });
  clearChallengeCookie(response);
  return response;
}

/**
 * Completes a passkey sign-in and mints a real Supabase session.
 *
 * This is the only unauthenticated endpoint in either app that can produce a
 * session, so the rules it follows are worth stating plainly:
 *
 *  - Identity comes from the CREDENTIAL, never from the request body. The
 *    client sends a credential id; everything about who that is comes from the
 *    row it matches and the signature verifying against that row's public key.
 *  - The challenge cookie is single-use and cleared on every outcome.
 *  - A stored credential whose player has no linked auth user is refused —
 *    roster rows exist without logins, and one must never become a session.
 */
export async function POST(request: Request) {
  if (!isPasskeyConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503 });
  }

  // NOT RATE LIMITED HERE. The throttle covering this route is at the edge, on
  // the /api/passkey prefix (240/min per client IP, routes.json on the proxy).
  // It has to stay wide: this is now the primary way in and the whole club
  // signs in within a few minutes of a session starting, largely from one
  // campus NAT, so a tight per-IP number locks out real members holding correct
  // credentials rather than stopping an attacker.
  //
  // Being wide is safe, and the limit was never what made this route safe in
  // the first place. Every attempt needs a valid single-use challenge cookie
  // minted by /login/options AND a signature over that challenge; the cookie is
  // cleared on every outcome including failure, so an attempt cannot be retried
  // against the same challenge; and every failure is deliberately uniform, so
  // there is no oracle to grind. Those three properties are the actual control.
  let body: z.infer<typeof bodySchema>;
  try {
    body = parseOrThrow(bodySchema, await request.json());
  } catch {
    return fail();
  }

  const cookieStore = await cookies();

  // The whole verification (challenge claim, signature, counter CAS, minting
  // the single-use token) lives in lib/passkey/login-assertion.ts, shared with
  // the native-app route. This route passes the WEB origin only; the Android
  // apk-key-hash origins are the app route's alone, so an assertion made
  // inside a native app can never mint a browser cookie session here.
  const result = await verifyLoginAssertion({
    credential: body.credential,
    challengeToken: cookieStore.get(PASSKEY_CHALLENGE_COOKIE)?.value,
    tokenType: 'login',
    expectedOrigin: getExpectedOrigin(),
  });
  if (!result.ok) {
    const response = NextResponse.json({ error: result.message }, { status: result.status });
    clearChallengeCookie(response);
    return response;
  }
  const hashedToken = result.hashedToken;

  const response = NextResponse.json({ ok: true });
  clearChallengeCookie(response);

  const supabase = createServerClient(
    getServerSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options as any);
          });
          // Expire the old host-only cookie in the same response that mints the
          // domain-scoped one, so the two never coexist. Raw append because
          // ResponseCookies is keyed by name and would clobber the write above.
          hostOnlyAuthCookieClears(cookiesToSet).forEach((c) =>
            response.headers.append('set-cookie', c)
          );
        },
      },
    }
  );

  const { error: otpErr } = await supabase.auth.verifyOtp({
    token_hash: hashedToken,
    type: 'magiclink',
  });
  if (otpErr) return fail(500);

  return response;
}
