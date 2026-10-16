import {
  LayoutDashboard,
  Users,
  Trophy,
  Medal,
  Scale,
  ScrollText,
  Settings,
  Gauge,
  UserCog,
  Target,
  Calendar,
  CalendarHeart,
  DollarSign,
  Megaphone,
  ShieldCheck,
  FileSignature,
  FileCheck,
  Camera,
  History,
} from 'lucide-react';
import {
  canAccess,
  featureAccessCapability,
  type AccessLevel,
  type Area,
  type Capability,
  type Permissions,
} from '../lib/permissions';
// Deep and type-only, NOT the '@badminton/ui' barrel: that loads every
// component in the package, and this module is imported by tests that must not
// need a DOM.
import type { NavEntry, NavNest } from '@badminton/ui/src/nav-groups';
// Deep for the same reason: the registry has no imports of its own.
import { adminFeatureFor, type FeatureFlags } from '@badminton/shared/src/utils/features';

// THE CONSOLE'S NAVIGATION, as data.
//
// Its own module, with no framework import, for one reason: it is the only
// hand-written list in the console with nothing tying it to the capability
// vocabulary, so it needs a test — and a test cannot import the sidebar, which
// pulls in next/navigation and a browser Supabase client.
//
// Two nav ROWS, not two access levels. Every item in both is filtered through
// canAccess() against the same section map the middleware uses, so this list
// can never offer a door that will not open — grouping is layout only.
//
// The first row is the day-to-day club work an exec does; the second is the
// back-office row, which happens to be mostly admin-only but is not uniformly
// so (/players and /settings reach down to trainers, /legal to execs). Put a
// section wherever it belongs on screen and let canAccess() do the deciding:
// hand-keeping a second idea of who may see what is exactly how execs came to
// be shown four links that bounced them to /unauthorized.
//
// EVERY ITEM NAMES THE AREA ITS HREF BELONGS TO, or null for the two links that
// belong to no area at all — the dashboard and settings, which every console
// user keeps regardless of what they hold. Until this key existed, a section
// renamed or an href mistyped would simply stop matching the section map,
// canAccess() would fall through to its admin-only default, and the link would
// disappear for every exec with nothing failing anywhere. The key's only job is
// to be checked against the vocabulary and against canAccess().
export type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  area: Area | null;
};

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Manage',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, area: null },
      { href: '/matches', label: 'Matches', icon: Target, area: 'matches' },
      { href: '/tournaments', label: 'Tournaments', icon: Trophy, area: 'tournaments' },
      { href: '/events', label: 'Club events', icon: CalendarHeart, area: 'events' },
      { href: '/sessions', label: 'Sessions', icon: Calendar, area: 'sessions' },
      { href: '/announcements', label: 'Announcements', icon: Megaphone, area: 'announcements' },
      { href: '/seasons', label: 'Seasons', icon: Medal, area: 'seasons' },
      // Route stays /fees — it is the section's access key in permissions.ts
      // and every existing link and revalidatePath points at it. The label is
      // "Finances" because the section is no longer only fees: other income and
      // expenses are tabs on the same page.
      //
      // Sits in the first row now that /fees is exec-level: for an exec it is
      // the only back-office link they have, and left in the second row it
      // would have rendered as a one-item strip under a divider. An exec who
      // follows it lands on the Expenses tab and sees nothing else — the page
      // decides that, not this list.
      { href: '/fees', label: 'Finances', icon: DollarSign, area: 'fees' },
    ],
  },
  {
    title: 'Admin only',
    items: [
      { href: '/players', label: 'Players', icon: Users, area: 'players' },
      { href: '/permissions', label: 'Permissions', icon: ShieldCheck, area: 'permissions' },
      // Platform configuration, split out of /settings — which stays trainer-level
      // for passkey enrolment and no longer carries any of it.
      { href: '/ratings', label: 'Ratings', icon: Gauge, area: 'ratings' },
      { href: '/club-changes', label: 'Club changes', icon: History, area: 'changelog' },
      { href: '/accounts', label: 'Accounts', icon: UserCog, area: 'accounts' },
      { href: '/legal', label: 'Legal', icon: Scale, area: 'legal' },
      { href: '/legal/signatures', label: 'Member signatures', icon: FileCheck, area: 'legal' },
      { href: '/legal/guests', label: 'External waivers', icon: FileSignature, area: 'legal' },
      { href: '/legal/media-consent', label: 'Photo consent', icon: Camera, area: 'legal' },
      { href: '/audit', label: 'Audit Log', icon: ScrollText, area: 'audit' },
      { href: '/settings', label: 'Settings', icon: Settings, area: null },
    ],
  },
];

