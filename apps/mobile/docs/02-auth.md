# Auth

## Email code: what the app does today

`auth/EmailCode.kt` ports the player web app's email code client
(`apps/player/src/lib/email-code-client.ts`).

- **Send** calls GoTrue `/otp` with `create_user: false`, so only an existing
  account gets a code. Accounts are created on the website, where the waivers are.
  A send that fails the way an idle auth gateway fails is retried once, silently.
- **Verify** tries each OTP type GoTrue may have issued, then makes the web login's
  check: no `players_self` row means an account that never finished signing up. That
  session is logged out on this device, never kept, and the sign-in screen says why.

## Token storage

Sessions are tokens, not cookies. The web cookie name is pinned and must never be
renamed, but this app never sees it.

The session is one file, `session.bin` in the app's private files directory:

- AES-256-GCM under a key in the **Android Keystore** that never leaves it. No user
  authentication on the key: a routine launch must refresh a token without asking
  for a fingerprint. EncryptedSharedPreferences is not used (androidx
  security-crypto is deprecated).
- Written through `AtomicFile`, so a crash mid write never leaves a torn file.
- Excluded from cloud backup and device transfer, and `allowBackup` is false. A copy
  on another phone could not be decrypted anyway.
- Anything that cannot be decrypted or parsed is deleted and reads as signed out.

On iOS the session is one generic-password **Keychain** item
(`Auth/KeychainSessionStore.swift`): `AfterFirstUnlockThisDeviceOnly`, so a
background refresh can read it, and never synchronizable, so it never syncs to
iCloud or moves to another phone. A value that does not read back as a session is
deleted and reads as signed out, as on Android. The Keychain outlives an uninstall,
so a UserDefaults marker (which does not) clears a leftover session on the first
launch after a reinstall; that is the reason `PrivacyInfo.xcprivacy` declares for
UserDefaults.

## Refresh

`auth/SessionManager.kt` is the one owner of the session. Every token read refreshes
first if the token is within 90 seconds of expiry.

Refresh is **single flight** behind a mutex, because GoTrue rotates the refresh token
on use: two refreshes racing with the same token would have the second refused and
sign the member out. The new session is written to disk before it is published, so a
process killed in between never wakes holding a spent refresh token.

A 4xx from the refresh grant ends the session. Anything else (offline, a gateway 5xx)
keeps it for the next attempt. The app also refreshes when it returns to the
foreground.

## Passkeys

Sign-in only, with the passkeys members already use on the website. Enrolling a
passkey stays on the website: the app never creates one, and the sign-in screen
says so. The button shows only when the build names the club website
(`badminton.siteUrl`), and hides for the rest of the screen's life once passkeys
prove unavailable.

The server half is on branch `feat/passkey-native-app` (not merged here), with
operating detail in `docs/ops/native-app-passkeys.md` on that branch:

- `POST /api/passkey/app/login/options` returns the WebAuthn options with a signed
  `challengeToken` in the body instead of a cookie, or 503 when the server has no
  passkey secret.
- `POST /api/passkey/app/login/verify` takes the credential and that token and
  returns the Supabase session tokens in the body, with no user object.
- `/.well-known/assetlinks.json` is built from `PASSKEY_ANDROID_CERT_SHA256`
  (comma separated signing certificate fingerprints) and `PASSKEY_ANDROID_PACKAGE`
  (empty means `com.clubladder.app`). With no fingerprint it answers 404.

What the app does (`auth/PasskeySignIn.kt`, `auth/PasskeyApi.kt`,
`auth/CredentialManagerAuthenticator.kt`):

1. **Fresh options on every attempt.** The server claims the challenge before it
   verifies anything, so any attempt burns it and a retry with the old token always
   fails. Nothing is cached.
2. The `options` object goes to Android's Credential Manager as the server wrote it,
   never decoded into a class, so a field the app does not know still gets there.
   On API 33 and below Credential Manager goes through Play services
   (`credentials-play-services-auth`); on 34 and up through the platform.
