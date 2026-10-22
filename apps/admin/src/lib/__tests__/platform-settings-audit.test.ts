import { describe, it, expect, beforeEach, vi } from 'vitest';

// EVERY PLATFORM SETTING CHANGE CARRIES A TYPED REASON, FROM EITHER SCREEN.
//
// updatePlatformSettings gained the reason as an OPTIONAL parameter when
// /ratings was rebuilt, so /ratings passed one and /accounts — which mounts the
// generic PlatformSettingsForm — did not. The same audited action was therefore
// reasoned or auto-captioned depending on which page the officer happened to
// open, which is the one property an audit log cannot have.
//
// The floor is the server's, not the Save button's: a stale tab or a direct
// call to the action reaches the same write. These tests are on the action.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: { id: 'aaaaaaaa-0000-4000-8000-000000000001' } as Row,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        (store.db[table] ??= []).push({ ...payload });
        return { data: [payload], error: null };
      }
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async single() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      async maybeSingle() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({
  requireCapability: async () => store.actor,
}));

import { updatePlatformSettings } from '../actions/settings';
import { REASON_MIN } from '../audit-reason';
import { SEEDABLE_SETTINGS } from '../platform-setting-fields';

const KEY = 'elo_settings';
const settings = () => store.db.platform_settings ?? [];
const audits = () => store.db.audit_logs ?? [];

beforeEach(() => {
  store.db = {
    platform_settings: [{ key: KEY, value: { k_factor: 32 } }],
    audit_logs: [],
  };
});

describe('updatePlatformSettings — the reason is the boundary', () => {
  it('writes nothing at all when the reason is too short', async () => {
    await expect(
      updatePlatformSettings([{ key: KEY, value: { k_factor: 40 } }], 'oops'),
    ).rejects.toThrow(new RegExp(`at least ${REASON_MIN} characters`));

    expect(settings()[0]!.value).toEqual({ k_factor: 32 });
    expect(audits()).toHaveLength(0);
  });

  it('refuses whitespace that only looks like a reason', async () => {
    await expect(
      updatePlatformSettings([{ key: KEY, value: { k_factor: 40 } }], '        '),
    ).rejects.toThrow();
    expect(audits()).toHaveLength(0);
  });

  it('names the setting rather than one of the two screens it can be changed from', async () => {
    // The message used to say "the rating settings", which stopped being true
    // the moment /accounts could reach the same action.
    await expect(
      updatePlatformSettings([{ key: KEY, value: {} }], ''),
    ).rejects.toThrow(/platform setting/i);
  });

  it('stores the key first and the typed reason after it', async () => {
    await updatePlatformSettings(
      [{ key: KEY, value: { k_factor: 40 } }],
      '  Provisional players were moving too slowly  ',
    );

    expect(settings()[0]!.value).toEqual({ k_factor: 40 });
    expect(audits()).toHaveLength(1);
    // The key leads because target_id is null for a settings row, and /ratings
    // reads these back by the prefix. The reason is trimmed.
    expect(audits()[0]!.reason).toBe(
      `${KEY} — Provisional players were moving too slowly`,
    );
    expect(audits()[0]!.action_type).toBe('platform_setting_updated');
  });

  it('puts the same reason on every key changed in one save', async () => {
    store.db.platform_settings!.push({ key: 'account_settings', value: { auto_approve: false } });

    await updatePlatformSettings(
      [
        { key: KEY, value: { k_factor: 40 } },
        { key: 'account_settings', value: { auto_approve: true } },
      ],
      'Exec meeting 2026-08-11',
    );

    expect(audits().map((a) => a.reason)).toEqual([
      `${KEY} — Exec meeting 2026-08-11`,
      'account_settings — Exec meeting 2026-08-11',
    ]);
  });
});

// A SAVE MAY NOT QUIETLY DELETE A SETTING IT WAS NOT SENT.
//
// The write is a whole-blob JSONB replace, so a payload missing a key removes
// it. Both real forms spread the saved blob first, which is why this never
// showed up in the app — and why nothing stopped a stale tab or a hand-rolled
// POST from doing it. `updates` is a client-controlled POST field, so the shape
// that matters is the one no button produces.
const REAL_RATING_KEY = 'rating_defaults';
const REAL_RATING_BLOB = {
  default_elo: 400,
  min_elo: 100,
  max_elo: 3001,
  tier_beginner_elo: 400,
  tier_intermediate_elo: 800,
  tier_advanced_elo: 1200,
};
const WHY = 'Raising the advanced starting rating';

