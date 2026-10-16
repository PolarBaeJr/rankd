# Building it

The Android app first; the iOS app is under [iOS](#ios) below.

## Prerequisites

- A JDK 17 installed: the build pins a Java 17 toolchain (`jvmToolchain(17)`).
- The Android SDK with platform 36. Android Studio is optional; the Gradle wrapper
  (Gradle 9.7.0) is committed and does everything from the command line.

## Configure

```
cd apps/mobile/android
cp local.properties.example local.properties   # then fill in the values
```

`local.properties` is gitignored. It holds `sdk.dir` and the two public Supabase
values, `badminton.supabaseUrl` and `badminton.supabaseAnonKey`: the same URL and
anon key the player web app ships to every browser. Never the service role key.

One more value is optional: `badminton.siteUrl`, the https base URL of the club
website (the player site, not Supabase), for passkey sign-in. It must be from the
SAME environment as the Supabase URL, or a passkey session minted by one
environment is used against the other's Supabase. For production it is
`https://example.com`. Empty, or not https, only hides the passkey button.

For CI any of them can be passed as a Gradle property of the same name instead
(`-Pbadminton.supabaseUrl=...`).

A missing value still builds, as an empty string, and the app shows a configuration
screen rather than starting. The URL must be https for the same reason: the session
tokens ride on every request. A local Supabase stack on http needs an https tunnel
in front of it before the app will talk to it.

## Gates

```
./gradlew testDebugUnitTest lintDebug assembleRelease
```

Unit tests are plain JVM tests (no device). Lint aborts on any error, release builds
included. The release build is minified and resource shrunk with R8, so it is where a
missing keep rule would show. There is no signing config yet, so the release APK is
**unsigned** and cannot be installed as is; `assembleDebug` builds a debug-signed
APK instead (`app-debug.apk`).

There is no CI for this directory. Run the gates by hand.

## An emulator on Apple silicon

Not yet done for this app. Should you do it: the app's minSdk is 28 and it targets
36, and the system image must be **arm64-v8a**. An x86_64 image runs under
translation on Apple silicon and is unusably slow.

## Testing passkeys on a device

Not yet done for this app. The owner's steps, against staging first
(`<staging host>` is the staging player site):

1. The debug keystore's SHA-256:
   `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`
2. In the staging player service's environment, set
   `PASSKEY_ANDROID_CERT_SHA256` to that fingerprint (colon hex is fine), and check
   `PASSKEY_COOKIE_SECRET` exists, or every options call is a 503 and the button
   hides.
3. Read the RP ID the server uses:
   `curl -s -X POST https://<staging host>/api/passkey/app/login/options` and look at
   `options.rpId`.
4. `https://<rpId>/.well-known/assetlinks.json` must answer 200 with JSON, no
   redirect, listing `com.clubladder.app`, that fingerprint and
   `delegate_permission/common.get_login_creds`. The RP ID host may be a parent of
   `<staging host>`, and that is the host Credential Manager checks. Google's
   Digital Asset Links API (`digitalassetlinks.googleapis.com/v1/statements:list`)
   shows what Google itself sees.
5. `local.properties`: `badminton.siteUrl=https://<staging host>` and the Supabase
   URL and anon key of the SAME environment. Then `./gradlew installDebug`.
6. An emulator with a **Google Play** system image (not plain Google APIs), a Google
   account signed in and a screen lock set; or a real phone.
7. Enrol a passkey on the staging website, from the same Google account.
8. In the app: sign in with the passkey, dismiss the sheet (nothing is said), and
   try on a phone with no passkey (the no-passkey line). Do all of it on API 33 or
   below (the Play services path) and on 34 or above (the platform path).

## Committed, not generated

The Gradle project is hand written and committed. `.gitignore` in `android/` keeps
out `local.properties`, `build/`, `.gradle/`, `.kotlin/`, IDE files, keystores and
built APKs and bundles. The Gradle wrapper jar is committed on purpose.

The application id `com.clubladder.app` is permanent once a build reaches Google
Play.

## Look and feel

The app wears the club website's dark theme and nothing else: no light mode, no
dynamic colour. The tokens are the website's (`apps/player/src/app/globals.css`),
kept in `ui/theme/Theme.kt`; the type is Barlow, Barlow Condensed and JetBrains
Mono, in `ui/theme/Type.kt` with the files in `res/font`. The cards, page headers,
buttons, avatars and sign-in card copy the website's components, and the launcher
icon is the site header's shuttle mark on its red tile. Change the website first
and follow it here.

## Deferred past milestone 1

Challenges (issue, answer, cancel, submit, confirm, dispute, walkover) and the door
check-in are built in both apps, through the website's own actions
(`01-architecture.md`). Still deferred:

- Google sign in.
- Every other write: tournament entry and receipt upload. Receipts are sent from
  the website; the Membership tab says so.
- The tournament points ladder tab and the win-rate sort.
- Realtime updates (every screen refreshes by pull to refresh).
- Push notifications.
- The fees feature switch. The web shows the statement only while the switch is on
  (`playerPathVisible('/fees', ...)`); this app shows it to every approved member.
- Release signing, and the 512 px Play Store icon (a PNG render of the launcher
  icon, made when the listing is).
- A minimum version gate (see `04-release-and-versioning.md`).
- CI for this directory.
- iOS on a device: signing, passkeys and universal links wait on an Apple team
  (`../ios/README.md`).

## iOS

### Prerequisites

- Xcode with an iOS 17 or later simulator (built and tested with Xcode 27 on an
  "iPhone 17e" simulator).
- XcodeGen (`brew install xcodegen`). `ClubLadder.xcodeproj` is generated from
  `ios/project.yml` and gitignored; regenerate it after adding or removing a file.

### Configure

```
cd apps/mobile/ios
sh scripts/config-from-android.sh      # or: cp Config/Local.xcconfig.example Config/Local.xcconfig
```

`Config/Local.xcconfig` is gitignored and holds the same public values as the
Android `local.properties`: the Supabase host, the public anon key, and optionally
the club website host and the passkey RP ID. Hosts go in without `https://`, because
xcconfig reads `//` as a comment; `Info.plist` adds the scheme. The script copies the
Android values, so both apps point at the same environment, and never prints the
key. With no file the app still builds and shows the configuration screen. Never
run `xcodebuild -showBuildSettings` or `-verbose` in a shared terminal: both print
the anon key.

### Gates

```
xcodegen generate && xcodebuild test -project ClubLadder.xcodeproj -scheme ClubLadder \
  -destination 'platform=iOS Simulator,name=iPhone 17e' -quiet
```

The tests are XCTest, hosted in the app (the Keychain tests need the simulator's
ad-hoc signature, so do not add `CODE_SIGNING_ALLOWED=NO` here). The app itself
builds nothing when it is launched under test, so no test touches the network or
the member's Keychain item. The debug previews (`../ios/README.md`) draw every
screen from fixtures without an account.

There is no CI for this directory. Run the gates by hand.

### Size and memory

Measured 2026-09-27 on an unsigned Release archive (`-Osize`, dead code stripping):

```
xcodebuild archive -project ClubLadder.xcodeproj -scheme ClubLadder -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/ClubLadder.xcarchive CODE_SIGNING_ALLOWED=NO -quiet
```

| | Bytes on disk | Compressed |
|---|---|---|
| iOS `ClubLadder.app` (arm64) | 1,755,720 (the binary 1,463,680) | 786,598 (`ditto -c -k` zip) |
| Android unsigned release APK | 3,813,776 | 1,917,286 (apkanalyzer download size) |

The zip is only a stand-in for the App Store download, which Apple computes per
device after signing and thinning, so it is not measured here. Of the
.app, the five fonts are about 216 KB and the asset catalogue about 60 KB; the rest
is code, since the app links no third-party library.

Memory, with `footprint -p <pid>` on the simulator, a Debug build in preview mode
(fixture data, no network): 22 to 26 MB on every tab and challenge screen, the
highest on My stats (the QR) and the scanner's paste screen. Simulator numbers are
indicative only; measure a device build against real data before quoting them.
