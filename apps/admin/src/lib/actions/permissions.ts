'use server';

import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { requireReason } from '../audit-reason';
import { logAdminAudit } from '../audit';
import { auditablePlayer } from '../auditable-player';
import { runAction, type ActionResult } from '../action-result';
// listOf / missingFrom / assertLevelClosure live there rather than here now that
// resolvePrivilegeClaimReview needs the same closure test — see the block at the
// bottom of that module for why one copy rather than two.
import {
  ADMIN_TIER_ACCESS,
  assertLevelClosure,
  fromRoleValue,
  listOf,
  missingFrom,
  toRoleValue,
  type ExecRole,
} from '../console-access';
import { isSuperAdminActor } from '../player-field-access';
import {
  accessLevelFor,
  atLeast,
  effectiveCapabilities,
  isCapability,
  permissionsOf,
  resolvePermissions,
  EDITOR_OFFERABLE,
  PERMISSION_ROLES,
  ROLE_DEFAULTS,
  UNRESTRICTED,
  type Capability,
  type PermissionRole,
} from '../permissions';

/** The whole of a person's stored permissions, written in one act. */
export type PermissionsPayload = {
  /** NULL means "not composed" — the level baseline, i.e. today's access. */
  role: PermissionRole | null;
  grants: string[];
  revokes: string[];
  /**
   * Which custom baseline (00093) these grants were COPIED from, or null/absent
   * for a hand-picked set.
   *
   * WHEN IT IS SET, IT IS THE SOURCE OF TRUTH AND THE OTHER THREE ARE CHECKED
   * AGAINST IT. The action loads the baseline and uses its capabilities, so the
   * stored label can never describe a set the baseline does not say. A caller
   * that sends a role, grants or revokes disagreeing with it is refused loudly
   * rather than quietly overruled — a silent overrule is the editor showing one
   * diff and the database taking another.
   *
   * WHEN IT IS ABSENT, THE LABEL IS CLEARED, and that is the important default.
   * Every ordinary edit through the two-pane editor goes through here without
   * this field, so ticking one extra capability for a baseline holder drops the
   * label and keeps every capability. Without that, the row would say "Socials
   * VP" while holding Socials VP plus one — and the next edit to that baseline
   * would propagate over the extra tick and take it away, a narrowing produced
   * by somebody else's edit to something else.
   */
  baselineId?: string | null;
  /**
   * WHY, AND IT IS NOT OPTIONAL.
   *
   * It used to be, and the consequence was that `player_permissions_changed`
   * was the ONE audited action in the console with `reason: null` on every row
   * — sessions, announcements, legal documents, ratings and platform settings
   * all require one. An access change is the last thing that should be the
   * exception: "who gave them tournaments.write, and why" is exactly the
   * question the log exists to answer, and a null there answers half of it.
   *
   * ONE REASON COVERS A BATCH. The two-pane editor saves several people at
   * once and asks for a single reason, which is then written to every one of
   * their audit rows — the same shape baseline propagation already used, where
   * the reason belongs to the edit that caused the change rather than to each
   * person it reached.
   */
  reason: string;
};

/**
 * Compose one person's permissions — the write half of /permissions, and the
 * gate behind `permissions.write`.
 *
 * ONE ACTION FOR THE WHOLE TRIPLE, not three. The three columns are one
 * decision: a role change moves the base, and the deltas only mean anything
 * against it. Saving them separately would leave a window in which the deltas
 * belong to the old role — and the window is exactly when a revoke that was
 * holding something back stops applying.
 *
 * GRANT CLOSURE IS THE PRIMARY DEFENCE (see the block above the checks). It is
 * what makes this capability safe to hand to somebody who is not an admin:
 * delegation spreads access sideways, and never manufactures it.
 */
export async function setPlayerPermissions(
  playerId: string,
  next: PermissionsPayload,
): Promise<ActionResult<void>> {
  return runAction(() => setPlayerPermissionsImpl(playerId, next));
}

/** Sorted, de-duplicated, and every element known to the vocabulary. */
function cleanDelta(values: string[], which: 'grant' | 'revoke'): Capability[] {
  const unknown = values.filter((v) => !isCapability(v));
  if (unknown.length > 0) {
    // Refused rather than dropped. The resolver ignores an element the
    // vocabulary no longer has — it has to, because a build can be older than a
    // stored row — but the WRITER is the one place that knows the string was
    // just typed, and storing a `${which}` nothing will ever read is a promise
    // the app does not keep. The database would refuse it anyway; this is the
    // refusal in words rather than as a constraint violation.
    throw new ExpectedError(
      `Not something this console can ${which}: ${unknown.join(', ')}`,
    );
  }
  return [...new Set(values as Capability[])].sort();
}

/**
 * The typed reason, trimmed, or a refusal.
 *
 * THE SHARED FLOOR, never a second copy of it — requireReason and REASON_MIN
 * live in lib/audit-reason.ts and every audited action in the console measures
 * against them. All this adds is the error CLASS: that helper throws a plain
 * Error, and every refusal in this file is an ExpectedError so that somebody
 * being told to type a reason is the system working rather than a Sentry fault.
 */
function reasonFor(reason: string, what: string): string {
  try {
    return requireReason(reason, what);
  } catch (err) {
    throw new ExpectedError(err instanceof Error ? err.message : 'A reason is required.');
  }
}

/**
 * THE CEILING THIS CHANGE SHIPS WITH. Grant closure bounds what one person may
 * hand another; it cannot bound an ADMIN, who holds everything by level. So the
 * set an admin may compose is capped at the exec baseline — the capabilities
 * execs already had — which is what keeps this change provably inside the
 * envelope that shipped before it. Handing out the admin-only half is its own
 * small, reviewable change; it is not this one.
 *
 * ONE FUNCTION RATHER THAN TWO TRANSCRIPTIONS, for the reason stated above
 * assertLevelClosure: setConsoleAccess asks the identical question now that a
 * baseline can be handed over in the same act as a level, and it has to ask it
 * BEFORE the level write. A second copy of this sentence is the shape that let a
 * search-and-replace in this file edit the wrong one.
 */