/**
 * Every door this person can actually open, flattened out of the two rows.
 *
 * Derived rather than listed, through the same canAccess() the sidebar and the
 * middleware use, so a section added to NAV_SECTIONS later appears here with no
 * second list to remember. The dashboard uses it to tell somebody narrowed by
 * permissions where they CAN go, instead of leaving them on a page whose every
 * panel belongs to a capability they do not hold.
 */
export function openableSections(
  level: AccessLevel | null,
  permissions: Permissions,
): NavItem[] {
  return NAV_SECTIONS.flatMap((section) => section.items).filter((item) =>
    canAccess(level, permissions, item.href),
  );
}

// THE TOP BAR'S LAYOUT: the same items, arranged into menus.
//
// NAV_SECTIONS above stays the list of record (its order is pinned by
// nav-drift.test.ts, and openableSections() walks it); this only decides where
// each item sits on screen. The two sections are no longer rendered as rows. Built by href lookup so an item cannot be copied
// here with a different label or area, and a mistyped href fails at module
// load rather than quietly dropping a link. nav-layout.test.ts checks that
// every item appears exactly once.
//
// A group can also fold rows under a parent row (`nest`), which the menu draws
// as one entry that opens. The group's items stay flat and in display order,
// so NAV_SECTIONS and everything that walks the layout is unaffected.
//
// A new destination in a group is one href added to its list.
const byHref = new Map(NAV_SECTIONS.flatMap((section) => section.items).map((item) => [item.href, item]));

function navItem(href: string): NavItem {
  const item = byHref.get(href);
  if (!item) throw new Error(`NAV_LAYOUT names ${href}, which is not in NAV_SECTIONS`);
  return item;
}

const group = (id: string, label: string, hrefs: string[], nest?: NavNest[]): NavEntry<NavItem> => {
  // Checked like the hrefs, so a typo in a nest throws at load as well.
  for (const n of nest ?? []) [n.parent, ...n.children].forEach(navItem);
  return {
    kind: 'group',
    group: { id, label, items: hrefs.map(navItem), ...(nest ? { nest } : {}) },
  };
};

export const NAV_LAYOUT: NavEntry<NavItem>[] = [
  { kind: 'link', item: navItem('/dashboard') },
  group('play', 'Play', ['/sessions', '/matches', '/seasons']),
  group('events', 'Events', ['/tournaments', '/events']),
  group('members', 'Members', ['/players', '/permissions', '/accounts']),
  group(
    'club',
    'Club',
    ['/announcements', '/fees', '/legal', '/legal/signatures', '/legal/guests', '/legal/media-consent'],
    [{ parent: '/legal', selfLabel: 'Documents', children: ['/legal/signatures', '/legal/guests', '/legal/media-consent'] }],
  ),
  group('system', 'System', ['/ratings', '/club-changes', '/audit']),
  { kind: 'link', item: navItem('/settings') },
];

/**
 * False for the nav item of a club feature that is switched off, unless the
 * viewer holds that feature's `page.access.<id>` key (an admin always does, by
 * level). Layered on top of canAccess() by the top bar and the dashboard; the
 * page itself stays reachable by URL and says the feature is off.
 *
 * `held` is the viewer's resolved set, from effectiveCapabilities(), so this
 * asks the same question the members' app asks through featureAccessFor().
 */
export function adminNavItemOn(
  href: string,
  features: FeatureFlags,
  held: ReadonlySet<Capability>,
): boolean {
  const id = adminFeatureFor(href);
  return id === null || features[id] || held.has(featureAccessCapability(id));
}
