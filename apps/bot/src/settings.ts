// What each Discord setting controls, in the club's words rather than the
// column's.
//
// Pure data and pure functions: no fetch, no token, no clock — same reason
// setup.ts and roles.ts are. /config show is mostly a rendering problem and
// this is the part of it worth testing.
//
// THE APP OWNS THE RULES, THIS OWNS THE MENU. apps/player's settings route has
// its own whitelist and its own validators, and that one is the security
// boundary: a bot rolled ahead of its player app must not be able to write a
// key the app has not agreed to. What lives here is the option list, the
// wording, and the answer to "why is this relay silent" — all of which are the
// bot's business and none of which the app should be describing.

/** A setting a club can change from Discord. */
export interface SettingSpec {
  /** The row in discord_settings. */
  key: string;
  /** The /config option that sets it, and the choice name in /config clear. */
  option: string;
  /** What it is, on one line, in a channel an exec is reading. */
  label: string;
  /**
   * What happens while it is unset.
   *
   * The point of the whole command: an unconfigured relay looks exactly like a
   * working one from outside — it runs on schedule, reports success and posts
   * nothing. This is the sentence that says so.
   */
  whenUnset: string;
}

/** Where each relay posts. Every one of these is a Discord channel id. */
export const CHANNEL_SETTINGS: readonly SettingSpec[] = [
  {
    key: 'announcement_channel_id',
    option: 'announcements',
    label: 'Announcements',
    whenUnset: 'club announcements are not relayed',
  },
  {
    key: 'session_ping_channel_id',
    option: 'session_pings',
    label: 'Session pings',
    whenUnset: 'nobody is pinged before a session',
  },
  {
    key: 'session_board_channel_id',
    option: 'session_board',
    label: 'Session board',
    // BOTH HALVES, because this is the only place either one is written down:
    // unset, no board is posted at all; and clearing it is also the off switch,
    // which takes down the board that is already there.
    whenUnset: 'no upcoming-sessions board is posted, and clearing this takes down the one that is',
  },
  {
    key: 'match_results_channel_id',
    option: 'match_results',
    label: 'Match results',
    whenUnset: 'finished matches are not posted',
  },
  {
    key: 'feedback_channel_id',
    option: 'bug_reports',
    label: 'Bug reports',
    whenUnset: '/bug reports are filed but not shown here',
  },
  {
    key: 'event_feedback_channel_id',
    option: 'event_feedback',
    label: 'Event feedback',
    whenUnset: 'tournament survey comments are not shown here',
  },
  {
    key: 'audit_channel_id',
    option: 'audit_log',
    label: 'Audit log',
    whenUnset: 'role changes are made but not logged',
  },
] as const;

/**
 * The three fields a Discord scheduled event needs that `tournaments` has not
 * got, plus the ping lead time.
 *
 * Not channels, and they behave differently from them in a way worth stating:
 * the tournament relay has NO channel setting at all, because it creates
 * scheduled events rather than posting messages. It is the one relay that runs
 * whether or not anything here is set — these only change what it sends.
 */
export const VALUE_SETTINGS: readonly SettingSpec[] = [
  {
    key: 'tournament_event_start_time',
    option: 'start_time',
    label: 'Tournament start time',
    whenUnset: 'events start at 09:00',
  },
  {
    key: 'tournament_event_end_time',
    option: 'end_time',
    label: 'Tournament end time',
    whenUnset: 'events end at 18:00',
  },
  {
    key: 'tournament_event_location',
    option: 'location',
    label: 'Tournament location',
    whenUnset: 'events carry no location',
  },
  {
    key: 'session_ping_lead_minutes',
    option: 'ping_lead_minutes',
    label: 'Session ping lead time',
    whenUnset: 'pings go out 60 minutes ahead',
  },
] as const;

/**
 * Which role each session ping mentions, one per session group.
 *
 * ITS OWN SETTING, NOT THE ROLE PICKER. The ping job used to learn its roles
 * only from /rolepicker rows carrying a track, which would also list the ping
 * role in the picker and give members a second way to get a role Onboarding
 * already hands out. The app reads these keys first (see the session-pings
 * route); these options are what lets a club set them without SQL.
 *
 * The three mirror the session_group enum. A club with one ping role for
 * everything sets it for all three, which is what `every_session` does.
 */
export const ROLE_SETTINGS: readonly SettingSpec[] = [
  {
    key: 'session_ping_all_role_id',
    option: 'club_nights',
    label: 'Ping role: club-wide sessions',
    whenUnset: 'club-wide sessions ping nobody',
  },
  {
    key: 'session_ping_competitive_role_id',
    option: 'competitive',
    label: 'Ping role: competitive sessions',
    whenUnset: 'competitive sessions ping nobody',
  },
  {
    key: 'session_ping_recreational_role_id',
    option: 'recreational',
    label: 'Ping role: recreational sessions',
    whenUnset: 'recreational sessions ping nobody',
  },
] as const;

export const ALL_SETTINGS: readonly SettingSpec[] = [
  ...CHANNEL_SETTINGS,
  ...ROLE_SETTINGS,
  ...VALUE_SETTINGS,
];

export function specByOption(option: string): SettingSpec | undefined {
  return ALL_SETTINGS.find((s) => s.option === option);
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Check a value the member typed, BEFORE it is sent to the app.
 *
 * The app validates these again and is the authority — this exists so a typo
 * comes back as "07:00, not 7pm" instead of the app's 400, which reaches the
 * member as a generic "couldn't reach the club app". Channels are absent from
 * this list on purpose: Discord's own picker produces those, so there is
 * nothing for a human to get wrong.
 */
export function validateValue(option: string, value: string): string | null {
  switch (option) {
    case 'start_time':
    case 'end_time':
      return CLOCK.test(value) ? null : `**${value}** is not a time — use 24-hour HH:MM, like 09:00.`;
    case 'location':
      return value.length >= 1 && value.length <= 100
        ? null
        : 'The location needs to be between 1 and 100 characters.';
    case 'ping_lead_minutes': {
      const n = Number(value);
      // The floor tracks the cron schedule, not taste: the ping job runs every
      // five minutes, so a shorter lead time would be missed as often as hit.
      return Number.isInteger(n) && n >= 5 && n <= 1440
        ? null
        : 'The lead time has to be a whole number of minutes between 5 and 1440.';
    }
    default:
      return null;
  }
}
