import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET as assetLinks } from '../../app/.well-known/assetlinks.json/route';
import { GET as appleAssociation } from '../../app/.well-known/apple-app-site-association/route';

// The two files the operating systems fetch to decide whether the native app
// may use this domain's passkeys. What matters is status, content type and
// that the body parses: both verifiers are unforgiving, and neither says why
// it rejected a file.

const SEQ = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/.well-known/assetlinks.json', () => {
  it('is a 404 with an empty body when no certificate is configured', async () => {
    vi.stubEnv('PASSKEY_ANDROID_CERT_SHA256', '');
    const res = assetLinks();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('serves the statement list as JSON when configured', async () => {
    vi.stubEnv('PASSKEY_ANDROID_CERT_SHA256', SEQ);
    vi.stubEnv('PASSKEY_ANDROID_PACKAGE', '');
    const res = assetLinks();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await res.json();
    expect(body[0].target).toEqual({
      namespace: 'android_app',
      package_name: 'com.clubladder.app',
      sha256_cert_fingerprints: [SEQ],
    });
  });
});

describe('/.well-known/apple-app-site-association', () => {
  it('is a 404 with an empty body when no app id is configured', async () => {
    vi.stubEnv('PASSKEY_IOS_APP_IDS', '');
    const res = appleAssociation();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('serves webcredentials and applinks as JSON when configured', async () => {
    vi.stubEnv('PASSKEY_IOS_APP_IDS', 'ABCDE12345.com.example.test');
    const res = appleAssociation();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    expect(body.webcredentials).toEqual({ apps: ['ABCDE12345.com.example.test'] });
    expect(body.applinks.details[0].appIDs).toEqual(['ABCDE12345.com.example.test']);
    expect(body.applinks.details[0].components).toContainEqual({ '/': '/challenges/new', comment: 'New challenge, from a member QR' });
  });
});
