// Section-level access control for the admin app. The real security boundary is
// the server action (service-role bypasses RLS); this map is the single source of
// truth for which capability a section requires, shared by middleware and nav.
//
// WHAT A PERSON MAY DO IS A SET OF CAPABILITIES, not a rung on a ladder. The
// three levels — admin > exec > trainer — still exist and still decide who
// reaches the console at all, but they no longer answer "may this person do
// X": that is permits(), and it is plain membership in the set the person
// resolves to. See @badminton/shared's access-level.ts for the vocabulary and
// the two baselines.
//
//  - admin    role = 'admin'. Superuser BY LEVEL: permits() short-circuits
//             before any set is consulted, so a capability added next year is
//             automatically theirs.
//  - exec     is_exec. EXEC_BASELINE — eight section pages and four reads, and
//             NOT ONE WRITE. An officer with no permission_role can see the
//             club's business and change none of it; the writes they used to
//             hold by level are in EXEC_ASSIGNABLE and arrive by assignment.
//  - trainer  is_trainer. TRAINER_BASELINE — reading the roster and writing
//             varsity notes, and that is the whole level. See
//             ./player-field-access.ts, where their writable field set is EMPTY.
//
// This file's job is the admin-only half: which PATH needs which capability.
// It maps a path to ONE capability and admits anyone holding it. Written that
// way rather than as "the section's level" because the two answers have come
// apart: an exec granted `audit.page` must reach /audit, and no minimum level
// expresses that.
//
// THE CAPABILITY A SECTION ASKS FOR IS ITS `<area>.page` — that is what a page
// key is for, and it is why the mode exists. Asking for "any read in the area"
// (which this map used to do) made opening a section and seeing its data the
// same permission, so somebody who should come in to ADD without browsing could
// not get through the door at all.
//
// THREE OUTCOMES, no `||` on a security check:
//   1. A baseline path (`/`, `/dashboard`, `/settings`, `/api/passkey`) — the
//      front door, the landing page and enrolling your own passkeys. Any
//      console level at all.
//   2. A path that resolves to a capability — holds it.
//   3. An UNMATCHED path — admin by level. The safety net is kept: a section
//      added to the app without an entry here is admin-only, not open to the
//      newest level.
//
// Deep import, NOT the '@badminton/shared' barrel. This module is pulled into
// the EDGE middleware through canAccess(), and the barrel re-exports the mail
// sender, which drags `resend` and a Supabase client in with it: importing it
// here took the built middleware from 321 KB to 843 KB, on every request, for
// three pure functions. Same reason push/send is imported by path elsewhere,
// and the same reason CAPABILITY_GATES lives in its own module — it is labels
// and prose for the editor, and no request needs it.
import {
  atLeast,
  effectiveCapabilities,
  type AccessLevel,
  type Capability,
  type Permissions,
} from '@badminton/shared/src/utils/access-level';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';

// Re-exported so every existing `from '@/lib/permissions'` import keeps working
// and there is still ONE place in the admin app to look for these.
export {
  accessLevelFor,
  atLeast,
  baselineCapabilityRefusal,
  baselineNameRefusal,
  consoleAccessLevelFor,
  effectiveCapabilities,
  featureAccessCapability,
  hasConsoleAccess,
  isBuiltinPermissionRole,
  isCapability,
  isInGoodStanding,
  normaliseBaselineCapabilities,
  pageOf,
  permissionsOf,
  permissionTripleOf,
  permits,
  resolvePermissions,
  shippedDefaultFor,
  AREAS,
  BASELINE_NAME_MAX,
  BUILTIN_BASELINE_IDS,
  BUILTIN_PERMISSION_ROLES,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_ASSIGNABLE,
  EXEC_BASELINE,
  PERMISSION_ROLES,
  PERMISSION_ROLE_LABELS,
  ROLE_DEFAULTS,
  TRAINER_BASELINE,
  UNRESTRICTED,
} from '@badminton/shared/src/utils/access-level';
export type {
  AccessLevel,
  Area,
  Capability,
  CustomBaseline,
  PermissionRole,
  Permissions,
  PermissionsInput,
} from '@badminton/shared/src/utils/access-level';

