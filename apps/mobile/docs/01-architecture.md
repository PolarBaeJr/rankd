# How it fits together

Four clients, one database. The phone app is a peer of the other three, not a wrapper
around any of them.

```
                  player web (Next.js)
                  admin console (Next.js)
  Supabase  <---- Discord bot
   Postgres       Android app (Kotlin)   <- this directory
   PostgREST      iOS app (Swift)        <- this directory
   GoTrue
```

There is no Supabase SDK in the app. It makes plain HTTPS calls
(`HttpURLConnection`, JSON through kotlinx.serialization):

- **GoTrue** for four calls: send a code, verify it, refresh, and log out this
  device (`scope=local`). They are made on the wire the way auth-js makes them
  (`auth/GoTrueApi.kt`).
- **PostgREST** with the member's JWT for every read (`data/`). The RPCs
  `get_leaderboard` and `get_active_season`, and the tables `players_self`,
  `players`, `ratings`, `matches`, `sessions`, `club_fees`, `seasons`,
  `tournaments` and `club_events`. A 401 refreshes the session once and retries
  once. A failed read reaches the screen as an error, never as an empty list.
  The challenge screens also read `challenge_participants`, `challenges` and
  `matches` the way the website's challenge pages do.
- **The club website** for every write, through `apps/player/src/app/api/app/`
  (`data/AppApi.kt`). The app sends the member's JWT as a bearer and the route
  runs the website's own server action as that member: `createChallenge`, accept,
  reject, cancel, submit and confirm a result, dispute, report a walkover, and
  `checkInWithToken`. `GET /api/app/challenges/context` hands over the standing,
  the feature switch, the challenge rules and quota, and the opponents the member
  may challenge. So every write runs the website's gates, emails and
  notifications, and none is re-implemented here. A website without these routes
  answers with a redirect, a 404 or HTML; the app never follows a redirect and
  reads all three as NET-003. A write is never retried after no answer or a 5xx.

| Layer | Where it lives | Work for this app |
|---|---|---|
| Business logic | 23 Postgres functions, website server actions | none: reads call the same RPCs, writes call the website |
| Authorization | RLS, 68 of 69 public tables | none |
| Fees, sessions, auth rules | `packages/shared` | hand ported to `shared/`, kept in step by hand |
| Elo | Postgres and `packages/shared` | none, ratings are read, never computed |
| Screens and navigation | Compose, `ui/` | five tabs behind sign in (Challenges only for approved members), a QR scanner, App Links |
| Auth glue | `auth/` | email code and passkey sign-in (`02-auth.md`) |
| Push notifications | not built | see `03-push.md` |

No realtime: every screen loads on open and refreshes by pull to refresh; a
challenge's page also reads again whenever it comes back to the front.

The scan icon in the header (and "Scan the door code" on Sessions, "Scan their
QR" on the new-challenge form) opens Google's code scanner
(`play-services-code-scanner`). Play services draws the camera screen and hands
back only the text, so the app holds no CAMERA permission. `links/LinkRouter.kt`
decides where a scanned code or an App Link goes: only the build's own website
origin is the app's, and a page of it the app does not draw opens in the
browser. The member's own challenge QR on My stats is drawn with
`io.nayuki:qrcodegen` (MIT).

App Links: the manifest claims `/leaderboard`, `/my-stats`, `/sessions`,
`/membership`, `/fees`, `/challenges...` and `/checkin/...` on the host of
`badminton.siteUrl` (`siteHost` in `app/build.gradle.kts`). Verification needs the
website's `assetlinks.json` to list the build's signing certificate, the same file
passkeys already use.

The app starts in `BadmintonApp`, which builds one `AppContainer` per process so a
session has one owner. With no usable Supabase config the container has no services
and the app shows `ConfigErrorScreen` instead of starting.

## The iOS app

`ios/` is the same design in Swift and SwiftUI, file for file: GoTrue, PostgREST and
the website's `/api/app` routes over `URLSession`, with no Supabase SDK and no
third-party package. JSON goes through an ordered value type (`Net/JSONValue.swift`)
rather than `Codable`, so every request body is byte for byte what the Android app
sends, key order included. The same rules hold: a failed read is an error, never an
empty list; a redirect is never followed; a write is never retried after no answer
or a 5xx. The Android unit tests are ported to XCTest with the same inputs and
expected strings.

Where the platforms differ:

- **Scanner.** VisionKit's `DataScannerViewController`, the system's own camera
  reader, so the app ships no scanning model. Unlike Android's Play services
  scanner it runs in the app's process and needs the camera permission
  (`NSCameraUsageDescription`). The simulator has no camera; a debug build offers a
  paste field instead.
- **Member QR.** CoreImage's `CIQRCodeGenerator` (correction level M), cropped to its
  modules and redrawn with a quiet zone of exactly 4 modules, so no QR library.
- **Links.** Universal links, from the `applinks` block of the website's
  `apple-app-site-association`, claiming the same paths as the Android manifest.
  They need a signed build; until there is an Apple team the app also answers
  `clubladder://<path>`, read as the same path of the build's website. A claimed
  page the app does not draw opens in an in-app Safari view, so it cannot loop back
  into the app (`ios/README.md`).
- **Dialogs** are sheets, and confirming a cancel is an alert.
