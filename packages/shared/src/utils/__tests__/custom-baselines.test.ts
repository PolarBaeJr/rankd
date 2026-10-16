import { describe, it, expect } from 'vitest';
import {
  baselineCapabilityRefusal,
  baselineNameRefusal,
  effectiveCapabilities,
  normaliseBaselineCapabilities,
  resolvePermissions,
  BASELINE_NAME_MAX,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_ASSIGNABLE,
  EXEC_BASELINE,
  ROLE_DEFAULTS,
  TRAINER_BASELINE,
  UNRESTRICTED,
  type Capability,
} from '../access-level';

// THE RULES A STORED BASELINE HAS TO SATISFY.
//
// A custom baseline is COPIED onto a row rather than resolved through, so every
// property this file pins is a property of the array as it is written down.
// That is the whole reason these checks can exist at all: on a player row the
// same questions are about the RESOLVED set, after revokes, and no check on the
// stored columns can see them.

const held = (...capabilities: Capability[]) => new Set<Capability>(capabilities);
const ALL = new Set<Capability>(CAPABILITIES);
// AN AUTHOR WHOSE OWN SET IS THE HISTORIC EXEC ONE. Deliberately
// EXEC_ASSIGNABLE and not EXEC_BASELINE: this stands in for a fully-composed
// officer in the closure tests below, and the narrowed floor would make that a
// twelve-capability author who is refused almost everything — which would still
// pass, vacuously, while testing nothing about where the line falls.
const EXEC = new Set<Capability>(EXEC_ASSIGNABLE);

describe('naming a baseline', () => {
  it('refuses an empty name, and a name of nothing but space', () => {
    expect(baselineNameRefusal('')).toMatch(/needs a name/);
    expect(baselineNameRefusal('   ')).toMatch(/needs a name/);
  });

  it('refuses a name longer than the column allows', () => {
    expect(baselineNameRefusal('x'.repeat(BASELINE_NAME_MAX))).toBeNull();
    expect(baselineNameRefusal('x'.repeat(BASELINE_NAME_MAX + 1))).toMatch(/at most/);
  });

  // Measured on the TRIMMED name, because that is what the unique index is
  // built on and what the row will hold.
  it('measures the trimmed name', () => {
    expect(baselineNameRefusal(`  ${'x'.repeat(BASELINE_NAME_MAX)}  `)).toBeNull();
  });

  it('accepts an ordinary club job', () => {
    expect(baselineNameRefusal('Socials VP')).toBeNull();
  });
});

