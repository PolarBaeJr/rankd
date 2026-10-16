# apps/mobile

The members' phone app. Milestone 1 is a native Android app written in Kotlin with
Jetpack Compose, in `android/`: sign in by email code, the ladder, your own stats,
upcoming sessions and your membership statement, all read only. It builds and its
unit tests pass, but it has not yet been run on a device or emulator. How to build
it is in `docs/05-development.md`.

The iOS app is a separate native Swift and SwiftUI app in `ios/`, a port of the
Android one with the same screens, challenges and scanner included. It builds and
its tests pass on the simulator; it has not run on a device, because signing needs
an Apple team (`ios/README.md`).

An Expo / React Native version was built first and dropped by the owner for its
download size and memory use. It survives in git history only.

## What this is, and what it is not

It is a **separate installable app**, not a webview wrapper. No Capacitor, no
Cordova, no Trusted Web Activity. The screens are native views.

It is **not a fourth backend**. It is a fourth client of the same Supabase, on the
same footing as the player web app, the admin console and the Discord bot. Nothing
here should grow its own API.

## Scope: the player app only. The console stays on the web.

Console authorization is application layer: 93 capability gates in Next.js server
code against exactly one RLS policy that touches `is_exec`. A native console means
reimplementing all 93 per platform or moving them into the database.

It would also be the least used surface, built twice. As of 2026-09-21, eleven of
thirteen exec and admin accounts have never taken a single console action, while 34
of 47 member accounts signed in within 30 days. The player app is the one with users.

## Why this works: the writes are in the database

The player web app reads tables directly in 297 places and calls **23 Postgres
functions** for its writes, among them `submit_match_result`,
`create_challenge_atomic`, `enter_tournament_event`, `report_walkover_atomic`,
`respond_to_challenge` and `dispute_match_result`.

So the business logic is not in Next.js, it is in Postgres. The sixteen `'use server'`
files in the player app are mostly transport: authenticate, call an RPC, revalidate a
page. A native client skips the transport and calls the same functions. It is a
second caller, not a reimplementation.

Row level security is already the gate: 68 of the 69 `public` tables have RLS
enabled, and the one that does not (`discord_role_revocations`) denies
`authenticated` SELECT outright. The Android app talks to GoTrue and PostgREST
directly with the member's own JWT, so RLS applies to it exactly as it does to the
website's browser client.

**Before adding any write:** find anything the player app does inside a server
action that is *not* already behind an RPC. Each of those has to become one, or the
phone app cannot do it.

## The cost of going native: ported shared logic

`packages/shared` is TypeScript, and neither a Kotlin nor a Swift app can import it.
The rules the app needs are ported by hand into `android/app/src/main/kotlin/.../shared/`
(and from there into `ios/ClubLadder/Shared/`): active
season filtering, auth error and OTP rules, the club's clock, the fee statement,
payment methods, season records and session tracks. Each file names its TypeScript
source and says "keep in step with it".

Nothing checks that they stay in step. A change to one of those TypeScript files
needs the matching change in Kotlin and in Swift, and each app's tests only prove
its port agrees with itself. The Elo engine is **not** ported: ratings are read from the database,
never computed on the phone. Keep it that way.

## Layout

```
apps/mobile/
  android/      the Kotlin / Compose app (Gradle project)
    app/src/main/kotlin/com/clubladder/app/
      auth/       email code, GoTrue calls, the session and its encrypted store
      config/     the Supabase URL and anon key, read from BuildConfig
      data/       PostgREST queries, one file per screen's data
      net/        the HTTP transport (HttpURLConnection)
      shared/     hand ports of packages/shared rules
      ui/         Compose screens and theme
  ios/          the Swift / SwiftUI app (XcodeGen project, see ios/README.md)
  assets/       icons, splash, fonts
  docs/         the decisions, written down before the code
```

## Passkeys

Both apps sign in by email code, or by a passkey already enrolled on the website:
through Credential Manager on Android, and through AuthenticationServices on iOS,
which needs a signed build. The server side of native passkeys is on branch
`feat/passkey-native-app` (token-returning routes and
`/.well-known/assetlinks.json`). See `docs/02-auth.md`.
