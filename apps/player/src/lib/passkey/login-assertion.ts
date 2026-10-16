// The verification half of a passkey sign-in, shared by the web route
// (/api/passkey/login/verify, cookie challenge, cookie session) and the native
// app route (/api/passkey/app/login/verify, body challenge, token session).
//
// It returns a result and never builds a response. The two routes answer in
// different shapes, and the web route's exact statuses and messages are pinned
// by app/api/passkey/login/verify/__tests__/route.test.ts; keeping NextResponse
// out of here is what lets each route own its answer without this file
// growing a flag per caller.
//
// The rules the web route states in its header hold here unchanged, because
// this IS that code: identity comes from the credential and never the body; a
// credential whose player has no linked auth user is refused; every failure a
// caller could learn from is the same message.
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { verifyPayload } from '@/lib/passkey/cookie';
import { consumeChallenge } from '@/lib/passkey/challenge-store';
import { getRpId } from '@/lib/passkey/config';

export type LoginAssertionResult =
  | { ok: true; hashedToken: string }
  | { ok: false; status: 400 | 403 | 500; message: 'Passkey sign-in failed' | 'Passkey verification failed' };

function fail(status: 400 | 403 | 500 = 400): LoginAssertionResult {
  return { ok: false, status, message: 'Passkey sign-in failed' };
}

/**
 * Verifies a discoverable-credential assertion against a signed challenge
 * token and, on success, returns a single-use magic-link token hash for the
 * caller to redeem into a session.
 *
 * `tokenType` is the `type` the challenge token must carry. The web flow signs
 * 'login' into a cookie and the app flow signs 'app_login' into a response
 * body, so a token lifted from one flow is refused by the other before the
 * server-side claim is even attempted.
 *
 * `expectedOrigin` is passed straight through to simplewebauthn, which matches
 * it exactly (a string, or any one of an array). The web route passes only the
 * web origin; only the app route passes the Android apk-key-hash origins.
 */
export async function verifyLoginAssertion({
  credential,
  challengeToken,
  tokenType,
  expectedOrigin,
}: {
  credential: { id: string } & Record<string, unknown>;
  challengeToken: string | null | undefined;
  tokenType: 'login' | 'app_login';
  expectedOrigin: string | string[];
}): Promise<LoginAssertionResult> {
  const challenge = challengeToken ? await verifyPayload(challengeToken) : null;
  if (!challenge || challenge.type !== tokenType) return fail();

  // CLAIM THE CHALLENGE, SERVER SIDE (00181).
  //
  // The signed token proves the challenge was issued by us and is unexpired.
  // It cannot prove it has not already been spent: clearing a cookie is a
  // response header, so two requests carrying the same cookie and the same
  // assertion, sent before either response lands, both got this far and both
  // verified. A token in a request body has no clearing step at all. The
  // signature counter cannot catch that either: synced passkeys report 0
  // every time, so there is no regression to detect.
  //
  // One atomic UPDATE, bound to THIS flow's purpose so a challenge minted
  // elsewhere cannot be redeemed here.
  if (!(await consumeChallenge(createServiceRoleClient(), challenge.challenge as string, 'player_login'))) return fail();

  const service = createServiceRoleClient();
  const { data: stored } = await service
    .from('passkey_credentials')
    .select('id, credential_id, public_key, counter, transports, player_id')
    .eq('credential_id', credential.id)
    .maybeSingle();
  if (!stored) return fail();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge as string,
      expectedOrigin,
      expectedRPID: getRpId(),
      credential: {
        id: stored.credential_id,
        publicKey: isoBase64URL.toBuffer(stored.public_key),
        counter: Number(stored.counter),
        transports: (stored.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
      requireUserVerification: false,
    });
  } catch {
    verification = null;
  }
  if (!verification?.verified) return fail();

  // Counter regression = possible cloned authenticator. Synced passkeys
  // (iCloud/Google) always report 0, so never fail on 0.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter > 0 && newCounter <= Number(stored.counter)) return fail();

  const { data: player } = await service
    .from('players')
    .select('id, user_id, status')
    .eq('id', stored.player_id)
    .maybeSingle();
  if (!player?.user_id) return fail();

  // The canonical address lives on the auth user, not players.email: the
  // session must be minted for whatever GoTrue actually knows this account as.
  const { data: authUser, error: authErr } = await service.auth.admin.getUserById(player.user_id);
  const email = authUser?.user?.email;
  if (authErr || !email) return fail();
  if (authUser.user?.banned_until) return fail(403);

  // COMPARE AND SWAP ON THE COUNTER WE VERIFIED AGAINST, and only issue a
  // session once exactly one row has moved.
  //
  // This was a blind `WHERE id = ...` whose result was never inspected, so a
  // failed write still handed out the cookie: the stored counter stayed where
  // it was, and the next replay of the same assertion compared against the
  // same old value and passed the regression check again. The whole point of
  // persisting the counter is that it moves.
  //
  // The predicate also closes the concurrent case the audit describes: two
  // assertions verified at once both compared against the same stored value,
  // and both wrote. Now the second finds the row already moved and is refused.
  //
  // Zero-counter authenticators (iCloud- and Google-synced passkeys always
  // report 0) are NOT protected by this, because 0 -> 0 is a legitimate write
  // that any number of replays would also satisfy. That class is covered by
  // single-use challenges (00181), not by the counter.
  const { data: counterRows, error: counterErr } = await service
    .from('passkey_credentials')
    .update({ counter: newCounter, last_used_at: new Date().toISOString() })
    .eq('id', stored.id)
    .eq('counter', Number(stored.counter))
    .select('id');
  if (counterErr || !counterRows || counterRows.length === 0) {
    return { ok: false, status: 400, message: 'Passkey verification failed' };
  }

  // GoTrue has no WebAuthn grant, so a session is minted the supported way:
  // generateLink produces a single-use token WITHOUT sending mail, and the
  // caller redeems it with verifyOtp. The token never leaves the server.
  const { data: link, error: linkErr } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const hashedToken = link?.properties?.hashed_token;
  if (linkErr || !hashedToken) return fail(500);

  return { ok: true, hashedToken };
}
