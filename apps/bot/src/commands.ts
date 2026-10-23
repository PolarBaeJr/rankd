import { randomUUID } from 'node:crypto';
import {
  addSelfRole,
  AppApiError,
  clearRevocations,
  deleteLink,
  fetchCard,
  fetchLeaderboard,
  fetchLinkedAccounts,
  fetchProfile,
  fetchSelfRoles,
  fetchSessions,
  fetchTournaments,
  fetchTournamentChoices,
  fetchTournamentDraw,
  fetchNextTournamentMatch,
  fetchTournamentResults,
  enterTournamentEvent,
  forceLinkDiscordAccount,
  forceSyncMember,
  forceUnlinkDiscordAccount,
  isMemberBanned,
  RateLimitedError,
  removeSelfRole,
  submitFeedback,
  SweepManagedRoleError,
  AlreadyLinkedError,
  mintLinkToken,
  writeGuildConfig,
  writeServerRoleCatalog,
  fetchDiscordSettings,
  fetchClubSocials,
  writeDiscordSettings,
  checkDiscordManager,
  fetchServerSettings,
  writeServerSettings,
  type ManagerRefusal,
  submitAnnouncement,
  setMembership,
  createChallenge,
  fetchOpenChallenges,
  reportChallenge,
  signupStep,
  submitReceipt,
  fetchOwnFees,
  fetchSchedule,
  adminGet,
  adminSend,
  ConsoleNotAvailableError,
  ConsoleNotConfiguredError,
  type ConsoleReply,
  type ChallengeRefusal,
  type ReceiptReply,
  type SignupReply,
  type SignupScreen,
  type CardFile,
  type FeedbackKind,
  type ProfilePayload,
  type SessionsPage,
  type SessionSummary,
  type TournamentsPage,
  type TournamentSummary,
  type TournamentDraw,
  type TournamentEntryReply,
} from './api.js';
import { postAuditEntry, summaryFromOutcomes } from './audit.js';
import { SOFTBAN_WINDOWS, describeWindow, softban, windowSeconds } from './moderation.js';
import { parseServerLogScopes } from './server-log.js';
import { invalidateConfigCache, loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';
import { loadHandles, matchHandles } from './handles.js';
import { syncMembersNow } from './member-sync.js';
import { MEMBERSHIP_ROLES, type GuildRoleMap, type ManagedRole, type MembershipRole } from './roles.js';
import { offerableRoles } from './server-roles.js';
import { DISPLAY_NAMES, planSetup, type DiscordRole, type MatchedRole } from './setup.js';
import { syncMemberEverywhere } from './sync.js';
import { socialsReply, type SocialsPayload } from './socials.js';
import {
  ALL_SETTINGS,
  CHANNEL_SETTINGS,
  ROLE_SETTINGS,
  VALUE_SETTINGS,
  specByOption,
  validateValue,
} from './settings.js';

// The accent red, the app's single accent (--red: #c00). Keeps Discord output visually
// part of the same product rather than Discord-default blurple.
const CLUB_RED = 0xcc0000;

// THE CLUB'S OWN SUBDOMAIN, NEVER A discord.gg CODE. The subdomain is a
// Cloudflare 301 at the club's own domain, and that redirect IS the indirection
// layer: a Discord invite expires, gets revoked, or is rotated after a raid,
// and the new code is one DNS record away. A raw discord.gg code printed on a
// poster or frozen into a pinned embed cannot be reprinted when that happens,
// so the poster quietly becomes a dead end nobody reports.
const DISCORD_INVITE_URL = 'https://discord.sfubadminton.com';
// Served by the player app, not by the bot: the bot image copies only
// package.json and dist (see the Dockerfile), so it has no bytes to upload.
// The file is apps/player/public/qr/discord.png, and what it encodes is the
// SUBDOMAIN above, not the discord.gg code behind it. That is what carries the
// argument above through to the picture: rotate the invite and a printed poster
// still resolves, because the image never named the code it points at.
const DISCORD_QR_PATH = '/qr/discord.png';

const LADDER_LABEL: Record<string, string> = {
  singles: 'Singles',
  doubles: 'Doubles',
  points: 'Tournament points',
};

/**
 * THE TWO GATES, and which one a command needs.
 *
 * They answer different questions, and a command that writes club data needs
 * BOTH. Getting this wrong in either direction is the sort of mistake that
 * looks fine until it does not, so it is written down here rather than decided
 * again per command.
 *
 * GATE 1 -- `default_member_permissions`, enforced by DISCORD, decides who can
 * SEE and RUN the command. It is the only thing that can hide a command from
 * the picker, and the only gate that applies before the bot is involved at all.
 * What it cannot do is know anything about the club: Discord has no idea who
 * the treasurer is.
 *
 * GATE 2 -- the LINKED MEMBER'S APP CAPABILITY, enforced by the app, decides
 * whether the action is actually allowed. This is the real authority. A Discord
 * role is a claim about a person; `players.permission_role` and the capability
 * resolver are what the club's own records say, and they are what the website
 * enforces. Anyone who can edit roles in Discord could otherwise grant
 * themselves whatever a Discord-only check was looking for -- which is exactly
 * the escalation roles.ts refuses to allow in the other direction.
 *
 * So: leave it unset for reads anybody may do, MANAGE_GUILD for Discord
 * plumbing, EXEC_ONLY to keep exec tooling out of everyone else's command list
 * -- and for anything that WRITES to the club's records, EXEC_ONLY to hide it
 * PLUS a capability check on the linked member to enforce it. The visibility
 * gate is tidiness; the capability check is the security boundary. Never let
 * the first stand in for the second.
 */

/**
 * MANAGE_GUILD (1 << 5). Server administration -- creating roles, wiring the
 * bot into the server. Whoever holds it could do the same work by hand.
 */
const MANAGE_GUILD = '32';

/**
 * Hidden from everyone until a server admin grants it to a role.
 *
 * `'0'` is Discord's documented way to say "no default access": the command is
 * invisible in the picker for every non-administrator until somebody opens
 * Server Settings -> Integrations -> SFU Badminton -> Command permissions and
 * allows a role -- normally @Executives, which /setup already creates.
 *
 * WHY '0' RATHER THAN A PERMISSION BIT EXECS HAPPEN TO HOLD. Picking something
 * like Manage Messages would make the audience "whoever holds that Discord
 * permission", which drifts the moment somebody grants Manage Messages to
 * helpers during an unrelated tidy-up. '0' makes the audience an explicit list
 * rather than a side effect.
 *
 * FAILS CLOSED: if nobody ever grants it, the command is simply unavailable
 * outside the admins. The wrong people never get it by accident.
 */
const EXEC_ONLY = '0';

/** BAN_MEMBERS (1 << 2). Only /softban uses it; see the note on its definition. */
const BAN_MEMBERS = '4';

/**
 * The club event kinds, as /event create offers them. A copy of
 * CLUB_EVENT_KINDS in packages/shared/src/utils/club-events.ts: the bot does
 * not import the shared package. The console's schema refuses anything else,
 * so a drift shows up as a refusal rather than a wrong row.
 */
const CLUB_EVENT_KIND_CHOICES = [
  { name: 'Social', value: 'social' },
  { name: 'Workshop', value: 'workshop' },
  { name: 'Clinic', value: 'clinic' },
  { name: 'Outing', value: 'outing' },
  { name: 'AGM', value: 'agm' },
  { name: 'Other', value: 'other' },
];

/** The tournament every /tourney subcommand starts from. */
const TOURNEY_TOURNAMENT_OPTION = {
  type: 3,
  name: 'tournament',
  description: 'The tournament',
  required: true,
  autocomplete: true,
};

/** A participant or a pair, read from the console once a tournament is picked. */
const TOURNEY_ENTRY_OPTION = {
  type: 3,
  name: 'entry',
  description: 'The player or pair',
  required: true,
  autocomplete: true,
};

/** A match, listed side A first so a score can be typed the same way round. */
const TOURNEY_MATCH_OPTION = {
  type: 3,
  name: 'match',
  description: 'The match (side A is named first)',
  required: true,
  autocomplete: true,
};

export const COMMAND_DEFINITIONS = [
  {
    name: 'leaderboard',
    description: 'Club ladder standings',
    options: [
      {
        type: 3, // STRING
        name: 'ladder',
        description: 'Which ladder (defaults to doubles)',
        required: false,
        choices: [
          { name: 'Doubles', value: 'doubles' },
          { name: 'Singles', value: 'singles' },
          { name: 'Tournament points', value: 'points' },
        ],
      },
      {
        type: 4, // INTEGER
        name: 'page',
        description: 'Page number',
        required: false,
        min_value: 1,
      },
    ],
  },
  {
    name: 'profile',
    description: 'A member\u2019s club profile card',
    options: [
      {
        type: 6, // USER
        name: 'member',
        description: 'Whose card (defaults to yours)',
        required: false,
      },
      {
        type: 3, // STRING
        name: 'handle',
        description: 'Club handle, for a member who has not linked Discord',
        required: false,
        // The `member` option above cannot have this: Discord populates a USER
        // option from the server's own member list and only accepts
        // autocomplete on STRING, INTEGER and NUMBER.
        autocomplete: true,
      },
      {
        type: 3, // STRING
        name: 'type',
        // The club ranks two elos four ways, and by default the card shows the
        // whole table. This asks it to headline ONE of them instead.
        description: 'Headline one ladder instead of the whole table',
        required: false,
        // CHOICES, not free text, and the values are /leaderboard's own
        // CategoryId strings. Discord enforces the list on its side, and the
        // card route re-validates against the same allowlist rather than
        // trusting it -- the value reaches the route as a query parameter and
        // a query parameter is whatever the caller says it is.
        choices: [
          { name: 'Doubles — open', value: 'open_doubles' },
          { name: 'Singles — open', value: 'open_singles' },
          { name: 'Doubles — competitive', value: 'comp_doubles' },
          { name: 'Singles — competitive', value: 'comp_singles' },
        ],
      },
    ],
  },
  {
    name: 'sessions',
    description: 'Upcoming club sessions',
    options: [],
  },
  {
    // ONE WORD, because Discord's command names are `^[-_\p{L}\p{N}]{1,32}$`
    // and lowercase -- there is no /sessionPost to register.
    //
    // A SIBLING of /sessions rather than a subcommand of it. Adding subcommands
    // would turn the command every member already uses into `/sessions list`,
    // which is a rename of the club's most-run command to make room for one
    // execs use. They sort next to each other in the picker anyway.
    name: 'sessionpost',
    description: 'Post the club-wide session schedule into this channel',
    options: [],
    // EXEC_ONLY, on the same argument /rolepicker post makes: this writes a
    // message into a shared channel under the club's name. It is not gated on
    // MANAGE_GUILD because posting the schedule is session-running work and the
    // execs who run sessions are usually not the one or two people holding that
    // bit. '0' means an admin grants @Executives once, in Integrations.
    default_member_permissions: EXEC_ONLY,
  },
  {
    // SUBCOMMANDS SINCE 1.1.1. A client still holding the old registration
    // sends /tournaments with no subcommand, and that is the list.
    name: 'tournaments',
    description: 'Club tournaments: what is on, enter, draws and results',
    options: [
      { type: 1, name: 'list', description: 'Tournaments happening now and coming up', options: [] },
      {
        type: 1,
        name: 'enter',
        description: 'Enter a singles event as yourself',
        options: [
          { type: 3, name: 'tournament', description: 'The tournament', required: true, autocomplete: true },
          { type: 3, name: 'event', description: 'The event (only ones taking entries)', required: true, autocomplete: true },
        ],
      },
      {
        type: 1,
        name: 'draw',
        description: "An event's draw",
        options: [
          { type: 3, name: 'tournament', description: 'The tournament', required: true, autocomplete: true },
          { type: 3, name: 'event', description: 'The event', required: true, autocomplete: true },
        ],
      },
      { type: 1, name: 'next', description: 'Your next tournament match', options: [] },
      {
        type: 1,
        name: 'results',
        description: 'On court now and the latest results',
        options: [
          { type: 3, name: 'tournament', description: 'The tournament', required: true, autocomplete: true },
        ],
      },
    ],
  },
  {
    // NO default_member_permissions, deliberately. EXEC_ONLY is right there in
    // this file and copying it here would make /bug invisible to everyone who
    // is not an admin — which is everyone who would ever report a bug. The
    // audience for these two is the whole club.
    name: 'bug',
    description: 'Report something in the app that is broken',
    // THE WORDS ARE NOT HERE. A title and a body are collected in a modal (see
    // openReportModal) because a slash-command option is a single line that
    // truncates in the client at the width of the input — people write one
    // sentence into it and stop. A paragraph box gets a reproduction.
    //
    // The screenshot is a command option, picked on the interaction before
    // the modal and carried across. When this was written a modal could only
    // hold text inputs; Discord has since added a file upload component, so
    // moving the picture into the modal is now possible, just not done.
    options: [
      {
        type: 11, // ATTACHMENT
        name: 'screenshot',
        description: 'Optional: a picture of what went wrong',
        required: false,
      },
    ],
  },
  {
    name: 'feedback',
    description: 'Tell the club what you think',
    // Same shape as /bug: the words come from the modal, the picture from an option.
    // `about` stays a command option rather than moving into the modal, because
    // a modal's only component is a text input — there is no way to offer three
    // choices in one, and a free-text "what is this about" would be a fourth
    // thing to type for a value the route has to validate anyway.
    options: [
      {
        type: 11, // ATTACHMENT
        name: 'screenshot',
        description: 'Optional: a picture, if one helps',
        required: false,
      },
      {
        type: 3, // STRING
        name: 'about',
        description: 'What it is about (defaults to general feedback)',
        required: false,
        choices: [
          { name: 'The club or the app in general', value: 'feedback' },
          { name: 'A tournament', value: 'tournament_feedback' },
          { name: 'Something else', value: 'other' },
        ],
      },
    ],
  },
  {
    // EXEC_ONLY, and it is the strongest case for it in this file: everything
    // else behind that flag reads club data or wires up the server, and this
    // one WRITES something every member reads. The flag is only half of it --
    // Discord's command-list filter is not authorization, so the app checks the
    // caller's own `announcements.create.write` before writing anything. See
    // the route.
    name: 'announce',
    description: 'Post a club announcement to the website',
    default_member_permissions: EXEC_ONLY,
    // A guild only. The reply names the channel the relay will post into, and a
    // DM has no guild for that to mean anything in.
    dm_permission: false,
    // THE WORDS COME FROM A MODAL, same as /bug and /feedback and for the same
    // reason: a slash-command option is one line that truncates at the width of
    // the input, and an announcement is a paragraph.
    //
    // These four cannot move into the modal -- a modal's only component is a
    // text input, so a choice and three toggles have nowhere to live in one.
    // They are carried across in the custom_id; there is no file here, so
    // unlike /bug nothing has to be stashed in memory to survive the round trip.
    options: [
      {
        type: 3, // STRING
        name: 'type',
        description: 'How it is badged on the website (defaults to info)',
        required: false,
        choices: [
          { name: 'Info', value: 'info' },
          { name: 'Warning', value: 'warning' },
          { name: 'Urgent', value: 'urgent' },
          { name: 'Event', value: 'event' },
        ],
      },
      {
        type: 5, // BOOLEAN
        name: 'pin',
        description: 'Keep it at the top of the announcements page',
        required: false,
      },
      {
        type: 5,
        name: 'draft',
        description: 'Save it without publishing, to finish in the console',
        required: false,
      },
      {
        type: 5,
        name: 'evergreen',
        description: 'A standing notice (club rules, door code) that outlives this term',
        required: false,
      },
    ],
  },
  {
    // EXEC_ONLY, and read /announce's note above first — this is the same
    // reasoning with none of the safety rails. /announce writes a row the
    // console can edit, unpublish or delete, badged as an announcement, and the
    // relay says where it came from. This posts arbitrary words in the club's
    // own voice, indistinguishable from anything else the bot says, and Discord
    // has no undo. Two things make that acceptable rather than reckless:
    //
    //   Discord's own permissions still apply. The bot cannot post where it
    //   cannot post, and cannot mention @everyone unless the club has given it
    //   that permission in that channel.
    //
    //   Every use writes an audit entry QUOTING THE MESSAGE, so a message that
    //   is later deleted is still readable in the audit channel. A bot that can
    //   speak for the club with no record of who moved its mouth is the thing
    //   worth not building.
    //
    // Unlike every other EXEC_ONLY command there is no app-side capability
    // check, because there is no app call: nothing here reads or writes club
    // data. The gate is Discord's, which is the same gate that decides who can
    // type in the channel by hand.
    name: 'say',
    description: 'Post a message as the club bot',
    default_member_permissions: EXEC_ONLY,
    // A guild only. There is no channel to default to in a DM, and speaking as
    // the club in a DM is not a thing the club does.
    dm_permission: false,
    // THE WORDS COME FROM A MODAL, for /announce's reason and one more: a slash
    // option cannot carry a line break, and the whole point of this command is
    // posting something that reads like a person wrote it.
    options: [
      {
        type: 7, // CHANNEL
        name: 'channel',
        description: 'Where to post it (defaults to this channel)',
        required: false,
        // Text (0) and announcement (5), same as /config. The picker would
        // otherwise offer a category and the post would 400.
        channel_types: [0, 5],
      },
      {
        type: 5, // BOOLEAN
        name: 'ping',
        description: 'Let @mentions in the message actually notify people (default: no)',
        required: false,
      },
    ],
  },
  {
    name: 'link',
    description: 'Connect your Discord account to your club account',
    options: [],
  },
  {
    name: 'unlink',
    description: 'Disconnect your Discord account and remove your club roles',
    options: [],
  },
  {
    // The Discord-side door to the console's force-link panel. The member it is
    // for is the one who cannot walk /link: no browser session they can get to,
    // an account they have lost, or a signup still pending approval.
    //
    // EXEC_ONLY IS GATE 1 ONLY, and on the doctrine at the top of this file that
    // makes it TIDINESS RATHER THAN SECURITY: it keeps the command out of every
    // member's picker and it is not authorization. Discord will execute it for
    // anyone a server admin grants it to, and the bot in a second guild carries
    // no such filter at all. THE REAL BOUNDARY IS THE ROUTE'S CAPABILITY CHECK,
    // which resolves the caller's own club account and asks it for
    // `players.discordlink.write`: the same capability the console's panel
    // requires, through the same resolver.
    name: 'forcelink',
    description: 'Connect a Discord account to a club member who cannot run /link',
    default_member_permissions: EXEC_ONLY,
    // A guild only, and LOAD-BEARING rather than copied: EXEC_ONLY is a
    // guild-only filter with no meaning in a DM, so without this any member
    // could DM the bot and gate 1 would be decorative.
    dm_permission: false,
    options: [
      {
        type: 6, // USER
        name: 'account',
        description: 'The Discord account to connect',
        required: true,
      },
      {
        // A STRING, NOT A SECOND USER OPTION, and the club member cannot be one:
        // a USER option is populated from the server's own member list, and the
        // member being linked is by definition somebody the club's records and
        // Discord do not yet agree about. A handle is the only key the bot holds
        // for a club member who is not in that list.
        //
        // It also has to be a string to autocomplete at all: Discord accepts
        // autocomplete only on STRING, INTEGER and NUMBER, which is the same
        // limitation /profile's `member` option runs into (see :170-173).
        //
        // THE DESCRIPTION SAYS WHAT THE PICKER CANNOT OFFER, deliberately. The
        // suggestions come from the club ladder, and a pending or hidden member
        // has no ladder row, so the member this command exists for is exactly
        // the one that will never be suggested. An officer who does not know
        // that reads an empty picker as "no such member".
        type: 3, // STRING
        name: 'member',
        description: 'Club handle. The picker only suggests ladder members; type one in full.',
        required: true,
        autocomplete: true,
      },
      {
        // AN OPTION, NOT A MODAL, unlike /bug, /feedback, /announce and /say.
        // Those four collect a paragraph, and a slash option is one line that
        // truncates at the width of the input. This is one sentence saying why,
        // which fits.
        //
        // And a modal could not carry this command anyway: a modal's only
        // component is a text input, so the USER option above has nowhere to
        // live in one. Going that way would force the two-interaction split
        // /announce uses, with both Discord ids packed into a custom_id and read
        // back out, for no gain.
        type: 3, // STRING
        name: 'reason',
        description: 'Why this is being done by hand (goes in the club audit log)',
        required: true,
      },
    ],
  },
  {
    // The inverse of /forcelink, and THE ONLY OFFICER-FACING UNLINK THERE IS.
    // The console's Discord panel links and does not unlink, so until this
    // existed the only way to detach somebody else's account was to force-link
    // it onto a different member.
    //
    // EXEC_ONLY IS GATE 1 ONLY, exactly as it is on /forcelink: it keeps the
    // command out of every member's picker and it is not authorization. THE
    // REAL BOUNDARY IS THE ROUTE'S CAPABILITY CHECK, which resolves the
    // caller's own club account and asks it for `players.discordlink.write`,
    // the same capability the linking half requires, through the same
    // resolver.
    //
    // AN OFFICER MAY TARGET THEMSELVES. The effect is /unlink plus an audit
    // row, which is harmless and not worth a special case.
    name: 'forceunlink',
    description: "Disconnect a member's Discord account and remove their club roles",
    default_member_permissions: EXEC_ONLY,
    // A guild only, and LOAD-BEARING rather than copied, on the argument
    // /forcelink's own line makes: EXEC_ONLY is a guild-only filter with no
    // meaning in a DM, so without this any member could DM the bot and gate 1
    // would be decorative.
    dm_permission: false,
    options: [
      {
        // A STRING WITH AUTOCOMPLETE, NOT A USER OPTION, and this is the whole
        // design decision of the command.
        //
        // A USER option is populated from the guild's own member list, so it
        // can never offer somebody who is not in the server. The member this
        // command exists for is very often exactly that: they LEFT Discord and
        // their link row survived them, which is the single most likely reason
        // an officer reaches for it. /forcelink's `member` option is a STRING
        // for the mirror image of this reason, where the club's records and
        // Discord do not yet agree about a person. Here they agree and one side
        // has walked away.
        //
        // THE CHOICE VALUE IS THE SNOWFLAKE, not a handle or a player id: the
        // route's delete keys on discord_user_id and syncMemberEverywhere takes
        // snowflakes, so the picker hands over exactly what both already want
        // and nothing downstream has to translate.
        //
        // A RAW ID MUST STILL BE ACCEPTED, and the description says so: Discord
        // refuses an autocomplete response over 25 choices, so in a club past
        // that size the picker cannot offer everybody.
        type: 3, // STRING
        name: 'member',
        description: 'The connected account. Pick from the list, or paste a raw Discord ID.',
        required: true,
        autocomplete: true,
      },
      {
        // An option rather than a modal, on /forcelink's reasoning: this is one
        // sentence saying why, which fits on a line, and a deferred interaction
        // cannot open a modal anyway.
        type: 3, // STRING
        name: 'reason',
        description: 'Why this is being done by hand (goes in the club audit log)',
        required: true,
      },
    ],
  },
  {
    // Re-apply the club's current view of ONE member's roles, now.
    //
    // NO "EVERYONE" MODE, DELIBERATELY. That path already exists and is
    // strictly better: POST /sync with {"trigger":"manual"} holds the
    // sweepInFlight guard, reloads the config, and files the entry audit.ts
    // titles "Role sync (manually triggered)". A slash command cannot reach
    // that guard from dispatch, and a few hundred members synced sequentially
    // per guild would outlive the interaction token.
    //
    // NO REASON OPTION, unlike /forceunlink, and that is not an oversight.
    // Nothing here is written to the club's records and the act is convergent:
    // it makes Discord agree with what the app already says. A reason is what
    // makes a by-hand EDIT acceptable, and there is no edit to justify. The
    // Discord audit entry still names who ran it and about whom.
    //
    // Same two gates as /forceunlink, same capability, same reasons.
    name: 'forceupdate',
    description: "Re-apply a member's club roles in Discord right now",
    default_member_permissions: EXEC_ONLY,
    dm_permission: false,
    options: [
      {
        // THE SAME OPTION NAME AND THE SAME SHAPE as /forceunlink's, on
        // purpose: both pickers are fed by the same route and the same handler,
        // and an officer who has learned one has learned the other. See that
        // option for why it is a STRING and why the value is a snowflake.
        type: 3, // STRING
        name: 'member',
        description: 'The connected account. Pick from the list, or paste a raw Discord ID.',
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'setup',
    description: 'Create and wire up the club roles in this server',
    options: [
      {
        type: 7, // CHANNEL
        name: 'audit_channel',
        description: 'Where I should log every role change I make (optional)',
        required: false,
        // Text channels only (0) and announcement channels (5). A voice or
        // category channel would be accepted by Discord's picker and then fail
        // on the first message the bot tried to post.
        channel_types: [0, 5],
      },
    ],
    // MANAGE_GUILD (1 << 5). Discord enforces this server-side, so the command
    // is not even visible to anyone else.
    //
    // This gate is the security boundary of the whole feature, and it is worth
    // being explicit about why it sits HERE. Whoever runs /setup decides which
    // Discord role the bot hands to everyone the app says is an exec. Pointing
    // `executives` at a powerful role would grant it to every exec at once.
    // Requiring Manage Server means the people who can run it are exactly the
    // people who could already edit those roles by hand, so it adds no power
    // anyone did not have -- and Discord independently refuses to let a bot
    // create or assign anything above its own position, which caps the blast
    // radius even if this gate were somehow bypassed.
    // Stays MANAGE_GUILD rather than EXEC_ONLY: this one really is server
    // administration, it runs once, and it is what CREATES the @Executives role
    // that EXEC_ONLY commands are later granted to. Gating the bootstrap on the
    // thing it bootstraps would leave a fresh server with no way in.
    default_member_permissions: MANAGE_GUILD,
    // Meaningless in a DM: there is no guild to configure.
    dm_permission: false,
  },
  {
    name: 'config',
    description: 'See and change where the club relays post',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'show',
        description: 'What is configured, and what each relay is doing about it',
        options: [],
      },
      {
        type: 1,
        name: 'channels',
        description: 'Choose where each relay posts',
        // BUILT FROM THE SPEC LIST rather than typed out, so a setting cannot
        // exist in /config show and be missing from the thing that sets it.
        options: CHANNEL_SETTINGS.map((spec) => ({
          type: 7, // CHANNEL
          name: spec.option,
          description: spec.label,
          required: false,
          // Text (0) and announcement (5) channels only. The picker would
          // happily offer a voice channel or a category, and the failure would
          // arrive later as a relay that 400s every five minutes.
          channel_types: [0, 5],
        })),
      },
      {
        type: 1,
        name: 'ping_roles',
        description: 'Choose which role each session ping mentions',
        options: [
          {
            type: 8, // ROLE
            name: 'every_session',
            description: 'One role for every session (sets all three below)',
            required: false,
          },
          ...ROLE_SETTINGS.map((spec) => ({
            type: 8, // ROLE
            name: spec.option,
            description: spec.label,
            required: false,
          })),
        ],
      },
      {
        type: 1,
        name: 'tournament',
        description: 'Times and location for the Discord events I create for tournaments',
        options: [
          { type: 3, name: 'start_time', description: 'Start time, 24-hour HH:MM (default 09:00)', required: false },
          { type: 3, name: 'end_time', description: 'End time, 24-hour HH:MM (default 18:00)', required: false },
          { type: 3, name: 'location', description: 'Where tournaments are held', required: false },
          {
            type: 4, // INTEGER
            name: 'ping_lead_minutes',
            description: 'How long before a session to ping (default 60)',
            required: false,
            min_value: 5,
            max_value: 1440,
          },
        ],
      },
      {
        type: 1,
        name: 'clear',
        description: 'Unset one of these — the relay that reads it goes quiet',
        options: [
          {
            type: 3,
            name: 'setting',
            description: 'Which one to unset',
            required: true,
            choices: ALL_SETTINGS.map((spec) => ({ name: spec.label, value: spec.option })),
          },
        ],
      },
    ],
    // MANAGE_GUILD, the same gate /setup carries and for the same reason: this
    // decides which channels the bot broadcasts the club's business into, which
    // is server administration rather than exec tooling.
    default_member_permissions: MANAGE_GUILD,
    dm_permission: false,
  },
  {
    name: 'rolepicker',
    description: 'Manage the self-serve ping roles members can pick',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'add',
        description: 'Offer a role for members to give themselves',
        options: [
          { type: 8, name: 'role', description: 'The role to offer', required: true },
          {
            type: 3,
            name: 'label',
            description: 'What the button should say',
            required: true,
          },
          {
            type: 3,
            name: 'emoji',
            description: 'An emoji for the button (optional)',
            required: false,
          },
          {
            type: 4,
            name: 'order',
            description: 'Sort position, lowest first (optional)',
            required: false,
          },
        ],
      },
      {
        type: 1,
        name: 'remove',
        description: 'Stop offering a role. Members who have it keep it.',
        options: [
          { type: 8, name: 'role', description: 'The role to stop offering', required: true },
        ],
      },
      {
        type: 1,
        name: 'post',
        description: 'Post the picker message in this channel',
        options: [],
      },
      {
        type: 1,
        name: 'list',
        description: 'Show which roles are currently on offer',
        options: [],
      },
    ],
    // MANAGE_GUILD, same gate and same reasoning as /setup: whoever runs this
    // decides which roles the bot will hand out on request. Requiring Manage
    // Server means they could already edit those roles by hand, so it grants no
    // power anyone lacked -- and Discord still refuses to let the bot assign
    // anything above its own position, which caps it regardless.
    //
    // EXEC_ONLY rather than MANAGE_GUILD -- which LOOSENS who can run it and
    // TIGHTENS who sees it by default, at the same time.
    //
    // Posting a ping picker is session-running work, and the execs who run
    // sessions are usually not the one or two people holding Manage Server, so
    // gating on that bit puts a routine job behind the person least likely to
    // be around. '0' means an admin grants @Executives once, in Integrations,
    // and the right people have it from then on -- while it stays out of every
    // ordinary member's command list.
    //
    // Safe to widen because of what the command can actually do: it only
    // nominates roles for a picker, 00168 refuses any role the nightly sweep
    // controls, and Discord independently refuses to let the bot assign
    // anything above its own position. There is no path from here to a role
    // somebody could not already have been given by hand.
    //
    // A DISCORD gate, not an app-permission one, and deliberately so: what is
    // configured here is Discord role plumbing, not club data. The commands
    // that write to the club's records check the LINKED member's capability,
    // because that is where the authority actually lives.
    default_member_permissions: EXEC_ONLY,
    dm_permission: false,
  },
  {
    // One word, for /sessionpost's reason: Discord command names are
    // ^[-_\p{L}\p{N}]{1,32}$ and lowercase. A sibling rather than a subcommand
    // because there is nothing to be a sibling OF: this posts one fixed message
    // and has no add/remove/list to sit beside.
    name: 'guidepost',
    description: 'Post the help guide, with buttons, into this channel',
    options: [],
    // EXEC_ONLY, on /sessionpost's argument at the top of this file: it writes a
    // message into a shared channel under the club's name. Not MANAGE_GUILD,
    // because posting a help guide is session-running work rather than server
    // administration. No app-side capability check to pair it with because
    // nothing here reads or writes club data: the buttons carry no authority,
    // they only open the same flows /link, /bug and /feedback open for every
    // member already.
    default_member_permissions: EXEC_ONLY,
    // A guild only. The reply is a public channel message and a DM has no
    // channel for that to mean anything in.
    dm_permission: false,
  },
  {
    name: 'discord',
    description: 'Show the club Discord invite link and its QR code',
    // NO OPTIONS, on purpose and by instruction. The club has one invite, so
    // there is nothing to parameterise, and an option or a subcommand here
    // would only invite a second invite to exist.
    options: [],
    // EXEC_ONLY, on /guidepost's argument: this is the link an exec pastes into
    // a slide or a poster, and handing every member a one-keystroke way to
    // spray it is how an invite ends up somewhere the club did not put it. No
    // app-side capability check to pair it with, like /say and /guidepost,
    // because nothing here reads or writes club data.
    default_member_permissions: EXEC_ONLY,
    // LOAD-BEARING, not copied boilerplate. default_member_permissions is a
    // GUILD-ONLY filter and has no meaning in a DM, so without this line any
    // member could DM the bot and the exec gate above would be decorative.
    dm_permission: false,
  },
  {
    name: 'socials',
    description: "The club's links: Discord, Instagram and the website",
    options: [],
    // UNGATED, like /sessions: a read anybody may do, answered only to them.
    // This does print the invite /discord keeps exec-only, but as a link a
    // member can already copy from the website's footer, not as a QR code for
    // a poster.
  },
  {
    name: 'challenge',
    description: 'Send a challenge or report a result',
    // UNGATED, and that is safe for the reason /announce's gate is not needed:
    // the app acts as the member who typed it, resolved from their own linked
    // Discord account, and runs the same standing, feature and waiver checks
    // the website does. There is nothing here a member could not already do on
    // the web as themselves.
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'send',
        description: 'Challenge a member to a match',
        // Required first: Discord refuses a definition with an optional option
        // ahead of a required one.
        options: [
          { type: 6, name: 'opponent', description: 'Who you are challenging', required: true },
          {
            type: 3, // STRING
            name: 'type',
            description: 'Singles or doubles (defaults to singles)',
            required: false,
            choices: [
              { name: 'Singles', value: 'singles' },
              { name: 'Doubles', value: 'doubles' },
            ],
          },
          {
            type: 5, // BOOLEAN
            name: 'rated',
            // The web form starts with Rated ticked, so leaving this out is rated.
            description: 'Counts toward ratings (defaults to yes)',
            required: false,
          },
          {
            type: 4, // INTEGER
            name: 'best_of',
            description: 'Games in the match (defaults to 3)',
            required: false,
            // Odd only, like the web: an even best-of can end level.
            choices: [
              { name: '1 game', value: 1 },
              { name: 'Best of 3', value: 3 },
              { name: 'Best of 5', value: 5 },
              { name: 'Best of 7', value: 7 },
            ],
          },
          {
            type: 4,
            name: 'points',
            description: 'Points to win a game (defaults to 21)',
            required: false,
            min_value: 5,
            max_value: 30,
          },
          { type: 6, name: 'partner', description: 'Your partner, for doubles', required: false },
          {
            type: 6,
            name: 'opponent_partner',
            description: "Your opponent's partner, for doubles",
            required: false,
          },
          {
            type: 3,
            name: 'note',
            description: 'A note for your opponent',
            required: false,
            // challengeCreateSchema's own limit.
            max_length: 500,
          },
        ],
      },
      {
        type: 1,
        name: 'report',
        description: 'Report the result of an accepted challenge',
        options: [
          {
            type: 3,
            name: 'challenge',
            description: 'Which challenge',
            required: true,
            autocomplete: true,
          },
          {
            type: 3,
            name: 'score',
            description: 'Your points first in each game, e.g. 21-15 18-21 21-19',
            required: true,
            max_length: 100,
          },
          {
            type: 4,
            name: 'duration',
            description: 'How long the match took, in minutes',
            required: true,
            min_value: 1,
            max_value: 300,
          },
        ],
      },
    ],
  },
  {
    name: 'signup',
    description: 'Join the club without leaving Discord',
    options: [],
    // UNGATED: it is for people who are not members yet. The app refuses an
    // account that is already linked, and nothing is created until the email
    // code comes back. NOT deferred: its first answer is a modal, which a
    // deferred interaction cannot open.
  },
  {
    name: 'receipt',
    description: 'Send the receipt for a club fee you have paid',
    // UNGATED, on /challenge's reasoning: the app acts as the member who typed
    // it, resolved from their own linked Discord account, and runs the checks
    // the Membership page runs. An unlinked caller is told to link first.
    //
    // ONE SLASH COMMAND, NOT A MODAL. Storing the screenshot takes the app
    // longer than Discord's three seconds, so this is deferred, and a deferred
    // interaction cannot open a modal. Every value fits an option: the fee is a
    // picker of the caller's own unpaid fees, the reference is one short line.
    options: [
      {
        type: 3, // STRING
        name: 'fee',
        description: 'Which fee you paid',
        required: true,
        autocomplete: true,
      },
      {
        type: 11, // ATTACHMENT
        name: 'screenshot',
        description: 'A screenshot of the e-Transfer or SFU Rec receipt (JPEG, PNG or WebP, up to 8 MB)',
        required: true,
      },
      {
        type: 3,
        name: 'reference',
        description: 'The reference or receipt number on it',
        required: true,
        // The website's own bounds (feeSubmissionSchema).
        min_length: 4,
        max_length: 32,
      },
    ],
  },
  {
    // The caller's own next two weeks: sessions on their track, published club
    // events and tournaments, plus their calendar feed link. No permission flag:
    // every linked member may ask. Deferred and therefore ephemeral, because the
    // feed link is a personal credential.
    name: 'schedule',
    description: 'Your club schedule for the next two weeks',
    options: [],
  },
  {
    // CONSOLE COMMANDS ON DISCORD. Runs the console's own session actions as the
    // linked exec, through the console's /api/discord routes.
    //
    // EXEC_ONLY IS GATE 1 ONLY, on the doctrine at the top of this file. The
    // real boundary is the capability each console action asks for, resolved
    // for the caller's own club account by the same gate the console uses.
    //
    // NOT IN DEFERRED_COMMANDS, and it cannot be: archive and delete open a
    // modal, and a deferred interaction can no longer open one. The handler
    // acknowledges for itself instead (type 5, ephemeral) on every other
    // subcommand, the way /profile does.
    name: 'session',
    description: 'Create, edit and manage club sessions (console)',
    default_member_permissions: EXEC_ONLY,
    dm_permission: false,
    options: [
      {
        type: 1,
        name: 'create',
        description: 'Create a session, or a weekly series',
        options: [
          { type: 3, name: 'date', description: 'Date, YYYY-MM-DD', required: true, min_length: 10, max_length: 10 },
          { type: 3, name: 'start', description: 'Start time, 24-hour HH:MM', required: true, max_length: 5 },
          { type: 3, name: 'end', description: 'End time, 24-hour HH:MM', required: true, max_length: 5 },
          { type: 3, name: 'location', description: 'Where', required: true, autocomplete: true, max_length: 200 },
          {
            type: 3,
            name: 'track',
            description: 'Who it is for',
            required: true,
            choices: [
              { name: 'Everyone', value: 'all' },
              { name: 'Competitive', value: 'competitive' },
              { name: 'Recreational', value: 'recreational' },
            ],
          },
          { type: 3, name: 'name', description: 'Name (defaults to Practice Session)', required: false, max_length: 100 },
          { type: 3, name: 'notes', description: 'Notes members see', required: false, max_length: 500 },
          {
            type: 3,
            name: 'repeat_weekly_until',
            description: 'Repeat every week up to this date, YYYY-MM-DD',
            required: false,
            min_length: 10,
            max_length: 10,
          },
        ],
      },
      {
        type: 1,
        name: 'edit',
        description: 'Change a session. Only the options you fill in change.',
        options: [
          { type: 3, name: 'session', description: 'The session', required: true, autocomplete: true },
          // REQUIRED, unlike the fields: the console refuses a session edit
          // with no reason, and required options must come first.
          { type: 3, name: 'reason', description: 'Why (goes in the club audit log)', required: true, min_length: 5, max_length: 500 },
          { type: 3, name: 'date', description: 'New date, YYYY-MM-DD', required: false, min_length: 10, max_length: 10 },
          { type: 3, name: 'start', description: 'New start time, 24-hour HH:MM', required: false, max_length: 5 },
          { type: 3, name: 'end', description: 'New end time, 24-hour HH:MM', required: false, max_length: 5 },
          { type: 3, name: 'location', description: 'New location', required: false, autocomplete: true, max_length: 200 },
          {
            type: 3,
            name: 'track',
            description: 'Who it is for',
            required: false,
            choices: [
              { name: 'Everyone', value: 'all' },
              { name: 'Competitive', value: 'competitive' },
              { name: 'Recreational', value: 'recreational' },
            ],
          },
          { type: 3, name: 'name', description: 'New name', required: false, max_length: 100 },
          { type: 3, name: 'notes', description: 'New notes', required: false, max_length: 500 },
        ],
      },
      {
        type: 1,
        name: 'archive',
        description: 'Close a session (asks for a reason)',
        options: [{ type: 3, name: 'session', description: 'The session', required: true, autocomplete: true }],
      },
      {
        type: 1,
        name: 'delete',
        description: 'Delete a session and its RSVPs and attendance (asks for a reason)',
        options: [{ type: 3, name: 'session', description: 'The session', required: true, autocomplete: true }],
      },
      { type: 1, name: 'list', description: 'Upcoming open sessions', options: [] },
      {
        type: 1,
        name: 'attendance',
        description: 'Who is going and who has checked in',
        options: [{ type: 3, name: 'session', description: 'The session', required: true, autocomplete: true }],
      },
      {
        type: 1,
        name: 'checkin',
        description: 'The check-in link for a session (only you see it)',
        options: [
          { type: 3, name: 'session', description: 'The session', required: true, autocomplete: true },
          { type: 5, name: 'rotate', description: 'Issue a new link and retire the old one', required: false },
        ],
      },
    ],
  },
  {
    // CONSOLE COMMANDS ON DISCORD for club events (not tournaments). Same two
    // gates and the same acknowledgement as /session: cancel and delete open a
    // modal, so this is not in DEFERRED_COMMANDS either.
    name: 'event',
    description: 'Create and manage club events (console)',
    default_member_permissions: EXEC_ONLY,
    dm_permission: false,
    options: [
      {
        type: 1,
        name: 'create',
        description: 'Create a club event (a draft unless you publish it)',
        options: [
          { type: 3, name: 'title', description: 'Title', required: true, max_length: 120 },
          {
            type: 3,
            name: 'kind',
            description: 'What sort of event',
            required: true,
            choices: CLUB_EVENT_KIND_CHOICES,
          },
          { type: 3, name: 'starts', description: 'Start, YYYY-MM-DD HH:MM (24-hour, club time)', required: true, min_length: 16, max_length: 16 },
          { type: 3, name: 'ends', description: 'End, YYYY-MM-DD HH:MM', required: false, min_length: 16, max_length: 16 },
          { type: 3, name: 'location', description: 'Where', required: false, max_length: 200 },
          { type: 4, name: 'capacity', description: 'How many places (no limit if left out)', required: false, min_value: 1 },
          { type: 10, name: 'cost', description: 'Cost in dollars, for display only', required: false, min_value: 0, max_value: 1000 },
          { type: 5, name: 'publish', description: 'Publish it now (default: save as a draft)', required: false },
          { type: 3, name: 'description', description: 'Description members see', required: false, max_length: 1000 },
        ],
      },
      {
        type: 1,
        name: 'publish',
        description: 'Publish a draft event',
        options: [{ type: 3, name: 'event', description: 'The event', required: true, autocomplete: true }],
      },
      {
        type: 1,
        name: 'cancel',
        description: 'Cancel an event and tell the people signed up (asks for a reason)',
        options: [{ type: 3, name: 'event', description: 'The event', required: true, autocomplete: true }],
      },
      {
        type: 1,
        name: 'delete',
        description: 'Delete an event nobody has signed up for (asks you to confirm)',
        options: [{ type: 3, name: 'event', description: 'The event', required: true, autocomplete: true }],
      },
      { type: 1, name: 'list', description: 'Upcoming drafts and published events', options: [] },
      {
        type: 1,
        name: 'signups',
        description: 'Who has signed up',
        options: [{ type: 3, name: 'event', description: 'The event', required: true, autocomplete: true }],
      },
    ],
  },
  {
    // CONSOLE COMMANDS ON DISCORD for running a tournament on the day. Same two
    // gates and the same acknowledgement as /session: suspend opens a modal, so
    // this is not in DEFERRED_COMMANDS either.
    name: 'tourney',
    description: 'Run a tournament on the day (console)',
    default_member_permissions: EXEC_ONLY,
    dm_permission: false,
    options: [
      {
        type: 1,
        name: 'checkin',
        description: 'Check an entry in',
        options: [TOURNEY_TOURNAMENT_OPTION, TOURNEY_ENTRY_OPTION],
      },
      {
        type: 1,
        name: 'noshow',
        description: 'Mark an entry as a no-show',
        options: [TOURNEY_TOURNAMENT_OPTION, TOURNEY_ENTRY_OPTION],
      },
      {
        type: 1,
        name: 'undo-checkin',
        description: 'Undo a check-in',
        options: [TOURNEY_TOURNAMENT_OPTION, TOURNEY_ENTRY_OPTION],
      },
      {
        type: 1,
        name: 'result',
        description: 'Enter a match result',
        options: [
          TOURNEY_TOURNAMENT_OPTION,
          TOURNEY_MATCH_OPTION,
          {
            type: 3,
            name: 'scores',
            description: 'Each game like 21-15, side A first, as shown in the picker',
            required: true,
            max_length: 60,
          },
        ],
      },
      {
        type: 1,
        name: 'walkover',
        description: 'Award a match as a walkover',
        options: [
          TOURNEY_TOURNAMENT_OPTION,
          TOURNEY_MATCH_OPTION,
          {
            type: 3,
            name: 'winner',
            description: 'Which side wins, as shown in the picker',
            required: true,
            choices: [
              { name: 'Side A', value: 'a' },
              { name: 'Side B', value: 'b' },
            ],
          },
          { type: 3, name: 'reason', description: 'Why (goes in the club audit log)', required: true, min_length: 5, max_length: 500 },
        ],
      },
      {
        type: 1,
        name: 'court',
        description: 'Put a match on a court',
        options: [
          TOURNEY_TOURNAMENT_OPTION,
          TOURNEY_MATCH_OPTION,
          { type: 3, name: 'court', description: 'The court, like 3', required: true, max_length: 40 },
        ],
      },
      {
        type: 1,
        name: 'live',
        description: 'Start or stop a match',
        options: [
          TOURNEY_TOURNAMENT_OPTION,
          TOURNEY_MATCH_OPTION,
          {
            type: 3,
            name: 'state',
            description: 'Start or stop',
            required: true,
            choices: [
              { name: 'Start', value: 'start' },
              { name: 'Stop', value: 'stop' },
            ],
          },
        ],
      },
      {
        type: 1,
        name: 'status',
        description: "Change a tournament's status",
        options: [
          TOURNEY_TOURNAMENT_OPTION,
          {
            type: 3,
            name: 'status',
            description: 'The new status',
            required: true,
            choices: [
              { name: 'Draft', value: 'draft' },
              { name: 'Active', value: 'active' },
              { name: 'Completed', value: 'completed' },
              { name: 'Archived', value: 'archived' },
            ],
          },
        ],
      },
      {
        type: 1,
        name: 'suspend',
        description: 'Suspend play (asks for a reason members see)',
        options: [TOURNEY_TOURNAMENT_OPTION],
      },
      { type: 1, name: 'resume', description: 'Resume a suspended tournament', options: [TOURNEY_TOURNAMENT_OPTION] },
      {
        type: 1,
        name: 'fee',
        description: "Mark a player's tournament fee paid or unpaid",
        options: [
          TOURNEY_TOURNAMENT_OPTION,
          { type: 3, name: 'player', description: 'The player', required: true, autocomplete: true },
          {
            type: 3,
            name: 'state',
            description: 'Paid or unpaid',
            required: true,
            choices: [
              { name: 'Paid', value: 'paid' },
              { name: 'Unpaid', value: 'unpaid' },
            ],
          },
          {
            type: 3,
            name: 'method',
            description: 'How they paid',
            required: false,
            // PAYMENT_METHODS in packages/shared/src/utils/payment-methods.ts,
            // without Custom (a free-text method is the console's).
            choices: [
              { name: 'E-transfer', value: 'e_transfer' },
              { name: 'Cash', value: 'cash' },
              { name: 'Online portal', value: 'online_portal' },
              { name: 'SFU Rec website', value: 'sfu_rec' },
            ],
          },
        ],
      },
      {
        type: 1,
        name: 'checkin-link',
        description: 'The self check-in link (only you see it)',
        options: [
          TOURNEY_TOURNAMENT_OPTION,
          {
            type: 3,
            name: 'action',
            description: 'Get the current link, or issue a new one',
            required: true,
            choices: [
              { name: 'Get', value: 'get' },
              { name: 'Rotate', value: 'rotate' },
            ],
          },
        ],
      },
    ],
  },
  {
    // A Discord moderation action, so a Discord permission is the gate, on
    // /setup's argument for MANAGE_GUILD: whoever holds Ban Members could do
    // this by hand. moderation.ts re-checks the caller's permissions and rank,
    // because a server admin can open any command to any role.
    name: 'softban',
    description: 'Remove someone from the server and delete their recent messages; they can rejoin',
    default_member_permissions: BAN_MEMBERS,
    dm_permission: false,
    options: [
      { type: 6, name: 'member', description: 'Who to soft-ban', required: true },
      {
        type: 3,
        name: 'delete',
        description: 'How far back to delete their messages (default: last day)',
        required: false,
        choices: SOFTBAN_WINDOWS.map((w) => ({ name: w.name, value: w.value })),
      },
      {
        type: 3,
        name: 'reason',
        description: 'Why, for the logs',
        required: false,
        max_length: 300,
      },
    ],
  },
  {
    // THIS SERVER'S OWN SETTINGS (00302), in any server the bot is in, as
    // opposed to /config, which is the club's. MANAGE_GUILD: whoever holds it
    // runs the server already. In one of the club's servers the log carries
    // deleted messages' text, so there a club exec account is needed as well,
    // checked in handleServer and again by the app.
    name: 'server',
    description: "This server's own bot settings: its log channel and the scam guard",
    default_member_permissions: MANAGE_GUILD,
    dm_permission: false,
    options: [
      { type: 1, name: 'show', description: 'What this server has set', options: [] },
      {
        type: 1,
        name: 'log',
        description: "Post this server's log (bans, joins, deleted messages) in a channel",
        options: [
          { type: 7, name: 'channel', description: 'Where the log posts', required: true, channel_types: [0, 5] },
        ],
      },
      { type: 1, name: 'log_off', description: "Stop posting this server's log", options: [] },
      {
        type: 1,
        name: 'scam_guard',
        description: 'Soft-ban accounts that spray the same post across channels',
        options: [{ type: 5, name: 'enabled', description: 'On or off', required: true }],
      },
    ],
  },
];

