// Labels, descriptions and per-field metadata for every platform_settings row.
//
// Lifted out of components/platform-settings-form.tsx so that the two screens
// which draw these settings — /accounts (the generic form) and /ratings (its
// own three-column layout) — read ONE description of what each field means.
// Two copies of a hint is how the console ends up telling an officer that the
// starting rating is 800 on one page and 400 on the other.
//
// Deliberately dependency-free: no React, no Supabase. It is imported by a
// client component, a server page and the tests. The feature registry is
// imported deeply for the same reason: it has no imports of its own.
import {
  FEATURES,
  FEATURES_SETTING_KEY,
  defaultFeaturesValue,
  featureField,
  type FeatureDefinition,
  type FeatureId,
} from '@badminton/shared/src/utils/features';
import { CLUB_SOCIALS_SETTING_KEY, defaultClubSocialsValue } from '@badminton/shared/src/utils/club-socials';
import {
  MEMBERSHIP_PAYMENTS_SETTING_KEY,
  defaultMembershipPaymentsValue,
} from '@badminton/shared/src/utils/membership-settings';

export interface PlatformSetting {
  key: string;
  value: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string;
}

export const SETTING_LABELS: Record<string, string> = {
  challenge_rules: 'Challenge Rules',
  session_caps: 'Session Caps',
  repeat_opponent_caps: 'Repeat Opponent Caps',
  walkover_rules: 'Walkover & No-Show Rules',
  rating_defaults: 'Rating Defaults',
  tournament_bonuses: 'Tournament Bonuses',
  season_settings: 'Season Settings',
  inactivity_rules: 'Inactivity Rules',
  session_attendance: 'Session Attendance',
  signup_settings: 'Signup Approval',
  features: 'Club Features',
  club_socials: 'Instagram and Discord',
  membership_payments: 'Buying a membership',
};

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  challenge_rules: 'Elo range, ladder range, max active challenges, expiry hours',
  session_caps: 'Maximum rated matches per session (singles and doubles)',
  repeat_opponent_caps: 'Maximum rated matches against the same opponent in a rolling window',
  walkover_rules: 'Grace periods, withdrawal thresholds, auto-flag and auto-suspend limits',
  rating_defaults: 'Starting Elo, provisional threshold, K-factors, repeat challenges',
  tournament_bonuses: 'Placement bonus amounts for singles and doubles tournaments',
  season_settings: 'Compression factor for end-of-season Elo normalization',
  inactivity_rules: 'Days of inactivity before auto-marking players inactive',
  session_attendance: 'Check-in window and default session duration',
  signup_settings: 'Whether a new signup is approved automatically or waits for an exec',
  features: 'Which member-facing features are running',
  club_socials: 'The Instagram and Discord links on the site and in the bot',
  membership_payments: 'Where the membership page sends people to buy a membership',
};

export interface FieldMeta {
  label: string;
  hint: string;
  type: 'number' | 'boolean' | 'text' | 'select';
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
  /**
   * The closed set of values, for `type: 'select'` only.
   *
   * A setting with a fixed vocabulary was a free-text box until now, and the
   * cost of that showed up in the hint rather than the control: the field had
   * to end by explaining what happens when you type something that is not one
   * of the two allowed words. The database still refuses a bad value the same
   * way — see the WARNING branch in 00220 — this just stops the console being
   * able to produce one.
   */
  options?: readonly { value: string; label: string }[];
  /** One line under the label, for the tile layout. */
  summary?: string;
  /** Always shown in the tile layout, never tucked behind the disclosure. */
  warning?: string;
  /** The tile layout's disclosure body: the hint without the warning. */
  detail?: string;
  /**
   * A fixed prefix drawn beside the input (see lib/prefixed-url.ts). The stored
   * value stays the full URL.
   */
  adornment?: 'https' | 'instagram';
}

