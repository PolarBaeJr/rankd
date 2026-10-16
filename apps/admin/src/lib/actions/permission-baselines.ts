'use server';

import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { setPlayerPermissions } from './permissions';
import { REASON_MIN } from '../audit-reason';
import {
  accessLevelFor,
  baselineCapabilityRefusal,
  baselineNameRefusal,
  effectiveCapabilities,
  isBuiltinPermissionRole,
  isCapability,
  normaliseBaselineCapabilities,
  permissionsOf,
  shippedDefaultFor,
  type Capability,
  type CustomBaseline,
} from '../permissions';

// THE BASELINES THE CLUB WRITES FOR ITSELF.
//
// ROLE_DEFAULTS is four VP jobs in a compile-time constant, so a fifth is a
// deploy. These are rows, and an admin makes one on /permissions.
//
// A BASELINE IS COPIED ONTO A ROW, NEVER RESOLVED THROUGH. Assigning one writes
// permission_role = 'custom' (the empty base) and the baseline's capabilities
// into permission_grants — see the header of 00093 for why, and for the 22 call
// sites that shape avoids touching. Everything in this file follows from that
// one decision:
//
//   * ASSIGNING is not here. It goes through setPlayerPermissions, which already
//     runs the five closure checks per person, and which gained one optional
//     field (`baselineId`) that makes it load the baseline and copy it. There is
//     no second write path to players.permission_* and there must never be.
//
//   * EDITING has to PROPAGATE, because the copies do not update themselves.
//     Every holder is re-written in one act, each write closure-checked and
//     audited on its own. That is more traceable than ROLE_DEFAULTS, where
//     changing what 'finance' means leaves no row in this database at all — but
//     it is N writes and not a transaction, and the failure handling below says
//     so out loud rather than hiding it.
//
//   * DELETING is refused while anybody holds one. players.permission_baseline_id
//     is ON DELETE RESTRICT, so the database refuses it too; this is the refusal
//     in words, naming the people, which a foreign-key violation cannot do.
//
// GRANT CLOSURE APPLIES AT AUTHORING TIME AS WELL AS AT ASSIGNMENT. An author
// may only put capabilities in a baseline that they themselves hold, and the
// contents are capped at EDITOR_OFFERABLE — the two rules baselineCapabilityRefusal
// implements. Without the first, a narrowly-scoped holder of permissions.write
// could write down a baseline nobody but an admin could ever assign; without the
// second, an admin could author one containing permissions.write and then meet
// check 5 of setPlayerPermissions every time they tried to use it.

/** The row shape, as every reader here wants it. */
type BaselineRow = {
  id: string;
  name: string;
  capabilities: string[];
  builtin_role: string | null;
};

/** Every column asBaseline() reads, in one place so no SELECT can forget one. */
const BASELINE_COLUMNS = 'id, name, capabilities, builtin_role';

function asBaseline(row: BaselineRow): CustomBaseline {
  return {
    id: row.id,
    name: row.name,
    // Filtered through the vocabulary this build has, exactly as draftOf() does
    // for a player row: a stored string the code no longer knows resolves to
    // nothing anyway, and offering to re-save it as though it meant something is
    // how a dead capability survives a rename.
    capabilities: normaliseBaselineCapabilities(row.capabilities.filter(isCapability)),
    // Narrowed rather than cast. A value outside the four reads as "not a
    // built-in", which is the safe answer: it makes the row deletable and not
    // resettable, and both of those are what an unrecognised row should be.
    builtinRole: isBuiltinPermissionRole(row.builtin_role) ? row.builtin_role : null,
  };
}

/**
 * The actor, their resolved set, and a client — the three things every action
 * here opens with.
 *
 * The set comes from the actor's OWN ROW, resolved server-side through the same
 * path every gate uses, and never from anything the client sent. requireCapability
 * returns the row it just authenticated, so there is not even a second lookup
 * that could disagree with the one that let them in.
 */
async function actorContext() {
  const actor = await requireCapability('permissions.write');
  return {
    actor,
    held: effectiveCapabilities(
      accessLevelFor(actor),
      permissionsOf(accessLevelFor(actor), actor),
    ),
    adminClient: createAdminClient(),
  };
}

