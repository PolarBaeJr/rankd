import { describe, it, expect } from 'vitest';
import { openableSections } from '../../components/nav-sections';
import {
  permits,
  resolvePermissions,
  EXEC_BASELINE,
  UNRESTRICTED,
  type AccessLevel,
  type Capability,
} from '../permissions';

// WHO LANDS ON A BARE DASHBOARD, and what they are shown instead.
//
// The dashboard's panels are gated one capability at a time, which is correct
// and is not what this file is about: it is about the person for whom EVERY one
// of those answers is no. She holds fees.page, fees.expenses.read and
// fees.expenses.add.write — the Finance role — and no panel on the page asks
// for any of them, so she used to get a header and an empty screen, which looks
// exactly like the app being broken.
//
// TWO THINGS ARE PINNED HERE. First, that the narrowed branch is UNREACHABLE
// for anybody nobody narrowed: an unrestricted exec holds fees.expenses.read
// (it is in EXEC_BASELINE, and ROLE_DEFAULTS.finance is precisely that subset of
// it), so no capability separates the Finance role from an ordinary exec inside
// the fees area, and the new tiles can only be conditioned on the old ones being
// absent. Second, that the signpost is DERIVED — it enumerates the sections
// through the same canAccess() the sidebar and the middleware use, so a section
// added later appears in it with nothing to remember.
//
// TILE_GATES IS A HAND WRITE-DOWN of the flags at the top of dashboard/page.tsx,
// deliberately, in the same spirit as ./capability-equivalence.test.ts: deriving
// it from the page would make it pass by construction, and the page cannot be
// imported anyway. A panel added there needs its capability added here.
//
// IT MUST BE KEPT IN STEP IN BOTH DIRECTIONS. A gate added to the page and not
// here lets a narrowed person fall into the signpost branch AND render a panel;
// a gate left here after its panel is deleted gives them hasTiles with nothing
// behind it, which is the blank screen the branch exists to prevent.
const TILE_GATES: Capability[] = [
  'players.read',            // Members + Active roster cells, and New this week
  'players.approve.write',   // Pending approvals, the panel and the alert clause
  'disputes.page',           // The open-disputes alert clause
  'walkovers.page',          // The pending-walkovers alert clause
  'matches.page',            // Matches logged, and Awaiting confirmation
  'sessions.page',           // Sessions this week, and the Tonight card
  'tournaments.page',        // In play · Tournaments
  'challenges.page',         // In play · Challenges
  'fees.netposition.read',   // The net position card
  'fees.clubfees.read',      // The Fees outstanding cell
];

const LEVELS: AccessLevel[] = ['admin', 'exec', 'trainer'];

const resolved = (level: AccessLevel, role: string | null, revokes: string[] = []) =>
  role === null ? UNRESTRICTED : resolvePermissions(level, role, [], revokes);

/** The page's `hasTiles`: does ANY panel of the ordinary dashboard render? */
const hasTiles = (level: AccessLevel, role: string | null, revokes: string[] = []) =>
  TILE_GATES.some((capability) => permits(level, resolved(level, role, revokes), capability));

/** What the signpost lists — the page drops /dashboard, being that page. */
const signpost = (level: AccessLevel, role: string | null, revokes: string[] = []) =>
  openableSections(level, resolved(level, role, revokes))
    .map((item) => item.href)
    .filter((href) => href !== '/dashboard');

/**
 * Every section page the floor opens, which is how an admin closes a section.
 * Derived from the floor since 2026-10-23, when it became every read and page
 * outside the admin areas: a section added later is closed here with nothing to
 * remember.
 */
const ALL_PAGES: string[] = EXEC_BASELINE.filter((capability) => capability.endsWith('.page'));

