import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted state that mocks read from. `vi.hoisted` keeps these definitions
// available before the mocked module factories run.
const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  player: null as {
    id: string;
    role: string;
    is_exec?: boolean;
    permission_role?: string | null;
    permission_grants?: string[];
    permission_revokes?: string[];
  } | null,
  // Admin-enrolled passkeys for this player. >0 arms the gate, so the caller
  // must present a verified cookie. Members'-app passkeys are excluded by the
  // query itself (enrolled_via = 'admin'), which is why this is a count of
  // admin credentials rather than of all of them.
  adminPasskeyCount: 0,
  // The console_passkey_grace row (00262): when the 14 days without a console
  // passkey started. null is "no row".
  grace: null as { started_at: string } | null,
}));

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

const sentrySetUser = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [],
    get: () => undefined,
    set: () => {},
  }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
    },
  }),
}));

// A chainable, awaitable stub. Two different call sites share it: the player
// lookup ends in .maybeSingle(), while the passkey gate chains .eq() twice
// (player_id AND enrolled_via) and awaits the builder directly for its count.
// A stub that only models one shape lets a real second filter throw at runtime
// — which is exactly how this suite went red when the gate learned to narrow
// on enrolled_via.
//
// TABLE-AWARE since 00262: the gate also reads console_passkey_grace with
// .maybeSingle(). Answering every table with the player row would read as a
// grace row with no started_at and fail closed, which looks exactly like a
// real regression.
vi.mock('@supabase/supabase-js', () => {
  const chain = (table: string): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      eq: () => self,
      maybeSingle: async () =>
        table === 'console_passkey_grace'
          ? { data: state.grace, error: null }
          : { data: state.player },
      // Thenable: `await supabase.from(...).select(...).eq(...).eq(...)`
      then: (resolve: (v: { count: number }) => unknown) =>
        resolve({ count: state.adminPasskeyCount }),
    };
    return self;
  };
  return {
    createClient: () => ({
      from: (table: string) => ({ select: (_cols: string, _opts?: unknown) => chain(table) }),
    }),
  };
});

vi.mock('@sentry/nextjs', () => ({
  setUser: sentrySetUser,
  captureException: vi.fn(),
}));

// Import the module under test AFTER mocks are registered.
import { getAuthenticatedAdmin, requireCapability } from '../supabase-server';

beforeEach(() => {
  state.user = null;
  state.player = null;
  state.adminPasskeyCount = 0;
  // Inside the window by default, so tests about other things are not also
  // tests about the grace period.
  state.grace = { started_at: daysAgo(1) };
  sentrySetUser.mockClear();
});

describe('getAuthenticatedAdmin', () => {
  it('throws when there is no authenticated user', async () => {
    state.user = null;
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Not authenticated');
    // Failure paths clear any stale Sentry user context.
    expect(sentrySetUser).toHaveBeenCalledWith(null);
  });

  it('throws when the user has no matching player row', async () => {
    state.user = { id: 'user-1' };
    state.player = null;
    await expect(getAuthenticatedAdmin()).rejects.toThrow('No player record found');
    expect(sentrySetUser).toHaveBeenCalledWith(null);
  });

  it('throws when the player is not an admin', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'player' };
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Admin access required');
    expect(sentrySetUser).toHaveBeenCalledWith(null);
  });

  it('returns the player and tags Sentry when the player is an admin', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    const result = await getAuthenticatedAdmin();
    expect(result).toEqual(state.player);
    expect(sentrySetUser).toHaveBeenCalledWith({ id: 'player-1' });
  });

  // The passkey gate broke twice in one day: once because the SQL counted any
  // passkey, and again because this server-side check duplicated that decision
  // and was not narrowed alongside it. Both times an exec lost the console with
  // nothing failing in CI, so the two states are pinned here.
  it('lets an admin with no admin-enrolled passkey through inside the 14-day window', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    state.adminPasskeyCount = 0;
    state.grace = { started_at: daysAgo(3) };
    await expect(getAuthenticatedAdmin()).resolves.toEqual(state.player);
  });

  it('refuses once the 14 days without a console passkey have run out (AUTH-105)', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    state.adminPasskeyCount = 0;
    state.grace = { started_at: daysAgo(15) };
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Add a console passkey');
    await expect(getAuthenticatedAdmin()).rejects.toMatchObject({ code: 'AUTH-105' });
  });

  it('fails closed when the window has no row (AUTH-103)', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    state.adminPasskeyCount = 0;
    state.grace = null;
    await expect(getAuthenticatedAdmin()).rejects.toMatchObject({ code: 'AUTH-103' });
  });

  it('asks for the passkey, not the window, when one is enrolled', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    state.adminPasskeyCount = 1;
    state.grace = { started_at: daysAgo(30) };
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Passkey verification required');
  });

  it('requires verification once an admin-enrolled passkey exists', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'player-1', role: 'admin' };
    state.adminPasskeyCount = 1;
    // No verified cookie is set by the next/headers mock, so the gate must bite.
    await expect(getAuthenticatedAdmin()).rejects.toThrow('Passkey verification required');
    expect(sentrySetUser).toHaveBeenCalledWith(null);
  });
});