/**
 * Commands answered with a deferred reply instead of an immediate one.
 *
 * Discord gives an interaction 3 seconds to be acknowledged. /setup can create
 * nine roles and then write to the app, which is comfortably longer, so it
 * acknowledges first and edits the message when it is actually finished.
 *
 * /discord MUST NEVER BE ADDED TO THIS SET. It makes no network call of any
 * kind, so there is nothing to defer for, and deferring buys a second HTTP
 * round trip to Discord to say the same thing a few hundred milliseconds later.
 *
 * /forcelink IS HERE ON PURPOSE, and the two warnings elsewhere in this file
 * about NOT deferring do not apply to it. Those are about what deferring costs:
 * a deferred interaction can no longer open a MODAL (so /link, /bug, /feedback,
 * /announce and /say cannot be here), and a deferred acknowledgement fixes the
 * reply as ephemeral (so /guidepost cannot, because its reply is the public
 * guide). /forcelink opens no modal, takes its reason as a plain string option,
 * and answers ephemerally anyway. What it does do is call an app route that
 * makes about six round trips and then strip roles in every guild, which does
 * not fit in three seconds with any margin.
 *
 * /forceunlink AND /forceupdate ARE HERE FOR THE SAME REASON AND PASS THE SAME
 * TEST. Neither opens a modal, both answer ephemerally, and both call an app
 * route and then talk to Discord about every guild, which is comfortably past
 * three seconds.
 *
 * DEFERRAL COVERS THE COMMAND ONLY, AND HAS NOTHING TO DO WITH AUTOCOMPLETE.
 * The picker on those two commands is a SEPARATE interaction type with its own
 * three-second budget, and it cannot be deferred at all: type 8 or nothing.
 * Adding a command here buys its picker no time whatsoever, which is why the
 * picker's client timeout is two seconds while the commands' are five and ten.
 */
export const DEFERRED_COMMANDS = new Set([
  'setup',
  // Five or six Discord calls, plus up to three unban retries.
  'softban',
  'config',
  'forcelink',
  'forceunlink',
  'forceupdate',
  // Opens no modal and answers ephemerally. Sending a challenge also sends an
  // email and a push, and either can take the app past three seconds.
  'challenge',
  // Opens no modal and answers ephemerally. The app downloads and stores the
  // screenshot before it answers.
  'receipt',
  // Opens no modal, and the reply carries the member's own calendar feed link,
  // so ephemeral is what it must be anyway.
  'schedule',
  // Opens no modal and every answer is ephemeral. `enter` writes an entry and
  // `draw` reads a whole event, and either can take the app past three seconds.
  'tournaments',
]);

/**
 * Which commands' pickers are fed by the LINKED ACCOUNT list rather than the
 * club ladder.
 *
 * A SET HERE RATHER THAN A CONDITION IN index.ts, on DEFERRED_COMMANDS' own
 * pattern: index.ts routes the autocomplete interaction and commands.ts owns
 * the answer to "which provider does this command want", so the two cannot
 * drift, and the routing decision is assertable without standing a server up.
 *
 * /profile and /forcelink are deliberately ABSENT. Their pickers read the club
 * ladder through handleProfileAutocomplete, which is the privacy-equivalent
 * source /profile's own route is built on, and moving either onto this list
 * would start suggesting members the ladder hides to anybody who can run the
 * command.
 */
export const LINKED_ACCOUNT_PICKERS = new Set(['forceunlink', 'forceupdate']);

/**
 * Which commands' pickers list the CALLER'S OWN open challenges. On
 * LINKED_ACCOUNT_PICKERS' pattern, so index.ts routes on a set this file owns.
 */
export const OPEN_CHALLENGE_PICKERS = new Set(['challenge']);

/**
 * Which commands' pickers list the CALLER'S OWN unpaid fees. Same pattern.
 */
export const OWN_FEE_PICKERS = new Set(['receipt']);

/**
 * The console commands' pickers: sessions and locations for /session, club
 * events for /event. Read from the console as the linked exec, behind the same
 * capability the console page asks for. Same pattern as the sets above.
 */
export const SESSION_PICKERS = new Set(['session']);
export const EVENT_PICKERS = new Set(['event']);

/**
 * /tournaments' pickers: active tournaments and their events, read from the
 * member app, the same for everybody. Same pattern as the sets above.
 */
export const MEMBER_TOURNAMENT_PICKERS = new Set(['tournaments']);

/**
 * /tourney's pickers: tournaments, entries, matches and fees, read from the
 * console as the linked exec. Same pattern as SESSION_PICKERS.
 */
export const TOURNEY_PICKERS = new Set(['tourney']);

/**
 * Who ran the command, and where.
 *
 * discordUserId comes from TWO different places depending on context: a guild
 * interaction populates `member.user`, a DM populates `user` and leaves
 * `member` undefined entirely. /link and /unlink are exactly the commands
 * people run in a DM, so reading only one of them breaks the flow for the
 * quietest half of the users.
 */
export interface InteractionContext {
  discordUserId: string | null;
  guildId: string | null;
  /**
   * Where the command was typed. Only /say reads it, and only as the default
   * for its optional `channel` option — "post it here" is the overwhelmingly
   * common case and making it the one thing you have to fill in every time is
   * how a quick command stops being quick.
   */
  channelId?: string | null;
  /**
   * The CALLER'S own permissions in this guild, as Discord computed them: a
   * 64-bit mask sent as a string, and theirs rather than the bot's.
   *
   * Populated for a MODAL_SUBMIT, because that is the interaction that actually
   * posts. Only handleSayModal reads it, and only as defence in depth: see the
   * note there for why '0' means no mask here can reproduce /say's real
   * audience.
   */
  permissions?: string | null;
  /** The caller's role ids in this guild. /softban compares ranks with them. */
  memberRoles?: string[] | null;
  /** Both only present for a deferred command; see DEFERRED_COMMANDS. */
  applicationId?: string | null;
  interactionToken?: string | null;
  /**
   * `interaction.data.resolved.attachments`, keyed by attachment id.
   *
   * An attachment option's VALUE is only an id; the file itself lives in this
   * side table. Reading the option alone gets a snowflake and no url, which
   * looks like the picker returning nothing.
   */
  attachments?: Record<string, ResolvedAttachment> | null;
}

export interface ResolvedAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  size?: number;
}

export interface CommandOption {
  name: string;
  // boolean because Discord sends a BOOLEAN option (type 5) as a real JSON
  // boolean, not the string "true" -- /announce's three toggles arrive that
  // way. Reading one through String() would make `false` the truthy "false".
  value?: string | number | boolean;
  /**
   * Subcommands nest. Discord sends `/rolepicker add role:@X` as a single
   * top-level option named "add" (type 1) whose own `options` carry the real
   * arguments — the arguments are NOT flattened onto the command. Reading
   * `option(options, 'role')` on the outer list therefore finds nothing and
   * looks like the user left a required field blank, which Discord would never
   * have allowed. subcommand() below unwraps one level.
   */
  options?: CommandOption[];
  type?: number;
  /**
   * AUTOCOMPLETE ONLY: which slot the cursor is in.
   *
   * Discord marks exactly one, and it is sent even when nothing has been typed
   * yet — that first empty-value call is how the picker opens.
   */
  focused?: boolean;
}

/** The chosen subcommand and its arguments, for a command that has any. */
function subcommand(options: CommandOption[] | undefined) {
  const chosen = options?.find((o) => o.type === 1);
  return { name: chosen?.name ?? null, options: chosen?.options };
}

function option(options: CommandOption[] | undefined, name: string) {
  return options?.find((o) => o.name === name)?.value;
}

function reply(embed: Record<string, unknown>) {
  return { type: 4, data: { embeds: [embed] } };
}

/**
 * An embed only the caller sees.
 *
 * Separate from reply() rather than a boolean argument to it, because the
 * decision is per-command and permanent: /leaderboard is public on purpose,
 * /sessions must not be. A flag at the call site is easy to drop in a refactor
 * and the resulting bug is invisible to the person who caused it — they see
 * their own message either way.
 */
function ephemeralEmbed(embed: Record<string, unknown>) {
  return { type: 4, data: { embeds: [embed], flags: 64 } };
}

// Ephemeral (flag 64) so failures and empty states don't clutter a shared
// channel. Only the person who ran the command sees them.
function ephemeral(content: string) {
  return { type: 4, data: { content, flags: 64 } };
}

function formatLeaderboardRow(e: {
  rank: number;
  name: string;
  handle: string | null;
  rating: number;
  provisional: boolean;
  wins: number;
  losses: number;
}) {
  // Podium gets a marker; everything else is a plain number so the column stays
  // readable in Discord's proportional font.
  const medal = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : `\`${e.rank}.\``;
  // The asterisk is not decoration: an unmarked provisional rating reads as
  // settled, and a leaderboard posted in a channel outlives the message.
  const rating = `${e.rating}${e.provisional ? '*' : ''}`;
  return `${medal} **${e.name}** — ${rating} (${e.wins}W ${e.losses}L)`;
}

/**
 * THE TWO NUMBERS ON A ROW ARE ON DIFFERENT CLOCKS, and nothing said so.
 *
 * activate_season REBASES Elo at a rollover -- compressed toward the mean, or
 * reset outright under the 'full' policy in 00068 -- but it resets no other
 * counter. So the W-L printed beside that Elo is cumulative across every season
 * the member has ever played, and a row reading "1847 (18W 6L)" stated one
 * since-rollover figure and one all-time figure side by side.
 *
 * The points ladder is all-time on BOTH sides: get_leaderboard() sums
 * tournament_participants.points with no season predicate and no join to
 * tournaments, so there is no rebase to mention and the caveat is a different
 * one.
 *
 * In the footer, not on each row: a row already carries a medal, a name, a
 * rating and a record, and Discord wraps it on a phone. The footer is also
 * where this embed already puts its other caveat, the provisional asterisk. The
 * same statement sits under the column key on the web ladder.
 */
function ladderTimeBase(ladder: string): string {
  return ladder === 'points'
    ? 'Tournament points are all-time, across every season.'
    : 'Elo is rebased each season. W-L is all-time.';
}

export async function handleLeaderboard(options: CommandOption[] | undefined) {
  const ladder = String(option(options, 'ladder') ?? 'doubles');
  const page = Number(option(options, 'page') ?? 1);

  const data = await fetchLeaderboard(ladder, page);

  if (data.entries.length === 0) {
    return ephemeral(
      data.page > data.totalPages
        ? `That page is empty — the ${LADDER_LABEL[data.ladder]} ladder has ${data.totalPages} page(s).`
        : 'No ranked players yet.'
    );
  }

  const anyProvisional = data.entries.some((e) => e.provisional);

  return reply({
    title: `${LADDER_LABEL[data.ladder] ?? data.ladder} ladder`,
    color: CLUB_RED,
    description: data.entries.map(formatLeaderboardRow).join('\n'),
    footer: {
      text:
        [
          `Page ${data.page} of ${data.totalPages}`,
          `${data.totalPlayers} ranked`,
          anyProvisional ? '* rating still provisional' : null,
        ]
          .filter(Boolean)
          .join(' · ') +
        // On its own line rather than joined with ' · ': it is a sentence, not
        // another count, and a leaderboard posted in a channel outlives the
        // message that asked for it.
        `\n${ladderTimeBase(data.ladder)}`,
    },
  });
}

// The card is fetched AFTER the acknowledgement, so this no longer has to fit
// inside Discord's three seconds -- the interaction token is good for fifteen
// minutes. It is still bounded, and the bound still matters: the member is
// looking at a "thinking..." spinner that Discord will happily spin for the
// full fifteen, so an unbounded read turns a slow render into a message that
// never arrives. Today's behaviour on a timeout, a link they can open, is worse
// than a card and far better than a permanent spinner.
//
// EIGHT SECONDS RATHER THAN THE 1800ms THIS REPLACES. That ceiling existed
// because the read had to finish inside the acknowledgement deadline, and it
// sat only ~750ms above the measured worst case (1046, 945, 611, 631ms from
// inside the staging bot container, every one a fresh render) -- close enough
// that an ordinary slow render dropped to the URL intermittently and looked
// like the feature was broken at random. Nothing forces it to be tight now, so
// it is set where only a genuinely stuck render reaches it.
const CARD_FETCH_MS = 8000;

/**
 * Why a requested `type:` cannot be honoured, or null when it can.
 *
 * THE ONLY PLACE THIS IS DECIDED. The route already falls back to the default
 * table for a ladder the member is not on, which is the truthful render but an
 * invisible one -- the bytes are identical to a card with no type at all, which
 * is how the option came to look broken. Drawing the explanation on the card
 * instead was tried and dropped: it can only be reached by hand-editing a card
 * URL, since this returns before one is ever built, and a second copy of the
 * rule in the renderer is a copy that drifts.
 *
 * An unrecognised `type` returns null, deliberately. The route ignores one and
 * draws the default table, so refusing here would be the bot inventing a miss
 * the app does not have.
 */
function unavailableLadder(profile: ProfilePayload, type: string): string | null {
  const who = profile.name;

  // Resolved BEFORE the not-ranked case, so that an unrecognised type takes the
  // same null exit whatever the member's state -- otherwise `type:garbage` on
  // an unranked member would be refused with a miss the route does not have.
  const side =
    type.endsWith('_doubles') ? profile.doubles
    : type.endsWith('_singles') ? profile.singles
    : undefined;
  if (side === undefined) return null;

  if (!profile.ranked) {
    return `${who} isn't on the club ladder yet — no ranked matches recorded.`;
  }

  const discipline = type.endsWith('_doubles') ? 'doubles' : 'singles';

  if (type.startsWith('comp_')) {
    // Three shapes mean the same thing to the member -- no competitive rank in
    // this discipline -- so they get the same sentence. `side` null is a member
    // who has not played it at all; compRank null is one who has, but not as a
    // competitive member.
    //
    // == null, NOT === null, and this is load-bearing rather than style. The
    // field arrives over the wire from the player app, and a player older than
    // the resolver that added it omits the key entirely -- so `undefined` is
    // the shape a bot that has rolled ahead of its player actually sees, which
    // is an ordinary state here and not a hypothetical. A strict check reads
    // that as "has a competitive rank" and hands back the byte-identical card
    // this whole function exists to stop.
    if (!side || side.compRank == null) {
      return `${who} does not have competitive stats in ${discipline}. Run \`/profile\` without a type to see their full card.`;
    }
    return null;
  }

  if (type.startsWith('open_') && !side) {
    return `${who} hasn't played any ranked ${discipline} yet. Run \`/profile\` without a type to see their full card.`;
  }

  return null;
}

/**
 * A member's profile card.
 *
 * PUBLIC, like /leaderboard and unlike /sessions. The card carries only what
 * the club ladder already publishes about the member, and the point of the
 * command is that somebody can post their card into a channel.
 *
 * THE CARD ITSELF IS A PNG THE APP RENDERS. The bot fetches its bytes and
 * uploads them, but it still does not draw the card and does not know the
 * numbers on it — the app decides both, which keeps the card's visibility rules
 * in the same place as every other rule this bot renders rather than splitting
 * them across two codebases.
 *
 * UPLOADED RATHER THAN LINKED. An embed's `image.url` makes Discord's CDN fetch
 * the card itself, from outside the cluster, and the signed URL it would be
 * fetching expires — so the picture goes missing from a message that stays in
 * the channel. Uploading the bytes hands Discord a file it owns and stores, and
 * it also removes the embed frame the card was never designed to sit inside.
 *
 * ANSWERED IN TWO PHASES, and the split is what makes deferring possible at
 * all. The command has to be deferred: rendering the card is a fresh PNG every
 * time, and a cold one blows Discord's three seconds and shows the member "the
 * application did not respond". But DEFERRED_COMMANDS defers ephemerally, and
 * an ephemeral card is the one property this command exists to not have, while
 * deferring publicly would publish the five refusals below — each of which is
 * ephemeral on purpose.
 *
 * Neither, then. The refusals are ALL decided by fetchProfile, one JSON call to
 * the app; the card fetch and its multipart upload are the slow part and decide
 * nothing. So the fast half runs BEFORE any acknowledgement and still answers
 * every refusal immediately and ephemerally, exactly as it did when the whole
 * command was immediate, and only the hit path acknowledges — publicly, because
 * by then the answer is known to be a card. Visibility is therefore still
 * chosen with the answer in hand, which is the whole reason it can be fixed at
 * acknowledgement time and never revisited.
 *
 * The five refusals are the app declining on purpose, and each one sends the
 * member somewhere different. Collapsing them into "something went wrong" would
 * leave someone who mistyped a handle waiting for an outage to end.
 */
export async function handleProfile(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const member = option(options, 'member');
  const handle = option(options, 'handle');
  // The value itself is NOT validated here -- the route that renders owns that,
  // and a check in two places is a check that drifts. What is checked here, in
  // the miss below, is something the route cannot answer: whether the member
  // has that ladder at all. Only the bot can say so in words.
  const type = option(options, 'type');

  const result = await fetchProfile(context.discordUserId, {
    discordUserId: member ? String(member) : null,
    handle: handle ? String(handle) : null,
  });

  if ('miss' in result) {
    switch (result.miss) {
      case 'not_linked':
        return ephemeral(
          "You haven't linked your Discord account to the club yet — run `/link` first, or look someone up with `/profile handle:their-handle`."
        );
      case 'target_unlinked':
        return ephemeral(
          "That Discord account isn't linked to a club member. If you know their club handle, try `/profile handle:their-handle`."
        );
      case 'no_such_handle':
        // Deliberately does NOT say whether the handle exists. A member who is
        // off the public ladder has no ladder row for a handle to find, and
        // "that member is hidden" would be exactly the disclosure their setting
        // exists to prevent -- so an unlisted member and a typo read the same.
        return ephemeral(
          "No member on the club ladder has that handle. Check the spelling — `/leaderboard` lists handles."
        );
      default:
        return ephemeral("Couldn't find that member.");
    }
  }

  // A LADDER THE MEMBER IS NOT ON. Asking for `type:` and getting the default
  // table back is indistinguishable from the option doing nothing -- the two
  // renders are byte-identical for a member with no competitive rank, which is
  // exactly how this was reported. So say it instead of drawing it.
  //
  // Text, and ephemeral, unlike every other reply this command sends: the card
  // is the artifact and this is not a card, it is an answer to the person who
  // asked. Posting "they have no competitive stats" publicly would also put a
  // member's absence from a ladder into a channel, which nobody asked for.
  const focusMiss = type ? unavailableLadder(result.profile, String(type)) : null;
  if (focusMiss) {
    return ephemeral(focusMiss);
  }

  // NO MESSAGE BODY. Everything this reply says is drawn on the card — the bio
  // and the provisional footnote used to be typed here beside the image, and
  // both moved into the render.
  //
  // The image is the artifact: it is what gets forwarded, quoted, embedded and
  // cached, and message text does not travel with any of that. A card that
  // needed a caption to be understood was only complete in the one channel it
  // was posted to.
  //
  // The asterisk on a provisional rating is the case that proves it. It is
  // drawn on the panel; the line explaining it is now on the rail beside the
  // club name, so the explanation cannot be separated from the mark.
  // The chosen ladder rides on the card URL rather than on the token, so it
  // stays a rendering choice and never touches what the token AUTHORISES. The
  // token already decides whose card this is and what may be said about them;
  // a query parameter that could widen that would be a hole. This one cannot --
  // the route matches it against a fixed list of four and ignores anything else.
  const cardUrl = type
    ? `${result.cardUrl}?type=${encodeURIComponent(String(type))}`
    : result.cardUrl;

  // THE ACKNOWLEDGEMENT, and the last decision this function makes. No flags:
  // the card is public, and a deferred reply's visibility is fixed here and
  // cannot be changed by the edit that follows. Every return above this line is
  // ephemeral and immediate; everything below runs after the socket has closed.
  return {
    type: 5,
    finish: async () => {
      // NEVER THROWS, by construction rather than by a try: fetchCard answers
      // null on any failure, and the only other work is building an object.
      // A rejection escaping here is answered publicly with a generic apology,
      // which is strictly worse than the link this returns instead.
      const card = await fetchCard(cardUrl, CARD_FETCH_MS);

      if (card) {
        return {
          type: 4,
          data: {
            // Both halves of the pair, and the filename taken from the file
            // rather than written out again. Discord accepts a declaration that
            // does not match the part with a 200 and renders the message with
            // no image at all — the same silent half-success
            // postMessageWithFile guards.
            attachments: [{ id: 0, filename: card.filename }],
          },
          file: card,
        };
      }

      // The bytes did not arrive. The URL still resolves for whoever opens it,
      // so the reply degrades to a link rather than to an apology — and the
      // link is enough on its own now, because the bio and the footnote are on
      // the card it points at rather than in a body this branch would rebuild.
      return {
        type: 4,
        data: { content: cardUrl },
      };
    },
  };
}

