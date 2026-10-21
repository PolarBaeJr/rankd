import { describe, expect, it } from 'vitest';
import { BLOCKED_CEREMONY_MS, isBlockedCeremony, isEmbeddedWebView } from '../passkey-client';

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

describe('isEmbeddedWebView', () => {
  it('lets Safari, SFSafariViewController and Chrome on iOS through', () => {
    expect(isEmbeddedWebView(`${IOS} Version/18.0 Mobile/15E148 Safari/604.1`)).toBe(false);
    expect(isEmbeddedWebView(`${IOS} CriOS/129.0 Mobile/15E148 Safari/604.1`)).toBe(false);
  });

  it('catches bare WKWebViews and in-app browsers on iOS', () => {
    expect(isEmbeddedWebView(`${IOS} Mobile/15E148`)).toBe(true);
    expect(isEmbeddedWebView(`${IOS} Mobile/15E148 Instagram 350.0.0`)).toBe(true);
    expect(isEmbeddedWebView(`${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]`)).toBe(true);
  });

  it('catches Android WebViews but not Chrome on Android', () => {
    expect(isEmbeddedWebView('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36')).toBe(true);
    expect(isEmbeddedWebView('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36')).toBe(false);
  });

  it('leaves desktop browsers alone', () => {
    expect(isEmbeddedWebView('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe(false);
  });
});

describe('in-app browsers that claim to be Safari', () => {
  it('names the apps whose browsers block the passkey sheet', () => {
    const claimsSafari = `${IOS} Mobile/15E148 Safari/604.1`;
    expect(isEmbeddedWebView(`${claimsSafari} Instagram 450.1.0 (iPhone15,5; iOS 26_6_2)`)).toBe(true);
    expect(isEmbeddedWebView(`${claimsSafari} [FBAN/FBIOS;FBAV/500.0]`)).toBe(true);
    expect(isEmbeddedWebView(`${claimsSafari} musical_ly_38.0 BytedanceWebview/d8a21c6`)).toBe(true);
    expect(isEmbeddedWebView(`${claimsSafari} Snapchat/13.0`)).toBe(true);
    expect(isEmbeddedWebView('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36 Instagram 350.0.0')).toBe(true);
  });
});

describe('isBlockedCeremony', () => {
  const notAllowed = Object.assign(new Error('denied'), { name: 'NotAllowedError' });

  it('treats a refusal faster than any person as a blocked browser', () => {
    expect(isBlockedCeremony(notAllowed, 158)).toBe(true);
    expect(isBlockedCeremony(notAllowed, BLOCKED_CEREMONY_MS - 1)).toBe(true);
  });

  it('leaves a real cancel silent', () => {
    expect(isBlockedCeremony(notAllowed, BLOCKED_CEREMONY_MS)).toBe(false);
    expect(isBlockedCeremony(notAllowed, 4_000)).toBe(false);
  });

  it('never fires for our own abort or other errors', () => {
    expect(isBlockedCeremony(Object.assign(new Error('x'), { name: 'AbortError' }), 10)).toBe(false);
    expect(isBlockedCeremony(Object.assign(new Error('x'), { name: 'InvalidStateError' }), 10)).toBe(false);
  });
});
