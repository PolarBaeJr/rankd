/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // camera=(self), not camera=(). This app scans QR codes in-browser — the
  // session check-in button and the tournament door scanner both call
  // getUserMedia — and `camera=()` is a platform-level veto that denies them
  // before the user is ever asked. It shipped that way, which means the
  // tournament in-app scanner has been dead on Chrome/Android since it landed;
  // Safari's thinner Permissions-Policy support is why an iPhone-heavy club
  // never reported it.
  //
  // `self` grants nothing: the browser still prompts and the member still has
  // to allow it. It only restores our own origin's right to ask. Third parties
  // remain excluded, and nothing can frame us anyway (X-Frame-Options: DENY).
  // microphone and geolocation stay fully denied.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

// Read from the workspace root, the same source the admin console uses, so one
// manifest bump moves both apps. The settings page used to hard-code this and
// sat at a year-stale "0.0.1" through every release since.
const appVersion = require('../../package.json').version;

const path = require('path');

// THE SERVER'S RECEIPT OCR (00297, src/lib/receipt-ocr-server.ts). tesseract.js
// runs its worker as a worker_threads script it names by path, and its core
// is required by name inside that worker, so a bundler sees neither: kept
// external, and traced in by hand for the routes that read a receipt. Missing
// any of it, the build is clean and the read fails in the container only
// (safely: the receipt is held for an exec as 'ocr_failed').
// ALL of tesseract.js-core, not only its LSTM builds: tesseract.js 7 hands its
// core picker a boolean where it compares an OEM number, so whatever the OEM it
// loads the full core (worker-script/node/getCore.js).
const TESSERACT_FILES = [
  '../../node_modules/tesseract.js/**',
  '../../node_modules/tesseract.js-core/**',
  '../../node_modules/wasm-feature-detect/**',
  '../../node_modules/zlibjs/**',
  '../../node_modules/bmp-js/**',
  '../../node_modules/is-url/**',
  '../../node_modules/node-fetch/**',
  '../../node_modules/whatwg-url/**',
  '../../node_modules/tr46/**',
  '../../node_modules/webidl-conversions/**',
  '../../node_modules/regenerator-runtime/**',
  '../../node_modules/idb-keyval/**',
];

const nextConfig = {
  output: 'standalone',
  // Inlined at build time, so the standalone server needs nothing at runtime.
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // Pin the tracing root to the workspace. Left to infer it, Next walks up
  // looking for lockfiles and can land outside the repo entirely (a stray
  // ~/package-lock.json is enough), which decides what gets copied into the
  // standalone bundle the container runs.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // THE PROFILE CARD'S FONTS. next/og renders the card server-side and reads
  // these .ttf files off disk at request time, so they have to be inside the
  // standalone bundle -- and nothing imports them, so nothing traces them.
  // Without this the route builds clean and 500s on first request in the
  // container, which is the only place it would ever be noticed.
  //
  // They are .ttf and not the .woff2 the browser gets because satori (what
  // next/og renders through) cannot read WOFF2 at all.
  outputFileTracingIncludes: {
    '/api/discord/card/[token]': ['./src/fonts/*.ttf'],
    '/api/discord/card/probe': ['./src/fonts/*.ttf'],
    '/membership': TESSERACT_FILES,
    '/api/discord/receipts': TESSERACT_FILES,
  },
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core'],
  // src/instrumentation.ts (Sentry server/edge init) needed an experimental
  // flag on 14; it is default-on from 15, and leaving the flag set now only
  // earns an "unrecognised experimental option" warning.
  // THE CLIENT ROUTER CACHE, which Next 15 turns off for dynamic routes.
  //
  // next/dist/server/config-shared.js defaults staleTimes to
  // `{ dynamic: 0, static: 300 }`. Every page in this app is force-dynamic, so
  // dynamic: 0 meant the in-memory router cache held a visited page for zero
  // seconds and switching tab -> other tab -> back re-ran the FULL server render
  // both ways, for data that had not changed. Next 14 defaulted this to 30s, so
  // the console silently got slower to navigate at the 15 upgrade rather than at
  // any change of ours.
  //
  // SAFE HERE BECAUSE MUTATIONS ALREADY INVALIDATE: 160 revalidatePath() calls
  // across 51 files plus 98 router.refresh() calls. Those drop the client cache,
  // so this window only ever applies to passive navigation between tabs — never
  // to a page you just wrote to. 30s is deliberately short for that reason: it
  // is long enough to cover flicking between sections while working, short
  // enough that a figure changed by somebody ELSE cannot sit wrong for long.
  //
  // NOT accompanied by prefetch={true} on the nav links, on purpose. Prefetch on
  // a dynamic route only warms the nearest loading.tsx (the skeleton) unless
  // forced, and forcing it fires a full server render PER LINK. Render is
  // single-threaded and is this app's measured bottleneck, so blanket prefetch
  // would multiply load on exactly the constrained resource.
  experimental: {
    staleTimes: { dynamic: 30, static: 180 },
  },
  transpilePackages: ['@badminton/shared', '@badminton/ui'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

// Only wrap with Sentry when DSN is configured
if (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) {
  const { withSentryConfig } = require('@sentry/nextjs');
  module.exports = withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    silent: !process.env.CI,
    widenClientFileUpload: true,
    tunnelRoute: '/monitoring',
    hideSourceMaps: true,
    disableLogger: true,

    // Tree-shake Sentry code we never execute. Session Replay is sampled at 0
    // in sentry.client.config.ts and replayIntegration is not registered, so
    // its rrweb payload was being shipped and parsed for nothing. Note the
    // installed SDK has no excludeReplayShim flag, so this trims replay but
    // cannot remove it outright. Tracing stays in (we use it).
    bundleSizeOptimizations: {
      excludeDebugStatements: true,
      excludeReplayIframe: true,
      excludeReplayShadowDom: true,
      excludeReplayWorker: true,
    },
  });
} else {
  module.exports = nextConfig;
}
