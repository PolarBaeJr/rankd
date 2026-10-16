import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  parseCertFingerprints,
  fingerprintToApkKeyHashOrigin,
  getAndroidOrigins,
  getAppExpectedOrigins,
  buildAssetLinks,
  buildAppleAppSiteAssociation,
} from '../passkey/native-apps';

// The origin string is the one thing here that cannot be eyeballed: Android
// puts `android:apk-key-hash:<base64url of the cert digest>` in clientDataJSON
// and simplewebauthn compares it EXACTLY. One wrong character (standard base64
// instead of url-safe, a trailing `=`) and every sign-in from the app fails
// with the uniform message and nothing to go on. So the encoding is pinned to a
// fixed vector and cross-checked against Node's own base64url.

const SEQ = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const SEQ_ORIGIN = 'android:apk-key-hash:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

function colonHex(bytes: Buffer): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('fingerprintToApkKeyHashOrigin', () => {
  it('encodes the 00..1F vector', () => {
    expect(fingerprintToApkKeyHashOrigin(SEQ)).toBe(SEQ_ORIGIN);
  });

  // FB FF BF are the bytes whose standard base64 contains + and /, so a
  // missing url-safe substitution shows up here and nowhere else.
  it('uses the url-safe alphabet with no padding', () => {
    const bytes = Buffer.alloc(32, 0);
    bytes.set([0xfb, 0xff, 0xbf], 0);
    const origin = fingerprintToApkKeyHashOrigin(colonHex(bytes));
    expect(origin).toBe(`android:apk-key-hash:${bytes.toString('base64url')}`);
    expect(origin).not.toMatch(/[+/=]/);
  });

  it('matches Buffer base64url for random fingerprints', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(32);
      expect(fingerprintToApkKeyHashOrigin(colonHex(bytes))).toBe(
        `android:apk-key-hash:${bytes.toString('base64url')}`,
      );
    }
  });
});

describe('parseCertFingerprints', () => {
  it('returns nothing for unset or empty', () => {
    expect(parseCertFingerprints(undefined)).toEqual([]);
    expect(parseCertFingerprints('')).toEqual([]);
    expect(parseCertFingerprints(' , ')).toEqual([]);
  });

  it('normalises case and colons to colon-separated upper case', () => {
    const bare = SEQ.replace(/:/g, '').toLowerCase();
    expect(parseCertFingerprints(bare)).toEqual([SEQ]);
    expect(parseCertFingerprints(SEQ.toLowerCase())).toEqual([SEQ]);
  });

  it('splits on commas, trims, and dedupes after normalising', () => {
    const other = colonHex(Buffer.alloc(32, 0xab));
    expect(parseCertFingerprints(` ${SEQ} ,${SEQ.toLowerCase()}, ${other}`)).toEqual([SEQ, other]);
  });

  it('drops anything that is not exactly 32 bytes, with one warning that does not echo it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sha1 = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD';
    const tooLong = `${SEQ}:20`;
    const notHex = SEQ.replace('1F', 'ZZ');
    expect(parseCertFingerprints([sha1, SEQ, tooLong, notHex].join(','))).toEqual([SEQ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(' ');
    for (const bad of [sha1, tooLong, notHex]) expect(logged).not.toContain(bad);
  });

  it('does not warn when everything is valid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseCertFingerprints(SEQ);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('expected origins', () => {
  it('has no Android origins when no certificate is set', () => {
    expect(getAndroidOrigins({})).toEqual([]);
  });

  it('maps each certificate to its apk-key-hash origin', () => {
    expect(getAndroidOrigins({ PASSKEY_ANDROID_CERT_SHA256: SEQ })).toEqual([SEQ_ORIGIN]);
  });

  it('accepts the web origin, the RP ID origin, and the Android origins', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.example.test');
    vi.stubEnv('NEXT_PUBLIC_PASSKEY_RP_ID', 'example.test');
    expect(getAppExpectedOrigins({ PASSKEY_ANDROID_CERT_SHA256: SEQ })).toEqual([
      'https://www.example.test',
      'https://example.test',
      SEQ_ORIGIN,
    ]);
  });

  it('dedupes when the web origin already is the RP ID origin', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example.test');
    vi.stubEnv('NEXT_PUBLIC_PASSKEY_RP_ID', 'example.test');
    expect(getAppExpectedOrigins({})).toEqual(['https://example.test']);
  });
});

describe('buildAssetLinks', () => {
  it('is null when no certificate is set, or none is valid', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildAssetLinks({})).toBeNull();
    expect(buildAssetLinks({ PASSKEY_ANDROID_CERT_SHA256: 'not-a-fingerprint' })).toBeNull();
  });

  it('publishes both relations for the default package', () => {
    expect(buildAssetLinks({ PASSKEY_ANDROID_CERT_SHA256: SEQ })).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'com.clubladder.app',
          sha256_cert_fingerprints: [SEQ],
        },
      },
    ]);
  });

  it('takes the package name from PASSKEY_ANDROID_PACKAGE', () => {
    const links = buildAssetLinks({ PASSKEY_ANDROID_CERT_SHA256: SEQ, PASSKEY_ANDROID_PACKAGE: 'org.example.debug' });
    expect(links?.[0]?.target.package_name).toBe('org.example.debug');
  });
});

describe('buildAppleAppSiteAssociation', () => {
  it('is null when unset or when no id is valid', () => {
    expect(buildAppleAppSiteAssociation({})).toBeNull();
    expect(buildAppleAppSiteAssociation({ PASSKEY_IOS_APP_IDS: 'com.example.app, abcde12345.com.example.app' })).toBeNull();
  });

  it('lists valid ids under webcredentials, dropping invalid ones and duplicates', () => {
    expect(
      buildAppleAppSiteAssociation({
        PASSKEY_IOS_APP_IDS: ' ABCDE12345.com.example.app ,SHORT.com.example.app,ABCDE12345.com.example.app,FGHIJ67890.com.example.other',
      })?.webcredentials,
    ).toEqual({ apps: ['ABCDE12345.com.example.app', 'FGHIJ67890.com.example.other'] });
  });

  it('gives applinks the same app ids as webcredentials', () => {
    const body = buildAppleAppSiteAssociation({ PASSKEY_IOS_APP_IDS: 'ABCDE12345.com.example.app,FGHIJ67890.com.example.other' });
    expect(body?.applinks.details).toHaveLength(1);
    expect(body?.applinks.details[0]?.appIDs).toEqual(body?.webcredentials.apps);
  });

  it('claims exactly the paths the app draws, each with and without a trailing slash', () => {
    const body = buildAppleAppSiteAssociation({ PASSKEY_IOS_APP_IDS: 'ABCDE12345.com.example.app' });
    const paths = body?.applinks.details[0]?.components.map((c) => c['/']);
    const base = [
      '/leaderboard',
      '/my-stats',
      '/sessions',
      '/membership',
      '/fees',
      '/challenges',
      '/challenges/new',
      `/challenges/${'?'.repeat(36)}`,
      `/checkin/${'?'.repeat(48)}`,
    ];
    expect(paths).toEqual(base.flatMap((p) => [p, `${p}/`]));
    expect(body?.applinks.details[0]?.components.every((c) => c.comment.length > 0)).toBe(true);
    // No session detail page: the app has no screen for one.
    expect(paths?.some((p) => p.startsWith('/sessions/?'))).toBe(false);
  });
});
