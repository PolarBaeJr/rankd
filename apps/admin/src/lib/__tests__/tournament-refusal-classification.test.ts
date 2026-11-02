import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A source-level test, deliberately, because the alternative is standing up a
// mock Supabase for twenty actions to assert one word in each. The classification
// IS the thing at risk here: nothing about `throw new Error('Event is full')`
// looks wrong, it type-checks, it reaches the user correctly, and the only
// consequence is a Sentry issue nobody asked for.
//
// It reads both ways on purpose. The refusal list must stay marked so the four
// tournament routes stay quiet; the FAULT list must stay unmarked, and that is
// the assertion that matters — the "Could not check ... try again" family is a
// failed DB read, and 'Event not found' under RLS is indistinguishable from a
// row the caller cannot see, which expected-error.ts already argues has to stay
// loud (the 00032 fallout).

const DIR = fileURLToPath(new URL('../tournament-actions/', import.meta.url));
const read = (f: string) => readFileSync(`${DIR}${f}`, 'utf8');

const SOURCES = ['participants.ts', 'brackets.ts', 'events.ts', 'finalize.ts', 'seeding.ts', 'team-category.ts'];
const ALL = SOURCES.map(read).join('\n');

// State guards a stale tab or a mistimed click can meet. Each message tells the
// person what to do instead, which is the tell that it is a refusal.
const REFUSALS = [
  'Draw is locked. Unlock it before making changes.',
  'Draw is locked. Unlock it before generating bracket.',
  'Draw is locked. Unlock it before generating matches.',
  'Draw is locked. Unlock it before changing seeds.',
  'Draw is locked. Unlock it before clearing seeds.',
  'Cannot add participants in current status',
  'Cannot add pairs in current status',
  'Event is full',
  'Player already registered for this event',
  'Need at least 2 participants to generate a bracket',
  'Need at least 3 participants for round robin',
  'Can only delete events in registration status',
  'Event must be completed first',
  'Event must be live to finalize',
  'Placement bonuses not enabled for this event',
  // 00278: the waitlist switch.
  'An external event has no waitlist: its teams are entered by name.',
  'The waitlist can only be changed while the event is taking entries or checking in.',
  'People are still waiting. Promote or remove them before switching the waitlist off.',
  // 00312: the waitlist limit.
  'The waitlist limit must be a whole number of at least 1, or blank for no limit.',
  // 00279: a category change after play is a request.
  'A category change for this team is waiting for approval. Cancel or decide it first.',
  'Give a reason for the change.',
  'Keep the reason under 500 characters.',
  'This team has not played with head starts yet, so change its category directly.',
  'This team already has a category change waiting for approval.',
  'Only the person who asked can cancel this request.',
];

// Genuine faults. A failed read, a failed revalidate, or a row that should be
// there and is not.
const FAULTS = [
  'Could not check this tournament’s event limit. Nothing was added — try again.',
  'Could not check how full this event is. Nothing was added — try again.',
  'Could not read player ratings. Nothing was added — try again.',
  'Saved, but the page could not be refreshed. Reload to see the change.',
  'Event not found',
  'Participant not found',
  'Could not read this waitlist entry. Nothing was changed, try again.',
];

// 'Pair not found' is deliberately in NEITHER list. participants.ts throws it
// three times and already disagreed with itself before this change — twice as an
// ExpectedError (1368, 1491), once as a plain Error (1629) — so no single
// assertion is true of it. Left exactly as found rather than picking a side
// while changing something else: it wants deciding on its own, alongside
// 'Event not found', whose RLS-invisibility argument applies to it too.

describe('tournament-actions refusal classification', () => {
  it('marks the 00279 category request refusals, which are named by constant or mapped', () => {
    expect(ALL).toContain("const CATEGORY_MIGRATION_MISSING = 'Run migration 00279 first';");
    expect(ALL).toContain("const ALREADY_DECIDED = 'This request has already been decided. Reload the page.';");
    expect(ALL).toContain("return 'The team\\'s category changed after this was asked for. Decline it and ask again.';");
    expect(ALL).toContain("return 'That category is no longer one of this event\\'s.';");
    for (const name of ['CATEGORY_MIGRATION_MISSING', 'ALREADY_DECIDED', 'categoryRequestRefusal(result?.reason)']) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(ALL, name).toMatch(new RegExp(`throw new ExpectedError\\(${escaped}\\)`));
      expect(ALL, name).not.toMatch(new RegExp(`throw new Error\\(${escaped}\\)`));
    }
  });

  it('marks the 00278 waitlist refusals, which are named by constant or mapped', () => {
    expect(ALL).toContain("const WAITLIST_MIGRATION_MISSING = 'Run migration 00278 first';");
    expect(ALL).toContain("const NOT_WAITING = 'That member is no longer on the waitlist. Reload the page.';");
    for (const name of ['WAITLIST_MIGRATION_MISSING', 'NOT_WAITING', 'waitlistRefusal(result)']) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(ALL, name).toMatch(new RegExp(`throw new ExpectedError\\(${escaped}\\)`));
      expect(ALL, name).not.toMatch(new RegExp(`throw new Error\\(${escaped}\\)`));
    }
  });

  it('marks the 00312 waitlist limit refusal before the migration, which is named by constant', () => {
    expect(ALL).toContain("const WAITLIST_LIMIT_MIGRATION_MISSING = 'Run migration 00312 first';");
    expect(ALL).toMatch(/throw new ExpectedError\(WAITLIST_LIMIT_MIGRATION_MISSING\)/);
    expect(ALL).not.toMatch(/throw new Error\(WAITLIST_LIMIT_MIGRATION_MISSING\)/);
  });

  it.each(REFUSALS)('is thrown as an ExpectedError: %s', (message) => {
    const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(ALL).toMatch(new RegExp(`throw new ExpectedError\\('${escaped}'\\)`));
    expect(ALL).not.toMatch(new RegExp(`throw new Error\\('${escaped}'\\)`));
  });

  it.each(FAULTS)('stays a plain Error so Sentry still hears about it: %s', (message) => {
    const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(ALL).toMatch(new RegExp(`throw new Error\\('${escaped}'\\)`));
    expect(ALL).not.toMatch(new RegExp(`throw new ExpectedError\\('${escaped}'\\)`));
  });
});
