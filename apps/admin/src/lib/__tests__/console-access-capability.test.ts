import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// GIVING SOMEBODY THE CONSOLE IS A CAPABILITY, AND THIS IS THE DOOR IT OPENS IN
// THE HARD FLOOR.
//
// `role`, `is_exec` and `is_trainer` are PLAYER_FIELD_FLOOR: refused to
// everybody below admin by assertPlayerFieldAccess, reachable by no capability,
// and the reason the capability system cannot be used to manufacture a level.
// 00105 opens exactly one path through that floor — setConsoleAccess, under
// `players.consoleaccess.write` — because the club owner asked for it: "also
// make role change a permission."
//
// EVERY REFUSAL THAT MAKES THAT SAFE IS PINNED HERE, and the file is written so
// that removing any one of them turns a test red. Where two refusals cover the
// same case (the explicit admin checks sit in front of a closure test that would
// also catch them), the assertion is on the MESSAGE — otherwise deleting the
// explicit check would leave the suite green and the claim untested.
//
// THE ONE THING THAT MUST NEVER BECOME REACHABLE: minting an admin. If a
// capability could do it, holding that capability would be the same thing as
// being an admin, and the floor would be decorative.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: {} as Row,
}));

// The harness permission-reason.test.ts and grant-closure.test.ts use, so the
// gate and the resolver under test are the real ones and only the database and
// the session are stubbed.
const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        (store.db[table] ??= []).push({ ...payload });
        return { data: [payload], error: null };
      }
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async maybeSingle() {
        const res = run();
        // A COPY, because PostgREST returns fresh JSON and a shared reference
        // would make every "what it was" snapshot in this file read back as
        // "what it is". That is a harness fidelity point, not a nicety: the
        // audit assertion below is exactly the thing it would silently break.
        const hit = res.data?.[0];
        return { data: hit ? { ...hit } : null, error: res.error };
      },
      // The same copy rule. `.single()` differs from maybeSingle only in that
      // PostgREST errors when there is no row — which is what
      // resolvePrivilegeClaimReview's read uses.
      async single() {
        const res = run();
        const hit = res.data?.[0];
        return hit
          ? { data: { ...hit }, error: null }
          : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));

// THE REAL GATE, run against the actor's real row. Nothing here decides who may
// do what — permits() does, from the same resolver the app uses — so a test that
// passes because the gate was stubbed open is not possible.
vi.mock('../actions/_shared', async () => {
  const { accessLevelFor, permissionsOf, permits } = await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      const level = accessLevelFor(store.actor);
      if (!permits(level, permissionsOf(level, store.actor), capability)) {
        throw new Error(`Missing capability: ${capability}`);
      }
      return store.actor;
    },
  };
});

// NO updatePlayer STUB ANY MORE, and its absence is the change this file is
// pinning. The admin half of the level write used to go through updatePlayer and
// was stubbed here, because updatePlayer is a large action with its own guard and
// its own audit row and what is under test is who reaches it. updatePlayer now
// refuses the three columns from every caller, so setConsoleAccess has ONE writer
// for everybody: writeConsoleLevel, inside actions/permissions.ts, writing through
// the mock client above. Every assertion below therefore sees the REAL columns
// and the REAL audit row for an admin as well as for a capability holder — which
// the stub could only approximate.

import { setConsoleAccess, setPlayerPermissions } from '../actions/permissions';
import { resolvePrivilegeClaimReview } from '../actions/players';
import {
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_BASELINE,
  ROLE_DEFAULTS,
  TRAINER_BASELINE,
  type Capability as Cap,
} from '../permissions';
import { isAccessChange } from '../officer-access';

const CONSOLE_CAP: Cap = 'players.consoleaccess.write';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
/** A super admin (00321): the one level that may make or unmake an admin. */
const SUPER = 'aaaaaaaa-0000-4000-8000-000000000009';
/** Holds every capability an admin may compose — the widest legitimate holder. */
const FULL_HOLDER = 'ffffffff-0000-4000-8000-000000000001';
/** Holds the trainer baseline plus the console capability, and nothing else. */
const SMALL_HOLDER = 'ffffffff-0000-4000-8000-000000000002';
/** An ordinary unrestricted exec: permissions.write is not in EXEC_BASELINE. */
const PLAIN_EXEC = 'eeeeeeee-0000-4000-8000-000000000001';
/** An unrestricted exec, as a TARGET. */
const TARGET_EXEC = 'eeeeeeee-0000-4000-8000-000000000002';
/** Nobody: no level at all. */
const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000001';

