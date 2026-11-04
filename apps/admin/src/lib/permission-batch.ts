// QUEUEING PERMISSION CHANGES FOR SEVERAL PEOPLE AND SAVING THEM TOGETHER.
//
// The editor used to hold one person's pending triple in three pieces of state,
// so picking somebody else threw the work away. This is the same triple, keyed
// by person, plus the two things a batch needs that a single save never did: a
// summary across everybody, and an ordering that refuses the whole batch rather
// than half-applying it.
//
// NOTHING HERE DECIDES WHETHER A SAVE IS ALLOWED. localRefusal() mirrors the
// checks setPlayerPermissions makes, so a batch that cannot land is refused
// before any of it is written — but the server resolves the actor's own set from
// the actor's own row and runs every one of those checks again, per call. This
// is the refusal arriving early, never the authority to skip it.
//
// Pure on purpose: the component around it is a thousand lines of tree and the
// parts worth pinning — who is dirty, what the counts add up to, and that a
// single refusal writes nothing — are the parts that do not need a DOM.
import {
  atLeast,
  effectiveCapabilities,
  resolvePermissions,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  PERMISSION_ROLES,
  ROLE_DEFAULTS,
  type AccessLevel,
  type Capability,
  type PermissionRole,
} from './permissions';

/** As much of the editor's PersonRow as the batch needs to read. */
export type BatchPerson = {
  id: string;
  name: string;
  level: AccessLevel | null;
  role: string | null;
  grants: string[];
  revokes: string[];
  /**
   * Which custom baseline (00093) the stored grants were copied from, or null.
   * PROVENANCE ONLY — nothing here resolves through it, and it changes nobody's
   * capabilities. It is in the batch because it is part of the ROW, and isDirty
   * asks whether the row would change.
   */
  baselineId?: string | null;
};

/** The stored triple as the editor would write it — one person's pending edit. */
export type Draft = {
  role: PermissionRole | null;
  grants: Capability[];
  revokes: Capability[];
  /**
   * Set only while the draft is still exactly what a baseline says. Every hand
   * edit clears it — see setCell and setAll in the editor — so a row can never
   * claim a baseline whose contents it no longer matches.
   *
   * OPTIONAL, and absent means null. Every Draft written before baselines
   * existed still type-checks and still means "hand-picked", which is what it
   * always meant.
   */
  baselineId?: string | null;
};

/**
 * The queue, keyed by player id.
 *
 * ONLY PEOPLE WHO HAVE BEEN TOUCHED APPEAR HERE, and that is load-bearing rather
 * than tidy. `isDirty` compares a draft filtered through this build's vocabulary
 * against the row as it is STORED, so seeding an entry for everybody would mark
 * anyone carrying a capability this build no longer knows as dirty on load — a
 * queued change nobody made. An absent key means "not touched", full stop.
 */
export type PendingEdits = Record<string, Draft>;

