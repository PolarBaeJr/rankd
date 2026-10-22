import { beforeEach, describe, it, expect, vi } from 'vitest';

// getClubSocials() runs in the ROOT LAYOUT. A throw there is a 500 on every
// page, so every way the read can go wrong has to come back as the defaults.

const state = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'error' | 'throw' | 'builder-throws',
  rows: {} as Record<string, unknown>,
}));

vi.mock('../supabase-server', () => ({
  createServiceRoleClient: () => {
    if (state.mode === 'builder-throws') throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    return {
      from: () => {
        let key = '';
        const api = {
          select: () => api,
          eq: (_column: string, value: string) => {
            key = value;
            return api;
          },
          maybeSingle: async () => {
            if (state.mode === 'throw') throw new Error('fetch failed');
            if (state.mode === 'error') return { data: null, error: { message: 'permission denied' } };
            return key in state.rows ? { data: { value: state.rows[key] }, error: null } : { data: null, error: null };
          },
        };
        return api;
      },
    };
  },
}));

import { getClubSocials, getMembershipPayments } from '../club-socials';
import { DEFAULT_INSTAGRAM_URL, DEFAULT_MEMBERSHIP_PURCHASE_URL } from '@badminton/shared';

const DEFAULTS = { instagramUrl: DEFAULT_INSTAGRAM_URL, showDiscord: true };

beforeEach(() => {
  state.mode = 'ok';
  state.rows = {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getClubSocials', () => {
  it('reads the stored row', async () => {
    state.rows.club_socials = { instagram_url: '', show_discord: false };
    await expect(getClubSocials()).resolves.toEqual({ instagramUrl: null, showDiscord: false });
  });

  it('reads a missing row as the defaults', async () => {
    await expect(getClubSocials()).resolves.toEqual(DEFAULTS);
  });

  it('reads a row with missing keys as the defaults for those keys', async () => {
    state.rows.club_socials = { show_discord: false };
    await expect(getClubSocials()).resolves.toEqual({ instagramUrl: DEFAULT_INSTAGRAM_URL, showDiscord: false });
  });

  it('hides a malformed value rather than printing it', async () => {
    state.rows.club_socials = { instagram_url: 'javascript:alert(1)', show_discord: 'no' };
    await expect(getClubSocials()).resolves.toEqual({ instagramUrl: null, showDiscord: true });
  });

  it('survives a value that is not an object at all', async () => {
    state.rows.club_socials = ['not', 'an', 'object'];
    await expect(getClubSocials()).resolves.toEqual(DEFAULTS);
  });

  it.each(['error', 'throw', 'builder-throws'] as const)('falls back to the defaults on a %s', async (mode) => {
    state.mode = mode;
    await expect(getClubSocials()).resolves.toEqual(DEFAULTS);
  });
});

describe('getMembershipPayments', () => {
  it('reads a missing row as the seeded purchase link and no e-transfer address', async () => {
    await expect(getMembershipPayments()).resolves.toEqual({
      sfssPurchaseUrl: DEFAULT_MEMBERSHIP_PURCHASE_URL,
      etransferEmail: null,
      etransferPayeeName: null,
    });
  });

  it('hides a purchase link that is not https', async () => {
    state.rows.membership_payments = { sfss_purchase_url: 'http://example.com', etransfer_email: '' };
    await expect(getMembershipPayments()).resolves.toEqual({
      sfssPurchaseUrl: null,
      etransferEmail: null,
      etransferPayeeName: null,
    });
  });

  it.each(['error', 'throw', 'builder-throws'] as const)('never throws on a %s', async (mode) => {
    state.mode = mode;
    await expect(getMembershipPayments()).resolves.toEqual({
      sfssPurchaseUrl: DEFAULT_MEMBERSHIP_PURCHASE_URL,
      etransferEmail: null,
      etransferPayeeName: null,
    });
  });
});
