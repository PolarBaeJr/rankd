import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// EDITING A BUILT-IN ROLE, THROUGH THE REAL ACTIONS.
//
// Since 00104 the four VP jobs are seeded rows in permission_baselines, so
// "edit what Finance means" is updatePermissionBaseline and nothing new. What is
// new, and what this file is about, is the four ways a built-in differs from a
// baseline the club wrote:
//
//   1. IT CAN BE RESET to the set it shipped with, and a reset is an EDIT — so
//      it is closure-checked, ceiling-checked, reason-checked and propagated
//      exactly like one. A reset that narrows people can be refused.
//   2. IT CANNOT BE DELETED, holders or no holders. The holder check alone is
//      not enough: a Finance nobody holds would delete cleanly and take the seed
//      with it.
//   3. ITS EDIT REACHES LEGACY ROLE HOLDERS — rows still storing
//      permission_role = 'finance', which resolve through the hard-coded
//      ROLE_DEFAULTS. 00104 converts them; this is what makes the code correct
//      before it is applied and idempotent after.
//   4. GRANT CLOSURE AND THE HARD FLOOR ARE UNCHANGED, and are asserted here
//      against the widened ceiling rather than assumed to have survived it.
//
// The harness is permission-baselines.test.ts's, with the seeded rows inserted
// directly (a built-in cannot be created through the action — createImpl never
// writes builtin_role, which is itself asserted below). The gate is the REAL
// one: requireCapability resolves the actor through the real resolver.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: {} as Row,
  nextId: 1,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        const rows = (store.db[table] ??= []);
        if (table === 'permission_baselines') {
          const key = String(payload.name ?? '').trim().toLowerCase();
          if (rows.some((r) => String(r.name ?? '').trim().toLowerCase() === key)) {
            return {
              data: null,
              error: {
                message:
                  'duplicate key value violates unique constraint "permission_baselines_name_key"',
              },
            };
          }
        }
        const written = { id: `bbbbbbbb-0000-4000-8000-00000000000${store.nextId++}`, ...payload };
        rows.push(written);
        return { data: [written], error: null };
      }
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      if (op === 'delete') {
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async maybeSingle() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
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

vi.mock('../actions/_shared', async () => {
  const { accessLevelFor, permissionsOf, permits } = await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      const level = accessLevelFor(store.actor);
      if (!permits(level, permissionsOf(level, store.actor), capability)) {
        throw new Error('Admin access required');
      }
      return store.actor;
    },
  };
});

import {
  createPermissionBaseline,
  deletePermissionBaseline,
  resetPermissionBaseline,
  updatePermissionBaseline,
} from '../actions/permission-baselines';
import {
  BUILTIN_BASELINE_IDS,
  BUILTIN_PERMISSION_ROLES,
  EDITOR_OFFERABLE,
  EXEC_BASELINE,
  PERMISSION_ROLE_LABELS,
  ROLE_DEFAULTS,
} from '../permissions';
import { PLAYER_FIELD_FLOOR } from '../player-field-access';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const EXEC_A = 'eeeeeeee-0000-4000-8000-000000000001';
const TREASURER = 'eeeeeeee-0000-4000-8000-000000000009';

const FINANCE = BUILTIN_BASELINE_IDS.finance;

/** Finance taught to see money in as well as out — the owner's actual request. */
const MONEY_IN: Capability[] = [
  'fees.page',
  'fees.expenses.read',
  'fees.expenses.add.write',
  'fees.clubfees.read',
  'fees.otherincome.read',
  'fees.netposition.read',
];

/**
 * MONEY_IN plus a money WRITE, for the grant-closure cases. Since 2026-10-23
 * every officer reads the books by level, so MONEY_IN's reads are inside any
 * officer's own set and closure has nothing to refuse. Marking a fee paid is
 * offerable and is held by nobody by being an officer, which is what those
 * cases need.
 */
const MONEY_MOVED: Capability[] = [...MONEY_IN, 'fees.clubfees.markpaid.write'];

const REASON = 'The treasurer needs to see money in as well as out';

const exec = (id: string, extra: Row = {}): Row => ({
  id,
  full_name: `Exec ${id.slice(-1)}`,
  email: null,
  role: 'player',
  is_exec: true,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  permission_baseline_id: null,
  ...extra,
});