type Client = ReturnType<typeof createAdminClient>;

async function loadBaseline(adminClient: Client, id: string): Promise<CustomBaseline> {
  const { data } = await adminClient
    .from('permission_baselines')
    .select(BASELINE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (!data) throw new ExpectedError('That baseline no longer exists.');
  return asBaseline(data as unknown as BaselineRow);
}

const HOLDER_COLUMNS =
  'id, full_name, email, role, is_exec, is_trainer, permission_role, permission_grants, permission_revokes';

/**
 * Everyone this edit has to reach.
 *
 * TWO POPULATIONS FOR A BUILT-IN ROLE, AND THE SECOND ONE IS THE WHOLE REASON
 * THIS FUNCTION TAKES A BASELINE RATHER THAN AN ID.
 *
 *  1. Rows whose grants were COPIED from this baseline — permission_baseline_id.
 *     The only population a club-written baseline ever has.
 *
 *  2. For a built-in, rows still storing the LEGACY permission_role ('finance'),
 *     which resolve through the hard-coded ROLE_DEFAULTS. 00104 rewrites those
 *     to the copied shape, so after it is applied there are none — and this
 *     branch is what makes the code correct BEFORE it is applied, and what makes
 *     a row that somehow acquires one later get swept up rather than silently
 *     keeping the shipped value under a name that now means something else.
 *
 *     Propagation writes them as role 'custom' with the baseline's capabilities,
 *     which is exactly the conversion 00104 performs — so the two agree, and
 *     running either after the other changes nothing.
 */
async function holdersOf(adminClient: Client, baseline: CustomBaseline) {
  const { data: copied } = await adminClient
    .from('players')
    .select(HOLDER_COLUMNS)
    .eq('permission_baseline_id', baseline.id);

  const rows = [...((copied ?? []) as Record<string, unknown>[])];

  if (baseline.builtinRole !== null) {
    const { data: legacy } = await adminClient
      .from('players')
      .select(HOLDER_COLUMNS)
      .eq('permission_role', baseline.builtinRole);
    // De-duplicated by id: the two queries are disjoint today (the check
    // constraint forbids a baseline label on anything but 'custom'), but a
    // holder counted twice would be propagated to twice and reported as two
    // people in the audit row, and neither is worth trusting a constraint for.
    const seen = new Set(rows.map((row) => row.id as string));
    for (const row of (legacy ?? []) as Record<string, unknown>[]) {
      if (!seen.has(row.id as string)) rows.push(row);
    }
  }

  return rows;
}

const nameOfPerson = (person: Record<string, unknown>) =>
  (person.full_name as string | null) ?? (person.email as string | null) ?? 'a member';

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------
/**
 * Write down a new baseline. Nobody holds it yet, so nothing anybody can do
 * changes.
 *
 * NO TYPED REASON, and it is the one place on this screen without one. The house
 * rule is that an AUDITED ACTION takes a reason because "what changed and why"
 * has to be readable back — and creating a baseline changes nobody's access.
 * The audit row carries the author, the name and every capability in it, which
 * is the whole of what happened. Editing one, which does change what a group of
 * people may do, takes a reason; so does deleting one.
 */
export async function createPermissionBaseline(
  name: string,
  capabilities: string[],
): Promise<ActionResult<string>> {
  return runAction(() => createImpl(name, capabilities));
}

async function createImpl(name: string, capabilities: string[]): Promise<string> {
  const { actor, held, adminClient } = await actorContext();

  const nameRefusal = baselineNameRefusal(name);
  if (nameRefusal) throw new ExpectedError(nameRefusal);
  const capabilityRefusal = baselineCapabilityRefusal(capabilities, held);
  if (capabilityRefusal) throw new ExpectedError(capabilityRefusal);

  const stored = normaliseBaselineCapabilities(capabilities as Capability[]);
  const trimmed = name.trim();

  const { data, error } = await adminClient
    .from('permission_baselines')
    .insert({
      name: trimmed,
      capabilities: stored,
      created_by: actor.id,
      updated_by: actor.id,
    })
    .select('id')
    .maybeSingle();
  // The unique index is case- and space-insensitive, so this is the common
  // failure and deserves its own sentence rather than a constraint name.
  if (error) throw new ExpectedError(uniqueNameOr(error.message, trimmed));
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error('The baseline was not written.');

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'permission_baseline_created',
      target_type: 'permission_baseline',
      target_id: id,
      new_value: { name: trimmed, capabilities: stored },
    },
    { baselineId: id },
  );

  revalidatePath('/permissions');
  return id;
}

