// CLUB FEATURE SWITCHES: which optional member-facing features are running.
//
// One platform_settings row, key `features`, holding `<id>_enabled` booleans.
// No migration seeds it: an absent row or an absent field reads as the
// feature's default, so nothing changes until an admin flips a switch on
// /accounts. The first save inserts the row (see SEEDABLE_SETTINGS in the
// admin's actions/settings.ts).
//
// ON BY DEFAULT, unless the entry says `defaultEnabled: false`. A default-on
// feature is switched off only by a literal `false`; a default-off one is
// switched on only by a literal `true`. So every doubt resolves to the default.
//
// A FAILED READ IS ALSO THE DEFAULT. Hiding a feature is not a safety
// property, and a settings blip must not make a live tournament vanish
// mid-event. A default-off feature stays off, because it is off until somebody
// has decided otherwise (guest_waivers waits on a privacy policy that covers
// guests).
//
// THIS REGISTRY DRIVES EVERYTHING ELSE: the player nav, the admin nav, the
// redirect gate on the player routes, the refusal in the player actions and
// the switches on the settings form. Adding a feature is one entry here plus
// a gate on its routes; feature-registry.test.ts in the player app checks that
// every route named below exists and that no protected route is switchable.
//
// EVERY ENTRY ALSO MINTS A CAPABILITY, `page.access.<id>`, derived in
// ./access-level.ts: the key that lets one person into the feature while it is
// off. So a new entry also needs the string added to the vocabulary CHECKs in
// a migration, and capability-storage.test.ts fails until it is.
//
// Deliberately dependency-free, so the nav modules and a client component can
// import it deeply without pulling the shared barrel.
//
// NEVER SWITCHABLE: the feed and home page, settings, legal, sign-in,
// onboarding, account linking, notifications, email and unsubscribe, the exec
// panel and feedback. Account, legal and safety paths must always work.

export interface FeatureDefinition {
  id: string;
  label: string;
  /** One line under the switch's label. */
  summary: string;
  /** Shown beside the switch. Names the knock-on effects of switching it off. */
  description: string;
  /** A consequence serious enough to stay visible, not tucked behind a disclosure. */
  warning?: string;
  /**
   * Player app route prefixes this feature owns: hidden from the nav when off,
   * and gated by a FeatureGate in app/<route>/layout.tsx, which redirects
   * anybody not holding the feature's `page.access.<id>` key. The leaderboard gates its index page only, so profiles under it
   * stay reachable, and so does the guest waiver, so a proof link under it
   * outlives the switch.
   */
  playerRoutes: readonly string[];
  /**
   * Admin console pages this feature owns. Their nav items and dashboard
   * signposts are hidden when off from anybody not holding the feature's
   * `page.access.<id>` key; the pages stay reachable by URL and carry a banner
   * (app/<route>/layout.tsx in the admin app).
   */
  adminRoutes: readonly string[];
  /** Absent means on. False keeps the feature off until an admin switches it on. */
  defaultEnabled?: boolean;
  /**
   * Replaces the settings form's generic sentence about what off does, for a
   * feature where "members are sent to the feed" is not what happens.
   */
  offNote?: string;
}

