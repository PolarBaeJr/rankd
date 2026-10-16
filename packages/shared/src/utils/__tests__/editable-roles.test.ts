import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  baselineCapabilityRefusal,
  isBuiltinPermissionRole,
  resolvePermissions,
  shippedDefaultFor,
  BUILTIN_BASELINE_IDS,
  BUILTIN_PERMISSION_ROLES,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_ASSIGNABLE,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  PERMISSION_ROLES,
  PERMISSION_ROLE_LABELS,
  ROLE_DEFAULTS,
  type Capability,
} from '../access-level';

// EDITABLE BUILT-IN ROLES.
//
// The club owner asked to "edit the permissions of each preassigned role
// beforehand", and the case that prompted it was Finance seeing money IN as well
// as out. 00104 makes the four VP jobs SEEDED ROWS in permission_baselines, so
// the answer lives in the database and ROLE_DEFAULTS becomes the seed.
//
// WHAT THIS FILE PINS, and it is three separate things:
//
//   1. THE RESOLVER DID NOT MOVE. A built-in role is COPIED onto a person, the
//      same shape 00093 chose, so resolvePermissions() is untouched. Asserted
//      rather than asserted-about: the seeded sets are resolved and compared.
//
//   2. THE SEED AND THE CONSTANT AGREE. The migration is read as TEXT and
//      checked against ROLE_DEFAULTS and BUILTIN_BASELINE_IDS. Without this the
//      two drift and "reset to shipped default" restores something that was
//      never shipped — a silent, permanent lie in the one action whose whole
//      value is being trustworthy.
//
//   3. THE CEILING IS STILL A CEILING. EDITOR_OFFERABLE stopped being an alias
//      of the historic exec set so the owner's request is expressible at all;
//      this pins exactly how far it moved and, more importantly, what it still
//      refuses.
//
// The two invariants in capabilities.test.ts — every role inside the historic
// exec set, and the four partitioning it exactly — are NOT touched by this
// feature and are NOT relaxed. They survive because ROLE_DEFAULTS stopped being
// edited. The last describe() below says so in a form that fails if anybody
// edits it anyway.
//
// EVERY ASSERTION IN THIS FILE THAT NAMED EXEC_BASELINE NOW NAMES
// EXEC_ASSIGNABLE, AND NOT ONE OF THEM CHANGED WHAT IT CLAIMS. This file was
// written when EXEC_BASELINE was the historic 73 and EDITOR_OFFERABLE spread it;
// the baseline has since narrowed to twelve reads and the 73 moved, verbatim and
// in order, to EXEC_ASSIGNABLE, which is what EDITOR_OFFERABLE spreads now. So
// "the exec baseline" in each comment below meant "what an exec could already
// do", and that is the constant the assertions follow. Left pointing at the
// twelve, every one of them would have been a different and much weaker claim:
// "the ceiling adds 66 things" instead of "the ceiling adds five, named".

const MIGRATION = readFileSync(
  join(__dirname, '../../../../../supabase/migrations/00104_editable_builtin_roles.sql'),
  'utf8',
);

// THE SHIPPED DEFAULT IS A CHAIN, NOT A FILE, and 00224 is the first link past
// the seed: the owner asked for `announcements.discord.write` to be VP
// External's, and a built-in portfolio is a seeded ROW, so widening one is a
// migration. Reading only 00104 would now assert that ROLE_DEFAULTS is wrong.
//
// AMENDMENTS ARE LISTED, NOT GLOBBED. A test that swept the migrations
// directory for anything touching permission_baselines would keep passing while
// silently absorbing whatever the next migration did — which is the opposite of
// what reading the migration as text is for. Each link is added here by hand,
// by whoever writes it, which is the moment to think about it.
const AMENDMENTS: { role: string; adds: readonly string[]; sql: string }[] = [
  {
    role: 'external',
    adds: ['announcements.discord.write'],
    sql: readFileSync(
      join(__dirname, '../../../../../supabase/migrations/00224_vp_external_may_speak_in_discord.sql'),
      'utf8',
    ),
  },
];

/** What the migration CHAIN says a role ships with, sorted. */
function shippedByMigrations(role: string, seeded: string[]): string[] {
  const added = AMENDMENTS.filter((a) => a.role === role).flatMap((a) => [...a.adds]);
  return [...new Set([...seeded, ...added])].sort();
}