const WHY = 'Elected at the AGM and needs the console';

const person = (id: string, extra: Row = {}): Row => ({
  id,
  full_name: `Person ${id.slice(0, 4)}`,
  email: null,
  role: 'player',
  is_exec: false,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  permission_baseline_id: null,
  ...extra,
});

const rowFor = (id: string) => store.db.players!.find((p) => p.id === id)!;
const audits = () => store.db.audit_logs ?? [];
const levelAudits = () => audits().filter((a) => a.action_type === 'player_updated');
const permissionAudits = () =>
  audits().filter((a) => a.action_type === 'player_permissions_changed');
const errorOf = (res: { ok: boolean } | { ok: false; error: string }) =>
  'error' in res ? res.error : '';

beforeEach(() => {
  store.db = {
    players: [
      person(ADMIN, { role: 'admin', is_exec: true }),
      person(ADMIN_2, { role: 'admin', is_exec: true }),
      person(SUPER, { role: 'super_admin', is_exec: true }),
      // A composed exec holding the whole ceiling. Every element is in
      // EDITOR_OFFERABLE, so this is a row an admin could actually write through
      // setPlayerPermissions — asserted at the bottom of this file rather than
      // assumed.
      person(FULL_HOLDER, {
        is_exec: true,
        permission_role: 'custom',
        permission_grants: [...EDITOR_OFFERABLE],
      }),
      // A composed TRAINER holding the console capability. The point of the
      // pair: the same capability, two different ceilings, because closure — not
      // a second capability — is what decides which levels they may hand out.
      //
      // IT WAS `is_exec: true` AND HAD TO STOP BEING, which is the level floor
      // showing up in a fixture. The row was trainer-SIZED only because a role
      // replaced the base; now the level's baseline is a floor under every
      // composition, so an exec is never trainer-sized — this row would hold all
      // twelve exec reads and could promote somebody to executive, which is the
      // exact thing the next test says it must not do. A varsity trainer is what
      // the comment always described, and composable trainers (00090) make it a
      // state the club can actually be in.
      person(SMALL_HOLDER, {
        is_trainer: true,
        permission_role: 'custom',
        permission_grants: [...TRAINER_BASELINE, CONSOLE_CAP],
      }),
      person(PLAIN_EXEC, { is_exec: true }),
      person(TARGET_EXEC, { is_exec: true }),
      person(MEMBER),
    ],
    audit_logs: [],
  };
  store.actor = rowFor(ADMIN);
});

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

