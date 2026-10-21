// Browser half of the passkey SIGN-IN flow (the one that starts logged out).
//
// The enrol and step-up flows call @simplewebauthn/browser directly from their
// own components — they are already inside a session and each has different
// surrounding state to manage. This is kept separate rather than folded in with
// them because it is the only one that talks to /api/passkey/login/*.
import {
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  WebAuthnAbortService,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { reportAuthFailure, errorName, errorMessage } from './auth-telemetry';
import { friendlyPasskeyError } from './passkey/errors';
import { withBase } from './base-path';

export type PasskeyResult = { ok: true } | { ok: false; error: string };

export function supportsPasskeys(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/**
 * True inside another app's built-in browser (Instagram, Facebook, a plain
 * WKWebView on iOS, an Android WebView).
 *
 * Those views report WebAuthn as supported, but the OS only shows a passkey
 * sheet to an app entitled for this domain, so the call rejects at once with a
 * NotAllowedError, which is indistinguishable from the member cancelling. The
 * result was a button that did nothing at all. Safari, SFSafariViewController
 * and Chrome on iOS all carry "Safari/" in the user agent; the bare webviews
 * do not, and Android marks its WebView with "; wv)".
 *
 * Instagram's iOS browser now claims "Safari/" as well (two members hit the
 * dead prompt in it after this check shipped), so the apps known to embed
 * their own browser are also named outright. Neither list can be complete:
 * isBlockedCeremony() below catches whichever app comes next.
 */
export function isEmbeddedWebView(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  if (IN_APP_BROWSER_MARKERS.test(ua)) return true;
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return !/Safari\//.test(ua);
  return /Android/.test(ua) && /; wv\)/.test(ua);
}

// Instagram, Facebook and Messenger, Threads ("Barcelona"), TikTok, Snapchat,
// LinkedIn, Pinterest, LINE, WeChat and KakaoTalk.
const IN_APP_BROWSER_MARKERS =
  /\b(Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|Barcelona|Threads|musical_ly|BytedanceWebview|TikTok|Snapchat|LinkedInApp|Pinterest|Line\/|MicroMessenger|KAKAOTALK)/i;

export const EMBEDDED_WEBVIEW_ERROR =
  "Passkeys don't work in this app's built-in browser. Open this page in Safari or Chrome, or use an email code.";

/** Shown when the prompt was refused before anyone could have seen it. */
export const BLOCKED_CEREMONY_ERROR =
  "This browser blocked the passkey prompt. If you opened this link from another app, open it in Safari or Chrome instead, or use an email code.";

// See the player app's copy for the full reasoning: the `webauthn` token must
// be LAST, and both the browser and @simplewebauthn/browser enforce that.
export const PASSKEY_AUTOFILL_AUTOCOMPLETE = 'username webauthn';

// One challenge cookie per app, so two overlapping ceremonies fight over it.
// Every path about to mint a fresh challenge cancels whatever is in flight.
export function cancelPasskeyCeremony(): void {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    // Nothing in flight, or no AbortController in this environment.
  }
}

// A cancelled prompt is a normal thing to do, not an error worth shouting
// about — the browser reports it as NotAllowedError / AbortError. An empty
// message tells the caller to say nothing at all.
function isUserCancellation(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * Faster than any person could see a passkey sheet and dismiss it.
 *
 * A browser that will not show the sheet at all (an in-app browser the user
 * agent checks above failed to name) rejects with the same NotAllowedError a
 * member's cancel produces, but within a few hundred milliseconds: the
 * Instagram failures in Sentry came back in 158ms. The sheet's own animation
 * takes longer than this, so a real cancel never lands under it.
 */
export const BLOCKED_CEREMONY_MS = 600;

/** A NotAllowedError that arrived too fast to be the member saying no. */
export function isBlockedCeremony(err: unknown, elapsedMs: number): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' && elapsedMs < BLOCKED_CEREMONY_MS;
}

