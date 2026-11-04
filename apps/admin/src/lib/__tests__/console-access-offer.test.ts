import { describe, it, expect } from 'vitest';
import { consoleAccessOffer } from '../console-access-offer';
import { EXEC_ROLE_OPTIONS } from '../console-access';

// WHAT THIS FILE IS FOR. /players now offers a console-access control per row,
// and the interesting half is the rows where it must NOT appear. Every one of
// those is already refused inside setConsoleAccessImpl — this only decides what
// is drawn — so the test is about the promise that nobody is shown a button
// guaranteed to refuse them, not about the boundary. The boundary's own tests
// are console-access-capability.test.ts and grant-closure.test.ts.

const base = { canWrite: true, isSelf: false, current: 'none' as const, viewerIsSuperAdmin: false };

describe('who gets the control at all', () => {
  it('offers it to a holder of players.consoleaccess.write', () => {
    expect(consoleAccessOffer(base).offered).toBe(true);
  });

  it('does not offer it without the capability', () => {
    // The capability the ACTION asks for, deliberately, and not
    // players.update.write: somebody who may correct a member's phone number
    // must not be shown a way to make themselves an executive.
    expect(consoleAccessOffer({ ...base, canWrite: false }).offered).toBe(false);
  });

  it('never offers it on the viewer’s own row', () => {
    // setConsoleAccess refuses a self-edit before it reads anything. Handing
    // yourself a level is the one move that would let this capability promote
    // its own holder.
    expect(consoleAccessOffer({ ...base, isSelf: true }).offered).toBe(false);
    expect(
      consoleAccessOffer({ ...base, isSelf: true, viewerIsSuperAdmin: true }).offered,
    ).toBe(false);
  });

  it('does not offer anybody but a super admin the row of an admin or a super admin', () => {
    // Taking the level away is the same act as giving it, so the levels only a
    // super admin hands out are the ones only a super admin takes back (00321).
    expect(consoleAccessOffer({ ...base, current: 'admin' }).offered).toBe(false);
    expect(consoleAccessOffer({ ...base, current: 'super_admin' }).offered).toBe(false);
  });

  it('offers a super admin the row of an admin or another super admin', () => {
    expect(
      consoleAccessOffer({ ...base, current: 'admin', viewerIsSuperAdmin: true }).offered,
    ).toBe(true);
    expect(
      consoleAccessOffer({ ...base, current: 'super_admin', viewerIsSuperAdmin: true }).offered,
    ).toBe(true);
  });

  it('offers a non-admin the row of an executive or a trainer', () => {
    expect(consoleAccessOffer({ ...base, current: 'executive' }).offered).toBe(true);
    expect(consoleAccessOffer({ ...base, current: 'trainer' }).offered).toBe(true);
  });
});

describe('which levels are offered', () => {
  it('withholds Admin and Super admin from anybody but a super admin', () => {
    // Filtered rather than disabled, matching /permissions: a capability that
    // could mint an admin would make holding it the same thing as being one.
    expect(consoleAccessOffer(base).options.map((o) => o.value)).toEqual([
      'none',
      'executive',
      'trainer',
    ]);
  });

  it('offers a super admin every level', () => {
    expect(consoleAccessOffer({ ...base, viewerIsSuperAdmin: true }).options).toEqual(
      EXEC_ROLE_OPTIONS,
    );
  });

  it('offers the levels in the order /permissions offers them', () => {
    // One vocabulary and one order across the two screens that set a level —
    // the whole reason EXEC_ROLE_OPTIONS is a shared constant.
    expect(consoleAccessOffer({ ...base, viewerIsSuperAdmin: true }).options.map((o) => o.value)).toEqual(
      EXEC_ROLE_OPTIONS.map((o) => o.value),
    );
  });
});