function assertWithinCeiling(capabilities: readonly Capability[]) {
  const offerable = new Set<Capability>(EDITOR_OFFERABLE);
  const notYetOfferable = capabilities.filter((capability) => !offerable.has(capability));
  if (notYetOfferable.length > 0) {
    throw new ExpectedError(
      `${listOf(notYetOfferable)} cannot be handed out yet — ${notYetOfferable.length === 1 ? 'it is' : 'they are'} admin-only.`,
    );
  }
}

async function setPlayerPermissionsImpl(playerId: string, next: PermissionsPayload) {
  // requireCapability returns the row it just authenticated, so there is not
  // even a second lookup that could disagree with the one that let them in.
  const actor = await requireCapability('permissions.write');
  await applyPlayerPermissions(actor, playerId, next);
}

/**
 * Everything setPlayerPermissions does EXCEPT asking for `permissions.write`.
 *
 * SPLIT OUT SO THE ONE OTHER CALLER CAN REACH IT, and that caller is
 * setConsoleAccess clearing a stored composition. It runs under a different
 * capability — `players.consoleaccess.write` — and it must not be made to hold
 * `permissions.write` as well, because that capability is offerable to nobody:
 * it is outside EDITOR_OFFERABLE, so check 5 below refuses to grant it and only
 * an admin can ever hold it. Requiring it here would have made the console
 * capability unusable by the only people it exists for.
 *
 * IT IS NOT A HOLE. Every check in this function still runs, against the ACTOR'S
 * OWN SET, for whichever of the two capabilities got them in — the closure
 * tests, the admin-target refusal, the ceiling and the reason are all below and
 * none of them is conditional on how the caller was authenticated. What the
 * split removes is one `requireCapability` call that the caller has already made
 * for its own act.
 *
 * THE ACTOR'S SET COMES FROM THEIR OWN ROW, resolved server-side through the
 * same path every gate uses — permissionsOf, resolvePermissions,
 * effectiveCapabilities — and never from anything the client sent. That is the
 * whole of grant closure's foundation: if the actor's set could be influenced
 * from outside, every check below would be checking a number the attacker chose.
 */
