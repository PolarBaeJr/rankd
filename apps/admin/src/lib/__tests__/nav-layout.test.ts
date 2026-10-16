import { describe, it, expect } from 'vitest';
import { NAV_LAYOUT, NAV_SECTIONS, adminNavItemOn, type NavItem } from '../../components/nav-sections';
import { ALL_FEATURES_ENABLED, FEATURES, type FeatureFlags } from '@badminton/shared/src/utils/features';
import {
  flattenEntries,
  isRouteActive,
  nestItems,
  visibleEntries,
  type NavEntry,
} from '@badminton/ui/src/nav-groups';
import {
  canAccess,
  effectiveCapabilities,
  resolvePermissions,
  EXEC_BASELINE,
  UNRESTRICTED,
  type AccessLevel,
  type Permissions,
} from '../permissions';

// THE TOP BAR IS A SECOND ARRANGEMENT OF THE SAME LIST, and these pin the two
// together. NAV_SECTIONS is what nav-drift.test.ts checks against the
// capability vocabulary; NAV_LAYOUT only moves its items into menus. So the
// layout must hold every one of those items exactly once, and what a person
// sees in it must be decided by the same canAccess() the sidebar calls.

const ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/** What the sidebar renders for this person, with the sidebar's own predicate. */
const visibleFor = (level: AccessLevel, permissions: Permissions) =>
  visibleEntries(NAV_LAYOUT, (item) => canAccess(level, permissions, item.href));

/** The layout reduced to something readable: a link's href, a group's id and hrefs. */
const shape = (entries: NavEntry<NavItem>[]) =>
  entries.map((entry) =>
    entry.kind === 'link'
      ? entry.item.href
      : { [entry.group.id]: entry.group.items.map((item) => item.href) },
  );