async function errorFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return typeof body?.error === 'string' ? body.error : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Options prefetch
// ---------------------------------------------------------------------------
//
// See the player app's copy for the full reasoning. In short: iOS Safari only
// opens the passkey sheet from inside the tap, so an awaited options fetch
// between the tap and startAuthentication makes it refuse with NotAllowedError,
// which reads as a silent cancel. The options are fetched before the tap and the
// button starts synchronously. 4 minutes stays under the 5-minute challenge TTL.
export const OPTIONS_FRESH_MS = 4 * 60 * 1000;

export type OptionsCache<T> = {
  prime: () => Promise<T | null>;
  takeFresh: () => T | null;
  invalidate: () => void;
};

// Dedupes: one challenge cookie per app and the last fetch wins, so concurrent
// primes must share a single fetch.
export function createOptionsCache<T>(
  fetcher: () => Promise<T | null>,
  now: () => number = Date.now
): OptionsCache<T> {
  let promise: Promise<T | null> | null = null;
  let options: T | null = null;
  let fetchedAt = 0;
  let generation = 0;

  const isFresh = () => options !== null && now() - fetchedAt < OPTIONS_FRESH_MS;

  return {
    prime() {
      if (promise && (options === null || isFresh())) return promise;
      options = null;
      const mine = ++generation;
      const pending: Promise<T | null> = fetcher()
        .catch(() => null)
        .then((result) => {
          if (mine !== generation) return result;
          if (result === null) {
            promise = null;
            return null;
          }
          options = result;
          fetchedAt = now();
          return result;
        });
      promise = pending;
      return pending;
    },
    takeFresh() {
      return isFresh() ? options : null;
    },
    invalidate() {
      generation += 1;
      promise = null;
      options = null;
    },
  };
}

let lastOptionsError: string | null = null;

const loginOptions = createOptionsCache<PublicKeyCredentialRequestOptionsJSON>(async () => {
  lastOptionsError = null;
  const res = await fetch(withBase('/api/passkey/login/options'), { method: 'POST' });
  if (!res.ok) {
    lastOptionsError = await errorFrom(res, 'Could not start passkey sign-in.');
    return null;
  }
  return (await res.json()) as PublicKeyCredentialRequestOptionsJSON;
});

/** Fetch sign-in options ahead of the tap, so the button can start synchronously. */
export function primePasskeySignIn(): void {
  if (!supportsPasskeys()) return;
  void loginOptions.prime();
}

// Calls `callback` when the tab becomes visible again or the window regains
// focus; returns the cleanup. prime() only fetches when stale or empty, so this
// keeps a long-open login page's first tap working on iOS at no cost otherwise.
export function onPageReturn(
  callback: () => void,
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> = document
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') callback();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('focus', callback);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('focus', callback);
  };
}

/** Keep the sign-in options fresh while the page is left open. Returns the cleanup. */
export function keepPasskeySignInFresh(): () => void {
  return onPageReturn(primePasskeySignIn);
}

