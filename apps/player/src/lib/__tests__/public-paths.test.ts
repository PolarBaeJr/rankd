import { describe, expect, it } from 'vitest';
import { isPublicPath } from '../public-paths';

// Every /api/discord/* route that exists today. The bot calls these with a
// bearer secret and no session cookie, so each one has to clear the sign-in
// gate — otherwise middleware redirects to /login, fetch follows the 307, and
// the bot gets the sign-in PAGE under a 200 and dies parsing HTML as JSON.
const DISCORD_API_ROUTES = [
  '/api/discord/config',
  '/api/discord/leaderboard',
  '/api/discord/link',
  '/api/discord/link-tokens',
  '/api/discord/members',
  '/api/discord/sessions',
  '/api/discord/socials',
];

describe('isPublicPath', () => {
  describe('the Discord bot surface', () => {
    it.each(DISCORD_API_ROUTES)('lets %s through the session gate', (path) => {
      expect(isPublicPath(path)).toBe(true);
    });

    it('covers nested segments under a discord route', () => {
      expect(isPublicPath('/api/discord/link-tokens/abc123')).toBe(true);
    });

    // The trailing slash in the prefix is load-bearing: without it a route
    // named /api/discordsomething would inherit the exemption.
    it('does not match a path that merely starts with the same letters', () => {
      expect(isPublicPath('/api/discordfoo')).toBe(false);
      expect(isPublicPath('/api/discord-admin/members')).toBe(false);
    });

    // /link/<token> is a PAGE, not an API route. Requiring a session is the
    // entire point of it — that is how the token gets attached to a player.
    it('keeps the /link/<token> page gated', () => {
      expect(isPublicPath('/link/abcdefghijklmnop')).toBe(false);
      expect(isPublicPath('/link')).toBe(false);
    });
  });

  describe('routes carrying their own credential', () => {
    it('lets the token-authenticated calendar feed through', () => {
      expect(isPublicPath('/api/calendar/feed.ics')).toBe(true);
    });

    // RFC 8058 one-click: the mail client POSTs with no cookies, and treats
    // any non-2xx as a failed unsubscribe.
    it('lets one-click unsubscribe through', () => {
      expect(isPublicPath('/unsubscribe')).toBe(true);
      expect(isPublicPath('/unsubscribe/confirm')).toBe(true);
    });

    // The anonymous caller here is Discord's image proxy, fetching the QR out
    // of the /discord embed with none of our cookies. Gated, it follows the 307
    // to /login and the embed renders blank with nothing logged.
    it('lets the Discord invite QR through for the image proxy', () => {
      expect(isPublicPath('/qr/discord.png')).toBe(true);
    });

    it('lets passkey sign-in through but not passkey registration', () => {
      expect(isPublicPath('/api/passkey/login/options')).toBe(true);
      expect(isPublicPath('/api/passkey/register/options')).toBe(false);
    });

    // Only the app's login pair. Anything else under /api/passkey/app/ stays
    // gated until it is deliberately listed.
    it('lets the native app passkey sign-in through, and nothing else under app/', () => {
      expect(isPublicPath('/api/passkey/app/login/options')).toBe(true);
      expect(isPublicPath('/api/passkey/app/login/verify')).toBe(true);
      expect(isPublicPath('/api/passkey/app/register/options')).toBe(false);
      expect(isPublicPath('/api/passkey/app/loginx')).toBe(false);
      expect(isPublicPath('/api/passkey/app')).toBe(false);
    });

    // The native app's bearer routes check the token themselves; a 307 to
    // /login would reach the app as HTML. By whole segment only.
    it('lets the native app routes through, by whole segment', () => {
      expect(isPublicPath('/api/app/actions/x')).toBe(true);
      expect(isPublicPath('/api/app/challenges/context')).toBe(true);
      expect(isPublicPath('/api/appx')).toBe(false);
      expect(isPublicPath('/api/ap')).toBe(false);
    });

    // Android and Apple fetch these anonymously and follow no redirect.
    it('lets the native app trust files through', () => {
      expect(isPublicPath('/.well-known/assetlinks.json')).toBe(true);
      expect(isPublicPath('/.well-known/apple-app-site-association')).toBe(true);
      expect(isPublicPath('/.well-knownx/assetlinks.json')).toBe(false);
    });
  });

  describe('public pages', () => {
    it.each(['/', '/login', '/login/forgot', '/signup', '/auth/callback', '/exec', '/legal/privacy', '/leaderboard', '/membership', '/socials', '/whats-new'])(
      'treats %s as public',
      (path) => {
        expect(isPublicPath(path)).toBe(true);
      },
    );

    // Exact match, not a prefix — /leaderboard/<something> is not a thing the
    // gate should open up wholesale.
    it('matches /leaderboard exactly', () => {
      expect(isPublicPath('/leaderboard/season-2')).toBe(false);
    });

    // Exact too. /fees is the member's own statement and needs a session.
    it('matches /membership and /socials exactly, and keeps /fees gated', () => {
      expect(isPublicPath('/membershipX')).toBe(false);
      expect(isPublicPath('/membership/anything')).toBe(false);
      expect(isPublicPath('/socialsX')).toBe(false);
      expect(isPublicPath('/socials/anything')).toBe(false);
      expect(isPublicPath('/fees')).toBe(false);
    });

    it('matches /whats-new exactly', () => {
      expect(isPublicPath('/whats-newX')).toBe(false);
      expect(isPublicPath('/whats-new/1.1.1')).toBe(false);
    });

    // A guest has no account, and a proof link is opened by whoever holds it.
    // By whole segment, so a lookalike path stays gated.
    it('lets a guest reach the guest waiver and its proof pages, by whole segment', () => {
      expect(isPublicPath('/guest-waiver')).toBe(true);
      expect(isPublicPath('/guest-waiver/abc')).toBe(true);
      expect(isPublicPath('/guest-waiverX')).toBe(false);
    });

    it('lets a signed-out scanner reach the tournament check-in page', () => {
      expect(isPublicPath('/tournaments/checkin/xyz')).toBe(true);
    });
  });

  describe('the app itself stays gated', () => {
    it.each([
      '/feed',
      '/sessions',
      '/profile',
      '/onboarding',
      '/checkin/abcdef',
      '/api/notifications',
      '/api/sessions/register',
    ])('requires a session for %s', (path) => {
      expect(isPublicPath(path)).toBe(false);
    });
  });
});