export const FEATURES = [
  {
    id: 'sessions',
    label: 'Sessions',
    summary: 'Schedule, RSVPs and check-in',
    description:
      'The schedule, RSVPs and session check-in, including the door QR code. Off also stops the automatic session reminders and the Discord session pings and list.',
    warning:
      'WARNING: a session check-in is what keeps a membership active. With this off for longer than the inactivity threshold, every member who is not an exec is marked inactive and sent the inactivity notice, and one who then never signs in has their personal details erased on the usual schedule.',
    playerRoutes: ['/sessions', '/checkin'],
    adminRoutes: ['/sessions'],
  },
  {
    id: 'challenges',
    label: 'Challenges',
    summary: 'Members challenging each other to rated matches',
    description:
      'Members challenging each other to rated matches and reporting the results. Off stops members creating, answering or reporting challenges; matches an exec records are unaffected.',
    playerRoutes: ['/challenges'],
    adminRoutes: ['/challenges'],
  },
  {
    id: 'tournaments',
    label: 'Tournaments',
    summary: 'Tournament pages, entry and check-in',
    description:
      'Tournament pages, entry, withdrawal and check-in. Off also stops Discord scheduled events being created for tournaments and empties the Discord tournament list. Past tournaments stay in the console.',
    playerRoutes: ['/tournaments'],
    adminRoutes: ['/tournaments'],
  },
  {
    id: 'events',
    label: 'Club events',
    summary: 'Socials, workshops and the AGM',
    description:
      'Socials, workshops, clinics, outings and the AGM, and signing up for them. Off hides them from members and refuses sign-ups, and stops club events being posted to the Discord Events tab; the console keeps every event and sign-up.',
    playerRoutes: ['/events'],
    adminRoutes: ['/events'],
  },
  {
    id: 'leaderboard',
    label: 'Leaderboard',
    summary: 'The ranked ladder',
    description:
      'The ranked ladder, and the Discord leaderboard command. Ratings still move. Member profiles stay reachable, since they are linked from everywhere.',
    playerRoutes: ['/leaderboard'],
    adminRoutes: [],
  },
  {
    id: 'my_stats',
    label: 'My stats',
    summary: "A member's own stats page",
    description: "A member's own stats page. Their data is untouched.",
    playerRoutes: ['/my-stats'],
    adminRoutes: [],
  },
  {
    id: 'announcements',
    label: 'Announcements',
    summary: 'Club news on the feed and in Discord',
    description:
      'The announcements page and the announcements on the feed. Off also stops announcements being posted to Discord.',
    playerRoutes: ['/announcements'],
    adminRoutes: ['/announcements'],
  },
  {
    id: 'fees',
    label: 'Fees',
    summary: "A member's statement and e-transfer receipts",
    description:
      "A member's own statement on the membership page, the way to pay it by e-transfer, the unpaid-fees banner and the Paid badge on profiles. Fees are still owed and still recorded in Finances; members just cannot see their statement or send receipts.",
    playerRoutes: ['/fees'],
    adminRoutes: [],
  },
  {
    id: 'membership',
    label: 'Membership page',
    summary: 'Prices and where to buy a membership',
    description:
      'The public membership page: this season\'s prices and where to buy a membership, for visitors and members alike. Off hides the page and its nav item, and with it a member\'s statement and the way to pay, even while the Fees switch is on. Fees are still owed and recorded.',
    playerRoutes: ['/membership'],
    adminRoutes: [],
  },
  {
    id: 'socials',
    label: 'Social links',
    summary: 'Instagram and Discord links everywhere',
    description:
      "The club's social links: the socials page, the links in the page footer and on the membership page, the Discord links in the nav, and the Discord bot's /socials command. Off hides every one of them. Linking a Discord account still works. Instagram and Discord can also be hidden one at a time under Club links.",
    playerRoutes: ['/socials'],
    adminRoutes: [],
  },
  {
    id: 'guest_waivers',
    label: 'External waivers',
    summary: 'Non-members sign the waiver and privacy policy with a name and email',
    description:
      'A public page where somebody who is not a member signs the liability waiver and the privacy policy with only a name and an email, and gets a link that proves it. Execs see the signings under Legal.',
    warning:
      'WARNING: keep this off until the privacy policy has been republished, with a new version, to cover externals. The current policy is written for members only, and every external signing records the version it was signed against.',
    offNote:
      ' Off hides the external waiver page and the links to it, and refuses new signings. Proof links already given out still work, and the console list stays.',
    playerRoutes: ['/guest-waiver'],
    adminRoutes: ['/legal/guests'],
    defaultEnabled: false,
  },
  // No route of its own: the cards sit on the challenge screens of a member
  // who plays in the challenge, and each one asks the switch itself (player
  // lib/predictions.ts).
  {
    id: 'predictions',
    label: 'Match predictions',
    summary: "Win predictions on a member's own challenges",
    description:
      'Shows win predictions posted through the Data API. Predictions never change ratings.',
    offNote:
      ' Off hides the prediction cards on challenges. Predictions a Data API key has already posted are kept.',
    playerRoutes: [],
    adminRoutes: [],
    defaultEnabled: false,
  },
] as const satisfies readonly FeatureDefinition[];

export type FeatureId = (typeof FEATURES)[number]['id'];

export type FeatureFlags = Record<FeatureId, boolean>;

export const FEATURES_SETTING_KEY = 'features';

/** The stored field for one feature, e.g. `tournaments_enabled`. */
export function featureField(id: FeatureId): string {
  return `${id}_enabled`;
}

