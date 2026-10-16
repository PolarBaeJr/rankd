import { NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { signPayload } from '@/lib/passkey/cookie';
import { recordChallenge } from '@/lib/passkey/challenge-store';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { getRpId, isPasskeyConfigured, CHALLENGE_TTL_SECONDS } from '@/lib/passkey/config';

/**
 * Starts a passkey sign-in for the NATIVE app. The web twin is
 * /api/passkey/login/options; this differs only in how the signed challenge
 * travels.
 *
 * The web flow carries it in an httpOnly cookie. A native app has no cookie
 * jar worth relying on, so here it comes back in the body as `challengeToken`
 * and the app sends it back to /api/passkey/app/login/verify. No cookie is
 * set.
 *
 * The token is signed as type 'app_login', not 'login'. The two verify routes
 * each accept only their own type, so a web challenge cookie cannot be pasted
 * into the app route's body, and an app token cannot be planted as the web
 * cookie. Both are still claimed against the same 'player_login' purpose
 * server side (00181), which is what makes either single-use.
 *
 * Unauthenticated by design, and rate limited at the edge on the /api/passkey
 * prefix like the web pair (see docs/ops/rate-limits.md).
 */
export async function POST() {
  if (!isPasskeyConfigured()) {
    return NextResponse.json({ error: 'Passkeys are not configured' }, { status: 503 });
  }

  // allowCredentials is deliberately EMPTY, for the same reason as the web
  // route: returning an account's credential ids would need an email first and
  // would answer "does this address have an account here", an enumeration
  // oracle on a membership list. Discoverable credentials let the
  // authenticator choose, so the server learns who you are only after a valid
  // signature.
  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: 'preferred',
  });

  await recordChallenge(createServiceRoleClient(), options.challenge, 'player_login', null, CHALLENGE_TTL_SECONDS);

  const challengeToken = await signPayload(
    { challenge: options.challenge, type: 'app_login' },
    CHALLENGE_TTL_SECONDS
  );

  // no-store: a cached options body would hand two sign-ins the same
  // challenge, and the second would always fail the single-use claim.
  return NextResponse.json({ options, challengeToken }, { headers: { 'Cache-Control': 'no-store' } });
}