/**
 * The handle picker behind /profile.
 *
 * READS THE FOCUSED OPTION, not the one named 'handle'. Discord says which slot
 * the cursor is in, and it sends the option with an empty value the moment the
 * picker opens — matching by name would answer the wrong slot as soon as a
 * second autocompleting option is added, and would look like a picker that
 * suggests nothing.
 *
 * The value of a choice is the BARE HANDLE, because it lands straight in the
 * option handleProfile passes to fetchProfile. Anything decorative in there
 * becomes a lookup for a handle nobody has.
 */
export async function handleProfileAutocomplete(
  options: CommandOption[] | undefined
): Promise<BotResponse> {
  const focused = options?.find((o) => o.focused);
  const hits = matchHandles(await loadHandles(), String(focused?.value ?? ''));

  return {
    type: 8,
    data: {
      choices: hits.map((h) => ({
        // Discord refuses a choice name over 100 characters, and refusing it
        // takes the whole response down rather than that one row.
        name: `${h.name} (@${h.handle})`.slice(0, 100),
        value: h.handle,
      })),
    },
  };
}

function formatSession(s: SessionSummary) {
  // Discord's <t:unix:F> renders in each viewer's own timezone. Using it means
  // the bot never has to know the club timezone, and a member travelling sees
  // the right local time without the bot doing anything.
  const when = s.startsAt
    ? `<t:${Math.floor(new Date(s.startsAt).getTime() / 1000)}:F>`
    : `${s.date}${s.startTime ? ` ${s.startTime}` : ''}`;

  const parts = [when];
  if (s.location) parts.push(s.location);
  if (s.going !== null) parts.push(`${s.going} going`);

  return `**${s.name ?? 'Session'}**\n${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// PAGED LISTS: /sessions, /tournaments, and the session board
// ---------------------------------------------------------------------------
//
// THE ARITHMETIC IS NOT HERE. The app routes own the page, the search, the
// location filter and every total, because those files are type-checked and this
// one's tests are not (apps/bot/tsconfig.json excludes src/**/__tests__/**). The
// bot is the renderer: it echoes ids it was given and prints numbers it was
// handed.
//
// ONE custom_id GRAMMAR, FIVE SLOTS, ALWAYS PRESENT:
//
//     <prefix>:<origin>:<action>:<num|->:<loc|->
//
//   prefix   ses: / trn: / sesboard:   WHO THE ROWS ARE FOR
//   origin   e or p                    WHAT KIND OF MESSAGE WAS CLICKED
//   action   prev / next / go / find / loc
//   num      target page, or the page count a `go` modal names, or -
//   loc      an opaque location id from the route, or -
//
// `-` rather than an omitted segment, because a grammar with optional segments
// puts a page number and a location id in the same slot on different messages,
// and the parser that reads the wrong one fails silently.
//
// THE ORIGIN DECIDES THE RESPONSE TYPE, AND IT FAILS CLOSED. Exactly `e` means
// the click arrived on a message that is already private to the clicker, which
// is the only case where type 7 (edit the message the component sits on) is
// safe. Anything else, including a garbled, truncated or unrecognised id,
// resolves to public and answers type 4 with flags 64, which cannot edit
// anything. Had the marker gone the other way a mangled id would type-7 edit
// whatever it was sitting on, and one of those messages is a post the whole club
// reads. The bot writes every one of these ids, so unlike a flag read off the
// interaction it cannot be wrong in the dangerous direction.
//
// THE PREFIX DECIDES THE AUDIENCE, and it has to be a separate field from the
// origin: a private COPY of the public board carries `e`, so a handler that read
// the audience off the origin would switch audience on the second click.
//
// THE ONE MISTAKE WITH THE LARGEST BLAST RADIUS is a public render path emitting
// `e` ids, because a click would then type-7 edit the club's channel post under
// every reader. The guard is that no call site anywhere passes a variable
// origin: sessionPostBoard and sessionBoardWall hardcode `p`, sessionPostCopy is
// the only function in the codebase that emits `sesboard:e:`, and session-board.ts
// does not import it.
//
// Longest id: sesboard:p:prev:999:a1b2c3d4, 28 characters against Discord's 100.

/** Paging ids on /sessions' own ephemeral reply. */
const SESSION_PAGE_PREFIX = 'ses:';
/** Paging ids on /tournaments' own ephemeral reply. */
const TOURNAMENT_PAGE_PREFIX = 'trn:';
/**
 * Paging ids on the two PUBLIC session messages: /sessionpost's snapshot and the
 * self-updating board.
 *
 * A prefix of its own rather than reusing `ses:`, so the audience travels in the
 * prefix. Disjoint from `ses:` under startsWith in both directions because they
 * differ at index 3 (`b` against `:`), and from `sesmodal:` at the same index.
 * Named `sesboard:` rather than `sesp:`, which misreads as `ses:`.
 */
const SESSION_BOARD_PREFIX = 'sesboard:';

// Modal ids carry no origin: a modal submit ALWAYS answers type 4 with flags 64,
// so the board it renders is always ephemeral and always carries `e` ids. Adding
// an origin here for symmetry would be adding a field nothing may read.
// Grammar: <prefix><action>:<loc|->
const SESSION_MODAL_PREFIX = 'sesmodal:';
const TOURNAMENT_MODAL_PREFIX = 'trnmodal:';
const SESSION_BOARD_MODAL_PREFIX = 'sesboardmodal:';

/** Discord refuses a select with more than 25 options. */
const SELECT_OPTIONS_MAX = 25;

// Discord refuses an embed description over 4096 characters and takes the whole
// message down with it, silently on an interaction response (index.ts writes the
// callback as the HTTP body, so there is no status to log). 4000 is the same
// headroom announcements.ts leaves. `sessions.name` is unbounded TEXT, so a
// 300-character session name is the only way to get near it.
const DESCRIPTION_MAX = 4000;

/**
 * What the board says when the schedule really is empty.
 *
 * NEVER AN EMPTY STRING: Discord refuses an embed with an empty description, and
 * every list render goes through here so that cannot happen. Leaving the last
 * render up instead would be worse than saying nothing, because those rows are
 * absolute <t:...:F> stamps that quietly become a list of nights that have
 * already happened.
 */
const NO_SESSIONS_LINE = 'No club-wide sessions are open right now.';

function clampDescription(text: string): string {
  return text.length > DESCRIPTION_MAX ? text.slice(0, DESCRIPTION_MAX) : text;
}

function idSlots(customId: string): string[] {
  return customId.split(':');
}

/** Anything that is not exactly `e` is public. The fail-closed direction. */
function originFromButtonId(customId: string): 'e' | 'p' {
  return idSlots(customId)[1] === 'e' ? 'e' : 'p';
}

/** Dispatch on this FIRST, so the numeric slot is never read for go or find. */
function actionFromButtonId(customId: string): string {
  return idSlots(customId)[2] ?? '';
}

/**
 * The target page of a prev or next button, and nothing else.
 *
 * Named apart from the `go` slot deliberately: `go` puts a page COUNT where
 * these put a page NUMBER, and one parser for both would read the wrong one on
 * half the ids. Fails closed to 1, which is the list the member would have got
 * anyway, and the route clamps the upper end.
 */
function targetPageFromButtonId(customId: string): number {
  const page = Number.parseInt(idSlots(customId)[3] ?? '', 10);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/** The location filter to carry forward, or null for "all locations". */
function locationFromButtonId(customId: string): string | null {
  const slot = idSlots(customId)[4] ?? '-';
  return slot && slot !== '-' ? slot : null;
}

/**
 * One action row of pager buttons, or none at all.
 *
 * Takes the ids as opaque strings, so it knows nothing about the grammar above
 * and cannot be the place an origin goes wrong. Three invariants worth naming:
 *
 *  - NEVER style 5. Style 5 is the LINK style; it requires a url, cannot carry a
 *    custom_id, and emits no interaction at all when clicked. The same trap
 *    guideComponents documents.
 *  - The edges are DISABLED rather than omitted, so the row never changes shape
 *    under the reader's cursor.
 *  - The ids are distinct in every case, including one page, because direction
 *    is encoded in them rather than derived from the target. A duplicate
 *    custom_id makes Discord refuse the whole message, and on an interaction
 *    response that arrives as "the application did not respond" with nothing
 *    logged anywhere.
 *
 * Returns [] at one page: a UX call, not the uniqueness guard.
 */
function pagerRow(input: {
  prevId: string;
  nextId: string;
  goId?: string;
  findId?: string;
  page: number;
  totalPages: number;
}): Record<string, unknown>[] {
  if (input.totalPages <= 1) return [];

  const buttons: Record<string, unknown>[] = [
    {
      type: 2, // BUTTON
      style: 2, // SECONDARY -- paging is neither primary nor destructive
      label: 'Previous',
      custom_id: input.prevId,
      disabled: input.page <= 1,
    },
    {
      type: 2,
      style: 2,
      label: 'Next',
      custom_id: input.nextId,
      disabled: input.page >= input.totalPages,
    },
  ];
  if (input.goId) {
    buttons.push({ type: 2, style: 2, label: 'Go to page', custom_id: input.goId });
  }
  if (input.findId) {
    buttons.push({ type: 2, style: 2, label: 'Find', custom_id: input.findId });
  }

  return [{ type: 1, components: buttons }];
}

/**
 * The location filter, as a string select on its own row.
 *
 * OMITTED BELOW TWO LOCATIONS, mirroring pagerRow's one-page rule: a filter over
 * a single gym can do nothing, and a dead control on the club's board is worse
 * than no control. The options come from the route's window rather than from the
 * page, or a gym with nothing on in the next ten would vanish from its own
 * filter.
 *
 * The current selection is rendered with `default: true` and an explicit "All
 * locations" option, so the state is visible rather than implied.
 */
function locationRow(input: {
  customId: string;
  locations: { id: string; label: string }[];
  applied: string | null;
}): Record<string, unknown>[] {
  if (input.locations.length < 2) return [];

  const options: Record<string, unknown>[] = [
    { label: 'All locations', value: '-', default: input.applied === null },
    // One slot is spent on "All locations", so the rest is what is left of the 25.
    ...input.locations.slice(0, SELECT_OPTIONS_MAX - 1).map((l) => ({
      label: l.label.slice(0, 100),
      value: l.id,
      default: l.id === input.applied,
    })),
  ];

  return [
    {
      type: 1, // ACTION_ROW -- a select must sit alone in one
      components: [
        {
          type: 3, // STRING_SELECT
          custom_id: input.customId,
          placeholder: 'Filter by location',
          min_values: 1,
          max_values: 1,
          options,
        },
      ],
    },
  ];
}

/** An embed and its control rows, ready to be a response body. */
type RenderedList = {
  embeds: Record<string, unknown>[];
  components: Record<string, unknown>[];
};

/**
 * The ONLY permitted way to answer a click with a freshly rendered private copy.
 *
 * Not `{ ...board, flags: 64 }` at the call site, for the reason ephemeralEmbed
 * exists: a flag at the call site is easy to drop in a refactor and the bug is
 * invisible to whoever caused it, because they see their own message either way.
 * Here the consequence is not clutter. Drop the flag on a copy of the session
 * board and one member's personalised schedule posts publicly into the channel,
 * which is the exact leak the ephemeral rule on /sessions exists to prevent.
 */
function ephemeralBoard(board: RenderedList): BotResponse {
  return { type: 4, data: { ...board, flags: 64 } };
}

/**
 * Type 7 for a click that arrived on a private message, type 4 + flags 64 for
 * one that arrived on a public one.
 *
 * THE ASYMMETRY IS THE POINT: the RESPONSE differs, the rendered content does
 * not. A copy is always built by a wrapper that emits `e` ids, whichever
 * message was clicked, because a copy is always private and its own buttons have
 * to page it in place.
 */
function listResponse(origin: 'e' | 'p', board: RenderedList): BotResponse {
  return origin === 'e' ? { type: 7, data: board } : ephemeralBoard(board);
}

/**
 * Every session list this bot renders, in one function.
 *
 * The wrappers below are what call it, and each of them hardcodes its prefix and
 * its origin. Nothing takes either as a variable, which is what makes "no public
 * render path can emit an `e` id" a property of the code rather than a rule in a
 * comment.
 */
function sessionList(
  data: SessionsPage,
  render: {
    prefix: string;
    origin: 'e' | 'p';
    /**
     * Whether these numbers are the reader's own. The wall's are not: it always
     * fetches as nobody, so its `linked` is always false and its footer must
     * ignore it entirely, or it would offer /link to explain a narrowing that is
     * not happening.
     */
    personal: boolean;
    /** A STATIC extra clause. Anything clock derived would refingerprint the
     *  board on every tick and edit it forever. */
    note: string | null;
    withLocations: boolean;
  }
): RenderedList {
  const { page, totalPages, total, locations, location } = data;
  const head = `${render.prefix}${render.origin}`;
  const loc = location ?? '-';

  const rows = [
    ...pagerRow({
      prevId: `${head}:prev:${Math.max(1, page - 1)}:${loc}`,
      nextId: `${head}:next:${Math.min(totalPages, page + 1)}:${loc}`,
      // A PUBLIC `go` CARRIES NO TOTAL. The copy a public click produces is the
      // clicker's own and may run to more pages than the public message does, so
      // a range built from the public numbers would understate it and read as a
      // cap. Only an `e` id's total is the clicker's to quote.
      goId: `${head}:go:${render.origin === 'e' ? totalPages : '-'}:${loc}`,
      findId: `${head}:find:-:${loc}`,
      page,
      totalPages,
    }),
    ...(render.withLocations
      ? locationRow({ customId: `${head}:loc:-:${loc}`, locations, applied: location })
      : []),
  ];

  const appliedLabel = locations.find((l) => l.id === location)?.label ?? null;

  return {
    embeds: [
      {
        title: 'Upcoming sessions',
        color: CLUB_RED,
        description: data.sessions.length
          ? clampDescription(data.sessions.map(formatSession).join('\n\n'))
          : NO_SESSIONS_LINE,
        footer: {
          text: [
            `Page ${page} of ${totalPages}`,
            // "for you" is load-bearing on a copy: it is the whole explanation
            // of why the reader's numbers differ from the ones on the wall they
            // clicked.
            `${total} upcoming${render.personal ? ' for you' : ''}`,
            appliedLabel ? `at ${appliedLabel}` : null,
            render.personal && !data.linked
              ? 'Club-wide nights only: run /link to see the sessions for your track.'
              : 'RSVP on the website',
            render.note,
          ]
            .filter(Boolean)
            .join(' · '),
        },
      },
    ],
    components: rows,
  };
}

/** /sessions' own reply and every private copy of it. `ses:e:` */
function sessionsBoard(data: SessionsPage): RenderedList {
  // No location select: that control belongs to the board family, where a public
  // message needs a way to narrow a club-wide list. Here the reader already has
  // /sessions and the find button.
  return sessionList(data, {
    prefix: SESSION_PAGE_PREFIX,
    origin: 'e',
    personal: true,
    note: null,
    withLocations: false,
  });
}

/** The /sessionpost snapshot. PUBLIC, so `sesboard:p:`. */
function sessionPostBoard(data: SessionsPage): RenderedList {
  return sessionList(data, {
    prefix: SESSION_BOARD_PREFIX,
    origin: 'p',
    personal: false,
    note: 'The buttons give you your own private copy; this post does not move.',
    withLocations: true,
  });
}

/**
 * The self-updating board. PUBLIC, so `sesboard:p:`, identically to the snapshot.
 *
 * It differs from sessionPostBoard in exactly one respect: a static clause saying
 * the message maintains itself. Without it the live board and a month-old
 * snapshot in the same channel are byte-identical messages and no member can
 * tell which is which.
 */
export function sessionBoardWall(data: SessionsPage): RenderedList {
  return sessionList(data, {
    prefix: SESSION_BOARD_PREFIX,
    origin: 'p',
    personal: false,
    note: 'Updates itself. The buttons give you your own private copy; this post does not move.',
    withLocations: true,
  });
}

/**
 * A reader's private copy of a public board. THE ONLY EMITTER OF `sesboard:e:`.
 *
 * PERSONALISED, and that is not a leak: the copy is ephemeral, so the rows it
 * shows are the clicker's own and nobody else's, exactly as /sessions already
 * works. The public post is never edited and never filtered.
 *
 * ONE RENDER PATH FOR LINKED AND UNLINKED. They differ only in the footer
 * clause, which sessionList already handles. An unlinked copy shows every
 * club-wide row in full: withholding rows that are sitting in the message
 * directly above the button would hide nothing and make the button read as
 * broken. The nudge is text, never /link's button, because that button carries a
 * single-use credential minted per invocation and this path has no call to spend
 * on minting one.
 */
function sessionPostCopy(data: SessionsPage): RenderedList {
  return sessionList(data, {
    prefix: SESSION_BOARD_PREFIX,
    origin: 'e',
    personal: true,
    note: 'Your own copy. The board in the channel has not moved.',
    withLocations: true,
  });
}

/** /tournaments' own reply and every private copy of it. `trn:e:` */
function tournamentsBoard(data: TournamentsPage): RenderedList {
  const { page, totalPages, total } = data;
  const head = `${TOURNAMENT_PAGE_PREFIX}e`;

  // Finished this week, under the first page only: the route sends it only
  // when there is no search, and a later page repeating it would read as more
  // results.
  const finished = page === 1 ? (data.recentlyFinished ?? []) : [];
  const sections = [
    data.tournaments.length ? data.tournaments.map(formatTournament).join('\n\n') : TOURNAMENTS_EMPTY,
    ...(finished.length
      ? [
          `**Finished this week**\n${finished
            .map((t) => `${t.name} · ${formatTournamentDates(t)}`)
            .join('\n')}\nResults: \`/tournaments results\``,
        ]
      : []),
  ];

  return {
    embeds: [
      {
        title: 'Tournaments',
        color: CLUB_RED,
        description: clampDescription(sections.join('\n\n')),
        footer: {
          text: [
            `Page ${page} of ${totalPages}`,
            `${total} on or upcoming`,
            data.linked
              ? 'Enter with /tournaments enter or on the website'
              : 'Run /link to see which of these you can enter.',
          ].join(' · '),
        },
      },
    ],
    // No location slot in use here, and no select: a tournament's venue is not
    // in this payload at all. The slot is still present as `-` so the grammar is
    // one grammar and the positions never shift.
    components: pagerRow({
      prevId: `${head}:prev:${Math.max(1, page - 1)}:-`,
      nextId: `${head}:next:${Math.min(totalPages, page + 1)}:-`,
      goId: `${head}:go:${totalPages}:-`,
      findId: `${head}:find:-:-`,
      page,
      totalPages,
    }),
  };
}

/**
 * A modal, opened by a click, answered with no app call at all.
 *
 * Type 9 in response to a type 3 has no precedent in this bot, so it is on the
 * staging click list. Instant by construction: nothing here waits on the app, so
 * the 3 second interaction deadline is never in play.
 */
function openListModal(input: {
  modalPrefix: string;
  action: 'go' | 'find';
  /** The raw page-count slot off the button, `-` on a public id. */
  totalSlot: string;
  /** The raw location slot, carried through so a modal preserves the filter. */
  locSlot: string;
  title: string;
  findPlaceholder: string;
}): BotResponse {
  const custom_id = `${input.modalPrefix}${input.action}:${input.locSlot || '-'}`;
  const total = Number.parseInt(input.totalSlot, 10);

  const field =
    input.action === 'go'
      ? {
          type: 4, // TEXT_INPUT
          custom_id: 'page',
          label: 'Which page?',
          style: 1, // SHORT
          required: true,
          min_length: 1,
          max_length: 4,
          // Generic unless the id carried a total, which only an `e` id does.
          placeholder:
            Number.isInteger(total) && total >= 1 ? `1 to ${total}` : 'Page number',
        }
      : {
          type: 4,
          custom_id: 'q',
          label: 'What are you looking for?',
          style: 1,
          required: true,
          min_length: 1,
          max_length: 80,
          placeholder: input.findPlaceholder,
        };

  return {
    type: 9, // MODAL
    data: {
      custom_id,
      title: input.title.slice(0, MODAL_TITLE_MAX),
      components: [{ type: 1, components: [field] }],
    },
  };
}

/** The location a modal submit has to carry forward, or null. */
function locationFromModalId(customId: string): string | null {
  const slot = idSlots(customId)[2] ?? '-';
  return slot && slot !== '-' ? slot : null;
}

/** go or find, off a modal id. */
function actionFromModalId(customId: string): string {
  return idSlots(customId)[1] ?? '';
}

/** A typed page number, failing closed to 1 exactly as the button parser does. */
function pageFromModalValue(value: string): number {
  const page = Number.parseInt(value.trim(), 10);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/**
 * What a find answers with: THE MATCHES, and no components.
 *
 * Not a jump to the page holding the first one. Session names repeat weekly, so
 * "Club night" matches rows spread over every page, and landing on the first of
 * them often means landing on the page the member was already looking at while
 * the other three stay hidden. Position in a time-ordered list carries no
 * information, so the useful answer is the rows themselves.
 *
 * The window note is not decoration: the app searches what it has read, not the
 * whole calendar, so without it a member searching for something months out gets
 * a confident wrong answer.
 */
function searchMessage(input: {
  q: string;
  lines: string[];
  total: number;
  nothing: string;
}): BotResponse {
  if (input.lines.length === 0) return ephemeral(input.nothing);

  return ephemeralEmbed({
    title: `Matching "${input.q}"`,
    color: CLUB_RED,
    description: clampDescription(input.lines.join('\n\n')),
    footer: {
      text: [
        input.total > input.lines.length
          ? `Showing ${input.lines.length} of ${input.total}, refine your search`
          : `${input.total} match${input.total === 1 ? '' : 'es'}`,
        'Search only reaches what is coming up next',
      ].join(' · '),
    },
  });
}

/**
 * The app applied the search this bot asked for. CHECKED, not assumed.
 *
 * The bot image and the player image roll independently, so a bot that sends ?q=
 * to an app that does not read it gets an unfiltered page back. Framing ten
 * non-matching sessions as search results is a wrong answer rather than a
 * cosmetic one, so an absent or mismatched echo refuses instead.
 */
function searchWasApplied(echo: string | null, sent: string): boolean {
  return echo !== null && echo === sent.toLowerCase();
}

const SEARCH_UNAVAILABLE =
  "Search isn't available yet on this build. Try again in a few minutes.";

/**
 * EPHEMERAL, and that is a correctness property rather than tidiness.
 *
 * The app now returns a schedule filtered to the CALLER — a recreational member
 * is not shown competitive nights, matching the website. A public reply would
 * undo that completely: one competitive member runs /sessions and the bot posts
 * their filtered-for-them schedule into a channel every rec member reads. The
 * filter and the flag only work as a pair.
 *
 * It also means one person's /sessions no longer buries a busy channel in ten
 * embeds, which is a nice consequence and not the reason.
 *
 * PAGING PRESERVES BOTH HALVES. A pager click re-fetches with the clicker's id,
 * and because the message is ephemeral the clicker is the same person the first
 * fetch was made for, so the per-caller filter still holds on every page.
 */
export async function handleSessions(context: InteractionContext) {
  const data = await fetchSessions(context.discordUserId, 1);

  if (data.sessions.length === 0) {
    return ephemeral(
      data.linked
        ? 'No upcoming sessions are open right now.'
        : 'No club-wide sessions are open right now.\n\n' +
            'Run **/link** to connect your club account and see the sessions for your track.'
    );
  }

  // The footer's linked and unlinked wording lives in sessionList, said the same
  // way in both branches: an unlinked caller is seeing club-wide nights only and
  // should know the list is narrowed rather than empty.
  return ephemeralBoard(sessionsBoard(data));
}

/**
 * A pager click on /sessions' own reply, or on a private copy of it.
 *
 * ONE HANDLER, ONE RENDER PATH, TWO RESPONSE TYPES, picked by the origin in the
 * id. Both `data.embeds` AND `data.components` go back on every type 7, because
 * type 7 replaces what it is given and omitting the components strips the buttons
 * off the message with no error anywhere. The components key is sent even when
 * its value is [], so a list that shrank to one page between clicks clears its
 * buttons instead of stranding live controls on a single page.
 */
export async function handleSessionPageButton(
  customId: string,
  context: InteractionContext
): Promise<BotResponse> {
  const action = actionFromButtonId(customId);

  if (action === 'go' || action === 'find') {
    return openListModal({
      modalPrefix: SESSION_MODAL_PREFIX,
      action,
      totalSlot: idSlots(customId)[3] ?? '-',
      locSlot: idSlots(customId)[4] ?? '-',
      title: action === 'go' ? 'Go to page' : 'Find a session',
      findPlaceholder: 'Club night, or West Gym',
    });
  }

  if (action !== 'prev' && action !== 'next') {
    // A button from an older build. Type 6 acknowledges and changes nothing,
    // leaving the message exactly as it was: the same fail-quiet answer index.ts
    // already gives a component it does not recognise.
    return { type: 6 };
  }

  const data = await fetchSessions(
    // THE CALLER ID COMES FROM THE INTERACTION, NEVER FROM THE custom_id, so
    // nothing a client controls can widen what comes back.
    context.discordUserId,
    targetPageFromButtonId(customId),
    undefined,
    locationFromButtonId(customId) ?? undefined
  );

  if (data.sessions.length === 0) {
    // Type 4 rather than a type-7 empty embed: Discord refuses an embed with an
    // empty description, and on an interaction response that refusal reaches the
    // member as "the application did not respond" with nothing logged.
    return ephemeral('No upcoming sessions are open right now.');
  }

  return listResponse(originFromButtonId(customId), sessionsBoard(data));
}

/**
 * A submitted "go to page" or "find" from /sessions.
 *
 * NEVER TYPE 7, and that is the invariant the two-path design rests on: a modal
 * submit is its own interaction, so the message it would edit is not the one the
 * member is looking at. The fresh ephemeral board it answers with is itself
 * pageable, because its own buttons carry `e`.
 */
export async function handleSessionListModal(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const location = locationFromModalId(customId) ?? undefined;

  if (actionFromModalId(customId) === 'go') {
    const data = await fetchSessions(
      context.discordUserId,
      pageFromModalValue(modalValue(components, 'page')),
      undefined,
      location
    );
    if (data.sessions.length === 0) return ephemeral('No upcoming sessions are open right now.');
    return ephemeralBoard(sessionsBoard(data));
  }

  const q = modalValue(components, 'q').trim().slice(0, 80);
  if (!q) {
    // Discord's min_length of 1 lets a space through. Answering with the
    // unfiltered page would read as a search that matched everything.
    return ephemeral('Type something to search for.');
  }

  const data = await fetchSessions(context.discordUserId, 1, q, location);
  if (!searchWasApplied(data.query, q)) return ephemeral(SEARCH_UNAVAILABLE);

  return searchMessage({
    q,
    lines: data.sessions.map(formatSession),
    total: data.total,
    nothing: `Nothing coming up matches "${q}".`,
  });
}

/**
 * The session schedule, posted into the channel for everyone to read.
 *
 * NOT EPHEMERAL -- that is the entire point of it, and it is the reason this is
 * a separate command rather than a flag on /sessions. Read the comment on
 * handleSessions before changing anything here: /sessions is ephemeral as a
 * CORRECTNESS property, because the app filters that schedule to the caller's
 * own track, and a public reply would post one member's filtered-for-them view
 * into a channel every other track reads.
 *
 * WHICH IS WHY THIS FETCHES WITH NO CALLER. Passing the exec who ran it would
 * publish THEIR schedule; the audience for a channel post is everyone who can
 * read the channel, including members who never linked an account, so the right
 * view is the one the app gives an unlinked caller -- club-wide nights only.
 * See PUBLIC_TRACKS and the three-audiences comment in the sessions route. The
 * gate on this command controls who may post, not what the post may contain,
 * and those are different questions.
 *
 * NOBODY IS MENTIONED, for the reason announcements.ts gives at length: a
 * feature that can ping the server on demand is one bad afternoon away from
 * people muting the channel that carries club notices. The scheduled pings in
 * session-pings.ts are the thing that is allowed to mention a role, and they
 * are rate-limited by being tied to a session actually starting.
 *
 * IT CARRIES BUTTONS, AND THEY NEVER EDIT THIS MESSAGE. A click answers with a
 * private copy of the board, so the public post stays on page 1 for every reader
 * forever and there is no per-message page state anywhere. The truncation apology
 * this footer used to carry is gone with it: all 28 rows are now reachable from
 * the post, so there is nothing to apologise for.
 *
 * ZERO ARGUMENTS, DELIBERATELY. This is the only function that produces the
 * public post, and there is no clicker id in scope in it to pass. Adding a
 * parameter here is a visible signature change a reviewer sees, which is the
 * whole guard: see the arity assertion in the tests.
 */
export async function handleSessionPost(): Promise<BotResponse> {
  const data = await fetchSessions(null, 1);

  // EPHEMERAL, unlike the success case. "There is nothing to post" is feedback
  // for the exec who ran the command, not a notice the channel needs -- and a
  // public "no sessions are open" is worse than saying nothing, because it
  // reads as a club announcement that the club has cancelled everything.
  if (data.sessions.length === 0) {
    return ephemeral(
      'No club-wide sessions are open right now, so there is nothing to post.'
    );
  }

  // No flags, so it stays public. No "run /link to see your track" line either:
  // that footer is advice for one reader looking at their own narrowed list, and
  // on a club-wide post it would imply this list is narrowed, which it is not.
  return { type: 4, data: sessionPostBoard(data) };
}

/**
 * A click on one of the two PUBLIC session messages: the /sessionpost snapshot or
 * the self-updating board.
 *
 * WHAT THE CLICKER GETS IS THEIR OWN PRIVATE COPY, personalised to them, and the
 * public message is never touched. That is not the leak the ephemeral rule on
 * /sessions guards against: an ephemeral copy shows the clicker their own view
 * and nobody else's, which is exactly what /sessions already does. The leak
 * would be editing the shared message, and no path here can: a `p` id answers
 * type 4 with flags 64, and only an `e` id, which only sessionPostCopy emits,
 * reaches type 7.
 *
 * THIS HANDLER HAS A CLICKER ID AND THAT IS FINE. The guard lives on the
 * producers of the public message instead: handleSessionPost takes no arguments,
 * and the tick fetches with null. Neither has an id in scope to pass.
 *
 * `values` is how a string select's choice arrives. The bot has never read that
 * field before, so it fails closed to no filter.
 */
export async function handleSessionBoardButton(
  customId: string,
  context: InteractionContext,
  values?: string[]
): Promise<BotResponse> {
  const action = actionFromButtonId(customId);

  if (action === 'go' || action === 'find') {
    return openListModal({
      modalPrefix: SESSION_BOARD_MODAL_PREFIX,
      action,
      totalSlot: idSlots(customId)[3] ?? '-',
      locSlot: idSlots(customId)[4] ?? '-',
      title: action === 'go' ? 'Go to page' : 'Find a session',
      findPlaceholder: 'Club night, or West Gym',
    });
  }

  let location = locationFromButtonId(customId);
  if (action === 'loc') {
    // FAILS CLOSED TO NO FILTER. An absent or empty `values` must not leave the
    // filter the member just changed silently in place, and it must certainly not
    // be read off the id instead, which is the selection they are replacing.
    const chosen = values?.[0] ?? '-';
    location = chosen && chosen !== '-' ? chosen : null;
  } else if (action !== 'prev' && action !== 'next') {
    return { type: 6 };
  }

  const data = await fetchSessions(
    context.discordUserId,
    // A new filter is a different list, so it starts at its first page rather
    // than wherever the reader happened to be.
    action === 'loc' ? 1 : targetPageFromButtonId(customId),
    undefined,
    location ?? undefined
  );

  if (data.sessions.length === 0) {
    return ephemeral('No upcoming sessions are open right now.');
  }

  return listResponse(originFromButtonId(customId), sessionPostCopy(data));
}

/**
 * A submitted "go to page" or "find" from a public board or a copy of one.
 *
 * FETCHED AS THE CLICKER, like the board's buttons and unlike the board's own
 * render path. A modal submit always answers with an ephemeral copy, so it takes
 * the copy's audience; and the numbers it prints are the clicker's own, which is
 * what "for you" in the footer says. Never type 7, for the reason on
 * handleSessionListModal.
 */
export async function handleSessionBoardModal(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const location = locationFromModalId(customId) ?? undefined;

  if (actionFromModalId(customId) === 'go') {
    const data = await fetchSessions(
      context.discordUserId,
      pageFromModalValue(modalValue(components, 'page')),
      undefined,
      location
    );
    if (data.sessions.length === 0) return ephemeral('No upcoming sessions are open right now.');
    return ephemeralBoard(sessionPostCopy(data));
  }

  const q = modalValue(components, 'q').trim().slice(0, 80);
  if (!q) return ephemeral('Type something to search for.');

  const data = await fetchSessions(context.discordUserId, 1, q, location);
  if (!searchWasApplied(data.query, q)) return ephemeral(SEARCH_UNAVAILABLE);

  return searchMessage({
    q,
    lines: data.sessions.map(formatSession),
    total: data.total,
    nothing: `Nothing coming up matches "${q}".`,
  });
}

/**
 * A tournament's dates, as a date and not an instant.
 *
 * <t:unix:F> is right for a session, which starts at a specific minute. A
 * tournament runs a day or a weekend, and rendering it as "Saturday 9:00 AM" in
 * each reader's timezone would state a start time the club has not actually
 * committed to — the schema stores DATE, with no time of day at all. <t:unix:D>
 * shows the date alone, which is the whole of what is known.
 */
function formatTournamentDates(t: { startDate: string; endDate: string | null }): string {
  // Noon UTC, not midnight: midnight on the club's date is the previous day in
  // every timezone west of it, so a reader in Vancouver would see a tournament
  // starting the day before the website says.
  const stamp = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);
  const start = `<t:${stamp(t.startDate)}:D>`;
  if (!t.endDate || t.endDate === t.startDate) return start;
  return `${start} – <t:${stamp(t.endDate)}:D>`;
}