export const FIELD_META: Record<string, Record<string, FieldMeta>> = {
  challenge_rules: {
    elo_range: {
      label: 'Elo range',
      hint: 'Players can only challenge within this many Elo points.',
      type: 'number',
      min: 0,
      step: 1,
    },
    ladder_range: {
      label: 'Ladder range',
      hint: 'Players can only challenge within this many ladder positions.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_active_challenges: {
      label: 'Max active challenges',
      hint: 'Each player can have at most this many open challenges at a time.',
      type: 'number',
      min: 1,
      step: 1,
    },
    challenge_expiry_hours: {
      label: 'Challenge expiry (hours)',
      hint: 'Unanswered challenges expire after this many hours.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  session_caps: {
    max_rated_singles_per_session: {
      label: 'Max rated singles per session',
      hint: 'Rated singles matches one player can play in a single session.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_rated_doubles_per_session: {
      label: 'Max rated doubles per session',
      hint: 'Rated doubles matches one player can play in a single session.',
      type: 'number',
      min: 0,
      step: 1,
    },
  },
  repeat_opponent_caps: {
    max_rated_singles_vs_same_7days: {
      label: 'Rated singles vs same opponent',
      hint: 'Rated singles against the same opponent allowed within the window below.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_rated_doubles_same_combo_7days: {
      label: 'Rated doubles, same combo',
      hint: 'Rated doubles with the same team combination allowed within the window below.',
      type: 'number',
      min: 0,
      step: 1,
    },
    // The window was hardcoded at 7 days and only implied by the key names
    // above, which are kept as-is so existing stored values keep working.
    window_days: {
      label: 'Rolling window (days)',
      hint: 'How far back the two caps above look. Defaults to 7.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  walkover_rules: {
    grace_period_minutes: {
      label: 'Grace period (minutes)',
      hint: 'How long a player can be late before the match can be claimed as a walkover.',
      type: 'number',
      min: 0,
      step: 1,
    },
    admin_review_window_hours: {
      label: 'Admin review window (hours)',
      hint: 'How long admins have to review a reported walkover before it stands.',
      type: 'number',
      min: 0,
      step: 1,
    },
    late_withdrawal_threshold_hours: {
      label: 'Late withdrawal threshold (hours)',
      hint: 'Withdrawing closer to the session than this counts as a late withdrawal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    no_show_auto_flag_threshold: {
      label: 'No-show auto-flag',
      hint: 'No-shows within the rolling window before a player is flagged for review.',
      type: 'number',
      min: 1,
      step: 1,
    },
    no_show_auto_flag_rolling_days: {
      label: 'No-show rolling window (days)',
      hint: 'How many days back no-shows are counted.',
      type: 'number',
      min: 1,
      step: 1,
    },
    no_show_auto_suspend_threshold: {
      label: 'No-show auto-suspend',
      hint: 'No-shows within the rolling window before a player is automatically suspended.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  rating_defaults: {
    default_elo: {
      // NOT "Starting rating", which is what this said and is the one thing it
      // does not do. Every path that creates a rating row writes a literal 400
      // and reads no setting at all: create_player_with_rating (00003:887,
      // redefined at 00023:89 and 00132:548) spells the number out, and the
      // approval trigger (00220:310) inserts `(player_id)` alone and takes the
      // ratings.singles_elo column DEFAULT 400 from 00001:190. So an admin who
      // set this to 600 expecting new members to start at 600 got new members
      // at 400, with nothing anywhere saying otherwise — and the fields that DO
      // decide a new member's rating sit two sections down under New members.
      // The label was the whole of the confusion, so it is the label that moved.
      label: 'Ladder baseline',
      // Two real jobs — 00055 for the compression baseline, 00127:184 for the
      // sentinel. The sentinel is the non-obvious one: apply_skill_tier_seed
      // has no match counter to consult, so "has anyone decided this rating
      // yet" is answered by comparing it to this number.
      hint: 'The bottom of the ladder: a full season reset writes this value, and a soft reset compresses every rating toward it. It also defines what an untouched rating looks like, which is how a skill tier tells "nobody has decided yet" apart from a rating an exec set by hand. It does NOT set a new member\'s rating — the three tier fields under New members do that.',
      type: 'number',
      min: 0,
      step: 1,
    },
    sweep_margin_multiplier: {
      label: 'Sweep bonus multiplier',
      hint: 'Extra rating movement when a multi-game match ends in a sweep (2-0). Applies to both players — the winner gains this much more, the loser drops this much more. 1.0 turns margin scaling off. Matches that go the distance are never scaled.',
      type: 'number',
      min: 1,
      max: 2,
      step: 0.05,
    },
    max_elo: {
      label: 'Maximum Elo',
      hint: 'Rating ceiling. At the cap a win gains nothing while the loser still drops in full, so ratings leak out of the ladder — keep this well clear of your strongest player.',
      type: 'number',
      min: 1,
      step: 50,
    },
    min_elo: {
      label: 'Minimum Elo',
      hint: 'Rating floor. Applied the same way as the ceiling, in reverse.',
      type: 'number',
      min: 0,
      step: 50,
    },
    provisional_threshold: {
      label: 'Placement matches',
      hint: 'Rated matches a member must complete before their rating counts as established. Until then they move on the provisional K-factors below, so a new member settles quickly.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_k_provisional: {
      label: 'Singles K (provisional)',
      hint: "How fast a provisional player's singles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    singles_k_established: {
      label: 'Singles K (established)',
      hint: "How fast an established player's singles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    doubles_k_provisional: {
      label: 'Doubles K (provisional)',
      hint: "How fast a provisional player's doubles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    doubles_k_established: {
      label: 'Doubles K (established)',
      hint: "How fast an established player's doubles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    provisional_k_enabled: {
      label: 'Provisional K-factors',
      // Names the consequence, not the mechanism. Switching this off is the
      // decision on this page most likely to be made without realising what it
      // does, so the hint says what stops happening — including the interaction
      // with the skill tiers, which is not obvious from either field alone.
      hint: 'On: new members move on the higher provisional K-factors until they have played their placement matches, so a wrong starting rating corrects itself in a few matches. Off: everybody moves on the established K-factors from their first match, and a member who understated their skill level at signup takes far longer to be found out.',
      type: 'boolean',
    },
    tier_beginner_elo: {
      label: 'Beginner starting rating',
      // "the starting rating above" until the field above stopped claiming to
      // be one. Named rather than pointed at, because the two are now in
      // different sections and "above" would be a direction, not a reference.
      hint: 'Assigned to a member who picks Beginner at signup. Normally the same as the ladder baseline, so the tier changes nothing for a true beginner.',
      type: 'number',
      min: 0,
      step: 50,
    },
    tier_intermediate_elo: {
      label: 'Intermediate starting rating',
      hint: 'Assigned to a member who picks Intermediate at signup.',
      type: 'number',
      min: 0,
      step: 50,
    },
    tier_advanced_elo: {
      label: 'Advanced starting rating',
      hint: 'Assigned to a member who picks Advanced at signup. Only ever seeds a rating that has never moved — a member claiming a roster row you already rated keeps the rating you gave them.',
      type: 'number',
      min: 0,
      step: 50,
    },
    // Repeat challenges (00268). Also editable by execs from the card on
    // /matches, which validates the same ranges in updateRepeatChallengeSettings.
    repeat_decay_pct: {
      label: 'Repeat challenge reduction (%)',
      hint: "Each earlier rated challenge between the same players inside the window cuts this match's rating change by this percentage, compounding. 0 turns it off.",
      type: 'number',
      min: 0,
      max: 90,
      step: 5,
    },
    repeat_window_days: {
      label: 'Repeat challenge window (days)',
      hint: 'How far back an earlier challenge between the same players still counts.',
      type: 'number',
      min: 1,
      max: 365,
      step: 1,
    },
    repeat_min_factor: {
      label: 'Repeat challenge floor',
      hint: 'The smallest share of a normal rating change a repeat can fall to, from 0 to 1.',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.05,
    },
  },
  tournament_bonuses: {
    enabled: {
      label: 'Bonuses enabled',
      hint: 'Award bonus Elo for tournament placements.',
      type: 'boolean',
    },
    singles_champion: {
      label: 'Singles champion',
      hint: 'Bonus Elo for winning a singles tournament.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_finalist: {
      label: 'Singles finalist',
      hint: 'Bonus Elo for reaching a singles final.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_thirdplace: {
      label: 'Singles 3rd place',
      hint: 'Bonus Elo for winning the singles third-place play-off. Fourth takes the semifinalist amount.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_semifinalist: {
      label: 'Singles semifinalist',
      hint: 'Bonus Elo for reaching a singles semifinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_quarterfinalist: {
      label: 'Singles quarterfinalist',
      hint: 'Bonus Elo for reaching a singles quarterfinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_champion: {
      label: 'Doubles champion',
      hint: 'Bonus Elo for winning a doubles tournament.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_finalist: {
      label: 'Doubles finalist',
      hint: 'Bonus Elo for reaching a doubles final.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_thirdplace: {
      label: 'Doubles 3rd place',
      hint: 'Bonus Elo for winning the doubles third-place play-off. Fourth takes the semifinalist amount.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_semifinalist: {
      label: 'Doubles semifinalist',
      hint: 'Bonus Elo for reaching a doubles semifinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_quarterfinalist: {
      label: 'Doubles quarterfinalist',
      hint: 'Bonus Elo for reaching a doubles quarterfinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
  },
  season_settings: {
    // The tier band the soft reset refuses to drop anyone below, and the
    // ladder floor everything compresses toward. Both were hardcoded in
    // activate_season until 00055.
    tier_size: {
      label: 'Tier size (Elo points)',
      // Also said "the starting rating above". It was already the weaker of the
      // two references — this is a different settings key in a different
      // section, so "above" was never pointing at anything adjacent.
      hint: 'Soft reset never drops a player below the bottom of the tier they earned. The ladder floor itself is the ladder baseline, under The formula.',
      type: 'number',
      min: 1,
      step: 25,
    },
    soft_compression_enabled: {
      label: 'Soft compression',
      hint: 'Pull every rating toward the average at season end.',
      type: 'boolean',
    },
    compression_factor: {
      label: 'Compression factor',
      hint: 'How strongly season-end ratings are pulled toward the average (0 to 1).',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
    },
  },
  inactivity_rules: {
    inactive_threshold_days: {
      label: 'Inactive threshold (days)',
      hint: 'Days without playing before a player is automatically marked inactive.',
      type: 'number',
      min: 1,
      step: 1,
    },
    purge_after_days: {
      label: 'Erase personal details after (days)',
      hint: 'Days a membership stays inactive before its personal details (name, email, phone, photo, bio) are permanently erased. Match history and ratings are kept under an anonymous name. Signing in resets this. This number is also what the inactivity email promises, so changing it changes the notice members receive.',
      type: 'number',
      // 30 days is the floor on purpose: anything shorter would erase people
      // faster than the 30-day grace window we give members who explicitly
      // ASKED to be deleted, which would be incoherent.
      min: 30,
      step: 1,
    },
  },
  session_attendance: {
    checkin_opens_minutes_before: {
      label: 'Check-in opens (minutes before)',
      hint: 'Minutes before the session start that self check-in opens. Leave empty to let players check in any time.',
      type: 'number',
      min: 0,
      step: 1,
      nullable: true,
    },
    default_duration_minutes: {
      label: 'Default session duration (minutes)',
      hint: 'Used to decide when check-in closes for sessions without an end time.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  // Backs migration 00220. The row renders without these two entries — an
  // unmapped key falls through to SettingsForm's raw JSON textarea — but the
  // switch is the one an exec has to be able to find and flip in a hurry, and
  // "edit this JSON correctly" is not that.
  signup_settings: {
    auto_approve_enabled: {
      label: 'Approve new signups automatically',
      hint: 'On: anyone who finishes setup joins the club immediately, with no exec review. Off: they wait in Pending until an exec approves them, which is the normal way in. Intended for the first week of a semester, when the queue is hundreds of people long. Turning it off does not un-approve anyone already in.',
      type: 'boolean',
    },
    auto_approve_status: {
      label: 'Auto-approved members join as',
      // The hint no longer has to end by warning about typos. It used to say
      // "Anything else here leaves everyone pending, which is the safe
      // direction" — true, and still true of the database, but it was the
      // control apologising for itself. A closed set is a closed control.
      hint: 'Recreational is the default and the cheaper fee tier. Both appear on the leaderboard and can challenge, so this only decides which membership they are billed for.',
      type: 'select',
      options: [
        { value: 'recreational', label: 'Recreational' },
        { value: 'competitive', label: 'Competitive' },
      ],
    },
  },
  // Both read by the player app and the bot, which re-check every value; the
  // console refuses a bad one on save (updatePlatformSettings).
  [CLUB_SOCIALS_SETTING_KEY]: {
    instagram_url: {
      label: 'Instagram',
      hint: 'The club Instagram profile, as https://www.instagram.com/<name>/. Shown in the page footer, on the socials page and in the bot. Leave empty to hide Instagram everywhere.',
      type: 'text',
      adornment: 'instagram',
    },
    show_discord: {
      label: 'Show Discord',
      hint: 'Off hides every link to the club Discord: the nav, the page footer, the socials page and the bot\'s /socials reply. Linking a Discord account still works. The Social links switch under Club Features hides all of the links at once.',
      type: 'boolean',
    },
  },
  [MEMBERSHIP_PAYMENTS_SETTING_KEY]: {
    sfss_purchase_url: {
      label: 'Buy membership link',
      hint: 'The Campus Recreation page where a membership is bought. It must start with https://. The membership page shows a "Buy membership on Campus Recreation" button while this is set; leave it empty to hide the button.',
      type: 'text',
      adornment: 'https',
    },
    etransfer_email: {
      label: 'E-transfer email',
      hint: 'Where members send an Interac e-Transfer for club fees. While this is empty, members cannot upload payment receipts: the Membership page says e-transfer is not set up.',
      type: 'text',
    },
    etransfer_payee_name: {
      label: 'E-transfer payee name',
      hint: 'The name a member\'s bank shows the club as on an e-Transfer receipt, for example Club Ladder. An e-transfer receipt confirms itself only when it shows this name or the e-transfer email as the recipient; otherwise an exec reviews it. Leave empty to match on the email alone.',
      type: 'text',
    },
  },
  // One switch per entry in the shared feature registry, so a feature added
  // there appears here with no second list to keep in step.
  // FEATURES is `as const`, so `warning` is only readable through the wider type.
  [FEATURES_SETTING_KEY]: Object.fromEntries(
    (FEATURES as readonly FeatureDefinition[]).map((f): [string, FieldMeta] => {
      const offNote =
        f.offNote ??
        ` Off hides it from members and sends them to the feed; admins, and anyone given its access key (page.access.${f.id}) under Permissions, can still open it.`;
      return [
        featureField(f.id as FeatureId),
        {
          label: f.label,
          hint: `${f.description}${f.warning ? ` ${f.warning}` : ''}${offNote}`,
          type: 'boolean',
          summary: f.summary,
          warning: f.warning,
          detail: `${f.description}${offNote}`,
        },
      ];
    }),
  ),
};

/**
 * Settings rows the console may create on first save, with the value a missing
 * row stands for. Every other key still has to be seeded by a migration, and
 * updatePlatformSettings refuses one that is absent.
 *
 * `features` is here so the switches need no migration: until somebody saves
 * one, the absent row already means every feature at its default. `club_socials` and
 * `membership_payments` are here for the same reason.
 */
export const SEEDABLE_SETTINGS: Record<string, () => Record<string, unknown>> = {
  [FEATURES_SETTING_KEY]: defaultFeaturesValue,
  // The same defaults the player app and the bot read an absent row as, so the
  // form shows what the site is already showing.
  [CLUB_SOCIALS_SETTING_KEY]: defaultClubSocialsValue,
  [MEMBERSHIP_PAYMENTS_SETTING_KEY]: defaultMembershipPaymentsValue,
};

/**
 * The rows as the form should draw them: a seedable row that does not exist
 * yet is stood in by its defaults, and one that exists gains any field added
 * to its defaults since it was saved (a feature added to the registry later),
 * so every switch renders.
 */
export function withSeededSettings(rows: PlatformSetting[]): PlatformSetting[] {
  const out = rows.map((row) =>
    SEEDABLE_SETTINGS[row.key]
      ? { ...row, value: { ...SEEDABLE_SETTINGS[row.key]!(), ...row.value } }
      : row,
  );
  for (const [key, defaults] of Object.entries(SEEDABLE_SETTINGS)) {
    if (!out.some((row) => row.key === key)) {
      out.push({ key, value: defaults(), updated_by: null, updated_at: new Date(0).toISOString() });
    }
  }
  return out;
}