async function applyPlayerPermissions(
  actor: Awaited<ReturnType<typeof requireCapability>>,
  playerId: string,
  next: PermissionsPayload,
) {
  const actorLevel = accessLevelFor(actor);
  const actorSet = effectiveCapabilities(actorLevel, permissionsOf(actorLevel, actor));

  // Before anything is read and long before anything is written. The reason is
  // a property of the REQUEST, so refusing it early keeps a reasonless call
  // from ever touching the database — and the trimmed value is what reaches
  // the audit row, never the whitespace that got it past the length check.
  const why = reasonFor(next.reason, 'Changing somebody’s permissions');

  // SELF-EDIT IS BLOCKED OUTRIGHT, and it is worth saying that this is not
  // load-bearing: granting yourself something you already hold is a no-op, and
  // a self role-change is bounded by the after-test below, so it could only
  // ever shrink you. It is refused because a permissions screen where the row
  // you are editing might be your own is where misreadings live — "I ticked it
  // and nothing happened" is a support conversation nobody should have. An
  // admin who wants to drop one of their own capabilities asks another admin.
  if (actor.id === playerId) {
    throw new ExpectedError(
      'You cannot change your own permissions. Ask another admin to do it.',
    );
  }

  const adminClient = createAdminClient();
  // Every column permissionsOf() and accessLevelFor() read, and all three
  // permission columns together: naming permission_role without both delta
  // columns makes permissionsOf() throw, deliberately, because the alternative
  // is a narrowed SELECT silently discarding a revoke.
  const { data: target } = await adminClient
    .from('players')
    .select(
      'id, full_name, email, role, is_exec, is_trainer, permission_role, permission_grants, permission_revokes',
    )
    .eq('id', playerId)
    .maybeSingle();
  if (!target) throw new ExpectedError('That member no longer exists.');

  const targetLevel = accessLevelFor(target);

  // Its own check with its own words, ahead of the subset test that would also
  // catch it. An admin holds all 115 capabilities, so "their set is not a
  // subset of yours" is technically what fails — but that sentence tells a
  // treasurer nothing, and "only an admin can change an admin's permissions"
  // tells them exactly who to ask.
  // A super admin target needs a super admin (00321).
  if (atLeast(targetLevel, 'admin') && !atLeast(actorLevel, targetLevel!)) {
    throw new ExpectedError(
      targetLevel === 'super_admin'
        ? "Only a super admin can change a super admin's permissions."
        : "Only an admin can change an admin's permissions.",
    );
  }

  if (next.role !== null && !PERMISSION_ROLES.includes(next.role)) {
    throw new ExpectedError('That is not a permission role.');
  }

  // THE LITERAL ROLE VALUES STILL RESOLVE, AND THAT IS DELIBERATE.
  //
  // Since 00104 the four VP jobs are editable ROWS, handed over by copying like
  // any baseline, and the editor no longer OFFERS them as names — roleOptions()
  // filters them out, keeping one only when it is already what the person has.
  // So a row storing permission_role = 'finance' can no longer be created
  // through the console; it can only be a row that predates the migration.
  //
  // REFUSING THE VALUE HERE WAS TRIED AND REJECTED. It is not an escalation —
  // the seeded defaults are inside EXEC_ASSIGNABLE, the historic exec set, and
  // checks 3-5 below run on the RESOLVED result regardless, so nothing can be
  // gained by naming one. What
  // it would be is incoherent: a second Finance that does not follow the Finance
  // the club edited.
  //
  // TWO THINGS ALREADY CLOSE THAT, WHICH IS WHY A THIRD IS NOT WORTH ITS COST.
  // 00104 rewrites every legacy holder to the copied shape when it is applied,
  // and holdersOf() in permission-baselines.ts sweeps any that remain into it on
  // the next edit to that role — so the incoherent state is self-healing and
  // bounded by the shipped set while it lasts. A refusal here would additionally
  // have forced seventeen existing closure and audit tests off a role base and
  // onto hand-picked grants, which is a weaker thing to test than what they test
  // now.

  // A ROLE ON AN ADMIN IS A VALUE NOTHING READS, and that is the whole reason
  // it is refused. permits() short-circuits on level === 'admin' before any set
  // is consulted, so a stored role would not take one capability away from
  // them; it would only look as though it had, which is worse than refusing.
  // Narrowing an admin means making them an executive first.
  //
  // TRAINERS USED TO BE REFUSED HERE TOO, and that is what this change undoes.
  // The old reasoning was that a trainer's whole level is three capabilities
  // with nothing in it to narrow — true, and beside the point: the club has a
  // varsity trainer who also runs sessions, and the only way to say so was to
  // make them an exec, which hands over the entire exec baseline to somebody
  // who needed one area of it. Composition is the answer to exactly that, and
  // no machinery had to change to allow it: resolvePermissions is
  // LEVEL-AGNOSTIC, so a composed trainer has always resolved through the same
  // path as a composed exec, and the level decides only what an UNCOMPOSED
  // person holds. This guard was the one thing refusing to create one.
  //
  // The cost, and it is real: a role REPLACES the base, so a trainer given
  // `tournaments` loses TRAINER_BASELINE — varsity notes included — unless the
  // role carries it or it is granted back. That is the same semantics an exec
  // has had since this shipped, and the editor shows what will be lost before
  // the save rather than after.
  if (next.role !== null && atLeast(targetLevel, 'admin')) {
    throw new ExpectedError(
      'An admin holds every capability by level, so a permission role on one would never be consulted. Make them an executive first.',
    );
  }

  // A CUSTOM BASELINE (00093) IS A COPY, AND THIS IS WHERE IT IS COPIED.
  //
  // The capabilities are read from the baseline row, never from the payload, so
  // permission_baseline_id can never name a baseline that says something other
  // than what the person holds. The payload is checked against it rather than
  // ignored: a disagreement means the client drew a diff the server would not
  // have written, and silently writing the other one is how an admin comes to
  // believe they granted something they did not.
  //
  // THE FIVE CLOSURE CHECKS BELOW STILL RUN, unchanged and on these values. A
  // baseline is bounded at authoring time by the author's own set, but the
  // person ASSIGNING it may be someone else with less — so "this baseline was
  // legal to write" is not "this actor may hand it to this person", and nothing
  // here is allowed to skip the question.
  const baselineId = next.baselineId ?? null;
  let fromBaseline: Capability[] | null = null;
  if (baselineId !== null) {
    const { data: baselineRow } = await adminClient
      .from('permission_baselines')
      .select('id, capabilities')
      .eq('id', baselineId)
      .maybeSingle();
    if (!baselineRow) throw new ExpectedError('That baseline no longer exists.');
    fromBaseline = [
      ...new Set((baselineRow.capabilities as string[]).filter(isCapability)),
    ].sort();

    // 'custom' is the EMPTY base, which is the only base under which the stored
    // grants are the whole of what the person holds. Any other role has defaults
    // beneath them, and a label claiming the set came from a baseline would be
    // describing part of it.
    if (next.role !== 'custom') {
      throw new ExpectedError('A baseline is stored as a hand-picked set. Pick "Hand-picked".');
    }
    // Element by element rather than through a joined string: a delimiter is a
    // character that could appear in a capability, and this comparison is what
    // stops a stored label describing a set the baseline does not say.
    const asked = [...new Set(next.grants)].sort();
    const sameAsBaseline =
      asked.length === fromBaseline.length
      && asked.every((capability, index) => capability === fromBaseline![index]);
    if (!sameAsBaseline || next.revokes.length > 0) {
      throw new ExpectedError(
        'That does not match what the baseline says. Reload the page and try again.',
      );
    }
  }

  // NO DELTAS WITHOUT A ROLE, cleared here rather than refused. Going back to
  // unrestricted is the safe direction and should not be a two-step act — but
  // the arrays cannot be left behind, or a revoke would sit dormant and wake up
  // the day somebody picks a role again. The database CHECK says the same
  // thing; this is what stops an admin ever meeting it.
  const role = next.role;
  const grants = role === null ? [] : cleanDelta(fromBaseline ?? next.grants, 'grant');
  const revokes = role === null ? [] : cleanDelta(next.revokes, 'revoke');

  const bothWays = grants.filter((capability) => revokes.includes(capability));
  if (bothWays.length > 0) {
    throw new ExpectedError(
      `Cannot grant and revoke the same thing: ${listOf(bothWays)}`,
    );
  }

  // A grant of something the role already gives is normalised away rather than
  // stored. It resolves identically, but a stored redundant grant survives the
  // role losing that capability — so the person would keep it while every other
  // holder of the role lost it, from a tick nobody made deliberately.
  const roleBase = role === null ? [] : ROLE_DEFAULTS[role];
  const storedGrants = grants.filter((capability) => !roleBase.includes(capability));

  // ------------------------------------------------------------------
  // GRANT CLOSURE
  // ------------------------------------------------------------------
  // Nobody hands out what they do not hold. Four checks, all of them before any
  // write, so a refusal leaves the row exactly as it was — a partially applied
  // permission change is a person with an access set nobody chose.

  // 1. Every GRANT is something the actor holds.
  const cannotGrant = missingFrom(actorSet, storedGrants);
  if (cannotGrant.length > 0) {
    throw new ExpectedError(
      `You cannot grant ${listOf(cannotGrant)} because you do not hold ${cannotGrant.length === 1 ? 'it' : 'them'}.`,
    );
  }

  // 2. Every REVOKE is something the actor holds, bound by the SAME rule.
  //
  // An unbounded revoke is a denial-of-access weapon: a narrowly-scoped holder
  // of permissions.write could strip a colleague who outranks them of the
  // capabilities they were elected to use. The consequence, which is real and
  // worth stating: only somebody who could have granted a capability can take
  // it back, so tidying up after a departed officer may need an admin.
  const cannotRevoke = missingFrom(actorSet, revokes);
  if (cannotRevoke.length > 0) {
    throw new ExpectedError(
      `You cannot revoke ${listOf(cannotRevoke)} because you do not hold ${cannotRevoke.length === 1 ? 'it' : 'them'}.`,
    );
  }

  // 3. WHO MAY EDIT WHOM, before the change. Stops a narrowly-scoped holder
  //    reaching into the permissions of somebody who holds more than they do —
  //    which they could otherwise do purely by narrowing them, without granting
  //    anything at all.
  const before = effectiveCapabilities(targetLevel, permissionsOf(targetLevel, target));
  const outOfReach = missingFrom(actorSet, [...before]);
  if (outOfReach.length > 0) {
    throw new ExpectedError(
      `You cannot change this person's permissions: they hold ${listOf(outOfReach)}, which you do not.`,
    );
  }

  // 4. And on the RESULT. Catches the case the delta checks cannot see: a role
  //    change moves the base wholesale, and its defaults are not grants, so
  //    nothing above would have looked at them.
  const after = effectiveCapabilities(
    targetLevel,
    resolvePermissions(targetLevel, role, storedGrants, revokes),
  );
  const wouldExceed = missingFrom(actorSet, [...after]);
  if (wouldExceed.length > 0) {
    throw new ExpectedError(
      `That would give them ${listOf(wouldExceed)}, which you do not hold.`,
    );
  }

  // 5. AND THE CEILING THIS CHANGE SHIPS WITH, which is the one check of the
  //    five that is not about this actor at all. See assertWithinCeiling, whose
  //    other caller is setConsoleAccess pre-flighting a baseline handed over in
  //    the same act as a level.
  assertWithinCeiling(storedGrants);

  // Snapshotted BEFORE the write, not read back from `target` afterwards. The
  // audit row is the only trace this change leaves, and "what it was" has to be
  // captured while it still is.
  const wasStored = {
    permission_role: target.permission_role ?? null,
    permission_grants: target.permission_grants ?? [],
    permission_revokes: target.permission_revokes ?? [],
  };

  // THE LABEL IS WRITTEN ON EVERY SAVE, and to null unless this one came from a
  // baseline. That is what keeps it honest: an ordinary edit through the editor
  // carries no baselineId, so ticking one extra capability for a baseline holder
  // drops the label in the same write that stores the tick. The person keeps
  // everything they had; only the claim about where it came from goes.
  const { error } = await adminClient
    .from('players')
    .update({
      permission_role: role,
      permission_grants: storedGrants,
      permission_revokes: revokes,
      permission_baseline_id: role === null ? null : baselineId,
    })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  // BOTH the stored triple AND the resolved set, on both sides.
  //
  // The triple alone does not answer "what did this change actually do": a role
  // is a name whose contents live in code and can move in a later deploy, so
  // reading `role: finance` back in six months tells you what it means TODAY,
  // not what it meant when the change was made. The resolved sets are the
  // answer, and they are the only thing in this row that cannot go stale.
  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id,
      action_type: 'player_permissions_changed',
      target_type: 'player',
      target_id: playerId,
      old_value: { ...wasStored, effective: [...before].sort() },
      new_value: {
        permission_role: role,
        permission_grants: storedGrants,
        permission_revokes: revokes,
        permission_baseline_id: role === null ? null : baselineId,
        effective: [...after].sort(),
      },
      // ALWAYS PRESENT NOW. An editor save carries the one reason typed for the
      // batch; baseline propagation carries the reason typed on the edit that
      // caused it; setConsoleAccess carries its own. So a member's audit trail
      // says why their access moved without anything else having to be found
      // first, which is the entire reason the column is there.
      reason: why,
    },
    { playerId },
  );

  revalidatePath('/permissions');
  revalidatePath('/players');
  // THIS PATH BECAME LOAD-BEARING when the editor was embedded on the member's
  // own detail page: the panel there IS this row, so a stale copy would show the
  // capabilities as they were before the save that just landed. setConsoleAccess
  // has always revalidated it — only the capability-write path was missing it.
  revalidatePath(`/players/${playerId}`);
  // The sidebar and the dashboard are both filtered by what the viewer holds,
  // so the person whose access just changed must not keep a cached copy of the
  // old answer.
  revalidatePath('/dashboard');
}