const TOURNAMENTS_EMPTY = 'Nothing is on or coming up right now. Past tournaments are on the website.';

function formatTournament(t: TournamentSummary): string {
  const parts = [formatTournamentDates(t)];
  if (t.inProgress) parts.unshift('**Happening now**');
  if (t.events.length > 0) parts.push(`${t.events.length} event${t.events.length === 1 ? '' : 's'}`);
  if (t.registrationOpen) parts.push('entries open');

  // WHY INELIGIBILITY IS A NOTE AND NOT A FILTER. allowed_memberships is an
  // ENTRY rule — the registration path reads it and refuses — not a visibility
  // one, and the website shows every tournament to every member. Hiding rows
  // here would make Discord show LESS than the site, and the member would find
  // out they cannot enter at the click instead of now.
  const note = t.eligible === false ? '\n_Not open to your membership type._' : '';

  return `**${t.name}**\n${parts.join(' · ')}${note}`;
}

/**
 * EPHEMERAL, for a reason that is one step removed from /sessions'.
 *
 * There is no leak to prevent here — the tournament list is the same for
 * everybody, because the column that pretended to gate it was dropped in 00109
 * and the website filters nothing. What IS per-caller is the eligibility note,
 * and a public reply would announce to the channel which membership type the
 * caller holds. That is nobody else's business, and it would arrive as a side
 * effect of running a command about tournaments.
 */
export async function handleTournaments(context: InteractionContext, options?: CommandOption[]) {
  const chosen = subcommand(options);
  switch (chosen.name) {
    // null: a client still holding the registration from before the
    // subcommands, which sends none. That was the list.
    case null:
    case 'list':
      break;
    case 'enter':
      return handleTournamentEnter(chosen.options, context);
    case 'draw':
      return handleTournamentDraw(chosen.options);
    case 'next':
      return handleTournamentNext(context);
    case 'results':
      return handleTournamentResults(chosen.options);
    default:
      return ephemeral('Unknown subcommand.');
  }

  const data = await fetchTournaments(context.discordUserId, 1);

  if (data.tournaments.length === 0 && (data.recentlyFinished ?? []).length === 0) {
    return ephemeral(TOURNAMENTS_EMPTY);
  }

  return ephemeralBoard(tournamentsBoard(data));
}

/**
 * A pager click on /tournaments.
 *
 * THIS WILL LOOK LIKE NOTHING CHANGED for a long time: the row is omitted below
 * eleven upcoming tournaments and the club runs a handful, so the buttons appear
 * only when there is something to page. That is the design working.
 */
export async function handleTournamentPageButton(
  customId: string,
  context: InteractionContext
): Promise<BotResponse> {
  const action = actionFromButtonId(customId);

  if (action === 'go' || action === 'find') {
    return openListModal({
      modalPrefix: TOURNAMENT_MODAL_PREFIX,
      action,
      totalSlot: idSlots(customId)[3] ?? '-',
      locSlot: '-',
      title: action === 'go' ? 'Go to page' : 'Find a tournament',
      findPlaceholder: 'Autumn Classic',
    });
  }

  if (action !== 'prev' && action !== 'next') return { type: 6 };

  const data = await fetchTournaments(context.discordUserId, targetPageFromButtonId(customId));

  if (data.tournaments.length === 0) {
    return ephemeral(TOURNAMENTS_EMPTY);
  }

  return listResponse(originFromButtonId(customId), tournamentsBoard(data));
}

/** A submitted "go to page" or "find" from /tournaments. Never type 7. */
export async function handleTournamentListModal(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  if (actionFromModalId(customId) === 'go') {
    const data = await fetchTournaments(
      context.discordUserId,
      pageFromModalValue(modalValue(components, 'page'))
    );
    if (data.tournaments.length === 0) {
      return ephemeral(TOURNAMENTS_EMPTY);
    }
    return ephemeralBoard(tournamentsBoard(data));
  }

  const q = modalValue(components, 'q').trim().slice(0, 80);
  if (!q) return ephemeral('Type something to search for.');

  const data = await fetchTournaments(context.discordUserId, 1, q);
  if (!searchWasApplied(data.query, q)) return ephemeral(SEARCH_UNAVAILABLE);

  return searchMessage({
    q,
    lines: data.tournaments.map(formatTournament),
    total: data.total,
    nothing: `No tournament on or coming up matches "${q}".`,
  });
}

// ---------------------------------------------------------------------------
// /tournaments enter, draw, next and results
// ---------------------------------------------------------------------------
//
// In DEFERRED_COMMANDS, so each of these has fifteen minutes and its answer is
// the edit of an ephemeral "thinking...". draw, next and results only read;
// enter writes an entry AS THE CALLER, read off the interaction, never from an
// option, through the app's own registerForEvent body.

const TOURNAMENT_PICK_FIRST = 'Pick a tournament from the list.';
const TOURNAMENT_PICK_EVENT = 'Pick an event from the list.';

// An abort can fire after the app has written the entry, so this never says
// nothing happened.
const TOURNAMENT_ENTRY_UNKNOWN =
  "Couldn't get an answer from the club app, so I can't tell whether you were entered. " +
  'Check the tournament on the website before you try again.';

// One message carries at most 10 embeds, 4096 characters in a description
// and 6000 across every embed in it. The budgets sit under those with room
// for the titles and the link line.
const DRAW_EMBEDS_MAX = 10;
const DRAW_DESCRIPTION_MAX = 4000;
const DRAW_MESSAGE_MAX = 5800;

function tournamentLine(content: string): BotResponse {
  // allowed_mentions empty: a player's name is text a member typed.
  return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
}

function suspendedNote(suspended: { reason: string | null } | null): string | null {
  if (!suspended) return null;
  return suspended.reason ? `Play is suspended: ${suspended.reason.slice(0, 300)}` : 'Play is suspended.';
}

/** Turn an entry refusal into this file's own sentence. */
function tournamentEntryRefusalText(reply: Extract<TournamentEntryReply, { ok: false }>): string {
  switch (reply.refusal) {
    case 'not_linked':
      return 'Link your account first with `/link`.';
    case 'lapsed':
      return 'Your membership was paused for inactivity. Open the club website once to switch it back on, then try again.';
    case 'standing':
      return "Your account can't enter tournaments right now. The club website says why.";
    case 'feature_off':
      return 'Tournaments are switched off in the club right now.';
    case 'waiver':
      return "Accept the club's current legal documents on the website first, then try again.";
    case 'not_found':
      return "That event isn't open to entries. Pick one from the list.";
    case 'website':
      // An event waiver is a signed record and a doubles entry is a choice
      // about a partner: both are the website's to ask.
      return reply.url
        ? `Enter this one on the website, where you can read and accept what it asks: ${reply.url}`
        : 'Enter this one on the website, where you can read and accept what it asks.';
    case 'rule':
      return reply.message ? reply.message.slice(0, 300) : 'The club rules do not allow that entry.';
    default:
      return "The club app said no, and this version of the bot doesn't know why. Try the website.";
  }
}

async function handleTournamentEnter(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  if (!context.discordUserId) return tournamentLine("I couldn't tell who ran that. Try again.");
  const eventId = stringOption(options, 'event');
  if (!eventId || !UUID_PATTERN.test(eventId)) return tournamentLine(TOURNAMENT_PICK_EVENT);

  let reply: TournamentEntryReply;
  try {
    reply = await enterTournamentEvent({ discordUserId: context.discordUserId, eventId });
  } catch (error) {
    console.error('[bot] tournament entry failed:', error instanceof Error ? error.message : 'unknown');
    return tournamentLine(TOURNAMENT_ENTRY_UNKNOWN);
  }
  if (!reply.ok) return tournamentLine(tournamentEntryRefusalText(reply));
  return tournamentLine(
    `You're entered in ${reply.event}. Any entry fee and your check-in are on the website.`
  );
}

/**
 * A draw as embeds: the sections in order, packed whole lines at a time under
 * every Discord limit, with a "Full draw" link at the end. Whatever does not
 * fit is left to the link, and the last line says so.
 */
export function drawEmbeds(draw: Extract<TournamentDraw, { found: true }>): Record<string, unknown>[] {
  const title = `${draw.tournament.name} · ${draw.event.label}`.slice(0, 256);
  const tail: string[] = [];
  const suspended = suspendedNote(draw.suspended);
  if (suspended) tail.push(suspended);
  const link = draw.url ? `[Full draw](${draw.url})` : null;

  const lines: string[] = [];
  for (const section of draw.sections) {
    if (section.lines.length === 0) continue;
    lines.push(`**${section.title}**`, ...section.lines, '');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) lines.push('No matches drawn yet.');

  // The closing block goes on the last embed, so every description leaves room
  // for it (with the cut note, in case it is needed), and the message total
  // leaves room for it and the title.
  const cutNote = 'More on the website.';
  const closingRoom = [cutNote, ...tail, ...(link ? [link] : [])].join('\n').length + 2;
  const perEmbed = DRAW_DESCRIPTION_MAX - closingRoom;
  const messageRoom = DRAW_MESSAGE_MAX - closingRoom - title.length;

  const descriptions: string[] = [];
  let current = '';
  let used = 0;
  let cut = draw.truncated;
  for (const raw of lines) {
    const line = raw.slice(0, perEmbed);
    const startsNew = current !== '' && current.length + 1 + line.length > perEmbed;
    if (startsNew && descriptions.length + 1 >= DRAW_EMBEDS_MAX) {
      cut = true;
      break;
    }
    const cost = startsNew || current === '' ? line.length : line.length + 1;
    if (used + cost > messageRoom) {
      cut = true;
      break;
    }
    if (startsNew) {
      descriptions.push(current);
      current = line;
    } else {
      current = current === '' ? line : `${current}\n${line}`;
    }
    used += cost;
  }
  if (current) descriptions.push(current);
  if (descriptions.length === 0) descriptions.push('');

  const closing = [...(cut ? [cutNote] : []), ...tail, ...(link ? [link] : [])];
  if (closing.length > 0) {
    const last = descriptions.length - 1;
    descriptions[last] = descriptions[last] ? `${descriptions[last]}\n\n${closing.join('\n')}` : closing.join('\n');
  }

  return descriptions.map((description, index) => ({
    ...(index === 0 ? { title } : {}),
    color: CLUB_RED,
    description,
  }));
}

async function handleTournamentDraw(options: CommandOption[] | undefined): Promise<BotResponse> {
  const eventId = stringOption(options, 'event');
  if (!eventId || !UUID_PATTERN.test(eventId)) return tournamentLine(TOURNAMENT_PICK_EVENT);
  const draw = await fetchTournamentDraw(eventId);
  if (!draw.found) return tournamentLine("That event isn't showing a draw. Pick one from the list.");
  return {
    type: 4,
    data: { embeds: drawEmbeds(draw), flags: 64, allowed_mentions: { parse: [] } },
  };
}

const MATCH_STATUS_WORDS: Record<string, string> = {
  live: 'On court now',
  ready: 'Waiting to be called',
  pending: 'Scheduled',
};

async function handleTournamentNext(context: InteractionContext): Promise<BotResponse> {
  if (!context.discordUserId) return tournamentLine("I couldn't tell who ran that. Try again.");
  const reply = await fetchNextTournamentMatch(context.discordUserId);
  if (!reply.linked) return tournamentLine('Link your account first with `/link`.');
  const next = reply.match;
  if (!next) return tournamentLine('You have no tournament match coming up.');

  const lines = [
    `**${next.tournament}** · ${next.event}`,
    next.round,
    `Against: ${next.opponents}`,
    [MATCH_STATUS_WORDS[next.status] ?? next.status, next.court ? `Court ${next.court}` : null, next.scheduledTime]
      .filter(Boolean)
      .join(' · '),
  ];
  const suspended = suspendedNote(next.suspended);
  if (suspended) lines.push(suspended);
  if (next.url) lines.push(next.url);
  return tournamentLine(lines.join('\n').slice(0, 1900));
}

async function handleTournamentResults(options: CommandOption[] | undefined): Promise<BotResponse> {
  const tournamentId = stringOption(options, 'tournament');
  if (!tournamentId || !UUID_PATTERN.test(tournamentId)) return tournamentLine(TOURNAMENT_PICK_FIRST);
  const results = await fetchTournamentResults(tournamentId);
  if (!results.found) return tournamentLine("That tournament isn't showing results. Pick one from the list.");

  const sections: string[] = [];
  const suspended = suspendedNote(results.suspended);
  if (suspended) sections.push(suspended);
  sections.push(
    results.live.length ? `**On court now**\n${results.live.join('\n')}` : 'Nothing is on court right now.'
  );
  if (results.recent.length) sections.push(`**Latest results**\n${results.recent.join('\n')}`);
  if (results.url) sections.push(`[Full results](${results.url})`);
  return {
    type: 4,
    data: {
      embeds: [{ title: results.tournament.name.slice(0, 256), color: CLUB_RED, description: clampDescription(sections.join('\n\n')) }],
      flags: 64,
      allowed_mentions: { parse: [] },
    },
  };
}

/**
 * The /tournaments pickers. The tournament slot lists active tournaments; the
 * event slot lists the picked tournament's events, only those taking entries
 * for `enter`. Until a tournament is picked the event slot is empty.
 */
export async function handleTournamentAutocomplete(options: CommandOption[] | undefined): Promise<BotResponse> {
  const empty = { type: 8, data: { choices: [] as { name: string; value: string }[] } };
  const chosen = subcommand(options);
  const focused = chosen.options?.find((o) => o.focused);
  const typed = String(focused?.value ?? '').trim().slice(0, 80);
  try {
    let choices: { id: string; label: string }[] = [];
    if (focused?.name === 'tournament') {
      choices = await fetchTournamentChoices({ q: typed });
    } else if (focused?.name === 'event') {
      const tournamentId = String(option(chosen.options, 'tournament') ?? '');
      if (!UUID_PATTERN.test(tournamentId)) return empty;
      choices = await fetchTournamentChoices({ q: typed, tournamentId, open: chosen.name === 'enter' });
    } else {
      return empty;
    }
    return {
      type: 8,
      data: {
        choices: choices.slice(0, SELECT_OPTIONS_MAX).map((c) => ({ name: c.label.slice(0, 100), value: c.id })),
      },
    };
  } catch (error) {
    console.error('[bot] tournament picker failed:', error instanceof Error ? error.message : 'unknown');
    return empty;
  }
}

export async function handleLink(context: InteractionContext) {
  if (!context.discordUserId) {
    // Should be unreachable — Discord always identifies the caller — but the
    // alternative to checking is minting a token bound to "null".
    return ephemeral("Couldn't work out who you are on Discord. Try again.");
  }

  let url: string;
  let expiresAt: string;
  try {
    ({ url, expiresAt } = await mintLinkToken(context.discordUserId, context.guildId));
  } catch (error) {
    // Caught HERE rather than in dispatch, which turns everything into
    // "couldn't reach the club app" -- true for a timeout, false for a
    // deliberate 409. Re-thrown otherwise so real faults keep their handling.
    if (!(error instanceof AlreadyLinkedError)) throw error;
    return ephemeral(
      'Your Discord account is already connected to a club account.\n\n' +
        'Use **/unlink** first if you want to connect a different one. ' +
        'To move your club account to a different Discord account, run **/link** ' +
        'from that account instead.'
    );
  }

  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));

  return {
    type: 4,
    data: {
      // EPHEMERAL IS LOAD-BEARING, not politeness. This message contains a
      // single-use credential: anyone who could read it could click it first
      // and attach their own club account to this Discord account.
      flags: 64,
      embeds: [
        {
          title: 'Connect your club account',
          color: CLUB_RED,
          description:
            'Open the link below and sign in the way you normally do on the club website. ' +
            'Your roles here are set from your club account once the two are connected.\n\n' +
            `The link works once, and expires in ${minutes} minutes.`,
        },
      ],
      components: [
        {
          type: 1,
          components: [
            // A link button, not a URL in the body: Discord does not unfurl
            // button targets, so the token is not handed to the preview
            // crawler. That matters because an unfurl is a GET from Discord's
            // servers, and the /link page is built so a GET consumes nothing.
            { type: 2, style: 5, label: 'Connect my account', url },
          ],
        },
      ],
    },
  };
}

export async function handleUnlink(context: InteractionContext) {
  if (!context.discordUserId) {
    return ephemeral("Couldn't work out who you are on Discord. Try again.");
  }

  const unlinked = await deleteLink(context.discordUserId);
  if (!unlinked) {
    return ephemeral('Your Discord account is not connected to a club account.');
  }

  // The delete already tombstoned this account (00165's trigger), so the roles
  // WILL come off even if everything below fails. This is the fast path so the
  // member sees it happen now rather than at the next sweep.
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] /unlink: DISCORD_BOT_TOKEN is not set — roles left to the sweep');
    return ephemeral('Disconnected. Your roles will update shortly.');
  }

  let cleared = false;
  try {
    const { registry, auditChannelId } = await loadConfig();
    const api = new DiscordApi({ token });
    const outcomes = await syncMemberEverywhere(
      api,
      registry,
      context.discordUserId,
      null,
      // Including the membership role they picked. /unlink is the member saying
      // they are done with the club account; leaving @Internal on would leave
      // the member-only channels open to somebody the app no longer knows.
      { revokeMembership: true }
    );
    cleared = outcomes.every((o) => !o.forbidden && !o.failed);
    // Only when the strip actually succeeded everywhere. A 403 here is the
    // ordinary answer for an exec, and clearing the tombstone on one would
    // discard the revocation permanently.
    if (cleared) await clearRevocations([context.discordUserId]);

    // /unlink strips roles here rather than through POST /sync-member, so it
    // has to write its own entry — otherwise the one action a member can take
    // to remove themselves is the one action the log never records.
    await postAuditEntry(api, auditChannelId, {
      kind: 'member',
      reason: 'unlinked',
      discordUserIds: [context.discordUserId],
      summary: summaryFromOutcomes(context.discordUserId, outcomes),
    });
  } catch (error) {
    console.error('[bot] /unlink: immediate strip failed, left to the sweep:', error);
  }

  return ephemeral(
    cleared
      ? 'Disconnected, and your club roles have been removed.'
      : // Deliberately not "some roles could not be removed": the tombstone
        // means it is a matter of when, not whether.
        'Disconnected. Your roles will update shortly.'
  );
}

/**
 * /forcelink: attach a Discord account to a club member, on an officer's word.
 *
 * THE DISCORD-SIDE DOOR TO THE CONSOLE'S FORCE-LINK PANEL. The app route
 * (apps/player/src/app/api/discord/force-link/route.ts) owns every rule there
 * is: who may do this, which member the handle names, the shape of the write and
 * what goes in the audit log. This function collects three options, renders one
 * bespoke sentence per refusal, and then does the ONE thing the console cannot.
 *
 * WHAT THE CONSOLE CANNOT DO: move club roles now, in either direction. The
 * admin app holds no Discord token, so its half of this feature can only rely on
 * 00165's tombstone and the nightly sweep. The bot has a token, so it does both
 * halves while the officer waits: the displaced account is stripped, and the
 * arriving one is granted whatever the app says it should hold.
 *
 * Deferred; see DEFERRED_COMMANDS for why that is correct here and wrong for the
 * modal commands.
 */
export async function handleForceLink(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  if (!context.discordUserId) {
    // Should be unreachable, since Discord always identifies the caller. Checked
    // because this id is the OFFICER: the route resolves it to a club account and
    // asks that account for the capability, so a null here would ask it to check
    // the permissions of "null".
    return ephemeral("Couldn't work out who you are on Discord. Try again.");
  }

  const targetDiscordUserId = String(option(options, 'account') ?? '');
  const handle = String(option(options, 'member') ?? '');
  const reason = String(option(options, 'reason') ?? '');

  const result = await forceLinkDiscordAccount({
    discordUserId: context.discordUserId,
    targetDiscordUserId,
    handle,
    reason,
  });

  if (!result.ok) {
    // MATCHED AGAINST A CLOSED SET, never printed. The refusal is a code the
    // route chose from a union; turning it into a sentence is this file's job,
    // and interpolating whatever arrived would put an app response body into a
    // Discord message.
    switch (result.refusal) {
      case 'not_linked':
        // THE CALLER'S OWN LINK, not the target's. The route resolves the
        // officer by their Discord id, so an officer who is not linked has no
        // club account for the capability check to ask about. Said in full
        // because the first instinct on reading "not linked" here is to assume
        // this command can repair it, and it cannot: it is the one case
        // /forcelink can never fix.
        return ephemeral(
          'Run `/link` on your own account first. This command acts as **your** club ' +
            'account, and this Discord account is not connected to one yet, so there is ' +
            'no officer for the club to check.\n\n' +
            'It cannot fix your own account either. Use `/link`, or ask another exec to ' +
            'run this for you, or use the admin console, which signs you in through a ' +
            'browser instead. Nothing was changed.'
        );
      case 'no_such_member':
        return ephemeral(
          'No club member has that handle. The suggestions only cover members who are on ' +
            'the club ladder, so somebody pending approval or hidden from it is never ' +
            'offered: type their handle in full instead of picking it. Nothing was changed.'
        );
      case 'already_linked_elsewhere':
        return ephemeral(
          // POINTED AT /forceunlink, AND IT USED TO POINT AT THE CONSOLE. There
          // is no unlink control there: the console's Discord panel
          // (apps/admin/src/app/players/[id]/discord-link-panel.tsx) links and
          // does not unlink, so this sentence sent officers looking for a
          // button that has never existed.
          'That Discord account is already connected to a different club member. ' +
            'Disconnect it from that member first with `/forceunlink`, then run this ' +
            'again. Nothing was changed.'
        );
      case 'no_reason':
        return ephemeral(
          'Say why this is being done by hand. It is recorded in the club audit log beside ' +
            'your name, and that record is what makes linking an account on somebody ' +
            "else's behalf acceptable. Nothing was changed."
        );
      default:
        // 'not_permitted', and anything a newer app adds. Deliberately says
        // nothing about which check failed: a banned exec and a member who never
        // had the capability get the same sentence.
        return ephemeral(
          'You do not have permission to connect Discord accounts to club members. An ' +
            'admin grants that in the console under Permissions. Nothing was changed.'
        );
    }
  }

  const { displacedDiscordUserId, memberName, alreadyThatAccount } = result;
  const member = memberName ?? 'that member';
  const account = `<@${targetDiscordUserId}>`;

  // The link is already written, and 00165's trigger has already tombstoned the
  // displaced account, so its roles WILL come off at the next sweep whatever
  // happens below. This is the fast path, exactly as /unlink's is.
  let cleared = false;
  // Whether the ARRIVING account's roles actually landed. False until a sync
  // says otherwise, so every path that never reached one promises "shortly"
  // rather than claiming work it did not do.
  let synced = false;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] /forcelink: DISCORD_BOT_TOKEN is not set, roles left to the sweep');
  } else {
    try {
      const { registry, auditChannelId } = await loadConfig();
      const api = new DiscordApi({ token });

      // ONLY THE DISPLACED ACCOUNT IS TOUCHED BY THIS CALL, and only to strip
      // it: syncMemberEverywhere with a null desired state is a strip by
      // definition. The ARRIVING account is granted further down instead of
      // here, because a grant needs the member's desired role set and that comes
      // from the app's linked-members read, which this call does not make.
      const outcomes = displacedDiscordUserId
        ? await syncMemberEverywhere(api, registry, displacedDiscordUserId, null, {
            // Including the membership role, on /unlink's argument: an account
            // the app no longer knows must not keep the role that opens the
            // member-only channels.
            revokeMembership: true,
          })
        : [];

      cleared = outcomes.every((o) => !o.forbidden && !o.failed);
      // ONLY for the displaced account, and only when the strip really landed
      // everywhere. A 403 is the ordinary answer for an exec, and clearing a
      // tombstone on one would discard the revocation permanently.
      //
      // NEVER FOR THE ARRIVING ACCOUNT: the trigger's second half already
      // deleted any tombstone naming it (00165), so there is nothing to clear,
      // and clearing on its behalf here would be a second copy of a rule the
      // database already enforces.
      if (displacedDiscordUserId && cleared) await clearRevocations([displacedDiscordUserId]);

      // ONE ENTRY, MENTIONS ONLY. audit.ts's rule is Discord ids rendered as
      // mentions and nothing else: no player ids, no real names, no handles. The
      // officer's ephemeral reply above may name the member because only they
      // read it; an audit channel inherits whatever permissions somebody set on
      // it.
      //
      // The summary is keyed to the DISPLACED account, because these outcomes are
      // its role removals. Keying it to the arriving account would render the
      // removals beside the account that just gained a link.
      await postAuditEntry(api, auditChannelId, {
        kind: 'member',
        reason: 'linked',
        discordUserIds: displacedDiscordUserId
          ? [targetDiscordUserId, displacedDiscordUserId]
          : [targetDiscordUserId],
        summary: summaryFromOutcomes(displacedDiscordUserId ?? targetDiscordUserId, outcomes),
      });

    } catch (error) {
      // Logged and continued, for /unlink's reason: the write is done and the
      // tombstone guarantees the strip, so failing the command here would invite
      // an officer to run it again against a link that is already correct.
      console.error('[bot] /forcelink: immediate strip failed, left to the sweep:', error);
    }

    // NOW THE ARRIVING ACCOUNT: the half the console cannot do either, and the
    // half this command used to leave to the nightly sweep. It is a second
    // pass rather than an argument to the strip above because it needs the
    // app's linked-members read to know what the member should hold.
    //
    // RUN EVEN WHEN NOTHING MOVED. An officer re-running /forcelink on an
    // account that is already linked is the ordinary way somebody says "their
    // roles are missing", and that is exactly the case a conditional here
    // would skip.
    //
    // OUTSIDE THE STRIP'S try, NOT NESTED IN IT. This block used to sit inside
    // it, which quietly broke the promise the paragraph above makes: a throw
    // anywhere in the strip jumped to that catch and skipped the grant
    // entirely, so the one case an officer most often runs this for, a member
    // whose roles are missing, was also a case where a bad strip meant no
    // grant. The two halves touch DIFFERENT accounts and share no state:
    // syncMembersNow loads its own config and builds its own client, so it
    // needs nothing the strip above computed. Neither may cancel the other.
    //
    // ITS OWN catch, for the same reason it is its own block: the strip's
    // reports a failed STRIP, and filing a failed grant under it would point
    // whoever reads the log at the wrong account. Swallowed all the same, on
    // the reason the strip's gives: the link is written and 00165's tombstone
    // guarantees the strip, so no hiccup here may tell the officer that the
    // force-link failed.
    try {
      const {
        summary,
        api: syncApi,
        auditChannelId: syncAuditChannelId,
      } = await syncMembersNow([targetDiscordUserId]);
      // Clean means nothing was refused and nothing failed. NOT that anything
      // was added: a member whose roles were already correct adds zero, and
      // saying "shortly" at them would be inventing a problem.
      synced = summary.forbidden === 0 && summary.failed === 0;

      // A SECOND ENTRY, never merged into the one above. That summary is rolled
      // up from a single account's outcomes and this one is a SweepSummary;
      // there is no helper that adds the two together, and two acts on two
      // accounts read more honestly as two entries in any case.
      await postAuditEntry(syncApi, syncAuditChannelId, {
        kind: 'member',
        reason: 'linked',
        discordUserIds: [targetDiscordUserId],
        summary,
      });
    } catch (error) {
      console.error('[bot] /forcelink: role grant failed, left to the sweep:', error);
    }
  }

  if (alreadyThatAccount) {
    return ephemeral(
      `${account} was already connected to **${member}**. Nothing moved, and ` +
        (synced
          ? 'their club roles have been applied.'
          : // Deliberately not "their roles could not be applied": the app is the
            // authority on what they hold and the sweep reapplies it, so this is
            // a matter of when, not whether.
            'their club roles will appear shortly.')
    );
  }

  const opening =
    `**${member}** is now connected to ${account}. ` +
    (synced
      ? 'Their club roles have been applied.'
      : 'Their club roles will appear shortly.');
  if (!displacedDiscordUserId) return ephemeral(opening);

  return ephemeral(
    `${opening}\n\n` +
      (cleared
        ? `<@${displacedDiscordUserId}> was disconnected, and its club roles have been removed.`
        : // Deliberately not "some roles could not be removed": the tombstone
          // means it is a matter of when, not whether.
          `<@${displacedDiscordUserId}> was disconnected. Its club roles will be removed shortly.`)
  );
}

/**
 * /forceunlink: disconnect ANOTHER member's Discord account, on an officer's
 * word.
 *
 * /unlink with the caller and the target separated. The app route
 * (apps/player/src/app/api/discord/force-unlink/route.ts) owns every rule: who
 * may do this, whether that account is connected to anybody, and the audit row.
 * This function collects two options, renders one bespoke sentence per refusal,
 * and then does the ONE thing the console cannot: take the club roles off now.
 *
 * THE ORDER IS THE SAFETY ARGUMENT, AND IT IS THE ROUTE'S HALF THAT GOES FIRST.
 * By the time this function gets to Discord the row is already deleted and
 * 00165's trigger has tombstoned the account, so the roles come off at the next
 * sweep whatever happens below. Reversed, a strip that landed before a delete
 * that failed would be undone by the very next sweep.
 *
 * Deferred; see DEFERRED_COMMANDS.
 */
export async function handleForceUnlink(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  if (!context.discordUserId) {
    // Should be unreachable, since Discord always identifies the caller.
    // Checked because this id is the OFFICER: the route resolves it to a club
    // account and asks that account for the capability, so a null here would
    // ask it to check the permissions of "null".
    return ephemeral("Couldn't work out who you are on Discord. Try again.");
  }

  const targetDiscordUserId = String(option(options, 'member') ?? '');
  const reason = String(option(options, 'reason') ?? '');

  const result = await forceUnlinkDiscordAccount({
    discordUserId: context.discordUserId,
    targetDiscordUserId,
    reason,
  });

  if (!result.ok) {
    // MATCHED AGAINST A CLOSED SET, never printed, exactly as /forcelink's are.
    switch (result.refusal) {
      case 'not_linked':
        // THE CALLER'S OWN LINK, not the target's. The route resolves the
        // officer by their Discord id, so an officer who is not linked has no
        // club account for the capability check to ask about.
        return ephemeral(
          'Run `/link` on your own account first. This command acts as **your** club ' +
            'account, and this Discord account is not connected to one yet, so there is ' +
            'no officer for the club to check. Nothing was changed.'
        );
      case 'target_not_linked':
        // Also the answer when two officers race the same account: the loser's
        // delete matched no rows. Claiming success there would put an audit row
        // under the wrong name.
        return ephemeral(
          'That Discord account is not connected to any club member, so there was nothing ' +
            'to disconnect. Nothing was changed.'
        );
      case 'no_reason':
        return ephemeral(
          'Say why this is being done by hand. It is recorded in the club audit log beside ' +
            "your name, and that record is what makes disconnecting somebody else's account " +
            'acceptable. Nothing was changed.'
        );
      default:
        // 'not_permitted', and anything a newer app adds. Deliberately says
        // nothing about which check failed: a banned exec and a member who
        // never had the capability get the same sentence.
        return ephemeral(
          'You do not have permission to disconnect Discord accounts from club members. An ' +
            'admin grants that in the console under Permissions. Nothing was changed.'
        );
    }
  }

  const member = result.memberName ?? 'that member';
  const account = `<@${targetDiscordUserId}>`;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] /forceunlink: DISCORD_BOT_TOKEN is not set, roles left to the sweep');
    return ephemeral(
      `${account} is disconnected from **${member}**. Their club roles will be removed shortly.`
    );
  }

  // False until a strip says otherwise, so every path that never reached one
  // promises "shortly" rather than claiming work it did not do.
  let cleared = false;
  try {
    const { registry, auditChannelId } = await loadConfig();
    const api = new DiscordApi({ token });

    // A NULL DESIRED STATE IS A STRIP BY DEFINITION, and the membership role
    // goes with it on /unlink's argument: an account the app no longer knows
    // must not keep the role that opens the member-only channels.
    const outcomes = await syncMemberEverywhere(api, registry, targetDiscordUserId, null, {
      revokeMembership: true,
    });

    // A MEMBER WHO HAS LEFT THE SERVER COUNTS AS CLEAN, and that is deliberate
    // rather than accidental: syncMemberInGuild reports them as `absent` with
    // nothing forbidden and nothing failed. The officer asked for the link to
    // go, the link is gone, and there were no roles left to take off somebody
    // who is not in the guild. Reporting that as a failure would be a lie about
    // the only half that mattered.
    cleared = outcomes.every((o) => !o.forbidden && !o.failed);
    // ONLY when the strip really landed everywhere. A 403 is the ordinary
    // answer for an exec whose top role outranks the bot, and clearing the
    // tombstone on one would discard the revocation permanently.
    if (cleared) await clearRevocations([targetDiscordUserId]);

    // MENTIONS ONLY, never the member's name. audit.ts's rule is Discord ids
    // rendered as mentions and nothing else; the officer's ephemeral reply may
    // name the member because only they read it, but an audit channel inherits
    // whatever permissions somebody set on it.
    //
    // No new AuditEvent variant: MEMBER_TITLES.unlinked is "Account unlinked",
    // which is exactly what happened, and audit.ts already gives a clean unlink
    // club red while letting a failed or refused one outrank that colour.
    await postAuditEntry(api, auditChannelId, {
      kind: 'member',
      reason: 'unlinked',
      discordUserIds: [targetDiscordUserId],
      summary: summaryFromOutcomes(targetDiscordUserId, outcomes),
    });
  } catch (error) {
    // Logged and continued, on /unlink's reason: the delete is done and the
    // tombstone guarantees the strip, so failing the command here would invite
    // the officer to run it again against a row that no longer exists, which
    // would now answer target_not_linked and read as a broken command.
    console.error('[bot] /forceunlink: immediate strip failed, left to the sweep:', error);
  }

  return ephemeral(
    cleared
      ? `${account} is disconnected from **${member}**, and their club roles have been removed.`
      : // Deliberately not "some roles could not be removed": the tombstone
        // means it is a matter of when, not whether.
        `${account} is disconnected from **${member}**. Their club roles will be removed shortly.`
  );
}

/**
 * /forceupdate: re-apply the club's current view of ONE member's roles, now.
 *
 * THE ONE-MEMBER FORM OF THE MANUAL SWEEP, not a second sweep. The everyone
 * path is POST /sync with {"trigger":"manual"}, which holds the sweepInFlight
 * guard and reloads the config; this command deliberately has no such mode.
 *
 * NOTHING IS WRITTEN TO THE CLUB'S RECORDS, which is why it takes no reason and
 * why every failure below is swallowed. The act is convergent: it makes Discord
 * agree with what the app already says, so there is never anything half-done,
 * and the worst case is an officer running a convergent command twice.
 *
 * Deferred; see DEFERRED_COMMANDS.
 */
