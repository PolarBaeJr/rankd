// A copy of apps/player/src/lib/discord-service-auth.ts, for the console's
// /api/discord/* routes. Copied rather than shared: it uses node:crypto, and
// the @badminton/shared barrel reaches edge bundles. Keep the logic of the two identical.

import { timingSafeEqual } from 'node:crypto';

// Service authentication for /api/discord/*.
//
// These routes take the Discord user's identity as DATA (a path or query
// parameter the bot asserts), so nothing about the request itself proves who is
// calling. Without a service credential, `GET /api/discord/users/{discordId}`
// would let anyone who can reach the route read any linked member's profile, and
// the write routes added in phase 3 would let anyone RSVP as anyone.
//
// So: the bot authenticates as a SERVICE. `discordId` is then a claim the
// service is making, which the authorization layer still resolves and checks. A
// valid token gets you in the door and grants nothing on its own.
//
// Deliberately NOT the plain `!==` used by the cron routes in the admin app. A
// non-constant-time compare on a long-lived shared secret leaks it a byte at a
// time to anyone who can measure the response. The cron routes should move to
// this too; they are just not this branch's job.
export function isAuthorizedDiscordService(request: Request): boolean {
  const expected = process.env.DISCORD_SERVICE_SECRET;

  // An unset secret must FAIL CLOSED. Returning true here, or comparing
  // undefined against undefined, would leave the whole surface open on any
  // deploy where the secret failed to land, which is exactly the deploy where
  // nobody is looking.
  if (!expected) return false;

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;

  const presented = Buffer.from(header.slice('Bearer '.length));
  const secret = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, which would itself be a timing
  // signal for the length. Compare a fixed-width digest-free proxy instead: pad
  // both to the same length and AND in the length check, so every path does the
  // same work.
  const sameLength = presented.length === secret.length;
  const a = sameLength ? presented : secret;
  return timingSafeEqual(a, secret) && sameLength;
}

// 401 with no detail. Never distinguish "no header" from "wrong secret".
export function discordServiceUnauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}
