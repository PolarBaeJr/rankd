# Android app

The native Android app: Kotlin, Jetpack Compose, application id
`com.clubladder.app`. Building and configuring it is in
`../docs/05-development.md`; how it signs in and keeps a session is in
`../docs/02-auth.md`.

| | |
|---|---|
| Gradle | 9.7.0 (wrapper) |
| Android Gradle Plugin | 9.3.1 |
| Kotlin | 2.4.20 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 28 |
| Compose BOM | 2026.06.01 |
| Lifecycle | 2.10.0 |
| Credential Manager (androidx.credentials) | 1.6.0 |

Compose and lifecycle are held at those versions because their next releases need
compileSdk 37.

Libraries are kept few on purpose: Compose, activity and lifecycle, coroutines,
kotlinx.serialization, Credential Manager for passkey sign-in, Google's code
scanner and a QR encoder. No Supabase SDK
and no HTTP client library; networking is `HttpURLConnection`.

Credential Manager needs `credentials-play-services-auth` on API 33 and below
(minSdk is 28), which brings Play services auth, FIDO and fragment with it;
`credentials` 1.6.0 itself brings biometric, and with it appcompat. That is the
passkey cost: the unsigned release APK went from about 2.4 MB to about 3.2 MB
(about 1.2 MB to 1.6 MB to download). None of it starts with the app: the merged
manifest gains no content provider or startup initializer, and Credential
Manager is created only when a member taps the passkey button.

The website's fonts cost about 148 KiB more to download. The unsigned release APK
went from 3,174,477 to 3,362,620 bytes on disk and from 1,557,102 to 1,708,699
bytes to download (apkanalyzer), a rise of 151,597 bytes. Nearly all of it is the
five latin-only TTFs in `res/font` (compressed in the APK: Barlow 400, 600 and 700
about 19 KB each, Barlow Condensed 700 about 18 KB, the variable JetBrains Mono
about 37 KB); the vector icons and the licence texts in `assets/licenses` are a
few KB. Where the fonts come from is in `../assets/fonts/README.md`.

Challenges, the scanner and the member QR, measured on the unsigned release APK
with apkanalyzer (bytes on disk / bytes to download):

| Step | File size | Download size |
|---|---|---|
| Before | 3,362,620 | 1,709,404 |
| `play-services-code-scanner` 16.1.0 and the scanner call | 3,595,597 | 1,805,424 |
| `io.nayuki:qrcodegen` 1.8.0 and the member QR | 3,612,712 | 1,812,501 |
| The challenge screens, routing and App Links | 3,813,776 | 1,917,286 |

The code scanner holds no scanning model in the APK (Play services downloads it,
`barcode_ui` in the manifest asks for it ahead of the first scan) and adds no
CAMERA permission. It does bring ML Kit's start-up provider
(`MlKitInitProvider`) and Google's datatransport telemetry, which adds
`ACCESS_NETWORK_STATE`.

It runs on the emulator against staging. The restyled sign-in screen, launcher
icon and cold start have been checked there; the restyled signed-in screens have
not been checked on a device yet.

## Before it can ship

1. A Google Play Console account, 25 USD once. Same governance question as iOS: see
   `../ios/README.md`.
2. Release signing. The upload key is a secret and never lands in this repo, which is
   public.
3. For passkeys, `https://<rpId>/.well-known/assetlinks.json` (for production,
   `https://example.com`) listing the package name and **every** signing
   certificate SHA-256: debug, upload key and Play App Signing. The route that
   serves it is on `feat/passkey-native-app`; see `../docs/02-auth.md`. The release
   build also needs `badminton.siteUrl` set, or it offers no passkey button.
