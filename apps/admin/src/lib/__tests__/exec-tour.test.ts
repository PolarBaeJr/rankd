import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectSteps } from '@badminton/ui/src/tour';
import { flattenEntries } from '@badminton/ui/src/nav-groups';
import { ALL_FEATURES_ENABLED, FEATURES, type FeatureFlags } from '@badminton/shared/src/utils/features';
import { NAV_LAYOUT } from '../../components/nav-sections';
import {
  canAccess,
  effectiveCapabilities,
  featureAccessCapability,
  isCapability,
  resolvePermissions,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  UNRESTRICTED,
  type AccessLevel,
  type Permissions,
} from '../permissions';
import { EXEC_TOUR_KEY, execTourMayAutoStart, execTourSteps } from '../tours/exec-tour';

// WHO GETS WHICH STEP of the console tour. The tour is never mounted here: a
// green suite says nothing about the spotlight landing on the right trigger.

function stepsFor(level: AccessLevel, permissions: Permissions, features: FeatureFlags = ALL_FEATURES_ENABLED) {
  const held = new Set<string>(effectiveCapabilities(level, permissions));
  const featureAccess = FEATURES.filter((f) => held.has(featureAccessCapability(f.id))).map((f) => f.id);
  return selectSteps(execTourSteps(held), { features, featureAccess, approved: true, held });
}

const ids = (steps: { id: string }[]) => steps.map((s) => s.id);
const role = (name: string) => resolvePermissions('exec', name, [], []);

describe('the exec tour steps', () => {
  it('gives an admin every step, with every optional sentence', () => {
    const steps = stepsFor('admin', UNRESTRICTED);
    expect(ids(steps)).toEqual([
      'welcome', 'pending-approvals', 'sessions', 'door', 'members', 'club-events',
      'announcements', 'feature-switches', 'settings', 'done',
    ]);
    const body = (id: string) => steps.find((s) => s.id === id)!.body;
    expect(body('sessions')).toContain('select several');
    expect(body('door')).toContain('Check-in QR puts up the code');
    expect(body('announcements')).toContain('club Discord');
  });

  it('gives an exec on the baseline only what the baseline opens', () => {
    const steps = stepsFor('exec', UNRESTRICTED);
    expect(effectiveCapabilities('exec', UNRESTRICTED)).toEqual(new Set(EXEC_BASELINE));
    // Club events reads by level since 2026-10-23, so its step shows; the steps
    // that need a write or an admin area (approvals, feature switches) do not.
    expect(ids(steps)).toEqual([
      'welcome', 'sessions', 'door', 'members', 'club-events', 'announcements', 'settings', 'done',
    ]);
    const body = (id: string) => steps.find((s) => s.id === id)!.body;
    // The baseline writes nothing in sessions or announcements, so neither
    // optional sentence is offered.
    expect(body('sessions')).not.toContain('select several');
    expect(body('door')).toContain('needs a permission an admin can grant');
    expect(body('announcements')).not.toContain('Discord');
  });

  it('tells the tournaments role about bulk session edits', () => {
    const steps = stepsFor('exec', role('tournaments'));
    expect(ids(steps)).not.toContain('pending-approvals');
    expect(steps.find((s) => s.id === 'sessions')!.body).toContain('select several');
  });

  it('shows the internal role the pending approvals', () => {
    expect(ids(stepsFor('exec', role('internal')))).toContain('pending-approvals');
  });

  it('tells the external role about the Discord cross-post', () => {
    const steps = stepsFor('exec', role('external'));
    expect(steps.find((s) => s.id === 'announcements')!.body).toContain('club Discord');
  });

  it('drops a step whose feature is off, unless its key is held', () => {
    const off = { ...ALL_FEATURES_ENABLED, sessions: false, announcements: false };
    expect(ids(stepsFor('exec', UNRESTRICTED, off))).toEqual([
      'welcome', 'members', 'club-events', 'settings', 'done',
    ]);
    // An admin holds every page.access key by level.
    expect(ids(stepsFor('admin', UNRESTRICTED, off))).toContain('sessions');
  });

  it('gives a trainer only what the roster opens, and never starts by itself for one', () => {
    expect(effectiveCapabilities('trainer', UNRESTRICTED)).toEqual(new Set(TRAINER_BASELINE));
    expect(ids(stepsFor('trainer', UNRESTRICTED))).toEqual(['welcome', 'members', 'settings', 'done']);
    expect(execTourMayAutoStart('trainer')).toBe(false);
    expect(execTourMayAutoStart(null)).toBe(false);
    expect(execTourMayAutoStart('exec')).toBe(true);
    expect(execTourMayAutoStart('admin')).toBe(true);
  });

  it('uses the exec key', () => {
    expect(EXEC_TOUR_KEY).toBe('exec_v2');
  });
});