describe('updatePlatformSettings — a partial blob is refused, not applied', () => {
  beforeEach(() => {
    store.db.platform_settings!.push({ key: REAL_RATING_KEY, value: { ...REAL_RATING_BLOB } });
  });

  const ratingRow = () => settings().find((s) => s.key === REAL_RATING_KEY)!;

  it('refuses a payload holding one field of a six-field blob, and writes nothing', async () => {
    // The crafted-POST shape, verbatim: one tier, no bounds, no other tiers.
    // Before the guard this succeeded and left rating_defaults holding exactly
    // one key — no error, and an audit row that looked entirely normal.
    await expect(
      updatePlatformSettings([{ key: REAL_RATING_KEY, value: { tier_advanced_elo: 9999 } }], WHY),
    ).rejects.toThrow(/would delete the settings/);

    expect(ratingRow().value).toEqual(REAL_RATING_BLOB);
    expect(audits()).toHaveLength(0);
  });

  it('names every key it would have destroyed', async () => {
    // Naming them is the whole point: "invalid payload" tells a stale tab
    // nothing, and tells somebody deleting a key on purpose even less.
    await expect(
      updatePlatformSettings([{ key: REAL_RATING_KEY, value: { tier_advanced_elo: 9999 } }], WHY),
    ).rejects.toThrow(/default_elo, min_elo, max_elo, tier_beginner_elo, tier_intermediate_elo/);
  });

  it('says "the setting" for one and "the settings" for several', async () => {
    const { tier_advanced_elo: _dropped, ...allButOne } = REAL_RATING_BLOB;
    await expect(
      updatePlatformSettings([{ key: REAL_RATING_KEY, value: allButOne }], WHY),
    ).rejects.toThrow(/would delete the setting tier_advanced_elo,/);
  });

  it('still lets a superset through — every field back, one of them changed', async () => {
    // The shape both real forms actually send. This must not have become
    // harder: the guard is about what is ABSENT, never about what is different.
    await updatePlatformSettings(
      [{ key: REAL_RATING_KEY, value: { ...REAL_RATING_BLOB, tier_advanced_elo: 1400 } }],
      WHY,
    );

    expect(ratingRow().value).toEqual({ ...REAL_RATING_BLOB, tier_advanced_elo: 1400 });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]!.old_value).toEqual(REAL_RATING_BLOB);
    expect(audits()[0]!.new_value).toEqual({ ...REAL_RATING_BLOB, tier_advanced_elo: 1400 });
  });

  it('lets a payload ADD a key, which is how a migration-seeded field arrives', async () => {
    await updatePlatformSettings(
      [{ key: REAL_RATING_KEY, value: { ...REAL_RATING_BLOB, provisional_k_enabled: true } }],
      WHY,
    );
    expect(ratingRow().value).toHaveProperty('provisional_k_enabled', true);
  });

  it('refuses a key that does not exist rather than writing an audit row about it', async () => {
    // `.update().eq('key', ...)` matches zero rows and returns no error, so this
    // used to be a silent no-op that still logged a change.
    await expect(
      updatePlatformSettings([{ key: 'rating_defaultz', value: { min_elo: 100 } }], WHY),
    ).rejects.toThrow(/no platform setting called "rating_defaultz"/);
    expect(audits()).toHaveLength(0);
  });

  it('writes NO key when a later key in the same save is refused', async () => {
    // There is no transaction across keys, so the guards run in a pass of their
    // own. Checked per key inside the write loop, this save would have committed
    // elo_settings and audited it before ever looking at the bad second key.
    await expect(
      updatePlatformSettings(
        [
          { key: KEY, value: { k_factor: 40 } },
          { key: REAL_RATING_KEY, value: { tier_advanced_elo: 9999 } },
        ],
        WHY,
      ),
    ).rejects.toThrow(/would delete/);

    expect(settings().find((s) => s.key === KEY)!.value).toEqual({ k_factor: 32 });
    expect(ratingRow().value).toEqual(REAL_RATING_BLOB);
    expect(audits()).toHaveLength(0);
  });
});