// ---------------------------------------------------------------------------
// THE CEILING
// ---------------------------------------------------------------------------
describe('EDITOR_OFFERABLE, now that it is not the exec baseline', () => {
  // The exec transcription must not move, and this is the local half of the
  // guard — capability-equivalence.test.ts derives the same list independently
  // from the call sites, which is the half that cannot be fooled by editing a
  // constant and its test together.
  //
  // IT WAS 73 FOR THE WHOLE OF THE TRANSCRIPTION'S LIFE, and 74 since the owner
  // put `announcements.discord.write` in VP External (00224). That is the ONLY
  // entry here that was not something an unrestricted exec could do the day
  // composition shipped, and it is here because a VP portfolio is by
  // construction a subset of this list — so "give VP External this capability"
  // and "this list never grows" could not both be kept, and the owner chose.
  //
  // WHAT DID NOT CHANGE IS THE THING THE OWNER'S RULE WAS ABOUT: EXEC_BASELINE,
  // the read-only floor, is still twelve. Nobody gained anything by being an
  // exec; one named job gained one capability by being given it. Asserting
  // `EXEC_BASELINE.length === 12` HERE would have pinned the floor while
  // claiming to guard the transcription, which is the substitution the next
  // assertion exists to catch — so both are pinned, separately.
  //
  // ...AND STILL 74 AFTER THE DATA API, which added four `accounts.*` strings
  // to CAPABILITIES and none of them here. A minted key reads the club's data
  // from outside every gate in the file and keeps doing so after the minter's
  // console is taken away, so minting is an admin act rather than an
  // assignable one. The floor does not move for any of that, which remains the
  // thing the owner's rule was about. It moved once, separately and on
  // purpose, for the expense write; see the assertion below.
  it('leaves the assignable set at the transcription plus the named addition', () => {
    expect(EXEC_ASSIGNABLE.length).toBe(74);
    // Named, so growing this list is a diff somebody reads rather than a number
    // somebody bumps.
    expect(EXEC_ASSIGNABLE).toContain('announcements.discord.write');
    // And the counterpart: a string that is a real capability, is held by
    // admins, and must never become assignable without somebody deciding so.
    expect(EXEC_ASSIGNABLE).not.toContain('accounts.apikey.mint.write');
  });

  // AND THE FLOOR, WHICH IS THE THING THAT DID MOVE, pinned next to it so the
  // two are read together. Nobody should be able to change one and have the
  // other's assertion cover for them.
  it('leaves the exec baseline a floor of thirteen holding one named write', () => {
    expect(EXEC_BASELINE.length).toBe(13);
    // Read-only until 2026-09-19. The owner asked for the expense write to
    // reach every officer rather than only the ones somebody remembered to
    // assign a baseline to, so the floor now carries exactly one write. Naming
    // it keeps this as strict as the empty array was.
    expect(EXEC_BASELINE.filter((c) => c.endsWith('.write'))).toEqual([
      'fees.expenses.add.write',
    ]);
  });

  it('contains the whole assignable set, so nothing composable was withdrawn', () => {
    const offerable = new Set<Capability>(EDITOR_OFFERABLE);
    for (const capability of EXEC_ASSIGNABLE) {
      expect(offerable.has(capability), capability).toBe(true);
    }
  });

  // THE WIDENING, NAMED. Four reads on /fees — the club's books, which is what
  // the owner asked Finance to be able to see — and one write since 00105. If
  // this list grows, this assertion is the diff somebody has to read.
  //
  // `announcements.discord.write` WAS BRIEFLY HERE and is not any more: 00223
  // shipped it admin-only, above the assignable set, and 00224 moved it into VP
  // External at the owner's request, which put it INSIDE that set. A capability
  // in both lists would be a duplicate in EDITOR_OFFERABLE, since the ceiling
  // is their union.
  //
  // THE SEVEN `page.access.*` KEYS JOINED IT, one per club feature switch: the
  // owner's "permission node for access to a restricted page". Here and not in
  // EXEC_ASSIGNABLE because they were never exec work, and that list is the
  // historic transcription the four VP roles partition exactly. They are spread
  // from the feature registry, and they are written out literally below anyway:
  // this list is what makes a new feature's key a diff somebody reads rather
  // than a ceiling that grew on its own. None of them is a write, so the
  // assertion further down that names the one added write did not move.
  it('adds exactly the four finance reads, the one admin-only write and the switched-off page keys', () => {
    // AGAINST EXEC_ASSIGNABLE, because "added" means "beyond what an exec could
    // already do". Measured against the narrowed floor instead, this list would
    // be 66 entries long and would stop being the reviewable diff it exists to
    // be — the six below would be lost among sixty-one writes that are not
    // widenings at all, merely capabilities that now arrive by assignment.
    const exec = new Set<Capability>(EXEC_ASSIGNABLE);
    const added = [...EDITOR_OFFERABLE].filter((capability) => !exec.has(capability));
    expect(added.sort()).toEqual([
      'fees.clubfees.read',
      'fees.netposition.read',
      'fees.otherincome.read',
      'fees.reinstatements.read',
      'page.access.announcements',
      'page.access.challenges',
      'page.access.events',
      'page.access.fees',
      'page.access.guest_waivers',
      'page.access.leaderboard',
      'page.access.membership',
      'page.access.my_stats',
      'page.access.predictions',
      'page.access.sessions',
      'page.access.socials',
      'page.access.tournaments',
      'players.consoleaccess.write',
    ]);
  });

  // THE MONEY WIDENING IS STILL READ-ONLY, which is the claim that assertion
  // used to make about the whole list and can no longer make about the whole
  // list. Seeing the books is not moving the money, and every `fees.*.write`
  // stayed out — so it is asserted where it is actually true, over the `fees`
  // half, rather than weakened into nothing.
  it('adds no fees WRITE, so seeing the books is not moving the money', () => {
    // EXEC_ASSIGNABLE for the same reason as above: `fees.expenses.add.write` is
    // historic exec work, not a widening, and against the floor it would fail
    // this assertion while nothing had actually been opened up.
    const exec = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const capability of EDITOR_OFFERABLE) {
      if (exec.has(capability)) continue;
      if (!capability.startsWith('fees.')) continue;
      expect(capability.endsWith('.read'), capability).toBe(true);
    }
  });

  // THE ONE WRITE, NAMED. The ceiling is what bounds an ADMIN, whom grant
  // closure cannot bound, so every write on this list is a thing an admin may
  // hand to somebody who is not one — which is why a second arriving here has
  // to be a diff somebody reads rather than a number that moved.
  //
  //   - players.consoleaccess.write (00105) — "also make role change a
  //     permission". It hands out a LEVEL, bounded by closure inside
  //     setConsoleAccess and refused outright for admin.
  it('adds exactly one write, and names it', () => {
    // EXEC_ASSIGNABLE: "one write" counts writes the CEILING added, and every
    // write an exec used to hold by default is still inside it.
    const exec = new Set<Capability>(EXEC_ASSIGNABLE);
    const writes = [...EDITOR_OFFERABLE].filter(
      (capability) => !exec.has(capability) && capability.endsWith('.write'),
    );
    expect(writes.sort()).toEqual(['players.consoleaccess.write']);
  });

  // THE ONES THAT STAY OUT, each named so opening it is deliberate. These are
  // the reason the ceiling was not simply deleted when it got in the way.
  it('still withholds permissions.write and the edge of the hard floor', () => {
    const offerable = new Set<Capability>(EDITOR_OFFERABLE);
    for (const capability of [
      // Editing a role to contain this would make "pick Finance from a
      // dropdown" hand over the ability to hand out permissions.
      'permissions.write',
      'permissions.page',
      // The grantable EDGE of the hard floor. The floor itself is unreachable
      // by construction; this is the nearest thing and stays per-person.
      'players.privilegedfields.write',
      // Destructive or identity-altering roster work.
      'players.remove.write',
      'players.merge.write',
      'players.discordlink.write',
      'players.deletion.cancel.write',
      'players.reliability.write',
      // Setting or moving money, as opposed to seeing it.
      'seasons.fees.write',
      'fees.clubfees.markpaid.write',
      'fees.clubfees.waive.write',
      'fees.otherincome.add.write',
      'fees.reinstatements.write',
      'fees.playerflags.write',
      'tournaments.fees.read',
      'tournaments.fees.markpaid.write',
      // Everything else that was admin work and was not asked for.
      'audit.page',
      'ratings.page',
      'accounts.page',
      // The data API's keys, withheld with the page they are minted from.
      'accounts.apikey.read',
      'accounts.apikey.mint.write',
      'accounts.apikey.revoke.write',
      'platform.page',
      'platform.settings.write',
      'legal.documents.write',
      'legal.waivertemplate.write',
      'challenges.page',
      'walkovers.page',
      'disputes.page',
      // Club events (00244): admin-only by level until the owner decides
      // otherwise, which would be a ROLE_DEFAULTS re-seed.
      'events.page',
      'events.signups.read',
      'events.signups.remove.write',
      'events.manage.create.write',
      'events.manage.update.write',
      'events.manage.cancel.write',
      'events.manage.delete.write',
    ] as Capability[]) {
      expect(offerable.has(capability), `${capability} became offerable`).toBe(false);
    }
  });

  it('is inside the vocabulary, with no duplicates', () => {
    expect(new Set(EDITOR_OFFERABLE).size).toBe(EDITOR_OFFERABLE.length);
    const all = new Set<string>(CAPABILITIES);
    for (const capability of EDITOR_OFFERABLE) expect(all.has(capability), capability).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE MOTIVATING EDIT
// ---------------------------------------------------------------------------
// The whole feature is worth nothing if the thing that prompted it is still
// refused, so it is asserted end to end through the real refusal function.
describe('teaching Finance to see money in as well as out', () => {
  const MONEY_IN: Capability[] = [
    'fees.page',
    'fees.expenses.read',
    'fees.expenses.add.write',
    'fees.clubfees.read',
    'fees.otherincome.read',
    'fees.netposition.read',
  ];

  it('is accepted for an admin, who holds everything', () => {
    const held = new Set<Capability>(CAPABILITIES);
    expect(baselineCapabilityRefusal(MONEY_IN, held)).toBeNull();
  });

  it('was refused before the ceiling moved, and the refusal is what moved', () => {
    // The old ceiling, reconstructed rather than remembered: EXEC_ASSIGNABLE is
    // what EDITOR_OFFERABLE used to be, and three of the six are outside it.
    //
    // IT IS THE ASSIGNABLE SET AND NOT THE FLOOR. The ceiling before 00104 was
    // the historic 73 — which is now EXEC_ASSIGNABLE and was then called
    // EXEC_BASELINE. Reconstructing it from today's twelve would put
    // `fees.expenses.add.write` in the refused list, and that capability was
    // never refused by the old ceiling: it is the one money write execs had.
    const oldCeiling = new Set<Capability>(EXEC_ASSIGNABLE);
    const wouldHaveBeenRefused = MONEY_IN.filter((c) => !oldCeiling.has(c));
    expect(wouldHaveBeenRefused.sort()).toEqual([
      'fees.clubfees.read',
      'fees.netposition.read',
      'fees.otherincome.read',
    ]);
  });

  // CLOSURE STILL BINDS, and it is the only thing binding a non-admin. An
  // officer who cannot see the club's books cannot write a role that shows them
  // to somebody else, however editable the role now is.
  it('is refused for an officer who does not hold the reads themselves', () => {
    const held = new Set<Capability>([
      'fees.page',
      'fees.expenses.read',
      'fees.expenses.add.write',
      'permissions.page',
      'permissions.write',
    ]);
    const refusal = baselineCapabilityRefusal(MONEY_IN, held);
    expect(refusal).toMatch(/you do not hold/i);
    expect(refusal).toContain('fees.clubfees.read');
  });

  // AND THE CEILING BINDS THE ADMIN, whom closure cannot. This is the case the
  // constant exists for.
  it('refuses permissions.write even from an admin who holds it', () => {
    const held = new Set<Capability>(CAPABILITIES);
    const refusal = baselineCapabilityRefusal(
      ['permissions.page', 'permissions.write'],
      held,
    );
    expect(refusal).toMatch(/admin-only/);
  });
});

// ---------------------------------------------------------------------------
// THE SEED
// ---------------------------------------------------------------------------
// Reads the migration as TEXT. The alternative — trusting that somebody kept
// two lists in step — is exactly what this feature cannot afford, because the
// seed is what "reset to shipped default" restores.
describe('00104 seeds what ROLE_DEFAULTS says', () => {
  /** The ARRAY[...] literal of the INSERT carrying this builtin_role. */
  function seededCapabilities(role: string): string[] {
    const marker = `'${role}'\n)`;
    const end = MIGRATION.indexOf(marker);
    expect(end, `no INSERT for ${role}`).toBeGreaterThan(-1);
    const block = MIGRATION.slice(0, end);
    const open = block.lastIndexOf('ARRAY[');
    const close = block.indexOf(']::TEXT[]', open);
    // Group 1 is non-null by construction: matchAll only yields matches, and
    // the pattern cannot match without capturing. Asserted rather than guarded
    // so a genuinely empty capture would still fail the assertion below.
    return [...block.slice(open + 'ARRAY['.length, close).matchAll(/'([^']+)'/g)].map(
      (m) => m[1]!,
    );
  }

  /** The id literal of the INSERT carrying this builtin_role. */
  function seededId(role: string): string {
    const end = MIGRATION.indexOf(`'${role}'\n)`);
    const block = MIGRATION.slice(0, end);
    const open = block.lastIndexOf('VALUES (');
    return block.slice(open).match(/'([0-9a-f-]{36})'/)![1]!;
  }

  it.each([...BUILTIN_PERMISSION_ROLES])('seeds %s with its shipped default', (role) => {
    expect(shippedByMigrations(role, seededCapabilities(role))).toEqual(
      [...ROLE_DEFAULTS[role]].sort(),
    );
  });

  // THE SEED ITSELF DID NOT MOVE, which is the half the chain above could
  // otherwise hide. 00104 is an APPLIED migration on production: if this ever
  // fails, somebody edited a file the database has already run, and the two
  // have silently disagreed ever since.
  it('leaves 00104 saying exactly what it said the day it was applied', () => {
    expect(seededCapabilities('external')).toEqual([
      'announcements.create.write',
      'announcements.delete.write',
      'announcements.page',
      'announcements.update.write',
      'legal.page',
      'legal.reacceptance.write',
    ]);
    // The other three have no amendment yet, so for them the seed and the
    // constant are still the same claim — asserted here so that stays true by
    // accident rather than by nobody looking.
    for (const role of ['finance', 'tournaments', 'internal'] as const) {
      expect(seededCapabilities(role)).toEqual([...ROLE_DEFAULTS[role]].sort());
    }
  });

  // EVERY AMENDMENT ACTUALLY WRITES WHAT IT CLAIMS. The list above is prose
  // until something reads the SQL, and an amendment that named a capability its
  // migration never stored would make "reset to shipped default" hand out
  // something no database has.
  it.each(AMENDMENTS)('$role amendment stores what it says it stores', ({ adds, sql }) => {
    for (const capability of adds) {
      expect(sql).toContain(`'${capability}'`);
    }
    // Appended, never rewritten: the row is editable and an overwrite would
    // discard whatever the club changed. This is the shape that guarantees it.
    expect(sql).toMatch(/capabilities\s*\|\|\s*ARRAY\[/);
    expect(sql).not.toMatch(/SET capabilities\s*=\s*ARRAY\[/);
  });

  it.each([...BUILTIN_PERMISSION_ROLES])('seeds %s under its pinned id', (role) => {
    expect(seededId(role)).toBe(BUILTIN_BASELINE_IDS[role]);
  });

  it.each([...BUILTIN_PERMISSION_ROLES])('seeds %s under its shown label', (role) => {
    const end = MIGRATION.indexOf(`'${role}'\n)`);
    const block = MIGRATION.slice(MIGRATION.slice(0, end).lastIndexOf('VALUES ('), end);
    expect(block).toContain(`'${PERMISSION_ROLE_LABELS[role]}'`);
  });

  // Four ids, four rows, no collisions — the reason a rename cannot lose one.
  it('gives the four distinct ids', () => {
    const ids = Object.values(BUILTIN_BASELINE_IDS);
    expect(new Set(ids).size).toBe(4);
  });

  // ON CONFLICT DO NOTHING, so re-applying the migration never silently undoes
  // an edit the owner made.
  it('never overwrites an edited row on re-application', () => {
    const inserts = MIGRATION.match(/INSERT INTO public\.permission_baselines/g) ?? [];
    expect(inserts.length).toBe(4);
    // The semicolon is what distinguishes the four STATEMENTS from the header
    // prose that explains why they are written this way.
    expect((MIGRATION.match(/ON CONFLICT \(id\) DO NOTHING;/g) ?? []).length).toBe(4);
    expect(MIGRATION).not.toMatch(/ON CONFLICT[^\n]*DO UPDATE/);
  });

  // shippedDefaultFor() is what reset() calls, so it has to be the same thing
  // the seed wrote and not a second reading of it.
  it.each([...BUILTIN_PERMISSION_ROLES])('resets %s to that same set', (role) => {
    expect([...shippedDefaultFor(role)].sort()).toEqual(
      shippedByMigrations(role, seededCapabilities(role)),
    );
  });
});

// ---------------------------------------------------------------------------
// THE RESOLVER
// ---------------------------------------------------------------------------
// The claim the whole design rests on: a built-in role is copied, not resolved
// through, so nothing about resolvePermissions() had to change. Asserted by
// running it.
describe('the resolver is untouched by this feature', () => {
  it.each([...BUILTIN_PERMISSION_ROLES])(
    'resolves a copied %s to exactly the set that was copied',
    (role) => {
      const copied = [...ROLE_DEFAULTS[role]].sort();
      // AT A REAL LEVEL, WITH THE FLOOR, because that is what a holder gets and
      // the claim being made is about holders. The equivalence is unaffected by
      // the floor — it lands identically on both sides — and asserting it at
      // `null` to keep the old literal would have tested a person who cannot
      // sign in.
      const resolved = resolvePermissions('exec', 'custom', copied, []);
      expect(resolved.kind).toBe('restricted');
      if (resolved.kind !== 'restricted') return;
      expect([...resolved.capabilities].sort()).toEqual(
        [...new Set<Capability>([...EXEC_BASELINE, ...copied])].sort(),
      );
      // ...and it is the same set the ROLE itself resolves to, which is the
      // equivalence 00104's data conversion actually rests on.
      const asRole = resolvePermissions('exec', role, [], []);
      if (asRole.kind !== 'restricted') return;
      expect([...resolved.capabilities].sort()).toEqual([...asRole.capabilities].sort());
    },
  );

  // THE EQUIVALENCE 00104's DATA CONVERSION RESTS ON, run rather than asserted
  // in prose. 'custom' has an empty base, so unioning the role's defaults into
  // the grants reproduces exactly what the role would have formed — which is why
  // rewriting today's holders moves nobody's access by one capability.
  it.each([...BUILTIN_PERMISSION_ROLES])(
    'gives a converted %s holder the identical set, extra grants and revokes included',
    (role) => {
      const extra = ['legal.page', 'legal.reacceptance.write'];
      const revokes = [...ROLE_DEFAULTS[role]].slice(0, 1);

      // BOTH SIDES AT THE SAME LEVEL, so the floor lands on both and the
      // equivalence is tested rather than the floor. Two different levels here
      // would make this pass or fail for a reason that has nothing to do with
      // the conversion.
      const asRole = resolvePermissions('exec', role, extra, revokes);
      const asCopy = resolvePermissions(
        'exec',
        'custom',
        [...new Set([...ROLE_DEFAULTS[role], ...extra])].sort(),
        revokes,
      );

      expect(asRole.kind).toBe('restricted');
      expect(asCopy.kind).toBe('restricted');
      if (asRole.kind !== 'restricted' || asCopy.kind !== 'restricted') return;
      expect([...asCopy.capabilities].sort()).toEqual([...asRole.capabilities].sort());
    },
  );

  // The widened ceiling did not teach the resolver a new rule either: a money
  // read still needs its area page, exactly like everything else.
  //
  // ASSERTED AT THE TRAINER LEVEL NOW, because that is where the rule is still
  // reachable. An exec's floor carries `fees.page`, so this grant is no longer
  // pruned for them — not because the invariant was relaxed, but because the
  // condition it catches ("holds something in an area they cannot open") cannot
  // arise for somebody who can open every section. A trainer's floor is the
  // roster and nothing else, so the rule fires there exactly as it always did.
  it('still prunes a widened capability whose area page is absent', () => {
    const resolved = resolvePermissions('trainer', 'custom', ['fees.netposition.read'], []);
    expect(resolved.kind).toBe('restricted');
    if (resolved.kind !== 'restricted') return;
    expect([...resolved.capabilities].sort()).toEqual([...TRAINER_BASELINE].sort());

    // ...and for an exec it survives, on the floor's own `fees.page`.
    const asExec = resolvePermissions('exec', 'custom', ['fees.netposition.read'], []);
    if (asExec.kind !== 'restricted') return;
    expect([...asExec.capabilities]).toContain('fees.netposition.read');
  });
});

// ---------------------------------------------------------------------------
// WHAT THE BUILT-INS ARE
// ---------------------------------------------------------------------------
describe('the four built-in roles', () => {
  it('are every permission role except the empty base', () => {
    expect([...BUILTIN_PERMISSION_ROLES].sort()).toEqual(
      PERMISSION_ROLES.filter((role) => role !== 'custom').sort(),
    );
  });

  it('narrows only those four, and refuses anything else', () => {
    for (const role of BUILTIN_PERMISSION_ROLES) {
      expect(isBuiltinPermissionRole(role), role).toBe(true);
    }
    for (const value of ['custom', '', null, undefined, 'admin', 'Finance']) {
      expect(isBuiltinPermissionRole(value), String(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// THE TWO INVARIANTS THAT WERE EXPECTED TO DIE
// ---------------------------------------------------------------------------
// The brief for this feature assumed a literal partition test could not survive
// roles becoming editable. It does, and the reason is the strongest evidence
// this design is the right shape: ROLE_DEFAULTS stopped being the runtime answer
// and became a frozen SEED, so the club's edits land in the table and the
// constant never moves.
//
// Both assertions live in capabilities.test.ts and are unchanged. They are
// restated here for one reason only: to fail loudly if somebody ever goes back
// to hand-editing the constant, because at that point the seed and the rows
// disagree and "reset to shipped default" starts lying.
describe('ROLE_DEFAULTS is a frozen seed, so its invariants still hold literally', () => {
  // BOTH RESTATEMENTS FOLLOW THE ORIGINALS TO EXEC_ASSIGNABLE. They exist to
  // fail if somebody hand-edits ROLE_DEFAULTS, and that job is unchanged; the
  // set they compare against is the same 73 under a new name. Pointing them at
  // the twelve would have made them assert that the four VP jobs hand out
  // nothing but reads, which is the opposite of what the roles are for.
  it('keeps every role inside what an exec may be assigned', () => {
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const role of PERMISSION_ROLES) {
      for (const capability of ROLE_DEFAULTS[role]) {
        expect(
          assignable.has(capability),
          `${role} seeds ${capability}, which no exec ever held`,
        ).toBe(true);
      }
    }
  });

  it('still partitions the assignable set exactly', () => {
    const fromRoles = PERMISSION_ROLES.flatMap((role) => [...ROLE_DEFAULTS[role]]);
    expect(new Set(fromRoles).size, 'two roles claim the same capability').toBe(fromRoles.length);
    expect([...fromRoles].sort()).toEqual([...EXEC_ASSIGNABLE].sort());
  });

  // AND THE PART THAT IS GENUINELY NEW. The security property those tests
  // carried — "picking a role from a dropdown cannot hand out something nobody
  // reviewed" — is no longer a property of a constant, because the club edits
  // the rows. It is enforced at WRITE TIME instead, and this is that enforcement
  // reached through the same function every write path calls.
  it('bounds an EDIT the way the constant used to bound a deploy', () => {
    const held = new Set<Capability>(CAPABILITIES);
    // An admin editing Finance to reach beyond the ceiling: refused.
    expect(
      baselineCapabilityRefusal(
        ['fees.page', 'fees.expenses.read', 'fees.playerflags.write'],
        held,
      ),
    ).toMatch(/admin-only/);
    // ...and to reach inside it: allowed, which is the feature.
    expect(
      baselineCapabilityRefusal(
        ['fees.page', 'fees.expenses.read', 'fees.netposition.read'],
        held,
      ),
    ).toBeNull();
  });
});
