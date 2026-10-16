// CLUB CHANGES IN PLAIN LANGUAGE (00286).
//
// The triggers store a structured diff for every officer edit: which setting
// or officer role, which field, the value before and the value after. This
// module turns one of those into the sentence a member reads, and the console
// shows it as the draft line.
//
// Written for members, not officers. The console's own field labels and hints
// (platform-setting-fields.ts) are written for the person editing the value
// and several carry an em dash, so none of them is reused here: every phrase
// below is its own member-facing label, and the tests hold the map to cover
// every field FIELD_META has, with no stale entries.
//
// A key or field this map does not know (a row added later, or something typed
// into the raw JSON editor on /ratings) never shows its raw name. It reads "A
// club setting was updated" and is marked unknown, and posting refuses it
// until an admin rewords it.
//
// Deliberately dependency-free: no React, no Supabase. The feature registry and
// the capability labels are imported deeply for the same reason the settings
// form does it.
import {
  FEATURES,
  FEATURES_SETTING_KEY,
  featureField,
  type FeatureDefinition,
  type FeatureId,
} from '@badminton/shared/src/utils/features';
import { CLUB_SOCIALS_SETTING_KEY } from '@badminton/shared/src/utils/club-socials';
import { MEMBERSHIP_PAYMENTS_SETTING_KEY } from '@badminton/shared/src/utils/membership-settings';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
import { isCapability } from '@badminton/shared/src/utils/access-level';
import { SEEDABLE_SETTINGS } from './platform-setting-fields';
import { sectionForSettingKey, type PlatformSettingsSection } from './platform-setting-sections';

export type ClubChangeSource = 'setting' | 'baseline' | 'manual';

/** A club_change_drafts row, as the console reads it. */
export interface ClubChangeDraft {
  id: string;
  source: ClubChangeSource;
  subject: string | null;
  field: string | null;
  from_value: unknown;
  to_value: unknown;
  text_override: string | null;
  override_to_value: unknown;
  first_actor_id: string | null;
  last_actor_id: string | null;
  revision: number;
  created_at: string;
  changed_at: string;
}

export type ClubChangeGroup =
  | 'Ratings'
  | 'Account rules'
  | 'Member pages'
  | 'Club links'
  | 'Officer roles'
  | 'Added by hand';

export interface FormattedDraft {
  /** What will be posted: the admin's wording when there is one. */
  text: string;
  /** The generated sentence, null for a line typed by hand. */
  autoText: string | null;
  /** False when the generated sentence is the generic fallback. */
  known: boolean;
  group: ClubChangeGroup;
  /** Nothing actually changed (a first save that wrote the defaults). */
  noOp: boolean;
  /** Reworded, and the setting moved again after the rewording. */
  staleRewording: boolean;
}

export const UNKNOWN_CHANGE_TEXT = 'A club setting was updated';

/** The longest line the database accepts, and the box allows. */
export const CLUB_CHANGE_LINE_MAX = 300;

export type Phrase =
  | { kind: 'number'; label: string; unit?: string; percent?: boolean }
  | { kind: 'toggle'; label: string }
  | { kind: 'select'; label: string; options: Record<string, string> }
  | { kind: 'link'; label: string }
  | { kind: 'private'; label: string };

const num = (label: string, unit?: string): Phrase => ({ kind: 'number', label, unit });
const toggle = (label: string): Phrase => ({ kind: 'toggle', label });

const FEATURE_PHRASES: Record<string, Phrase> = Object.fromEntries(
  (FEATURES as readonly FeatureDefinition[]).map((feature) => [
    featureField(feature.id as FeatureId),
    toggle(`Member pages: ${feature.label}`),
  ]),
);