describe('the narrowed dashboard', () => {
  // THE DEPLOY-DAY GUARANTEE for this page: nothing new renders for anybody who
  // has not been narrowed, at any level. A trainer holds players.read, an exec
  // holds seven of these and an admin holds all of them.
  it('never fires for anybody nobody narrowed', () => {
    for (const level of LEVELS) {
      expect(hasTiles(level, null), level).toBe(true);
    }
  });

  // THESE TWO USED TO EXPECT `false` — "fires for the Finance role, whose every
  // panel is somebody else's", and the same for External — and they now expect
  // the opposite, because ASSIGNING A ROLE NO LONGER NARROWS ANYBODY'S READS.
  //
  // The club owner ruled that the level's baseline is a floor under every role,
  // and four of the eleven TILE_GATES are in it: `players.read`, `matches.page`,
  // `sessions.page`, `tournaments.page`. So an officer given the Finance job
  // still sees the roster count, the ladder and the tournament panels — the
  // ordinary dashboard, not the signpost. That is the ruling working, not the
  // branch rotting: a treasurer who could see nothing but a list of links was
  // the thing the ruling was made to stop.
  it('no longer fires for a role, because the floor keeps four tile gates', () => {
    for (const role of ['finance', 'external', 'tournaments', 'internal', 'custom']) {
      expect(hasTiles('exec', role), role).toBe(true);
    }
    for (const capability of ['players.read', 'matches.page', 'sessions.page', 'tournaments.page']) {
      expect(TILE_GATES).toContain(capability);
    }
  });

  // AND THE BRANCH IS NOT DEAD — its trigger moved from "assigned" to
  // "deliberately narrowed", which is a better trigger and the only one left.
  // A person only lands here because an admin revoked their reads by hand,
  // which is exactly the state the page's copy describes.
  it('fires for somebody whose reads were REVOKED, which is the only way now', () => {
    expect(hasTiles('exec', 'external', ALL_PAGES)).toBe(false);
    expect(hasTiles('exec', 'custom', ALL_PAGES)).toBe(false);
    // A trainer too: their floor holds players.read, so the same rule applies.
    expect(hasTiles('trainer', 'custom')).toBe(true);
    expect(hasTiles('trainer', 'custom', ['players.page'])).toBe(false);
  });

  // The two roles that still land on a populated page, so the branch stays as
  // narrow as it claims to be.
  it('does not fire for roles that keep a panel', () => {
    expect(hasTiles('exec', 'tournaments')).toBe(true);
    expect(hasTiles('exec', 'internal')).toBe(true);
  });

  // WHICH FEE CHARTS CAN EVER APPEAR ON THE NARROWED LANDING — and it is two of
  // the four, by construction rather than by choice. `fees.clubfees.read` and
  // `fees.netposition.read` are both TILE_GATES, so anybody holding either is
  // already on the ordinary dashboard and their panels live in its right rail.
  // The narrowed branch can only ever draw the expense ledger and other income.
  //
  // This is not a style rule. The narrowed landing used to carry a "Club fees"
  // tile gated on fees.clubfees.read that could never render, for exactly this
  // reason; a chart added there under either capability below would be the same
  // dead code, and one added there under a capability NOT in TILE_GATES would
  // give a narrowed person a panel AND the signpost.
  it('can never reach the narrowed landing holding the dues or net-position read', () => {
    for (const capability of ['fees.clubfees.read', 'fees.netposition.read'] as Capability[]) {
      expect(TILE_GATES).toContain(capability);
    }
  });

  // And the two that CAN. Both are absent from TILE_GATES, so holding one takes
  // nobody off the narrowed landing — which is what makes an expense chart
  // there reachable for the Finance role at all.
  it('draws the expense and other-income ledgers there, which no tile claims', () => {
    for (const capability of ['fees.expenses.read', 'fees.otherincome.read'] as Capability[]) {
      expect(TILE_GATES).not.toContain(capability);
    }
    expect(permits('exec', resolvePermissions('exec', 'finance', [], []), 'fees.expenses.read'))
      .toBe(true);
  });

  // THE SIGNPOST USED TO BE THE INTERESTING PART OF A ROLE and is now the same
  // list for every one of them: the floor opens every section outside the admin
  // areas (since 2026-10-23 that includes /events and /club-changes), so which
  // job somebody holds changes what they can DO there and not what they can
  // reach. Pinned as one assertion across every role rather than three
  // role-shaped ones that would each look like a decision about that role.
  it('opens every section for an officer, whichever role they hold', () => {
    const everything = [
      '/matches', '/tournaments', '/events', '/sessions', '/announcements',
      '/seasons', '/fees', '/finances', '/players', '/club-changes',
      '/legal', '/legal/signatures', '/legal/guests', '/legal/media-consent', '/settings',
    ];
    for (const role of ['finance', 'external', 'tournaments', 'internal', 'custom', null]) {
      expect(signpost('exec', role), String(role)).toEqual(everything);
      // And none of the admin areas, whichever role.
      for (const href of ['/permissions', '/audit', '/ratings', '/accounts']) {
        expect(signpost('exec', role), `${String(role)} ${href}`).not.toContain(href);
      }
    }
  });

  // ...and a REVOKE is what narrows it, which is the mechanism that replaced
  // "pick a role" as the way somebody ends up on this page.
  it('narrows to what is left when the section pages are revoked', () => {
    expect(signpost('exec', 'external', ALL_PAGES.filter((p) => p !== 'announcements.page')))
      .toEqual(['/announcements', '/settings']);
  });

  // A hand-picked person with everything revoked still gets a link rather than a
  // blank card: /settings belongs to no area and every console user keeps it,
  // so the signpost can never itself be empty.
  it('still names a door for somebody revoked down to nothing at all', () => {
    expect(signpost('exec', 'custom', ALL_PAGES)).toEqual(['/settings']);
  });
});
