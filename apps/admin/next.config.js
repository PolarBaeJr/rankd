/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

// Single source of truth for the version shown in Settings > About. It used to
// be a literal in that page and drifted to a year-stale "v0.0.1"; reading the
// workspace root here means the only way to change it is to bump the manifest.
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
  // Pin the tracing root to the workspace. Left to infer it, Next walks up
  // looking for lockfiles and can land outside the repo entirely (a stray
  // ~/package-lock.json is enough), which decides what gets copied into the
  // standalone bundle the container runs.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  outputFileTracingIncludes: {
    '/api/cron/registration-form-poll': TESSERACT_FILES,
  },
  serverExternalPackages: ['tesseract.js', 'tesseract.js-core'],
  // Inlined at build time, so the standalone server needs nothing at runtime.
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // The console is served at sfubadminton.com/admin — the player app's own
  // origin. It used to have a subdomain, but the player app is an installed
  // PWA, and a PWA cannot keep a cross-origin navigation in its window: every
  // tap of "Exec Panel" ejected the exec into a browser tab.
  //
  // Env-driven rather than a literal because basePath is baked in at BUILD
  // time and localhost still wants a root-mounted console. `undefined` rather
  // than '' when unset, so an unset build resolves to exactly Next's default.
  // Everything that has to follow this prefix by hand — fetch(), raw
  // window.location, redirectTo — lives in src/lib/base-path.ts.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
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