3. The assertion goes back as `credential`, a JSON **object**, with the
   `challengeToken` unchanged. A credential sent as a string holding JSON is a
   silent 400.
4. The reply has no user object, so the user id is the access token's `sub` claim
   (and the email its optional `email` claim). The JWT is read, not verified: it
   came over TLS from our own server.
5. The same `players_self` check as the email code (`auth/AccountCheck.kt`): no row
   means an unfinished account, logged out on this device and never kept. The
   session is stored exactly as an email code's is, so refresh and sign-out need
   nothing new.

Errors. Every server failure is the same "Passkey sign-in failed" by design, so the
status is all there is:

| What happened | Shown |
|---|---|
| no response | Could not reach the club website (AUTH-205) |
| 429 at the edge | Too many attempts (AUTH-202) |
| options 503, or no passkey provider on the phone | no error; the button hides and a line suggests an email code |
| any other 5xx, except a verify 500 | The sign-in service did not answer (AUTH-205) |
| 400, 403, a verify 500, an unreadable reply, any authenticator failure | Signing in with your passkey did not work (AUTH-208) |
| no passkey on the phone | a line saying to sign in with a code, then add one on the website |

Only a real cancel (the member dismissed the sheet) is silent. A DOM
`NotAllowedError` is **not** treated as a cancel: a broken assetlinks file or an RP
ID mismatch can surface as exactly that (not yet confirmed on a device), and
reading it as a cancel would make a misconfigured server look like a member who
changed their mind. The website's passkey client learned the same. Nothing logs
the options, the assertion or the tokens.

Three ways this goes wrong late:

1. **The RP ID must match what the existing web passkeys were registered against.**
   If it does not, every passkey already enrolled is invisible to the app, and it
   presents as "passkeys just do not work on mobile" rather than as a configuration
   error.
2. **Every signing certificate must be listed.** The debug keystore, the upload key
   and Play App Signing's key all sign installable builds. A missing fingerprint
   makes passkeys work throughout testing and fail the moment the app ships.
3. **assetlinks is checked at the RP ID's host, not the website's.** Credential
   Manager fetches `https://<rpId>/.well-known/assetlinks.json`, and the RP ID may be
   a parent of the site's host. A file served only on the site's own host then does
   nothing, and every attempt fails as a passkey failure (AUTH-208).

### On iOS

`Auth/PasskeySignIn.swift` and `Auth/PasskeyApi.swift` follow the same five steps
against the same routes, with `ASAuthorizationPlatformPublicKeyCredentialProvider`
(`Auth/ASAuthorizationAuthenticator.swift`) in place of Credential Manager. The
differences:

- iOS lets the app use the RP ID's passkeys only when the website's
  `/.well-known/apple-app-site-association` lists `<TEAMID>.com.clubladder.app`
  under `webcredentials` (`PASSKEY_IOS_APP_IDS`) and the build carries the
  associated-domains entitlement. That needs a signed build and an Apple team, so
  on an unsigned simulator build every attempt fails as AUTH-208. The owner's
  steps are in `../ios/README.md`.
- The options are decoded, not passed through: `ASAuthorization` takes the
  challenge, RP ID, allowed credentials and user verification as values, not JSON.
  The assertion is written back as the same JSON object, in the web client's field
  order.
- Only `ASAuthorizationError.canceled` is silent. A failure is never read as a
  cancel, for the same reason as on Android. With no passkey on the phone, the
  sheet offers other devices instead and dismissing it arrives as a cancel, so the
  no-passkey line is probably never shown on iOS. That is unverified until tried on
  a device.
- The server accepts `https://<rpId>` as an app origin on the strength of Apple's
  documentation. Read `clientDataJSON.origin` from the first real iOS assertion to
  confirm it.

These files belong to production, `example.com`, and must not redirect. Serving
them from staging proves staging works (see `05-development.md`), not production.