// WHICH SECTION ASKS FOR WHICH CAPABILITY. One page key per section, and a
// person may open it when they hold that key.
//
// The level column that used to live here is gone. It said the same thing twice
// for every row but one, and the row where it did not — /fees — is the reason
// this shape changed.
const SECTION_CAPABILITY: { [pathPrefix: string]: Capability } = {
  '/announcements': 'announcements.page',
  '/matches': 'matches.page',
  '/tournaments': 'tournaments.page',
  '/events': 'events.page',
  '/sessions': 'sessions.page',
  '/seasons': 'seasons.page',
  // Finances. `fees.page` buys the SECTION and nothing in it: the five ledgers
  // behind it — club fees, other income, expenses, reinstatements, the net
  // position — each have their own read, and an exec holds exactly one of them
  // (fees.expenses.read) because the club owner asked for "execs can add
  // expenses", not for the finance page. /fees/page.tsx enforces that by
  // skipping their FETCHES rather than hiding the rendered output: a hidden card
  // whose query still ran ships the figures into the RSC payload for anyone with
  // devtools. Same reasoning, and the same shape, as dashboard/page.tsx.
  //
  // SO THIS LINE IS NOT THE WHOLE STORY FOR THIS SECTION, and the split into
  // page-and-reads makes that sharper rather than softer: fees.page is now
  // satisfied by somebody who may see NO ledger at all. Anything that asks "may
  // this person see club money?" must ask for the capability the DATA needs —
  // fees.clubfees.read, fees.netposition.read — and must NOT reuse
  // canAccess(…, '/fees'). The dashboard finance snapshot is the one place that
  // nearly did, and reusing this line is precisely what would have leaked it.
  '/fees': 'fees.page',
  '/audit': 'audit.page',
  // The audit log's CSV download, which is a route rather than a server action
  // because a file has to arrive as a response with its own headers. Listed
  // EXPLICITLY rather than left to canAccess()'s admin-only fallthrough for an
  // unmatched path: the fallthrough is a safety net for a section somebody
  // forgot, and leaning on it here would make this row's answer depend on the
  // absence of a line instead of on the presence of one. It also keeps the
  // capability offerable one day without a second edit.
  //
  // isUnder() is segment-aware, so '/audit' never matches '/api/audit/export'
  // and this is a real entry rather than a narrowing of the one above.
  '/api/audit/export': 'audit.export.read',
  // Execs open the documents and may require a re-signature; only admins edit
  // the text. That split is three separate capabilities under `legal`, enforced
  // in the page and in the server actions — this line only decides who may open
  // the section.
  '/legal': 'legal.page',
  // Platform configuration, split out of /settings. Admin-only in BOTH halves,
  // unlike Legal: the club owner wants execs kept off the rating and account
  // rules entirely, not shown a read-only copy. Neither page key is in any
  // baseline, and each page re-checks — this line only decides who may open the
  // section. The settings FORM on both is its own area, `platform.page`.
  '/ratings': 'ratings.page',
  '/accounts': 'accounts.page',
  // Club changes (00286): the draft lines that officer edits write, and the
  // posting of them. Admin-only: changelog.page is in no baseline.
  '/club-changes': 'changelog.page',
  // Execs run the roster: approve, edit, ban/unban, varsity notes. Granting
  // exec/admin is NOT part of that — the per-field split lives in
  // ./player-field-access.ts, and destructive actions (remove, merge) ask for
  // capabilities no baseline holds.
  //
  // Trainers get in here too, and ONLY to look: this is where the varsity notes
  // live, and finding the player you are writing about means seeing the list.
  //
  // AND THIS LINE IS NOT THE WHOLE STORY EITHER, for the same reason /fees is
  // not. players.page opens the section; the roster itself — the list, one
  // member's record, the count on the dashboard — is players.read, and the
  // owner's case for the whole three-mode split was somebody here who may add a
  // member without browsing the club. Anything asking "may this person see who
  // is in the club?" must ask for that read and must NOT reuse
  // canAccess(…, '/players').
  '/players': 'players.page',
  '/disputes': 'disputes.page',
  '/walkovers': 'walkovers.page',
  '/challenges': 'challenges.page',
  // The permission editor. permissions.page is in no baseline, so it is
  // admin-only exactly as before, and it must STAY that way for anyone who is
  // not deliberately given it — someone who could reach it and hold
  // permissions.write could hand themselves anything they already have.
  '/permissions': 'permissions.page',
};

// Sub-routes that ask for something NARROWER than the section they sit inside,
// and which would otherwise inherit its page key by prefix match. Tournament
// entry fees live at /tournaments/<id>/fees: execs run tournaments and hold
// tournaments.page, but entry money is its own group and no baseline holds
// tournaments.fees.read. Checked before the prefix map.
//
// A READ, not a second page: page keys are one per AREA, at depth 2, and entry
// money is a group inside `tournaments` rather than an area of its own. What the
// sub-route withholds is the fee roster, which is data — so a read is the right
// mode as well as the only available one.
//
// This replaces the old ADMIN_ONLY_PATTERNS list, and the replacement is a
// capability rather than a hard "admin": the whole point of the reshape is that
// an admin can hand this section to a treasurer without making them an admin.
const SECTION_PATTERNS: { pattern: RegExp; capability: Capability }[] = [
  { pattern: /^\/tournaments\/[^/]+\/fees(\/|$)/, capability: 'tournaments.fees.read' },
];

