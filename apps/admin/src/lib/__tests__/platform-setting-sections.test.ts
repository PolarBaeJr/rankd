import { describe, it, expect } from 'vitest';
import {
  SETTING_SECTION,
  DEFAULT_SECTION,
  sectionForSettingKey,
  settingsForSection,
} from '../platform-setting-sections';
import { FIELD_META, withSeededSettings } from '../platform-setting-fields';
import { defaultFeaturesValue } from '@badminton/shared/src/utils/features';

// The rows that exist in platform_settings on production (nine verified
// 2026-08-06; signup_settings added by migration 00220 on 2026-09-09). Pinned
// here so splitting them across two pages can never lose one: a key that is
// neither in SETTING_SECTION nor caught by the default would simply stop
// rendering, with no error anywhere. `features`, `club_socials` and
// `membership_payments` are the exceptions: no migration seeds them, and the
// console inserts each on its first save.
const PRODUCTION_KEYS = [
  'challenge_rules',
  'club_socials',
  'features',
  'inactivity_rules',
  'membership_payments',
  'rating_defaults',
  'repeat_opponent_caps',
  'season_settings',
  'session_attendance',
  'session_caps',
  'signup_settings',
  'tournament_bonuses',
  'walkover_rules',
];

describe('platform settings section map', () => {
  it('assigns every production key to exactly one section', () => {
    for (const key of PRODUCTION_KEYS) {
      expect(SETTING_SECTION[key], `${key} is unmapped`).toBeDefined();
    }
    expect(Object.keys(SETTING_SECTION).sort()).toEqual([...PRODUCTION_KEYS].sort());
  });

  it('puts the rating-affecting knobs on Ratings', () => {
    for (const key of ['rating_defaults', 'tournament_bonuses', 'season_settings']) {
      expect(sectionForSettingKey(key)).toBe('ratings');
    }
  });

  it('puts the account-governing knobs on Accounts', () => {
    for (const key of [
      'challenge_rules',
      'repeat_opponent_caps',
      'session_caps',
      'walkover_rules',
      'inactivity_rules',
      'session_attendance',
    ]) {
      expect(sectionForSettingKey(key)).toBe('accounts');
    }
  });

  // The failure this guards against is invisible, so it gets its own test: a
  // tenth settings row added by a future migration must surface SOMEWHERE.
  it('surfaces an unmapped key rather than dropping it', () => {
    expect(sectionForSettingKey('some_future_key')).toBe(DEFAULT_SECTION);
    const rows = [{ key: 'some_future_key' }, { key: 'rating_defaults' }];
    expect(settingsForSection(rows, 'accounts')).toEqual([{ key: 'some_future_key' }]);
  });

  it('partitions rows — every row lands on one page and no page shows another’s', () => {
    const rows = PRODUCTION_KEYS.map((key) => ({ key }));
    const ratings = settingsForSection(rows, 'ratings');
    const accounts = settingsForSection(rows, 'accounts');
    const club = settingsForSection(rows, 'club');
    const pages = settingsForSection(rows, 'pages');
    expect(ratings.length + accounts.length + club.length + pages.length).toBe(rows.length);
    expect(ratings.some((r) => accounts.includes(r) || club.includes(r))).toBe(false);
    expect(accounts.some((r) => club.includes(r))).toBe(false);
  });

  // The links the club publishes get their own card, not a place among the
  // account rules.
  it('puts the club links in their own section', () => {
    expect(sectionForSettingKey('club_socials')).toBe('club');
    expect(sectionForSettingKey('membership_payments')).toBe('club');
  });

  it('puts the page switches in their own section', () => {
    expect(sectionForSettingKey('features')).toBe('pages');
  });

  it('renders in map order, not the database’s alphabetical order', () => {
    // Handed to the page alphabetically by .order('key'); Starting Elo should
    // still come before Tournament Bonuses.
    const rows = [{ key: 'season_settings' }, { key: 'rating_defaults' }, { key: 'tournament_bonuses' }];
    expect(settingsForSection(rows, 'ratings').map((r) => r.key)).toEqual([
      'rating_defaults',
      'tournament_bonuses',
      'season_settings',
    ]);
  });
});

describe('withSeededSettings', () => {
  const row = (key: string, value: Record<string, unknown>) => ({
    key,
    value,
    updated_by: null,
    updated_at: '2026-09-01T00:00:00.000Z',
  });

  // Every switch on but guest waivers and predictions, the two features that
  // start off.
  it('stands in for an absent features row with every switch at its default', () => {
    const out = withSeededSettings([row('session_caps', { max_rated_singles_per_session: 3 })]);
    const features = out.find((r) => r.key === 'features');
    expect(features?.value).toEqual(defaultFeaturesValue());
    const {
      guest_waivers_enabled: guestWaivers,
      predictions_enabled: predictions,
      ...rest
    } = features!.value;
    expect(guestWaivers).toBe(false);
    expect(predictions).toBe(false);
    expect(Object.values(rest).every((v) => v === true)).toBe(true);
  });

  it('keeps a saved switch, and adds one a later feature brought in', () => {
    const out = withSeededSettings([row('features', { tournaments_enabled: false })]);
    const features = out.find((r) => r.key === 'features')!;
    expect(features.value.tournaments_enabled).toBe(false);
    expect(Object.keys(features.value).sort()).toEqual(Object.keys(defaultFeaturesValue()).sort());
    expect(out.filter((r) => r.key === 'features')).toHaveLength(1);
  });

  it('draws a switch for every field it stores', () => {
    for (const field of Object.keys(defaultFeaturesValue())) {
      expect(FIELD_META.features?.[field]?.type, field).toBe('boolean');
    }
  });

  // The tile layout shows the warning on its own, but the full hint (the rows
  // layout, and anything else reading it) must still carry it.
  it('keeps the sessions warning in the hint, and gives every switch a summary', () => {
    const sessions = FIELD_META.features!.sessions_enabled!;
    expect(sessions.hint).toContain('WARNING');
    expect(sessions.warning).toMatch(/^WARNING:/);
    expect(sessions.detail).not.toContain('WARNING');
    for (const [field, meta] of Object.entries(FIELD_META.features!)) {
      expect(meta.summary, field).toBeTruthy();
    }
  });
});