export const ALL_FEATURES_ENABLED: FeatureFlags = Object.fromEntries(
  FEATURES.map((f) => [f.id, true]),
) as FeatureFlags;

function defaultOn(f: FeatureDefinition): boolean {
  return f.defaultEnabled ?? true;
}

/**
 * Each feature at its default: what an absent row, and a failed read, mean.
 * NOT ALL_FEATURES_ENABLED, which stays literally everything on for the nav
 * components and tests that want that.
 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = Object.fromEntries(
  (FEATURES as readonly FeatureDefinition[]).map((f) => [f.id, defaultOn(f)]),
) as FeatureFlags;

/** The row a first save starts from: every feature at its default. */
export function defaultFeaturesValue(): Record<string, boolean> {
  return Object.fromEntries(
    (FEATURES as readonly FeatureDefinition[]).map((f) => [featureField(f.id as FeatureId), defaultOn(f)]),
  );
}

/**
 * The stored row as a flag per feature. A default-on feature is off only for a
 * literal `false`; a default-off one is on only for a literal `true`. An absent
 * row, an absent field, a string, a null or a non-object all read as the
 * default.
 */
export function parseFeatureFlags(value: unknown): FeatureFlags {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    (FEATURES as readonly FeatureDefinition[]).map((f) => {
      const stored = row[featureField(f.id as FeatureId)];
      return [f.id, defaultOn(f) ? stored !== false : stored === true];
    }),
  ) as FeatureFlags;
}

function ownsPath(routes: readonly string[], path: string): boolean {
  return routes.some((route) => path === route || path.startsWith(`${route}/`));
}

/** The feature that owns this player app path, or null for an always-on one. */
export function playerFeatureFor(path: string): FeatureId | null {
  return FEATURES.find((f) => ownsPath(f.playerRoutes, path))?.id ?? null;
}

/** The feature that owns this admin page, or null. */
export function adminFeatureFor(href: string): FeatureId | null {
  return FEATURES.find((f) => (f.adminRoutes as readonly string[]).includes(href))?.id ?? null;
}

export function featureLabel(id: FeatureId): string {
  return FEATURES.find((f) => f.id === id)?.label ?? id;
}

/**
 * What a viewer gets on a feature's page.
 *
 *   allow     the feature is on
 *   banner    it is off, but the viewer holds its `page.access.<id>` key
 *             (featureAccessFor in ./access-level.ts), so they can still open
 *             it, to check it before switching it back on
 *   redirect  it is off and the viewer does not hold the key
 */
export type FeatureGateDecision = 'allow' | 'banner' | 'redirect';

export function featureGate(enabled: boolean, holdsAccess: boolean): FeatureGateDecision {
  if (enabled) return 'allow';
  return holdsAccess ? 'banner' : 'redirect';
}

/**
 * Can this viewer be shown a link to this player path? `access` is the list of
 * features whose key they hold: a plain array, because it crosses from the
 * server layout into client components.
 */
export function playerPathVisible(
  path: string,
  flags: FeatureFlags,
  access: readonly FeatureId[],
): boolean {
  const id = playerFeatureFor(path);
  return id === null || featureGate(flags[id], access.includes(id)) !== 'redirect';
}

/** The sentence a refused player action throws. */
export function featureOffMessage(id: FeatureId): string {
  return `The club has switched ${featureLabel(id).toLowerCase()} off for now.`;
}

// Minimal structural shape so any Supabase client in this repo fits.
type FlagsReader = { from: (table: string) => any };

/**
 * Read the switches. Never throws: a failed read logs and returns the
 * defaults, which is the behaviour before this row existed.
 */
export async function readFeatureFlags(client: FlagsReader): Promise<FeatureFlags> {
  try {
    const { data, error } = await client
      .from('platform_settings')
      .select('value')
      .eq('key', FEATURES_SETTING_KEY)
      .maybeSingle();
    if (error) {
      console.error('[features] could not read the feature switches, using the defaults:', error.message);
      return { ...DEFAULT_FEATURE_FLAGS };
    }
    return parseFeatureFlags(data?.value ?? null);
  } catch (err) {
    console.error('[features] could not read the feature switches, using the defaults:', err);
    return { ...DEFAULT_FEATURE_FLAGS };
  }
}