const admin = (id: string): Row => ({
  id,
  full_name: 'An admin',
  email: null,
  role: 'admin',
  is_exec: false,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  permission_baseline_id: null,
});

/** The four rows exactly as 00104 writes them. */
const seededRows = (): Row[] =>
  BUILTIN_PERMISSION_ROLES.map((role) => ({
    id: BUILTIN_BASELINE_IDS[role],
    name: PERMISSION_ROLE_LABELS[role],
    capabilities: [...ROLE_DEFAULTS[role]].sort(),
    builtin_role: role,
  }));

const rowFor = (id: string) => store.db.players!.find((p) => p.id === id)!;
const baselineFor = (id: string) => store.db.permission_baselines!.find((b) => b.id === id)!;
const audits = () => store.db.audit_logs ?? [];

beforeEach(() => {
  store.nextId = 1;
  store.db = {
    players: [admin(ADMIN), admin(ADMIN_2), exec(EXEC_A), exec(TREASURER)],
    permission_baselines: seededRows(),
    audit_logs: [],
  };
  store.actor = rowFor(ADMIN);
});

// ---------------------------------------------------------------------------
// EDITING ONE — THE FEATURE
// ---------------------------------------------------------------------------
describe('editing a built-in role', () => {
  it('stores what the club chose, sorted and audited', async () => {
    const result = await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);
    expect(result.ok).toBe(true);
    expect(baselineFor(FINANCE).capabilities).toEqual([...MONEY_IN].sort());

    const row = audits().find((a) => a.action_type === 'permission_baseline_updated')!;
    expect(row).toBeTruthy();
    expect(row.reason).toBe(REASON);
    expect((row.old_value as Row).capabilities).toEqual([...ROLE_DEFAULTS.finance].sort());
  });

  it('keeps it a built-in, so an edit cannot quietly demote it to an ordinary baseline', async () => {
    await updatePermissionBaseline(FINANCE, 'Treasurer', MONEY_IN, REASON);
    expect(baselineFor(FINANCE).builtin_role).toBe('finance');
    // Renaming IS allowed — it is not part of what the role can DO.
    expect(baselineFor(FINANCE).name).toBe('Treasurer');
  });

  // THE CEILING, reached through the action rather than the pure function.
  it('refuses a capability above the ceiling even from an admin', async () => {
    const result = await updatePermissionBaseline(
      FINANCE,
      'Finance',
      // An admin area: since 2026-10-23 those are all the ceiling refuses.
      [...MONEY_IN, 'audit.page'],
      REASON,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/admin-only/);
    // Nothing written.
    expect(baselineFor(FINANCE).capabilities).toEqual([...ROLE_DEFAULTS.finance].sort());
  });

  // GRANT CLOSURE, and it is the only bound on a non-admin.
  it('refuses an officer adding something they do not hold themselves', async () => {
    Object.assign(rowFor(TREASURER), {
      permission_role: 'custom',
      permission_grants: [
        'fees.page',
        'fees.expenses.read',
        'fees.expenses.add.write',
        'permissions.page',
        'permissions.write',
      ],
      permission_revokes: [],
    });
    store.actor = rowFor(TREASURER);

    const result = await updatePermissionBaseline(FINANCE, 'Finance', MONEY_MOVED, REASON);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/you do not hold/i);
    expect(baselineFor(FINANCE).capabilities).toEqual([...ROLE_DEFAULTS.finance].sort());
  });

  it('requires a reason long enough for the propagation to accept too', async () => {
    const result = await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, 'ok');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/at least/i);
    expect(baselineFor(FINANCE).capabilities).toEqual([...ROLE_DEFAULTS.finance].sort());
  });
});

