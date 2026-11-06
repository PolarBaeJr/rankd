import type { Metadata, Viewport } from 'next';
import './globals.css';

export const dynamic = 'force-dynamic';
import { BottomNav } from '@/components/bottom-nav';
import { GroupSwitch } from '@/components/group-switch';
import { TopBar } from '@/components/top-bar';
import { ToastProvider } from '@/components/toast-provider';
import { OfflineBanner } from '@/components/OfflineBanner';
import { WaiverGate } from '@/components/waiver-gate';
import { DeletionGate } from '@/components/deletion-gate';
import { PostHogProvider } from '@/components/posthog-provider';
import { PostHogIdentify } from '@/components/posthog-identify';
import { SentryUserInit } from '@/components/sentry-user-init';
import { StandingProvider } from '@/components/standing-provider';
import { StandingBanner } from '@/components/standing-banner';
import { LegalFooter } from '@/components/legal-footer';
import { MemberTourHost } from '@/components/member-tour-host';
import { cookies } from 'next/headers';
import { after } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { LEGAL_DOCUMENT_ORDER, hasConsoleAccess, featureAccessFor, getAccountStanding, playerPathVisible, type AccountStanding, type FeatureId } from '@badminton/shared';
import { evaluateLegalGate, type LegalAcceptance } from '../lib/legal-gate';
import { createServerSupabaseClient, getActiveSeason, getViewer } from '@/lib/supabase-server';
import { getFeatureFlags } from '@/lib/feature-gate';
import { getClubSocials } from '@/lib/club-socials';
import localFont from "next/font/local";
import { cn } from "@/lib/utils";
import { ConfirmProvider, StaleBuildBanner } from "@badminton/ui";

