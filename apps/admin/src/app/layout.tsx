import type { Metadata, Viewport } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { Sidebar } from '@/components/sidebar';
import { createAdminClient, getAuthenticatedConsoleUser, touchLastSeen } from '@/lib/supabase-server';
import { ALL_CONSOLE_PAGES_ON, DEFAULT_FEATURE_FLAGS, readConsolePages, readFeatureFlags } from '@badminton/shared';
import {
  accessLevelFor,
  effectiveCapabilities,
  permissionsOf,
  permissionTripleOf,
  type AccessLevel,
  type PermissionsInput,
} from '@/lib/permissions';
import { MainContent } from '@/components/main-content';
import { ToastProvider } from '@/components/toast-provider';
import { SentryUserInit } from '@/components/sentry-user-init';
import { ExecTourHost } from '@/components/exec-tour-host';
import { PasskeyGraceBanner } from '@/components/passkey-grace-banner';
import localFont from 'next/font/local';
import { cn, ConfirmProvider, StaleBuildBanner } from '@badminton/ui';
import { withBase } from '@/lib/base-path';

// Self-hosted for the same reason the members' app is: next/font/google fetches
// from fonts.gstatic.com during `docker build`, so a network blip on the CI
// runner fails the image. Byte-identical files (Google's own woff2 for each
// family, weight and subset) live in src/fonts/ with their OFL 1.1 licences.
//
// Barlow arrives as three unicode-range subsets. localFont() mints a private
// family per call and offers no per-file unicode-range, so each subset needs
// its own call and globals.css chains them back into --font-sans/--font-display
// — subsets first, because the latin call's Arial metric fallback would
// otherwise answer for ř and ế. See apps/player/src/app/layout.tsx for the
// full note; this file is the same arrangement.
const barlow = localFont({
  src: [
    { path: '../fonts/barlow-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-latin-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/barlow-latin-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans-latin',
  display: 'swap',
});
const barlowExt = localFont({
  src: [
    { path: '../fonts/barlow-latin-ext-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-latin-ext-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/barlow-latin-ext-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-latin-ext-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans-ext',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF' }],
});
const barlowVietnamese = localFont({
  src: [
    { path: '../fonts/barlow-vietnamese-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-vietnamese-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/barlow-vietnamese-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-vietnamese-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans-vi',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB' }],
});
const barlowCondensed = localFont({
  src: [
    { path: '../fonts/barlow-condensed-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-condensed-latin-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-condensed-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display-latin',
  display: 'swap',
});
const barlowCondensedExt = localFont({
  src: [
    { path: '../fonts/barlow-condensed-latin-ext-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-condensed-latin-ext-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-condensed-latin-ext-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display-ext',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF' }],
});
const barlowCondensedVietnamese = localFont({
  src: [
    { path: '../fonts/barlow-condensed-vietnamese-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/barlow-condensed-vietnamese-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/barlow-condensed-vietnamese-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display-vi',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB' }],
});
// One variable file, four declared weights — the shape Google's CSS had.
const jetbrainsMono = localFont({
  src: [
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/jetbrains-mono-latin-400.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SFU Badminton - Admin',
  description: 'Admin dashboard for SFU Badminton Club',
  // Next prepends basePath to <Link>, redirect() and the router, but NOT to
  // metadata.manifest or metadata.icons — those emit whatever string they are
  // given. The console shares the player app's origin, so an unprefixed
  // "/manifest.json" is not a 404, it is the MEMBERS' manifest: an exec doing
  // Add to Home Screen from /admin got the members' app name and icon, and
  // launching it opened /feed. Hence withBase() on every one of these.
  //
  // public/manifest.json itself uses RELATIVE members (scope "./", start_url
  // "dashboard", icon "icon-192.png"). A manifest's URLs resolve against the
  // manifest's own address, so one file is correct both here — served at
  // /admin/manifest.json, giving scope /admin/ and start_url /admin/dashboard —
  // and on a root-mounted localhost build, where basePath is ''. A static file
  // cannot read BASE_PATH, and hard-coding /admin into it would break localhost.
  manifest: withBase('/manifest.json'),
  icons: {
    icon: [
      { url: withBase('/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { url: withBase('/icon-512.png'), sizes: '512x512', type: 'image/png' },
    ],
    apple: withBase('/apple-touch-icon.png'),
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'SFU Admin',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve the access level HERE, on the server, so the sidebar's first paint
  // is already correct. It used to fetch this itself in a useEffect and render
  // every nav item until the RPC came back — so an exec watched the admin-only
  // sections sit there for the length of a round-trip and then vanish. Choosing
  // between a flash of too much and a flash of an empty nav was a false choice:
  // the layout is already an async server component and can just know.
  //
  // The PERMISSIONS are seeded alongside the level, and for the same reason: a
  // narrowed exec whose first paint used the level alone would watch the
  // sections they no longer hold sit there until the first poll came back.
  //
  // Sent as the stored TRIPLE rather than as a resolved Permissions, because a
  // resolved one carries a Set and a Set is not plain data — what crosses into
  // a client component has to be. The sidebar resolves it with the same
  // permissionsOf() the server used, so the two cannot answer differently.
  //
  // Throws on public routes (/login, /unauthorized) where there is no session,
  // which is exactly when the sidebar renders nothing anyway.
  let initialAccessLevel: AccessLevel | null = null;
  let initialPermissions: PermissionsInput | null = null;
  // For the console tour: what this officer holds, and which tours they have
  // already been through (00246).
  let heldCapabilities: string[] = [];
  let toursSeen: Record<string, unknown> = {};
  // Started before the viewer read and awaited after it, so the two overlap.
  // Never throws: a failed read is every feature at its default.
  const featuresRead = (async () => readFeatureFlags(createAdminClient()))()
    .catch(() => ({ ...DEFAULT_FEATURE_FLAGS }));
  // The console page switches (00321). Never throws: a failed read is every page on.
  const consolePagesRead = (async () => readConsolePages(createAdminClient()))()
    .catch(() => ({ ...ALL_CONSOLE_PAGES_ON }));
  try {
    const viewer = await getAuthenticatedConsoleUser({ skipPasskey: true });
    initialAccessLevel = accessLevelFor(viewer);
    initialPermissions = permissionTripleOf(viewer);
    heldCapabilities = [...effectiveCapabilities(initialAccessLevel, permissionsOf(initialAccessLevel, viewer))];
    toursSeen = (viewer.tours_seen as Record<string, unknown> | null) ?? {};
    // 00320. The console's own visit, once the stamp is fifteen minutes old.
    // touchLastSeen never throws, so it cannot take the sidebar down with it.
    const lastSeen = viewer.last_seen_at ? new Date(viewer.last_seen_at).getTime() : 0;
    if (Date.now() - lastSeen > 15 * 60 * 1000) await touchLastSeen();
  } catch {
    initialAccessLevel = null;
  }
  const features = await featuresRead;
  const consolePages = await consolePagesRead;

  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={cn(
        'font-sans',
        // All six Barlow variables have to land on the same element: globals.css
        // composes --font-sans/--font-display out of them at :root, which IS
        // this <html>, and a var() that resolves to nothing there would
        // invalidate the whole font-family it sits in.
        barlow.variable, barlowExt.variable, barlowVietnamese.variable,
        barlowCondensed.variable, barlowCondensedExt.variable, barlowCondensedVietnamese.variable,
        jetbrainsMono.variable,
      )}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var t = localStorage.getItem('theme') || 'dark';
            var r = t === 'system'
              ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
              : t;
            document.documentElement.setAttribute('data-theme', r);
          } catch(e) { document.documentElement.setAttribute('data-theme', 'dark'); }
        `}} />
      </head>
      <body className="antialiased">
        {/* Outside every provider — see the player app's layout for why. */}
        <StaleBuildBanner />
        <ToastProvider>
          <ConfirmProvider>
            <SentryUserInit playerId={null} />
            <Sidebar
              initialAccessLevel={initialAccessLevel}
              initialPermissions={initialPermissions}
              features={features}
              consolePages={consolePages}
            />
            <ExecTourHost
              level={initialAccessLevel}
              held={heldCapabilities}
              toursSeen={toursSeen}
              features={features}
            />
            <MainContent>
              <PasskeyGraceBanner />
              {children}
            </MainContent>
          </ConfirmProvider>
        </ToastProvider>
        {/*
          The console deliberately registers NO service worker.

          It used to register '/sw.js' from a dangerouslySetInnerHTML string,
          which Next cannot rewrite — so on the shared origin that was the
          PLAYER app's service worker, installed at scope '/' for execs who may
          never open the members' app. apps/admin/public/sw.js was dead code and
          has been deleted with this change.

          The console does not get its own worker either, and the reason is the
          push schema, not tidiness: push_subscriptions has no scope column, and
          sendPushToPlayers() fans a payload out to EVERY active row for a
          player_id. A second registration at scope '/admin/' would mean a
          second endpoint for the same device, so every member notification
          would fire twice on an exec's phone — one copy rendered by each
          worker. Two workers would also fight over caches (each activate
          handler deletes every cache but its own) and would re-introduce the
          /admin caching that apps/player/public/sw.js refuses on purpose, so a
          shared phone cannot hand back another exec's console view offline.

          Admin-targeted push therefore rides the one root worker, which honours
          the payload's `url`. See the notificationclick handler there.

          We do NOT unregister '/sw.js' from here: for the many execs who are
          also members that is their real player-app worker.
        */}
      </body>
    </html>
  );
}
