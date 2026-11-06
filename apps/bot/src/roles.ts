// app state -> the set of Discord roles a member should hold.
//
// One direction only, FOR EVERY ROLE THAT CARRIES PERMISSION. Nothing here ever
// reads @Executives, @VP, @Session Staff, @Competitive or @Recreation back into
// the app: if it did, anyone who can edit roles in a Discord server would be
// able to promote themselves inside the club, and Discord role edits are not
// audited the way the app's permission changes are. See docs/design/discord-bot.md §5.
//
// THE THREE MEMBERSHIP ROLES ARE THE DELIBERATE EXCEPTION, and it is an
// exception the club asked for: @Internal, @Alumni and @External are now
// MEMBERS' OWN to pick, so the sweep neither asserts nor strips them
// (MEMBERSHIP_ROLES below). The member's own pick still writes through to
// players.membership_type when they click the button, while the sweep no longer
// reasserts membership, so the console stays authoritative between clicks. They
// are the exception because they grant nothing inside the app: they price a
// tournament entry and decide which events a member may enter, which an exec
// can see and correct in the console. Nothing else about this file changes
// direction.
//
// This module is deliberately pure — no fetch, no Discord client, no clock. The
// whole of the interesting logic (who gets what, and what a sync should change)
// is decided here so it can be tested without a guild, a token or a database.

/**
 * The roles this bot manages. `admin` is NOT in this list and must never be:
 * it is managed by hand in Discord, it carries a lock icon a bot cannot assign
 * anyway, and `players.role = 'admin'` (or `'super_admin'`, 00321) grants the
 * console on the app side without needing a Discord mirror.
 */
export const MANAGED_ROLES = [
  'linked',
  'session_staff',
  'vp',
  'executives',
  'competitive',
  'recreation',
  'internal',
  'alumni',
  'external',
] as const;

export type ManagedRole = (typeof MANAGED_ROLES)[number];

/**
 * The roles a member chooses for themselves, which the sweep therefore must
 * never touch.
 *
 * They stay in MANAGED_ROLES — the registry still has to be able to NAME them,
 * because knowing that role 123 is this guild's @Alumni is exactly what makes
 * the write-back possible, and because parseGuildRegistry rejects a role name
 * it does not know, so dropping them here would stop a bot booting on an
 * unchanged DISCORD_GUILDS.
 */
export const MEMBERSHIP_ROLES = ['internal', 'alumni', 'external'] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * What the nightly sweep actually reconciles.
 *
 * roleDiff iterates THIS, not MANAGED_ROLES, and that is the whole mechanism
 * keeping the sweep off a member's own choice. Leaving the three in the
 * iteration and merely dropping them from desiredRoles() would have been WORSE
 * than doing nothing: a role the diff knows about and does not want is one it
 * REMOVES, so the sweep would have stripped every membership role in the server
 * at 10:50 UTC instead of merely overwriting it.
 */
export const SWEPT_ROLES = MANAGED_ROLES.filter(
  (role): role is Exclude<ManagedRole, MembershipRole> =>
    !(MEMBERSHIP_ROLES as readonly string[]).includes(role)
);

export function isMembershipRole(role: string): role is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(role);
}

/**
 * What the app reports about a linked member. Mirrors the payload of
 * `/api/discord/member`; every field is what the APP believes, never what
 * Discord believes.
 */
export interface MemberState {
  status: 'competitive' | 'recreational' | 'pending_approval' | 'suspended';
  membershipType: 'internal' | 'alumni' | 'external';
  isExec: boolean;
  isBanned: boolean;
  /**
   * The heir of the old `players.portfolio`, which was created in 00086 and
   * dropped again in 00087 — the spec's original "VP = portfolio IS NOT NULL"
   * names a column that has not existed since. `custom` is present in the union
   * because it is a storable value, but it is not a VP job; access-level.ts
   * says so in as many words ("`custom` IS NOT A FIFTH VP JOB. It is the empty
   * base"), so it does not earn the role.
   */
  permissionRole: 'finance' | 'tournaments' | 'internal' | 'external' | 'custom' | null;
  /** Resolved app capabilities, already flattened by the app's own resolver. */
  capabilities: string[];
}