describe('requireCapability', () => {
  // THE CAPABILITY MOVED, BECAUSE THE BASELINE DID. This asked for
  // `players.approve.write` and an unrestricted exec no longer holds it — the
  // exec baseline is twelve READS now, and every write arrives by assignment.
  // Asking for the roster read instead keeps the assertion about what it was
  // always about (the level's own baseline admits its holder) and stops it
  // silently testing an assignment path it does not set up.
  it('admits somebody whose level baseline holds the capability', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'exec-1', role: 'player', is_exec: true };
    await expect(requireCapability('players.read')).resolves.toEqual(state.player);
    expect(sentrySetUser).toHaveBeenCalledWith({ id: 'exec-1' });
  });

  // ...AND THE OTHER HALF, WHICH THE BASELINE USED TO COVER FOR FREE. A write is
  // now reached through a permission_role, so the gate has to admit on the
  // RESOLVED set and not on the level. This is the case the narrowing turns into
  // the ordinary one: nearly every officer doing nearly every job.
  it('admits an exec who was ASSIGNED the capability, though no baseline holds it', async () => {
    state.user = { id: 'user-1' };
    state.player = {
      id: 'exec-1',
      role: 'player',
      is_exec: true,
      permission_role: 'internal',
      permission_grants: [],
      permission_revokes: [],
    };
    await expect(requireCapability('players.approve.write')).resolves.toEqual(state.player);
    // ...and the same officer, unassigned, is refused it. Same person, same
    // level, same capability — the assignment is the whole difference.
    state.player = { id: 'exec-1', role: 'player', is_exec: true };
    await expect(requireCapability('players.approve.write')).rejects.toThrow();
  });

  // THE ORDER, pinned. The capability is checked BEFORE the passkey gate,
  // exactly as the level check used to be: an exec calling an admin-only action
  // has always been told "admin access required", and being sent to enrol a
  // passkey first would be a different answer to a different question. Both
  // conditions are true here, so only the ordering decides which message wins.
  it('answers the permission question before the passkey one', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'exec-1', role: 'player', is_exec: true };
    state.adminPasskeyCount = 1;
    // An admin-area capability: since 2026-10-23 a money write is offerable,
    // so an exec refused one is told to ask an admin, not "admin access".
    await expect(requireCapability('audit.page'))
      .rejects.toThrow('Admin access required');
  });

  // The refusal names the lowest level that would have been enough, which is
  // what the three level gates used to say — an ordinary member turned away
  // from exec work is told about exec, not about admin. All three come from
  // the same caller, so only the CAPABILITY decides which message appears.
  //
  // UNCHANGED, AND THAT IS THE POINT OF READING denialFor's MIDDLE BRANCH FROM
  // EXEC_ASSIGNABLE. `players.approve.write` left the exec BASELINE and is still
  // exec-tier work: the level a member needs before an admin can give it to them
  // is exec, so "Admin or exec access required" is the same true answer it was.
  // Read from the narrowed baseline the branch would have missed, and this
  // member would have been told to go and become an admin.
  it('spells the refusal by the lowest level that holds the capability', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'member-1', role: 'player' };
    await expect(requireCapability('players.approve.write'))
      .rejects.toThrow('Admin or exec access required');
    await expect(requireCapability('players.page'))
      .rejects.toThrow('Admin console access required');
    await expect(requireCapability('audit.page'))
      .rejects.toThrow('Admin access required');
  });

  // THE STORED TRIPLE IS READ HERE, not only in the editor. This is the whole
  // of the gate's connection to per-person permissions: the row comes from
  // select('*'), permissionsOf() turns its three columns into a set, and
  // permits() asks that set rather than the level's baseline.
  it('reads the caller’s stored permissions, not just their level', async () => {
    state.user = { id: 'user-1' };
    state.player = {
      id: 'exec-1',
      role: 'player',
      is_exec: true,
      permission_role: 'finance',
      permission_grants: [],
      permission_revokes: [],
    };
    // In the finance role's defaults.
    await expect(requireCapability('fees.expenses.add.write')).resolves.toEqual(state.player);
    // In the exec BASELINE, and deliberately not in the finance role.
    await expect(requireCapability('players.approve.write')).rejects.toThrow(
      'Your permissions do not include this. Ask an admin.',
    );
  });

  // A NARROWED EXEC IS NOT TOLD THEIR LEVEL IS THE PROBLEM. "Admin or exec
  // access required" is false for somebody who IS an exec — they would read it
  // as a bug and ask an admin to check a flag that is already set. The three
  // level messages above stay exactly as they were for everybody else, which is
  // why this branch is asked FIRST rather than replacing them.
  it('keeps the level messages for a capability no level below admin holds', async () => {
    state.user = { id: 'user-1' };
    state.player = {
      id: 'exec-1',
      role: 'player',
      is_exec: true,
      permission_role: 'finance',
      permission_grants: [],
      permission_revokes: [],
    };
    await expect(requireCapability('audit.page')).rejects.toThrow('Admin access required');
  });

  // THE REFUSAL AN UNRESTRICTED OFFICER MEETS, WHICH IS NOW THE COMMONEST ONE IN
  // THE CONSOLE AND USED TO BE UNREACHABLE. denialFor's first branch was guarded
  // by `kind === 'restricted'` on the argument that an unrestricted person's set
  // IS their baseline, so they could only ever be refused genuinely admin-only
  // work. The narrowed baseline retires that argument: Gloria and every other
  // officer with no permission_role is unrestricted AND refused sixty-one
  // writes, and the old fall-through told them "Admin access required" — which
  // is false, and false in the one direction that stops them asking for the
  // thing that would fix it.
  it('tells an UNRESTRICTED officer it is their permissions, not their level', async () => {
    state.user = { id: 'user-1' };
    state.player = { id: 'exec-1', role: 'player', is_exec: true };
    await expect(requireCapability('players.approve.write')).rejects.toThrow(
      'Your permissions do not include this. Ask an admin.',
    );
    // ...and it is still the LEVEL for work no permission can reach, so the
    // change did not swallow the three level messages.
    await expect(requireCapability('audit.page')).rejects.toThrow('Admin access required');
  });
});