/**
 * Give somebody the console, or take it away — the other half of /permissions,
 * and the half the page's own subtitle has always promised.
 *
 * THIS IS THE ONLY WAY TO CHANGE SOMEBODY'S CONSOLE ACCESS. `role`, `is_exec`
 * and `is_trainer` are the hard floor in player-field-access.ts, and the member
 * Edit dialog used to reach them through updatePlayer() under nothing but an
 * `isAdmin` check. The club owner removed that control — "i dont think the
 * console access should be there anymore… as its only admins who will be mainly
 * editing permissions" — and updatePlayer now refuses the three columns from
 * every caller, so the level write lives here and nowhere else.
 *
 * (The one other writer of those columns on an EXISTING member is
 * resolvePrivilegeClaimReview in actions/players.ts, which puts back exactly what
 * a roster claim withheld under this same capability. Creating a member can set
 * is_exec / is_trainer at insert, behind the admin-only
 * assertPlayerCreateFieldAccess, because 00132's claim attribution depends on an
 * exec being able to pre-add an officer.)
 *
 * (Worth knowing while reading that: the guard_player_privileged_columns trigger
 * names the same columns and does NOT cover this path. It opens with `IF
 * auth.uid() IS NULL … RETURN NEW`, and every admin action writes through the
 * service-role client where auth.uid() is NULL — see the header of
 * player-field-access.ts, verified against the live definition. The trigger
 * protects a member editing their own row through PostgREST. The application
 * guard is the only one standing here.)
 *
 * THIS USED TO BE ADMIN BY LEVEL AND IS NOW A CAPABILITY — the club owner's
 * "also make role change a permission". What stood here was an isAdminActor()
 * check whose stated reason was that handing out a level is the one act the
 * capability system deliberately cannot express, so `permissions.write` — which
 * an exec may hold — must not be mistaken for permission to do it.
 *
 * THAT REASONING IS NARROWED RATHER THAN OVERTURNED, and the part of it that
 * survives is the part that matters. `permissions.write` still is not permission
 * to hand out a level: a SECOND capability, `players.consoleaccess.write`, is
 * required, and it is in no baseline, so nobody holds it who was not given it by
 * name. What it may hand out is `executive` and `trainer` and nothing else —
 * making somebody an ADMIN, and touching anybody who already is one, still
 * require isAdminActor(). If a capability could mint an admin, holding it would
 * be equivalent to being one and the hard floor would be decorative.
 *
 * ONE CAPABILITY, AND DELIBERATELY NOT `permissions.write` AS WELL. Requiring
 * both was the obvious shape and it would have made the feature inert:
 * `permissions.write` is outside EDITOR_OFFERABLE, so check 5 of
 * setPlayerPermissions refuses to grant it and only an admin can ever hold it.
 * A gate that asks for it is a gate only admins pass, which is what this change
 * exists to stop being true. The composition clear below therefore goes through
 * applyPlayerPermissions rather than the gated action — see the note there.
 *
 * GRANT CLOSURE IS WHAT MAKES IT SAFE, checked in both directions and against
 * the LEVEL BASELINES rather than a delta: what the target holds now must be
 * inside the actor's own set, and what they would hold after the change must be
 * too. That is also what graduates exec from trainer without a second
 * capability — promoting somebody to executive hands them EXEC_BASELINE, so only
 * an actor holding all of it may do it, while a trainer-sized actor can still
 * promote somebody to varsity trainer.
 *
 * THAT BAR DROPPED FROM 73 CAPABILITIES TO 12 when the exec baseline became
 * read-only, and it dropped for the right reason: the promotion now confers
 * twelve reads and no writes, so the closure test measures what is actually
 * being handed over. The writes follow separately, through setPlayerPermissions,
 * where each is closure-checked on its own.
 *
 * AND THE BASELINE IS PART OF THE SAME ACT NOW, which is the whole of the fourth
 * parameter. Giving somebody the console and giving them the job they were
 * elected to were two saves on two controls, with a read-only executive in
 * between them for as long as it took to notice the second one, and a reason
 * typed twice. Passing a baseline here makes it one prompted step and one
 * all-or-nothing act: every refusal below, closure and ceiling alike, is checked
 * against the post-baseline state BEFORE the level is written, so a refusal
 * leaves the row exactly as it was.
 *
 * `baselineId` IS A CLIENT-CONTROLLED POST FIELD, like every other parameter of
 * every exported function in a 'use server' module: this file's own doors are the
 * endpoints, the picker on /permissions is not. That is why nothing below trusts
 * the capabilities the client thinks the baseline holds: they are read from the
 * row. It is also why the refusals are here rather than in the editor, which only
 * decides what is DRAWN.
 */