// Session staff is the pair, not either half: running check-in needs both the
// attendance write and the token that opens the door. Someone holding only one
// of them is mid-configuration, not staff.
const SESSION_STAFF_CAPABILITIES = [
  'sessions.attendance.write',
  'sessions.checkin.token.write',
];

// The four named jobs, minus `custom` — see MemberState.permissionRole.
const VP_ROLES = ['finance', 'tournaments', 'internal', 'external'];

/**
 * Which managed roles a linked member should hold.
 *
 * Two policies are applied here that the spec did not state outright, both of
 * which follow from its own rule that a role disappears when the app permission
 * behind it does:
 *
 *  - A BANNED member keeps only `linked`. A ban is the club withdrawing access;
 *    leaving them holding `@Internal` would leave the member-only channels open
 *    to exactly the person who was just removed from them. The membership roles
 *    are not in this set at all any more, so the ban takes them off through
 *    `roleDiff`'s `revokeMembership` instead — see DiffOptions.
 *  - A `pending_approval` member gets no team role. Signing up is not the club
 *    letting you in — the same reason the guard refuses a self-created row that
 *    arrives already approved, and the same reason the owner asked for pending
 *    signups to stay off the ladder.
 *
 * Both are visible in the role diff, so getting them wrong is repairable by
 * changing this function and letting the sweep run; neither silently persists.
 */
export function desiredRoles(state: MemberState): Set<ManagedRole> {
  // Linking is a fact about the account, not a permission, so it survives every
  // other condition below — including a ban. It is what tells the sweep that a
  // member is known at all.
  const roles = new Set<ManagedRole>(['linked']);
  if (state.isBanned) return roles;

  const approved = state.status !== 'pending_approval';

  if (state.isExec) roles.add('executives');
  if (state.isExec && state.permissionRole !== null && VP_ROLES.includes(state.permissionRole)) {
    roles.add('vp');
  }
  if (SESSION_STAFF_CAPABILITIES.every((c) => state.capabilities.includes(c))) {
    roles.add('session_staff');
  }

  if (approved && state.status === 'competitive') roles.add('competitive');
  if (approved && state.status === 'recreational') roles.add('recreation');

  // NO MEMBERSHIP ROLE IS ASSERTED HERE ANY MORE. @Internal / @Alumni /
  // @External are the member's own pick (MEMBERSHIP_ROLES), so the app has an
  // opinion about what they MEAN — membership_type follows the pick — but none
  // about who should hold one. Adding them back to this set would do nothing on
  // its own, since roleDiff iterates SWEPT_ROLES; both would have to change.
  return roles;
}

/** Role IDs for one guild. A role the guild has not configured is absent. */
export type GuildRoleMap = Partial<Record<ManagedRole, string>>;

export type GuildRegistry = Map<string, GuildRoleMap>;

/**
 * Parse DISCORD_GUILDS, which is a JSON object of guild id -> role name -> role id:
 *
 *   {"1234": {"linked": "999", "executives": "888"}}
 *
 * Config, not schema, but deliberately not hardcoded: the bot serves more than
 * one guild and joining another is a config change, not a code change.
 *
 * Unknown role names are REJECTED rather than ignored. A typo'd key that parses
 * silently is a role that never syncs and never reports why, which is the
 * failure mode this whole registry exists to avoid.
 */
export function parseGuildRegistry(raw: string | undefined): GuildRegistry {
  const registry: GuildRegistry = new Map();
  if (!raw || raw.trim() === '') return registry;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DISCORD_GUILDS is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DISCORD_GUILDS must be a JSON object of guild id -> role map');
  }

  for (const [guildId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`DISCORD_GUILDS: guild ${guildId} must map to an object`);
    }
    const roleMap: GuildRoleMap = {};
    for (const [name, id] of Object.entries(value as Record<string, unknown>)) {
      if (!(MANAGED_ROLES as readonly string[]).includes(name)) {
        throw new Error(`DISCORD_GUILDS: guild ${guildId} names an unmanaged role "${name}"`);
      }
      if (typeof id !== 'string' || id === '') {
        throw new Error(`DISCORD_GUILDS: guild ${guildId} role "${name}" must be a role id string`);
      }
      roleMap[name as ManagedRole] = id;
    }
    registry.set(guildId, roleMap);
  }

  return registry;
}

