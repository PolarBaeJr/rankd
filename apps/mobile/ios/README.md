# iOS app

The members' iPhone app: native Swift and SwiftUI, iOS 17 and up, Swift 6 strict
concurrency, no third-party dependencies. It is a separate codebase from the Kotlin
Android app in `../android/`, a port of it rather than generated from it, and it
does what the Android app does: sign in by email code or passkey, the ladder, your
own stats and challenge QR, upcoming sessions, your membership statement, and
challenges (list, detail, issue, accept, reject, cancel, submit and confirm a
result, dispute, walkover), the QR scanner and door check-in.

How to build it, the gates and its size are in `../docs/05-development.md`.

## Layout

```
ios/
  project.yml         the XcodeGen spec; ClubLadder.xcodeproj is generated, not committed
  Config/             Base.xcconfig (committed), Local.xcconfig (gitignored, from the .example)
  scripts/            config-from-android.sh writes Local.xcconfig from ../android/local.properties
  ClubLadder/
    App/              the entry point, AppContainer (one set of services per process), AppModel
    Auth/             GoTrue, email code, passkeys, SessionManager, the Keychain session store
    Data/             PostgREST reads, one file per screen, and AppApi for every write
    Links/            LinkRouter: where a scanned code or an opened link goes
    Net/              the URLSession transport and the ordered JSON value
    Shared/           hand ports of packages/shared rules, as the Android app ports them
    UI/               SwiftUI screens and the theme
  ClubLadderTests/  XCTest, the Android unit tests ported with the same inputs
```

Each ported file names its Kotlin (and TypeScript) source and says to keep in step
with it. Nothing checks that they do.

## Links: universal links and the app's own URL scheme

`Links/LinkRouter.swift` is the Android router ported: only the build's own website
origin is the app's; the tab paths, `/challenges/new?opponent=<id>`,
`/challenges/<uuid>` and `/checkin/<48 hex>` open screens, and any other page of
the website opens in the browser. A claimed path the router does not draw (an
upper-case check-in token, a malformed challenge id) opens in an in-app Safari
view, which never re-enters universal-link routing, so it cannot loop back here.

Universal links need a signed build with the associated-domains entitlement, and
there is no Apple team yet. Until there is, the app also answers its own URL scheme,
which works unsigned: `clubladder://challenges/<id>` is read as
`<site>/challenges/<id>` and routed the same way. So in the simulator:

```
xcrun simctl openurl booted "clubladder://challenges/new?opponent=<player uuid>"
```

iOS asks "Open in Club Ladder?" first. Nothing on the website links to this scheme;
it is for development and for testing routing before the entitlement exists. The
entitlement itself is already written (`ClubLadder/ClubLadder.entitlements`,
`webcredentials:` for passkeys and `applinks:` for the site host) and is switched on
by `BADMINTON_ENTITLEMENTS_FILE` in step 3 below. The website's side is the
`applinks` block of `/.well-known/apple-app-site-association`
(`apps/player/src/lib/passkey/native-apps.ts`), whose paths are kept in step with
`LinkRouter.isClaimedPath`.

## Debug previews

A debug build launched with `-previewTab <tab>` draws the signed-in screens from
invented fixtures, with no services, Keychain item or network request; every write
is refused on the spot. `-previewOverlay detail|new|checkin|scan`,
`-previewSheet submit|dispute|walkover|cancel|picker` and `-previewLink <url>` open
the challenge screens, their dialogs and a routed link. See `UI/DebugPreview.swift`.
The simulator has no camera, so the scanner shows a paste field in a debug build
instead; it is compiled out of Release.

## What the owner has to do for passkeys and universal links

Nothing here needs doing for simulator builds, email-code sign-in or the custom URL
scheme. A signed device build needs:

1. Enrol in the Apple Developer Program (99 USD a year) and read the 10-character
   Team ID from the membership page. Who owns the account is a governance question:
   the exec turns over annually, and an account tied to one student leaves with them.
2. Register the App ID `com.clubladder.app` with the Associated Domains capability.
3. In `Config/Local.xcconfig`, set `DEVELOPMENT_TEAM = <TEAMID>` and
   `BADMINTON_ENTITLEMENTS_FILE = ClubLadder/ClubLadder.entitlements`. Leave both
   empty for unsigned simulator builds, which then carry no capabilities.
4. In the staging player service's environment, set
   `PASSKEY_IOS_APP_IDS=<TEAMID>.com.clubladder.app`. Then
   check that `https://<rp host>/.well-known/apple-app-site-association` answers 200
   with JSON and no redirect. The RP ID host (passkeys) and the site host (universal
   links) may differ, and the file must be served on each.
5. Deploy the `applinks` server change (the owner's call; it rides the release line).
   For development builds, set `BADMINTON_APPLINKS_MODE = ?mode=developer` and turn on
   Associated Domains Development in the device's Developer settings, so iOS fetches
   the file directly instead of through Apple's CDN cache.
6. On a device: sign in with a passkey, dismiss the sheet (nothing is said), and open
   a universal link (a member's challenge QR from the camera app).

The RP ID must match the one the existing web passkeys were registered against, or
every enrolled passkey is invisible to the app. The server assumes an iOS assertion
carries the origin `https://<rpId>`; that is from Apple's documentation, not a
captured assertion, so read `clientDataJSON.origin` on the first device test.
