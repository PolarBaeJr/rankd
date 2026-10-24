import * as Sentry from '@sentry/nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseIntegration } from '@supabase/sentry-js-integration';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

// Performance trace sample rate. Full sampling was a beta setting. On the server
// this instrumentation runs on the same single thread as SSR, and it measured
// as the likely cause of prod serving ~18 rps where an un-instrumented staging
// served ~28 (docs/sensitive/LOAD-TEST-2026-08-18.md).
//
// Error capture is UNAFFECTED by this — exceptions are always sent regardless
// of the trace rate. Only performance data is sampled.
//
// Override with NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE at build time; the
// default is what production runs.
const TRACES_RAW = process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;
const tracesSampleRate =
  TRACES_RAW === undefined || TRACES_RAW === ''
    ? 0.1
    : Math.min(Math.max(Number(TRACES_RAW) || 0, 0), 1);

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  ignoreErrors: ['NEXT_NOT_FOUND'],
  // Scripts an in-app browser adds to the page, never ours: Instagram's
  // webview injects app://navigation_performance_logger_android, and its
  // bridge to the app fails now and then (JAVASCRIPT-NEXTJS-1B). Our own code
  // always loads from https, so nothing of ours can match.
  denyUrls: [/^app:\/\//],
  integrations: [
    // Names every browser-side Supabase call as a DB span; class form patches
    // the prototype so all client instances are traced.
    supabaseIntegration(SupabaseClient, Sentry, {
      tracing: true,
      breadcrumbs: true,
      errors: true,
    }),
    Sentry.browserTracingIntegration({
      shouldCreateSpanForRequest: (url) => !url.startsWith(`${SUPABASE_URL}/rest`),
    }),
  ],
});
