import { describe, it, expect } from 'vitest';
import {
  CHANGE_PHRASES,
  UNKNOWN_CHANGE_TEXT,
  formatDraft,
  postRefusal,
  renderBaselineChange,
  renderPhrase,
  sameValue,
  type ClubChangeDraft,
} from '../club-change-format';
import { FIELD_META, SEEDABLE_SETTINGS, SETTING_LABELS } from '../platform-setting-fields';
import { SETTING_SECTION } from '../platform-setting-sections';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';

// CLUB CHANGES ARE PUBLISHED TO MEMBERS (00286), so every sentence this module
// can produce is member copy. These hold the phrase map to the settings the
// console can actually save, and every sentence to the copy rules.

const EM_DASH = /\u2014/;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const SNAKE_CASE = /\b[a-z]+_[a-z_]+\b/;
const LEAKS = /undefined|null|\[object|NaN/;

function draft(overrides: Partial<ClubChangeDraft>): ClubChangeDraft {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    source: 'setting',
    subject: 'rating_defaults',
    field: 'singles_k_established',
    from_value: 32,
    to_value: 24,
    text_override: null,
    override_to_value: null,
    first_actor_id: null,
    last_actor_id: null,
    revision: 1,
    created_at: '2026-10-08T00:00:00Z',
    changed_at: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}

describe('the phrase map', () => {
  it('has a phrase for every field of every setting the console knows', () => {
    const keys = new Set([
      ...Object.keys(SETTING_SECTION),
      ...Object.keys(SETTING_LABELS),
      ...Object.keys(SEEDABLE_SETTINGS),
      ...Object.keys(FIELD_META),
    ]);
    for (const key of keys) {
      expect(CHANGE_PHRASES[key], `no phrases for ${key}`).toBeDefined();
      for (const field of Object.keys(FIELD_META[key] ?? {})) {
        expect(CHANGE_PHRASES[key]![field], `no phrase for ${key}.${field}`).toBeDefined();
      }
    }
  });

  it('names no field the console does not have', () => {
    for (const [key, fields] of Object.entries(CHANGE_PHRASES)) {
      for (const field of Object.keys(fields)) {
        expect(FIELD_META[key]?.[field], `stale phrase ${key}.${field}`).toBeDefined();
      }
    }
  });

  it('renders every phrase without an em dash, an emoji, a raw key or a leaked value', () => {
    const samples: [unknown, unknown][] = [
      [1, 2],
      [true, false],
      [false, true],
      [null, 5],
      [3, null],
      ['', 'https://example.com/a'],
      ['https://example.com/a', ''],
      ['recreational', 'competitive'],
    ];
    for (const [key, fields] of Object.entries(CHANGE_PHRASES)) {
      for (const [field, phrase] of Object.entries(fields)) {
        for (const [from, to] of samples) {
          const text = renderPhrase(phrase, from, to);
          const where = `${key}.${field} ${JSON.stringify([from, to])}: ${text}`;
          expect(text, where).not.toMatch(EM_DASH);
          expect(text, where).not.toMatch(PICTOGRAPH);
          expect(text, where).not.toMatch(SNAKE_CASE);
          expect(text, where).not.toMatch(LEAKS);
          expect(text.length, where).toBeLessThanOrEqual(300);
        }
      }
    }
  });
});

describe('formatDraft', () => {
  it('says a K-factor change the way a member reads it', () => {
    expect(formatDraft(draft({})).text).toBe('Singles K-factor (established players) changed from 32 to 24');
  });

  it('says a member page switch the way a member reads it', () => {
    const formatted = formatDraft(
      draft({ subject: 'features', field: 'challenges_enabled', from_value: true, to_value: false }),
    );
    expect(formatted.text).toBe('Member pages: Challenges turned off');
    expect(formatted.group).toBe('Member pages');
  });

  it('puts units and percentages on the numbers', () => {
    expect(
      formatDraft(draft({ subject: 'challenge_rules', field: 'challenge_expiry_hours', from_value: 48, to_value: 24 })).text,
    ).toBe('Time to answer a challenge changed from 48 hours to 24 hours');
    expect(
      formatDraft(draft({ field: 'repeat_decay_pct', from_value: 20, to_value: 25 })).text,
    ).toBe('Repeat challenge reduction changed from 20% to 25%');
  });

  it('never prints the e-transfer email', () => {
    const formatted = formatDraft(
      draft({
        subject: 'membership_payments',
        field: 'etransfer_email',
        from_value: 'old@example.com',
        to_value: 'new@example.com',
      }),
    );
    expect(formatted.text).toBe('E-transfer email updated');
    expect(formatted.text).not.toContain('@');
  });

  it('treats 24 and 24.0 as no change', () => {
    expect(sameValue(24, 24.0)).toBe(true);
    expect(formatDraft(draft({ from_value: 24, to_value: 24.0 })).noOp).toBe(true);
  });

  it('judges a first save of a seeded row against its defaults', () => {
    const unchanged = formatDraft(
      draft({ subject: 'features', field: 'challenges_enabled', from_value: null, to_value: true }),
    );
    expect(unchanged.noOp).toBe(true);
    const changed = formatDraft(
      draft({ subject: 'features', field: 'challenges_enabled', from_value: null, to_value: false }),
    );
    expect(changed.noOp).toBe(false);
    expect(changed.text).toBe('Member pages: Challenges turned off');
  });

  it('never shows a raw key it does not know, and marks the line as needing words', () => {
    for (const unknown of [
      draft({ subject: 'rating_defaults', field: 'secret_knob' }),
      draft({ subject: 'brand_new_setting', field: 'anything' }),
      draft({ subject: 'rating_defaults', field: '*' }),
    ]) {
      const formatted = formatDraft(unknown);
      expect(formatted.text).toBe(UNKNOWN_CHANGE_TEXT);
      expect(formatted.known).toBe(false);
      expect(postRefusal(formatted, false)).not.toBeNull();
    }
  });

  it('lets an admin reword an unknown line so it can be posted', () => {
    const formatted = formatDraft(
      draft({ field: 'secret_knob', text_override: 'A new rating rule is in place.', override_to_value: 24 }),
    );
    expect(formatted.text).toBe('A new rating rule is in place.');
    expect(postRefusal(formatted, true)).toBeNull();
  });

  it('flags a rewording the setting has moved past', () => {
    const formatted = formatDraft(draft({ text_override: 'K-factor is now 24.', override_to_value: 24, to_value: 20 }));
    expect(formatted.staleRewording).toBe(true);
    expect(postRefusal(formatted, true)).toMatch(/changed again/);
    expect(formatDraft(draft({ text_override: 'K-factor is now 24.', override_to_value: 24 })).staleRewording).toBe(false);
  });

  it('files each source under its group', () => {
    expect(formatDraft(draft({})).group).toBe('Ratings');
    expect(formatDraft(draft({ subject: 'signup_settings', field: 'auto_approve_enabled', to_value: true })).group).toBe(
      'Account rules',
    );
    expect(formatDraft(draft({ subject: 'club_socials', field: 'show_discord', to_value: false })).group).toBe(
      'Club links',
    );
    expect(formatDraft(draft({ source: 'manual', subject: null, field: null, text_override: 'Hi' })).group).toBe(
      'Added by hand',
    );
  });
});

describe('officer roles', () => {
  const role = (name: string, capabilities: string[]) => ({ name, capabilities });

  it('names a new role and a removed one', () => {
    expect(renderBaselineChange(null, role('Treasurer', ['fees.page'])).text).toBe('New officer role: Treasurer');
    expect(renderBaselineChange(role('Treasurer', ['fees.page']), null).text).toBe('Officer role removed: Treasurer');
  });

  it('describes a change of abilities with the editor labels, dropping unknown strings', () => {
    const text = renderBaselineChange(
      role('Treasurer', ['fees.page', 'retired.capability.write']),
      role('Treasurer', ['matches.page', 'another.retired.write']),
    ).text;
    expect(text).toBe(
      `Officer role Treasurer can now: ${CAPABILITY_GATES['matches.page'].label}. No longer: ${CAPABILITY_GATES['fees.page'].label}`,
    );
    expect(text).not.toMatch(/retired/);
  });

  it('describes a rename', () => {
    expect(renderBaselineChange(role('A', ['fees.page']), role('B', ['fees.page'])).text).toBe(
      'Officer role A renamed to B',
    );
  });

  it('uses no capability label with an em dash or an emoji', () => {
    for (const entry of Object.values(CAPABILITY_GATES)) {
      expect(entry.label).not.toMatch(EM_DASH);
      expect(entry.label).not.toMatch(PICTOGRAPH);
    }
  });
});