export async function setConsoleAccess(
  playerId: string,
  access: ExecRole,
  reason: string,
  baselineId: string | null = null,
): Promise<ActionResult<void>> {
  return runAction(() => setConsoleAccessImpl(playerId, access, reason, baselineId));
}

/**
 * THE ONE WRITER OF role / is_exec / is_trainer on an existing member — for an
 * admin and for a capability holder alike. It was added in 00105 for the holder
 * only, beside updatePlayer's admin path; that path is gone, because updatePlayer
 * now refuses these columns from everybody.
 *
 * NOT EXPORTED, and that is a security property rather than tidiness. This file
 * carries `'use server'`, so every exported async function in it is a client
 * callable endpoint — an exported writer of role/is_exec/is_trainer would be the
 * hard floor with a public door in it. It is reachable only from
 * setConsoleAccessImpl, after the capability gate, the two admin-only branches,
 * the self-edit refusal and both closure checks have run.
 *
 * THE SAME AUDIT SHAPE updatePlayer WRITES, and that is load-bearing rather than
 * cosmetic. isAccessChange() in officer-access.ts picks console-access changes
 * out of the log by looking for `player_updated` rows whose new_value names one
 * of these three columns; a different action_type or a different shape here
 * would make these changes vanish from the access-changes view — silently, which
 * is the failure mode this codebase keeps writing comments about.
 *
 * THE LAST-ADMIN GUARD IS NOT BYPASSED, and it is now REACHABLE from here, which
 * it was not while only non-admins came through. It is trg_guard_last_admin_role
 * (00050), a BEFORE UPDATE OR DELETE trigger on public.players, so it fires on
 * this statement exactly as it fired on updatePlayer's — an admin demoting the
 * last admin holding a passkey is refused by the database, and the message
 * reaches them verbatim: `throw new Error(error.message)` here becomes
 * runAction's `err.message` at the boundary, which is the identical sentence
 * updatePlayer's own runAction used to hand back.
 */
