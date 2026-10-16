import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FEATURES,
  featureGate,
  playerFeatureFor,
  type FeatureId,
} from '@badminton/shared/src/utils/features';
import { isCapability } from '@badminton/shared/src/utils/access-level';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';

// THE REGISTRY IS A LIST OF PROMISES ABOUT ROUTES, and these check each one
// against the files. A route prefix that names no directory gates nothing; a
// directory with no FeatureGate is a switch that hides the nav item and leaves
// the page open.

const PLAYER_APP = join(__dirname, '../../app');
const ADMIN_APP = join(__dirname, '../../../../admin/src/app');

// The features that gate their index page rather than a layout: the
// leaderboard, so the profiles under it stay open, and the guest waiver, so a
// proof link under it outlives the switch.
const PAGE_GATED: readonly FeatureId[] = ['leaderboard', 'guest_waivers'];
const gateFile = (id: FeatureId) => (PAGE_GATED.includes(id) ? 'page.tsx' : 'layout.tsx');

// Account, legal and safety paths. None may ever belong to a feature.
const PROTECTED = [
  '/', '/feed', '/settings', '/legal', '/login', '/signup', '/auth', '/onboarding', '/link',
  '/notifications', '/email', '/unsubscribe', '/exec', '/feedback',
];

describe('the feature registry', () => {
  it('gives every feature a unique id and a label', () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FEATURES) expect(f.label.length, f.id).toBeGreaterThan(0);
  });

  it('never lets two features own the same player route', () => {
    const routes = FEATURES.flatMap((f) => f.playerRoutes);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('names only player routes that exist', () => {
    for (const f of FEATURES) {
      for (const route of f.playerRoutes) {
        expect(existsSync(join(PLAYER_APP, route)), `${f.id}: ${route}`).toBe(true);
      }
    }
  });

  it('names only admin pages that exist', () => {
    for (const f of FEATURES) {
      for (const route of f.adminRoutes) {
        expect(existsSync(join(ADMIN_APP, route, 'page.tsx')), `${f.id}: ${route}`).toBe(true);
      }
    }
  });

  it('gates every player route with a FeatureGate for its own feature', () => {
    for (const f of FEATURES) {
      for (const route of f.playerRoutes) {
        const file = gateFile(f.id);
        const source = readFileSync(join(PLAYER_APP, route, file), 'utf8');
        expect(source, `${route}/${file}`).toContain(`<FeatureGate feature="${f.id}">`);
      }
    }
  });

  it('puts a banner on every admin page a feature owns', () => {
    for (const f of FEATURES) {
      for (const route of f.adminRoutes) {
        const source = readFileSync(join(ADMIN_APP, route, 'layout.tsx'), 'utf8');
        expect(source, route).toContain(`<FeatureOffBanner feature="${f.id}" />`);
      }
    }
  });

  // EVERY FEATURE HAS ITS KEY, `page.access.<id>`, derived in access-level.ts,
  // and the key's enforcement point is the FeatureGate this file already checks.
  //
  // A feature with no pages (predictions, which only draws cards on other
  // pages) has no FeatureGate. Its key names a function in lib/ instead, and
  // that function must exist and must ask featureGate with the key.
  it('gives every feature a page.access key gated on its own pages', () => {
    for (const f of FEATURES) {
      const key = `page.access.${f.id}`;
      expect(isCapability(key), key).toBe(true);
      if (f.playerRoutes.length === 0) {
        const gate = CAPABILITY_GATES[key as keyof typeof CAPABILITY_GATES].gate ?? '';
        const parsed = /^player (lib\/[\w-]+\.ts) (\w+)$/.exec(gate);
        expect(parsed, key).not.toBeNull();
        const source = readFileSync(join(__dirname, '../../', parsed![1]!), 'utf8');
        expect(source, gate).toContain(`export async function ${parsed![2]}(`);
        expect(source, gate).toContain(`featureGate(flags.${f.id}, featureAccessFor(viewer).includes('${f.id}'))`);
        continue;
      }
      const file = gateFile(f.id);
      expect(CAPABILITY_GATES[key as keyof typeof CAPABILITY_GATES].gate, key).toBe(
        `player app${f.playerRoutes[0]}/${file} FeatureGate`,
      );
    }
  });

  it('never makes an account, legal or safety path switchable', () => {
    for (const path of PROTECTED) {
      expect(playerFeatureFor(path), path).toBeNull();
      expect(playerFeatureFor(`${path}/anything`), path).toBeNull();
    }
  });
});

describe('the gate decision, for every feature', () => {
  for (const f of FEATURES) {
    const id: FeatureId = f.id;
    it(`${id}: on lets everyone in, off redirects a viewer without the key and shows a holder a banner`, () => {
      expect(featureGate(true, false)).toBe('allow');
      expect(featureGate(true, true)).toBe('allow');
      expect(featureGate(false, true)).toBe('banner');
      expect(featureGate(false, false)).toBe('redirect');
      for (const route of f.playerRoutes) expect(playerFeatureFor(route)).toBe(id);
    });
  }
});