export async function handleForceUpdate(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  if (!context.discordUserId) {
    // The OFFICER, for handleForceUnlink's reason.
    return ephemeral("Couldn't work out who you are on Discord. Try again.");
  }

  const targetDiscordUserId = String(option(options, 'member') ?? '');

  const result = await forceSyncMember({
    discordUserId: context.discordUserId,
    targetDiscordUserId,
  });

  if (!result.ok) {
    switch (result.refusal) {
      case 'not_linked':
        return ephemeral(
          'Run `/link` on your own account first. This command acts as **your** club ' +
            'account, and this Discord account is not connected to one yet, so there is ' +
            'no officer for the club to check. Nothing was changed.'
        );
      case 'target_not_linked':
        // THE LOAD-BEARING REFUSAL. An id the app does not know is read by the
        // sync as "strip everything", so running it here would be a silent full
        // strip rather than the refresh the officer asked for.
        return ephemeral(
          'That Discord account is not connected to any club member, so there are no club ' +
            'roles to apply. Connect it with `/forcelink` first. Nothing was changed.'
        );
      default:
        return ephemeral(
          "You do not have permission to change other members' club roles. An admin grants " +
            'that in the console under Permissions. Nothing was changed.'
        );
    }
  }

  const member = result.memberName ?? 'that member';
  const account = `<@${targetDiscordUserId}>`;

  // DECLARED OUT HERE, because syncMembersNow throws outright when there is no
  // bot token and the catch below swallows it. Read inside the try only, so the
  // reply on that path promises "shortly" instead of dereferencing a summary
  // that was never produced.
  let synced = false;
  let added = 0;
  let removed = 0;
  try {
    // ITS OWN CONFIG AND ITS OWN CLIENT: syncMembersNow loads both, so unlike
    // the strip in /forceunlink there is nothing to build here first.
    const { summary, api, auditChannelId } = await syncMembersNow([targetDiscordUserId]);

    // Clean means nothing was refused and nothing failed. NOT that anything was
    // added: a member whose roles were already correct adds zero, and saying
    // "shortly" at them would be inventing a problem.
    synced = summary.forbidden === 0 && summary.failed === 0;
    added = summary.added;
    removed = summary.removed;

    // THE SUMMARY GOES STRAIGHT THROUGH. syncMembersNow already returns a
    // SweepSummary; summaryFromOutcomes is for the SyncOutcome[] path that
    // /unlink and /forceunlink take, and crossing the two is the easy mistake
    // here. MEMBER_TITLES.resynced ("Roles resynced") is the title, and nothing
    // has ever actually emitted it: POST /sync-member falls back to that reason
    // when the caller names no other, and its one caller (the link flow's
    // syncDiscordMembers) always passes 'linked'.
    await postAuditEntry(api, auditChannelId, {
      kind: 'member',
      reason: 'resynced',
      discordUserIds: [targetDiscordUserId],
      summary,
    });
  } catch (error) {
    console.error('[bot] /forceupdate: resync failed, left to the sweep:', error);
  }

  if (!synced) {
    // Deliberately not "their roles could not be applied": the app is the
    // authority on what they hold and the nightly sweep reapplies it, so this
    // is a matter of when, not whether.
    return ephemeral(
      `**${member}** (${account}) could not be brought fully into line just now. Their club ` +
        'roles will be corrected shortly.'
    );
  }

  return ephemeral(
    added === 0 && removed === 0
      ? `**${member}** (${account}) already had the right club roles. Nothing to change.`
      : `**${member}** (${account}) is up to date: ${added} role${added === 1 ? '' : 's'} added, ` +
          `${removed} removed.`
  );
}

/**
 * The picker behind /forceunlink and /forceupdate: connected accounts, by
 * member name, sourced from the LINK ROWS rather than from guild membership.
 *
 * A SEPARATE PROVIDER FROM handleProfileAutocomplete, and it has to be. That
 * one reads the club ladder, which is the privacy-equivalent source /profile is
 * built on, and the ladder excludes pending, suspended and hidden members and
 * carries no Discord ids at all. The member these two commands exist for is
 * very often exactly one of those.
 *
 * EVERY FAILURE IS AN EMPTY LIST, NEVER AN ERROR, and there are two independent
 * reasons. An autocomplete has no user-visible failure mode: a throw renders as
 * "loading options failed" with nothing in the log saying why. And an error on
 * a REFUSAL would itself confirm that rows exist, which is precisely the
 * disclosure the route's capability check is there to prevent. So it is logged
 * and answered with nothing.
 *
 * THE CAPABILITY CHECK IS NOT REPEATED HERE. The route does it, and a second
 * copy in the bot would be a second source of truth for the same boundary.
 */
export async function handleLinkedAccountAutocomplete(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const empty = { type: 8, data: { choices: [] as { name: string; value: string }[] } };
  if (!context.discordUserId) return empty;

  // THE FOCUSED OPTION, not one matched by name, for the reason
  // handleProfileAutocomplete's own comment gives: matching by name answers the
  // wrong slot the moment a command grows a second autocompleting option.
  const focused = options?.find((o) => o.focused);

  try {
    const result = await fetchLinkedAccounts({
      discordUserId: context.discordUserId,
      query: String(focused?.value ?? ''),
    });
    if (!result.ok) return empty;

    return {
      type: 8,
      data: {
        // Capped again here even though the route caps too. Discord rejects the
        // WHOLE response above 25 rather than the surplus rows, so a picker
        // that suggests nothing at all is what a drifting route would cost.
        choices: result.choices.slice(0, 25).map((choice) => ({
          name: choice.name.slice(0, 100),
          value: choice.value,
        })),
      },
    };
  } catch (error) {
    console.error('[bot] linked-account autocomplete failed:', error);
    return empty;
  }
}

/**
 * /setup — make this server's roles exist, and tell the app their ids.
 *
 * The problem it solves is dull but real: wiring a guild by hand means copying
 * nine snowflakes out of Discord's UI into SQL without transposing a digit, and
 * a transposed digit is not a syntax error. It is a role that silently never
 * applies.
 *
 * Idempotent by construction. It matches on the NORMALISED role name, so a club
 * that already has "Session Staff" keeps it rather than gaining a second one,
 * and running it twice is a no-op. Nothing is ever deleted or renamed.
 *
 * Runs AFTER a deferred acknowledgement — see DEFERRED_COMMANDS — so it is free
 * to take as long as nine role creations need.
 */
/**
 * Why /setup or /config was turned away, in words. The bot runs in any server;
 * these two change the club's own setup, so they answer to the club's records.
 */
function managerRefusalText(refusal: ManagerRefusal): string {
  if (refusal === 'not_linked') {
    return 'This changes the club\'s bot setup, so it needs a club exec account. Connect yours with /link first.';
  }
  if (refusal === 'not_permitted') {
    return 'This changes the club\'s bot setup. Only club execs who can change the club\'s settings can run it.';
  }
  return 'This server is not connected to the club, so its settings cannot be changed from here. A club exec connects a server with /setup.';
}

export async function handleSetup(
  options: CommandOption[] | undefined,
  context: InteractionContext
) {
  const { guildId } = context;
  // dm_permission: false means Discord should never deliver this without a
  // guild. Checked anyway: the alternative is a confusing crash if that ever
  // changes, and the whole command is meaningless without one.
  if (!guildId) return ephemeral('Run this in the server you want to set up.');

  // BEFORE ANY ROLE IS MADE. Discord admin rights in this server say nothing
  // about the club; the club's records decide (managerRefusalText).
  if (!context.discordUserId) return ephemeral(managerRefusalText('not_linked'));
  const manager = { discordUserId: context.discordUserId, guildId };
  const setupRefusal = await checkDiscordManager(manager, { setup: true });
  if (setupRefusal) return ephemeral(managerRefusalText(setupRefusal));

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return ephemeral('The bot is not configured with a token.');

  const api = new DiscordApi({ token });

  let botPosition: number;
  let existing: DiscordRole[];
  try {
    [botPosition, existing] = await Promise.all([
      api.getOwnRolePosition(guildId),
      api.listGuildRoles(guildId),
    ]);
  } catch (error) {
    console.error('[bot] setup could not read roles:', error);
    // Do NOT assert a cause here. Two different calls run above, and reading
    // roles needs no permission at all, so "I need Manage Roles" was wrong for
    // every failure that was not a 403 -- it once sent an admin to re-grant a
    // permission the bot already held, because a malformed request 400'd.
    // /setup is admin-only and this reply is ephemeral, so the real reason is
    // safe to show and is the only thing that makes it debuggable.
    return ephemeral(
      "I could not read this server's roles.\n" +
        `Reason: \`${error instanceof Error ? error.message : String(error)}\`\n` +
        'If that mentions 403, I am missing **Manage Roles**.'
    );
  }

  const plan = planSetup(existing, botPosition);

  // Create what is missing, one at a time rather than in parallel: role
  // creation shares a per-guild rate limit bucket, and nine concurrent POSTs
  // just means nine 429s and a slower result.
  const created: MatchedRole[] = [];
  const failed: { role: ManagedRole; reason: string }[] = [];
  for (const role of plan.toCreate) {
    try {
      const made = await api.createGuildRole(guildId, DISPLAY_NAMES[role]);
      created.push({ role, id: made.id, name: made.name });
    } catch (error) {
      // Most likely a 403: no Manage Roles, or the bot's own role is at the
      // very bottom. Collected rather than thrown so one refusal does not
      // discard the eight that worked.
      failed.push({ role, reason: String(error) });
    }
  }

  const resolved = [...plan.matched, ...created];
  if (resolved.length === 0) {
    return ephemeral(
      'I could not resolve or create any roles. Check that I have **Manage Roles**, ' +
        'and that my own role is not at the bottom of the list.'
    );
  }

  const roles: Record<string, string> = {};
  for (const r of resolved) roles[r.role] = r.id;

  // Discord sends a CHANNEL option as the channel's id.
  const auditChannel = option(options, 'audit_channel');
  const auditChannelId = typeof auditChannel === 'string' ? auditChannel : undefined;

  try {
    await writeGuildConfig({
      guildId,
      discordUserId: manager.discordUserId,
      roles,
      ...(auditChannelId ? { auditChannelId } : {}),
    });
  } catch (error) {
    console.error('[bot] setup could not save config:', error);
    // The roles now exist in Discord but the app does not know their ids. Say
    // so plainly: re-running is safe and is the fix, because the roles it just
    // made will match by name on the next pass.
    return ephemeral(
      'I created the roles, but could not save them to the club app. ' +
        'Run /setup again in a moment — it will adopt the roles it just made.'
    );
  }

  // The bot re-reads config on a 60s cache; after a deliberate write there is
  // no reason to serve a stale map for the next minute.
  invalidateConfigCache();

  // AND THE CATALOGUE OF EVERY MENTIONABLE ROLE, for the console's notify picker
  // (00229). Free here: `existing` was already fetched above and the roles just
  // created are already in hand, so this costs no extra Discord call.
  //
  // AFTER writeGuildConfig AND NOT BEFORE. `discord_server_roles.guild_id` has a
  // foreign key onto `discord_guilds`, and on a first-ever /setup that row does
  // not exist until the write above lands.
  //
  // FAILURE IS LOGGED AND SWALLOWED, unlike the write above. The role map is what
  // /setup exists to produce and a half-configured guild has to be reported; the
  // catalogue is a convenience the five minute tick refills on its own, and
  // telling an admin their /setup failed over it would send them re-running a
  // command that already worked.
  try {
    await writeServerRoleCatalog({
      guildId,
      roles: [
        ...offerableRoles(existing, guildId),
        // The nine just created, which `existing` predates. No position: it is
        // not read back from createGuildRole and nothing depends on it, so the
        // column stays NULL until the next tick fills it in rather than carrying
        // an invented 0 that would sort them to the bottom.
        ...created.map((c) => ({ roleId: c.id, name: c.name })),
      ],
    });
  } catch (error) {
    console.error('[bot] setup could not save the role catalogue:', error);
  }

  const lines: string[] = [];
  if (created.length) {
    lines.push(`**Created ${created.length}:** ${created.map((c) => `<@&${c.id}>`).join(' ')}`);
  }
  if (plan.matched.length) {
    lines.push(
      `**Adopted ${plan.matched.length} existing:** ${plan.matched.map((m) => `<@&${m.id}>`).join(' ')}`
    );
  }
  for (const a of plan.ambiguous) {
    lines.push(
      `⚠️ **${a.role}** — ${a.names.length} roles share that name (${a.names.join(', ')}). ` +
        'Rename or delete the duplicates, then run /setup again.'
    );
  }
  for (const u of plan.unusable) {
    lines.push(
      u.reason === 'above_bot'
        ? `⚠️ **${u.name}** sits above my own role, so I cannot assign it. Move my role higher.`
        : `⚠️ **${u.name}** is managed by Discord and cannot be assigned.`
    );
  }
  for (const f of failed) {
    lines.push(`❌ Could not create **${DISPLAY_NAMES[f.role]}** — check my Manage Roles permission.`);
  }

  if (auditChannelId) {
    // Said explicitly because the two failure modes look identical from inside
    // Discord: no audit log at all, and an audit log going somewhere the reader
    // cannot see. Make it a private channel -- the entries mention the members
    // whose roles changed.
    lines.push(
      `**Audit log:** <#${auditChannelId}> — I need **View Channel** and **Send Messages** there.`
    );
  }

  // The single most common way this bot appears to work while doing nothing:
  // every role it manages sits above it, so every assignment 403s. Said up
  // front, every time, rather than left to be discovered by a silent sweep.
  lines.push(
    '',
    '**Next:** drag my role in Server Settings → Roles so it sits **above** every role listed here. ' +
      'Discord will not let me assign a role positioned above my own.'
  );

  return reply({
    title: 'Club roles configured',
    description: lines.join('\n'),
    color: failed.length || plan.ambiguous.length || plan.unusable.length ? 0xf1c40f : 0x2ecc71,
  });
}


// ---------------------------------------------------------------------------
// SELF-SERVE PING ROLES
//
// Buttons rather than emoji reactions, and that is a hard constraint rather than
// a preference. Reaction roles need MESSAGE_REACTION_ADD, which is a GATEWAY
// event delivered over a WebSocket the bot has to hold open. This bot is
// HTTP-interactions only -- Discord POSTs to it and it answers -- so it never
// sees a reaction at all. Buttons arrive through the same interaction endpoint
// as slash commands, which is why they work here and reactions could not.
//
// The custom_id carries the role id, and the toggle handler REVALIDATES it
// against the app rather than trusting it. See the note on the app route: a
// picker message posted in September still has September's buttons in January.
// ---------------------------------------------------------------------------

/** Prefix on every picker button's custom_id. `selfrole:<roleId>`. */
const SELF_ROLE_PREFIX = 'selfrole:';

/** Discord: 5 buttons per action row, 5 rows per message. */
const BUTTONS_PER_ROW = 5;

function pickerComponents(roles: { roleId: string; label: string; emoji: string | null }[]) {
  const rows = [];
  for (let i = 0; i < roles.length; i += BUTTONS_PER_ROW) {
    rows.push({
      type: 1, // ACTION_ROW
      components: roles.slice(i, i + BUTTONS_PER_ROW).map((r) => ({
        type: 2, // BUTTON
        style: 2, // SECONDARY -- a ping role is not a destructive or primary act
        label: r.label,
        custom_id: `${SELF_ROLE_PREFIX}${r.roleId}`,
        // Discord wants a custom emoji as {id}, a unicode one as {name}. Sent
        // the wrong way round it rejects the whole message, so the shape is
        // decided by whether the string looks like `name:id`.
        ...(r.emoji ? { emoji: parseEmoji(r.emoji) } : {}),
      })),
    });
  }
  return rows;
}

function parseEmoji(emoji: string) {
  const custom = /^<?a?:?([\w~]+):(\d+)>?$/.exec(emoji);
  if (custom) return { name: custom[1], id: custom[2], animated: emoji.startsWith('<a:') };
  return { name: emoji };
}

// ---------------------------------------------------------------------------
// /guidepost
// ---------------------------------------------------------------------------
//
// THE MESSAGE FOR PEOPLE WHO DO NOT KNOW THERE ARE COMMANDS. Everything this
// bot offers a member is behind a slash command they have to know the name of,
// which is fine for the people who read the announcement and invisible to
// everyone else. This posts one public message whose buttons open the three
// flows a new member actually needs.
//
// STYLE IS LOAD-BEARING. These buttons are style 1 and style 2 with a
// custom_id, never style 5. Style 5 is the LINK style used in handleLink; it
// requires a url and cannot carry a custom_id, so a style 5 button here would
// look right, render happily and emit no interaction at all when clicked.
//
// The custom_id suffix is a FIXED KEYWORD rather than configuration, which is
// what makes the message safe to leave in a channel forever: unlike a picker
// button there is nothing to revalidate, so a guide:link clicked in a year does
// exactly what it does today.

/** Prefix on every guide button's custom_id. `guide:<keyword>`. */
const GUIDE_PREFIX = 'guide:';

/**
 * The three guide buttons, ONE DEFINITION EACH.
 *
 * Factored out here rather than written inline below because a console message
 * may now carry a SUBSET of this row (00228), and a second copy of a button for
 * the one-button case is how a click on it stops being answered. Every caller
 * hands out the same object, so a narrow set's button is the guide row's button.
 */
const GUIDE_BUTTONS = {
  link: {
    type: 2, // BUTTON
    style: 1, // PRIMARY -- the one thing to do first
    label: 'Connect my account',
    custom_id: `${GUIDE_PREFIX}link`,
  },
  bug: {
    type: 2,
    style: 2, // SECONDARY
    label: 'Report a bug',
    custom_id: `${GUIDE_PREFIX}bug`,
  },
  feedback: {
    type: 2,
    style: 2,
    label: 'Send feedback',
    custom_id: `${GUIDE_PREFIX}feedback`,
  },
};

export function guideComponents() {
  return [
    {
      type: 1, // ACTION_ROW
      components: [GUIDE_BUTTONS.link, GUIDE_BUTTONS.bug, GUIDE_BUTTONS.feedback],
    },
  ];
}

/**
 * The buttons a NAMED SET means, for a message the console queued (00228).
 *
 * An outbox row carries the NAME of a set and never component JSON, because the
 * insert path is a server action and every field on one is client-controlled. So
 * the resolution from a name to real buttons happens exactly here, in the file
 * that also holds the handlers answering them.
 *
 * FOUR NAMES, AND THREE OF THEM ARE SUBSETS OF THE FIRST. `guide` is the whole
 * row /guidepost posts; `link`, `bug` and `feedback` are each one button OF THAT
 * ROW, because each club guide message is about one task and a message about
 * connecting an account should not carry the bug form. NO NEW HANDLER EXISTS OR
 * IS NEEDED: the custom_ids are the same `guide:` ids, so isGuideButton and
 * handleGuideButton already answer a click on a narrow set's button.
 *
 * AN UNKNOWN NAME IS NULL, NOT A THROW, and that is the compatibility property
 * rather than laziness: a row written by a newer console and drained by an older
 * bot image would otherwise throw inside payloadFor and fail a club message
 * three times over. This way it loses its buttons and still posts its words. It
 * is what makes the migration and the two images deployable in any order.
 *
 * `undefined` is the same case, and it is the version skew in the other
 * direction: a new bot image against an old relay route gets no `buttonSet`
 * field at all.
 */
export function componentsForButtonSet(name: string | null | undefined) {
  if (name === 'guide') return guideComponents();
  if (name === 'link' || name === 'bug' || name === 'feedback') {
    return [{ type: 1, components: [GUIDE_BUTTONS[name]] }];
  }
  return null;
}

function handleGuidePost(context: InteractionContext) {
  if (!context.guildId) {
    return ephemeral('Run this in a server, not a DM.');
  }

  // PUBLIC on purpose, and the only public reply this command has. Like
  // /rolepicker post it OMITS flags rather than setting 0: a guide only the
  // exec who posted it can see is no guide at all.
  //
  // Not deferred, and MUST NOT be added to DEFERRED_COMMANDS: a deferred
  // acknowledgement fixes the reply's visibility as ephemeral, so deferring
  // this would hide it from the channel. There is nothing to defer for anyway,
  // because nothing here makes a network call.
  return {
    type: 4,
    data: {
      embeds: [
        {
          title: 'Getting started here',
          color: CLUB_RED,
          description:
            'You do not need to know any commands to use this. Click a button below and I will ' +
            'reply where only you can see it. Nobody else in this channel sees your reply.\n\n' +
            '**Connect my account** joins your Discord account to your club account on the ' +
            'website. Do this one first. Once the two are joined, your roles in this server are ' +
            "set for you from the club's own records, and the bot can show you your profile and " +
            'your sessions.\n\n' +
            '**Report a bug** opens a small form for anything on the website that is not ' +
            'working. Say what you were doing and what happened. It goes to the exec team.\n\n' +
            '**Send feedback** opens the same kind of form for ideas, requests, or anything else ' +
            'you want the club to hear.',
          // NOT decoration. A button carries no options, so the bug and
          // feedback buttons cannot offer the screenshot the slash commands do.
          // Saying so is the difference between a limitation and a member
          // filing a bug report about a missing feature.
          footer: {
            text:
              'To attach a screenshot, type /bug in the message box instead. This form takes ' +
              'words only for now.',
          },
        },
      ],
      components: guideComponents(),
    },
  };
}

/**
 * /discord: the invite, as a link and as a picture of the link.
 *
 * No guildId check, unlike /guidepost above: that one refuses in a DM because
 * its reply is a public channel message, and this reply is ephemeral and says
 * the same thing wherever it is run. The branch would be unreachable.
 */
function handleDiscordInvite(): BotResponse {
  // Built against APP_PUBLIC_URL because Discord's image proxy fetches from
  // OUTSIDE the cluster, so the in-cluster APP_API_URL would be unreachable.
  // Same split, and the same reason, as the profile card's URL.
  let qrUrl: string | null = null;
  try {
    const base = process.env.APP_PUBLIC_URL;
    if (base) qrUrl = new URL(DISCORD_QR_PATH, base).toString();
  } catch {
    // A missing or unparseable base is NOT fatal here, unlike /profile where
    // the URL is the entire answer. The link below is the useful half on its
    // own, so this degrades to a link rather than to an apology.
  }

  return ephemeralEmbed({
    title: 'Join the club Discord',
    color: CLUB_RED,
    description:
      // The URL is printed as text AS WELL AS encoded in the image, because the
      // two are not substitutes: a link can be copied into a message or a
      // slide, and a QR code cannot be copied into anything.
      `**${DISCORD_INVITE_URL}**\n\n` +
      'Scan the code, or send the link. It works on a poster, a slide or a phone screen.',
    ...(qrUrl ? { image: { url: qrUrl } } : {}),
    // Not decoration. An ephemeral reply vanishes on a client reload, and an
    // exec who cannot find it again reads that as the bot having lost the
    // message rather than as Discord doing what it always does.
    footer: { text: 'Only you can see this. Run /discord again any time.' },
  });
}

/**
 * /socials: the club's links, as the app says they stand.
 *
 * Not deferred: one GET with a 2.5s client timeout fits Discord's three
 * seconds. An unreachable app is caught HERE rather than left to dispatch(),
 * whose catch would answer "couldn't reach the club app" with no links at all;
 * the invite and the website page are still worth giving.
 */
async function handleSocials(): Promise<BotResponse> {
  let payload: SocialsPayload | null = null;
  try {
    payload = await fetchClubSocials();
  } catch (err) {
    console.error('[bot] /socials could not read the club links, answering with the fallback:', err);
  }

  let pageUrl: string | null = null;
  try {
    const base = process.env.APP_PUBLIC_URL;
    if (base) pageUrl = new URL('/socials', base).toString();
  } catch {
    // An unparseable base drops the website line, nothing else.
  }

  return socialsReply({ payload, inviteUrl: DISCORD_INVITE_URL, pageUrl });
}

// ---------------------------------------------------------------------------
// /config
// ---------------------------------------------------------------------------
//
// THE COMMAND THAT ANSWERS "IT IS SET UP BUT NOTHING POSTS".
//
// Every relay reads discord_settings, nothing wrote it, and there was no way to
// see that from anywhere: /setup wires roles and the audit channel and stops,
// the settings table is service-role only so no member-facing page can touch
// it, and an unconfigured relay is indistinguishable from a working one from
// outside — it runs on schedule, answers 200 and posts nothing. `show` is the
// half that closes that; the rest is the half that fixes it.
//
// Deferred (see DEFERRED_COMMANDS) because `channels` posts a message into
// every channel it was given before saving any of them, which is several round
// trips to Discord and then one to the app.

/**
 * Prove the bot can post in a channel by posting in it.
 *
 * THE ALTERNATIVE IS A RELAY THAT 403s FOREVER. Discord's channel picker offers
 * channels by what the CALLER can see, not by what the bot can write to, so a
 * perfectly reasonable choice can be one the bot has no Send Messages in —
 * and every relay treats a failed post as a transient error and tries again on
 * the next tick, quietly, for as long as the setting stands.
 *
 * Computing the bot's effective permissions from the role and overwrite lists
 * would be the tidy version and it is not worth it: it means fetching the
 * member, the roles and the channel, reimplementing Discord's overwrite
 * precedence, and being wrong in a way that is invisible. Sending one message
 * asks the only question that matters and gets Discord's own answer, and it
 * leaves the club a note in the channel saying what will appear there.
 */
async function proveCanPost(
  api: DiscordApi,
  channelId: string,
  label: string
): Promise<boolean> {
  return api.createMessage(channelId, {
    content: `**${label}** will be posted here.`,
    // No mentions, ever. This lands in a channel the club chose for a relay,
    // and a setup confirmation that pings a role would be a poor introduction.
    allowed_mentions: { parse: [] },
  });
}

async function handleConfig(
  options: CommandOption[] | undefined,
  context: InteractionContext
) {
  if (!context.guildId) return ephemeral('Run this in a server, not a DM.');
  // Every subcommand, /config show included: these are the club's settings,
  // so the club's records decide who sees and changes them, not Discord admin
  // rights in whichever server the command was typed in.
  if (!context.discordUserId) return ephemeral(managerRefusalText('not_linked'));
  const manager = { discordUserId: context.discordUserId, guildId: context.guildId };
  const configRefusal = await checkDiscordManager(manager);
  if (configRefusal) return ephemeral(managerRefusalText(configRefusal));
  const { name: sub, options: args } = subcommand(options);

  if (sub === 'show') {
    const { settings } = await fetchDiscordSettings();

    const line = (spec: (typeof ALL_SETTINGS)[number], asChannel: boolean) => {
      const value = settings[spec.key];
      if (!value) return `**${spec.label}** — not set, so ${spec.whenUnset}`;
      return `**${spec.label}** — ${asChannel ? `<#${value}>` : value}`;
    };
    // An ephemeral embed never notifies, so rendering the mention is safe.
    const roleLine = (spec: (typeof ALL_SETTINGS)[number]) => {
      const value = settings[spec.key];
      return value
        ? `**${spec.label}**: <@&${value}>`
        : `**${spec.label}**: not set, so ${spec.whenUnset}`;
    };

    return ephemeralEmbed({
      title: 'Discord relay settings',
      color: CLUB_RED,
      description: [
        CHANNEL_SETTINGS.map((spec) => line(spec, true)).join('\n'),
        '',
        ROLE_SETTINGS.map((spec) => roleLine(spec)).join('\n'),
        '',
        VALUE_SETTINGS.map((spec) => line(spec, false)).join('\n'),
      ].join('\n'),
      // SAID EVERY TIME, because it is the one thing about this feature that
      // surprises people: tournaments are the exception. That relay makes
      // Discord scheduled events rather than posting messages, so it has no
      // channel to set and runs whether or not anything above is filled in.
      footer: {
        text:
          'Tournaments become Discord events, not messages — that relay runs with no channel. ' +
          'Change any of these with /config channels, /config ping_roles or /config tournament.',
      },
    });
  }

  if (sub === 'channels') {
    const chosen = CHANNEL_SETTINGS.map((spec) => ({
      spec,
      channelId: option(args, spec.option),
    })).filter((c): c is { spec: typeof c.spec; channelId: string } => typeof c.channelId === 'string');

    if (chosen.length === 0) {
      return ephemeral(
        'Pick at least one channel. Run **/config show** to see what is set, or ' +
          '**/config clear** to unset one.'
      );
    }

    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      console.error('[bot] /config channels: DISCORD_BOT_TOKEN is not set');
      return ephemeral('I am not configured to post anywhere right now.');
    }
    const api = new DiscordApi({ token });

    const write: Record<string, string> = {};
    const refused: string[] = [];
    for (const { spec, channelId } of chosen) {
      if (await proveCanPost(api, channelId, spec.label)) write[spec.key] = channelId;
      else refused.push(`<#${channelId}> for **${spec.label}**`);
    }

    // NOTHING IS SAVED UNTIL THE POST SUCCEEDS, and a channel that refused is
    // left exactly as it was rather than half-set. A club that changes three
    // channels and gets one wrong keeps the other two.
    if (Object.keys(write).length > 0) await writeDiscordSettings(write, manager);

    const saved = Object.keys(write).length;
    const ok = saved > 0 ? `Saved ${saved} channel${saved === 1 ? '' : 's'}.` : 'Nothing saved.';
    if (refused.length === 0) return ephemeral(`${ok} I posted a note in each one.`);

    return ephemeral(
      `${ok}\n\nI could not post in ${refused.join(', ')}, so ` +
        `${refused.length === 1 ? 'it was' : 'they were'} left unchanged. ` +
        'Give me **View Channel** and **Send Messages** there and run this again.'
    );
  }

  if (sub === 'ping_roles') {
    const every = option(args, 'every_session');
    const write: Record<string, string> = {};
    for (const spec of ROLE_SETTINGS) {
      // A specific option beats every_session, so "this role for everything
      // except competitive" is one command.
      const chosen = option(args, spec.option) ?? every;
      if (typeof chosen === 'string' && chosen) write[spec.key] = chosen;
    }
    if (Object.keys(write).length === 0) {
      return ephemeral('Pick at least one role. Run **/config show** to see what is set.');
    }
    await writeDiscordSettings(write, manager);
    const lines = ROLE_SETTINGS.filter((spec) => write[spec.key]).map(
      (spec) => `**${spec.label}**: <@&${write[spec.key]}>`
    );
    return ephemeral(
      `Saved.\n${lines.join('\n')}\n\n` +
        'The role must be mentionable, or I need **Mention Everyone** in the ping channel, ' +
        'or the ping posts without notifying anyone.'
    );
  }

  if (sub === 'tournament') {
    const write: Record<string, string> = {};
    for (const spec of VALUE_SETTINGS) {
      const raw = option(args, spec.option);
      if (raw === undefined || raw === null) continue;
      const value = String(raw).trim();
      const problem = validateValue(spec.option, value);
      if (problem) return ephemeral(problem);
      write[spec.key] = value;
    }

    if (Object.keys(write).length === 0) {
      return ephemeral('Nothing to change. Run **/config show** to see what is set.');
    }

    // A tournament event Discord will accept needs the end after the start, and
    // checking it here rather than at send time is the difference between one
    // wrong answer now and a relay that skips every tournament with
    // `end_before_start` where nobody is reading.
    const { settings } = await fetchDiscordSettings();
    const start = write.tournament_event_start_time ?? settings.tournament_event_start_time ?? '09:00';
    const end = write.tournament_event_end_time ?? settings.tournament_event_end_time ?? '18:00';
    // COMPARED AS STRINGS, which is only correct because both went through a
    // zero-padded HH:MM check -- CLOCK in settings.ts for what arrived here,
    // and the app's identical one for what came back from it. '9:00' would
    // sort after '18:00' and this would pass a backwards pair.
    if (end <= start) {
      return ephemeral(
        `A tournament cannot end at **${end}** having started at **${start}** — ` +
          'Discord rejects an event that ends before it begins, so nothing would be created.'
      );
    }

    await writeDiscordSettings(write, manager);
    return ephemeral(
      `Saved. Tournament events run **${start}–${end}**` +
        `${settings.tournament_event_location || write.tournament_event_location ? '' : ' with no location set'}.`
    );
  }

  if (sub === 'clear') {
    const spec = specByOption(String(option(args, 'setting') ?? ''));
    if (!spec) return ephemeral('I do not know that setting.');

    await writeDiscordSettings({ [spec.key]: null }, manager);
    // Says what stops rather than "cleared", because that is the part the club
    // needs to have understood before running it.
    return ephemeral(`Unset **${spec.label}** — from now on ${spec.whenUnset}.`);
  }

  return ephemeral(
    'Use **/config show**, **/config channels**, **/config ping_roles**, **/config tournament** or **/config clear**.'
  );
}

async function handleRolePicker(
  options: CommandOption[] | undefined,
  context: InteractionContext
) {
  if (!context.guildId) {
    return ephemeral('Run this in a server, not a DM.');
  }
  // Any server: a picker is that server's own (00302 opened the table to every
  // server). EXEC_ONLY keeps it to that server's admins until they grant it,
  // and the role option can only name roles from the server it was typed in.
  const { name: sub, options: args } = subcommand(options);

  if (sub === 'add') {
    const roleId = String(option(args, 'role') ?? '');
    const label = String(option(args, 'label') ?? '').trim();
    const emojiRaw = option(args, 'emoji');
    const order = option(args, 'order');
    if (!roleId || !label) return ephemeral('I need both a role and a label.');

    try {
      await addSelfRole({
        guildId: context.guildId,
        roleId,
        label,
        emoji: emojiRaw ? String(emojiRaw) : null,
        sortOrder: typeof order === 'number' ? order : 0,
      });
    } catch (error) {
      // The one failure worth explaining properly. Everything else falls
      // through to dispatch's generic handler.
      if (!(error instanceof SweepManagedRoleError)) throw error;
      return ephemeral(
        `<@&${roleId}> is one of the club roles I assign automatically from the ` +
          'website, so members must not be able to pick it themselves — I would ' +
          'take it straight back off them on the next nightly sync.\n\n' +
          'Make a separate role for pings and offer that one instead.'
      );
    }

    return ephemeral(
      `Added <@&${roleId}> as **${label}**.\n\n` +
        'Run **/rolepicker post** to put the picker in a channel (or post it again ' +
        'to refresh an existing one — the old message keeps its old buttons).'
    );
  }

  if (sub === 'remove') {
    const roleId = String(option(args, 'role') ?? '');
    if (!roleId) return ephemeral('I need a role.');
    await removeSelfRole(context.guildId, roleId);
    return ephemeral(
      `Stopped offering <@&${roleId}>.\n\n` +
        'Members who already have it keep it — I do not take roles away that ' +
        'people chose. Run **/rolepicker post** again to refresh the buttons.'
    );
  }

  if (sub === 'list' || sub === 'post') {
    const { roles, truncated } = await fetchSelfRoles(context.guildId);

    if (roles.length === 0) {
      return ephemeral(
        'No ping roles are on offer yet. Add one with **/rolepicker add**.'
      );
    }

    if (sub === 'list') {
      return ephemeralEmbed({
        title: 'Ping roles on offer',
        color: CLUB_RED,
        description: roles
          .map((r) => `${r.emoji ? `${r.emoji} ` : ''}**${r.label}** — <@&${r.roleId}>`)
          .join('\n'),
        ...(truncated
          ? { footer: { text: `Only the first 25 can be shown on one message.` } }
          : {}),
      });
    }

    // PUBLIC on purpose, and the only public reply in this command. The whole
    // point is a message everyone in the channel can click.
    return {
      type: 4,
      data: {
        embeds: [
          {
            title: 'Get pinged for the sessions you care about',
            color: CLUB_RED,
            description:
              'Pick what you want. Click again to turn one off.\n\n' +
              'Most of these are notification roles and change nothing else. The ' +
              'exception is your membership — **Internal**, **Alumni** or ' +
              '**External** — which the website reads back, so picking one sets ' +
              'your tournament entry fee and which events you can enter.',
          },
        ],
        components: pickerComponents(roles),
      },
    };
  }

  return ephemeral('Unknown subcommand.');
}