// ---------------------------------------------------------------------------
// PROPAGATION — INCLUDING TO LEGACY ROLE HOLDERS
// ---------------------------------------------------------------------------
describe('an edit reaches everybody holding the role', () => {
  it('rewrites a holder whose grants were copied from it', async () => {
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'custom',
      permission_grants: [...ROLE_DEFAULTS.finance].sort(),
      permission_revokes: [],
      permission_baseline_id: FINANCE,
    });

    const result = await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.propagated).toBe(1);
    expect(rowFor(EXEC_A).permission_grants).toEqual([...MONEY_IN].sort());
    expect(rowFor(EXEC_A).permission_baseline_id).toBe(FINANCE);
  });

  // THE CASE 00104 CONVERTS, AND THE REASON THE CODE HANDLES IT ANYWAY. A row
  // still storing permission_role = 'finance' resolves through the hard-coded
  // constant. Left behind by an edit it would be a second Finance with a
  // different value — the same word meaning two things.
  it('rewrites a LEGACY role holder, converting them to the copied shape', async () => {
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'finance',
      permission_grants: [],
      permission_revokes: [],
      permission_baseline_id: null,
    });

    const result = await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.propagated).toBe(1);
    expect(rowFor(EXEC_A).permission_role).toBe('custom');
    expect(rowFor(EXEC_A).permission_grants).toEqual([...MONEY_IN].sort());
    expect(rowFor(EXEC_A).permission_baseline_id).toBe(FINANCE);
  });

  it('counts a person once even if both queries could find them', async () => {
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'finance',
      permission_grants: [],
      permission_revokes: [],
      permission_baseline_id: FINANCE,
    });
    const result = await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.propagated).toBe(1);
  });

  it('leaves an audit row against the PERSON, carrying the same reason', async () => {
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'custom',
      permission_grants: [...ROLE_DEFAULTS.finance].sort(),
      permission_revokes: [],
      permission_baseline_id: FINANCE,
    });
    await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);

    const row = audits().find(
      (a) => a.action_type === 'player_permissions_changed' && a.target_id === EXEC_A,
    )!;
    expect(row).toBeTruthy();
    expect(row.reason).toBe(REASON);
    // THE FLOOR IS IN THE AUDIT ROW. `effective` records what the person
    // actually holds, and since the club owner's ruling that is the edited
    // baseline UNDER-pinned by the exec floor. Derived from the constant rather
    // than written out, so the literal cannot drift from the list it describes.
    expect((row.new_value as Row).effective).toEqual(
      [...new Set([...EXEC_BASELINE, ...MONEY_IN])].sort(),
    );
  });

  // VALIDATE EVERY HOLDER, THEN WRITE — held for the batch nobody chose.
  it('refuses the whole edit when one holder is out of reach, writing nothing', async () => {
    Object.assign(rowFor(TREASURER), {
      permission_role: 'custom',
      permission_grants: [...MONEY_MOVED].sort(),
      permission_revokes: [],
      permission_baseline_id: null,
    });
    // An officer who holds Finance-as-shipped plus permissions.write, editing a
    // role somebody richer than them also holds.
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'custom',
      permission_grants: [
        ...ROLE_DEFAULTS.finance,
        'permissions.page',
        'permissions.write',
      ].sort(),
      permission_revokes: [],
      permission_baseline_id: null,
    });
    Object.assign(rowFor(TREASURER), { permission_baseline_id: FINANCE });
    store.actor = rowFor(EXEC_A);

    const result = await updatePermissionBaseline(
      FINANCE,
      'Finance',
      [...ROLE_DEFAULTS.finance],
      REASON,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/which you do not/i);
    // The holder untouched, and the baseline too.
    expect(rowFor(TREASURER).permission_grants).toEqual([...MONEY_MOVED].sort());
    expect(baselineFor(FINANCE).capabilities).toEqual([...ROLE_DEFAULTS.finance].sort());
  });

  it('refuses when the editor holds the role themselves', async () => {
    Object.assign(rowFor(ADMIN), { permission_baseline_id: FINANCE });
    const result = await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/own permissions/i);
  });
});