describe('what may go in a baseline', () => {
  it('accepts a set an admin holds', () => {
    expect(baselineCapabilityRefusal(['fees.page', 'fees.expenses.add.write'], ALL)).toBeNull();
  });

  it('refuses a string the vocabulary does not have', () => {
    expect(baselineCapabilityRefusal(['fees.page', 'fees.everything'], ALL))
      .toMatch(/fees\.everything/);
  });

  it('refuses an empty baseline — a name that does nothing', () => {
    expect(baselineCapabilityRefusal([], ALL)).toMatch(/at least one capability/);
  });

  // ------------------------------------------------------------------
  // GRANT CLOSURE, at authoring time
  // ------------------------------------------------------------------
  it('refuses a capability the author does not hold', () => {
    const author = held('players.page', 'players.read');
    const refusal = baselineCapabilityRefusal(
      ['players.page', 'players.read', 'players.ban.write'],
      author,
    );
    expect(refusal).toMatch(/players\.ban\.write/);
    expect(refusal).toMatch(/do not hold it/);
  });

  it('lets an author write down exactly what they hold', () => {
    const author = held('players.page', 'players.read', 'players.ban.write');
    expect(baselineCapabilityRefusal([...author], author)).toBeNull();
  });

  // The property in general rather than on one example: for every capability an
  // exec baseline holder lacks, a baseline containing it is refused.
  it('refuses every capability outside the author, one at a time', () => {
    for (const capability of CAPABILITIES) {
      if (EXEC.has(capability)) continue;
      const refusal = baselineCapabilityRefusal(
        ['players.page', capability],
        EXEC,
      );
      expect(refusal, `${capability} was allowed into an exec's baseline`).not.toBeNull();
    }
  });

  // ------------------------------------------------------------------
  // THE CEILING, which closure cannot supply
  // ------------------------------------------------------------------
  // An admin holds everything by level, so closure never bites for them. Without
  // the EDITOR_OFFERABLE cap an admin could author a baseline containing
  // permissions.write, which setPlayerPermissions would then refuse to assign —
  // an authorable, unassignable baseline with no explanation on either screen.
  it('caps an admin at the ceiling, above which even they cannot author', () => {
    expect(baselineCapabilityRefusal(['permissions.page', 'permissions.write'], ALL))
      .toMatch(/admin-only/);
    expect(baselineCapabilityRefusal(['audit.page'], ALL)).toMatch(/admin-only/);
  });

  it('accepts anything inside the ceiling for an admin', () => {
    expect(baselineCapabilityRefusal([...EDITOR_OFFERABLE], ALL)).toBeNull();
  });

  // ------------------------------------------------------------------
  // THE PAGE INVARIANT
  // ------------------------------------------------------------------
  // The quiet failure this exists to prevent: a baseline that saves, assigns and
  // audits, and hands out nothing.
  it('refuses a capability whose area page is missing', () => {
    expect(baselineCapabilityRefusal(['fees.expenses.add.write'], ALL))
      .toMatch(/fees\.page/);
  });

  it('names every missing page once', () => {
    const refusal = baselineCapabilityRefusal(
      ['fees.expenses.add.write', 'fees.expenses.read', 'sessions.create.write'],
      ALL,
    );
    expect(refusal).toMatch(/fees\.page/);
    expect(refusal).toMatch(/sessions\.page/);
    expect(refusal!.match(/fees\.page/g)!.length).toBe(1);
  });

  // The invariant stated as the thing it is FOR: anything this function accepts
  // survives the resolver intact. A baseline is copied into permission_grants
  // against the empty 'custom' base.
  //
  // "EXACTLY ITSELF" BECAME "ITSELF, PLUS THE LEVEL'S FLOOR", and the property
  // this test exists for is the survival half rather than the equality. The club
  // owner ruled that "all roles should have the baseline", and a hand-picked
  // baseline is a role in every sense the editor presents — it sits in the same
  // "Starts from" select as the four VP jobs — so a floor goes under it too. The
  // thing that would be a bug is a baseline that saves, assigns, audits and
  // hands out LESS than it says; that is asserted first and separately below.
  //
  // THE PAGE REQUIREMENT IN baselineCapabilityRefusal IS NOT RELAXED TO MATCH,
  // and that is deliberate rather than an oversight. An exec's floor supplies
  // every section page, so for them the check is now stricter than it needs to
  // be — but the same stored baseline can be assigned to a TRAINER, whose floor
  // is the roster and nothing else, and there the page is genuinely required.
  // A check that consulted the assignee's level would be a check whose answer
  // depended on somebody the author has not chosen yet.
  it('everything it accepts resolves to itself, with the floor underneath', () => {
    const cases: Capability[][] = [
      ['fees.page', 'fees.expenses.read', 'fees.expenses.add.write'],
      ['players.page', 'players.read', 'players.approve.write'],
      ['sessions.page', 'sessions.attendance.write', 'legal.page', 'legal.reacceptance.write'],
      [...EDITOR_OFFERABLE],
    ];
    for (const capabilities of cases) {
      expect(baselineCapabilityRefusal(capabilities, ALL)).toBeNull();

      // NOTHING AUTHORED IS EVER LOST — the half that actually matters, and it
      // is asserted at every level a baseline can be assigned at.
      for (const level of ['exec', 'trainer', null] as const) {
        const resolved = resolvePermissions(level, 'custom', capabilities, []);
        expect(resolved.kind).toBe('restricted');
        const set = resolved.kind === 'restricted' ? resolved.capabilities : new Set();
        for (const capability of capabilities) {
          expect([...set], `${level}: ${capability}`).toContain(capability);
        }
      }

      // ...and the whole answer is the authored set unioned with that level's
      // floor, and not one capability more.
      const asExec = resolvePermissions('exec', 'custom', capabilities, []);
      const execSet = asExec.kind === 'restricted' ? asExec.capabilities : new Set();
      expect([...execSet].sort()).toEqual(
        [...new Set<Capability>([...EXEC_BASELINE, ...capabilities])].sort(),
      );

      // With no level there is no floor, so the original equality still holds
      // exactly where it was always a statement about the ARRAY.
      const bare = resolvePermissions(null, 'custom', capabilities, []);
      const bareSet = bare.kind === 'restricted' ? bare.capabilities : new Set();
      expect([...bareSet].sort()).toEqual([...new Set(capabilities)].sort());
    }
  });

  // THE HAND-PICKED PERSON NOW HOLDS TWELVE READS THEY DID NOT BEFORE, because
  // ROLE_DEFAULTS.custom is [] and a floor under an empty base is the floor.
  // That is the owner's ruling read literally, and it is the right answer: the
  // empty base exists so a hand-picked SET is storable, not so that choosing
  // "Hand-picked" is a way of taking somebody's reads away — which is what it
  // silently was, and the one option in the editor that quietly did more than
  // its name.
  it('gives a hand-picked person the floor, because custom is an empty BASE and not an empty SET', () => {
    expect(ROLE_DEFAULTS.custom).toEqual([]);
    const resolved = resolvePermissions('exec', 'custom', [], []);
    const set = resolved.kind === 'restricted' ? resolved.capabilities : new Set();
    expect([...set].sort()).toEqual([...EXEC_BASELINE].sort());
  });

  // ------------------------------------------------------------------
  // THE HARD FLOOR
  // ------------------------------------------------------------------
  // role, is_exec, is_trainer and the three permission_* columns are refused
  // below admin under all circumstances by assertPlayerFieldAccess, which is
  // what stands in front of updatePlayer() — see player-field-access.ts. A
  // baseline is a set of capabilities, so it cannot name a column at all; this
  // is that fact as an assertion, in the file where somebody adding a capability
  // for "granting exec" would look.
  //
  // SOMEBODY DID ADD ONE (00105, `players.consoleaccess.write`) AND THIS STILL
  // HOLDS, which is the interesting part. That capability is not a licence to
  // write a column: it is read by ONE action, setConsoleAccess, which
  // closure-checks the target's whole capability set before and after the change
  // and still requires admin BY LEVEL to touch the admin level in either
  // direction. updatePlayer's guard did not move, so the member Edit dialog
  // reaches none of these columns below admin, exactly as before. A baseline
  // that named a column would be something else entirely, and cannot exist.
  it('no capability in the vocabulary names a hard-floor column', () => {
    const floor = [
      'role',
      'is_exec',
      'is_trainer',
      'permission_role',
      'permission_grants',
      'permission_revokes',
      'permission_baseline_id',
    ];
    for (const capability of CAPABILITIES) {
      for (const column of floor) {
        expect(
          capability.includes(column),
          `${capability} reads as a grant of ${column}`,
        ).toBe(false);
      }
    }
  });

  // And the floor stated the other way: a baseline holding EVERY capability the
  // ceiling allows still resolves to a set that changes nobody's level. The two
  // markers that decide a level are not in the vocabulary, so the widest
  // possible baseline leaves accessLevelFor() with nothing to read.
  //
  // THE CEILING STOPPED BEING THE EXEC BASELINE when the four VP jobs became
  // editable (00104): the club owner wanted a treasurer who can see the club's
  // books, which no exec can. So the widest baseline is the exec baseline PLUS
  // four finance reads, since 00105 plus `players.consoleaccess.write`, and
  // since 00223 plus `announcements.discord.write` —
  // asserted as a derivation from EDITOR_OFFERABLE rather than a fresh list, so
  // this test says "the ceiling is the ceiling" instead of pinning the same
  // numbers twice.
  //
  // THAT LAST ADDITION IS WHY THE ASSERTION BELOW MATTERS MORE THAN IT DID. The
  // widest baseline now contains the capability that hands out a LEVEL, and the
  // claim being made is still that composing somebody with it leaves
  // accessLevelFor() with nothing to read: a capability set is not a level, and
  // the person holding it has to go through setConsoleAccess — closure-checked,
  // audited, and refused outright for the admin level — to move anybody.
  it('the widest baseline the ceiling allows is the ceiling, and no more', () => {
    const widest = normaliseBaselineCapabilities([...EDITOR_OFFERABLE]);
    expect(baselineCapabilityRefusal(widest, ALL)).toBeNull();

    // A trainer composed with it holds exactly the ceiling — a widening,
    // deliberately, and bounded by it. Never more.
    const composed = effectiveCapabilities(
      'trainer',
      resolvePermissions('trainer', 'custom', widest, []),
    );
    expect([...composed].sort()).toEqual([...EDITOR_OFFERABLE].sort());

    // AND STILL BOUNDED BY SOMETHING NAMED. The point of the old assertion was
    // that the widest composition is a set somebody enumerated, not "everything"
    // — so it is restated as the gap: the four finance reads and, since 00105,
    // the console-access write. Nothing else.
    //
    // `announcements.discord.write` is NOT in this gap, and that is the change
    // 00224 made: it shipped above the assignable set in 00223 and moved INSIDE
    // it when the owner gave it to VP External, so it is no longer something
    // the ceiling adds — it is something an admin may hand out.
    //
    // MEASURED AGAINST EXEC_ASSIGNABLE, NOT THE FLOOR. "The gap" means what the
    // ceiling added beyond what an exec could already do; the narrowed baseline
    // would make it sixty-seven entries and this assertion would stop naming the
    // five capabilities somebody actually enumerated, which is its whole job.
    //
    // THIRTEEN NOW: the eight `page.access.*` keys to switched-off features
    // joined the ceiling, one per club feature switch (`page.access.events`
    // arrived with club events in 00244). They are enumerated below for
    // the same reason the five are, even though the ceiling spreads them from
    // the feature registry: a new feature's key should be a line somebody reads.
    const beyond = [...composed].filter(
      (capability) => !(EXEC_ASSIGNABLE as readonly Capability[]).includes(capability),
    );
    expect(beyond.sort()).toEqual([
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

    // ...and an uncomposed trainer is untouched by any of this.
    expect([...effectiveCapabilities('trainer', UNRESTRICTED)].sort())
      .toEqual([...TRAINER_BASELINE].sort());

    // NOR IS AN UNCOMPOSED EXEC, WHICH IS NOW A MUCH SMALLER CLAIM AND WORTH
    // MAKING HERE. The widest thing an admin may author is 78 capabilities; the
    // most an officer holds without anybody authoring anything is twelve reads.
    // The gap between those two numbers is the whole of this change.
    expect([...effectiveCapabilities('exec', UNRESTRICTED)].sort())
      .toEqual([...EXEC_BASELINE].sort());
  });
});

describe('storing a baseline', () => {
  it('de-duplicates and sorts', () => {
    expect(normaliseBaselineCapabilities([
      'fees.page',
      'fees.expenses.read',
      'fees.page',
    ])).toEqual(['fees.expenses.read', 'fees.page']);
  });
});