async function writeConsoleLevel(
  adminClient: ReturnType<typeof createAdminClient>,
  actorId: string,
  playerId: string,
  access: ExecRole,
  reason: string,
) {
  // Read back in full for the audit row, the same select updatePlayer makes,
  // so "what it was" is the whole record rather than the handful of columns
  // this action happened to need for its own checks.
  const { data: oldPlayer } = await adminClient
    .from('players')
    .select('*')
    .eq('id', playerId)
    .maybeSingle();

  const columns = fromRoleValue(access);
  const { error } = await adminClient.from('players').update(columns).eq('id', playerId);
  if (error) throw new Error(error.message);

  await logAdminAudit(
    adminClient,
    {
      actor_id: actorId,
      action_type: 'player_updated',
      target_type: 'player',
      target_id: playerId,
      // `rating` is absent rather than null: updatePlayer carries one because it
      // can write ratings, and this cannot. An absent key says "not part of this
      // act"; a null would claim one was read and found empty.
      old_value: { player: auditablePlayer(oldPlayer) },
      new_value: { ...columns },
      reason,
    },
    { playerId },
  );

  // What updatePlayer would have revalidated. The roster shows the level and the
  // member's own page shows it twice.
  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

async function setConsoleAccessImpl(
  playerId: string,
  access: ExecRole,
  rawReason: string,
  baselineId: string | null,
) {
  // THE CAPABILITY THAT REPLACED isAdminActor(). An admin passes it by level,
  // holding every capability there is; anybody else holds it because somebody
  // granted it to them by name.
  const actor = await requireCapability('players.consoleaccess.write');
  // THE SAME FLOOR AS EVERY OTHER AUDITED ACTION. This used to be enforced only
  // by the dialog, at two characters — "ok" reached the audit log — and it now
  // has to hold here as well, because both clearComposition paths below forward
  // this reason into applyPlayerPermissions, which measures it against
  // REASON_MIN. Left at two, a console-access change that also cleared a
  // composition would half-apply and report a refusal about a screen the admin
  // never saw.
  const reason = reasonFor(rawReason, 'Changing somebody’s console access');

  const actorIsSuperAdmin = isSuperAdminActor(actor);
  const actorLevel = accessLevelFor(actor);
  // From the actor's OWN row, resolved server-side through the same path every
  // gate uses — never from anything the client sent. Same foundation grant
  // closure has in setPlayerPermissions, and for the same reason: a set that
  // could be influenced from outside makes every check below check a number the
  // attacker chose.
  const actorSet = effectiveCapabilities(actorLevel, permissionsOf(actorLevel, actor));

  // THE LINE THAT DOES NOT MOVE. A capability may hand out `executive` and
  // `trainer`; the admin levels stay a super admin's (00321), because a
  // capability that could mint an admin would make holding it the same thing as
  // being one, and the hard floor in player-field-access.ts, which exists
  // precisely so that no capability reaches a level, would be decorative. The
  // database refuses the same write from the browser key
  // (guard_player_privileged_columns).
  if (ADMIN_TIER_ACCESS.includes(access) && !actorIsSuperAdmin) {
    throw new ExpectedError(
      'Only a super admin can make somebody an admin or a super admin.',
    );
  }

  // NO SELF-EDIT, IN EITHER DIRECTION, and both directions now matter.
  //
  // SELF-DEMOTION: taking your own console access away on the one screen that
  // could put it back. The database's last-admin guard does not cover it — that
  // protects the last admin who holds a PASSKEY, so a club with two admins would
  // let either one lock themselves out. Somebody who genuinely means to step
  // down asks somebody else, which is the same answer the permissions half
  // already gives.
  //
  // SELF-PROMOTION is what this line closes now that the act is a capability
  // rather than an admin-only one, and it is the escalation question this whole
  // change turns on. An executive holding players.consoleaccess.write and
  // pointing it at their own row is the one move that would let a capability
  // manufacture a level for its holder. It cannot be reached: the actor is
  // refused before the target is even loaded. The two remaining routes are
  // bounded rather than open — minting a second privileged account is refused by
  // assertPlayerCreateFieldAccess, which is admin-only and untouched, and asking
  // a colleague to do it is delegation working as intended, bounded by closure
  // to what that colleague already holds.
  if (actor.id === playerId) {
    throw new ExpectedError(
      'You cannot change your own console access. Ask another admin to do it.',
    );
  }

  const adminClient = createAdminClient();
  // The level markers, plus all three permission columns together — naming
  // permission_role without both delta columns makes permissionsOf() throw.
  const { data: target } = await adminClient
    .from('players')
    .select('id, full_name, role, is_exec, is_trainer, permission_role, permission_grants, permission_revokes')
    .eq('id', playerId)
    .maybeSingle();
  if (!target) throw new ExpectedError('That member no longer exists.');

  const targetLevel = accessLevelFor(target);

  // TAKING CONSOLE ACCESS AWAY IS THE SAME ACT AS GIVING IT, so a holder must
  // not be able to strip an admin. Its own check with its own words, ahead of
  // the closure test below that would also catch it — an admin holds every
  // capability, so "they hold things you do not" is technically what fails, and
  // that sentence tells a treasurer nothing about who to ask.
  if (atLeast(targetLevel, 'admin') && !actorIsSuperAdmin) {
    throw new ExpectedError("Only a super admin can change an admin's console access.");
  }

  const was = toRoleValue(
    (target.role as string | null) ?? 'player',
    target.is_exec === true,
    target.is_trainer === true,
  );
  const levelChanged = was !== access;

  // A COMPOSITION IS ONLY CONSULTED AT TWO OF THE FOUR LEVELS. An admin is a
  // superuser by level and permits() short-circuits before any stored set is
  // read; somebody with no level never reaches a gate at all. So the stored
  // triple survives exactly one kind of move — executive to varsity trainer and
  // back — where the resolver, which is level-agnostic, goes on resolving it and
  // the page goes on showing it. Every other move clears it.
  //
  // Left behind, it is the dormant-delta hazard the storage CHECKs exist to
  // prevent, one level up: a revoke that stops biting and a grant that stops
  // showing, both invisible on a row with nowhere to apply, ready to wake up the
  // day somebody is promoted again months later.
  const live = (value: ExecRole) => value === 'executive' || value === 'trainer';
  const clears = !(live(was) && live(access));
  const hasComposition =
    (target.permission_role ?? null) !== null ||
    ((target.permission_grants as string[] | null) ?? []).length > 0 ||
    ((target.permission_revokes as string[] | null) ?? []).length > 0;

  // ORDER, AND IT IS NOT ARBITRARY. Clearing a LIVE composition first and then
  // failing to write the level would leave an executive who had just lost their
  // narrowing — a widening produced by a failed operation, which is the one
  // outcome this action must not have. So a live composition is cleared AFTER,
  // where the worst case is an inert delta on a row that no longer reaches a
  // gate, reported loudly here rather than discovered later.
  //
  // A composition that is ALREADY inert — on somebody with no level, or on an
  // admin — has the opposite answer for the same reason: clearing it cannot
  // widen anybody, because it is granting nobody anything right now, and doing
  // it first means a failed level write leaves nothing stale behind at all.
  const clearFirst = clears && hasComposition && !live(was);
  const clearAfter = clears && hasComposition && live(was);

  // THE BASELINE HALF, READ AND REFUSED HERE AND APPLIED AT THE VERY END.
  //
  // NOTHING HAS BEEN WRITTEN YET at this point, which is the only reason this
  // block belongs here: a baseline that cannot be handed over must take the level
  // change down with it rather than leave a half-applied member behind.
  //
  // A BASELINE ONLY MEANS SOMETHING AT THE TWO LIVE LEVELS. On `none` or `admin`
  // no stored set is ever consulted, so writing one would be the dormant-delta
  // hazard described just above: a composition on a row with nowhere to apply,
  // invisible, ready to wake up the day somebody is promoted again.
  //
  // THE CAPABILITIES COME FROM THE ROW, NEVER FROM THE CALLER, which is the same
  // rule applyPlayerPermissions states where it copies a baseline. It is also what
  // makes a client-controlled `baselineId` safe to accept: the worst a hand-crafted
  // POST can name is a baseline that already exists, bounded by the two checks
  // below exactly as the picker's own choice would have been.
  let baselineCapabilities: Capability[] | null = null;
  if (baselineId !== null) {
    if (!live(access)) {
      throw new ExpectedError(
        'A baseline only means something at executive or varsity trainer level, because no other level consults a stored set. Change the level without one.',
      );
    }
    const { data: baselineRow } = await adminClient
      .from('permission_baselines')
      .select('id, name, capabilities')
      .eq('id', baselineId)
      .maybeSingle();
    if (!baselineRow) throw new ExpectedError('That baseline no longer exists.');
    baselineCapabilities = [
      ...new Set((baselineRow.capabilities as string[]).filter(isCapability)),
    ].sort();
    // The ceiling, ahead of the level write rather than inside the apply that
    // follows it. Closure is folded into `after` below and therefore covered by
    // assertLevelClosure; this one is not about the actor's set at all, so it has
    // to be asked separately or an admin handing over an out-of-ceiling baseline
    // would get the level change and then the refusal.
    assertWithinCeiling(baselineCapabilities);
  }

  // ------------------------------------------------------------------
  // GRANT CLOSURE, ON A LEVEL
  // ------------------------------------------------------------------
  // The same rule setPlayerPermissions applies to a capability set, applied to
  // the set a LEVEL resolves to. Nobody hands out what they do not hold, and
  // giving somebody the console is still the largest single grant there is,
  // though it is a smaller one than it was: an unrestricted executive holds
  // EXEC_BASELINE, which is twelve reads rather than the historic 73.
  //
  // BOTH DIRECTIONS, and both before any write.
  //
  // Computed from the ACTUAL post-change state rather than from a guess about
  // which baseline applies, because `clears` decides it: executive-to-trainer
  // keeps the stored composition and resolves through it, and every other move
  // drops it and resolves to the new level's baseline. Reading the wrong one
  // here would make the check wrong in exactly the case it matters.
  const before = effectiveCapabilities(targetLevel, permissionsOf(targetLevel, target));
  const nextLevel = accessLevelFor(fromRoleValue(access));
  // THE FLOOR IS RESOLVED AT `nextLevel`, NOT AT `targetLevel`, and the explicit
  // parameter is what made that decidable rather than accidental. The only move
  // that keeps a composition is executive-to-trainer, and it is exactly the move
  // where the floor underneath it CHANGES — from the exec baseline to the
  // trainer one. Resolving the surviving composition at the old level would have
  // computed `after` with eight section pages the person is about to stop
  // holding, and check 2 below would then demand the actor hold them.
  //
  // A BASELINE IN THE SAME ACT IS PART OF THE POST-CHANGE STATE, and folding it in
  // here is what makes the combined act all-or-nothing rather than two writes with
  // a window between them. The apply at the bottom stores `role: 'custom'` with
  // the baseline as its grants, so that is what is resolved: assertLevelClosure
  // then refuses a closure violation BEFORE writeConsoleLevel, reusing the check
  // that was already there rather than adding a second one that could disagree
  // with the one the apply itself will make.
  const after = effectiveCapabilities(
    nextLevel,
    baselineCapabilities !== null
      ? resolvePermissions(nextLevel, 'custom', baselineCapabilities, [])
      : clears
        ? UNRESTRICTED
        : permissionsOf(nextLevel, target),
  );

  // BOTH CHECKS, IN ONE CALL, AND THE FUNCTION LIVES IN console-access.ts.
  // It was two inline blocks here, the same shape as checks 3 and 4 of
  // applyPlayerPermissions — and the second was once byte-identical to its twin,
  // which made a search-and-replace across this file silently edit the wrong
  // copy. The roster-claim restore now needs the identical test, so it is one
  // named function with one set of words rather than a third transcription.
  assertLevelClosure(actorSet, before, after);

  // NOTHING TO DO ONLY WHEN THERE IS NOTHING LEFT TO DO. "Their level is already
  // what you asked for" is NOT the same question as "does this action have
  // anything to change", and answering the second with the first is how the
  // clear-after path above becomes permanent damage: if the level write lands
  // and the clear then fails, the admin retries, `was` now equals `access`, and
  // an early return here would report success while the stale composition sits
  // there forever with no way to reach it from the console. On that retry
  // clearFirst is true — the level is 'none' now, so the composition is already
  // inert — and the work finishes.
  //
  // A BASELINE IS A FOURTH REASON THERE IS SOMETHING TO DO, and the same argument
  // applies to it: somebody already at the level they were asked for still needs
  // the job applied, and the retry after a failed apply is exactly the case where
  // `was` has caught up with `access` while the baseline has not.
  if (!levelChanged && !clearFirst && !clearAfter && baselineId === null) return;

  async function clearComposition(levelAlreadyChanged: boolean) {
    // THE CALLER'S OWN REASON, forwarded. This clear is not a separate decision
    // an admin made; it is part of the console-access change they typed a
    // reason for, and the member's audit trail should say so rather than carry
    // a permissions row explaining nothing beside a level row explaining
    // everything. (It is also what keeps this path working at all now that
    // applyPlayerPermissions requires one.)
    //
    // APPLIED RATHER THAN CALLED THROUGH setPlayerPermissions, because that
    // action asks for `permissions.write`, which nobody below admin can hold —
    // see the note on applyPlayerPermissions. Every CHECK inside it still runs
    // against this actor's own set.
    //
    // AND IT IS INERT WHENEVER IT RUNS, which is why clearing a composition
    // cannot widen anybody here. clearFirst runs while the target is at a level
    // that consults no stored set (none, or admin); clearAfter runs only after
    // the level write has landed on such a level, and only if that write
    // succeeded. So "role = null" — which reads as UNRESTRICTED — is being
    // written to somebody for whom unrestricted resolves to nothing anyway.
    try {
      await applyPlayerPermissions(actor, playerId, {
        role: null,
        grants: [],
        revokes: [],
        reason,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new ExpectedError(
        levelAlreadyChanged
          ? `Console access changed, but their stored permissions could not be cleared: ${message}`
          : `Their stored permissions could not be cleared, so console access was left alone: ${message}`,
      );
    }
  }

  if (clearFirst) await clearComposition(false);

  // ONE WRITER, FOR EVERYBODY, and it used to be two.
  //
  // The admin half went through updatePlayer(), because updatePlayer applied the
  // field guard, wrote the audit row and met the database's last-admin trigger,
  // and a capability holder could not go through it — assertPlayerFieldAccess
  // refuses the three level columns to everybody below admin unconditionally, so
  // 00105 added writeConsoleLevel beside it rather than opening the floor.
  //
  // THE EDIT DIALOG NO LONGER OFFERS CONSOLE ACCESS (the club owner: "i dont
  // think the console access should be there anymore"), and updatePlayer now
  // refuses the three columns from ANY caller, admin included. So the admin
  // branch had exactly one remaining reason to exist — reaching a writer the
  // capability holder could not — and that reason is gone with it. Collapsing to
  // one writer is the point of the change rather than a tidy-up: two functions
  // that write the same three columns are two places a check can be added to and
  // one place it can be forgotten.
  //
  // NOTHING IS LOST BY COLLAPSING. writeConsoleLevel reads the whole row back for
  // the audit, writes the same `player_updated` action_type isAccessChange()
  // matches, and revalidates what updatePlayer revalidated. The last-admin guard
  // (trg_guard_last_admin_role, 00050) is a BEFORE UPDATE trigger on
  // public.players, so it fires on this statement exactly as it fired on
  // updatePlayer's, and its message reaches the admin verbatim: runAction returns
  // `err.message` for any Error, which is the same sentence updatePlayer's own
  // runAction produced.
  //
  // All three columns every time, never a subset: fromRoleValue answers the whole
  // question, so moving somebody from executive to trainer clears is_exec in the
  // same write that sets is_trainer, and no marker survives a move it was not
  // part of.
  if (levelChanged) {
    await writeConsoleLevel(adminClient, actor.id as string, playerId, access, reason);
  }

  if (clearAfter) await clearComposition(true);

  // THE BASELINE, APPLIED LAST, AND THE ORDER IS THE WHOLE OF IT.
  //
  // AFTER THE LEVEL WRITE, NEVER BEFORE. applyPlayerPermissions resolves the
  // target's level from its OWN fresh read, so its checks 3 and 4 would measure
  // the level the person is about to stop having, and a baseline written first
  // would put `permission_role = 'custom'` on a row with no level at all, which is
  // the dormant-delta hazard documented above `clears`. Reversing these two lines
  // is the one edit to this function that would be quietly wrong.
  //
  // CLEARING AND APPLYING CAN NEVER BOTH HAPPEN, so the two lines need no guard
  // between them: `clearAfter` requires live(was), while a baseline requires
  // live(access), and `clears` is false whenever both are live. A baseline
  // therefore only ever arrives on a move whose `clearAfter` is false by
  // construction.
  //
  // THREE AUDIT ROWS IN ONE CASE, AND IT IS CORRECT. A member with no level but a
  // stale composition takes clearFirst, so the act logs
  // player_permissions_changed, player_updated, player_permissions_changed, all
  // carrying the same typed reason. Read as a bug it looks like a double write; it
  // is the clear, the level and the job, which is what the admin asked for.
  //
  // THROUGH THE GATED ACTION, NOT applyPlayerPermissions, and that is deliberate.
  // The licence for reaching the ungated helper is stated on clearComposition
  // above: the clear IS INERT WHENEVER IT RUNS. A baseline is the opposite kind of
  // act, because it WIDENS somebody. So it goes through the door that asks for
  // `permissions.write`, and setPlayerPermissions' five checks run again against
  // this actor's own set.
  //
  // THE WINDOW BETWEEN THE TWO WRITES IS NARROW, AND WHAT IS LEFT OF IT IS
  // RECOVERABLE. Folding the baseline into `after` removes every closure and
  // ceiling cause of a failure on this line, so what remains is a baseline deleted
  // between the pre-flight and here, a database error, and the hand-crafted POST
  // named below. All three arrive as the message below, on the screen the admin is
  // still looking at, with the level already where they put it: picking the
  // baseline again finishes the job and there is nothing to undo.
  //
  // WITH NO SECOND PRE-FLIGHT OF THAT CAPABILITY HERE, which has a consequence
  // worth stating rather than hiding: a non-admin holder of
  // players.consoleaccess.write who hand-crafts a POST carrying a baselineId gets
  // the level change plus this message, because nobody below admin can hold
  // `permissions.write`. Accepted, not prevented: a refusal here would be a
  // second enforcement point, which means a CAPABILITY_GATES entry and the
  // enforcement-point count that goes with it, and this is better than the silent
  // two-step it replaces either way. The picker is never drawn for them.
  if (baselineCapabilities !== null) {
    // AN `!result.ok` CHECK AND NOT A try/catch: setPlayerPermissions returns an
    // ActionResult and does not throw, unlike the applyPlayerPermissions call
    // inside clearComposition above.
    const result = await setPlayerPermissions(playerId, {
      role: 'custom',
      grants: baselineCapabilities,
      revokes: [],
      baselineId,
      reason,
    });
    if (!result.ok) {
      throw new ExpectedError(
        `Console access changed, but the baseline could not be applied: ${result.error}`,
      );
    }
  }

  // writeConsoleLevel revalidates /players and the member's own page; neither is
  // this one, and an executive moved to trainer never reaches
  // setPlayerPermissions above, so nothing else would refresh the list this was
  // changed from.
  revalidatePath('/permissions');
  revalidatePath('/dashboard');
}
