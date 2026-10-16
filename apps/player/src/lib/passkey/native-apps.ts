// Which native apps may use this site's passkeys, and what the site publishes
// so the operating systems agree.
//
// A passkey is bound to an RP ID (example.com), and a browser proves the
// page it ran on belongs to that domain by putting the page's origin in the
// signed clientDataJSON. A native app has no page, so each platform asks the
// DOMAIN to vouch for the app instead:
//
//  - Android reads /.well-known/assetlinks.json and only lets an app whose
//    signing certificate is listed there use the domain's credentials. The
//    assertion then carries `android:apk-key-hash:<base64url sha256 of the
//    cert>` as its origin, not an https origin, so the verify route has to
//    accept those strings too.
//  - iOS reads /.well-known/apple-app-site-association and wants the app's
//    TEAMID.bundle.id under `webcredentials`. The same file's `applinks`
//    hands the paths the app draws to it as universal links.
//
// Everything is read from env at call time (runtime, server-only, never
// NEXT_PUBLIC_, which Next would freeze into the image at build time). Unset
// means "no native app": the well-known files answer 404 and the app routes
// accept only the web origins, so nothing changes for a deployment that has
// not configured an app.
//
// Keep this file free of Node-only imports, like config.ts: it only needs
// btoa, and the well-known routes should not drag node:crypto in for it.
import { getExpectedOrigin, getRpId } from './config';

type Env = Record<string, string | undefined>;

const DEFAULT_ANDROID_PACKAGE = 'com.clubladder.app';

// TEAMID (10 upper-case alphanumerics) dot bundle id. Apple ignores an entry
// that does not look like this, so publishing one would only hide the typo.
const IOS_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;

/**
 * Parses PASSKEY_ANDROID_CERT_SHA256: a comma-separated list of SHA-256
 * signing-certificate fingerprints, typically three (the debug keystore, the
 * upload key, and Play App Signing's key, which is the one real installs are
 * signed with).
 *
 * Accepts upper or lower case, with or without colons, because the tools that
 * print these disagree (keytool and Play Console use colon-separated upper
 * case; other tools print bare hex). Normalises to the colon-separated upper
 * case that assetlinks.json uses, and dedupes.
 *
 * Anything that is not exactly 32 bytes of hex is dropped with ONE warning,
 * which deliberately does not include the value: a SHA-1 pasted by mistake is
 * the likeliest error, and the warning should say "check the variable", not
 * echo configuration into logs.
 */
export function parseCertFingerprints(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let invalid = 0;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const hex = trimmed.replace(/:/g, '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      invalid++;
      continue;
    }
    const normalised = hex.toUpperCase().match(/../g)!.join(':');
    if (!out.includes(normalised)) out.push(normalised);
  }
  if (invalid > 0) {
    console.warn(
      `PASSKEY_ANDROID_CERT_SHA256: ignored ${invalid} entr${invalid === 1 ? 'y' : 'ies'} that ` +
        'were not a 32-byte SHA-256 fingerprint'
    );
  }
  return out;
}

/**
 * The origin an Android passkey assertion carries when made from an app
 * signed with this certificate: the raw 32 digest bytes, base64url without
 * padding. Same encoding as toBase64Url in cookie.ts.
 */
export function fingerprintToApkKeyHashOrigin(fingerprint: string): string {
  const hex = fingerprint.replace(/:/g, '');
  let bin = '';
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `android:apk-key-hash:${b64}`;
}

export function getAndroidOrigins(env: Env = process.env): string[] {
  return parseCertFingerprints(env.PASSKEY_ANDROID_CERT_SHA256).map(fingerprintToApkKeyHashOrigin);
}

/**
 * Every origin the APP verify route accepts. Never used by the web route,
 * which accepts the web origin alone.
 *
 * `https://<rpId>` is here because a native iOS assertion carries the RP ID's
 * origin rather than any page's. That is from Apple's documentation, not from
 * a captured assertion: verify it against a real one once the Swift app
 * exists. It is harmless meanwhile, since in production it is the web origin
 * already.
 */
export function getAppExpectedOrigins(env: Env = process.env): string[] {
  return [...new Set([getExpectedOrigin(), `https://${getRpId()}`, ...getAndroidOrigins(env)])];
}

/** Body of /.well-known/assetlinks.json, or null when no certificate is set. */
export function buildAssetLinks(env: Env = process.env) {
  const fingerprints = parseCertFingerprints(env.PASSKEY_ANDROID_CERT_SHA256);
  if (fingerprints.length === 0) return null;
  return [
    {
      // handle_all_urls lets the app open this site's links; get_login_creds
      // is the one Credential Manager checks before it will hand the app a
      // passkey for this RP ID.
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: env.PASSKEY_ANDROID_PACKAGE?.trim() || DEFAULT_ANDROID_PACKAGE,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

// The paths the iOS app opens as universal links, as AASA components. `?` is
// one character: a challenge id is a 36-character uuid and a check-in token
// 48 hex characters. Each path is claimed with and without a trailing slash;
// a query is not matched on, so /challenges/new?opponent=<id> is included.
// Session pages are NOT claimed: the app has no session screen, and a claimed
// path it cannot draw would bounce back to the browser. Keep in step with
// Links/LinkRouter.swift (isClaimedPath) in apps/mobile/ios, LinkRouter.kt and
// the Android manifest's App Links paths.
const APP_LINK_PATHS: { path: string; comment: string }[] = [
  { path: '/leaderboard', comment: 'Leaderboard tab' },
  { path: '/my-stats', comment: 'My stats tab' },
  { path: '/sessions', comment: 'Sessions tab' },
  { path: '/membership', comment: 'Membership tab' },
  { path: '/fees', comment: 'Membership tab (the fees page)' },
  { path: '/challenges', comment: 'Challenges tab' },
  { path: '/challenges/new', comment: 'New challenge, from a member QR' },
  { path: `/challenges/${'?'.repeat(36)}`, comment: 'One challenge' },
  { path: `/checkin/${'?'.repeat(48)}`, comment: 'Session door check-in' },
];

function appLinkComponents() {
  return APP_LINK_PATHS.flatMap(({ path, comment }) => [
    { '/': path, comment },
    { '/': `${path}/`, comment },
  ]);
}

/** Body of /.well-known/apple-app-site-association, or null when no app id is set. */
export function buildAppleAppSiteAssociation(env: Env = process.env) {
  const apps = [
    ...new Set(
      (env.PASSKEY_IOS_APP_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => IOS_APP_ID.test(s))
    ),
  ];
  if (apps.length === 0) return null;
  return {
    webcredentials: { apps },
    applinks: { details: [{ appIDs: apps, components: appLinkComponents() }] },
  };
}
