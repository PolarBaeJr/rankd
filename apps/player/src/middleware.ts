import { createServerClient } from '@supabase/ssr';
import { isPublicPath } from '@/lib/public-paths';
import { NextResponse, type NextRequest } from 'next/server';
// Deep import, not the '@badminton/shared' barrel: the barrel re-exports the
// whole package and pulling it into the middleware bundle — which runs on every
// request — grew it from 208 kB to 371 kB. constants.ts has no dependencies.
import {
  CHECKIN_TOKEN_REGEX,
  DISCORD_LINK_TOKEN_REGEX,
  AUTH_COOKIE_OPTIONS,
  hostOnlyAuthCookieClears,
  duplicateAuthCookieClears,
} from '@badminton/shared/src/utils/constants';
import { getServerSupabaseUrl } from '@badminton/shared/src/utils/supabase-url';
import { VIEWER_HEADER, signViewer } from '@/lib/verified-viewer';

export async function middleware(request: NextRequest) {
  // Container health probes, before anything else — before the Supabase client
  // is even built. The matcher at the bottom already excludes them, so this is
  // the second of two independent guards, and it is worth the duplication: if
  // that lookahead is ever mis-edited, every container reports unhealthy at
  // once. Not in the isPublic list below either, because that list still pays
  // for an auth.getUser() round trip on a route that must stay dependency-free.
  //
  // Trailing slash so /api/healthfoo can never match.
  if (request.nextUrl.pathname.startsWith('/api/health/')) {
    return NextResponse.next();
  }

  // Only ever this middleware's own, minted below. A copy the caller sent could
  // never verify anyway (see lib/verified-viewer.ts), but dropping it here means
  // render never spends an HMAC check on one.
  request.headers.delete(VIEWER_HEADER);

  let supabaseResponse = NextResponse.next({ request });

  // Stale host-only auth cookies left over from before the cookie became
  // domain-scoped. Computed from the raw header (request.cookies hides the
  // duplicate) and appended to whichever response we end up returning —
  // including the redirects below, which replace supabaseResponse entirely.
  const staleClears = duplicateAuthCookieClears(request.headers.get('cookie'));
  const finish = <T extends NextResponse>(response: T): T => {
    staleClears.forEach((c) => response.headers.append('set-cookie', c));
    return response;
  };

  // Public routes viewable without an account. The predicate lives in
  // lib/public-paths.ts so it can be tested without standing up the whole edge
  // middleware — see the note there about what that cost us.
  const pathname = request.nextUrl.pathname;
  const isPublic = isPublicPath(pathname);

  // NOTHING BELOW READS `user` ON A PUBLIC PATH, so on one we do not ask for it.
  // Both gates that follow are guarded by `!isPublic`, which meant every public
  // request built a Supabase client and paid a GoTrue round trip to validate a
  // token whose answer was then discarded. For a signed-out visitor that is
  // ~free (no cookie, so supabase-js fails locally without a request), but a
  // SIGNED-IN member reading /leaderboard paid a real round trip here and a
  // second one in the root layout, which cannot reuse this one — separate
  // runtimes, no shared request memoization.
  //
  // DEFERRING THE REFRESH IS SAFE, which is the only reason this is allowed to
  // skip the call rather than merely reorder it. getUser() is also what rotates
  // an expiring token onto the response, via the setAll callback above; a
  // Server Component cannot set cookies, so this is the only server-side place
  // it happens. Skipping it does not drop the session — the refresh token does
  // not expire from inactivity, so the next non-public request refreshes it
  // then. The browser client refreshes and writes the cookie too (see
  // lib/supabase-browser.ts) wherever one is mounted.
  //
  // Through finish(), so the stale host-only cookie clears still ride along.
  if (isPublic) {
    return finish(supabaseResponse);
  }

  const supabase = createServerClient(
    getServerSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as any)
          );
          // Appended as raw headers, not via .cookies.set: ResponseCookies is
          // keyed by name alone and the second set would clobber the first.
          hostOnlyAuthCookieClears(cookiesToSet).forEach((c) =>
            supabaseResponse.headers.append('set-cookie', c)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // A scanned session QR points at /checkin/<token>, which is not public — so
  // this redirect is what a signed-out scanner actually hits, before the page
  // itself ever runs. Rewriting the path without the token dropped it, leaving
  // the scanner on /feed after sign-in and making the ?checkin= chain that
  // /login, /auth/callback and /auth/post-login all implement unreachable.
  // Only a well-formed token travels, so nothing arbitrary can ride along.
  const checkinToken = pathname.match(/^\/checkin\/([^/]+)$/)?.[1];
  const checkinSuffix =
    checkinToken && CHECKIN_TOKEN_REGEX.test(checkinToken) ? `?checkin=${checkinToken}` : '';

  // Exactly the same problem for /link/<token> from the Discord bot, and the
  // same fix. A member who taps the button while signed out would otherwise
  // land on /login with the token stripped, and the only way back is to run
  // /link again — which looks like the bot is broken.
  const discordToken = pathname.match(/^\/link\/([^/]+)$/)?.[1];
  const discordSuffix =
    discordToken && DISCORD_LINK_TOKEN_REGEX.test(discordToken) ? `?discord=${discordToken}` : '';

  // Only one can ever be set — they come from different paths. Both redirects
  // below use this: the onboarding gate drops the token just as thoroughly as
  // the sign-in one, and a member linking before they have finished setup is
  // an ordinary case, not an edge case.
  const authSuffix = checkinSuffix || discordSuffix;

  // `!isPublic` here and on the onboarding gate below is unreachable now that
  // the early return above covers it, and it is kept for the same reason the
  // health probe is checked twice: two independent guards, so that deleting one
  // cannot quietly turn a public page into a login redirect.
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = authSuffix;
    return finish(NextResponse.redirect(url));
  }

  // Onboarding gate. onboarding_completed was read by `/` alone, so anyone who
  // had not finished setup could still reach the app: signing in lands on
  // /feed, and the installed PWA opens there too (manifest start_url), neither
  // of which passes through `/`. Checking here covers every entry point.
  //
  // API routes are exempt on purpose — they authenticate themselves, and
  // redirecting one would hand the caller an HTML page under a 200.
  //
  // players_self, not players: migration 00032 revoked blanket SELECT on the
  // table, and the view is already scoped to the caller's own row.
  if (user && !isPublic && !pathname.startsWith('/onboarding') && !pathname.startsWith('/api/')) {
    const { data: self, error } = await supabase
      .from('players_self')
      .select('onboarding_completed')
      .maybeSingle();

    // Fail OPEN on a query error. A gate that fails closed would strand every
    // member on /onboarding if the view were ever unavailable; an un-onboarded
    // player slipping through is the far cheaper failure.
    if (error) {
      console.error('Onboarding gate check failed (failing open):', error.message);
    } else if (!self?.onboarding_completed) {
      const url = request.nextUrl.clone();
      url.pathname = '/onboarding';
      // Same reasoning as the sign-in redirect above: a member who scans the QR
      // before finishing setup should still end up checked in, not stranded.
      url.search = authSuffix;
      return finish(NextResponse.redirect(url));
    }
  }

  // Hand the verified id to the render that follows, so loadViewer() does not
  // ask GoTrue the same question again. The request headers a NextResponse
  // forwards are fixed when it is built, so this needs a fresh one; the old
  // one's Set-Cookie lines (a token rotated by getUser above) are copied across
  // or the refresh would be lost.
  if (user) {
    const token = await signViewer(user.id);
    if (token) {
      request.headers.set(VIEWER_HEADER, token);
      const forwarded = NextResponse.next({ request });
      supabaseResponse.headers
        .getSetCookie()
        .forEach((c) => forwarded.headers.append('set-cookie', c));
      supabaseResponse = forwarded;
    }
  }

  return finish(supabaseResponse);
}

export const config = {
  // PWA assets (manifest, service worker, icons) must stay public —
  // an auth redirect here breaks installability and SW registration.
  //
  // api/health/ likewise: the container healthcheck runs inside the container
  // with no session, so a gated probe would 307 to /login and — since the check
  // now requires exactly 200 — mark a perfectly good container unhealthy.
  //
  // qr/ is the same shape of caller again: /discord puts the QR in an embed and
  // Discord's image PROXY fetches it, anonymously and with no cookie of ours.
  // Gated, that fetch follows the 307 to /login, gets HTML under a 200, and the
  // embed renders blank with nothing logged anywhere.
  //
  // tesseract/ is static OCR code and data for the e-transfer form on
  // /membership: several megabytes a session lookup would only slow down.
  //
  // .well-known/ is the native app's trust files (assetlinks.json and
  // apple-app-site-association). Android and Apple fetch them anonymously and
  // follow no redirect, and they need no session lookup. The dot is escaped in
  // the pattern: unescaped it would match any character.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-192.png|icon-512.png|apple-touch-icon.png|email/|qr/|tesseract/|api/health/|api/discord/card/|\\.well-known/).*)',
  ],
};