// What every console user keeps regardless of what they hold. These are not
// powers: the front door, the landing page, and enrolling your own passkeys.
// Without them a narrowed person would be locked out of the console entirely —
// including out of enrolling the passkey the console demands of them.
//
// Matched with the same segment-prefix rule as SECTION_CAPABILITY, so '/' is the
// root and nothing else. The console root only redirects to /dashboard
// (app/page.tsx), but middleware runs BEFORE the redirect, so without it every
// non-admin opening /admin — which is where the player app's "Exec Panel" link
// points — was bounced to /unauthorized.
// /passkey-required is where the console sends someone whose 14 days without a
// console passkey have run out (00262); it has to open for every level, or a
// trainer would be bounced to /unauthorized instead of shown how to add one.
const BASELINE_SECTIONS = ['/', '/dashboard', '/settings', '/api/passkey', '/passkey-required'];

// Does this path sit inside this section? Segment-aware, so '/players' never
// matches '/playersecret'. The one matching rule, shared by both maps.
function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

// Longest-prefix lookup in a section map. Returns undefined when nothing
// matches; the caller treats that as admin-only.
function longestPrefixMatch<T>(map: { [prefix: string]: T }, pathname: string): T | undefined {
  let best = '';
  for (const prefix of Object.keys(map)) {
    if (isUnder(pathname, prefix) && prefix.length > best.length) best = prefix;
  }
  return best ? map[best] : undefined;
}

// The capability this path asks for, or undefined for a path no section claims.
function sectionCapability(pathname: string): Capability | undefined {
  for (const { pattern, capability } of SECTION_PATTERNS) {
    if (pattern.test(pathname)) return capability;
  }
  return longestPrefixMatch(SECTION_CAPABILITY, pathname);
}

/**
 * May this person open this section?
 *
 * BOTH the level and the permissions are required, and the permissions
 * deliberately so: an optional argument would default to something at every
 * call site that forgot it, and every possible default is wrong in one
 * direction or the other.
 *
 * `{ kind: 'unrestricted' }` is byte-for-byte the behaviour that shipped before
 * any of this existed — it resolves to the level's baseline, and the baselines
 * are a transcription of what the levels could do.
 */
export function canAccess(
  level: AccessLevel | null,
  permissions: Permissions,
  pathname: string,
): boolean {
  if (level === null) return false;
  if (BASELINE_SECTIONS.some((prefix) => isUnder(pathname, prefix))) {
    return atLeast(level, 'trainer');
  }
  const capability = sectionCapability(pathname);
  // Fail closed on a path nobody claimed. An admin still gets in, so a new
  // section is reachable by the person who can fix the omission.
  if (capability === undefined) return level === 'admin';
  return effectiveCapabilities(level, permissions).has(capability);
}

/**
 * A human name for the section a path belongs to, or null.
 *
 * SANITISATION, not decoration. `?denied=` on the dashboard comes straight off
 * a URL the visitor typed, so it is never rendered. It is resolved through the
 * console's own route map to a capability, and that capability's label is what
 * reaches the page — so anything the map does not claim produces null and the
 * dashboard simply says nothing. There is no path from the query string to the
 * DOM.
 */
export function sectionLabelFor(pathname: string | undefined): string | null {
  if (!pathname || !pathname.startsWith('/')) return null;
  const capability = sectionCapability(pathname);
  if (capability === undefined) return null;
  const label = CAPABILITY_GATES[capability]?.label;
  if (!label) return null;

  // The gate labels are written as ACTIONS, because that is what they describe
  // in the permissions editor: "Open the Audit log", "Open Finances". Quoted
  // into a sentence about a place they read as nonsense — “Open the Audit log”
  // is not part of your access — so the verb comes off and what is left is the
  // section's own name.
  //
  // Derived from the one authoritative source rather than a second hand-typed
  // map of section names, which would drift the first time somebody renamed a
  // section in the editor and not here.
  const section = label.replace(/^Open (?:the )?/, '');
  // "Open the roster" leaves a lower-case word where every sibling leaves a
  // capitalised one, and the difference shows once they are quoted side by side.
  return section.charAt(0).toUpperCase() + section.slice(1);
}