// ---------------------------------------------------------------------------
// RESET
// ---------------------------------------------------------------------------
describe('resetting a built-in role', () => {
  it('puts the shipped set back and keeps the name the club chose', async () => {
    await updatePermissionBaseline(FINANCE, 'Treasurer', MONEY_IN, REASON);
    const result = await resetPermissionBaseline(FINANCE, 'Reverting the finance change');
    expect(result.ok).toBe(true);
    expect(baselineFor(FINANCE).capabilities).toEqual([...ROLE_DEFAULTS.finance].sort());
    expect(baselineFor(FINANCE).name).toBe('Treasurer');
  });

  it.each([...BUILTIN_PERMISSION_ROLES])('restores %s to its shipped default', async (role) => {
    const id = BUILTIN_BASELINE_IDS[role];
    baselineFor(id).capabilities = ['legal.page', 'legal.reacceptance.write'];
    const result = await resetPermissionBaseline(id, 'Putting it back');
    expect(result.ok).toBe(true);
    expect(baselineFor(id).capabilities).toEqual([...ROLE_DEFAULTS[role]].sort());
  });

  it('propagates to holders, because a reset changes what they may do', async () => {
    await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'custom',
      permission_grants: [...MONEY_IN].sort(),
      permission_revokes: [],
      permission_baseline_id: FINANCE,
    });

    const result = await resetPermissionBaseline(FINANCE, 'Reverting the finance change');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.propagated).toBe(1);
    expect(rowFor(EXEC_A).permission_grants).toEqual([...ROLE_DEFAULTS.finance].sort());
  });

  // A RESET IS A REVOKE FOR THE HOLDERS, so it is bounded by the same rule. The
  // shipped set being NARROWER does not make putting it back safe for anybody to
  // do: an unbounded revoke is a denial-of-access weapon.
  it('is refused for an officer who cannot reach what the holders currently have', async () => {
    await updatePermissionBaseline(FINANCE, 'Finance', MONEY_MOVED, REASON);
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'custom',
      permission_grants: [...MONEY_MOVED].sort(),
      permission_revokes: [],
      permission_baseline_id: FINANCE,
    });
    Object.assign(rowFor(TREASURER), {
      permission_role: 'custom',
      permission_grants: [
        'fees.page',
        'fees.expenses.read',
        'fees.expenses.add.write',
        'permissions.page',
        'permissions.write',
      ],
      permission_revokes: [],
    });
    store.actor = rowFor(TREASURER);

    const result = await resetPermissionBaseline(FINANCE, 'Reverting the finance change');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/which you do not/i);
    expect(baselineFor(FINANCE).capabilities).toEqual([...MONEY_MOVED].sort());
    expect(rowFor(EXEC_A).permission_grants).toEqual([...MONEY_MOVED].sort());
  });

  it('takes a reason, like every other audited change to what people may do', async () => {
    const result = await resetPermissionBaseline(FINANCE, 'no');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/at least/i);
  });

  // VALIDATE EVERY HOLDER, THEN WRITE — inherited from updateImpl, and asserted
  // for reset specifically because "a reset is just an edit with the
  // capabilities chosen for you" is a claim this feature makes, and a claim
  // about failure behaviour is worth exactly what its test is worth.
  //
  // WHAT THIS PINS IS THAT THE PRE-FLIGHT IS AHEAD OF THE WRITE. updateImpl
  // writes the baseline row FIRST and then propagates — the other order would
  // reach people and then fail to record why, leaving them holding capabilities
  // no row describes — so everything that can be known in advance has to be
  // known in advance, or a refusal arrives with the role already reset.
  //
  // An admin holder is the case: nothing stored on an admin is ever consulted,
  // so propagating to one is meaningless and setPlayerPermissions refuses it.
  // The pre-flight refuses it first, which is the property worth having.
  it('refuses a reset before writing anything when a holder cannot be propagated to', async () => {
    await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);
    Object.assign(rowFor(ADMIN_2), { permission_baseline_id: FINANCE });

    const result = await resetPermissionBaseline(FINANCE, 'Reverting the finance change');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/is an admin/i);
    // NOTHING WRITTEN — the role still says what the club edited it to say,
    // rather than being reset with one person left behind on the old set.
    expect(baselineFor(FINANCE).capabilities).toEqual([...MONEY_IN].sort());
  });

  // A CLUB-WRITTEN BASELINE HAS NOTHING TO GO BACK TO.
  it('is refused on a baseline the club wrote', async () => {
    const created = await createPermissionBaseline('Socials VP', [
      'announcements.page',
      'announcements.create.write',
    ]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await resetPermissionBaseline(created.data, 'Trying to reset it');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no original set/i);
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
describe('deleting a built-in role', () => {
  // THE CASE THE HOLDER CHECK MISSES, and the reason this refusal is its own.
  it('is refused even when nobody holds it', async () => {
    const result = await deletePermissionBaseline(FINANCE, 'Tidying up');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot be deleted/i);
    expect(baselineFor(FINANCE)).toBeTruthy();
  });

  it.each([...BUILTIN_PERMISSION_ROLES])('is refused for %s', async (role) => {
    const result = await deletePermissionBaseline(BUILTIN_BASELINE_IDS[role], 'Tidying up');
    expect(result.ok).toBe(false);
    expect(store.db.permission_baselines!.length).toBe(4);
  });

  // ...while a club-written one is still deletable, so the refusal is about
  // built-ins and not about deletion having quietly stopped working.
  it('still deletes a baseline the club wrote and nobody holds', async () => {
    const created = await createPermissionBaseline('Socials VP', [
      'announcements.page',
      'announcements.create.write',
    ]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deletePermissionBaseline(created.data, 'Not needed any more');
    expect(result.ok).toBe(true);
    expect(store.db.permission_baselines!.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// A NEW BASELINE CANNOT CLAIM TO BE A BUILT-IN
// ---------------------------------------------------------------------------
describe('creating a baseline', () => {
  it('never writes builtin_role, so a fifth VP job cannot be invented', async () => {
    const created = await createPermissionBaseline('Socials VP', [
      'announcements.page',
      'announcements.create.write',
    ]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(baselineFor(created.data).builtin_role).toBeUndefined();

    // ...and it is therefore deletable and not resettable, which is the whole
    // observable difference.
    const reset = await resetPermissionBaseline(created.data, 'Trying to reset it');
    expect(reset.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE HARD FLOOR
// ---------------------------------------------------------------------------
// role, is_exec, is_trainer and the three permission_* columns are refused below
// admin under all circumstances and are reachable by NO capability. Editable
// roles widened the ceiling, so the claim is re-asserted against the widened
// list rather than assumed to have survived it.
describe('the hard floor is out of reach of an editable role', () => {
  it('is named by no capability the editor can offer', () => {
    for (const field of PLAYER_FIELD_FLOOR) {
      for (const capability of EDITOR_OFFERABLE) {
        expect(
          capability.includes(field),
          `${capability} names the floor column ${field}`,
        ).toBe(false);
      }
    }
  });

  it('survives an edit that tries to name one', async () => {
    for (const field of PLAYER_FIELD_FLOOR) {
      const result = await updatePermissionBaseline(
        FINANCE,
        'Finance',
        ['fees.page', `players.${field}.write` as Capability],
        REASON,
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      // Refused by the VOCABULARY, which is the strongest form the refusal can
      // take: there is no such capability to offer, so the floor is not guarded
      // by a rule that could be relaxed — it is unreachable by construction.
      expect(result.error).toMatch(/knows about|admin-only/i);
    }
    expect(baselineFor(FINANCE).capabilities).toEqual([...ROLE_DEFAULTS.finance].sort());
  });

  // AND NO EDIT EVER WRITES ONE. The propagation path goes through
  // setPlayerPermissions, which writes exactly four columns; the floor's other
  // three — role, is_exec, is_trainer — are set on an existing member by
  // writeConsoleLevel() alone, behind setConsoleAccess on /permissions.
  // updatePlayer() used to be that writer and now refuses them from every
  // caller, admins included.
  it('is never written by propagating an edit', async () => {
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'custom',
      permission_grants: [...ROLE_DEFAULTS.finance].sort(),
      permission_revokes: [],
      permission_baseline_id: FINANCE,
    });
    const before = { role: rowFor(EXEC_A).role, is_exec: rowFor(EXEC_A).is_exec, is_trainer: rowFor(EXEC_A).is_trainer };

    await updatePermissionBaseline(FINANCE, 'Finance', MONEY_IN, REASON);

    expect(rowFor(EXEC_A).role).toBe(before.role);
    expect(rowFor(EXEC_A).is_exec).toBe(before.is_exec);
    expect(rowFor(EXEC_A).is_trainer).toBe(before.is_trainer);
  });
});
