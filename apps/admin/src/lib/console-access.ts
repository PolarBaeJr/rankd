// WHAT CONSOLE ACCESS SOMEBODY HAS, as one question with four answers, and the
// translation between that answer and the three columns that store it.
//
// ONE MAPPING, AND ONE WRITER. This began inside the player Edit dialog and
// moved here when /permissions grew a console-access control of its own, because
// two places that both turn "Admin" into a role and two booleans is two places
// that can disagree about what Admin means.
//
// TWO SCREENS SET A LEVEL AGAIN — /permissions and the /players roster, which
// the club owner asked for: "allow me to edit access from the player menu too,
// but only to people who have permission to do edits on the player menu." That
// is not a return to the old arrangement, and the distinction is the whole point
// of this module: both screens call setConsoleAccess, so there is still exactly
// one writer of the three columns and exactly one place that decides what Admin
// means. The Edit dialog's old control wrote them through updatePlayer under a
// bare isAdmin check, which is what made it wrong; updatePlayer refuses them
// from every caller now. /accounts still only reads the mapping, to label a
// level it is showing.
//
// NOT a 'use server' module and deliberately free of any Supabase, Next or React
// import — a server action and a client component both import it, which is the
// same rule ./player-field-access.ts states for itself.
//
// This module does NOT write anything and is not a boundary. The three columns
// it names are the hard floor in ./player-field-access.ts, refused to anyone
// below admin under all circumstances and reachable by no capability; the write
// goes through writeConsoleLevel() in actions/permissions.ts, which is the one
// writer of them on an existing member and is not exported. updatePlayer() used
// to be the other one and now refuses them from every caller.
import { ExpectedError } from '@badminton/shared';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
import { accessLevelFor, type AccessLevel } from '@badminton/shared/src/utils/access-level';
import type { Capability } from './permissions';

/** The five answers, in the order they are offered. 'super_admin' is 00321's. */
export type ExecRole = 'none' | 'executive' | 'trainer' | 'admin' | 'super_admin';

// ONE question — what console access does this person have — instead of a
// role select, an is_exec flag and a trainer switch that had to be combined in
// the reader's head. "Admin + Executive" is gone because admin already outranks
// exec everywhere (accessLevelFor resolves the highest level held, and
// atLeast() orders admin > exec > trainer), so the pair was never a distinct
// state — only a way to get it wrong.
export const EXEC_ROLE_OPTIONS: { value: ExecRole; label: string }[] = [
  { value: 'none', label: 'None — ordinary member' },
  { value: 'executive', label: 'Executive' },
  { value: 'trainer', label: 'Varsity trainer' },
  { value: 'admin', label: 'Admin' },
  // Offered only to a super admin (console-access-offer.ts), and only a super
  // admin may set it (setConsoleAccess and the 00321 trigger).
  { value: 'super_admin', label: 'Super admin' },
];

/** The answers only a super admin may hand out or take away (00321). */
export const ADMIN_TIER_ACCESS: readonly ExecRole[] = ['admin', 'super_admin'];

export function toRoleValue(role: string, isExec: boolean, isTrainer: boolean): ExecRole {
  if (role === 'super_admin') return 'super_admin';
  if (role === 'admin') return 'admin';
  if (isExec) return 'executive';
  if (isTrainer) return 'trainer';
  return 'none';
}

// Admin implies is_exec: an admin already has every exec power, and the club's
// admin sits on the exec team, so they belong on the public /exec page too. A
// super admin likewise.
export function fromRoleValue(v: ExecRole): {
  role: 'player' | 'admin' | 'super_admin';
  is_exec: boolean;
  is_trainer: boolean;
} {
  switch (v) {
    case 'super_admin': return { role: 'super_admin', is_exec: true, is_trainer: false };
    case 'admin':     return { role: 'admin',  is_exec: true,  is_trainer: false };
    case 'executive': return { role: 'player', is_exec: true,  is_trainer: false };
    case 'trainer':   return { role: 'player', is_exec: false, is_trainer: true };
    default:          return { role: 'player', is_exec: false, is_trainer: false };
  }
}