export const CHANGE_PHRASES: Record<string, Record<string, Phrase>> = {
  rating_defaults: {
    default_elo: num('Ladder baseline rating'),
    sweep_margin_multiplier: num('Sweep bonus multiplier'),
    max_elo: num('Maximum rating'),
    min_elo: num('Minimum rating'),
    provisional_threshold: num('Placement matches'),
    singles_k_provisional: num('Singles K-factor (new players)'),
    singles_k_established: num('Singles K-factor (established players)'),
    doubles_k_provisional: num('Doubles K-factor (new players)'),
    doubles_k_established: num('Doubles K-factor (established players)'),
    provisional_k_enabled: toggle('Faster rating changes for new players'),
    tier_beginner_elo: num('Beginner starting rating'),
    tier_intermediate_elo: num('Intermediate starting rating'),
    tier_advanced_elo: num('Advanced starting rating'),
    repeat_decay_pct: { kind: 'number', label: 'Repeat challenge reduction', percent: true },
    repeat_window_days: num('Repeat challenge window', 'days'),
    repeat_min_factor: num('Repeat challenge floor'),
  },
  tournament_bonuses: {
    enabled: toggle('Tournament placement bonuses'),
    singles_champion: num('Singles champion bonus', 'points'),
    singles_finalist: num('Singles finalist bonus', 'points'),
    singles_thirdplace: num('Singles third place bonus', 'points'),
    singles_semifinalist: num('Singles semifinalist bonus', 'points'),
    singles_quarterfinalist: num('Singles quarterfinalist bonus', 'points'),
    doubles_champion: num('Doubles champion bonus', 'points'),
    doubles_finalist: num('Doubles finalist bonus', 'points'),
    doubles_thirdplace: num('Doubles third place bonus', 'points'),
    doubles_semifinalist: num('Doubles semifinalist bonus', 'points'),
    doubles_quarterfinalist: num('Doubles quarterfinalist bonus', 'points'),
  },
  season_settings: {
    tier_size: num('Season reset tier size', 'points'),
    soft_compression_enabled: toggle('Season-end rating compression'),
    compression_factor: num('Season-end compression factor'),
  },
  signup_settings: {
    auto_approve_enabled: toggle('Automatic approval of new members'),
    auto_approve_status: {
      kind: 'select',
      label: 'Automatically approved members join as',
      options: { recreational: 'Recreational', competitive: 'Competitive' },
    },
  },
  challenge_rules: {
    elo_range: num('Challenge rating range', 'points'),
    ladder_range: num('Challenge ladder range', 'places'),
    max_active_challenges: num('Open challenges allowed at once'),
    challenge_expiry_hours: num('Time to answer a challenge', 'hours'),
  },
  repeat_opponent_caps: {
    max_rated_singles_vs_same_7days: num('Rated singles against the same opponent'),
    max_rated_doubles_same_combo_7days: num('Rated doubles with the same players'),
    window_days: num('Same opponent limit window', 'days'),
  },
  session_caps: {
    max_rated_singles_per_session: num('Rated singles per session'),
    max_rated_doubles_per_session: num('Rated doubles per session'),
  },
  walkover_rules: {
    grace_period_minutes: num('Lateness grace period', 'minutes'),
    admin_review_window_hours: num('Walkover review window', 'hours'),
    late_withdrawal_threshold_hours: num('Late withdrawal cutoff', 'hours'),
    no_show_auto_flag_threshold: num('No-shows before a review'),
    no_show_auto_flag_rolling_days: num('No-show counting window', 'days'),
    no_show_auto_suspend_threshold: num('No-shows before an automatic suspension'),
  },
  inactivity_rules: {
    inactive_threshold_days: num('Days without playing before a member is marked inactive', 'days'),
    purge_after_days: num('Inactive accounts have their personal details erased after', 'days'),
  },
  session_attendance: {
    checkin_opens_minutes_before: num('Check-in opens before a session', 'minutes'),
    default_duration_minutes: num('Default session length', 'minutes'),
  },
  [FEATURES_SETTING_KEY]: FEATURE_PHRASES,
  [CLUB_SOCIALS_SETTING_KEY]: {
    instagram_url: { kind: 'link', label: 'Instagram link' },
    show_discord: toggle('Discord links'),
  },
  [MEMBERSHIP_PAYMENTS_SETTING_KEY]: {
    sfss_purchase_url: { kind: 'link', label: 'Buy a membership link' },
    // Never the address itself: the line is published.
    etransfer_email: { kind: 'private', label: 'E-transfer email' },
  },
};

const SECTION_GROUP: Record<PlatformSettingsSection, ClubChangeGroup> = {
  ratings: 'Ratings',
  accounts: 'Account rules',
  pages: 'Member pages',
  club: 'Club links',
};

/** Value equality as the database sees it: 24 and 24.0 are the same. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a ?? null) === stable(b ?? null);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const isBlank = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function withUnit(phrase: Extract<Phrase, { kind: 'number' }>, value: number): string {
  if (phrase.percent) return `${formatNumber(value)}%`;
  if (!phrase.unit) return formatNumber(value);
  const unit = value === 1 ? phrase.unit.replace(/s$/, '') : phrase.unit;
  return `${formatNumber(value)} ${unit}`;
}

/** One phrase applied to one change. Never shows a raw key or a private value. */
export function renderPhrase(phrase: Phrase, from: unknown, to: unknown): string {
  switch (phrase.kind) {
    case 'number': {
      if (isBlank(to)) return `${phrase.label} cleared`;
      if (typeof to !== 'number' || !Number.isFinite(to)) return `${phrase.label} updated`;
      if (typeof from !== 'number' || !Number.isFinite(from)) {
        return `${phrase.label} set to ${withUnit(phrase, to)}`;
      }
      return `${phrase.label} changed from ${withUnit(phrase, from)} to ${withUnit(phrase, to)}`;
    }
    case 'toggle':
      if (to === true) return `${phrase.label} turned on`;
      if (to === false) return `${phrase.label} turned off`;
      return `${phrase.label} updated`;
    case 'select': {
      const toLabel = typeof to === 'string' ? phrase.options[to] : undefined;
      const fromLabel = typeof from === 'string' ? phrase.options[from] : undefined;
      if (!toLabel) return `${phrase.label} updated`;
      return fromLabel
        ? `${phrase.label} changed from ${fromLabel} to ${toLabel}`
        : `${phrase.label} set to ${toLabel}`;
    }
    case 'link':
    case 'private':
      if (isBlank(to)) return `${phrase.label} removed`;
      if (isBlank(from)) return `${phrase.label} added`;
      return `${phrase.label} updated`;
  }
}