export interface DiffOptions {
  /**
   * Take the membership roles OFF as well.
   *
   * THE ASYMMETRY IS THE POINT, and it is the difference between the two things
   * that can put a membership role on somebody: a member choosing one, and the
   * club having granted it. Nothing ever ADDS one — that is the member's own
   * call now. But a BAN or a tombstone is the club revoking access, not a
   * member changing their mind, and member-only channel visibility in this
   * server IS @Internal + @Alumni (see the role table in
   * docs/design/discord-bot.md §5). Leaving them on would leave the member
   * channels open to exactly the person who was just removed from them, and
   * would let a tombstone be reported clean while a role was still on the
   * account.
   */
  revokeMembership?: boolean;
}

export interface RoleDiff {
  /** Role IDs to add. */
  add: string[];
  /** Role IDs to remove. */
  remove: string[];
}

/**
 * What to change for one member in one guild.
 *
 * `desired` is null for someone who is not linked (or no longer resolves to a
 * player): every managed role comes off, which is what makes `/unlink` and a
 * lapsed account the same code path.
 *
 * ONLY ROLES THIS GUILD HAS CONFIGURED ARE EVER TOUCHED. A role the registry
 * does not name is invisible to the diff, so `Admin`, and every unrelated role
 * the server happens to use, are safe by construction rather than by a
 * blocklist that a future role could fall outside of.
 *
 * The three membership roles are invisible to it for the same structural
 * reason: the loop is over SWEPT_ROLES. Never added, and not removed either
 * unless `revokeMembership` says the club is withdrawing access — see
 * DiffOptions, which is where that asymmetry is argued.
 */
export function roleDiff(
  desired: Set<ManagedRole> | null,
  guildRoles: GuildRoleMap,
  currentRoleIds: readonly string[],
  options: DiffOptions = {}
): RoleDiff {
  const held = new Set(currentRoleIds);
  const add: string[] = [];
  const remove: string[] = [];

  for (const role of SWEPT_ROLES) {
    const id = guildRoles[role];
    // A guild missing a given role is a skip, not an error (spec §5).
    if (!id) continue;
    const shouldHold = desired?.has(role) ?? false;
    if (shouldHold && !held.has(id)) add.push(id);
    if (!shouldHold && held.has(id)) remove.push(id);
  }

  // REMOVAL ONLY, and only when asked. There is no branch anywhere in this
  // function that can add a membership role.
  if (options.revokeMembership) {
    for (const role of MEMBERSHIP_ROLES) {
      const id = guildRoles[role];
      if (id && held.has(id)) remove.push(id);
    }
  }

  return { add, remove };
}

/**
 * What the roles a member is HOLDING say their membership is.
 *
 * The one read in the Discord -> app direction, and it is deliberately
 * conservative in both of the ways it can be wrong:
 *
 *  - Holding none of the three answers `null`, which every caller treats as
 *    "leave the app alone". A member who has not picked yet must not be
 *    silently demoted to a default, and a guild that has not configured the
 *    roles at all must not rewrite the whole roster.
 *  - Holding TWO answers `null` as well. Two memberships is not a state the app
 *    can store, and picking one of them here would be this module guessing at
 *    something a human can see and fix in a second. The picker keeps them
 *    exclusive when it is the one doing the assigning; this is what happens
 *    when somebody hands out a second one by hand.
 */
export function membershipFromRoles(
  guildRoles: GuildRoleMap,
  currentRoleIds: readonly string[]
): MembershipRole | null {
  const held = new Set(currentRoleIds);
  let found: MembershipRole | null = null;

  for (const role of MEMBERSHIP_ROLES) {
    const id = guildRoles[role];
    if (!id || !held.has(id)) continue;
    if (found) return null;
    found = role;
  }

  return found;
}
