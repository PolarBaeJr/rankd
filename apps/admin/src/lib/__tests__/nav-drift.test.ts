import { describe, it, expect } from 'vitest';
import { NAV_SECTIONS } from '../../components/nav-sections';
import {
  canAccess,
  AREAS,
  CAPABILITIES,
  UNRESTRICTED,
  type AccessLevel,
  type Area,
  type Capability,
} from '../permissions';

// THE NAV WAS THE ONE HAND-WRITTEN LIST WITH NOTHING HOLDING IT TO THE
// VOCABULARY.
//
// canAccess() sends a path nobody claimed to the admin-only default, which is
// the right failure for a NEW section — but for a MISTYPED href it means the
// link silently disappears for every exec and trainer, with nothing failing
// anywhere. A section renamed on one side and not the other does the same
// thing. There was no test that could catch either, because the sidebar cannot
// be imported: it pulls in next/navigation and a browser Supabase client.
//
// So the list moved into a module with no framework import, each item carries
// the area its href belongs to, and this suite checks that the key and
// canAccess() agree. A nav item is either a BASELINE path — the two links every
// console user keeps, which have no area — or a path under exactly one area.
// There is deliberately no third case: an item that reached the admin-only
// fallthrough would be a link only admins can see, and that is a decision to
// make out loud in the section map, not a side effect of a typo.

const ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/** Somebody whose whole set is one capability. */
const holding = (...capabilities: Capability[]) => ({
  kind: 'restricted' as const,
  capabilities: new Set(capabilities),
});

const EMPTY = holding();

// The one capability a nav link is allowed to depend on. Not "any read in the
// area": a read gates DATA, and /fees has four of them that must not open the
// section on their own.
const pageIn = (area: Area): Capability[] =>
  CAPABILITIES.filter((c) => c === `${area}.page`);

describe('the console nav', () => {
  it('names a real area, or none at all', () => {
    const areas = new Set<string>(AREAS);
    for (const item of ITEMS) {
      if (item.area === null) continue;
      expect(areas.has(item.area), `${item.href} names ${item.area}`).toBe(true);
    }
  });

  it('has no duplicate hrefs', () => {
    const hrefs = ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  // A BASELINE item is one every console level keeps regardless of what they
  // hold. If one of these ever stopped matching, a narrowed exec would lose the
  // front door — including the page where they enrol the passkey the console
  // demands of them.
  it('lets every level reach the two links that belong to no area', () => {
    for (const item of ITEMS.filter((i) => i.area === null)) {
      for (const level of ['admin', 'exec', 'trainer'] as AccessLevel[]) {
        expect(canAccess(level, EMPTY, item.href), `${item.href} for ${level}`).toBe(true);
      }
    }
  });

  // THE DRIFT CHECK. Holding the declared area's PAGE must open the link, and
  // holding nothing must close it. Together these pin the href to the area: a
  // typo fails the first (the path falls through to admin-only), and an area key
  // that names the wrong section fails it too.
  it('opens each link to exactly the area its item declares', () => {
    for (const item of ITEMS) {
      if (item.area === null) continue;
      const pages = pageIn(item.area);
      expect(pages.length, `${item.area} has no page capability`).toBe(1);
      for (const page of pages) {
        expect(canAccess('exec', holding(page), item.href), `${item.href} via ${page}`).toBe(true);
      }
      expect(canAccess('exec', EMPTY, item.href), `${item.href} with nothing held`).toBe(false);
    }
  });

  // A READ DOES NOT OPEN A SECTION. The reason the page mode exists is that the
  // two questions are separate, and /fees is where they come apart: its four
  // ledger reads gate DATA and nothing else, so holding one without the page
  // must leave the link — and the route — closed.
  it('refuses to open a section on a data read alone', () => {
    for (const read of ['fees.clubfees.read', 'fees.otherincome.read', 'fees.netposition.read', 'fees.reinstatements.read', 'fees.expenses.read'] as const) {
      expect(canAccess('exec', holding(read), '/fees'), read).toBe(false);
      expect(canAccess('exec', holding(read), '/finances'), read).toBe(false);
    }
    // /players comes apart the same way now: the roster is data behind
    // players.read, and holding it without players.page must not be a way in.
    expect(canAccess('exec', holding('players.read'), '/players')).toBe(false);
  });

  // What an UNRESTRICTED exec — which is everybody, on the day this ships —
  // actually sees, written out rather than derived. This is the nav half of the
  // deploy-day guarantee: an exec's console must look byte-identical, and a
  // link appearing or disappearing here is the most visible way it would not.
  it('shows an unrestricted exec exactly these links', () => {
    const visible = ITEMS.filter((i) => canAccess('exec', UNRESTRICTED, i.href)).map((i) => i.href);
    expect(visible).toEqual([
      '/dashboard',
      '/matches',
      '/tournaments',
      '/sessions',
      '/announcements',
      '/seasons',
      '/fees',
      '/finances',
      '/players',
      '/legal',
      '/legal/signatures',
      '/legal/guests',
      '/legal/media-consent',
      '/settings',
    ]);
  });

  it('shows an unrestricted trainer only the roster and their own settings', () => {
    const visible = ITEMS.filter((i) => canAccess('trainer', UNRESTRICTED, i.href)).map((i) => i.href);
    expect(visible).toEqual(['/dashboard', '/players', '/settings']);
  });
});
