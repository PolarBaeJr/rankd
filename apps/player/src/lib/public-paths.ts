// Which paths the sign-in gate lets through without a session.
//
// Extracted from middleware.ts so it can be tested directly. It used to be an
// inline boolean chain, which meant the one thing worth asserting — that a
// machine caller with its own credential is not redirected to a login page —
// could only be checked by running the whole edge middleware with a mocked
// Supabase client. It was not checked, and /api/discord/* shipped behind the
// gate: the bot would have followed the 307 to /login, received HTML under a
// 200, and failed parsing it as JSON.

/**
 * True when `pathname` is reachable without a session.
 *
 * Two kinds of entry live here and they are worth telling apart:
 *
 *  - PAGES anyone may read (`/`, `/legal`, `/leaderboard`, `/membership`,
 *    `/socials`, `/whats-new`).
 *  - ROUTES THAT CARRY THEIR OWN CREDENTIAL — a signed token, a bearer secret,
 *    a passkey challenge. These are not "public" in the sense of unprotected;
 *    they are protected by something the session gate cannot see, and putting
 *    them behind it turns a 401 into an HTML redirect the caller cannot read.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    // Creating an account happens without one, by definition. Exact: no subroutes.
    pathname === '/signup' ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/exec') ||
    // Legal documents (terms, privacy, waiver, conduct) are public reading.
    pathname.startsWith('/legal') ||
    // ICS feed for calendar clients — token-authenticated, no session cookie.
    pathname.startsWith('/api/calendar') ||
    // One-click unsubscribe. Authenticated by the signed token in the link, not
    // by a session — and it MUST work without one. RFC 8058 is a machine POST
    // from the mail client with no cookies at all, and a mail client treats any
    // non-2xx as a failed unsubscribe, which pushes the recipient toward the
    // spam button instead.
    pathname.startsWith('/unsubscribe') ||
    // Tournament check-in QR. Someone scanning at the door may well be logged
    // out; the page itself requires a session before it changes anything.
    pathname.startsWith('/tournaments/checkin') ||
    // Passkey sign-in. Necessarily reachable without a session — completing it
    // is what creates one. Only the /login pair; /register still needs one.
    pathname.startsWith('/api/passkey/login') ||
    // The native app's passkey sign-in pair, same reason. Only app/login, with
    // the trailing slash; never /api/passkey/app/ wholesale, so anything added
    // under it later (an app enrolment route, say) is gated until someone
    // decides otherwise here.
    pathname.startsWith('/api/passkey/app/login/') ||
    // The native app's routes. They carry the member's Supabase access token as
    // a bearer and check it themselves (resolveAppActor); the app has no cookie
    // for the gate to see, and a 307 to /login would reach it as HTML. Trailing
    // slash so /api/appx can never match.
    pathname.startsWith('/api/app/') ||
    // assetlinks.json and apple-app-site-association. Android and Apple fetch
    // these anonymously and neither follows a redirect, so behind the gate the
    // 307 to /login reads as "no app is trusted" and passkeys stop working in
    // the native app with nothing logged. The matcher in middleware.ts excludes
    // the prefix too; this is the testable guard.
    pathname.startsWith('/.well-known/') ||
    // The Discord bot's surface. It authenticates as a SERVICE (constant-time
    // bearer compare in isAuthorizedDiscordService, which fails closed when the
    // secret is unset) and has no session cookie at all.
    //
    // Trailing slash so /api/discordfoo can never match, same as api/health/.
    // API ONLY: /link/<token> is a PAGE and must stay gated — needing a session
    // is the entire point of it.
    pathname.startsWith('/api/discord/') ||
    // The Discord invite QR the bot's /discord embed points at. Discord's image
    // proxy fetches it anonymously, with none of our cookies, so gating it
    // turns the fetch into a 307 to /login and the embed renders blank with
    // nothing logged. The matcher in middleware.ts excludes it too; this is the
    // second of the two independent guards, and the testable one.
    pathname.startsWith('/qr/') ||
    pathname === '/leaderboard' ||
    // Prices and where to buy a membership, for somebody deciding whether to
    // join. Exact: the page has no subroutes. The statement a member owes is
    // /fees, which stays gated.
    pathname === '/membership' ||
    // Release notes, readable before joining. Exact: no subroutes.
    pathname === '/whats-new' ||
    // The club's social links. Exact, same reason.
    pathname === '/socials' ||
    // A guest with no account signs the waiver here, and the proof link under
    // it is opened by whoever holds it. By whole segment, so /guest-waiverX
    // stays gated.
    pathname === '/guest-waiver' ||
    pathname.startsWith('/guest-waiver/')
  );
}