describe('the exec tour stays tied to the console', () => {
  const all = execTourSteps(new Set());

  it('names only capabilities that exist', () => {
    const named = all.flatMap((s) => [
      ...(s.requires?.capabilitiesAll ?? []),
      ...(s.requires?.capabilitiesAny ?? []),
    ]);
    expect(named.length).toBeGreaterThan(0);
    for (const c of named) expect(isCapability(c), c).toBe(true);
    // And the ones read for the optional sentences.
    for (const c of ['sessions.create.write', 'sessions.update.write', 'sessions.checkin.token.write', 'announcements.discord.write']) {
      expect(isCapability(c), c).toBe(true);
    }
  });

  it('visits only pages the top bar offers', () => {
    const offered = new Set(flattenEntries(NAV_LAYOUT).map((item) => item.href));
    const hrefs = all.flatMap((s) => (s.href ? [s.href] : []));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(offered, href).toContain(href);
  });

  // A step whose page bounces the reader costs a page trip and a wait before it
  // is skipped, so every step a reader is given must be on a page they can open.
  it('gives each reader only steps on pages they can open', () => {
    const readers: [string, AccessLevel, Permissions][] = [
      ['admin', 'admin', UNRESTRICTED],
      ['exec on the baseline', 'exec', UNRESTRICTED],
      ['trainer', 'trainer', UNRESTRICTED],
      ['internal', 'exec', role('internal')],
      ['external', 'exec', role('external')],
      ['tournaments', 'exec', role('tournaments')],
    ];
    for (const [name, level, permissions] of readers) {
      for (const step of stepsFor(level, permissions)) {
        if (!step.href) continue;
        expect(canAccess(level, permissions, step.href), `${name}: ${step.id} on ${step.href}`).toBe(true);
      }
    }
  });

  it('names only features that exist', () => {
    const features = new Set<string>(FEATURES.map((f) => f.id));
    for (const f of all.flatMap((s) => s.requires?.featuresAny ?? [])) expect(features, f).toContain(f);
  });

  it('has no em dash and no emoji in what it says, and visits a page for each step', () => {
    const everyHeld = execTourSteps(new Set(effectiveCapabilities('admin', UNRESTRICTED)));
    for (const step of [...all, ...everyHeld]) {
      for (const text of [step.title, step.body]) {
        expect(/\u2014/.test(text), `${step.id}: ${text}`).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(text), `${step.id}: ${text}`).toBe(false);
      }
    }
    for (const step of [...all, ...everyHeld]) {
      expect(step.body, step.id).not.toMatch(/\bOpen [A-Z]\w+, then\b/);
    }
    for (const step of all.filter((s) => s.id !== 'welcome' && s.id !== 'done')) {
      expect(step.href, step.id).toBeDefined();
    }
  });
});

// THE SELECTORS ARE STRINGS, and nothing but this ties them to the attributes
// they name. Rename an attribute and the step silently skips.
describe('the exec tour selectors still match the markup', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
  const named = execTourSteps(new Set())
    .flatMap((s) => s.targets)
    .flatMap((t) => [...t.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]!));
  const carriers: Record<string, string[]> = {
    'pending-approvals': ['app/dashboard/page.tsx'],
    'sessions-upcoming': ['app/sessions/page.tsx'],
    'checkin-qr': ['app/sessions/actions.tsx'],
    'door-tonight': ['app/sessions/page.tsx'],
    // Both branches of the players page: the table, and the card shown to a
    // reader without players.read.
    roster: ['app/players/roster-table.tsx', 'app/players/page.tsx'],
    'events-upcoming': ['app/events/page.tsx'],
    'announcement-composer': ['app/announcements/page.tsx'],
    'member-pages': ['app/accounts/page.tsx'],
    passkeys: ['app/settings/page.tsx'],
  };

  it('every data-tour value is on the element expected to carry it', () => {
    expect(named.length).toBeGreaterThan(0);
    for (const value of named) {
      const files = carriers[value];
      expect(files, `no carrier recorded for data-tour="${value}"`).toBeDefined();
      for (const file of files!) {
        expect(src(file), `${file} no longer carries ${value}`).toContain(`data-tour="${value}"`);
      }
    }
  });

  it('every data-tour anchor in these files is targeted by a step', () => {
    for (const file of new Set(Object.values(carriers).flat())) {
      for (const m of src(file).matchAll(/data-tour="([^"]+)"/g)) {
        expect(named, `${file} carries data-tour="${m[1]}" and no step targets it`).toContain(m[1]);
      }
    }
  });
});