type BaselineValue = { name: string; capabilities: string[] };

function asBaselineValue(value: unknown): BaselineValue | null {
  if (value === null || typeof value !== 'object') return null;
  const { name, capabilities } = value as Record<string, unknown>;
  if (typeof name !== 'string' || !Array.isArray(capabilities)) return null;
  return { name, capabilities: capabilities.filter((c): c is string => typeof c === 'string') };
}

function capabilityLabels(capabilities: string[]): string[] {
  return capabilities.filter(isCapability).map((capability) => CAPABILITY_GATES[capability].label);
}

/** An officer role created, removed, renamed or given different abilities. */
export function renderBaselineChange(from: unknown, to: unknown): { text: string; known: boolean } {
  const before = asBaselineValue(from);
  const after = asBaselineValue(to);
  if (!before && after) return { text: `New officer role: ${after.name}`, known: true };
  if (before && !after) return { text: `Officer role removed: ${before.name}`, known: true };
  if (!before || !after) return { text: 'An officer role was updated', known: false };

  const had = new Set(before.capabilities);
  const has = new Set(after.capabilities);
  const gained = capabilityLabels(after.capabilities.filter((c) => !had.has(c)));
  const lost = capabilityLabels(before.capabilities.filter((c) => !has.has(c)));
  const renamed = before.name !== after.name;

  const abilities: string[] = [];
  if (gained.length > 0) abilities.push(`can now: ${gained.join(', ')}`);
  if (lost.length > 0) abilities.push(`no longer: ${lost.join(', ')}`);
  const sentence = abilities.map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)));

  if (renamed && sentence.length > 0) {
    return {
      text: `Officer role ${before.name} renamed to ${after.name}. It ${sentence.join('. ')}`,
      known: true,
    };
  }
  if (renamed) return { text: `Officer role ${before.name} renamed to ${after.name}`, known: true };
  if (sentence.length > 0) return { text: `Officer role ${after.name} ${sentence.join('. ')}`, known: true };
  return { text: `Officer role ${after.name} updated`, known: true };
}

/** The value a missing settings row stood for, when the console may seed it. */
function seededFrom(key: string, field: string): unknown {
  const defaults = SEEDABLE_SETTINGS[key];
  return defaults ? defaults()[field] ?? null : null;
}

/** The sentence, group and state of one draft line. */
export function formatDraft(draft: ClubChangeDraft): FormattedDraft {
  const override = draft.text_override?.trim() || null;

  if (draft.source === 'manual') {
    return {
      text: override ?? '',
      autoText: null,
      known: true,
      group: 'Added by hand',
      noOp: false,
      staleRewording: false,
    };
  }

  const staleRewording = override !== null && !sameValue(draft.override_to_value, draft.to_value);
  let auto: { text: string; known: boolean; noOp: boolean; group: ClubChangeGroup };

  if (draft.source === 'baseline') {
    const rendered = renderBaselineChange(draft.from_value, draft.to_value);
    auto = { ...rendered, noOp: sameValue(draft.from_value, draft.to_value), group: 'Officer roles' };
  } else {
    const key = draft.subject ?? '';
    const field = draft.field ?? '';
    const group = SECTION_GROUP[sectionForSettingKey(key)];
    // A first save of a row the console may seed records "from nothing". The
    // row stood for its defaults until then, so that is what it changed from.
    const from = draft.from_value ?? seededFrom(key, field);
    const noOp = sameValue(from, draft.to_value);
    const phrase = CHANGE_PHRASES[key]?.[field];
    auto = phrase
      ? { text: renderPhrase(phrase, from, draft.to_value), known: true, noOp, group }
      : { text: UNKNOWN_CHANGE_TEXT, known: false, noOp, group };
  }

  return {
    text: override ?? auto.text,
    autoText: auto.text,
    known: auto.known,
    group: auto.group,
    noOp: auto.noOp,
    staleRewording,
  };
}

/**
 * Why this line may not be posted as it stands, or null when it may. The same
 * sentence the console shows beside the line.
 */
export function postRefusal(formatted: FormattedDraft, reworded: boolean): string | null {
  if (formatted.staleRewording) {
    return 'This setting changed again since you reworded the line. Check the wording, or reset it.';
  }
  if (!formatted.known && !reworded) {
    return 'This line needs wording before it can be posted.';
  }
  if (formatted.text.trim() === '') return 'This line is empty.';
  return null;
}