/**
 * A member clicked a picker button.
 *
 * Returns an UPDATE-free ephemeral reply (type 4 + flags 64) rather than
 * editing the picker message: the message is shared, and editing it to say
 * "you now have Competitive nights" would show that to everyone who looks.
 */
export async function handleSelfRoleButton(
  customId: string,
  context: InteractionContext,
  currentRoleIds: readonly string[]
) {
  const roleId = customId.slice(SELF_ROLE_PREFIX.length);
  if (!context.guildId || !context.discordUserId || !roleId) {
    return ephemeral("Couldn't work out who you are. Try again.");
  }

  // REVALIDATED, not trusted. The button came from a message that may be older
  // than the configuration behind it.
  const { roles } = await fetchSelfRoles(context.guildId);
  const offered = roles.find((r) => r.roleId === roleId);
  if (!offered) {
    return ephemeral(
      'That role is not on offer any more. Ask an exec to post a fresh picker.'
    );
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] self-role toggle: DISCORD_BOT_TOKEN is not set');
    return ephemeral('I am not configured to change roles right now.');
  }

  const api = new DiscordApi({ token });
  const holds = currentRoleIds.includes(roleId);

  // roleCall RESOLVES with an outcome rather than throwing -- a try/catch here
  // would report every failure as a success. The outcomes are distinguished
  // because they have different fixes and only one of them is the club's to
  // make: 'forbidden' is the role sitting above the bot's own, which is the
  // single most common way this bot appears to work while doing nothing.
  const outcome = holds
    ? await api.removeRole(context.guildId, context.discordUserId, roleId)
    : await api.addRole(context.guildId, context.discordUserId, roleId);

  if (outcome === 'forbidden') {
    return ephemeral(
      `I am not allowed to give out **${offered.label}**. It sits above my own ` +
        'role in Server Settings → Roles — an exec needs to drag my role above it.'
    );
  }
  if (outcome !== 'ok') {
    console.error(`[bot] self-role toggle ${outcome}: role ${roleId} in ${context.guildId}`);
    return ephemeral(`Couldn't change **${offered.label}** just now. Try again in a moment.`);
  }

  // ---- MEMBERSHIP ROLES, WHICH ARE NOT PING ROLES --------------------------
  //
  // @Internal / @Alumni / @External say who a member is, so picking one has a
  // consequence on the website: it is what prices a tournament entry and what
  // decides which events they may enter. Everything below runs only for those
  // three; an ordinary ping role falls straight past it to the reply.
  const guildRoles = await guildRolesFor(context.guildId);
  const membership = membershipRoleFor(roleId, guildRoles);

  if (membership && !holds) {
    // ---- NOT FOR A BANNED MEMBER ----
    //
    // This click is the ONLY writer of membership_type, so a write that should
    // not have happened has nothing behind it to correct: the sweep no longer
    // reads these roles back. A ban is the club withdrawing access, and
    // membership_type prices a tournament entry and decides which events a
    // member may enter, so somebody the club has just closed setting their own
    // fee tier on the way out is worth one extra request to prevent.
    //
    // FAILING CLOSED, for the same reason. An unreadable answer is not evidence
    // the member is in good standing, and nothing revisits this later.
    //
    // ONLY THE WRITE IS REFUSED. The role is already on and stays on; roleDiff
    // strips all three from a banned member on the next sweep, which is the
    // path that has always taken them off.
    let banned: boolean;
    try {
      banned = await isMemberBanned(context.discordUserId);
    } catch (error) {
      console.error('[bot] could not check ban state for a membership click:', error);
      return ephemeral(
        `Added **${offered.label}**.\n\n` +
          'I could not update the website just now. Try the button again in a few ' +
          'minutes, or ask an exec to set your membership in the console.'
      );
    }
    if (banned) {
      // SAYS NOTHING ABOUT WHICH CHECK FAILED, the same restraint /announce's
      // 'not_permitted' branch uses: what the club has recorded about a member
      // is not something to read back to them because they pressed a button.
      return ephemeral(
        `Added **${offered.label}**.\n\n` +
          "I didn't change your membership on the website. Ask an exec if you " +
          'think that is wrong.'
      );
    }

    // ONE MEMBERSHIP AT A TIME. membership_type is a single value, and a member
    // holding both @Alumni and @Internal is a state the app cannot store — so
    // the other two come off here rather than being resolved by a guess later.
    // Failures are deliberately ignored: the app write below is the part that
    // matters, and a role that would not come off is visible in the server.
    await removeOtherMembershipRoles(
      api,
      context.guildId,
      context.discordUserId,
      guildRoles,
      membership,
      currentRoleIds
    );

    let linkedToApp = true;
    try {
      const result = await setMembership([
        { discordUserId: context.discordUserId, membershipType: membership },
      ]);
      linkedToApp = result.skipped === 0;
    } catch (error) {
      // The role is already on. Saying "that failed" would be wrong, and
      // silently pretending the website updated would be worse, so the reply
      // says exactly which half landed and names the two things that can still
      // fix it. NOTHING REPAIRS THIS IN THE BACKGROUND any more: the sweep no
      // longer reads membership roles back, so this click is the only writer.
      console.error('[bot] membership write failed:', error);
      return ephemeral(
        `Added **${offered.label}**.\n\n` +
          'I could not update the website just now. Try the button again in a few ' +
          'minutes, or ask an exec to set your membership in the console.'
      );
    }

    return ephemeral(
      linkedToApp
        ? `Added **${offered.label}** — the website now has you as **${membership}**, ` +
            'which is what decides your tournament entry fee and which events you can enter.'
        : `Added **${offered.label}**.\n\n` +
            'Your Discord account is not linked to the website yet, so this only ' +
            'changed your role here. Run **/link** and it will follow.'
    );
  }

  if (membership && holds) {
    // Toggling one OFF leaves the website alone on purpose. There is no "no
    // membership" to write — the column always holds one of the three — and
    // guessing a default would quietly move somebody's fee tier as a side
    // effect of tidying their roles.
    return ephemeral(
      `Removed **${offered.label}**.\n\n` +
        'The website still has your membership as it was — pick another one to ' +
        'change it.'
    );
  }

  return ephemeral(
    holds
      ? `Removed **${offered.label}** — you won't be pinged for those any more.`
      : `Added **${offered.label}** — you'll be pinged for those.`
  );
}

/**
 * This guild's role map, or an empty one if the config cannot be read.
 *
 * Degrading to empty is right HERE and nowhere else in this bot: an empty map
 * names no membership role, so the button behaves as an ordinary ping role and
 * the website is left alone.
 *
 * The cost of that is now real, because no sweep reads these roles back any
 * more: the member's membership_type stays as it was until they click again
 * with the config readable, or an exec sets it in the console. Still the right
 * direction. A fee tier written from a half-read config would be worse than one
 * that did not move.
 */
/**
 * Is this one of the club's own servers (connected by /setup)? The bot runs in
 * any server; the club's records, audit channel and role pickers belong to
 * these. False when the config cannot be read, which only ever skips extras.
 */
async function isClubServer(guildId: string | null): Promise<boolean> {
  if (!guildId) return false;
  try {
    return (await loadConfig()).registry.has(guildId);
  } catch (error) {
    console.error('[bot] could not read the club servers:', error);
    return false;
  }
}

async function guildRolesFor(guildId: string): Promise<GuildRoleMap> {
  try {
    const { registry } = await loadConfig();
    return registry.get(guildId) ?? {};
  } catch (error) {
    console.error('[bot] could not read the role map for a self-role click:', error);
    return {};
  }
}

/** Which membership this role id IS in this guild, if any. */
function membershipRoleFor(roleId: string, guildRoles: GuildRoleMap): MembershipRole | null {
  for (const role of MEMBERSHIP_ROLES) {
    if (guildRoles[role] === roleId) return role;
  }
  return null;
}

async function removeOtherMembershipRoles(
  api: DiscordApi,
  guildId: string,
  discordUserId: string,
  guildRoles: GuildRoleMap,
  keep: MembershipRole,
  currentRoleIds: readonly string[]
): Promise<void> {
  const held = new Set(currentRoleIds);
  for (const role of MEMBERSHIP_ROLES) {
    if (role === keep) continue;
    const id = guildRoles[role];
    if (!id || !held.has(id)) continue;
    await api.removeRole(guildId, discordUserId, id);
  }
}

// ---------------------------------------------------------------------------
// /bug and /feedback
// ---------------------------------------------------------------------------
//
// TWO INTERACTIONS, NOT ONE. The command opens a modal; the modal submit is a
// separate interaction that arrives later and files the report. Discord gives
// no way to do it in one — a modal is a RESPONSE to an interaction, so the
// command cannot both show it and read what was typed into it.
//
// That split is the whole reason for the pending-attachment map below: the
// screenshot is picked on the first interaction and needed on the second, and
// Discord echoes back nothing from the first except the custom_id.

const REPORT_MODAL_PREFIX = 'report:';

/** Discord's own cap on a modal title and on a text input label. */
const MODAL_TITLE_MAX = 45;

// Discord's default upload ceiling for a bot is 25MB, but a screenshot that
// large is a video somebody mislabelled. 8MB is generous for a phone
// screenshot and keeps a single tick of the relay from buffering something
// absurd. Enforced HERE, at pick time, so the reporter is told — the relay
// enforces it again because it is the one doing the download.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * A screenshot waiting for its modal to be submitted.
 *
 * IN MEMORY AND PER PROCESS, deliberately. Losing one costs a picture and never
 * a report: the modal submit finds nothing under its nonce, files the words on
 * their own, and says the screenshot did not make it. A restart mid-report, or
 * a second replica taking the submit, both land there.
 *
 * A database round trip to make this durable would be storing a url that
 * expires in a day, to survive a window of at most fifteen minutes, for a file
 * the reporter can simply attach again.
 */
interface PendingImage {
  url: string;
  filename: string;
  contentType: string;
  /** Set when the file was rejected at pick time; the reason is shown once. */
  rejected: string | null;
  expiresAt: number;
}

// IN-MEMORY, SO THE BOT MUST RUN AS ONE PROCESS. Discord routes the command
// and the modal submit as two independent HTTP requests, so a second replica
// would receive submits for pictures it never stashed and drop them. The
// compose files carry `proxy.unscalable: "true"` for exactly this reason --
// read the comment there before removing it.
//
// Deliberately not durable beyond that: losing this map costs the picture and
// never the report, which is the right way round for state that exists for at
// most fifteen minutes.
const pendingImages = new Map<string, PendingImage>();

// The interaction token behind the modal dies at fifteen minutes, so an entry
// older than that can never be claimed.
const PENDING_TTL_MS = 15 * 60_000;

// A ceiling on the map itself, because an entry is only ever removed by a
// submit that may never come: somebody who opens /bug and presses Escape leaves
// one behind. Eviction is oldest-first and bounded work per insert.
const MAX_PENDING = 200;

function stashImage(nonce: string, image: PendingImage) {
  const now = Date.now();
  for (const [key, value] of pendingImages) {
    if (value.expiresAt <= now) pendingImages.delete(key);
  }
  while (pendingImages.size >= MAX_PENDING) {
    const oldest = pendingImages.keys().next();
    if (oldest.done) break;
    pendingImages.delete(oldest.value);
  }
  pendingImages.set(nonce, image);
}

function claimImage(nonce: string): PendingImage | null {
  const found = pendingImages.get(nonce);
  // Claimed once and then gone, whether or not it was used. A modal cannot be
  // submitted twice, and leaving it would keep an expiring url alive for no
  // reader.
  if (found) pendingImages.delete(nonce);
  if (!found || found.expiresAt <= Date.now()) return null;
  return found;
}

/** Exported for the tests; nothing else has any business reaching in here. */
export function __clearPendingImages() {
  pendingImages.clear();
}

/**
 * /bug and /feedback. One handler, because they differ by which kind is filed.
 *
 * `fixedKind` is 'bug' for /bug and null for /feedback, where the reporter
 * picks from the `about` choices and 'feedback' is the default. Splitting them
 * into two commands rather than one /feedback with a 'bug' choice is a UX call:
 * somebody whose page just broke types "/bug", not "/feedback about:bug".
 *
 * The kind is carried in the custom_id because there is nowhere else to put it:
 * the modal submit arrives as its own interaction with no memory of the command
 * that opened it, and custom_id is the only field that survives the round trip.
 */
function openReportModal(
  fixedKind: FeedbackKind | null,
  options: CommandOption[] | undefined,
  context: InteractionContext
) {
  const chosen = String(option(options, 'about') ?? '');
  const kind: FeedbackKind =
    fixedKind ?? (chosen === 'tournament_feedback' || chosen === 'other' ? chosen : 'feedback');

  const nonce = randomUUID().replace(/-/g, '').slice(0, 12);

  const attachmentId = option(options, 'screenshot');
  if (attachmentId) {
    const file = context.attachments?.[String(attachmentId)];
    const contentType = (file?.content_type ?? '').split(';')[0]?.trim() ?? '';
    const url = file?.url ?? '';

    // NOT an image, or too big. Both are stashed as a REJECTION rather than
    // dropped, so the confirmation can say what happened — a screenshot that
    // silently does not appear reads as the report having failed.
    const rejected = !url
      ? 'the file could not be read'
      : !contentType.startsWith('image/')
        ? 'it is not an image'
        : (file?.size ?? 0) > MAX_IMAGE_BYTES
          ? 'it is over 8MB'
          : null;

    stashImage(nonce, {
      url,
      filename: (file?.filename ?? 'screenshot.png').slice(0, 100),
      contentType: contentType || 'application/octet-stream',
      rejected,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
  }

  const heading = kind === 'bug' ? 'Report a bug' : 'Send the club feedback';

  return {
    type: 9, // MODAL
    data: {
      custom_id: `${REPORT_MODAL_PREFIX}${kind}:${nonce}`,
      title: heading.slice(0, MODAL_TITLE_MAX),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // TEXT_INPUT
              custom_id: 'title',
              label: kind === 'bug' ? 'What is broken?' : 'In a few words',
              style: 1, // SHORT
              required: true,
              min_length: 3,
              // Under the column's own 120 so a title never arrives needing to
              // be trimmed by the route.
              max_length: 100,
              placeholder:
                kind === 'bug' ? 'Ladder page spins forever' : 'More weeknight sessions',
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'details',
              label: kind === 'bug' ? 'What happened?' : 'Tell us more',
              style: 2, // PARAGRAPH
              required: true,
              min_length: 5,
              max_length: 1000,
              placeholder:
                kind === 'bug'
                  ? 'What you did, what happened, and what you expected'
                  : 'What is on your mind',
            },
          ],
        },
      ],
    },
  };
}

/** True for a modal submit this module owns. */
export function isReportModal(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(REPORT_MODAL_PREFIX);
}

/**
 * The value of one text input in a submitted modal.
 *
 * Modal components arrive NESTED — every input sits inside its own action row —
 * so a flat find on the outer list matches nothing and reads as an empty box
 * the client would never have allowed.
 */
function modalValue(components: ModalComponent[] | undefined, customId: string): string {
  for (const row of components ?? []) {
    for (const child of row.components ?? []) {
      if (child.custom_id === customId) return String(child.value ?? '');
    }
    if (row.custom_id === customId) return String(row.value ?? '');
  }
  return '';
}

// ---------------------------------------------------------------------------
// /announce
// ---------------------------------------------------------------------------
//
// The same two-interaction split /bug uses: the command opens a modal, and the
// submit arrives later as its own interaction carrying the custom_id and the
// typed values and NOTHING ELSE. The four command options have to survive that
// gap, and the custom_id is the only field that does.
//
// PACKED INTO THE ID RATHER THAN STASHED IN A MAP, which is where /bug's
// screenshot has to go. A map costs correctness the moment the bot restarts or
// a second replica takes the submit: the entry is gone and the options silently
// revert to their defaults. For a screenshot that is a lost picture; for `draft`
// it would be an announcement published when somebody asked for a draft. Four
// flags fit in a dozen characters of a hundred-character field, so nothing here
// needs to be remembered between the two requests.

const ANNOUNCE_MODAL_PREFIX = 'announce:';

type AnnouncementType = 'info' | 'warning' | 'urgent' | 'event';
const ANNOUNCEMENT_TYPES: readonly AnnouncementType[] = ['info', 'warning', 'urgent', 'event'];

interface AnnounceFlags {
  type: AnnouncementType;
  pin: boolean;
  draft: boolean;
  evergreen: boolean;
}

/** `announce:<type>:<pin><draft><evergreen>`, each flag a single 0 or 1. */
function packAnnounceFlags(f: AnnounceFlags): string {
  const bit = (on: boolean) => (on ? '1' : '0');
  return `${ANNOUNCE_MODAL_PREFIX}${f.type}:${bit(f.pin)}${bit(f.draft)}${bit(f.evergreen)}`;
}

/**
 * Read the flags back, FAILING CLOSED ON `draft`.
 *
 * Everything that reaches here was written by packAnnounceFlags, so a malformed
 * id means either a build that has changed the format under a modal somebody
 * still has open, or a caller that is not Discord. Both are answered the same
 * way, and the direction of the default is the whole point: an unreadable
 * `draft` bit resolves to DRAFT, never to published. A draft the exec has to go
 * and publish is a small annoyance; a publish nobody asked for is on the
 * website and in the announcements channel before anyone can say otherwise.
 *
 * `pin` and `evergreen` fail closed to false on the same reasoning -- neither
 * is recoverable from the reply, both are one edit away in the console.
 */
function unpackAnnounceFlags(customId: string): AnnounceFlags {
  const [, rawType = '', bits = ''] = customId.split(':');
  const type = ANNOUNCEMENT_TYPES.includes(rawType as AnnouncementType)
    ? (rawType as AnnouncementType)
    : 'info';

  if (!/^[01]{3}$/.test(bits)) {
    return { type, pin: false, draft: true, evergreen: false };
  }
  return {
    type,
    pin: bits[0] === '1',
    draft: bits[1] === '1',
    evergreen: bits[2] === '1',
  };
}

/** True for a modal submit this module owns. */
export function isAnnounceModal(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(ANNOUNCE_MODAL_PREFIX);
}

function openAnnounceModal(options: CommandOption[] | undefined) {
  const rawType = String(option(options, 'type') ?? '');
  const flags: AnnounceFlags = {
    type: ANNOUNCEMENT_TYPES.includes(rawType as AnnouncementType)
      ? (rawType as AnnouncementType)
      : 'info',
    pin: option(options, 'pin') === true,
    draft: option(options, 'draft') === true,
    evergreen: option(options, 'evergreen') === true,
  };

  return {
    type: 9, // MODAL
    data: {
      custom_id: packAnnounceFlags(flags),
      title: (flags.draft ? 'Draft an announcement' : 'Post an announcement').slice(
        0,
        MODAL_TITLE_MAX
      ),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // TEXT_INPUT
              custom_id: 'title',
              label: 'Headline',
              style: 1, // SHORT
              required: true,
              min_length: 3,
              // Under the column's own 200 so a headline never arrives needing
              // to be trimmed by the route.
              max_length: 150,
              placeholder: 'Sunday session moved to Gym B',
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'body',
              label: 'The announcement',
              style: 2, // PARAGRAPH
              required: true,
              min_length: 5,
              // Discord's own ceiling for a text input is 4000; the route caps
              // at 3500 and the schema at 5000. The tightest of the three is
              // enforced HERE, where the writer can still see what they typed.
              max_length: 3500,
              placeholder: 'Everyone can read this — on the website and in the announcements channel.',
            },
          ],
        },
      ],
    },
  };
}

/**
 * A submitted announcement: file it, and be honest about who it reached.
 *
 * THE SECOND PARAGRAPH OF THE SUCCESS REPLY IS THE POINT OF IT. This path files
 * the announcement and nothing else -- no in-app bell row, no web push -- so an
 * exec who reads "posted" and walks away believes they have notified the club
 * when they have not. The route's header explains why it works that way; this
 * is where the club finds out.
 */
export async function handleAnnounceModal(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
) {
  const flags = unpackAnnounceFlags(customId);
  const title = modalValue(components, 'title').trim();
  const body = modalValue(components, 'body').trim();

  if (!title || !body) {
    // Discord's min_length should make this unreachable. Checked anyway,
    // because a blank announcement is worse than a refused one.
    return ephemeral('An announcement needs a headline and something to say. Try again.');
  }

  const result = await submitAnnouncement({
    discordUserId: context.discordUserId,
    title,
    body,
    type: flags.type,
    pin: flags.pin,
    draft: flags.draft,
    evergreen: flags.evergreen,
  });

  if (!result.ok) {
    // MATCHED AGAINST A CLOSED SET, never printed. The refusal is a code the
    // route chose from a union; turning it into a sentence is this file's job,
    // and interpolating whatever arrived would put an app response body into a
    // Discord message.
    switch (result.refusal) {
      case 'not_linked':
        return ephemeral(
          "Run `/link` first — an announcement is filed against your club account, " +
            "and this Discord account isn't connected to one yet. Nothing was posted."
        );
      case 'no_active_season':
        return ephemeral(
          "There's no active season right now, so this announcement wouldn't belong to " +
            'one — and a notice filed against no season shows in every future term. ' +
            'Run it again with `evergreen: True` if it is a standing notice (club rules, ' +
            'the door code), or activate a season in the console first. Nothing was posted.'
        );
      default:
        // 'not_permitted', and anything a newer app adds. Deliberately says
        // nothing about which check failed: a banned exec and a member who
        // never had the capability get the same sentence.
        return ephemeral(
          "You don't have permission to post club announcements. An admin grants that " +
            'in the console under Permissions. Nothing was posted.'
        );
    }
  }

  if (result.status === 'draft') {
    return ephemeral(
      "**Saved as a draft.** Nothing is public yet — nobody can see it on the website " +
        'and it will not reach the announcements channel until an exec publishes it in ' +
        'the console.'
    );
  }

  return ephemeral(
    "**Posted.** It's on the website now, and it will appear in the announcements " +
      'channel within about five minutes.\n\n' +
      'Nobody was notified — no in-app alert and no push. If members need to be ' +
      'pinged, publish it from the console instead.'
  );
}

// ---------------------------------------------------------------------------
// /say
// ---------------------------------------------------------------------------
//
// The two-interaction split /announce uses, and the same reason for packing the
// options into the custom_id rather than a map: a modal submit arrives as its
// own request carrying the id and the typed text and nothing else, and a map
// entry is gone the moment the bot restarts or a second replica takes the
// submit. Here the loss would be worse than a reverted flag — the channel would
// be unknown and the message would have nowhere to go.

const SAY_MODAL_PREFIX = 'say:';

/** `say:<channelId>:<ping bit>`. */
function packSay(channelId: string, ping: boolean): string {
  return `${SAY_MODAL_PREFIX}${channelId}:${ping ? '1' : '0'}`;
}

/**
 * Read it back, FAILING CLOSED ON `ping`.
 *
 * Anything malformed means a build that changed the format under a modal
 * somebody still has open, or a caller that is not Discord. Either way an
 * unreadable ping bit resolves to NO mentions: a message that should have
 * pinged and did not is a follow-up, and a ping nobody asked for has already
 * buzzed every phone in the server.
 */
function unpackSay(customId: string): { channelId: string; ping: boolean } {
  const [, channelId = '', bit = ''] = customId.split(':');
  return { channelId, ping: bit === '1' };
}

/** True for a modal submit this module owns. */
export function isSayModal(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(SAY_MODAL_PREFIX);
}

/**
 * The caller's own permissions, as a mask.
 *
 * BigInt, NEVER Number: the field is a 64-bit mask sent as a string, and bits
 * above 52 do not survive Number() -- discord-api.ts makes the same point where
 * it reads the bot's own permissions. Anything absent or unparseable reads as
 * zero, so the one caller fails closed without having to special-case it.
 */
function permissionMask(permissions: string | null | undefined): bigint {
  if (!permissions) return 0n;
  try {
    return BigInt(permissions);
  } catch {
    return 0n;
  }
}

export function openSayModal(
  options: CommandOption[] | undefined,
  context: InteractionContext
): BotResponse {
  // The picker gives a channel id as the option value; "here" is the fallback.
  const chosen = option(options, 'channel');
  const channelId = chosen ? String(chosen) : String(context.channelId ?? '');
  const ping = option(options, 'ping') === true;

  if (!channelId) {
    // Unreachable through Discord — a guild command always has a channel — but
    // a modal whose id has no channel in it would open, take the words and
    // throw them away on submit.
    return ephemeral("Couldn't work out which channel to post in. Pick one with `channel:`.");
  }

  return {
    type: 9, // MODAL
    data: {
      custom_id: packSay(channelId, ping),
      title: 'Post as the club'.slice(0, MODAL_TITLE_MAX),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // TEXT_INPUT
              custom_id: 'body',
              label: 'What should I say?',
              style: 2, // PARAGRAPH
              required: true,
              min_length: 1,
              // Discord refuses a message over 2000 characters. Enforced here,
              // where the writer can still see and cut what they typed, rather
              // than as a 400 after the modal has closed and eaten the words.
              max_length: 2000,
              placeholder: 'Posted exactly as typed, as the bot. Nobody sees that you sent it.',
            },
          ],
        },
      ],
    },
  };
}

/**
 * A submitted /say: post it, and write down who said it.
 *
 * ORDER MATTERS. The message goes out first and the audit entry second, so an
 * audit channel the bot cannot post in — misconfigured, deleted, permissions
 * changed — costs the club its record and not its message. postAuditEntry
 * already swallows its own failures for that reason.
 */
export async function handleSayModal(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  // ---- WHO SUBMITTED THIS ----
  //
  // DEFENCE IN DEPTH, NOT THE GATE, and it is worth being exact about which.
  // Discord shows /say only to the roles the server's integration allowlist
  // permits, and index.ts verifies the Ed25519 signature on every interaction,
  // so a submit cannot be forged. What this adds is that Discord RECOMPUTES the
  // mask for the submit rather than echoing the command's: a member whose
  // access was taken away while their modal sat open is refused by the second
  // interaction instead of posting in the club's voice with it.
  //
  // '0' IS NOT A PERMISSION. default_member_permissions is EXEC_ONLY, which is
  // "no default access" rather than a bit anybody holds, so there is no bit
  // here that reproduces that audience, and checking a named one (Manage
  // Messages, Manage Guild) would refuse exactly the execs the allowlist exists
  // to permit. So the check is the weakest one that is still true of every
  // member Discord would have shown the command to, and false for a caller with
  // no standing in the guild at all: the mask is there, and it is not empty.
  if (permissionMask(context.permissions) === 0n) {
    return ephemeral(
      "I couldn't check whether you're allowed to post as the club. Nothing was posted."
    );
  }

  const { channelId, ping } = unpackSay(customId);
  const body = modalValue(components, 'body').trim();

  if (!channelId) {
    return ephemeral("That message had no channel attached to it — run `/say` again.");
  }
  if (!body) {
    // Discord's min_length should make this unreachable. Checked anyway: a
    // blank message from the club bot is a mystery nobody can explain later.
    return ephemeral('There was nothing to post. Try again.');
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] /say: DISCORD_BOT_TOKEN is not set');
    return ephemeral("I'm not configured to post right now. Nothing was posted.");
  }

  const api = new DiscordApi({ token });
  const messageId = await api.postMessage(channelId, {
    content: body,
    // SILENCE UNLESS THE EXEC ASKED. An empty `parse` turns every @here,
    // @everyone and @role in the text into plain text: they still READ as
    // mentions and they notify nobody. That is the default, so a stray
    // @everyone typed into a paragraph cannot buzz the whole server.
    //
    // WHEN THE EXEC DID ASK, @everyone IS THE POINT and is left alone
    // deliberately. Notifying the club is the capability this command exists to
    // provide, and the gate on it is authorisation rather than scrubbing the
    // payload: Discord shows /say only to the integration allowlist, index.ts
    // verifies the Ed25519 signature, and the mask check above refuses a caller
    // with no standing. Narrowing this to roles named in the text was tried and
    // reverted: it silently broke the console's own plain-message switch, whose
    // copy promises that an @everyone in the text will buzz every phone.
    allowed_mentions: ping
      ? { parse: ['users', 'roles', 'everyone'] }
      : { parse: [] },
  });

  if (!messageId) {
    return ephemeral(
      `Discord refused that — check I can post in <#${channelId}>. Nothing was posted.`
    );
  }

  try {
    const { auditChannelId, registry } = await loadConfig();
    // The audit channel is the club's: /say in somebody else's server is theirs.
    const auditTo = context.guildId && registry.has(context.guildId) ? auditChannelId : undefined;
    await postAuditEntry(api, auditTo, {
      kind: 'say',
      discordUserId: context.discordUserId,
      guildId: context.guildId,
      channelId,
      messageId,
      body,
      pinged: ping,
    });
  } catch (error) {
    // The message is already posted. A failure to record it is worth a line in
    // the log and nothing else — telling the exec their message did not go out
    // would be false.
    console.error('[bot] /say: could not write the audit entry:', error);
  }

  return ephemeral(
    `**Posted** in <#${channelId}>${ping ? ' — mentions were allowed to notify.' : '.'}\n\n` +
      'It shows as coming from me, not from you. The audit channel has a copy with your name on ' +
      'it, so an exec can always find out who asked.'
  );
}

export interface ModalComponent {
  type?: number;
  custom_id?: string;
  value?: string;
  components?: ModalComponent[];
}

/**
 * A submitted report modal: file it, and say so.
 *
 * THE REPLY IS EPHEMERAL. Filing a complaint is not publishing it, and a member
 * reporting that a feature is broken has not asked their channel to hear about
 * it. What DOES happen is that the relay puts it in the exec channel a few
 * minutes later (00173) — a private room, not the one they typed in.
 */
export async function handleReportModal(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
) {
  const [, rawKind = '', nonce = ''] = customId.split(':');
  // Anything else is a caller that is not Discord — it only ever sends back a
  // custom_id this file wrote. 'feedback' is the harmless landing spot; passing
  // it through would fail 00172's CHECK and lose the whole report.
  const kind: FeedbackKind =
    rawKind === 'bug' || rawKind === 'tournament_feedback' || rawKind === 'other'
      ? rawKind
      : 'feedback';

  const title = modalValue(components, 'title').trim();
  const details = modalValue(components, 'details').trim();

  if (!details) {
    // Discord's min_length should make this unreachable. Checked anyway,
    // because an empty row looks like a report the club ignored.
    return ephemeral('Add a few words about what happened and try again.');
  }

  const image = nonce ? claimImage(nonce) : null;

  let linked: boolean;
  try {
    ({ linked } = await submitFeedback({
      kind,
      title: title || null,
      body: details,
      imageUrl: image && !image.rejected ? image.url : null,
      discordUserId: context.discordUserId,
      guildId: context.guildId,
    }));
  } catch (err) {
    if (err instanceof RateLimitedError) {
      // Named, so nobody retries a limiter that is working. Every retry pushes
      // their next allowed attempt further out.
      return ephemeral(
        "You've filed a few reports in a short space of time — give it an hour, " +
          'or add the rest to one message next time.'
      );
    }
    throw err;
  }

  const thanks =
    kind === 'bug'
      ? "Thanks — that's filed. The execs read these; if it's something we can " +
        'reproduce it goes on the list.'
      : "Thanks — that's filed and the execs will see it.";

  const notes: string[] = [];
  // ONLY WHEN UNLINKED, and phrased as a limitation of the reply rather than a
  // problem with the report. The report is stored either way; what is missing
  // is a way to get back to them.
  if (!linked) notes.push("You haven't run `/link` yet, so we may not be able to reply.");
  if (image?.rejected) {
    notes.push(`Your screenshot wasn't attached — ${image.rejected}. The report itself is filed.`);
  }

  return ephemeral(notes.length ? `${thanks}\n\n${notes.join('\n')}` : thanks);
}

/** True for a component interaction this module owns. */
export function isSelfRoleButton(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(SELF_ROLE_PREFIX);
}

/** True for a guide button click. */
export function isGuideButton(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(GUIDE_PREFIX);
}

// The paged lists' guards. Every prefix here is disjoint under startsWith from
// every other and from selfrole:, guide:, report:, announce:, say: and the
// leaderboard's lb:, in both directions, so the order they are checked in stays a
// readability choice rather than a correctness one. The pair that has to be read
// together is ses: and sesboard:, which diverge at index 3 (`:` against `b`);
// keep them adjacent wherever they are checked.

/** True for a paging click on /sessions' own reply or a copy of it. */
export function isSessionPageButton(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(SESSION_PAGE_PREFIX);
}

/** True for a paging click on a PUBLIC session board, or a copy of one. */
export function isSessionBoardButton(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(SESSION_BOARD_PREFIX);
}

/** True for a paging click on /tournaments. */
export function isTournamentPageButton(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(TOURNAMENT_PAGE_PREFIX);
}

/** True for a /sessions modal submit. */
export function isSessionListModal(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(SESSION_MODAL_PREFIX);
}

/** True for a session board modal submit. */
export function isSessionBoardModal(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(SESSION_BOARD_MODAL_PREFIX);
}

/** True for a /tournaments modal submit. */
export function isTournamentListModal(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(TOURNAMENT_MODAL_PREFIX);
}

/**
 * A member clicked one of the guide message's buttons.
 *
 * Written HERE rather than beside guideComponents so that openReportModal and
 * handleLink are both already in scope in reading order. Declarations hoist, so
 * either position runs.
 *
 * IT OWNS ITS OWN FAILURES. dispatch's catch covers slash commands only and
 * there is no equivalent on the component path, so an AppApiError from the mint
 * would otherwise leave here as a rejection and be answered with the generic
 * apology index.ts keeps for a bug in this file.
 *
 * The three buttons do exactly what /link, /bug and /feedback do, with no
 * options to carry: openReportModal is given `undefined` for the option list,
 * which is why the screenshot the slash command offers is not on this path.
 */
export async function handleGuideButton(customId: string, context: InteractionContext) {
  const action = customId.slice(GUIDE_PREFIX.length);
  try {
    switch (action) {
      case 'link':
        // AWAITED rather than returned bare: a bare return hands the promise
        // back before the catch below can see it reject.
        return await handleLink(context);
      // These two return bare, which is safe only because openReportModal is
      // synchronous. Make it async and they escape the catch below the way a
      // bare handleLink would.
      case 'bug':
        return openReportModal('bug', undefined, context);
      case 'feedback':
        return openReportModal(null, undefined, context);
      default:
        return ephemeral(
          'That button is from an older version of this message. Ask an exec to post a fresh one.'
        );
    }
  } catch (err) {
    console.error(`[bot] guide button ${action} failed:`, err);
    return ephemeral(
      err instanceof AppApiError
        ? "Couldn't reach the club app just now. Try again in a moment."
        : 'Something went wrong. Please try again.'
    );
  }
}