describe('the console top bar layout', () => {
  it('holds every NAV_SECTIONS item exactly once, and nothing else', () => {
    const hrefs = flattenEntries(NAV_LAYOUT).map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect([...hrefs].sort()).toEqual(ITEMS.map((item) => item.href).sort());
  });

  it('reuses the NAV_SECTIONS item itself, so a label or area cannot drift', () => {
    for (const item of flattenEntries(NAV_LAYOUT)) {
      expect(ITEMS).toContain(item);
    }
  });

  it('gives every group a unique id', () => {
    const ids = NAV_LAYOUT.flatMap((entry) => (entry.kind === 'group' ? [entry.group.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows an admin every group, in full', () => {
    expect(visibleFor('admin', UNRESTRICTED)).toEqual(NAV_LAYOUT);
  });

  // Club changes sits beside Ratings, where most of its lines come from.
  it('puts Club changes between Ratings and the Audit Log in the System menu of an admin', () => {
    expect(shape(visibleFor('admin', UNRESTRICTED))).toContainEqual({
      system: ['/ratings', '/club-changes', '/audit'],
    });
  });

  it('puts club events beside tournaments in the Events menu of an admin', () => {
    expect(shape(visibleFor('admin', UNRESTRICTED))).toContainEqual({ events: ['/tournaments', '/events'] });
  });

  // The same thirteen links nav-drift.test.ts pins for an unrestricted exec, now in
  // menus. System holds only admin-only sections, so it is gone entirely.
  it('shows an unrestricted exec these menus', () => {
    const visible = visibleFor('exec', UNRESTRICTED);
    expect(shape(visible)).toEqual([
      '/dashboard',
      { play: ['/sessions', '/matches', '/seasons'] },
      { events: ['/tournaments'] },
      { members: ['/players'] },
      { club: ['/announcements', '/fees', '/legal', '/legal/signatures', '/legal/guests', '/legal/media-consent'] },
      '/settings',
    ]);
    expect(flattenEntries(visible).map((item) => item.href).sort()).toEqual(
      ITEMS.filter((item) => canAccess('exec', UNRESTRICTED, item.href))
        .map((item) => item.href)
        .sort(),
    );
  });

  it('shows an unrestricted trainer only the roster menu and the two baseline links', () => {
    expect(shape(visibleFor('trainer', UNRESTRICTED))).toEqual([
      '/dashboard',
      { members: ['/players'] },
      '/settings',
    ]);
  });

  // A narrowed exec. A role alone no longer narrows (the level's baseline is a
  // floor under it, see dashboard-landing.test.ts), so this is the Finance role
  // with every other section page revoked by hand: Club becomes a menu of one
  // and every other group is gone.
  it('narrows a hand-revoked exec to the one menu they can still open', () => {
    const revokes = [
      'announcements.page', 'legal.page', 'matches.page', 'players.page',
      'seasons.page', 'sessions.page', 'tournaments.page',
    ];
    expect(shape(visibleFor('exec', resolvePermissions('exec', 'finance', [], revokes)))).toEqual([
      '/dashboard',
      { club: ['/fees'] },
      '/settings',
    ]);
  });
});

// A CLUB FEATURE SWITCHED OFF LOSES ITS NAV ITEM, on top of canAccess(), and a
// group it leaves empty goes with it. The page itself stays open by URL.
//
// UNLESS THE VIEWER HOLDS ITS `page.access.<id>` KEY, and an admin holds every
// one by level. So the hiding cases below run as an unassigned exec, who holds
// the section pages and none of the keys; run as an admin they would show
// nothing hidden at all, which is the last two tests' point rather than a bug.
describe('the console top bar with a feature switched off', () => {
  const off = (...ids: (keyof FeatureFlags)[]): FeatureFlags => ({
    ...ALL_FEATURES_ENABLED,
    ...Object.fromEntries(ids.map((id) => [id, false])),
  });
  const visibleWith = (
    features: FeatureFlags,
    level: AccessLevel = 'exec',
    permissions: Permissions = UNRESTRICTED,
  ) => {
    const held = effectiveCapabilities(level, permissions);
    return visibleEntries(
      NAV_LAYOUT,
      (item) => canAccess(level, permissions, item.href) && adminNavItemOn(item.href, features, held),
    );
  };

  it('changes nothing while every feature is on', () => {
    expect(visibleWith(ALL_FEATURES_ENABLED, 'admin')).toEqual(NAV_LAYOUT);
  });

  it('drops the Events menu when tournaments are off', () => {
    const visible = shape(visibleWith(off('tournaments')));
    expect(visible).not.toContainEqual({ events: ['/tournaments'] });
    expect(flattenEntries(visibleWith(off('tournaments'))).map((i) => i.href)).not.toContain('/tournaments');
  });

  // /events is admin-only, so an exec never had it to lose.
  it('leaves an exec their Events menu when club events are off', () => {
    expect(shape(visibleWith(off('events')))).toContainEqual({ events: ['/tournaments'] });
  });

  it('drops only Sessions from Play when sessions are off', () => {
    expect(shape(visibleWith(off('sessions')))).toContainEqual({ play: ['/matches', '/seasons'] });
  });

  it('drops Announcements from Club when announcements are off', () => {
    expect(shape(visibleWith(off('announcements')))).toContainEqual({ club: ['/fees', '/legal', '/legal/signatures', '/legal/guests', '/legal/media-consent'] });
  });

  it('never hides an item that belongs to no feature', () => {
    const allOff = off(...FEATURES.map((f) => f.id));
    const owned = new Set<string>(FEATURES.flatMap((f) => f.adminRoutes));
    const none = effectiveCapabilities('exec', UNRESTRICTED);
    for (const item of ITEMS) {
      expect(adminNavItemOn(item.href, allOff, none), item.href).toBe(!owned.has(item.href));
    }
  });

  // An admin holds every key by level, so nothing they could open is hidden.
  it('hides nothing from an admin, who holds every key', () => {
    const allOff = off(...FEATURES.map((f) => f.id));
    expect(visibleWith(allOff, 'admin')).toEqual(NAV_LAYOUT);
  });

  // THE KEY IS PER FEATURE: an exec handed page.access.tournaments keeps
  // Events, and still loses Sessions, whose key they were not given.
  it('keeps exactly the feature whose key an exec was granted', () => {
    const granted = resolvePermissions('exec', 'custom', [...EXEC_BASELINE, 'page.access.tournaments'], []);
    const visible = shape(visibleWith(off('tournaments', 'sessions'), 'exec', granted));
    expect(visible).toContainEqual({ events: ['/tournaments'] });
    expect(visible).toContainEqual({ play: ['/matches', '/seasons'] });
  });
});

// LEGAL IS ONE ROW THAT OPENS. The group's items stay flat (everything above
// still holds), and nestItems() folds the three legal pages under /legal for
// the menu to draw.
describe('nested rows', () => {
  const clubOf = (entries: NavEntry<NavItem>[]) => {
    const club = entries.find((entry) => entry.kind === 'group' && entry.group.id === 'club');
    if (!club || club.kind !== 'group') throw new Error('no Club group');
    return club.group;
  };
  const hrefs = (items: { href: string }[]) => items.map((item) => item.href);
  const tree = (items: NavItem[], nest: Parameters<typeof nestItems>[1]) =>
    nestItems(items, nest).map(({ item, selfLabel, children }) => ({
      href: item.href,
      selfLabel,
      children: hrefs(children),
    }));
  const LEGAL_NEST = [
    { parent: '/legal', selfLabel: 'Documents', children: ['/legal/signatures', '/legal/guests', '/legal/media-consent'] },
  ];
  const byHref = (href: string) => ITEMS.find((item) => item.href === href)!;

  it('folds the three legal pages under Legal in the Club menu', () => {
    const club = clubOf(NAV_LAYOUT);
    expect(tree(club.items, club.nest)).toEqual([
      { href: '/announcements', selfLabel: undefined, children: [] },
      { href: '/fees', selfLabel: undefined, children: [] },
      { href: '/legal', selfLabel: 'Documents', children: ['/legal/signatures', '/legal/guests', '/legal/media-consent'] },
    ]);
  });

  it('drops external waivers from the fold when guest waivers are off', () => {
    const held = effectiveCapabilities('exec', UNRESTRICTED);
    const features: FeatureFlags = { ...ALL_FEATURES_ENABLED, guest_waivers: false };
    const club = clubOf(
      visibleEntries(
        NAV_LAYOUT,
        (item) => canAccess('exec', UNRESTRICTED, item.href) && adminNavItemOn(item.href, features, held),
      ),
    );
    const legal = nestItems(club.items, club.nest).find((row) => row.item.href === '/legal')!;
    expect(hrefs(legal.children)).toEqual(['/legal/signatures', '/legal/media-consent']);
  });

  it('draws the parent as a plain row when every child is filtered out', () => {
    expect(tree([byHref('/fees'), byHref('/legal')], LEGAL_NEST)).toEqual([
      { href: '/fees', selfLabel: undefined, children: [] },
      { href: '/legal', selfLabel: undefined, children: [] },
    ]);
  });

  it('promotes the children to plain rows when the parent is filtered out', () => {
    expect(tree([byHref('/legal/signatures'), byHref('/legal/guests')], LEGAL_NEST)).toEqual([
      { href: '/legal/signatures', selfLabel: undefined, children: [] },
      { href: '/legal/guests', selfLabel: undefined, children: [] },
    ]);
  });

  it('nests only hrefs that are items of the same group', () => {
    for (const entry of NAV_LAYOUT) {
      if (entry.kind !== 'group') continue;
      const own = hrefs(entry.group.items);
      for (const n of entry.group.nest ?? []) {
        for (const href of [n.parent, ...n.children]) expect(own, href).toContain(href);
      }
    }
  });
});

describe('isRouteActive', () => {
  it('matches the route itself and anything under it', () => {
    expect(isRouteActive('/tournaments', '/tournaments')).toBe(true);
    expect(isRouteActive('/tournaments/abc', '/tournaments')).toBe(true);
    expect(isRouteActive('/tournaments/abc/events/def', '/tournaments')).toBe(true);
  });

  it('does not match a route that only shares a prefix', () => {
    expect(isRouteActive('/eventsx', '/events')).toBe(false);
    expect(isRouteActive('/settingsx', '/settings')).toBe(false);
    expect(isRouteActive('/', '/events')).toBe(false);
  });

  it('matches the root only on the root', () => {
    expect(isRouteActive('/', '/')).toBe(true);
    expect(isRouteActive('/feed', '/')).toBe(false);
  });
});