/**
 * The same four answers, for a caller holding the LEVEL a row resolved to rather
 * than the three raw columns — which is what /permissions has, because it builds
 * its rows through accessLevelFor().
 *
 * DERIVED RATHER THAN WRITTEN OUT, and that is the whole reason it is three
 * lines of search instead of a switch. A fourth hand-written mapping between
 * these four states and the level ladder is a fourth thing that can disagree
 * about what Admin means; running fromRoleValue() through accessLevelFor() makes
 * this the inverse of the mapping above by construction, so it cannot drift from
 * it even if either one is edited.
 *
 * Falls back to 'none' — the answer that hands out nothing — for a level the
 * four cannot produce.
 */
export function accessForLevel(level: AccessLevel | null): ExecRole {
  return EXEC_ROLE_OPTIONS.find((o) => accessLevelFor(fromRoleValue(o.value)) === level)?.value
    ?? 'none';
}

// ---------------------------------------------------------------------------
// GRANT CLOSURE ON A LEVEL
// ---------------------------------------------------------------------------
// MOVED HERE FROM actions/permissions.ts BECAUSE IT ACQUIRED A SECOND CALLER,
// and a second copy of this is a second place a check can be forgotten — which
// is exactly the defect the one-console-access-path change exists to remove.
// The callers are setConsoleAccess (the /permissions control) and
// resolvePrivilegeClaimReview (the roster-claim restore on /players): two
// different acts, both of which hand somebody a console LEVEL, and therefore
// both bounded by the same rule.
//
// The naming helpers came with it for the same reason: a refusal that lists
// capabilities has to spell them the way the rest of the console does, and
// there is one vocabulary.

/** "Varsity notes (write)" — how a capability is named in a refusal. */
function nameOf(capability: Capability): string {
  const entry = CAPABILITY_GATES[capability];
  return `${entry.label} (${entry.mode})`;
}

export function listOf(capabilities: readonly Capability[]): string {
  return capabilities.map(nameOf).join(', ');
}

export function missingFrom(
  held: ReadonlySet<Capability>,
  wanted: readonly Capability[],
): Capability[] {
  return wanted.filter((capability) => !held.has(capability));
}

/**
 * Nobody hands out — or takes away — what they do not hold themselves, measured
 * on the capability set a LEVEL resolves to rather than on a delta.
 *
 * BOTH DIRECTIONS, AND BOTH BEFORE ANY WRITE.
 *
 *   `before`  what the target's resolved set is NOW. Stops a narrowly-scoped
 *             holder reaching into somebody richer than they are — which, with
 *             no grant involved at all, is the denial-of-access half of the act:
 *             taking the console away from a colleague who was elected to use it.
 *   `after`   what it WOULD BE. This is what stops a trainer-sized holder minting
 *             an executive, and it is why one capability covers both levels
 *             rather than two: the graduation is a consequence of the baselines,
 *             not of a second tick box that would have to be kept in step.
 *
 * The caller computes `after` from the ACTUAL post-change state, because whether
 * a stored composition survives the move decides which baseline underpins it —
 * see the note at each call site. Reading the wrong one here would make the check
 * wrong in exactly the case it matters.
 */
export function assertLevelClosure(
  actorSet: ReadonlySet<Capability>,
  before: ReadonlySet<Capability>,
  after: ReadonlySet<Capability>,
): void {
  const outOfReach = missingFrom(actorSet, [...before]);
  if (outOfReach.length > 0) {
    throw new ExpectedError(
      `You cannot change this person's console access: they hold ${listOf(outOfReach)}, which you do not.`,
    );
  }

  const wouldExceed = missingFrom(actorSet, [...after]);
  if (wouldExceed.length > 0) {
    throw new ExpectedError(
      `That would give them ${listOf(wouldExceed)}, which you do not hold.`,
    );
  }
}