// ---------------------------------------------------------------------------
// /challenge
// ---------------------------------------------------------------------------
//
// Both subcommands act AS THE CALLER, and the caller is read off the
// interaction (context.discordUserId), never from an option. Every other
// person is a USER option, which is a Discord id the app resolves through its
// link table; the bot never sees or sends a club player id.
//
// NOTHING IS POSTED IN A CHANNEL. The opponent hears about a challenge, and the
// other side about a result, the way the website tells them: in-app, push and
// email. Every reply here is ephemeral.

const MAX_GAMES = 7;
const MAX_GAME_POINTS = 39;

/**
 * "21-15 18-21 21-19" into games, the first number of each game first. Games
 * are split on spaces or commas; each is two whole numbers joined by a hyphen
 * or colon. Only the shape is checked here, and that no game ends level.
 * Whether 21-20 can end a game is the app's call. `order` is the words for
 * which side comes first, as the command's own help says it.
 */
export function parseGameScores(
  raw: string,
  order: string
): { ok: true; games: [number, number][] } | { ok: false; message: string } {
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, message: 'Enter at least one game, like `21-15`.' };
  if (parts.length > MAX_GAMES) return { ok: false, message: `A match has at most ${MAX_GAMES} games.` };
  const games: [number, number][] = [];
  for (const part of parts) {
    const match = /^(\d{1,2})[-:](\d{1,2})$/.exec(part);
    if (!match) {
      return { ok: false, message: `\`${part.slice(0, 20)}\` is not a game score. Write each game like \`21-15\`, ${order}.` };
    }
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > MAX_GAME_POINTS || second > MAX_GAME_POINTS) {
      return { ok: false, message: `No game goes past ${MAX_GAME_POINTS} points.` };
    }
    if (first === second) return { ok: false, message: 'A game cannot end level.' };
    games.push([first, second]);
  }
  return { ok: true, games };
}

/** A challenge score: the caller's points first in every game. */
export function parseChallengeScore(
  raw: string
): { ok: true; games: { mine: number; theirs: number }[] } | { ok: false; message: string } {
  const parsed = parseGameScores(raw, 'your points first');
  if (!parsed.ok) return parsed;
  return { ok: true, games: parsed.games.map(([mine, theirs]) => ({ mine, theirs })) };
}

/** The reply for a deferred command: plain content, only the caller sees it. */
function challengeReply(content: string): BotResponse {
  // allowed_mentions empty: a refusal can name a member as <@id>, and an
  // ephemeral message should render that name without notifying them.
  return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
}

// An abort can fire after the app has written the challenge or the result,
// so this never says nothing happened.
const CHALLENGE_UNKNOWN =
  "Couldn't get an answer from the club app, so I can't tell whether that went through. " +
  'Check Challenges on the website before you try again.';

/** Turn a refusal code into this file's own sentence. */
function challengeRefusalText(
  refusal: ChallengeRefusal,
  message: string | undefined,
  people: { opponent: string | null; partner: string | null; opponentPartner: string | null }
): string {
  const notLinked = (id: string | null) =>
    `${id ? `<@${id}>` : 'That member'} hasn't connected Discord to a club account, so they can't be ` +
    'named here. Challenge them on the website instead.';
  // The three codes that carry a sentence carry the app's own words about the
  // club's rules or the score, and nothing else. Capped so a long one cannot
  // break the reply.
  const passed = (fallback: string) => (message ? message.slice(0, 300) : fallback);
  switch (refusal) {
    case 'not_linked':
      return 'Link your account first with `/link`.';
    case 'lapsed':
      return 'Your membership was paused for inactivity. Open the club website once to switch it back on, then try again.';
    case 'standing':
      return "Your account can't send or report challenges right now. The club website says why.";
    case 'feature_off':
      return 'Challenges are switched off in the club right now.';
    case 'waiver':
      return "Accept the club's current legal documents on the website first, then try again.";
    case 'opponent_not_linked':
      return notLinked(people.opponent);
    case 'partner_not_linked':
      return notLinked(people.partner);
    case 'opponent_partner_not_linked':
      return notLinked(people.opponentPartner);
    case 'not_participant':
      return "That isn't one of your accepted challenges. Pick one from the list.";
    case 'not_accepted':
      return "That challenge isn't accepted yet, or it has already finished.";
    case 'invalid_duration':
      return 'The duration has to be a whole number of minutes from 1 to 300.';
    case 'invalid':
      return passed('That challenge is not valid.');
    case 'invalid_score':
      return passed('That score is not valid.');
    case 'rule':
      return passed('The club rules do not allow that.');
    default:
      return "The club app said no, and this version of the bot doesn't know why. Try the website.";
  }
}

export async function handleChallenge(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  if (!context.discordUserId) return challengeReply("I couldn't tell who ran that. Try again.");
  const chosen = subcommand(options);
  if (chosen.name === 'send') return handleChallengeSend(chosen.options, context.discordUserId);
  if (chosen.name === 'report') return handleChallengeReport(chosen.options, context.discordUserId);
  return challengeReply('Unknown subcommand.');
}

async function handleChallengeSend(
  options: CommandOption[] | undefined,
  callerId: string
): Promise<BotResponse> {
  const userOption = (name: string) => {
    const value = option(options, name);
    return typeof value === 'string' && value ? value : null;
  };
  const opponent = userOption('opponent');
  const partner = userOption('partner');
  const opponentPartner = userOption('opponent_partner');
  const type = option(options, 'type') === 'doubles' ? 'doubles' : 'singles';
  const rated = option(options, 'rated') !== false;
  const bestOfValue = option(options, 'best_of');
  const pointsValue = option(options, 'points');
  const bestOf = typeof bestOfValue === 'number' ? bestOfValue : 3;
  const points = typeof pointsValue === 'number' ? pointsValue : 21;
  const noteValue = option(options, 'note');
  const note = typeof noteValue === 'string' && noteValue.trim() ? noteValue.trim() : null;

  if (!opponent) return challengeReply('Pick who you are challenging.');
  if (type === 'singles' && (partner || opponentPartner)) {
    return challengeReply('A singles challenge takes no partners. Set `type` to Doubles to add them.');
  }
  if (type === 'doubles' && (!partner || !opponentPartner)) {
    return challengeReply("A doubles challenge needs both `partner` and `opponent_partner`.");
  }
  const people = [callerId, opponent, ...(type === 'doubles' ? [partner, opponentPartner] : [])];
  if (new Set(people).size !== people.length) {
    return challengeReply('Everybody in a match has to be a different person, and that includes you.');
  }

  let result: Awaited<ReturnType<typeof createChallenge>>;
  try {
    result = await createChallenge({
      discordUserId: callerId,
      opponentDiscordId: opponent,
      type,
      rated,
      bestOf,
      points,
      partnerDiscordId: type === 'doubles' ? partner : null,
      opponentPartnerDiscordId: type === 'doubles' ? opponentPartner : null,
      note,
    });
  } catch (error) {
    console.error('[bot] challenge send failed:', error);
    return challengeReply(CHALLENGE_UNKNOWN);
  }

  if (!result.ok) {
    return challengeReply(
      challengeRefusalText(result.refusal, result.message, { opponent, partner, opponentPartner })
    );
  }
  return challengeReply(
    `**Challenge sent** to <@${opponent}>. They hear about it in the club app and by email, ` +
      'and they accept it on the website.'
  );
}

async function handleChallengeReport(
  options: CommandOption[] | undefined,
  callerId: string
): Promise<BotResponse> {
  const challengeValue = option(options, 'challenge');
  const scoreValue = option(options, 'score');
  const durationValue = option(options, 'duration');
  const challengeId = typeof challengeValue === 'string' ? challengeValue.trim() : '';
  if (!challengeId) return challengeReply('Pick the challenge you are reporting.');

  const score = parseChallengeScore(typeof scoreValue === 'string' ? scoreValue : '');
  if (!score.ok) return challengeReply(score.message);
  if (typeof durationValue !== 'number' || !Number.isInteger(durationValue) || durationValue < 1 || durationValue > 300) {
    return challengeReply('The duration has to be a whole number of minutes from 1 to 300.');
  }

  let result: Awaited<ReturnType<typeof reportChallenge>>;
  try {
    result = await reportChallenge({
      discordUserId: callerId,
      challengeId,
      games: score.games,
      durationMinutes: durationValue,
    });
  } catch (error) {
    console.error('[bot] challenge report failed:', error);
    return challengeReply(CHALLENGE_UNKNOWN);
  }

  if (!result.ok) {
    return challengeReply(
      challengeRefusalText(result.refusal, result.message, { opponent: null, partner: null, opponentPartner: null })
    );
  }
  // A report is never a confirmation, and the reply says who has to act.
  return challengeReply(
    `**Reported.** ${result.opponents.slice(0, 200)} must confirm it on the website before it counts.`
  );
}

/**
 * The /challenge report picker: the caller's accepted, unreported challenges.
 * The focused option sits one level down, under the subcommand.
 */