describe('the capability is what opens the action', () => {
  it('refuses an ordinary exec, who holds permissions but not this', async () => {
    store.actor = rowFor(PLAIN_EXEC);
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain(CONSOLE_CAP);
    expect(rowFor(MEMBER).is_trainer).toBe(false);
    expect(audits()).toHaveLength(0);
  });

  it('lets an admin through by LEVEL, as it always did', async () => {
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).is_trainer).toBe(true);
  });

  it('lets a holder through who is not an admin', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).is_trainer).toBe(true);
    expect(rowFor(MEMBER).is_exec).toBe(false);
    expect(rowFor(MEMBER).role).toBe('player');
  });

  // THE WHOLE FEATURE, END TO END: an admin can actually put this capability on
  // somebody's row. It is the assertion that makes every test above about a real
  // state rather than one hand-written into the fixture — the reason
  // EDITOR_OFFERABLE membership was not optional.
  it('can be granted to a non-admin through the ordinary permissions editor', async () => {
    const res = await setPlayerPermissions(PLAIN_EXEC, {
      role: 'custom',
      // THE WHOLE TRAINER BASELINE, not just the console capability. Promoting
      // somebody to varsity trainer hands them all three of TRAINER_BASELINE, and
      // closure refuses an actor who does not hold every one of them — which is
      // the graduation this feature relies on, met here in passing.
      grants: [...TRAINER_BASELINE, CONSOLE_CAP],
      revokes: [],
      reason: WHY,
    });
    expect(res.ok).toBe(true);
    expect(rowFor(PLAIN_EXEC).permission_grants).toContain(CONSOLE_CAP);

    // ...and it works the moment it lands.
    store.actor = rowFor(PLAIN_EXEC);
    const used = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(used.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE LINE THAT DOES NOT MOVE — no capability mints an admin
// ---------------------------------------------------------------------------

describe('the admin level is not grantable by any capability', () => {
  // MESSAGE-ASSERTED ON PURPOSE. Closure would refuse this too, because an admin
  // resolves to all 119 capabilities and no holder has them — so a test that
  // only checked `ok === false` would pass with the explicit check deleted. The
  // explicit check is the sentence a treasurer can act on; closure is the floor
  // underneath it. Both are wanted, and only this assertion tells them apart.
  it('refuses the widest possible holder, in its own words', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'admin', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe('Only a super admin can make somebody an admin or a super admin.');
    expect(rowFor(MEMBER).role).toBe('player');
    expect(audits()).toHaveLength(0);
  });

  it('refuses a holder even when the target already has a level', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(TARGET_EXEC, 'admin', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe('Only a super admin can make somebody an admin or a super admin.');
    expect(rowFor(TARGET_EXEC).role).toBe('player');
  });

  // 00321: an admin no longer mints an admin, nor a super admin.
  it('refuses an admin making an admin or a super admin', async () => {
    for (const access of ['admin', 'super_admin'] as const) {
      const res = await setConsoleAccess(MEMBER, access, WHY);
      expect(res.ok).toBe(false);
      expect(errorOf(res)).toBe('Only a super admin can make somebody an admin or a super admin.');
    }
    expect(rowFor(MEMBER).role).toBe('player');
  });

  it('lets a super admin make an admin and a super admin', async () => {
    store.actor = rowFor(SUPER);
    const res = await setConsoleAccess(MEMBER, 'admin', WHY);
    expect(res.ok, errorOf(res)).toBe(true);
    expect(rowFor(MEMBER).role).toBe('admin');
    const promoted = await setConsoleAccess(ADMIN_2, 'super_admin', WHY);
    expect(promoted.ok, errorOf(promoted)).toBe(true);
    expect(rowFor(ADMIN_2).role).toBe('super_admin');
    expect(rowFor(ADMIN_2).is_exec).toBe(true);
  });

  // The vocabulary itself, as a second line of defence: no capability string
  // names a level, so there is nothing to grant that would BE the admin level
  // even if a gate were written carelessly.
  it('has no capability naming a level at all', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.includes('admin'), capability).toBe(false);
      expect(capability.includes('exec'), capability).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// REVOCATION — taking it away is the same act
// ---------------------------------------------------------------------------

describe('taking console access away', () => {
  // MESSAGE-ASSERTED for the same reason as the admin-minting pair: closure
  // catches this too, because an admin's `before` is every capability there is.
  it('refuses a holder trying to strip an admin', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(ADMIN_2, 'none', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe("Only a super admin can change an admin's console access.");
    expect(rowFor(ADMIN_2).role).toBe('admin');
    expect(rowFor(ADMIN_2).is_exec).toBe(true);
  });

  it('refuses a holder trying to demote an admin to executive', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(ADMIN_2, 'executive', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe("Only a super admin can change an admin's console access.");
    expect(rowFor(ADMIN_2).role).toBe('admin');
  });

  it('refuses an admin stripping another admin or a super admin (00321)', async () => {
    for (const target of [ADMIN_2, SUPER]) {
      const res = await setConsoleAccess(target, 'executive', WHY);
      expect(res.ok).toBe(false);
      expect(errorOf(res)).toBe("Only a super admin can change an admin's console access.");
    }
    expect(rowFor(ADMIN_2).role).toBe('admin');
    expect(rowFor(SUPER).role).toBe('super_admin');
  });

  it('lets a holder take the console from somebody inside their own set', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(TARGET_EXEC, 'none', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(false);
    expect(rowFor(TARGET_EXEC).is_trainer).toBe(false);
  });

  // THE CLEAR PATH, UNDER THE NEW GATE. A holder does not hold
  // `permissions.write` — nobody below admin can — so this is the case that
  // proves splitting applyPlayerPermissions out of the gated action actually
  // works, rather than half-applying: the level goes, the composition goes with
  // it, and both are audited.
  it('clears a stored composition it can no longer reach, without permissions.write', async () => {
    Object.assign(rowFor(TARGET_EXEC), {
      permission_role: 'custom',
      permission_grants: ['fees.page', 'fees.expenses.read'],
      permission_revokes: [],
    });
    store.actor = rowFor(FULL_HOLDER);

    const res = await setConsoleAccess(TARGET_EXEC, 'none', WHY);

    expect(res.ok).toBe(true);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(false);
    expect(rowFor(TARGET_EXEC).permission_role).toBe(null);
    expect(rowFor(TARGET_EXEC).permission_grants).toEqual([]);
    expect(permissionAudits()).toHaveLength(1);
    expect(permissionAudits()[0]!.reason).toBe(WHY);
  });
});

// ---------------------------------------------------------------------------
// SELF-EDIT — the one move that would let the capability promote its holder
// ---------------------------------------------------------------------------

describe('nobody changes their own console access', () => {
  it('refuses self-PROMOTION by a holder', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(SMALL_HOLDER, 'executive', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe(
      'You cannot change your own console access. Ask another admin to do it.',
    );
    expect(audits()).toHaveLength(0);
  });

  it('refuses self-DEMOTION by an admin, as it always did', async () => {
    const res = await setConsoleAccess(ADMIN, 'none', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe(
      'You cannot change your own console access. Ask another admin to do it.',
    );
    expect(rowFor(ADMIN).role).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// GRANT CLOSURE — what makes one capability enough for two levels
// ---------------------------------------------------------------------------

describe('closure decides which levels a holder may hand out', () => {
  it('lets a trainer-sized holder make a varsity trainer', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).is_trainer).toBe(true);
  });

  // THE GRADUATION, AND IT IS WHY THIS IS ONE CAPABILITY RATHER THAN TWO.
  // Promoting to executive hands over EXEC_BASELINE — twelve reads, down from
  // the historic 73, so the bar is LOWER than it was. This holder still does not
  // clear it: their four are the trainer floor plus the console capability, and
  // the exec floor contains eight section pages they have never held. Nothing
  // about the capability says "trainer only" — the baselines do.
  it('refuses the same holder making an executive', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'executive', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/^That would give them /);
    expect(rowFor(MEMBER).is_exec).toBe(false);
    expect(audits()).toHaveLength(0);
  });

  it('lets a holder with the whole ceiling make an executive', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'executive', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).is_exec).toBe(true);
  });

  // THE OTHER DIRECTION, and it is the denial-of-access half: a narrowly scoped
  // holder must not be able to take the console from somebody who was elected to
  // more of it than they hold.
  it('refuses a holder reaching into somebody who holds more than they do', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(TARGET_EXEC, 'none', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/^You cannot change this person's console access/);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(true);
  });

  // EXECUTIVE TO TRAINER KEEPS THE COMPOSITION, so `after` has to be computed
  // through it rather than from the new level's baseline. A holder whose set does
  // not cover what the composition leaves them with is refused; one whose set
  // does is not. Getting this branch wrong would make the check wrong in exactly
  // the case where a composition is what the person actually holds.
  it('measures a live-to-live move against the composition, not the baseline', async () => {
    Object.assign(rowFor(TARGET_EXEC), {
      permission_role: 'custom',
      permission_grants: ['fees.page', 'fees.expenses.read'],
      permission_revokes: [],
    });
    store.actor = rowFor(SMALL_HOLDER);

    // The target is an EXEC, so before the move they hold the exec floor plus
    // their composition — and this holder, a trainer, holds neither. The BEFORE
    // test refuses them, and would do so on the floor alone: closure got easier
    // WITHIN a level (everybody shares a floor, so it cancels) and no easier
    // across one, which is the direction that matters.
    //
    const refused = await setConsoleAccess(TARGET_EXEC, 'trainer', WHY);
    expect(refused.ok).toBe(false);
    expect(errorOf(refused)).toMatch(/^You cannot change this person's console access/);

    // ...and the composition SURVIVES the move when somebody who does hold them
    // makes it, which is the behaviour that makes computing `after` through it
    // necessary in the first place.
    store.actor = rowFor(FULL_HOLDER);
    const allowed = await setConsoleAccess(TARGET_EXEC, 'trainer', WHY);
    expect(allowed.ok).toBe(true);
    expect(rowFor(TARGET_EXEC).is_trainer).toBe(true);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(false);
    expect(rowFor(TARGET_EXEC).permission_role).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// THE LEVEL AND THE JOB, IN ONE ACT
// ---------------------------------------------------------------------------
// setConsoleAccess takes a baseline now, because giving somebody the console and
// giving them the job they were elected to were two saves with a read-only
// executive in between them. What is pinned here is that it is ONE act: every
// refusal is measured against the post-baseline state and leaves the row and the
// log untouched, which is what makes the combined version safe to offer.

describe('a baseline handed over in the same act as the level', () => {
  const SOCIALS = '5eed0060-0000-4000-8000-000000000201';
  const NO_SUCH_BASELINE = '5eed0060-0000-4000-8000-0000000002ff';
  /** Inside EDITOR_OFFERABLE, and carrying its own area page so it resolves. */
  const SOCIALS_CAPS: Cap[] = ['announcements.create.write', 'announcements.page'];

  beforeEach(() => {
    store.db.permission_baselines = [
      { id: SOCIALS, name: 'Socials', capabilities: [...SOCIALS_CAPS], builtin_role: null },
    ];
  });

  // THE ADMIN IS THE ACTOR AND IT IS NOT A WEAKER TEST THAN IT LOOKS. The apply
  // half goes through setPlayerPermissions, which asks for `permissions.write`:
  // outside EDITOR_OFFERABLE, so nobody below admin can hold it. FULL_HOLDER is
  // the widest legitimate holder and still cannot finish this act; the case below
  // pins that, because it is the accepted consequence rather than a defect.
  it('writes the level and the job, with one audit row each', async () => {
    const res = await setConsoleAccess(MEMBER, 'executive', WHY, SOCIALS);
    expect(res.ok, errorOf(res)).toBe(true);

    const row = rowFor(MEMBER);
    expect(row.is_exec).toBe(true);
    expect(row.permission_role).toBe('custom');
    expect(row.permission_grants).toEqual(SOCIALS_CAPS);
    expect(row.permission_baseline_id).toBe(SOCIALS);

    // TWO ROWS AND NO NEW ACTION TYPE. One act, audited as the level change it is
    // and the permissions change it is, both carrying the one reason typed for it.
    expect(levelAudits()).toHaveLength(1);
    expect(permissionAudits()).toHaveLength(1);
    expect(levelAudits()[0]!.reason).toBe(WHY);
    expect(permissionAudits()[0]!.reason).toBe(WHY);
  });

  // ALL OR NOTHING, AND THIS IS THE ASSERTION THAT BUYS IT. The baseline is folded
  // into `after` before assertLevelClosure runs, so a baseline the actor could not
  // have granted takes the LEVEL down with it, rather than landing the promotion
  // and then refusing the job, which is the half-applied member the old two-step
  // could produce.
  //
  // THE LEVEL ASKED FOR IS `trainer` ON PURPOSE: this holder is already refused
  // `executive` by the exec floor, so an executive-plus-baseline case would pass
  // for the wrong reason and stay green with the `after` change reverted.
  it('refuses a holder a baseline they do not hold, and writes nothing at all', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY, SOCIALS);

    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/^That would give them /);
    expect(rowFor(MEMBER).is_trainer).toBe(false);
    expect(rowFor(MEMBER).role).toBe('player');
    expect(rowFor(MEMBER).permission_role).toBe(null);
    expect(audits()).toHaveLength(0);
  });

  // THE ACCEPTED HALF-APPLY, STATED AS A TEST. A non-admin holder of the console
  // capability cannot reach the apply, because `permissions.write` is not
  // offerable to anybody, so the level lands and the job does not, and they are
  // told so. That is strictly better than the silent two-step it replaces, and the
  // picker is never drawn for them; it is pinned here so a later reader does not
  // discover it from a support conversation.
  it('tells the widest non-admin holder the baseline could not be applied', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'executive', WHY, SOCIALS);

    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/^Console access changed, but the baseline could not be applied/);
    expect(rowFor(MEMBER).is_exec).toBe(true);
    expect(rowFor(MEMBER).permission_role).toBe(null);
    expect(levelAudits()).toHaveLength(1);
    expect(permissionAudits()).toHaveLength(0);
  });

  it('refuses a baseline that no longer exists, before the level write', async () => {
    const res = await setConsoleAccess(MEMBER, 'executive', WHY, NO_SUCH_BASELINE);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe('That baseline no longer exists.');
    expect(rowFor(MEMBER).is_exec).toBe(false);
    expect(audits()).toHaveLength(0);
  });

  // A BASELINE ON A LEVEL THAT CONSULTS NO STORED SET is the dormant-delta hazard
  // one level up: a composition nobody can see, on a row where it grants nothing,
  // waiting for the day the person is promoted again.
  it('refuses a baseline on a level that would never consult it', async () => {
    const res = await setConsoleAccess(TARGET_EXEC, 'none', WHY, SOCIALS);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/only means something at executive or varsity trainer/);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(true);
    expect(audits()).toHaveLength(0);
  });

  // THE OTHER TWENTY-TWO CALL SITES. The parameter is defaulted, and a three-
  // argument call has to go on doing exactly what it did, including the roster
  // dialog on /players, which does not query permission_baselines at all.
  it('leaves a three-argument call exactly as it was', async () => {
    const res = await setConsoleAccess(MEMBER, 'executive', WHY);
    expect(res.ok, errorOf(res)).toBe(true);
    expect(rowFor(MEMBER).is_exec).toBe(true);
    expect(rowFor(MEMBER).permission_role).toBe(null);
    expect(rowFor(MEMBER).permission_grants).toEqual([]);
    expect(rowFor(MEMBER).permission_baseline_id).toBe(null);
    expect(levelAudits()).toHaveLength(1);
    expect(permissionAudits()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE AUDIT ROW THE SECOND WRITER LEAVES
// ---------------------------------------------------------------------------
// The non-admin path does not go through updatePlayer — the hard floor stops it
// — so it writes its own row. isAccessChange() picks console-access changes out
// of the log by looking for `player_updated` rows naming one of the three level
// columns, so a different shape here would make a holder's changes vanish from
// the access-changes view. Silently, which is the whole reason this is asserted.

describe('a holder’s change is visible in the access log', () => {
  it('writes a player_updated row naming all three level columns', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'executive', WHY);
    expect(res.ok).toBe(true);

    expect(levelAudits()).toHaveLength(1);
    const row = levelAudits()[0]!;
    expect(row.actor_id).toBe(FULL_HOLDER);
    expect(row.target_id).toBe(MEMBER);
    expect(row.reason).toBe(WHY);
    expect(row.new_value).toEqual({ role: 'player', is_exec: true, is_trainer: false });
    expect(isAccessChange(row as { action_type: string; new_value?: unknown })).toBe(true);
  });

  it('records what it was, so the row answers what changed', async () => {
    store.actor = rowFor(FULL_HOLDER);
    await setConsoleAccess(TARGET_EXEC, 'trainer', WHY);
    const old = levelAudits()[0]!.old_value as { player: Row };
    expect(old.player.is_exec).toBe(true);
    expect(old.player.is_trainer).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // AN ADMIN DID NOT LOSE THE ABILITY TO DO THIS
  // ---------------------------------------------------------------------------
  // The member Edit dialog used to carry a console-access select and no longer
  // does, so this page is the whole of an admin's route to the act. That makes
  // "an admin can still set every level, and it lands, and it is visible" a claim
  // worth asserting rather than assuming — a removal that quietly took the
  // capability with it would look exactly like a tidy-up.
  //
  // THIS IS ALSO THE ADMIN WRITE PATH ITSELF, unstubbed for the first time.
  // updatePlayer used to stand in for it here; the columns and the audit row
  // below are now the real ones writeConsoleLevel produces for an admin.
  //
  // THE SUBJECT IS CHOSEN SO EACH CASE IS A REAL CHANGE. setConsoleAccess
  // correctly does nothing when the level asked for is the one already held, and
  // a no-op writes no audit row — so pointing every case at the same person would
  // make one of the four assert against an empty log for the right reason.
  it.each([
    ['executive', MEMBER, { role: 'player', is_exec: true, is_trainer: false }],
    ['trainer', MEMBER, { role: 'player', is_exec: false, is_trainer: true }],
    ['admin', MEMBER, { role: 'admin', is_exec: true, is_trainer: false }],
    ['none', TARGET_EXEC, { role: 'player', is_exec: false, is_trainer: false }],
  ] as const)('lets an admin set %s, writing all three columns', async (access, subject, columns) => {
    // Admin is a super admin's to hand out (00321), so that one case runs as
    // the super admin; the audit's actor is whoever acted.
    if (access === 'admin') store.actor = rowFor(SUPER);
    const res = await setConsoleAccess(subject, access, WHY);
    expect(res.ok, errorOf(res)).toBe(true);

    const row = rowFor(subject);
    expect(row.role).toBe(columns.role);
    expect(row.is_exec).toBe(columns.is_exec);
    expect(row.is_trainer).toBe(columns.is_trainer);

    // ...and it reaches the one screen that answers "who was given what, and
    // when". An admin's change going unlogged is the 2026-08-15 shape exactly.
    const audit = levelAudits()[0]!;
    expect(audit.actor_id).toBe(access === 'admin' ? SUPER : ADMIN);
    expect(audit.reason).toBe(WHY);
    expect(audit.new_value).toEqual(columns);
    expect(isAccessChange(audit as { action_type: string; new_value?: unknown })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WHERE THE CAPABILITY SITS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE OTHER WRITER OF THE THREE COLUMNS: THE ROSTER-CLAIM RESTORE (00132)
// ---------------------------------------------------------------------------
// resolvePrivilegeClaimReview puts back exactly what a claim withheld, and it is
// a SECOND UI surface for the same act — a card on /players rather than the
// control on /permissions — running under this same capability.
//
// ASKING FOR THE SAME CAPABILITY IS NOT THE SAME THING AS APPLYING THE SAME RULE,
// and for a while it was not: the restore wrote the columns directly, with no
// closure test in either direction. A five-capability officer resolving a review
// could hand a colleague the whole exec baseline — plus any dormant composition
// on the row, because a restore does not clear one — none of which the officer
// held. That is the identical defect class this branch exists to close, one
// screen over, so the fix is the SAME function and not a second transcription.
describe('the roster-claim restore is bounded like every other level change', () => {
  const CLAIMANT = 'cccccccc-0000-4000-8000-000000000001';

  /** Somebody whose exec marker a claim withheld at first sign-in. */
  const withheldExec = (extra: Row = {}): Row =>
    person(CLAIMANT, {
      privilege_claim_review: {
        state: 'held',
        at: '2026-08-15T00:00:00.000Z',
        withheld: { is_exec: true },
        kept: {},
      },
      ...extra,
    });

  beforeEach(() => {
    store.db.players!.push(withheldExec());
  });

  it('refuses a holder who does not hold what the restore would hand over', async () => {
    // A trainer-sized holder: the console capability and the trainer baseline,
    // and nothing of the exec one. Restoring is_exec would confer EXEC_BASELINE.
    store.actor = rowFor(SMALL_HOLDER);
    const res = await resolvePrivilegeClaimReview(CLAIMANT, 'restore');
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/which you do not hold/);
    // NOTHING WRITTEN — not the columns, and not the flag either. A restore that
    // cleared the review while refusing the privileges would destroy the only
    // record of what is owed to this member.
    expect(rowFor(CLAIMANT).is_exec).toBe(false);
    expect(rowFor(CLAIMANT).privilege_claim_review).toBeTruthy();
  });

  it('lets a holder with the whole ceiling do it, and writes the column', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await resolvePrivilegeClaimReview(CLAIMANT, 'restore');
    expect(res.ok, errorOf(res)).toBe(true);
    expect(rowFor(CLAIMANT).is_exec).toBe(true);
    expect(rowFor(CLAIMANT).privilege_claim_review).toBe(null);
  });

  it('lets an admin do it', async () => {
    const res = await resolvePrivilegeClaimReview(CLAIMANT, 'restore');
    expect(res.ok, errorOf(res)).toBe(true);
    expect(rowFor(CLAIMANT).is_exec).toBe(true);
  });

  // A DISMISS HANDS OVER NOTHING, so check 2 can never fire and the ORDINARY
  // case — a fully-stripped member, who resolves to no level and an empty
  // `before` — passes for any holder. That matters: a closure check bolted on
  // carelessly would have refused this too, and reviews would have piled up
  // behind a refusal nobody could act on.
  it('lets a narrow holder DISMISS a review on somebody with no level', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await resolvePrivilegeClaimReview(CLAIMANT, 'dismiss');
    expect(res.ok, errorOf(res)).toBe(true);
    expect(rowFor(CLAIMANT).is_exec).toBe(false);
    expect(rowFor(CLAIMANT).privilege_claim_review).toBe(null);
  });

  // ...AND IT IS NOT UNCHECKED, which is the half the obvious reading gets
  // wrong. Check 1 measures what the target ALREADY holds, so a MIXED review —
  // one that KEPT a level and withheld something else — is out of a narrow
  // holder's reach even to dismiss. Deliberate, and the same rule
  // setConsoleAccess applies: dismissing permanently discards a privilege
  // somebody was elected to have, which is the denial-of-access half of the act.
  it('refuses a narrow holder dismissing a MIXED review on somebody richer than them', async () => {
    Object.assign(rowFor(CLAIMANT), {
      is_exec: true,
      privilege_claim_review: {
        state: 'mixed',
        at: '2026-08-15T00:00:00.000Z',
        withheld: { role: 'admin' },
        kept: { is_exec: true },
      },
    });
    store.actor = rowFor(SMALL_HOLDER);
    const res = await resolvePrivilegeClaimReview(CLAIMANT, 'dismiss');
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/which you do not/);
    // The review SURVIVES the refusal, so the decision is still there for
    // somebody who can make it — the point of the next case.
    expect(rowFor(CLAIMANT).privilege_claim_review).toBeTruthy();
  });

  it('...and an admin can dismiss the same one, so it is not stranded', async () => {
    Object.assign(rowFor(CLAIMANT), {
      is_exec: true,
      privilege_claim_review: {
        state: 'mixed',
        at: '2026-08-15T00:00:00.000Z',
        withheld: { role: 'admin' },
        kept: { is_exec: true },
      },
    });
    const res = await resolvePrivilegeClaimReview(CLAIMANT, 'dismiss');
    expect(res.ok, errorOf(res)).toBe(true);
    expect(rowFor(CLAIMANT).privilege_claim_review).toBe(null);
    // Dismissed, so the withheld admin role is NOT written.
    expect(rowFor(CLAIMANT).role).toBe('player');
  });

  // THE SELF-EDIT REFUSAL, which setConsoleAccess has and this did not. Usually
  // unreachable — somebody stripped of their privileges has no console to resolve
  // anything from — but a MIXED review keeps some and withholds others, so the
  // holder of the capability can have a pending restore of their own.
  it('refuses somebody resolving their own review', async () => {
    Object.assign(rowFor(FULL_HOLDER), {
      privilege_claim_review: {
        state: 'mixed',
        at: '2026-08-15T00:00:00.000Z',
        withheld: { role: 'admin' },
        kept: { is_exec: true },
      },
    });
    store.actor = rowFor(FULL_HOLDER);
    const res = await resolvePrivilegeClaimReview(FULL_HOLDER, 'restore');
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/your own permission review/i);
    expect(rowFor(FULL_HOLDER).role).toBe('player');
  });

  it('still refuses a non-admin restoring an admin role, in its own words', async () => {
    Object.assign(rowFor(CLAIMANT), {
      privilege_claim_review: {
        state: 'held',
        at: '2026-08-15T00:00:00.000Z',
        withheld: { role: 'admin' },
        kept: {},
      },
    });
    store.actor = rowFor(FULL_HOLDER);
    const res = await resolvePrivilegeClaimReview(CLAIMANT, 'restore');
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/Only an admin can restore an admin role/);
    expect(rowFor(CLAIMANT).role).toBe('player');
  });
});

describe('players.consoleaccess.write is reachable only by being given it', () => {
  it('is in neither baseline', () => {
    expect((EXEC_BASELINE as readonly Cap[]).includes(CONSOLE_CAP)).toBe(false);
    expect((TRAINER_BASELINE as readonly Cap[]).includes(CONSOLE_CAP)).toBe(false);
  });

  it('is in none of the shipped roles', () => {
    for (const [role, defaults] of Object.entries(ROLE_DEFAULTS)) {
      expect((defaults as readonly Cap[]).includes(CONSOLE_CAP), role).toBe(false);
    }
  });

  it('IS offerable, or nobody could ever be given it', () => {
    expect((EDITOR_OFFERABLE as readonly Cap[]).includes(CONSOLE_CAP)).toBe(true);
  });
});