function uniqueNameOr(message: string, name: string): string {
  if (/permission_baselines_name_key|duplicate key/i.test(message)) {
    return `There is already a baseline called ${name}.`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// EDIT
// ---------------------------------------------------------------------------
/**
 * Change what a baseline says, and change everybody holding it with it.
 *
 * VALIDATE EVERY HOLDER, THEN WRITE — the promise saveBatch makes for a batch of
 * people, held here for a batch nobody chose. An admin editing 'Socials VP' is
 * editing three people at once without having picked them, so a refusal that
 * arrives after two of them are written is the worst possible moment to find
 * out. One unreachable holder refuses the whole edit and names them.
 *
 * THE BASELINE ROW IS WRITTEN FIRST, THEN THE HOLDERS, and the order is not
 * arbitrary. Propagating first and then failing to record the change would leave
 * people holding capabilities no baseline describes — a widening produced by a
 * failed operation, which is the one outcome this must not have. This way a
 * half-finished edit leaves the baseline saying the new thing and some holders
 * still on the old, which is visible on the screen and fixed by saving again:
 * re-running writes the same values to the holders that already have them.
 */
export async function updatePermissionBaseline(
  id: string,
  name: string,
  capabilities: string[],
  reason: string,
): Promise<ActionResult<{ propagated: number }>> {
  return runAction(() => updateImpl(id, name, capabilities, reason));
}

async function updateImpl(
  id: string,
  name: string,
  capabilities: string[],
  reason: string,
): Promise<{ propagated: number }> {
  const { actor, held, adminClient } = await actorContext();

  // THE SHARED FLOOR, WHERE THIS USED TO BE "NON-EMPTY", and the difference is
  // not cosmetic. This reason is forwarded verbatim into setPlayerPermissions
  // for every holder, and that action measures against REASON_MIN — so "ok"
  // would write the baseline row and its audit row, then be refused by all N
  // propagations, leaving the admin on "the baseline was saved, but 3 of 3
  // holders could not be updated. Save again to retry" with a retry that fails
  // identically forever. Refused up here, nothing is written at all.
  const why = reason.trim();
  if (why.length < REASON_MIN) {
    throw new ExpectedError(
      `Say why this baseline is changing — it changes what people can do. At least ${REASON_MIN} characters.`,
    );
  }

  const nameRefusal = baselineNameRefusal(name);
  if (nameRefusal) throw new ExpectedError(nameRefusal);
  const capabilityRefusal = baselineCapabilityRefusal(capabilities, held);
  if (capabilityRefusal) throw new ExpectedError(capabilityRefusal);

  const before = await loadBaseline(adminClient, id);

  // CLOSURE ON WHAT IT SAID, not only on what it will say. Editing a baseline
  // down is a revoke by another name, and an unbounded revoke is a
  // denial-of-access weapon: without this, a narrowly-scoped officer could
  // gut the baseline an admin wrote and every holder with it.
  const cannotReach = before.capabilities.filter((capability) => !held.has(capability));
  if (cannotReach.length > 0) {
    throw new ExpectedError(
      `You cannot change this baseline: it holds ${cannotReach.join(', ')}, which you do not.`,
    );
  }

  const stored = normaliseBaselineCapabilities(capabilities as Capability[]);
  const trimmed = name.trim();
  const holders = await holdersOf(adminClient, before);

  // PRE-FLIGHT, PER HOLDER. setPlayerPermissions runs all five closure checks
  // again for each of them, so this is not the boundary — it is the refusal
  // arriving before anything is written, which is the only place it is useful.
  //
  // Three of the five cannot fail here: the new set is inside the actor's own
  // set and inside EDITOR_OFFERABLE (both checked above), and there are no
  // revokes. What is left is who may be edited at all.
  for (const holder of holders) {
    if (holder.id === actor.id) {
      throw new ExpectedError(
        `You hold this baseline yourself, and nobody may change their own permissions. Ask another admin to make this edit.`,
      );
    }
    const level = accessLevelFor(holder);
    if (level === null) {
      throw new ExpectedError(
        `${nameOfPerson(holder)} holds this baseline but has no console access. Clear their permissions first.`,
      );
    }
    if (level === 'admin') {
      throw new ExpectedError(
        `${nameOfPerson(holder)} is an admin, so nothing stored on them is ever consulted. Clear their permissions first.`,
      );
    }
    const theirs = effectiveCapabilities(level, permissionsOf(level, holder));
    const outOfReach = [...theirs].filter((capability) => !held.has(capability));
    if (outOfReach.length > 0) {
      throw new ExpectedError(
        `You cannot change ${nameOfPerson(holder)}: they hold ${outOfReach.join(', ')}, which you do not.`,
      );
    }
  }

  const { error } = await adminClient
    .from('permission_baselines')
    // Club changes (00286) draft a line only from a write that sets updated_by
    // and moves updated_at. Keep both.
    .update({ name: trimmed, capabilities: stored, updated_by: actor.id, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new ExpectedError(uniqueNameOr(error.message, trimmed));

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'permission_baseline_updated',
      target_type: 'permission_baseline',
      target_id: id,
      old_value: { name: before.name, capabilities: before.capabilities },
      new_value: { name: trimmed, capabilities: stored, holders: holders.length },
      reason: why,
    },
    { baselineId: id },
  );

  // N CALLS, NOT A TRANSACTION, and reported as such. Each one writes its own
  // audit row against the PERSON, which is where somebody looking up "why did
  // this member's access change" will look — the baseline's own row above says
  // what changed, and theirs say who it reached.
  const failures: string[] = [];
  for (const holder of holders) {
    const result = await setPlayerPermissions(holder.id as string, {
      role: 'custom',
      grants: stored,
      revokes: [],
      baselineId: id,
      // The TRIMMED text, and the same one on the baseline's own row above.
      reason: why,
    });
    if (!result.ok) failures.push(`${nameOfPerson(holder)}: ${result.error}`);
  }
  if (failures.length > 0) {
    throw new ExpectedError(
      `The baseline was saved, but ${failures.length} of ${holders.length} holders could not be updated and are still on the old set. Save again to retry. ${failures.join('; ')}`,
    );
  }

  revalidatePath('/permissions');
  revalidatePath('/dashboard');
  return { propagated: holders.length };
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
/**
 * Remove a baseline nobody holds.
 *
 * REFUSED WHILE ANYBODY HOLDS IT, and the alternatives are worse. Deleting the
 * people's capabilities with it is a mass narrowing from a single click on a
 * screen about naming things. Leaving the capabilities and dropping the label is
 * an admin looking at a hand-picked set nobody hand-picked, with no way to tell
 * it apart from one somebody did. So: take the baseline off the people first —
 * which is a per-person act with a per-person audit row — and then delete it.
 *
 * The foreign key says the same thing (ON DELETE RESTRICT). This is the version
 * that names who.
 */
export async function deletePermissionBaseline(
  id: string,
  reason: string,
): Promise<ActionResult<void>> {
  return runAction(() => deleteImpl(id, reason));
}

async function deleteImpl(id: string, reason: string): Promise<void> {
  const { actor, held, adminClient } = await actorContext();

  if (reason.trim() === '') {
    throw new ExpectedError('Say why this baseline is being deleted.');
  }

  const baseline = await loadBaseline(adminClient, id);

  // Bounded by the same rule as a revoke, for the same reason: deleting a
  // baseline an officer could never have written is reaching past what they
  // hold.
  const cannotReach = baseline.capabilities.filter((capability) => !held.has(capability));
  if (cannotReach.length > 0) {
    throw new ExpectedError(
      `You cannot delete this baseline: it holds ${cannotReach.join(', ')}, which you do not.`,
    );
  }

  // A BUILT-IN ROLE IS NEVER DELETED, AND THE HOLDER CHECK BELOW IS NOT ENOUGH
  // ON ITS OWN. A Finance row that nobody currently holds would pass it and
  // delete cleanly — taking with it the seed, the "reset to shipped default"
  // target, and one of the four names the club has always picked from. 00104's
  // INSERT is ON CONFLICT DO NOTHING, so re-running the migration would not
  // bring it back either.
  //
  // Editing and renaming are the feature. Deleting is not, and there is nothing
  // it would buy: a built-in nobody holds is already inert.
  if (baseline.builtinRole !== null) {
    throw new ExpectedError(
      `${baseline.name} is one of the four roles the club ships with, so it cannot be deleted. Edit what it means, or reset it to its original set.`,
    );
  }

  const holders = await holdersOf(adminClient, baseline);
  if (holders.length > 0) {
    const names = holders.map(nameOfPerson).sort();
    throw new ExpectedError(
      `${names.length === 1 ? '1 member holds' : `${names.length} members hold`} ${baseline.name}: ${names.join(', ')}. Change what they hold first.`,
    );
  }

  const { error } = await adminClient.from('permission_baselines').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'permission_baseline_deleted',
      target_type: 'permission_baseline',
      // The row is gone, so the id points at nothing — which is exactly why the
      // contents are written into old_value rather than left to a join.
      target_id: id,
      old_value: { name: baseline.name, capabilities: baseline.capabilities },
      reason,
    },
    { baselineId: id },
  );

  revalidatePath('/permissions');
}

// ---------------------------------------------------------------------------
// RESET
// ---------------------------------------------------------------------------
/**
 * Put a built-in role back to the set it shipped with.
 *
 * THE ANSWER TO "can this be undone", and the reason the four are worth
 * distinguishing from the club's own baselines at all. A club-written baseline
 * has no shipped value to return to — there is nothing it was before somebody
 * wrote it. A built-in does: ROLE_DEFAULTS, which stopped being the runtime
 * answer when 00104 seeded these rows and survives as exactly this.
 *
 * IT IS updatePermissionBaseline WITH THE CAPABILITIES CHOSEN FOR THE CALLER,
 * and deliberately not a second write path. Every rule that applies to an edit
 * applies here: the reason, closure on what the row says AND on what it will
 * say, the EDITOR_OFFERABLE ceiling, the per-holder pre-flight, and propagation
 * to every holder with an audit row each.
 *
 * THAT MEANS A RESET CAN BE REFUSED, which is correct and worth saying out loud.
 * If the owner has taught Finance to read the club's books and hands it to three
 * people, a treasurer who does not hold `fees.clubfees.read` cannot reset it —
 * resetting is a revoke for those three, and an unbounded revoke is a
 * denial-of-access weapon. The shipped set being narrower than the current one
 * does not make putting it back a safe act for anybody to perform.
 *
 * THE NAME IS NOT RESET. A club that renamed Finance to 'Treasurer' meant it,
 * and it is not part of what the role can DO — the thing this feature is about.
 */
export async function resetPermissionBaseline(
  id: string,
  reason: string,
): Promise<ActionResult<{ propagated: number }>> {
  return runAction(() => resetImpl(id, reason));
}

async function resetImpl(id: string, reason: string): Promise<{ propagated: number }> {
  const { adminClient } = await actorContext();
  const baseline = await loadBaseline(adminClient, id);

  if (baseline.builtinRole === null) {
    throw new ExpectedError(
      `${baseline.name} is a baseline the club wrote, so there is no original set to go back to. Edit it, or delete it once nobody holds it.`,
    );
  }

  // Read through the same narrowing every other reader uses, so a value the
  // database somehow holds outside the four cannot pick a default here.
  if (!isBuiltinPermissionRole(baseline.builtinRole)) {
    throw new Error('resetPermissionBaseline: unrecognised built-in role');
  }

  return updateImpl(
    id,
    baseline.name,
    [...shippedDefaultFor(baseline.builtinRole)],
    reason,
  );
}