export async function signInWithPasskey(): Promise<PasskeyResult> {
  if (!supportsPasskeys()) {
    return { ok: false, error: 'This device does not support passkeys.' };
  }
  if (isEmbeddedWebView()) return { ok: false, error: EMBEDDED_WEBVIEW_ERROR };

  // Abort the speculative autofill request first. The button then reuses the
  // same, still unspent challenge rather than minting a new one.
  cancelPasskeyCeremony();

  // Nothing may be awaited before startAuthentication on the prefetched path.
  // The fallback fetch-then-start works everywhere except iOS, and leaves the
  // options cached for a second tap.
  const cached = loginOptions.takeFresh();
  let credential;
  const startedAt = Date.now();
  try {
    if (cached) {
      credential = await startAuthentication({ optionsJSON: cached });
    } else {
      const optionsJSON = await loginOptions.prime();
      if (!optionsJSON) {
        const error = lastOptionsError ?? 'Could not start passkey sign-in.';
        reportAuthFailure({ flow: 'passkey_signin', stage: 'options', error: 'fetch', message: error });
        return { ok: false, error };
      }
      credential = await startAuthentication({ optionsJSON });
    }
  } catch (err) {
    reportAuthFailure({
      flow: 'passkey_signin',
      stage: 'ceremony',
      error: errorName(err),
      message: errorMessage(err),
      elapsedMs: Date.now() - startedAt,
      extra: { prefetched: cached !== null },
    });
    if (isBlockedCeremony(err, Date.now() - startedAt)) return { ok: false, error: BLOCKED_CEREMONY_ERROR };
    if (isUserCancellation(err)) return { ok: false, error: '' };
    return { ok: false, error: friendlyPasskeyError(err, 'No passkey was used.') };
  }

  // Verify consumes the challenge whether or not it succeeds.
  loginOptions.invalidate();
  const verifyRes = await fetch(withBase('/api/passkey/login/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  if (!verifyRes.ok) {
    const error = await errorFrom(verifyRes, 'Passkey sign-in failed.');
    reportAuthFailure({ flow: 'passkey_signin', stage: 'verify', error: String(verifyRes.status), message: error });
    // That challenge is spent. Fetch the next now, so a retry starts from the tap.
    // Not on success: the page redirects.
    primePasskeySignIn();
    return { ok: false, error };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Conditional mediation ("passkey autofill")
// ---------------------------------------------------------------------------
//
// Mirrors the player app deliberately — see apps/player/src/lib/passkey-client
// for the long-form reasoning. It is worth having here even though the console
// has few users: those users are the ones migration 00050 refuses to let drop
// their last passkey, so every one of them HAS a credential and the offer
// essentially always fires. This is also the console's own step-up path's
// nearest neighbour, and keeping the two apps' sign-in behaviour identical is
// what stops one of them drifting into a bespoke, less-tested flow.
//
// It cannot interfere with the console's step-up gate: that lives on
// /unavailable and talks to /api/passkey/auth/*, a different route pair with a
// different challenge type, and it has no email field for autofill to attach to.
//
// Speculative, therefore silent. The two failures unique to this path throw
// plain Errors whose `name` is "Error", so isUserCancellation() would call them
// real and surface "No passkey was used." — hence a separate function rather
// than a flag threaded through signInWithPasskey.

export type ConditionalSignInSteps = {
  autofillAvailable: () => Promise<boolean>;
  requestOptions: () => Promise<PublicKeyCredentialRequestOptionsJSON | null>;
  authenticate: (
    optionsJSON: PublicKeyCredentialRequestOptionsJSON
  ) => Promise<AuthenticationResponseJSON>;
  verifyCredential: (credential: AuthenticationResponseJSON) => Promise<boolean>;
};

/** True only when a session now exists. Every other outcome is a silent false. */
export async function attemptConditionalSignIn(
  steps: ConditionalSignInSteps
): Promise<boolean> {
  try {
    if (!(await steps.autofillAvailable())) return false;
    const optionsJSON = await steps.requestOptions();
    if (!optionsJSON) return false;
    const credential = await steps.authenticate(optionsJSON);
    return await steps.verifyCredential(credential);
  } catch {
    return false;
  }
}

const browserConditionalSteps: ConditionalSignInSteps = {
  autofillAvailable: async () => !isEmbeddedWebView() && (await browserSupportsWebAuthnAutofill()),
  // Shared with the button, so both use one challenge.
  requestOptions: () => loginOptions.prime(),
  authenticate: (optionsJSON) => startAuthentication({ optionsJSON, useBrowserAutofill: true }),
  verifyCredential: async (credential) => {
    loginOptions.invalidate();
    const res = await fetch(withBase('/api/passkey/login/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) primePasskeySignIn();
    return res.ok;
  },
};

export function beginConditionalPasskeySignIn(): Promise<boolean> {
  return attemptConditionalSignIn(browserConditionalSteps);
}
