import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The player twin of admin's tournament-refusal-classification test, and the
// reason it exists is that the player app was nearly missed: the first sweep for
// plain-Error throws was `head`-truncated and every line it printed was admin's.
// The exposure is identical — a plain Error refusal is reported BOTH via
// onRequestError when it escapes the action and via runAction's captureException
// when it does not, because it carries no marker and is not on the guard
// allowlist.
//
// Source-level for the same reason as the admin twin: the classification is the
// thing at risk, not the control flow, and mocking Supabase for twenty actions
// to assert one word in each buys nothing.

const LIB = fileURLToPath(new URL('../', import.meta.url));
const ALL = ['tournament-actions.ts', 'tournament-entry-core.ts', 'actions/sessions.ts', 'actions/profile.ts']
  .map((f) => readFileSync(`${LIB}${f}`, 'utf8'))
  .join('\n');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Refusals: a member arriving early, arriving late, mistyping a code, entering
// a full event, or acting on a page whose state has moved on.
const REFUSALS = [
  'Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.',
  'Registration is closed',
  'You must accept the event waiver to register',
  'Event is full',
  'Not registered',
  'Cannot check in',
  // 00276: past the member's own check-in window.
  'Check-in has closed, see the desk',
  'This session is closed',
  'Invalid check-in code',
  'Not authenticated',
  'No deletion is scheduled for this account',
  // 00278: the waitlist.
  'Others are waiting for this event, join the waitlist',
  'Event is full, join the waitlist',
  'You must accept the event waiver to join the waitlist',
  'This event does not have a waitlist.',
  'You are already on the waitlist for this event.',
  'This event has room, so you can enter it now.',
  'You are not on the waitlist for this event.',
];

// Faults, and each one has a specific reason to stay loud.
//
// 'Could not check how full this event is' used to be here — a failed COUNT
// rather than a full event. 00185 moved the counting into
// enter_tournament_event, so there is no read left to fail: a broken count is
// now an RPC error, which registerForEvent already rethrows as a plain Error.
const FAULTS = [
  // Under RLS a row the caller cannot see is not an error at all, so an
  // RLS regression looks exactly like a genuinely absent event. See
  // expected-error.ts on why 'Challenge not found' is off the guard allowlist.
  'Event not found',
  // The RPC came back with a refusal nobody has written a sentence for yet, or
  // with no payload at all. Not a rule saying no — something is wrong.
  'Could not complete your entry — please try again shortly.',
  'Could not add you to the waitlist, please try again shortly.',
  'Could not take you off the waitlist, please try again shortly.',
];

describe('player refusal classification', () => {
  it.each(REFUSALS)('is thrown as an ExpectedError: %s', (message) => {
    expect(ALL).toMatch(new RegExp(`throw new ExpectedError\\('${escape(message)}'\\)`));
    expect(ALL).not.toMatch(new RegExp(`throw new Error\\('${escape(message)}'\\)`));
  });

  it.each(FAULTS)('stays a plain Error so Sentry still hears about it: %s', (message) => {
    expect(ALL).toMatch(new RegExp(`throw new Error\\('${escape(message)}'\\)`));
    expect(ALL).not.toMatch(new RegExp(`throw new ExpectedError\\('${escape(message)}'\\)`));
  });

  it('says the waitlist is not available yet, as a refusal, before 00278 runs', () => {
    expect(ALL).toContain("const WAITLIST_NOT_AVAILABLE = 'The waitlist is not available yet';");
    expect(ALL).toMatch(/throw new ExpectedError\(WAITLIST_NOT_AVAILABLE\)/);
    expect(ALL).not.toMatch(/throw new Error\(WAITLIST_NOT_AVAILABLE\)/);
  });

  it('interpolated refusals are marked too', () => {
    // Template literal, so the message cannot be matched as a whole string.
    const suspended = ALL.match(/throw new (\w+)\(`This tournament is currently suspended/g) ?? [];
    expect(suspended.length).toBeGreaterThan(0);
    for (const hit of suspended) expect(hit).toContain('ExpectedError');
  });

  it('marks the 00276 window refusals, which carry a time', () => {
    for (const lead of ['Registration opens ', 'Registration closed ', 'Check-in opens ']) {
      const hits = ALL.match(new RegExp(`throw new (\\w+)\\(\\s*\`${escape(lead)}`, 'g')) ?? [];
      expect(hits.length, lead).toBeGreaterThan(0);
      for (const hit of hits) expect(hit).toContain('ExpectedError');
    }
    // The RPC's reasons are mapped too, not left to the generic fault.
    for (const reason of ['registration_not_open', 'registration_window_closed']) {
      expect(ALL).toContain(`case '${reason}':`);
    }
    expect(ALL).toContain("reason === 'checkin_not_open'");
    expect(ALL).toContain("reason === 'checkin_window_closed'");
  });

  it('keeps the missing-event half of the check-in guard reportable', () => {
    // The guard used to be `!event || event.status !== 'checkin'`, one throw for
    // two very different situations. Marking that whole condition would have
    // hidden a vanished event behind a member arriving early.
    expect(ALL).toMatch(/if \(!event\) throw new Error\('Check-in is not open'\)/);
    expect(ALL).toMatch(/event\.status !== 'checkin'\) throw new ExpectedError\('Check-in is not open'\)/);
  });

  it('leaves the RLS 42501 backstops reporting', () => {
    // 42501 means session_checkin_open() / the RSVP policy rejected the write
    // AFTER the app-level window check let it through. That disagreement is
    // either a policy regression or app/DB drift, and both are worth a report —
    // so these two stay plain Errors even though their wording reads like a
    // refusal. The refusal a member actually meets is the ExpectedError thrown
    // by the window check above them.
    expect(ALL).toMatch(/throw new Error\('Check-in is not open for this session'\)/);
    expect(ALL).toMatch(/throw new Error\('RSVP is not open for this session'\)/);
  });
});