// THE FEATURE SWITCHES NEED NO MIGRATION. `features` is the one key the console
// may create: the absent row already means "everything on", so its first save
// inserts it. Every other absent key is still refused, above.
describe('updatePlatformSettings: a seedable key with no row yet', () => {
  const FEATURES_KEY = 'features';
  const featuresRow = () => settings().find((s) => s.key === FEATURES_KEY);
  const allOn = () => ({ ...SEEDABLE_SETTINGS[FEATURES_KEY]!() });

  it('inserts the row on first save and audits it with no "before"', async () => {
    const value = { ...allOn(), tournaments_enabled: false };
    await updatePlatformSettings([{ key: FEATURES_KEY, value }], 'Not running tournaments this term');

    expect(featuresRow()?.value).toEqual(value);
    expect(featuresRow()?.updated_by).toBe(store.actor.id);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]!.old_value).toBeNull();
    expect(audits()[0]!.new_value).toEqual(value);
  });

  it('updates the row once it exists, rather than inserting a second', async () => {
    store.db.platform_settings!.push({ key: FEATURES_KEY, value: allOn() });
    await updatePlatformSettings(
      [{ key: FEATURES_KEY, value: { ...allOn(), sessions_enabled: false } }],
      'Summer break, no sessions',
    );

    expect(settings().filter((s) => s.key === FEATURES_KEY)).toHaveLength(1);
    expect(featuresRow()?.value).toHaveProperty('sessions_enabled', false);
    expect(audits()[0]!.old_value).toEqual(allOn());
  });

  it('still refuses a first save that would drop a switch', async () => {
    await expect(
      updatePlatformSettings([{ key: FEATURES_KEY, value: { tournaments_enabled: false } }], WHY),
    ).rejects.toThrow(/would delete/);
    expect(featuresRow()).toBeUndefined();
    expect(audits()).toHaveLength(0);
  });
});

// THE CLUB LINKS ARE PRINTED ON EVERY PAGE, so a value the site would refuse to
// show is refused here, with a message, rather than saved and silently hidden.
describe('updatePlatformSettings: the club links', () => {
  const socials = (value: Record<string, unknown>) => ({
    key: 'club_socials',
    value: { ...SEEDABLE_SETTINGS.club_socials!(), ...value },
  });
  const payments = (value: Record<string, unknown>) => ({
    key: 'membership_payments',
    value: { ...SEEDABLE_SETTINGS.membership_payments!(), ...value },
  });

  it('seeds both rows on first save', async () => {
    await updatePlatformSettings([socials({}), payments({})], WHY);
    expect(settings().map((s) => s.key)).toEqual(expect.arrayContaining(['club_socials', 'membership_payments']));
  });

  it.each([
    'javascript:alert(1)',
    'http://www.instagram.com/clubladder/',
    'https://evil.com/clubladder',
  ])('refuses the Instagram link %s and writes nothing', async (instagram_url) => {
    await expect(updatePlatformSettings([socials({ instagram_url })], WHY)).rejects.toThrow(/Instagram/);
    expect(settings().some((s) => s.key === 'club_socials')).toBe(false);
    expect(audits()).toHaveLength(0);
  });

  it('allows an empty Instagram link, which hides it', async () => {
    await updatePlatformSettings([socials({ instagram_url: '' })], WHY);
    expect(settings().find((s) => s.key === 'club_socials')?.value).toHaveProperty('instagram_url', '');
  });

  it('refuses a show_discord that is not a boolean', async () => {
    await expect(updatePlatformSettings([socials({ show_discord: 'false' })], WHY)).rejects.toThrow(/Discord/);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'http://store.example.org/'])(
    'refuses the purchase link %s',
    async (sfss_purchase_url) => {
      await expect(updatePlatformSettings([payments({ sfss_purchase_url })], WHY)).rejects.toThrow(/https/);
    },
  );

  it('refuses an e-transfer address that is not one, and allows an empty one', async () => {
    await expect(updatePlatformSettings([payments({ etransfer_email: 'treasurer' })], WHY)).rejects.toThrow(/email/);
    await updatePlatformSettings([payments({ etransfer_email: '' })], WHY);
    expect(settings().find((s) => s.key === 'membership_payments')?.value).toHaveProperty('etransfer_email', '');
  });

  it('refuses a payee name over 100 characters, and allows an empty one (00297)', async () => {
    await expect(updatePlatformSettings([payments({ etransfer_payee_name: 'a'.repeat(101) })], WHY)).rejects.toThrow(
      /payee name/,
    );
    await updatePlatformSettings([payments({ etransfer_payee_name: '' })], WHY);
    expect(settings().find((s) => s.key === 'membership_payments')?.value).toHaveProperty('etransfer_payee_name', '');
  });
});
