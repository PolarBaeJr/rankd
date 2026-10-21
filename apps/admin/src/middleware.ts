import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import {
  canAccess,
  permissionsOf,
  UNRESTRICTED,
  type AccessLevel,
  type PermissionsInput,
} from '@/lib/permissions';
import { PASSKEY_VERIFIED_COOKIE } from '@/lib/passkey/config';
import { verifyPayload } from '@/lib/passkey/cookie';
import { isPasswordOnlySession } from '@/lib/password-session';
import { consolePasskeyGrace, parseGraceGate } from '@/lib/passkey/grace';
import {
  AUTH_COOKIE_OPTIONS,
  hostOnlyAuthCookieClears,
  duplicateAuthCookieClears,
} from '@badminton/shared/src/utils/constants';
import { getServerSupabaseUrl } from '@badminton/shared/src/utils/supabase-url';

export async function middleware(request: NextRequest) {
  // Container health probes come first, for the same second reason spelled out
  // for passkey sign-in below: the catch at the bottom of this function
  // redirects to /login WITHOUT consulting isPublicRoute, so any blip in
  // auth.getUser() would 307 the healthcheck — and a 307 now fails the check
  // and marks a working console unhealthy. The matcher at the bottom already
  // excludes these; this is the second of two independent guards.
  //
  // Paths here are basePath-RELATIVE (Next strips /admin before matching), so
  // this reads /api/health/ while the URL the healthcheck probes is
  // /admin/api/health/ready. Trailing slash so /api/healthfoo cannot match.
  if (request.nextUrl.pathname.startsWith('/api/health/')) {
    return NextResponse.next();
  }

  // Passkey SIGN-IN is let through before anything else, including before the
  // Supabase client is built. Two reasons it can't just join isPublicRoute
  // below:
  //   1. It has no session by definition — it is how you get one.
  //   2. The catch at the bottom of this function redirects to /login WITHOUT
  //      consulting isPublicRoute, so any blip in auth.getUser() would 307 these
  //      endpoints to the login page. fetch() follows redirects silently, so the
  //      browser would hand login-page HTML to startAuthentication() and report
  //      a cheerful 200 — the same trap /api/cron fell into (see below).
  // Trailing slash so a route like /api/passkey/loginfoo can never match. The
  // enrol (/register) and step-up (/auth) endpoints deliberately stay behind the
  // session check: those are second factors, not ways in.
  if (request.nextUrl.pathname.startsWith('/api/passkey/login/')) {
    return NextResponse.next();
  }

  // Inbound webhooks get the same treatment, for the same second reason. SNS
  // presents no session cookie, so /admin/api/webhooks/ses answered every POST
  // with a 307 to /admin/login — SNS could not even complete subscription
  // confirmation, so no bounce or complaint was ever recorded and the SES
  // complaint rate climbed unseen. isPublicRoute alone would not be enough:
  // the catch at the bottom redirects to /login without consulting it, so a
  // blip in auth.getUser() would silently un-fix this. Each handler under
  // /api/webhooks authenticates its own caller (the SES route verifies the
  // Amazon signature and pins the topic ARN, failing closed on both).
  // Trailing slash so a route like /api/webhooksfoo can never match. Skipping
  // finish() here also skips the stale-cookie cleanup, deliberately: a webhook
  // caller has no cookie jar to tidy.
  if (request.nextUrl.pathname.startsWith('/api/webhooks/')) {
    return NextResponse.next();
  }

  // Console commands from the Discord bot, for the same two reasons. The bot
  // has no session cookie, and the catch at the bottom redirects to /login
  // without consulting isPublicRoute. Each handler under /api/discord checks
  // the service secret itself and resolves the linked exec; nothing here may
  // import those handlers' actor store, which is Node-only.
  if (request.nextUrl.pathname.startsWith('/api/discord/')) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  // See the identical block in the player middleware: expires host-only auth
  // cookies left behind when the cookie became domain-scoped, on whichever
  // response this function returns.
  const staleClears = duplicateAuthCookieClears(request.headers.get('cookie'));
  const finish = <T extends NextResponse>(response: T): T => {
    staleClears.forEach((c) => response.headers.append('set-cookie', c));
    return response;
  };

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
          // Raw append, not .cookies.set: ResponseCookies is keyed by name
          // alone and would clobber the domain-scoped write above.
          hostOnlyAuthCookieClears(cookiesToSet).forEach((c) =>
            supabaseResponse.headers.append('set-cookie', c)
          );
        },
      },
    }
  );

  const isPublicRoute =
    request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/auth') ||
    // Scheduled jobs carry a shared secret, not a session cookie. Without this
    // the middleware redirected them to /login — and because pg_net follows
    // redirects, the cron job recorded a cheerful 200 (the login page HTML)
    // while no reminder was ever sent. Each handler under /api/cron checks the
    // secret itself and answers 401/503 when it is wrong or unset.
    request.nextUrl.pathname.startsWith('/api/cron') ||
    request.nextUrl.pathname === '/unauthorized' ||
    request.nextUrl.pathname === '/unavailable';

  try {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user && !isPublicRoute) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return finish(NextResponse.redirect(url));
    }

    if (user && !isPublicRoute) {
      // ONE round trip for both halves of the decision: the level, and the raw
      // permission triple. The database returns the triple and nothing else —
      // resolving it is permissionsOf()'s job, in the same module the server
      // actions use, so there is no SQL implementation of the rule to drift.
      const { data: access, error: accessError } =
        await supabase.rpc('admin_console_access', { p_user_id: user.id });

      let accessLevel: AccessLevel | null = null;
      let permissions = UNRESTRICTED;

      if (accessError) {
        // FAIL CLOSED FOR AN EXEC, and let admins and trainers through. This
        // deliberately inverts what this file used to do, and the asymmetry is
        // the point.
        //
        // Failing open was correct the day 00086 shipped, because every row was
        // NULL and "nobody is narrowed" was simply true. That property is
        // TIME-DEPENDENT: it stops holding the moment anything is assigned, and
        // from then on an RPC failure would silently restore full access to
        // every narrowed exec — invisibly, including access an admin had
        // deliberately taken away. A silent grant leaves no trace; a lockout is
        // loud within minutes.
        //
        // TRAINERS STILL GO THROUGH, and that is now a judgement rather than an
        // impossibility. A trainer used to be uncomposable, so a failure had
        // nothing to restore to them; they can be composed now, and the fallback
        // hands a composed one the trainer BASELINE — three capabilities, the
        // roster and varsity notes, which every trainer holds today. So the
        // exposure is capped at three things nobody has ever been refused, and
        // the expected direction of composing a trainer is widening, where the
        // fallback lands on LESS access rather than more. Failing them closed
        // would instead lock every ordinary trainer out of the console during an
        // outage to protect a revoke that may not exist.
        //
        // Admins are superusers by level and hold no stored capabilities — and
        // they are the people who can repair whatever broke, so they must never
        // be the ones locked out.
        const { data: level } = await supabase.rpc('admin_access_level', { p_user_id: user.id });
        accessLevel = (level as AccessLevel | null) ?? null;
        if (accessLevel === 'exec') {
          const url = request.nextUrl.clone();
          url.pathname = '/unavailable';
          url.search = '';
          // Not /unauthorized: this is not a decision about them, it is the
          // console being unable to make one, and the two need different words
          // or the exec goes hunting for a permission problem that does not
          // exist. The commonest cause by far is 00087 not being applied.
          url.searchParams.set('reason', 'permissions');
          // Where they were going, so Try again resumes it rather than dumping
          // them on the dashboard. Sanitised on the page — it is a URL anyone
          // can type, and an unchecked one is an open redirect.
          url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
          return finish(NextResponse.redirect(url));
        }
      } else {
        // Null when there is no player row at all, which resolves to no level
        // and therefore to no access — the same answer admin_access_level()
        // gave on its own.
        const row = access as (PermissionsInput & { level: string | null }) | null;
        accessLevel = (row?.level as AccessLevel | null) ?? null;
        // The LEVEL the same row carried, so the middleware floors on exactly
        // what every server action floors on. A gate that resolved a different
        // baseline from the action behind it is a nav that hides sections the
        // page would serve.
        permissions = permissionsOf(accessLevel, row);
      }

      // TWO DIFFERENT REFUSALS, because they are two different facts about the
      // person being refused.
      //
      // Somebody with NO console access at all belongs on /unauthorized: there
      // is nowhere in here for them, and the page says so.
      //
      // Somebody who IS a console user and simply lacks THIS section does not.
      // Sending a finance-scoped exec who clicks Audit to a dead-end page reads
      // as "you should not be here at all", which is false and is exactly how a
      // narrowed officer concludes their account is broken. They go to the
      // dashboard — the one page every console user can open, and the one that
      // now signposts what they CAN reach.
      //
      // `next` carries what they were denied so the dashboard can say so once,
      // rather than silently swallowing the click. Sanitised there: it is a URL
      // anyone can type, and an unchecked one is an open redirect.
      if (!canAccess(accessLevel, permissions, request.nextUrl.pathname)) {
        const url = request.nextUrl.clone();
        // THE LOOP GUARD, and it is not hypothetical: sending every refusal to
        // /dashboard means a refusal OF /dashboard redirects to itself forever.
        // /dashboard needs no capability today, so this is unreachable — which
        // is exactly why it must be written down rather than relied upon. One
        // capability added to that route and the console becomes an infinite
        // redirect for whoever lacks it.
        const canLandOnDashboard =
          accessLevel !== null && request.nextUrl.pathname !== '/dashboard';
        url.pathname = canLandOnDashboard ? '/dashboard' : '/unauthorized';
        url.search = '';
        if (canLandOnDashboard) {
          url.searchParams.set('denied', request.nextUrl.pathname);
        }
        return finish(NextResponse.redirect(url));
      }

      // Passkey gate: once a user has enrolled a console passkey, every page
      // needs a valid signed verified-cookie. With none, the console opens for
      // 14 days from the first visit (lib/passkey/grace.ts, 00262), then only
      // /passkey-required, where they add one. The /api/passkey handlers are
      // exempt: they are how you GET verified.
      //
      // IT USED TO FAIL OPEN. The reasoning was sound as far as it went — the
      // outer catch redirects to /login, and a gate failure there loops for
      // ever — but the conclusion did not follow. "Cannot determine whether
      // this admin has a passkey" was resolved as "they do not", which is the
      // grace-period answer, so any RPC failure switched the console's second
      // factor off for everyone at once and logged it to a console nobody
      // reads.
      //
      // /unavailable is the answer to both problems: it is already exempt from
      // this gate, so there is no loop, and it already exists to say "the
      // console cannot make a decision about you right now" for the
      // permissions outage a few lines up. Same shape, same page, new reason.
      const pathname = request.nextUrl.pathname;
      if (!pathname.startsWith('/unavailable') && !pathname.startsWith('/api/passkey')) {
        try {
          const token = request.cookies.get(PASSKEY_VERIFIED_COOKIE)?.value;
          const payload = token ? await verifyPayload(token) : null;
          if (!payload || payload.sub !== user.id) {
            // One call answers "do they hold a console passkey" and, if not,
            // when their window started, writing it on the first visit. It
            // replaced has_passkeys here; that function stays for rollback.
            const { data: gateData, error } = await supabase.rpc('console_passkey_grace_start');
            if (error) throw new Error(error.message);
            const gate = parseGraceGate(gateData);
            if (!gate) throw new Error('console_passkey_grace_start returned an unexpected shape');
            if (gate.hasConsolePasskey) {
              const url = request.nextUrl.clone();
              url.pathname = '/unavailable';
              url.search = '';
              url.searchParams.set('next', pathname + request.nextUrl.search);
              return finish(NextResponse.redirect(url));
            }
            // No console passkey: the 14-day window, but never for a password.
            // The member app's password sign-in shares this cookie, and a
            // password alone must not open the console (see password-session).
            // Decodes the token getUser() already validated; no network call.
            // A failure here throws into the catch below, which holds the door.
            const { data: aal, error: aalError } =
              await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
            if (aalError) throw new Error(aalError.message);
            if (isPasswordOnlySession(aal?.currentAuthenticationMethods)) {
              const url = request.nextUrl.clone();
              url.pathname = '/login';
              url.search = '';
              url.searchParams.set('reason', 'code-required');
              return finish(NextResponse.redirect(url));
            }
            // A console user always gets a row, so a missing start is an
            // anomaly and the door stays shut.
            if (!gate.graceStartedAt) throw new Error('console passkey window has no start');
            const standing = consolePasskeyGrace(gate.graceStartedAt, Date.now());
            if (!standing) throw new Error('console passkey window start is unreadable');
            if (standing.expired && pathname !== '/passkey-required') {
              // JSON for an API call, never a redirect: fetch() follows it
              // silently and hands the caller HTML (see /api/passkey/login).
              if (pathname.startsWith('/api/')) {
                return finish(NextResponse.json(
                  { error: 'Add a console passkey to keep using the console' },
                  { status: 403 },
                ));
              }
              const url = request.nextUrl.clone();
              url.pathname = '/passkey-required';
              url.search = '';
              url.searchParams.set('next', pathname + request.nextUrl.search);
              return finish(NextResponse.redirect(url));
            }
            // Inside the window, on any other sign-in method: proceed.
          }
        } catch (err) {
          // console, not Sentry: this file runs in the edge runtime and has no
          // Sentry client. The redirect is what makes the failure visible now —
          // an admin who is sent to /unavailable reports it, which is more than
          // the log line alone ever achieved.
          console.error('Passkey gate check failed (holding the door):', err);
          const url = request.nextUrl.clone();
          url.pathname = '/unavailable';
          url.search = '';
          url.searchParams.set('reason', 'passkey-unavailable');
          url.searchParams.set('next', pathname + request.nextUrl.search);
          return finish(NextResponse.redirect(url));
        }
      }
    }
  } catch {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return finish(NextResponse.redirect(url));
  }

  return finish(supabaseResponse);
}

export const config = {
  // PWA assets (manifest, icons) must stay public — an auth redirect here
  // breaks installability. The player app has carried this exclusion list since
  // it shipped; the console never got one, so /admin/manifest.json and
  // /admin/icon-*.png all 307'd to /admin/login. That was invisible only while
  // the console's <head> pointed at the origin root (i.e. at the PLAYER app's
  // assets) — fixing that without this turns a cosmetic mix-up into a console
  // that cannot be installed at all.
  //
  // api/health/ is excluded for a different reason: the container healthcheck
  // runs inside the container with no session, and the check now requires
  // exactly 200, so a 307 to /admin/login would report a working console as
  // unhealthy rather than being silently swallowed as it was under status<500.
  //
  // tesseract/ is the self-hosted OCR (app/fees/receipt-ocr.ts): a worker and
  // its wasm fetched by the browser, public files with nothing to gate, and a
  // redirect to the login page in their place would only break the read.
  //
  // Paths here are basePath-RELATIVE: Next strips /admin before matching.
  // No sw.js entry: the console registers no service worker (see app/layout.tsx).
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-192.png|icon-512.png|apple-touch-icon.png|api/health/|tesseract/).*)',
  ],
};
