import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveDiscordPlayer is requirePlayer + assertFeatureOn + assertCurrentWaiver
// for a caller who arrives from Discord with no session. The order and the
// verdicts are the web's; the differences are that a lapsed member is sent to
// the web rather than reactivated, and that a failed read is 'unavailable'
// (a 503) rather than any refusal.

let linkRow: Record<string, unknown> | null = null;
let linkError: { message: string } | null = null;
let featureOn = true;
const featuresAsked: string[] = [];
let legalGate: { status: 'ok'; missing: string[] } | { status: 'unavailable' } = { status: 'ok', missing: [] };

vi.mock('@/lib/supabase-server', () => ({ createServiceRoleClient: vi.fn(), getCurrentPlayer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ setUser: vi.fn(), captureException: vi.fn() }));
vi.mock('posthog-node', () => ({ PostHog: class {} }));
vi.mock('@badminton/shared/src/push/send', () => ({ sendPushToPlayers: vi.fn() }));
vi.mock('@/lib/feature-gate', async () => {
  const { ExpectedError } = await import('@badminton/shared');
  return {
    assertFeatureOn: vi.fn(async (feature: string) => {
      featuresAsked.push(feature);
      if (!featureOn) throw new ExpectedError('Challenges are switched off');
    }),
  };
});
vi.mock('@/lib/legal-gate', () => ({ evaluateLegalGate: vi.fn(async () => legalGate) }));

const { resolveDiscordPlayer, resolveDiscordMember } = await import('../discord-member');

const client = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: linkError ? null : linkRow, error: linkError }),
      }),
    }),
  }),
} as unknown as Parameters<typeof resolveDiscordPlayer>[0];

const MEMBER = { id: 'player-me', full_name: 'Me Myself', status: 'competitive', is_banned: false, active_flag: true };

beforeEach(() => {
  linkRow = { player_id: 'player-me', players: MEMBER };
  linkError = null;
  featureOn = true;
  featuresAsked.length = 0;
  legalGate = { status: 'ok', missing: [] };
});

describe('resolveDiscordMember', () => {
  it('names a failed read unavailable, never not_linked', async () => {
    linkError = { message: 'boom' };
    expect(await resolveDiscordMember(client, '111111')).toEqual({ ok: false, refusal: 'unavailable' });
  });

  it('answers not_linked when there is no link row', async () => {
    linkRow = null;
    expect(await resolveDiscordMember(client, '111111')).toEqual({ ok: false, refusal: 'not_linked' });
  });
});

describe('resolveDiscordPlayer', () => {
  it('lets a member in good standing through', async () => {
    expect(await resolveDiscordPlayer(client, '111111')).toEqual({ ok: true, player: MEMBER });
  });

  it('refuses pending, suspended and banned members as standing', async () => {
    for (const player of [
      { ...MEMBER, status: 'pending_approval' },
      { ...MEMBER, status: 'suspended' },
      { ...MEMBER, is_banned: true },
    ]) {
      linkRow = { player_id: 'player-me', players: player };
      expect(await resolveDiscordPlayer(client, '111111')).toEqual({ ok: false, refusal: 'standing' });
    }
  });

  it('sends a lapsed member to the web rather than reactivating them', async () => {
    linkRow = { player_id: 'player-me', players: { ...MEMBER, active_flag: false } };
    expect(await resolveDiscordPlayer(client, '111111')).toEqual({ ok: false, refusal: 'lapsed' });
  });

  it('refuses a member who asked to be deleted as standing, not lapsed', async () => {
    linkRow = {
      player_id: 'player-me',
      players: { ...MEMBER, active_flag: false, deletion_requested_at: '2026-10-01T00:00:00Z' },
    };
    expect(await resolveDiscordPlayer(client, '111111')).toEqual({ ok: false, refusal: 'standing' });
  });

  it('refuses when the club has switched challenges off', async () => {
    featureOn = false;
    expect(await resolveDiscordPlayer(client, '111111')).toEqual({ ok: false, refusal: 'feature_off' });
  });

  it('refuses a member with a legal document outstanding', async () => {
    legalGate = { status: 'ok', missing: ['waiver'] };
    expect(await resolveDiscordPlayer(client, '111111')).toEqual({ ok: false, refusal: 'waiver' });
  });

  it('answers unavailable when the legal documents cannot be read', async () => {
    legalGate = { status: 'unavailable' };
    expect(await resolveDiscordPlayer(client, '111111')).toEqual({ ok: false, refusal: 'unavailable' });
  });

  it('checks the challenges switch by default', async () => {
    await resolveDiscordPlayer(client, '111111');
    expect(featuresAsked).toEqual(['challenges']);
  });

  it('runs a fee receipt\'s checks: the fees switch and no legal documents, as the web action does', async () => {
    legalGate = { status: 'ok', missing: ['waiver'] };
    expect(await resolveDiscordPlayer(client, '111111', { feature: 'fees', waiver: false })).toEqual({
      ok: true,
      player: MEMBER,
    });
    expect(featuresAsked).toEqual(['fees']);

    featureOn = false;
    expect(await resolveDiscordPlayer(client, '111111', { feature: 'fees', waiver: false })).toEqual({
      ok: false,
      refusal: 'feature_off',
    });
  });

  it('still refuses standing and lapsed members on the receipt checks', async () => {
    linkRow = { player_id: 'player-me', players: { ...MEMBER, is_banned: true } };
    expect(await resolveDiscordPlayer(client, '111111', { feature: 'fees', waiver: false })).toEqual({ ok: false, refusal: 'standing' });
    linkRow = { player_id: 'player-me', players: { ...MEMBER, active_flag: false } };
    expect(await resolveDiscordPlayer(client, '111111', { feature: 'fees', waiver: false })).toEqual({ ok: false, refusal: 'lapsed' });
  });
});