export type PendingEntry<P extends BatchPerson = BatchPerson> = {
  person: P;
  draft: Draft;
  gaining: Capability[];
  losing: Capability[];
  /** gaining + losing — what this edit changes about the PERSON, not the row. */
  changes: number;
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const KNOWN = new Set<string>(CAPABILITIES);

export const isKnownCapability = (value: string): value is Capability => KNOWN.has(value);

export const isPermissionRole = (value: string | null): value is PermissionRole =>
  (PERMISSION_ROLES as readonly string[]).includes(value ?? '');

/**
 * What a person's row says today, read through the vocabulary this build has.
 *
 * The deltas are filtered and the role is not recognised unless this build knows
 * it: a stored element the code no longer understands resolves to nothing
 * anyway, and the editor must not offer to re-save it as though it meant
 * something.
 */
export function draftOf(person: BatchPerson): Draft {
  const role = isPermissionRole(person.role) ? person.role : null;
  return {
    role,
    grants: person.grants.filter(isKnownCapability),
    revokes: person.revokes.filter(isKnownCapability),
    // Read through the seeded role for the same reason the deltas are read
    // through the vocabulary: the label only means anything on a hand-picked
    // row, so a build that does not recognise the role must not carry it.
    baselineId: role === 'custom' ? (person.baselineId ?? null) : null,
  };
}

/**
 * What they hold right now, from the row as it is STORED.
 *
 * Through the SEEDED role rather than the raw column, because the two resolve
 * differently: a role this build does not recognise gives no defaults, while no
 * role at all gives the level's whole baseline. The editor shows the seeded
 * reading, so the comparison it draws against has to be the same one.
 */
export function storedSet(person: BatchPerson): ReadonlySet<Capability> {
  return effectiveCapabilities(
    person.level,
    resolvePermissions(person.level, draftOf(person).role, person.grants, person.revokes),
  );
}

/** What they would hold if this draft were saved. */
export function draftSet(person: BatchPerson, draft: Draft): ReadonlySet<Capability> {
  return effectiveCapabilities(
    person.level,
    resolvePermissions(person.level, draft.role, draft.grants, draft.revokes),
  );
}

/**
 * DIFFERS FROM STORED, measured on the ROW.
 *
 * The row and the person can disagree — turning a level default into a
 * hand-picked set of exactly the same capabilities rewrites the row and changes
 * nothing about anybody — so this is the question "is there something to save",
 * and the counts below are the separate question "does it do anything".
 */
export function isDirty(person: BatchPerson, draft: Draft): boolean {
  const stored = draftOf(person);
  return (
    draft.role !== stored.role ||
    !sameSet(draft.grants, person.grants) ||
    !sameSet(draft.revokes, person.revokes) ||
    // The LABEL alone is a change worth saving even when the capabilities are
    // identical: a hand-picked set that happens to match a baseline and a set
    // that came FROM it behave differently the next time that baseline is
    // edited, and only the second one follows it.
    (draft.baselineId ?? null) !== (stored.baselineId ?? null)
  );
}

/**
 * Everybody with something queued, in the order the caller lists people.
 *
 * A person whose draft has been edited back to what is stored drops out here
 * rather than being deleted from the map on the way in: the editor writes a
 * draft on every click, and making each click ask "is this now identical to the
 * row" would put the answer in two places.
 */
export function pendingEntries<P extends BatchPerson>(
  people: readonly P[],
  pending: PendingEdits,
): PendingEntry<P>[] {
  const entries: PendingEntry<P>[] = [];
  for (const person of people) {
    const draft = pending[person.id];
    if (!draft || !isDirty(person, draft)) continue;
    const before = storedSet(person);
    const after = draftSet(person, draft);
    const gaining = [...after].filter((capability) => !before.has(capability));
    const losing = [...before].filter((capability) => !after.has(capability));
    entries.push({ person, draft, gaining, losing, changes: gaining.length + losing.length });
  }
  return entries;
}

export function totalChanges(entries: readonly PendingEntry[]): number {
  return entries.reduce((total, entry) => total + entry.changes, 0);
}

/** The queue with these people taken out of it — what a successful save leaves. */
export function dropPending(pending: PendingEdits, ids: readonly string[]): PendingEdits {
  const drop = new Set(ids);
  return Object.fromEntries(Object.entries(pending).filter(([id]) => !drop.has(id)));
}

/**
 * The triple as setPlayerPermissions would STORE it.
 *
 * Local refusals have to be measured on this and not on the draft: the server
 * clears both deltas when no role is set, de-duplicates them, and drops a grant
 * the role already gives before any closure check runs. Checking the raw draft
 * instead would refuse batches the server would have accepted.
 */
export function normalise(draft: Draft): Draft {
  if (draft.role === null) return { role: null, grants: [], revokes: [], baselineId: null };
  const roleBase = ROLE_DEFAULTS[draft.role] as readonly Capability[];
  return {
    role: draft.role,
    grants: [...new Set(draft.grants)].sort().filter((capability) => !roleBase.includes(capability)),
    revokes: [...new Set(draft.revokes)].sort(),
    // A label survives only on 'custom', matching the CHECK in 00093 and the
    // refusal in setPlayerPermissions. Any other role has defaults beneath the
    // grants, so a label would be describing part of the set.
    baselineId: draft.role === 'custom' ? (draft.baselineId ?? null) : null,
  };
}

export type Actor = {
  id: string;
  /** The actor's own resolved set, as the SERVER resolved it. */
  held: ReadonlySet<Capability>;
};

/**
 * Why this queued edit could not be saved, or null.
 *
 * A TRANSCRIPTION OF setPlayerPermissions' checks, in its order, and it is
 * deliberately a second copy rather than a shared function: the server's copy
 * runs against the actor's row and is the boundary, and a shared helper would
 * invite somebody to trust this one. Kept here so a batch of five is refused
 * whole, naming the person who cannot land, instead of writing two and stopping.
 *
 * Phrased for the admin reading it beside a name, so it starts lower-case and
 * carries no subject.
 */
export function localRefusal(person: BatchPerson, draft: Draft, actor: Actor): string | null {
  if (person.id === actor.id) return 'you cannot change your own permissions';
  if (person.level === null) return 'they have no console access, so there is nothing to store';
  if (atLeast(person.level, 'admin')) {
    return 'admins hold every capability by level, so nothing stored would be consulted';
  }

  const stored = normalise(draft);

  const bothWays = stored.grants.filter((capability) => stored.revokes.includes(capability));
  if (bothWays.length > 0) return `granted and revoked at once: ${bothWays.join(', ')}`;

  const missing = (wanted: readonly Capability[]) =>
    wanted.filter((capability) => !actor.held.has(capability));

  const cannotGrant = missing(stored.grants);
  if (cannotGrant.length > 0) return `you do not hold ${cannotGrant.join(', ')}`;

  const cannotRevoke = missing(stored.revokes);
  if (cannotRevoke.length > 0) return `you do not hold ${cannotRevoke.join(', ')}`;

  // WHO MAY EDIT WHOM, before the change and again on the result. The second is
  // the one a click can reach that nothing else catches: picking a named role
  // replaces the base wholesale, and its defaults are not grants, so neither
  // delta check above has looked at them.
  const outOfReach = missing([...storedSet(person)]);
  if (outOfReach.length > 0) return `they already hold ${outOfReach.join(', ')}, which you do not`;

  const wouldExceed = missing([...draftSet(person, stored)]);
  if (wouldExceed.length > 0) return `that would give them ${wouldExceed.join(', ')}, which you do not hold`;

  const offerable = new Set<Capability>(EDITOR_OFFERABLE);
  const notOfferable = stored.grants.filter((capability) => !offerable.has(capability));
  if (notOfferable.length > 0) return `${notOfferable.join(', ')} is admin-only and cannot be handed out`;

  return null;
}

export type WriteOutcome = { ok: true } | { ok: false; error: string };

export type BatchResult = {
  /** Ids written, in order. */
  saved: string[];
  /** Written and refused BY THE SERVER — these stay queued. */
  failed: { id: string; error: string }[];
  /** Refused before anything was written. Non-empty means `saved` is empty. */
  refused: { id: string; error: string }[];
};

/**
 * VALIDATE EVERYONE, THEN WRITE EVERYONE — and never the other way round.
 *
 * A batch that half-applies is worse than one that refuses: the admin is left
 * not knowing what landed, on the one screen where "what landed" is the whole
 * question. So a single local refusal writes nothing at all, which is the same
 * promise the single-person save has always made, held one level up.
 *
 * IT IS STILL N CALLS, NOT A TRANSACTION, and that is not hidden. The writes are
 * sequential — each one revalidates and writes its own audit row — and if the
 * third of five is refused by the server despite passing here, the first two are
 * already written and cannot be taken back. The honest handling is to run the
 * rest anyway, report exactly which landed and which did not, and leave the
 * failures queued; stopping at the first would add an arbitrary prefix to the
 * list of things the admin has to work out.
 */
export async function saveBatch<T extends { id: string }>(
  entries: readonly T[],
  handlers: {
    validate: (entry: T) => string | null;
    write: (entry: T) => Promise<WriteOutcome>;
  },
): Promise<BatchResult> {
  const refused: BatchResult['refused'] = [];
  for (const entry of entries) {
    const reason = handlers.validate(entry);
    if (reason !== null) refused.push({ id: entry.id, error: reason });
  }
  if (refused.length > 0) return { saved: [], failed: [], refused };

  const saved: string[] = [];
  const failed: BatchResult['failed'] = [];
  for (const entry of entries) {
    const outcome = await handlers.write(entry);
    if (outcome.ok) saved.push(entry.id);
    else failed.push({ id: entry.id, error: outcome.error });
  }
  return { saved, failed, refused };
}