export async function handleChallengeAutocomplete(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const empty = { type: 8, data: { choices: [] as { name: string; value: string }[] } };
  if (!context.discordUserId) return empty;
  const chosen = subcommand(options);
  const focused = chosen.options?.find((o) => o.focused);
  if (chosen.name !== 'report' || focused?.name !== 'challenge') return empty;

  try {
    const typed = String(focused.value ?? '').trim().toLowerCase();
    const open = await fetchOpenChallenges(context.discordUserId);
    return {
      type: 8,
      data: {
        choices: open
          .filter((challenge) => !typed || challenge.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((challenge) => ({ name: challenge.label.slice(0, 100), value: challenge.id })),
      },
    };
  } catch (error) {
    console.error('[bot] challenge autocomplete failed:', error);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// /receipt
// ---------------------------------------------------------------------------
//
// A member sends the receipt for a club fee: the fee from a picker of their
// own unpaid ones, the screenshot as an attachment, the reference as text. The
// app does the rest exactly as the Membership page does (one pending receipt
// per fee, the method and reference rules, the e-transfer address, the fees
// switch), and it downloads the screenshot itself, from Discord's CDN only.
//
// THE CALLER IS THE MEMBER, read off the interaction, resolved by the app
// through the link table. An unlinked caller is told to link; nothing is ever
// matched by name or email.
//
// NOTHING IS POSTED IN A CHANNEL, and no reply repeats the amount, the
// reference or the picture. Every reply is ephemeral (the deferral fixed it).

const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// An abort can fire after the app has stored the receipt, so this never says
// nothing happened.
const RECEIPT_UNKNOWN =
  "Couldn't get an answer from the club app, so I can't tell whether your receipt went through. " +
  'Check Membership on the club website before you send it again.';

const RECEIPT_NOT_LINKED =
  "Your Discord account isn't linked to a club account yet, so I can't tell whose receipt this is. " +
  'Run `/link`, open the link it gives you and sign in on the club website, then send the receipt again.';

/** The reply for a deferred command: plain content, only the caller sees it. */
function receiptReply(content: string): BotResponse {
  return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
}

/** Turn a refusal into this file's own sentence. */
export function receiptRefusalText(result: Exclude<ReceiptReply, { ok: true }>): string {
  const passed = (fallback: string) => (result.message ? result.message.slice(0, 300) : fallback);
  switch (result.refusal) {
    case 'not_linked':
      return RECEIPT_NOT_LINKED;
    case 'lapsed':
      return 'Your membership was paused for inactivity. Open the club website once to switch it back on, then try again.';
    case 'standing':
      return "Your account can't send receipts right now. The club website says why.";
    case 'feature_off':
      return 'Receipts are switched off in the club right now.';
    case 'waiver':
      return "Accept the club's current legal documents on the website first, then try again.";
    case 'no_login':
      return 'Your club account has no website sign-in yet. Sign in on the club website once, then try again.';
    case 'invalid':
      return passed('Pick the fee from the list.');
    case 'rule':
      return passed('The club app did not accept that receipt.');
    case 'file':
      switch (result.file) {
        case 'too_large':
          return 'That image is over 8 MB. Try a screenshot of just the confirmation.';
        case 'not_image':
          return 'That file is not a JPEG, PNG or WebP image.';
        default:
          return "I couldn't read that attachment. Attach the screenshot again and resend.";
      }
    default:
      return "The club app said no, and this version of the bot doesn't know why. Try the Membership page on the website.";
  }
}

export async function handleReceipt(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  if (!context.discordUserId) return receiptReply("I couldn't tell who ran that. Try again.");

  const feeValue = option(options, 'fee');
  const referenceValue = option(options, 'reference');
  const attachmentId = option(options, 'screenshot');
  const fee = typeof feeValue === 'string' ? feeValue.trim() : '';
  const reference = typeof referenceValue === 'string' ? referenceValue.trim() : '';
  if (!fee) return receiptReply('Pick the fee you paid from the list.');
  if (!reference) return receiptReply('Enter the reference or receipt number.');

  // The attachment's VALUE is an id; the file is in the resolved side table.
  // These checks only make the common mistakes a friendly sentence. The app
  // downloads the file and checks it again from its own bytes, so neither the
  // type nor the size Discord reports here is trusted, and the filename is
  // never read at all.
  const file = attachmentId ? context.attachments?.[String(attachmentId)] : undefined;
  if (!file?.url) return receiptReply('Attach a screenshot of your receipt.');
  const declaredType = (file.content_type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (declaredType && !RECEIPT_TYPES.includes(declaredType)) {
    return receiptReply('That file is not a JPEG, PNG or WebP image.');
  }
  if ((file.size ?? 0) > RECEIPT_MAX_BYTES) {
    return receiptReply('That image is over 8 MB. Try a screenshot of just the confirmation.');
  }

  let result: ReceiptReply;
  try {
    result = await submitReceipt({
      discordUserId: context.discordUserId,
      fee,
      reference,
      attachmentUrl: file.url,
    });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return receiptReply("You've sent several receipts in the last hour. Try again later.");
    }
    console.error('[bot] receipt failed:', error);
    return receiptReply(RECEIPT_UNKNOWN);
  }

  if (!result.ok) return receiptReply(receiptRefusalText(result));
  return receiptReply(
    '**Receipt sent.** An exec checks it, and the Membership page on the club website shows when it is confirmed.'
  );
}

/** The /receipt picker: the caller's own unpaid dues and club event fees. */
export async function handleReceiptAutocomplete(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const empty = { type: 8, data: { choices: [] as { name: string; value: string }[] } };
  if (!context.discordUserId) return empty;
  const focused = options?.find((o) => o.focused);
  if (focused?.name !== 'fee') return empty;

  try {
    const typed = String(focused.value ?? '').trim().toLowerCase();
    const fees = await fetchOwnFees(context.discordUserId);
    return {
      type: 8,
      data: {
        choices: fees
          .filter((fee) => !typed || fee.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((fee) => ({ name: fee.label.slice(0, 100), value: fee.id.slice(0, 100) })),
      },
    };
  } catch (error) {
    console.error('[bot] receipt autocomplete failed:', error);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// /signup
// ---------------------------------------------------------------------------
//
// A new member joins from Discord. The command opens a modal for the details,
// and every screen after it is ONE ephemeral message, edited in place: a
// question with buttons, a legal document a page at a time, then the email
// code. The app holds the answers in a draft (00281) and decides what is asked
// next; this file only draws it.
//
// WHICH ACKNOWLEDGEMENT, AND WHY. The details modal comes from the slash
// command, so its submit has no message yet: it is answered type 5, ephemeral,
// and the reply is written over the "thinking..." placeholder. Every button,
// and the code modal (opened from a button), comes from that message: those
// are answered type 6 and the same message is edited. "Enter code" is the one
// click that answers at once, with type 9, because a modal cannot follow a
// deferral.
//
// NEVER LOG what the member typed: the email, names and phone go to the app
// and nowhere else.

export const SIGNUP_PREFIX = 'signup:';
const SIGNUP_DETAILS_MODAL = 'signup:details';
const SIGNUP_VERIFY_MODAL = 'signup:verify';
const SIGNUP_CANCEL = { type: 2, style: 4, label: 'Cancel sign-up', custom_id: 'signup:cancel' };
const DISCORD_CONTENT_MAX = 2000;
const DISCORD_EMBED_DESCRIPTION_MAX = 4096;

/** True for every /signup button and modal. */
export function isSignupInteraction(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(SIGNUP_PREFIX);
}

/** /signup: the details modal, straight away. */
export function openSignupModal(): BotResponse {
  const input = (
    customId: string,
    label: string,
    required: boolean,
    limits: { min_length?: number; max_length: number },
    placeholder?: string
  ) => ({
    type: 1,
    components: [
      {
        type: 4, // TEXT_INPUT
        custom_id: customId,
        label,
        style: 1, // SHORT
        required,
        ...limits,
        ...(placeholder ? { placeholder } : {}),
      },
    ],
  });
  return {
    type: 9, // MODAL
    data: {
      custom_id: SIGNUP_DETAILS_MODAL,
      title: 'Join the club',
      components: [
        input('email', 'Email', true, { min_length: 3, max_length: 254 }, 'Use your SFU email if you have one. We email you a code.'),
        input('first_name', 'First name', true, { min_length: 1, max_length: 40 }),
        input('last_name', 'Last name', true, { min_length: 1, max_length: 40 }),
        // No min_length on an optional box: the app checks 2 to 40 when it is filled.
        input('display_name', 'Display name (optional)', false, { max_length: 40 }),
        input('phone', 'Phone (optional)', false, { max_length: 20 }),
      ],
    },
  };
}

function signupCodeModal(): BotResponse {
  return {
    type: 9,
    data: {
      custom_id: SIGNUP_VERIFY_MODAL,
      title: 'Enter your code',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'code',
              label: 'The code from the email',
              style: 1,
              required: true,
              min_length: 6,
              max_length: 10,
            },
          ],
        },
      ],
    },
  };
}

function rows(buttons: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (let start = 0; start < buttons.length; start += BUTTONS_PER_ROW) {
    result.push({ type: 1, components: buttons.slice(start, start + BUTTONS_PER_ROW) });
  }
  return result;
}

/** A message body for the edit. Every one clears what the last screen drew. */
function signupMessage(
  content: string,
  buttons: Record<string, unknown>[] = [],
  embeds: Record<string, unknown>[] = []
): Record<string, unknown> {
  return {
    content: content.slice(0, DISCORD_CONTENT_MAX),
    embeds,
    components: rows(buttons),
    flags: 64,
    allowed_mentions: { parse: [] },
  };
}

const SIGNUP_RETRY = { type: 2, style: 1, label: 'Try again', custom_id: 'signup:resume' };

/** Draw a screen the app sent. Exported for the tests. */
export function renderSignupScreen(screen: SignupScreen): Record<string, unknown> {
  switch (screen.kind) {
    case 'choice': {
      const buttons = screen.choices.map((choice) => ({
        type: 2,
        style: screen.step === 'consent' && choice.value === 'no' ? 2 : 1,
        label: choice.label.slice(0, 80),
        custom_id: `signup:${screen.step}:${choice.value}`.slice(0, 100),
      }));
      const content = `${screen.notice ? `${screen.notice}\n\n` : ''}${screen.prompt}`;
      return signupMessage(content, [...buttons, SIGNUP_CANCEL]);
    }
    case 'document': {
      const last = screen.page >= screen.pageCount - 1;
      const buttons: Record<string, unknown>[] = [];
      if (screen.page > 0) {
        buttons.push({ type: 2, style: 2, label: 'Previous', custom_id: `signup:page:${screen.document}:${screen.page - 1}` });
      }
      if (!last) {
        buttons.push({ type: 2, style: 2, label: 'Next', custom_id: `signup:page:${screen.document}:${screen.page + 1}` });
      }
      // Accept only once the member has reached the end.
      if (last) {
        buttons.push({ type: 2, style: 3, label: 'I accept', custom_id: `signup:accept:${screen.document}:${screen.versionTag}` });
      }
      buttons.push(SIGNUP_CANCEL);
      const content =
        screen.notice ??
        (last ? 'Press **I accept** to continue.' : 'Read to the end to accept it.');
      return signupMessage(content, buttons, [
        {
          title: `${screen.title} (version ${screen.version})`.slice(0, 256),
          description: screen.text.slice(0, DISCORD_EMBED_DESCRIPTION_MAX),
          footer: { text: `Page ${screen.page + 1} of ${screen.pageCount}` },
        },
      ]);
    }
    case 'code_sent':
      return signupMessage(
        '**Check your email.** We sent a code to the address you gave. Press **Enter code** and type it in. ' +
          'No email after a minute? Check spam, then press **Resend**.',
        [
          { type: 2, style: 1, label: 'Enter code', custom_id: 'signup:code' },
          { type: 2, style: 2, label: 'Resend', custom_id: 'signup:resend' },
        ]
      );
    case 'done':
      return signupMessage(
        (screen.approved
          ? '**Welcome to the club!** Your account is ready.'
          : '**Account created.** An exec will approve it soon, and the website will tell you when.') +
          (screen.linked
            ? ' Your Discord account is connected to it.'
            : ' Sign in on the website and run `/link` to connect Discord.') +
          ' Sign in on the website to add a passkey, which Discord cannot set up.'
      );
    case 'cancelled':
      return signupMessage(
        screen.codeSent
          ? 'Sign-up cancelled and your answers deleted. Ignore the code we emailed.'
          : 'Sign-up cancelled, nothing was saved.'
      );
    default:
      return signupMessage('This version of the bot cannot show that step. Try signing up on the website.');
  }
}

function signupRefusalMessage(refusal: SignupReply & { ok: false }): Record<string, unknown> {
  const passed = (fallback: string) => (refusal.message ? refusal.message.slice(0, 300) : fallback);
  switch (refusal.refusal) {
    case 'already_linked':
      return signupMessage('This Discord account is already linked to a club account. Sign in on the website.');
    case 'timed_out':
      return signupMessage('Sign-up timed out, run /signup again.');
    case 'incomplete':
      return signupMessage('Your sign-up is missing your name. Run /signup again.');
    case 'invalid':
      return signupMessage(`${passed('Something you entered is not valid.')} Run /signup again to fix it.`);
    case 'rate_limited':
      return signupMessage(passed('Too many tries just now. Wait a few minutes.'), [SIGNUP_RETRY]);
    case 'send_failed':
      return signupMessage("Couldn't send the email just now.", [
        { type: 2, style: 1, label: 'Resend', custom_id: 'signup:resend' },
        SIGNUP_CANCEL,
      ]);
    case 'wrong_code':
      return signupMessage('That code is wrong or has expired.', [
        { type: 2, style: 1, label: 'Enter code', custom_id: 'signup:code' },
        { type: 2, style: 2, label: 'Resend', custom_id: 'signup:resend' },
      ]);
    case 'too_many_attempts':
      return signupMessage('Too many wrong codes. Sign-up cancelled; run /signup again later.');
    case 'in_progress':
      return signupMessage('Your account is already being created. Give it a moment.', [SIGNUP_RETRY]);
    case 'existing_account':
      return signupMessage('This email already has an account. Sign in on the website and use /link.');
    default:
      return signupMessage("The club app said no, and this version of the bot doesn't know why. Try the website.");
  }
}

/** The custom_id and the typed values, as the step the app expects. */
function signupRequest(
  customId: string,
  components: ModalComponent[] | undefined
): Record<string, unknown> | null {
  if (customId === SIGNUP_DETAILS_MODAL) {
    return {
      action: 'details',
      email: modalValue(components, 'email'),
      firstName: modalValue(components, 'first_name'),
      lastName: modalValue(components, 'last_name'),
      displayName: modalValue(components, 'display_name'),
      phone: modalValue(components, 'phone'),
    };
  }
  if (customId === SIGNUP_VERIFY_MODAL) return { action: 'verify', code: modalValue(components, 'code') };

  const [, action, first, second] = customId.split(':');
  switch (action) {
    case 'events':
      return { action, answer: first };
    case 'tier':
      return { action, tier: first };
    case 'page':
      return { action, document: first, page: Number(second) };
    case 'accept':
      return { action, document: first, versionTag: second };
    case 'age':
      return { action };
    case 'consent':
      return { action, consent: first === 'yes' };
    case 'cancel':
    case 'resend':
    case 'resume':
      return { action };
    default:
      return null;
  }
}

/**
 * Any /signup button or modal submit. Returns the acknowledgement, and for
 * everything but "Enter code" a `finish` that index.ts runs and writes over
 * the message.
 */
export function handleSignupInteraction(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
): BotResponse {
  if (customId === 'signup:code') return signupCodeModal();

  const fromCommand = customId === SIGNUP_DETAILS_MODAL;
  const ack: BotResponse = fromCommand ? { type: 5, data: { flags: 64 } } : { type: 6 };
  const callerId = context.discordUserId;
  const request = signupRequest(customId, components);

  return {
    ...ack,
    finish: async () => {
      if (!callerId) return { type: 4, data: signupMessage("I couldn't tell who pressed that. Run /signup again.") };
      if (!request) return { type: 4, data: signupMessage('That button is from an older version. Run /signup again.') };
      try {
        const result = await signupStep({ discordUserId: callerId, ...request } as { discordUserId: string; action: string });
        return { type: 4, data: result.ok ? renderSignupScreen(result.screen) : signupRefusalMessage(result) };
      } catch (error) {
        // The action only: what the member typed stays out of the log.
        console.error(`[bot] signup ${String(request.action)} failed:`, error instanceof Error ? error.message : 'unknown');
        return {
          type: 4,
          data: signupMessage(
            request.action === 'verify'
              ? "Couldn't get an answer from the club app, so I can't tell whether your account was made. " +
                  'Press Try again. If it says the sign-up timed out, try signing in on the website.'
              : "Couldn't reach the club app just now.",
            [SIGNUP_RETRY, SIGNUP_CANCEL]
          ),
        };
      }
    },
  };
}

/**
 * What a handler answers Discord with.
 *
 * `file` is a SIDECAR and is never part of the JSON body. index.ts splits it
 * off and writes a multipart response when it is set; leaving it on would
 * JSON.stringify the raw bytes into the payload, which Discord accepts as a
 * message with a very large content field.
 */
export interface BotResponse {
  type: number;
  data?: Record<string, unknown>;
  file?: CardFile;
  /**
   * The slow half of a command that acknowledged first — see handleProfile.
   *
   * Only ever set beside `type: 5`. index.ts writes the acknowledgement, then
   * runs this and PATCHes whatever it returns over the "thinking..." message.
   * It must not throw: a rejection here is answered publicly with a generic
   * apology, which is worse than any answer it could have returned itself.
   */
  finish?: () => Promise<BotResponse>;
}

// ---------------------------------------------------------------------------
// /schedule
// ---------------------------------------------------------------------------
//
// The caller's own next two weeks, decided and formatted by the app. Deferred
// (see DEFERRED_COMMANDS), so the reply is ephemeral: it carries the member's
// personal calendar feed link.

const SCHEDULE_NOT_LINKED =
  "You haven't linked your Discord account to the club yet. Run `/link` first, then try `/schedule` again.";

export async function handleSchedule(context: InteractionContext): Promise<BotResponse> {
  if (!context.discordUserId) return ephemeral("I couldn't tell who ran that. Try again.");
  const schedule = await fetchSchedule(context.discordUserId);
  if (!schedule.linked) return ephemeral(SCHEDULE_NOT_LINKED);

  const days = schedule.days.map(
    (day) => `**${day.label}**\n${day.items.map((line) => `- ${line}`).join('\n')}`
  );
  const body = days.length > 0 ? days.join('\n\n') : 'Nothing on your schedule in the next two weeks.';
  const links = schedule.calendarUrl ? [`[Open the calendar](${schedule.calendarUrl})`] : [];
  if (schedule.feed) {
    links.push(`Add it to your phone's calendar: <${schedule.feed.webcal}>`);
    links.push(`Or subscribe by URL: <${schedule.feed.https}>`);
  }
  return {
    type: 4,
    data: {
      flags: 64,
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: 'Your next two weeks',
          color: CLUB_RED,
          description: clampDescription([body, links.join('\n')].filter(Boolean).join('\n\n')),
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// CONSOLE COMMANDS ON DISCORD: /session and /event
// ---------------------------------------------------------------------------
//
// Each subcommand calls ONE console action (or read) through adminSend /
// adminGet, as the linked exec. Every rule about what is allowed lives in the
// console; what is here is option plumbing and the words.
//
// ACKNOWLEDGED BY THE HANDLER, NOT BY DEFERRED_COMMANDS. archive, delete and
// cancel open a modal, which a deferred interaction can no longer do. Every
// other subcommand returns { type: 5, flags: 64, finish } and does no network
// work before it, so index.ts writes the ephemeral "thinking..." inside the
// three seconds and PATCHes the answer in afterwards.

export const CONSOLE_NOT_CONFIGURED = 'Console commands are not configured on this bot.';
export const CONSOLE_NOT_AVAILABLE = 'This command is not available yet.';
export const CONSOLE_NOT_LINKED =
  'Run `/link` on your own account first. This command acts as your club account.';
export const CONSOLE_PASSKEY_REQUIRED =
  "Add a console passkey in the console's Settings first. Discord console commands need one on your account.";
const CONSOLE_UNREACHABLE =
  "Couldn't get an answer from the console. Check the console before you try again, in case it went through.";
const CONSOLE_ERROR_MAX = 300;
const CONSOLE_PICKER_TIMEOUT_MS = 900;
const CONSOLE_MODAL_PREFIX = 'cadm:';
const REASON_MIN = 5;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;
const WALL_CLOCK_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;

/** An ephemeral line that can never ping anybody, whatever the text holds. */
function consoleLine(content: string): BotResponse {
  return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
}

/**
 * The words for a console answer that was not a success.
 *
 * The action's own `error` is shown ONLY when it carries a `code`: that is an
 * expected refusal the console already shows people (no permission, account
 * suspended). Anything uncoded may be raw database text, so it becomes a
 * generic line. Capped, and sent with no mentions by consoleLine.
 */
export function consoleRefusalText(reply: Exclude<ConsoleReply<unknown>, { ok: true }>): string {
  if (reply.refusal === 'not_linked') return CONSOLE_NOT_LINKED;
  if (reply.refusal === 'passkey_required') return CONSOLE_PASSKEY_REQUIRED;
  if ('code' in reply && reply.code) {
    const text = String(reply.error ?? '').slice(0, CONSOLE_ERROR_MAX);
    return reply.ref ? `${text} (${reply.code}.${reply.ref})` : text;
  }
  const ref = 'ref' in reply && reply.ref ? ` (ref ${reply.ref})` : '';
  return `Something went wrong running that in the console${ref}.`;
}

/** finish() for a console subcommand: never throws, always answers. */
function consoleFinish(work: () => Promise<string>): BotResponse {
  return {
    type: 5,
    data: { flags: 64 },
    finish: async () => {
      try {
        return consoleLine(await work());
      } catch (error) {
        if (error instanceof ConsoleNotConfiguredError) return consoleLine(CONSOLE_NOT_CONFIGURED);
        if (error instanceof ConsoleNotAvailableError) return consoleLine(CONSOLE_NOT_AVAILABLE);
        console.error('[bot] console command failed:', error);
        return consoleLine(CONSOLE_UNREACHABLE);
      }
    },
  };
}

function stringOption(options: CommandOption[] | undefined, name: string): string | null {
  const value = option(options, name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** "7:00" or "19:00" as "07:00"/"19:00", or null when it is not a time. */
function clockTime(value: string): string | null {
  const m = TIME_PATTERN.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
}

function textModal(input: {
  customId: string;
  title: string;
  fieldId: string;
  label: string;
  placeholder: string;
  minLength: number;
  maxLength: number;
}): BotResponse {
  return {
    type: 9,
    data: {
      custom_id: input.customId,
      title: input.title.slice(0, 45),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: input.fieldId,
              label: input.label.slice(0, 45),
              placeholder: input.placeholder.slice(0, 100),
              style: 2,
              min_length: input.minLength,
              max_length: input.maxLength,
              required: true,
            },
          ],
        },
      ],
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConsoleSession {
  id: string;
  label: string;
  status: string;
  track: string;
  editInput: Record<string, unknown>;
}

interface ConsoleEvent {
  id: string;
  label: string;
  status: string;
  editInput: Record<string, unknown>;
}

function actionPath(name: string): string {
  return `/api/discord/actions/${name}`;
}

/** /session. See the section note above for how it acknowledges. */
export function handleSessionAdmin(
  options: CommandOption[] | undefined,
  context: InteractionContext
): BotResponse {
  const callerId = context.discordUserId;
  if (!callerId) return consoleLine("I couldn't tell who ran that. Try again.");
  if (!process.env.ADMIN_API_URL) return consoleLine(CONSOLE_NOT_CONFIGURED);

  const chosen = subcommand(options);
  const sessionId = stringOption(chosen.options, 'session');
  if (chosen.name !== 'create' && chosen.name !== 'list' && (!sessionId || !UUID_PATTERN.test(sessionId))) {
    return consoleLine('Pick a session from the list.');
  }

  switch (chosen.name) {
    case 'archive':
      return textModal({
        customId: `${CONSOLE_MODAL_PREFIX}sarchive:${sessionId}`,
        title: 'Archive this session',
        fieldId: 'reason',
        label: 'Reason (goes in the club audit log)',
        placeholder: 'Archiving closes the session and ends check-in for it.',
        minLength: REASON_MIN,
        maxLength: 500,
      });
    case 'delete':
      return textModal({
        customId: `${CONSOLE_MODAL_PREFIX}sdelete:${sessionId}`,
        title: 'Delete this session',
        fieldId: 'reason',
        label: 'Reason (goes in the club audit log)',
        placeholder: 'This also deletes every RSVP, attendance mark and check-in link for it.',
        minLength: REASON_MIN,
        maxLength: 500,
      });
    case 'create':
      return sessionCreate(chosen.options, callerId);
    case 'edit':
      return sessionEdit(chosen.options, callerId, sessionId as string);
    case 'list':
      return consoleFinish(async () => {
        const reply = await adminGet<{ sessions: ConsoleSession[] }>('/api/discord/reads/sessions', callerId);
        if (!reply.ok) return consoleRefusalText(reply);
        if (reply.data.sessions.length === 0) return 'No open sessions coming up.';
        return `**Upcoming open sessions**\n${reply.data.sessions.map((s) => `- ${s.label}`).join('\n')}`;
      });
    case 'attendance':
      return consoleFinish(async () => {
        const reply = await adminGet<{
          session: { id: string; label: string } | null;
          going?: number;
          checkedIn?: string[];
        }>(`/api/discord/reads/session-attendance?id=${sessionId}`, callerId);
        if (!reply.ok) return consoleRefusalText(reply);
        if (!reply.data.session) return 'That session no longer exists.';
        const names = reply.data.checkedIn ?? [];
        return (
          `**${reply.data.session.label}**\n` +
          `Going: ${reply.data.going ?? 0}\n` +
          `Checked in: ${names.length}${names.length > 0 ? `\n${names.map((n) => `- ${n}`).join('\n')}` : ''}`
        ).slice(0, 1900);
      });
    case 'checkin': {
      const rotate = option(chosen.options, 'rotate') === true;
      return consoleFinish(async () => {
        const reply = await adminSend<string>(
          actionPath(rotate ? 'rotateSessionCheckinToken' : 'getOrCreateSessionCheckinToken'),
          { discordUserId: callerId, args: [sessionId] }
        );
        if (!reply.ok) return consoleRefusalText(reply);
        const publicBase = process.env.APP_PUBLIC_URL;
        if (!publicBase) return 'The check-in link exists, but APP_PUBLIC_URL is not set on this bot.';
        // A CREDENTIAL. Only ever sent ephemerally, to the exec who asked.
        return (
          `${rotate ? 'New check-in link (the old one no longer works):' : 'Check-in link:'}\n` +
          `${publicBase.replace(/\/+$/, '')}/checkin/${reply.data}\n` +
          'Anyone with this link can check in. Show it as a QR at the door; do not post it in a channel.'
        );
      });
    }
    default:
      return consoleLine('Unknown subcommand.');
  }
}

function sessionCreate(options: CommandOption[] | undefined, callerId: string): BotResponse {
  const date = stringOption(options, 'date');
  const start = clockTime(stringOption(options, 'start') ?? '');
  const end = clockTime(stringOption(options, 'end') ?? '');
  const location = stringOption(options, 'location');
  const track = stringOption(options, 'track');
  const repeatUntil = stringOption(options, 'repeat_weekly_until');
  if (!date || !DATE_PATTERN.test(date)) return consoleLine('The date has to be YYYY-MM-DD.');
  if (!start || !end) return consoleLine('Start and end have to be 24-hour times, like 19:00.');
  if (!location) return consoleLine('Say where the session is.');
  if (repeatUntil && !DATE_PATTERN.test(repeatUntil)) {
    return consoleLine('repeat_weekly_until has to be YYYY-MM-DD.');
  }
  const notes = stringOption(options, 'notes');
  const input = {
    name: stringOption(options, 'name') ?? 'Practice Session',
    date,
    time: start,
    end_time: end,
    location,
    ...(notes ? { notes } : {}),
    track: track ?? 'all',
    ...(repeatUntil ? { repeat_until: repeatUntil, repeat_frequency: 'weekly' } : {}),
  };
  return consoleFinish(async () => {
    const reply = await adminSend<{ sessions: { id: string; date: string }[]; count: number }>(
      actionPath('createSession'),
      { discordUserId: callerId, args: [input] }
    );
    if (!reply.ok) return consoleRefusalText(reply);
    const dates = reply.data.sessions.map((s) => s.date).join(', ');
    return `Created ${reply.data.count} session${reply.data.count === 1 ? '' : 's'}: ${dates}`.slice(0, 1900);
  });
}

function sessionEdit(options: CommandOption[] | undefined, callerId: string, sessionId: string): BotResponse {
  const reason = stringOption(options, 'reason') ?? '';
  if (reason.length < REASON_MIN) return consoleLine(`The reason needs at least ${REASON_MIN} characters.`);
  const date = stringOption(options, 'date');
  const startText = stringOption(options, 'start');
  const endText = stringOption(options, 'end');
  const start = startText ? clockTime(startText) : null;
  const end = endText ? clockTime(endText) : null;
  if (date && !DATE_PATTERN.test(date)) return consoleLine('The date has to be YYYY-MM-DD.');
  if ((startText && !start) || (endText && !end)) {
    return consoleLine('Start and end have to be 24-hour times, like 19:00.');
  }
  const overlay: Record<string, string> = {};
  if (date) overlay.date = date;
  if (start) overlay.time = start;
  if (end) overlay.end_time = end;
  for (const name of ['location', 'track', 'name', 'notes']) {
    const value = stringOption(options, name);
    if (value) overlay[name] = value;
  }
  if (Object.keys(overlay).length === 0) return consoleLine('Fill in at least one thing to change.');

  return consoleFinish(async () => {
    // The console hands back the session as the exact input updateSession
    // takes, so only what the exec typed is overlaid; nothing is blanked.
    const current = await adminGet<{ sessions: ConsoleSession[] }>(
      `/api/discord/reads/sessions?id=${sessionId}`,
      callerId
    );
    if (!current.ok) return consoleRefusalText(current);
    const row = current.data.sessions[0];
    if (!row) return 'That session no longer exists.';
    const reply = await adminSend<void>(actionPath('updateSession'), {
      discordUserId: callerId,
      args: [sessionId, { ...row.editInput, ...overlay }, reason],
    });
    if (!reply.ok) return consoleRefusalText(reply);
    return `Updated: ${row.label}`;
  });
}

/** /event. Same shape as /session. */
export function handleEventAdmin(
  options: CommandOption[] | undefined,
  context: InteractionContext
): BotResponse {
  const callerId = context.discordUserId;
  if (!callerId) return consoleLine("I couldn't tell who ran that. Try again.");
  if (!process.env.ADMIN_API_URL) return consoleLine(CONSOLE_NOT_CONFIGURED);

  const chosen = subcommand(options);
  const eventId = stringOption(chosen.options, 'event');
  if (chosen.name !== 'create' && chosen.name !== 'list' && (!eventId || !UUID_PATTERN.test(eventId))) {
    return consoleLine('Pick an event from the list.');
  }

  switch (chosen.name) {
    case 'cancel':
      return textModal({
        customId: `${CONSOLE_MODAL_PREFIX}ecancel:${eventId}`,
        title: 'Cancel this event',
        fieldId: 'reason',
        label: 'Reason (the people signed up see it)',
        placeholder: 'Everybody signed up is told it is cancelled.',
        minLength: 1,
        maxLength: 500,
      });
    case 'delete':
      return textModal({
        customId: `${CONSOLE_MODAL_PREFIX}edelete:${eventId}`,
        title: 'Delete this event',
        fieldId: 'confirm',
        label: 'Type DELETE to confirm',
        placeholder: 'Only an event nobody has signed up for can be deleted.',
        minLength: 6,
        maxLength: 6,
      });
    case 'create':
      return eventCreate(chosen.options, callerId);
    case 'publish':
      return consoleFinish(async () => {
        const current = await adminGet<{ events: ConsoleEvent[] }>(
          `/api/discord/reads/events?id=${eventId}`,
          callerId
        );
        if (!current.ok) return consoleRefusalText(current);
        const row = current.data.events[0];
        if (!row) return 'That event no longer exists.';
        if (row.status === 'published') return `Already published: ${row.label}`;
        if (row.status === 'cancelled') return 'A cancelled event cannot be published.';
        const reply = await adminSend<void>(actionPath('updateClubEvent'), {
          discordUserId: callerId,
          args: [eventId, { ...row.editInput, publish: true }],
        });
        if (!reply.ok) return consoleRefusalText(reply);
        return `Published: ${row.label}`;
      });
    case 'list':
      return consoleFinish(async () => {
        const reply = await adminGet<{ events: ConsoleEvent[] }>('/api/discord/reads/events', callerId);
        if (!reply.ok) return consoleRefusalText(reply);
        if (reply.data.events.length === 0) return 'No club events coming up.';
        return `**Upcoming club events**\n${reply.data.events.map((e) => `- ${e.label}`).join('\n')}`;
      });
    case 'signups':
      return consoleFinish(async () => {
        const reply = await adminGet<{
          event: { id: string; label: string; capacity: number | null } | null;
          signups?: string[];
        }>(`/api/discord/reads/event-signups?id=${eventId}`, callerId);
        if (!reply.ok) return consoleRefusalText(reply);
        if (!reply.data.event) return 'That event no longer exists.';
        const names = reply.data.signups ?? [];
        const cap = reply.data.event.capacity;
        return (
          `**${reply.data.event.label}**\n` +
          `Signed up: ${names.length}${cap ? ` of ${cap}` : ''}` +
          (names.length > 0 ? `\n${names.map((n) => `- ${n}`).join('\n')}` : '')
        ).slice(0, 1900);
      });
    default:
      return consoleLine('Unknown subcommand.');
  }
}

function eventCreate(options: CommandOption[] | undefined, callerId: string): BotResponse {
  const title = stringOption(options, 'title');
  const kind = stringOption(options, 'kind');
  const starts = WALL_CLOCK_PATTERN.exec(stringOption(options, 'starts') ?? '');
  const endsText = stringOption(options, 'ends');
  const ends = endsText ? WALL_CLOCK_PATTERN.exec(endsText) : null;
  if (!title || !kind) return consoleLine('An event needs a title and a kind.');
  if (!starts) return consoleLine('starts has to be YYYY-MM-DD HH:MM, in club time.');
  if (endsText && !ends) return consoleLine('ends has to be YYYY-MM-DD HH:MM, in club time.');
  const capacity = option(options, 'capacity');
  const cost = option(options, 'cost');
  const publish = option(options, 'publish') === true;
  // clubEventSchema is strict and every field is present: an absent optional
  // is an explicit null, never a missing key.
  const input = {
    title,
    kind,
    description: stringOption(options, 'description'),
    location: stringOption(options, 'location'),
    starts_at: `${starts[1]}T${starts[2]}`,
    ends_at: ends ? `${ends[1]}T${ends[2]}` : null,
    signup_opens_at: null,
    signup_closes_at: null,
    capacity: typeof capacity === 'number' ? capacity : null,
    cost_dollars: typeof cost === 'number' ? cost : null,
    publish,
  };
  return consoleFinish(async () => {
    const reply = await adminSend<{ id: string }>(actionPath('createClubEvent'), {
      discordUserId: callerId,
      args: [input],
    });
    if (!reply.ok) return consoleRefusalText(reply);
    return publish
      ? `Published: ${title}. Members can sign up now.`
      : `Saved as a draft: ${title}. Publish it with /event publish when it is ready.`;
  });
}

export function isConsoleModal(customId: string | undefined | null): boolean {
  return typeof customId === 'string' && customId.startsWith(CONSOLE_MODAL_PREFIX);
}

/**
 * A submitted /session, /event or /tourney modal: `cadm:<action>:<uuid>`. Checked here
 * without a network call, then acknowledged ephemerally and finished like the
 * subcommands, because the console write can outlast the submit's 3 seconds.
 */
export function handleConsoleModal(
  customId: string,
  components: ModalComponent[] | undefined,
  context: InteractionContext
): BotResponse {
  const callerId = context.discordUserId;
  if (!callerId) return consoleLine("I couldn't tell who sent that. Try again.");
  if (!process.env.ADMIN_API_URL) return consoleLine(CONSOLE_NOT_CONFIGURED);
  const [, action, id] = customId.split(':');
  if (!id || !UUID_PATTERN.test(id)) return consoleLine('That form is from an older version. Run the command again.');
  const reason = modalValue(components, 'reason').trim();

  switch (action) {
    case 'sarchive':
    case 'sdelete': {
      if (reason.length < REASON_MIN) return consoleLine(`The reason needs at least ${REASON_MIN} characters.`);
      const archiving = action === 'sarchive';
      return consoleFinish(async () => {
        const reply = await adminSend<void>(actionPath(archiving ? 'archiveSession' : 'deleteSession'), {
          discordUserId: callerId,
          args: [id, reason],
        });
        if (!reply.ok) return consoleRefusalText(reply);
        return archiving ? 'Session archived.' : 'Session deleted, with its RSVPs and attendance.';
      });
    }
    case 'ecancel':
      return consoleFinish(async () => {
        const reply = await adminSend<void>(actionPath('cancelClubEvent'), {
          discordUserId: callerId,
          args: [id, reason],
        });
        if (!reply.ok) return consoleRefusalText(reply);
        return 'Event cancelled. Everybody signed up has been told.';
      });
    case 'tsuspend': {
      if (reason.length < TOURNEY_SUSPEND_REASON_MIN) {
        return consoleLine(`The reason needs at least ${TOURNEY_SUSPEND_REASON_MIN} characters.`);
      }
      return consoleFinish(async () => {
        const reply = await adminSend<void>(actionPath('suspendTournament'), {
          discordUserId: callerId,
          args: [id, reason],
        });
        if (!reply.ok) return consoleRefusalText(reply);
        return 'Play suspended. Members see the reason on the tournament page until you resume.';
      });
    }
    case 'edelete': {
      if (modalValue(components, 'confirm').trim().toUpperCase() !== 'DELETE') {
        return consoleLine('Nothing was deleted. Type DELETE to confirm.');
      }
      return consoleFinish(async () => {
        // Said in words before the console refuses it without a code: an event
        // with sign-ups is cancelled, never deleted.
        const signups = await adminGet<{ event: unknown; signups?: string[] }>(
          `/api/discord/reads/event-signups?id=${id}`,
          callerId
        );
        if (!signups.ok) return consoleRefusalText(signups);
        if ((signups.data.signups ?? []).length > 0) {
          return 'People have signed up for this event, so it cannot be deleted. Use `/event cancel` so they are told.';
        }
        const reply = await adminSend<void>(actionPath('deleteClubEvent'), {
          discordUserId: callerId,
          args: [id],
        });
        if (!reply.ok) return consoleRefusalText(reply);
        return 'Event deleted.';
      });
    }
    default:
      return consoleLine('That form is from an older version. Run the command again.');
  }
}

/** The /session pickers: the session itself, or a location used before. */
export async function handleSessionAutocomplete(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const empty = { type: 8, data: { choices: [] as { name: string; value: string }[] } };
  if (!context.discordUserId || !process.env.ADMIN_API_URL) return empty;
  const chosen = subcommand(options);
  const focused = chosen.options?.find((o) => o.focused);
  const typed = encodeURIComponent(String(focused?.value ?? '').trim().slice(0, 80));
  try {
    if (focused?.name === 'session') {
      const reply = await adminGet<{ sessions: ConsoleSession[] }>(
        `/api/discord/reads/sessions?q=${typed}`,
        context.discordUserId,
        CONSOLE_PICKER_TIMEOUT_MS
      );
      if (!reply.ok) return empty;
      return {
        type: 8,
        data: {
          choices: reply.data.sessions
            .slice(0, SELECT_OPTIONS_MAX)
            .map((s) => ({ name: s.label.slice(0, 100), value: s.id })),
        },
      };
    }
    if (focused?.name === 'location') {
      const reply = await adminGet<{ locations: string[] }>(
        `/api/discord/reads/locations?q=${typed}`,
        context.discordUserId,
        CONSOLE_PICKER_TIMEOUT_MS
      );
      if (!reply.ok) return empty;
      return {
        type: 8,
        data: {
          choices: reply.data.locations
            .slice(0, SELECT_OPTIONS_MAX)
            .map((label) => ({ name: label.slice(0, 100), value: label.slice(0, 100) })),
        },
      };
    }
  } catch (error) {
    console.error('[bot] session picker failed:', error instanceof Error ? error.message : 'unknown');
  }
  return empty;
}

/** The /event picker. */
export async function handleEventAutocomplete(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const empty = { type: 8, data: { choices: [] as { name: string; value: string }[] } };
  if (!context.discordUserId || !process.env.ADMIN_API_URL) return empty;
  const chosen = subcommand(options);
  const focused = chosen.options?.find((o) => o.focused);
  if (focused?.name !== 'event') return empty;
  const typed = encodeURIComponent(String(focused.value ?? '').trim().slice(0, 80));
  try {
    const reply = await adminGet<{ events: ConsoleEvent[] }>(
      `/api/discord/reads/events?q=${typed}`,
      context.discordUserId,
      CONSOLE_PICKER_TIMEOUT_MS
    );
    if (!reply.ok) return empty;
    return {
      type: 8,
      data: {
        choices: reply.data.events
          .slice(0, SELECT_OPTIONS_MAX)
          .map((e) => ({ name: e.label.slice(0, 100), value: e.id })),
      },
    };
  } catch (error) {
    console.error('[bot] event picker failed:', error instanceof Error ? error.message : 'unknown');
    return empty;
  }
}

// ---------------------------------------------------------------------------
// CONSOLE COMMANDS ON DISCORD: /tourney
// ---------------------------------------------------------------------------
//
// Running a tournament on the day, as the linked exec, through the console's
// own tournament actions. Acknowledged like /session: suspend opens a modal,
// every other subcommand returns consoleFinish.
//
// THE PICKERS ARE CHAINED. Every subcommand picks the tournament first, and the
// entry, match and player pickers read its value off the same interaction, so
// a match from another tournament is never offered. A value that is not a uuid
// (typed rather than picked) gets no choices.

const TOURNEY_SCORE_ORDER = 'side A first, as shown in the picker';
const TOURNEY_SUSPEND_REASON_MIN = 2;
const TOURNEY_ENTRY_PATTERN =
  /^(p|pr):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface TourneyMatch {
  id: string;
  label: string;
  sideA: string;
  sideB: string;
  status: string;
}

const STATUS_WORDS: Record<string, string> = {
  draft: 'a draft',
  active: 'active',
  completed: 'completed',
  archived: 'archived',
};

/** One match of this tournament, any status, for the names in a reply. */
async function tourneyMatch(
  callerId: string,
  tournamentId: string,
  matchId: string
): Promise<ConsoleReply<TourneyMatch | null>> {
  const reply = await adminGet<{ matches: TourneyMatch[] }>(
    `/api/discord/reads/tournament-matches?tournamentId=${tournamentId}&id=${matchId}`,
    callerId
  );
  if (!reply.ok) return reply;
  return { ok: true, data: reply.data.matches.find((m) => m.id === matchId) ?? null };
}

/** /tourney. See the section note above. */
export function handleTourney(options: CommandOption[] | undefined, context: InteractionContext): BotResponse {
  const callerId = context.discordUserId;
  if (!callerId) return consoleLine("I couldn't tell who ran that. Try again.");
  if (!process.env.ADMIN_API_URL) return consoleLine(CONSOLE_NOT_CONFIGURED);

  const chosen = subcommand(options);
  const tournamentId = stringOption(chosen.options, 'tournament');
  if (!tournamentId || !UUID_PATTERN.test(tournamentId)) return consoleLine('Pick a tournament from the list.');

  const send = (name: string, args: unknown[], done: string) =>
    consoleFinish(async () => {
      const reply = await adminSend<unknown>(actionPath(name), { discordUserId: callerId, args });
      if (!reply.ok) return consoleRefusalText(reply);
      return done;
    });

  switch (chosen.name) {
    case 'checkin':
    case 'noshow':
    case 'undo-checkin': {
      const entry = TOURNEY_ENTRY_PATTERN.exec(stringOption(chosen.options, 'entry') ?? '');
      if (!entry) return consoleLine('Pick a player or pair from the list.');
      const isPair = entry[1] === 'pr';
      const entryId = entry[2];
      if (chosen.name === 'checkin') {
        return send(isPair ? 'checkInPair' : 'checkInParticipant', [entryId], 'Checked in.');
      }
      if (chosen.name === 'noshow') {
        return send(isPair ? 'markPairNoShow' : 'markParticipantNoShow', [entryId], 'Marked as a no-show.');
      }
      return send('undoCheckIn', [entryId, isPair], 'Check-in undone.');
    }
    case 'result':
    case 'walkover':
    case 'court':
    case 'live':
      return tourneyMatchCommand(chosen.name, chosen.options, callerId, tournamentId);
    case 'status': {
      const status = stringOption(chosen.options, 'status') ?? '';
      if (!STATUS_WORDS[status]) return consoleLine('Pick a status from the list.');
      return send('updateTournamentStatus', [tournamentId, status], `The tournament is ${STATUS_WORDS[status]} now.`);
    }
    case 'suspend':
      return textModal({
        customId: `${CONSOLE_MODAL_PREFIX}tsuspend:${tournamentId}`,
        title: 'Suspend play',
        fieldId: 'reason',
        label: 'Reason (members see it)',
        placeholder: 'Members see this on the tournament page until you resume.',
        minLength: TOURNEY_SUSPEND_REASON_MIN,
        maxLength: 500,
      });
    case 'resume':
      return send('resumeTournament', [tournamentId], 'Play resumed.');
    case 'fee': {
      const playerId = stringOption(chosen.options, 'player');
      if (!playerId || !UUID_PATTERN.test(playerId)) return consoleLine('Pick a player from the list.');
      if (stringOption(chosen.options, 'state') === 'unpaid') {
        return send('markTournamentFeeUnpaid', [tournamentId, playerId], 'Fee marked unpaid.');
      }
      const method = stringOption(chosen.options, 'method');
      return send(
        'markTournamentFeePaid',
        [{ tournament_id: tournamentId, player_id: playerId, ...(method ? { method } : {}) }],
        'Fee marked paid.'
      );
    }
    case 'checkin-link': {
      const rotate = stringOption(chosen.options, 'action') === 'rotate';
      return consoleFinish(async () => {
        const reply = await adminSend<string>(
          actionPath(rotate ? 'rotateTournamentCheckinToken' : 'getOrCreateTournamentCheckinToken'),
          { discordUserId: callerId, args: [tournamentId] }
        );
        if (!reply.ok) return consoleRefusalText(reply);
        const publicBase = process.env.APP_PUBLIC_URL;
        if (!publicBase) return 'The check-in link exists, but APP_PUBLIC_URL is not set on this bot.';
        // A CREDENTIAL. Only ever sent ephemerally, to the exec who asked, and
        // never logged.
        return (
          `${rotate ? 'New check-in link (the old one no longer works):' : 'Check-in link:'}\n` +
          `${publicBase.replace(/\/+$/, '')}/tournaments/checkin?token=${encodeURIComponent(reply.data)}\n` +
          'Anyone with this link can check in. Show it as a QR at the desk; do not post it in a channel.'
        );
      });
    }
    default:
      return consoleLine('Unknown subcommand.');
  }
}

function tourneyMatchCommand(
  name: 'result' | 'walkover' | 'court' | 'live',
  options: CommandOption[] | undefined,
  callerId: string,
  tournamentId: string
): BotResponse {
  const matchId = stringOption(options, 'match');
  if (!matchId || !UUID_PATTERN.test(matchId)) return consoleLine('Pick a match from the list.');

  // Everything that can be refused without the console is refused here, so
  // nothing is read for a reply that was always going to be no.
  let args: unknown[];
  let done: (match: TourneyMatch) => string;
  if (name === 'result') {
    const parsed = parseGameScores(stringOption(options, 'scores') ?? '', TOURNEY_SCORE_ORDER);
    if (!parsed.ok) return consoleLine(parsed.message);
    const wonA = parsed.games.filter(([a, b]) => a > b).length;
    const wonB = parsed.games.length - wonA;
    if (wonA === wonB) return consoleLine('Both sides won the same number of games. Enter every game played.');
    args = [matchId, parsed.games.map(([a, b]) => ({ a, b }))];
    const score = parsed.games.map(([a, b]) => `${a}-${b}`).join(' ');
    done = (m) => `Recorded: ${m.sideA} ${score} ${m.sideB}`;
  } else if (name === 'walkover') {
    const winner = stringOption(options, 'winner');
    const reason = stringOption(options, 'reason') ?? '';
    if (winner !== 'a' && winner !== 'b') return consoleLine('Pick side A or side B.');
    if (reason.length < REASON_MIN) return consoleLine(`The reason needs at least ${REASON_MIN} characters.`);
    args = [matchId, winner, reason];
    done = (m) => `Walkover recorded: ${winner === 'a' ? m.sideA : m.sideB} goes through.`;
  } else if (name === 'court') {
    const court = stringOption(options, 'court');
    if (!court) return consoleLine('Say which court.');
    args = [matchId, court];
    done = (m) => `${m.sideA} v ${m.sideB}: Court ${court}.`;
  } else {
    const start = stringOption(options, 'state') === 'start';
    args = [matchId, start];
    done = (m) => `${m.sideA} v ${m.sideB}: ${start ? 'on court now' : 'no longer live'}.`;
  }
  const action = {
    result: 'enterMatchResultFromScores',
    walkover: 'enterWalkover',
    court: 'setMatchCourt',
    live: 'setMatchLive',
  }[name];

  return consoleFinish(async () => {
    // Read first: it names the sides for the reply, and it is how a match from
    // another tournament is refused before anything is written.
    const match = await tourneyMatch(callerId, tournamentId, matchId);
    if (!match.ok) return consoleRefusalText(match);
    if (!match.data) return 'That match is not in this tournament. Pick one from the list.';
    const reply = await adminSend<unknown>(actionPath(action), { discordUserId: callerId, args });
    if (!reply.ok) return consoleRefusalText(reply);
    return done(match.data);
  });
}

/** The /tourney pickers, chained off the tournament already picked. */
export async function handleTourneyAutocomplete(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const empty = { type: 8, data: { choices: [] as { name: string; value: string }[] } };
  if (!context.discordUserId || !process.env.ADMIN_API_URL) return empty;
  const chosen = subcommand(options);
  const focused = chosen.options?.find((o) => o.focused);
  const typed = encodeURIComponent(String(focused?.value ?? '').trim().slice(0, 80));
  const tournamentId = String(option(chosen.options, 'tournament') ?? '');
  const choicesFrom = (rows: { name: string; value: string }[]) => ({
    type: 8,
    data: {
      choices: rows
        .slice(0, SELECT_OPTIONS_MAX)
        .map((r) => ({ name: r.name.slice(0, 100), value: r.value.slice(0, 100) })),
    },
  });
  try {
    if (focused?.name === 'tournament') {
      const reply = await adminGet<{ tournaments: { id: string; label: string }[] }>(
        `/api/discord/reads/tournaments?q=${typed}`,
        context.discordUserId,
        CONSOLE_PICKER_TIMEOUT_MS
      );
      if (!reply.ok) return empty;
      return choicesFrom(reply.data.tournaments.map((t) => ({ name: t.label, value: t.id })));
    }
    if (!UUID_PATTERN.test(tournamentId)) return empty;
    const scope = `tournamentId=${tournamentId}&q=${typed}`;
    if (focused?.name === 'entry') {
      const reply = await adminGet<{ entries: { value: string; label: string }[] }>(
        `/api/discord/reads/tournament-entries?${scope}`,
        context.discordUserId,
        CONSOLE_PICKER_TIMEOUT_MS
      );
      if (!reply.ok) return empty;
      return choicesFrom(reply.data.entries.map((e) => ({ name: e.label, value: e.value })));
    }
    if (focused?.name === 'match') {
      const reply = await adminGet<{ matches: TourneyMatch[] }>(
        `/api/discord/reads/tournament-matches?${scope}`,
        context.discordUserId,
        CONSOLE_PICKER_TIMEOUT_MS
      );
      if (!reply.ok) return empty;
      return choicesFrom(reply.data.matches.map((m) => ({ name: m.label, value: m.id })));
    }
    if (focused?.name === 'player') {
      const reply = await adminGet<{ fees: { playerId: string; label: string }[] }>(
        `/api/discord/reads/tournament-fees?${scope}`,
        context.discordUserId,
        CONSOLE_PICKER_TIMEOUT_MS
      );
      if (!reply.ok) return empty;
      return choicesFrom(reply.data.fees.map((f) => ({ name: f.label, value: f.playerId })));
    }
  } catch (error) {
    console.error('[bot] tourney picker failed:', error instanceof Error ? error.message : 'unknown');
  }
  return empty;
}

const MANAGE_GUILD_BIT = 1n << 5n;
const ADMINISTRATOR_BIT = 1n << 3n;

/** Manage Server or Administrator, from the caller's own mask. Missing or unreadable is no. */
export function canManageServer(permissions: string | null | undefined): boolean {
  if (!permissions) return false;
  try {
    return (BigInt(permissions) & (MANAGE_GUILD_BIT | ADMINISTRATOR_BIT)) !== 0n;
  } catch {
    return false;
  }
}

/**
 * /server: the settings that belong to the server it is typed in (00302).
 *
 * THE SERVER IS ALWAYS THIS ONE. Every write names context.guildId, and the
 * log channel is a channel option, which Discord only fills from this server,
 * so nobody can point another server's log, or the club's, anywhere.
 *
 * Who may: Manage Server here, re-checked from the caller's own mask because
 * a server admin can open any command to anyone. In a club server, also the
 * club check /config uses, since a Discord admin there is not enough.
 */
export async function handleServer(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const { guildId, discordUserId } = context;
  if (!guildId || !discordUserId) return ephemeral('Run /server in the server you want to change.');
  if (!canManageServer(context.permissions)) {
    return ephemeral("You need the Manage Server permission in this server to change its bot settings.");
  }
  const caller = { discordUserId, guildId };
  const { name: sub, options: args } = subcommand(options);

  if (sub === 'show') {
    const { servers } = await fetchServerSettings();
    const mine = servers.find((row) => row.guildId === guildId);
    const { scopes } = parseServerLogScopes(process.env.DISCORD_SERVER_LOG);
    const logLine = mine?.serverLogChannelId
      ? `posts in <#${mine.serverLogChannelId}>`
      : 'off. Turn it on with **/server log**';
    const guardLine = mine?.scamGuard ? 'on' : 'off';
    const lines = [`**Server log:** ${logLine}`, `**Scam guard:** ${guardLine}`];
    // The scopes are the bot's, not the server's, so say when they make a
    // setting here do nothing rather than letting it look broken.
    if (scopes.size === 0) lines.push('The server log is switched off for this bot, so nothing is logged anywhere.');
    else if (!scopes.has('scam') && mine?.scamGuard) lines.push('The scam guard is switched off for this bot, so it does nothing yet.');
    return ephemeral(lines.join('\n'));
  }

  if (await isClubServer(guildId)) {
    const refusal = await checkDiscordManager(caller);
    if (refusal) return ephemeral(managerRefusalText(refusal));
  }

  if (sub === 'log') {
    const channelId = String(option(args, 'channel') ?? '');
    if (!channelId) return ephemeral('Pick a channel.');
    await writeServerSettings(caller, { serverLogChannelId: channelId });
    return ephemeral(
      `This server's log now posts in <#${channelId}>. Make sure I can see and post there. ` +
        'It includes the text of deleted and edited messages, so keep it to moderators.'
    );
  }
  if (sub === 'log_off') {
    await writeServerSettings(caller, { serverLogChannelId: null });
    return ephemeral("This server's log is off. Nothing is posted until you set a channel again.");
  }
  if (sub === 'scam_guard') {
    const enabled = option(args, 'enabled') === true;
    await writeServerSettings(caller, { scamGuard: enabled });
    return ephemeral(
      enabled
        ? 'Scam guard on. An account posting the same thing in several channels within two minutes is soft-banned: ' +
            'removed, its last hour of messages deleted, and free to rejoin. A lone giveaway post is only flagged in the server log. ' +
            'Moderators are never touched. I need Ban Members, and my role above theirs.'
        : 'Scam guard off. Nobody is soft-banned automatically in this server.'
    );
  }
  return ephemeral('Use **/server show**, **/server log**, **/server log_off** or **/server scam_guard**.');
}

export async function handleSoftban(
  options: CommandOption[] | undefined,
  context: InteractionContext
): Promise<BotResponse> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const targetId = stringOption(options, 'member');
  if (!context.guildId || !context.discordUserId) {
    return ephemeral('Run /softban in the server.');
  }
  if (!targetId) return ephemeral('Pick who to soft-ban.');
  if (!token) {
    console.error('[bot] /softban: DISCORD_BOT_TOKEN is not set');
    return ephemeral('The bot is not set up to do that right now.');
  }

  const deleteSeconds = windowSeconds(stringOption(options, 'delete') ?? undefined);
  const reason = stringOption(options, 'reason') ?? 'No reason given';
  const api = new DiscordApi({ token });
  const outcome = await softban(api, {
    guildId: context.guildId,
    callerId: context.discordUserId,
    callerRoles: context.memberRoles ?? [],
    callerPermissions: context.permissions,
    targetId,
    deleteSeconds,
    reason,
  });
  if (!outcome.ok) return ephemeral(outcome.message);

  const windowLabel = describeWindow(deleteSeconds);
  // The audit channel is the club's: a soft-ban in somebody else's server is
  // theirs, and a config read that fails must not turn a done ban into an error.
  const auditTo = (await isClubServer(context.guildId)) ? (await loadConfig()).auditChannelId : undefined;
  await postAuditEntry(api, auditTo, {
    kind: 'softban',
    moderatorId: context.discordUserId,
    targetId,
    deleteSeconds,
    windowLabel,
    reason,
    unbanned: outcome.unbanned,
  });

  return ephemeral(
    outcome.unbanned
      ? `Soft-banned <@${targetId}>: removed, messages from the ${windowLabel} deleted. They can rejoin with the invite.`
      : `<@${targetId}> was banned and their messages deleted, but **the unban failed, so they are still banned**. ` +
          'Lift it in Server Settings > Bans.'
  );
}

export async function dispatch(
  name: string,
  options: CommandOption[] | undefined,
  context: InteractionContext = { discordUserId: null, guildId: null }
): Promise<BotResponse> {
  try {
    switch (name) {
      case 'leaderboard':
        return await handleLeaderboard(options);
      case 'profile':
        return await handleProfile(options, context);
      case 'sessions':
        return await handleSessions(context);
      case 'sessionpost':
        return await handleSessionPost();
      case 'tournaments':
        return await handleTournaments(context, options);
      case 'rolepicker':
        return await handleRolePicker(options, context);
      case 'guidepost':
        return handleGuidePost(context);
      case 'discord':
        return handleDiscordInvite();
      case 'socials':
        return await handleSocials();
      case 'announce':
        return openAnnounceModal(options);
      case 'say':
        return openSayModal(options, context);
      case 'bug':
        return openReportModal('bug', options, context);
      case 'feedback':
        return openReportModal(null, options, context);
      case 'link':
        return await handleLink(context);
      case 'unlink':
        return await handleUnlink(context);
      case 'forcelink':
        return await handleForceLink(options, context);
      case 'forceunlink':
        return await handleForceUnlink(options, context);
      case 'forceupdate':
        return await handleForceUpdate(options, context);
      case 'setup':
        return await handleSetup(options, context);
      case 'config':
        return await handleConfig(options, context);
      case 'challenge':
        return await handleChallenge(options, context);
      case 'signup':
        return openSignupModal();
      case 'receipt':
        return await handleReceipt(options, context);
      case 'schedule':
        return await handleSchedule(context);
      case 'session':
        return handleSessionAdmin(options, context);
      case 'event':
        return handleEventAdmin(options, context);
      case 'tourney':
        return handleTourney(options, context);
      case 'softban':
        return await handleSoftban(options, context);
      case 'server':
        return await handleServer(options, context);
      default:
        return ephemeral('Unknown command.');
    }
  } catch (err) {
    // Log the real reason, tell the user something true and non-technical. An
    // AppApiError means the app answered badly or not at all; anything else is a
    // bug here. Neither should put a status code or a stack in a channel.
    console.error(`[bot] ${name} failed:`, err);
    return ephemeral(
      err instanceof AppApiError
        ? "Couldn't reach the club app just now — try again in a moment."
        : 'Something went wrong running that command.'
    );
  }
}