// SELF-HOSTED, NOT next/font/google — and that is a deploy property, not a
// preference. next/font/google resolves at BUILD time: `docker build` opens a
// socket to fonts.gstatic.com, so a blip on the CI runner's network fails the
// image rather than the page. It already has. These are the exact same bytes —
// every file under src/fonts/ is sha256-identical to the one gstatic serves for
// that family, weight and subset today — vendored with their OFL 1.1 licences,
// so the build reads the disk and nothing else.
//
// Google's stylesheet does not ship one file per weight — it ships three,
// latin / latin-ext / vietnamese, sharing one font-family name and separated by
// unicode-range. localFont() cannot express that shape: every call mints its
// own private family, and the files inside one `src` array all land on that
// family with no unicode-range, so the last one listed would simply win and the
// rest would never paint. Hence one call per subset, chained back together into
// a single stack in globals.css:
//
//   --font-sans: var(--font-sans-ext), var(--font-sans-vi), var(--font-sans-latin)
//
// Order is load-bearing. The ext/vi faces carry a `unicode-range`, so they
// decline every codepoint outside their block and ordinary text still reaches
// the latin file. They must sit BEFORE it because `--font-sans-latin` ends in
// next/font's metric-matched Arial fallback, and Arial has ř and ế — listed
// after it, the subsets would never be consulted, which is the bug being fixed.
//
// preload:false on the subsets is deliberate: a roster with no accented name
// must not pay for them. A browser fetches a font only once a character it
// claims is actually painted, so those two files cost nothing until a Nguyễn
// or a Dvořák appears. adjustFontFallback:false keeps a second Arial fallback
// out of the middle of the stack; the latin call at the end supplies the one.
//
// The unicode-range values are verbatim from fonts.googleapis.com's css2 output
// for Barlow v13 and must be written inline — next/font rejects a reference
// ("Font loader values must be explicitly written literals"). Where the blocks
// overlap (U+0304, U+0308, U+0329) ext answers where Google gave it to latin:
// same family, same weight, same outline.
//
// JetBrains Mono stays latin-only. It sets labels, dates and figures, never a
// person's name. It is also a VARIABLE font: one file serves all four weights,
// which is exactly what Google's CSS did (four @font-face rules, one src).
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
  title: 'SFU Badminton Club',
  description: 'Challenge, compete, and climb the ranks',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'SFU Badminton',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let playerName = '';
  let avatarUrl: string | null = null;
  let isAuthenticated = false;
  let playerId: string | null = null;
  let playerStatus: string | null = null;
  let singlesElo: number | null = null;
  let doublesElo: number | null = null;
  let unreadCount = 0;
  let activeSeasonName = '';
  let missingLegalDocs: string[] = [];
  let deletionRequestedAt: string | null = null;
  let isExecOrAdmin = false;
  // The switched-off features this viewer holds the key to, for the nav. A
  // separate value from isExecOrAdmin, which still decides the Exec Panel link.
  let featureAccess: FeatureId[] = [];
  // Published to every client control via StandingProvider so none of them has
  // to re-derive it (or, as before, offer a button the server is certain to
  // refuse). Defaults to good standing, which is what a signed-out visitor is.
  let standing: AccountStanding = getAccountStanding(null);

  // Theme preference lives in a cookie so we can set data-theme server-side and
  // avoid a flash of the wrong theme. Explicit light/dark render correctly on
  // the server; 'system' (or no cookie) defaults to dark and the inline script
  // below resolves the OS preference before paint.
  const themePref = (await cookies()).get('theme')?.value;
  const initialTheme = themePref === 'light' ? 'light' : 'dark';

  // NEITHER OF THESE WAITS ON THE OTHER, and until now both did. The season is
  // not a property of the viewer, but it ran first and to completion in front of
  // everything below purely because of the order this function was written in.
  const [season, viewer, features, clubSocials] = await Promise.all([
    // No active season is the ordinary answer here, not an error.
    getActiveSeason().catch(() => null),
    // A signed-out visitor comes back as nulls rather than a throw, so a throw
    // means something else — an unreachable Supabase, a missing service-role
    // key. The old code caught that under a comment reading "Not authenticated"
    // and rendered a signed-out shell to a signed-in member with nothing
    // anywhere reporting it. Still non-fatal, because chrome is not enforcement
    // (requirePlayer() re-reads the row and throws), but no longer silent.
    getViewer().catch((err) => {
      console.error('Root layout could not load the viewer:', err);
      return { user: null, player: null } as Awaited<ReturnType<typeof getViewer>>;
    }),
    // The club feature switches, for the nav. Never throws; a failed read is
    // every feature on.
    getFeatureFlags(),
    // The Instagram and Discord links, for the footer and the nav. Never
    // throws; a failed read is the defaults.
    getClubSocials(),
  ]);

  activeSeasonName = season?.name ?? '';

  // THE SAME ROW THE PAGE UNDER THIS LAYOUT IS ABOUT TO ASK FOR. getViewer() is
  // request-scoped, so whichever of the two runs first pays for it and the other
  // gets it free — see the note on the function. This block used to run its own
  // narrower select, which meant a different URL, which meant Next could not
  // collapse the two and every authenticated navigation fetched the row twice.
  const { user, player } = viewer;
  isAuthenticated = user !== null;

  // Published to every client control via StandingProvider so none of them has
  // to re-derive it. getAccountStanding and hasConsoleAccess both read columns
  // the old hand-written select had to name explicitly — is_banned, active_flag,
  // deletion_requested_at — and both silently degrade to "no restrictions" on a
  // column they cannot see. That trap is gone: PLAYER_SELECT is `*`, so there is
  // no list left to forget a column from.
  standing = getAccountStanding(player);
  playerName = player?.full_name ?? '';
  avatarUrl = player?.avatar_url ?? null;
  playerId = player?.id ?? null;
  playerStatus = player?.status ?? null;
  deletionRequestedAt = player?.deletion_requested_at ?? null;
  // Anyone with ANY console level, which includes varsity trainers — the link in
  // the top bar is the only route they have to the console, and hiding it would
  // leave the role technically working and practically unreachable. Shared
  // predicate with the settings page and the admin app, mirroring
  // admin_access_level() in 00057: standing first, then level. A banned or
  // deactivated exec is shown no route in, because the console would reject them
  // and a link that always errors is worse than no link.
  isExecOrAdmin = hasConsoleAccess(player);
  featureAccess = featureAccessFor(player);

  // THE SOCIALS SWITCH AND show_discord, DECIDED ONCE. The top bar, the tab bar
  // and the footer all take the answer rather than the inputs, so the three
  // cannot disagree. A holder of page.access.socials sees them while the
  // switch is off, the same as the nav treats every other feature.
  const socialsVisible = playerPathVisible('/socials', features, featureAccess);
  const showDiscord = socialsVisible && clubSocials.showDiscord;
  const footerSocials = socialsVisible ? clubSocials : null;

  const ratings = Array.isArray(player?.ratings) ? player.ratings[0] : player?.ratings;
  singlesElo = (ratings as Record<string, unknown>)?.singles_elo as number ?? null;
  doublesElo = (ratings as Record<string, unknown>)?.doubles_elo as number ?? null;

  if (player) {
    try {
      const supabase = await createServerSupabaseClient();
      // INDEPENDENT OF EACH OTHER, so they overlap. Both need `player` and
      // neither needs the other's answer; they were awaited one after the next.
      //
      // The notifications count also used to run for a signed-out visitor with
      // `player_id` filtered to the empty string — a request that could only
      // ever fail, on every anonymous page load. Under `if (player)` it does not
      // run at all, and the count for a visitor stays the 0 it always was.
      const [gate, unread] = await Promise.all([
        // A member needs the waiver gate when any of the four legal documents
        // lacks a valid acceptance — current version, and for the waiver also
        // re-signed within the last year. Shares evaluateLegalGate() with the
        // gameplay server actions so the two can never disagree: when the read
        // fails the actions decline every mutation, so the chrome must not carry
        // on as if nothing were wrong. 'unavailable' RAISES the gate, which is
        // the only screen that tells the member why the rest of the app has
        // stopped responding to them. Do not simplify that mapping away.
        evaluateLegalGate(
          supabase,
          player as { waiver_reset_at?: string | null; waiver_acceptances?: LegalAcceptance[] | null },
        ),
        supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('player_id', player.id)
          .eq('read_flag', false),
      ]);
      missingLegalDocs = gate.status === 'unavailable' ? LEGAL_DOCUMENT_ORDER.slice() : gate.missing;
      unreadCount = unread.count ?? 0;
      // 00320. The visit, for the console's "Last seen". Last in this block so
      // nothing above waits on it, run after the response so the page does
      // not either, and only once the stamp is fifteen minutes old;
      // touch_last_seen applies the same rule on its own side. On the member's
      // session, because the function resolves them from auth.uid() and the
      // service role would touch nobody.
      const lastSeen = player.last_seen_at ? new Date(player.last_seen_at).getTime() : 0;
      if (Date.now() - lastSeen > 15 * 60 * 1000) {
        after(async () => {
          try {
            const { error } = await supabase.rpc('touch_last_seen');
            if (error) Sentry.captureException(error, { tags: { step: 'touch-last-seen' } });
          } catch (err) {
            Sentry.captureException(err, { tags: { step: 'touch-last-seen' } });
          }
        });
      }
    } catch (err) {
      // Same shape as before — the chrome degrades, the page still renders —
      // but it says so now. Leaving missingLegalDocs empty here lowers the gate;
      // that is the pre-existing behaviour for a throw, and it is safe because
      // assertCurrentWaiver() fails CLOSED on the actions themselves.
      console.error('Root layout could not load the viewer chrome:', err);
    }
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-theme={initialTheme}
      className={cn(
        "font-sans",
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
            var m = document.cookie.match(/(?:^|; )theme=([^;]+)/);
            var t = (m && decodeURIComponent(m[1])) || localStorage.getItem('theme') || 'dark';
            var r = t === 'system'
              ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
              : t;
            document.documentElement.setAttribute('data-theme', r);
          } catch(e) { document.documentElement.setAttribute('data-theme', 'dark'); }
        `}} />
      </head>
      <body>
        {/* Outside every provider on purpose. It needs none of them, it must
            reach a member who is stuck behind WaiverGate or DeletionGate, and
            the fetch wrapper it installs should be in place before anything
            below has a handler that could fire a server action. */}
        <StaleBuildBanner />
        <PostHogProvider>
          <ToastProvider>
            <ConfirmProvider>
              <StandingProvider standing={standing}>
                <SentryUserInit playerId={playerId} />
                <PostHogIdentify
                  playerId={playerId}
                  playerStatus={playerStatus}
                  singlesElo={singlesElo}
                  doublesElo={doublesElo}
                />
                <OfflineBanner />
                <DeletionGate deletionRequestedAt={deletionRequestedAt} />
                {/* Deletion screen wins when both gates would apply. */}
                <WaiverGate missingDocs={deletionRequestedAt ? [] : missingLegalDocs} />
                <TopBar isApproved={playerStatus !== 'pending_approval' && playerStatus !== 'suspended'} playerName={playerName} avatarUrl={avatarUrl} unreadCount={unreadCount} isAuthenticated={isAuthenticated} isExecOrAdmin={isExecOrAdmin} activeSeasonName={activeSeasonName} activeSeasonId={season?.id ?? ''} features={features} featureAccess={featureAccess} showDiscord={showDiscord} />
                {/* Under the top bar, above the page: the one place that says
                    why the controls below are missing. Nav gating is left as
                    it was — a link that still loads its page is not a control
                    the server refuses, and the per-surface notes need those
                    pages to stay reachable. */}
                <StandingBanner />
                <main className="page page-shell pb-safe-nav">
                  {/* The content grows to fill the screen, so the footer sits at
                      the bottom of a short page instead of halfway up it. */}
                  <div className="page-shell-content">
                    {isAuthenticated && (
                      <GroupSwitch isApproved={playerStatus !== 'pending_approval' && playerStatus !== 'suspended'} features={features} featureAccess={featureAccess} />
                    )}
                    {children}
                  </div>
                  <LegalFooter socials={footerSocials} />
                </main>
                <BottomNav isAuthenticated={isAuthenticated} isApproved={playerStatus !== 'pending_approval' && playerStatus !== 'suspended'} features={features} featureAccess={featureAccess} showDiscord={showDiscord} />
                {/* Signed-in members only. Held back while either gate above
                    owns the screen, so the tour never sits on top of it. */}
                {player && (
                  <MemberTourHost
                    toursSeen={player.tours_seen ?? {}}
                    features={features}
                    featureAccess={featureAccess}
                    approved={playerStatus !== 'pending_approval' && playerStatus !== 'suspended'}
                    blocked={missingLegalDocs.length > 0 || !!deletionRequestedAt}
                  />
                )}
              </StandingProvider>
            </ConfirmProvider>
          </ToastProvider>
        </PostHogProvider>
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(function() {});
          }
        `}} />
      </body>
    </html>
  );
}
