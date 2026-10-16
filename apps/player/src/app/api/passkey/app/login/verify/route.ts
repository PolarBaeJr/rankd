import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { parseOrThrow, getServerSupabaseUrl } from '@badminton/shared';
import { verifyLoginAssertion } from '@/lib/passkey/login-assertion';
import { isPasskeyConfigured } from '@/lib/passkey/config';
import { getAppExpectedOrigins } from '@/lib/passkey/native-apps';

const bodySchema = z.object({
  credential: z.object({ id: z.string().min(1) }).passthrough(),
  challengeToken: z.string().min(1).max(4096),
});

const NO_STORE = { 'Cache-Control': 'no-store' };

// Deliberately uniform, MORE so than the web route: the web route answers a
// counter-CAS miss with its own message, this one does not. A native client
// has nothing different to do about it (fetch fresh options and try again is
// the answer to every failure here), so there is no reason to hand an
// unauthenticated caller a second distinguishable outcome.
function fail(status: number = 400) {
  return NextResponse.json({ error: 'Passkey sign-in failed' }, { status, headers: NO_STORE });
}

/**
 * Completes a passkey sign-in for the NATIVE app and returns the Supabase
 * session tokens in the body, where the web twin (/api/passkey/login/verify)
 * writes them into cookies.
 *
 * Verification is the web route's own code (lib/passkey/login-assertion.ts),
 * so identity still comes from the credential alone. What is different, and
 * why each difference is safe:
 *
 *  - CSRF. There is no ambient authority to forge: the challenge arrives in the
 *    body, not a cookie, and no cookie is read or written. A cross-site POST
 *    would need a fresh challenge token AND a signature over it from the
 *    member's authenticator.
 *  - CORS. None is added. A browser page on another origin cannot read the
 *    response, and the native app is not subject to CORS at all.
 *  - Replay. The challenge is claimed server side (00181) before anything is
 *    verified, so a token works once. A failed attempt burns it too, so the
 *    app must fetch fresh options for every attempt.
 *  - Rate limit. Covered at the edge by the /api/passkey prefix, same as the
 *    web pair; there is deliberately no in-process limiter.
 *  - Counter. The compare-and-swap in the shared core runs unchanged.
 *
 * Origins: the web origin, https://<rpId>, and one android:apk-key-hash origin
 * per certificate in PASSKEY_ANDROID_CERT_SHA256 (see native-apps.ts).
 *
 * The tokens returned are bearer credentials. Nothing here logs them, and
 * nothing may start to.
 */
export async function POST(request: Request) {
  // Checked before anything else, like the web route. Without it an unset
  // PASSKEY_COOKIE_SECRET in production would reach the HMAC in verifyPayload,
  // which throws, and the app would get an unhandled 500 instead of a clear
  // "not configured".
  if (!isPasskeyConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503, headers: NO_STORE });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = parseOrThrow(bodySchema, await request.json());
  } catch {
    return fail();
  }

  const result = await verifyLoginAssertion({
    credential: body.credential,
    challengeToken: body.challengeToken,
    tokenType: 'app_login',
    expectedOrigin: getAppExpectedOrigins(),
  });
  if (!result.ok) return fail(result.status);

  // A throwaway client: nothing persisted, nothing refreshed, no cookies. It
  // exists only to redeem the single-use token for a session and hand that
  // session back to the app, which owns refreshing it from here on.
  const supabase = createClient(getServerSupabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: result.hashedToken,
    type: 'magiclink',
  });
  const session = data?.session;
  if (error || !session) return fail(500);

  return NextResponse.json(
    {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      token_type: session.token_type,
    },
    { headers: NO_STORE }
  );
}
