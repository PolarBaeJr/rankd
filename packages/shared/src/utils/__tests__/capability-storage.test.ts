import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, PERMISSION_ROLES } from '../access-level';

// REMOVAL IS A MIGRATION, made self-enforcing.
//
// The vocabulary CHECK pins every capability string, and that constraint is
// there for the REVOKES. An unknown element in `grants` is
// harmless — the resolver drops it and nobody gains anything. An unknown
// element in `revokes` is the opposite: it fails to REMOVE something, and the
// something it fails to remove might be permissions.write. So deleting a
// capability from the code while a stored revoke still names it is the one way
// this model can widen a person by accident.
//
// A CHECK is not re-validated when code changes, so the constraint cannot catch
// that on its own. What catches it is this test: the two lists have to agree, so
// a capability cannot be added or removed without the migration that adds it to
// the constraint — or, for a removal, the UPDATE that strips it from every
// stored array.
//
// Reading the SQL as text is crude and it is the point. Anything cleverer would
// be a THIRD place the vocabulary is written down.

const MIGRATIONS = join(__dirname, '../../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

/** The single-quoted strings inside the first ARRAY[…] literal after a marker. */
function arrayLiteralAfter(sql: string, marker: string): string[] {
  const from = sql.indexOf(marker);
  if (from === -1) throw new Error(`marker not found: ${marker}`);
  const open = sql.indexOf('ARRAY[', from);
  const close = sql.indexOf(']', open);
  return [...sql.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('the migrations and the vocabulary', () => {
  const sql = migration('00087_');
  // THE VOCABULARY CHECK KEEPS MOVING, so the assertion follows it and nothing
  // else does. 00087 pinned 113 strings; 00088 renamed fourteen of them to
  // `<area>.page` and added two, reaching 115; 00089 adds `players.read` and
  // reaches 116. Each drops the constraint and re-adds it, so the LATEST one is
  // the only one whose list is live. The role list and the privilege guard still
  // live in 00087, which is applied on staging and is not edited, and pointing
  // them anywhere else would fail on a missing marker rather than on a real
  // disagreement.
  // ...00097 adds `tournaments.draw.waivers.read`, reaching 117, 00098 adds
  // `tournaments.draw.entrycounts.read`, reaching 118, 00105 adds
  // `players.consoleaccess.write`, reaching 119, 00223 adds
  // `announcements.discord.write`, reaching 120, and 00232 adds
  // `players.discordlink.write`, reaching 121, and 00238 adds the data API's
  // three `accounts.apikey.*` keys, reaching 124, and 00243 adds the seven
  // `page.access.*` keys to switched-off features, reaching 131, and 00244
  // adds the club events keys, reaching 139, and 00247 adds the membership and
  // socials switch keys, reaching 141, and 00254 adds the guest waivers switch
  // key, reaching 142, and 00256 adds the audit export's `audit.export.read`
  // and `audit.signins.read`, reaching 144, and 00282 adds the predictions
  // switch key, reaching 145, and 00286 adds Club changes' `changelog.page`
  // and `changelog.post.write`, reaching 147. THE LIVE LIST IS THE LAST ONE,
  // and only the last one.
  const vocabularySql = migration('00286_');
  // 00286 again, under a content name, for the same reason 00247 has one.
  const clubChangesVocabularySql = migration('00286_');
  // 00282, under a content name. It was `vocabularySql` until 00286 landed.
  const predictionsVocabularySql = migration('00282_');
  // 00256, under a content name. It was `vocabularySql` until 00282 landed.
  const auditExportVocabularySql = migration('00256_');
  // 00254, under a content name, for the same reason 00247 has one. It was
  // `vocabularySql` until 00256 landed.
  const guestWaiversVocabularySql = migration('00254_');
  // 00247 again, under a content name, for the same reason 00244 has one.
  const membershipSocialsVocabularySql = migration('00247_');
  // 00244 again, under a content name, for the same reason 00243 has one.
  const clubEventsVocabularySql = migration('00244_');
  // 00243 again, under a content name, so the hop and the admit test for it
  // keep comparing 00243 when the pointer above moves on to the next file.
  const switchedOffPagesVocabularySql = migration('00243_');
  // 00238, under a content name for the same reason 00232 has one below. It
  // was `vocabularySql` until 00243 landed.
  const dataApiVocabularySql = migration('00238_');
  // 00232, under a content name because the comment two links down promised the
  // relative names would stop growing and this is the first addition since. It
  // was `vocabularySql` until 00238 landed.
  const discordLinkVocabularySql = migration('00232_');
  // THE LINK THAT USED TO BE LIVE, pinned under a name taken from what it
  // CONTAINS rather than from how far back it sits. The `prev`/`prior` names
  // below say only how many hops from the front a file is, so every addition
  // wants to shift all of them by one, and a shifted name is exactly how a hop
  // changes which pair it compares while still reading as though it checked the
  // old one. A content name never has to move, so this is the last relative
  // name this chain grows.
  const discordSayVocabularySql = migration('00223_');
  // The previous link stays pinned under its own name rather than being
  // overwritten by the pointer above. If `vocabularySql` simply moved on, the
  // hop that used to be asserted would silently become a longer one and the
  // link in between would stop being checked at all — the chain would still look
  // unbroken while having a gap in it. So each hop keeps its own name and each
  // gets its own assertion.
  const prevVocabularySql = migration('00105_');
  // ...and the one before that, for the same reason. This was
  // `prevVocabularySql` until 00223 landed.
  const priorVocabularySql = migration('00098_');
  // The RENAME lives in 00088 and stays pinned there. Following it forward
  // would look like it still passed while quietly checking nothing: no later
  // migration renames anything, so `dropped` would be empty and the mapping
  // assertion would never run again.
  const renameSql = migration('00088_');
  // 00089 stays pinned for the same reason, in the other direction. Its own
  // "purely additive, therefore no rewrite of stored arrays" claim is asserted
  // below against 00088; moving this pointer to 00097 would silently retire that
  // assertion instead of extending it. 00097 makes the same claim and gets its
  // own assertion, chained off this one.
  const additiveSql = migration('00089_');

  it('pins exactly the capabilities this build has', () => {
    const stored = arrayLiteralAfter(vocabularySql, 'players_permission_vocabulary_check');
    expect(stored.length).toBe(CAPABILITIES.length);
    expect([...stored].sort()).toEqual([...CAPABILITIES].sort());
  });

  // Every capability 00087 pinned and 00088 does not is a string that may still
  // be sitting in somebody's stored revokes, and a revoke that stops naming a
  // capability the code has is a revoke that silently stops biting. So a removal
  // has to be a RENAME with a mapping, and this is the assertion that there is
  // one for each — the exact hazard 00087's header describes, tested rather than
  // described.
  it('maps every capability 00087 had and 00088 does not', () => {
    const before = arrayLiteralAfter(sql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(renameSql, 'players_permission_vocabulary_check'));
    const dropped = before.filter((capability) => !after.has(capability));
    expect(dropped.length, 'nothing was renamed — check the marker').toBeGreaterThan(0);
    for (const capability of dropped) {
      expect(
        renameSql.includes(`('${capability}',`),
        `${capability} left the vocabulary with no rename in 00088`,
      ).toBe(true);
    }
  });

  // ...and 00089 is where that rule is tested in the other direction. Its header
  // claims it needs no rewrite of the stored arrays BECAUSE it removes nothing,
  // and this is that claim as an assertion rather than a sentence: a purely
  // additive migration is the only kind that may skip the UPDATE step, so the day
  // somebody drops a string here without one, the file's own reasoning fails
  // with it.
  it('removes nothing in 00089, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(renameSql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(additiveSql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // 00097 makes the same claim as 00089 and is held to it the same way, chained
  // off the previous link rather than jumping back to 00088 — so the chain from
  // the last RENAME to the live list is unbroken, and every hop in it is
  // asserted to remove nothing.
  it('removes nothing in 00097 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(additiveSql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(priorVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // ...nor in 00098, the next link.
  it('removes nothing in 00098 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(priorVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(prevVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // ...nor in 00105, which adds `players.consoleaccess.write`. Every hop from
  // the last RENAME (00088) to the live list is asserted individually: 00088 ->
  // 00089 -> 00097 -> 00098 -> 00105 -> 00223 -> 00232 -> 00238 -> 00243 -> 00244
  // -> 00247 -> 00254 -> 00256 -> 00282. Adding one means adding a hop here, which is
  // the price of the chain staying a chain.
  it('removes nothing in 00223 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(prevVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(discordSayVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // ...nor in 00232. This is the hop the pointer move would otherwise have
  // swallowed: `vocabularySql` used to mean 00232, so without a name of its own
  // 00223 would have stopped being compared to anything, and the test above
  // would have compared 00105 straight past it while its name still said 00223.
  it('removes nothing in 00232 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(discordSayVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(discordLinkVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // ...nor in 00238.
  it('removes nothing in 00238 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(discordLinkVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(dataApiVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // ...nor in 00243.
  it('removes nothing in 00243 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(dataApiVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(switchedOffPagesVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // THE SEVEN KEYS 00243 IS FOR, one per club feature switch, written out
  // rather than read off the registry: a feature added later brings its own
  // migration and its own test beside this one, and this one keeps saying what
  // 00243 did. The set-equality at the top is what fails for a feature whose
  // key no migration has admitted yet.
  it('admits the switched-off page keys, which is what 00243 is for', () => {
    const before = new Set(arrayLiteralAfter(dataApiVocabularySql, 'players_permission_vocabulary_check'));
    const after = new Set(arrayLiteralAfter(switchedOffPagesVocabularySql, 'players_permission_vocabulary_check'));
    for (const capability of [
      'page.access.sessions',
      'page.access.challenges',
      'page.access.tournaments',
      'page.access.leaderboard',
      'page.access.my_stats',
      'page.access.announcements',
      'page.access.fees',
    ]) {
      expect(before.has(capability), `${capability} was already in 00238`).toBe(false);
      expect(after.has(capability), `${capability} is missing from 00243`).toBe(true);
    }
  });

  // ...nor in 00244.
  it('removes nothing in 00244 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(switchedOffPagesVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(clubEventsVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // THE EIGHT KEYS 00244 IS FOR: the seven admin-only `events.*` capabilities
  // and `page.access.events`, the key to the new events feature switch.
  it('admits the club events keys, which is what 00244 is for', () => {
    const before = new Set(arrayLiteralAfter(switchedOffPagesVocabularySql, 'players_permission_vocabulary_check'));
    const after = new Set(arrayLiteralAfter(clubEventsVocabularySql, 'players_permission_vocabulary_check'));
    for (const capability of [
      'events.page',
      'events.signups.read',
      'events.signups.remove.write',
      'events.manage.create.write',
      'events.manage.update.write',
      'events.manage.cancel.write',
      'events.manage.delete.write',
      'page.access.events',
    ]) {
      expect(before.has(capability), `${capability} was already in 00243`).toBe(false);
      expect(after.has(capability), `${capability} is missing from 00244`).toBe(true);
    }
  });

  // ...nor in 00247.
  it('removes nothing in 00247 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(clubEventsVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(membershipSocialsVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // THE TWO KEYS 00247 IS FOR, and nothing else.
  it('admits exactly the membership and socials keys, which is what 00247 is for', () => {
    const before = new Set(arrayLiteralAfter(clubEventsVocabularySql, 'players_permission_vocabulary_check'));
    const after = arrayLiteralAfter(membershipSocialsVocabularySql, 'players_permission_vocabulary_check');
    expect(after.filter((capability) => !before.has(capability)).sort()).toEqual([
      'page.access.membership',
      'page.access.socials',
    ]);
  });

  // ...nor in 00254.
  it('removes nothing going from 00247 to 00254, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(membershipSocialsVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(guestWaiversVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // THE ONE KEY 00254 IS FOR, and nothing else.
  it('admits exactly page.access.guest_waivers, which is what 00254 is for', () => {
    const before = new Set(arrayLiteralAfter(membershipSocialsVocabularySql, 'players_permission_vocabulary_check'));
    const after = arrayLiteralAfter(guestWaiversVocabularySql, 'players_permission_vocabulary_check');
    expect(after.filter((capability) => !before.has(capability))).toEqual(['page.access.guest_waivers']);
  });

  // ...nor in 00256. It was written when
  // 00238 was the live list and rebased twice, onto 00247 and then onto 00254,
  // before it shipped; this is the hop that would catch a rebase having been
  // missed, because every older list lacks a key a later one added.
  it('removes nothing going from 00254 to 00256, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(guestWaiversVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(auditExportVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // ...nor in 00282.
  it('removes nothing going from 00256 to 00282, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(auditExportVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(predictionsVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // ...nor in 00286, the newest link and the live list.
  it('removes nothing going from 00282 to 00286, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(predictionsVocabularySql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(clubChangesVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // THE TWO STRINGS 00286 IS FOR, and nothing else. Both admin-only, in no
  // baseline, admitted to keep this list the code's list exactly.
  it('admits exactly changelog.page and changelog.post.write, which is what 00286 is for', () => {
    const before = new Set(arrayLiteralAfter(predictionsVocabularySql, 'players_permission_vocabulary_check'));
    const after = arrayLiteralAfter(clubChangesVocabularySql, 'players_permission_vocabulary_check');
    expect(after.filter((capability) => !before.has(capability))).toEqual([
      'changelog.page',
      'changelog.post.write',
    ]);
  });

  // THE ONE KEY 00282 IS FOR, and nothing else.
  it('admits exactly page.access.predictions, which is what 00282 is for', () => {
    const before = new Set(arrayLiteralAfter(auditExportVocabularySql, 'players_permission_vocabulary_check'));
    const after = arrayLiteralAfter(predictionsVocabularySql, 'players_permission_vocabulary_check');
    expect(after.filter((capability) => !before.has(capability))).toEqual(['page.access.predictions']);
  });

  // THE TWO STRINGS 00256 IS FOR, and nothing else. Both are admin-only, in no
  // baseline and in EDITOR_OFFERABLE nowhere, admitted anyway to keep this list
  // the code's list exactly.
  it('admits exactly the audit export capabilities, which is what 00256 is for', () => {
    const before = new Set(arrayLiteralAfter(guestWaiversVocabularySql, 'players_permission_vocabulary_check'));
    const after = arrayLiteralAfter(auditExportVocabularySql, 'players_permission_vocabulary_check');
    expect(after.filter((capability) => !before.has(capability)).sort()).toEqual([
      'audit.export.read',
      'audit.signins.read',
    ]);
  });

  // THE THREE STRINGS THIS MIGRATION IS FOR, named rather than left to the
  // set-equality above. A vocabulary CHECK that does not admit them means the
  // database refuses every row naming one.
  //
  // ALL THREE ARE ADMIN-ONLY, in no baseline and in EDITOR_OFFERABLE nowhere,
  // so no save the console can produce would ever have hit that refusal. They
  // are admitted anyway to keep this list the code's list exactly, which is
  // what the set-equality above pins and what stops a second, weaker copy of
  // the assignability rule existing in SQL. `permissions.write` has stood here
  // on the same footing since 00087.
  it('admits the data API key capabilities, which is what 00238 is for', () => {
    const before = new Set(arrayLiteralAfter(discordLinkVocabularySql, 'players_permission_vocabulary_check'));
    const after = new Set(arrayLiteralAfter(dataApiVocabularySql, 'players_permission_vocabulary_check'));
    for (const capability of [
      'accounts.apikey.read',
      'accounts.apikey.mint.write',
      'accounts.apikey.revoke.write',
    ]) {
      expect(before.has(capability), `${capability} was already in 00232`).toBe(false);
      expect(after.has(capability), `${capability} is missing from 00238`).toBe(true);
    }
  });

  // The hop this one replaced, kept rather than overwritten.
  it('admits players.discordlink.write, which is what 00232 was for', () => {
    const before = new Set(arrayLiteralAfter(discordSayVocabularySql, 'players_permission_vocabulary_check'));
    const after = new Set(arrayLiteralAfter(discordLinkVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.has('players.discordlink.write')).toBe(false);
    expect(after.has('players.discordlink.write')).toBe(true);
  });

  // The hop this one replaced, kept rather than overwritten, exactly as 00105's
  // is kept below it.
  it('admits announcements.discord.write, which is what 00223 was for', () => {
    const before = new Set(arrayLiteralAfter(prevVocabularySql, 'players_permission_vocabulary_check'));
    const after = new Set(arrayLiteralAfter(discordSayVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.has('announcements.discord.write')).toBe(false);
    expect(after.has('announcements.discord.write')).toBe(true);
  });

  // The hop this one replaced, kept rather than overwritten. The pointer moving
  // forward must not retire the assertion it used to make — 00105's own string
  // would otherwise stop being checked the moment 00223 landed, and the chain
  // would look unbroken with a gap in it.
  it('admits players.consoleaccess.write, which is what 00105 was for', () => {
    const before = new Set(arrayLiteralAfter(priorVocabularySql, 'players_permission_vocabulary_check'));
    const after = new Set(arrayLiteralAfter(prevVocabularySql, 'players_permission_vocabulary_check'));
    expect(before.has('players.consoleaccess.write')).toBe(false);
    expect(after.has('players.consoleaccess.write')).toBe(true);
  });

  it('pins exactly the roles this build has', () => {
    // THE ROLE LIST MOVED, for the same reason the vocabulary list did: 00087
    // pinned the four VP jobs, and 00091 drops and re-adds the constraint with
    // `custom` alongside them. Both files write a list; only the LATEST one is
    // live, so the assertion follows it there.
    //
    // Written as `permission_role IN ('a', 'b', …)` rather than as an array, so
    // it is matched separately.
    const roleSql = migration('00091_');
    const from = roleSql.indexOf('players_permission_role_check');
    const check = roleSql.slice(from, roleSql.indexOf(';', roleSql.indexOf('CHECK', from)));
    const roles = [...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    expect([...roles].sort()).toEqual([...PERMISSION_ROLES].sort());
  });

  // The three columns the resolver reads, and the guard trigger that stops a
  // member writing them to their own row through PostgREST. Without the guard
  // lines, players_update_own (00005) lets the exec whose access these columns
  // limit clear them and take everything back.
  it('guards all three columns in both branches of the privilege trigger', () => {
    const from = sql.indexOf('CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns');
    const body = sql.slice(from);
    const [insertBranch, updateBranch] = body.split('IF TG_OP = \'INSERT\' THEN')[1]!
      .split('RETURN NEW;\n  END IF;');
    for (const column of ['permission_role', 'permission_grants', 'permission_revokes']) {
      expect(insertBranch!.includes(column), `INSERT branch misses ${column}`).toBe(true);
      expect(updateBranch!.includes(column), `UPDATE branch misses ${column}`).toBe(true);
    }
    // portfolio is gone from both, and the column with it.
    expect(body.includes('NEW.portfolio')).toBe(false);
  });

  // ------------------------------------------------------------------
  // 00093 — the baselines table
  // ------------------------------------------------------------------
  // A THIRD COPY OF THE VOCABULARY exists as of 00093: permission_baselines
  // constrains its own `capabilities` array to the same strings. Two copies
  // in SQL can drift, and the direction this one drifts in is a baseline that
  // stores a string the code does not know and therefore hands out nothing. So
  // it is pinned exactly as the players copy is, against the same array.
  describe('the baselines table', () => {
    // TWO POINTERS, ON PURPOSE. 00093 created the table and owns the live
    // definition of guard_player_privileged_columns; 00105 re-adds only the
    // vocabulary CHECK. Following the guard assertion to 00105 would fail on a
    // missing function rather than on a real disagreement, and following the
    // vocabulary assertion back to 00093 would check a list that is no longer
    // the live one. The vocabulary pointer moves with every migration that
    // re-adds the CHECK (00097, 00098, 00105, 00223, 00232, 00238, 00243, 00244,
    // 00247, 00254, 00256, 00282, now 00286) while the guard pointer stays
    // where the function is defined.
    const baselineGuardSql = migration('00093_');
    const baselineSql = migration('00286_');

    it('pins the same vocabulary the players columns pin', () => {
      const stored = arrayLiteralAfter(baselineSql, 'permission_baselines_vocabulary_check');
      expect(stored.length).toBe(CAPABILITIES.length);
      expect([...stored].sort()).toEqual([...CAPABILITIES].sort());
    });

    // The two SQL copies, compared to each other rather than only to the code.
    // Both assertions above could pass while the constraints were written in
    // different migrations against different builds; this one says they are the
    // same list today.
    it('agrees with the players vocabulary check', () => {
      const players = arrayLiteralAfter(vocabularySql, 'players_permission_vocabulary_check');
      const baselines = arrayLiteralAfter(baselineSql, 'permission_baselines_vocabulary_check');
      expect([...baselines].sort()).toEqual([...players].sort());
    });

    // THE GUARD IS REPLACED WHOLESALE by 00093 (CREATE OR REPLACE takes the
    // whole body), so the live definition is that file's — and everything 00087
    // protected has to still be in it. A column dropped in the copy is a guard
    // silently removed, which is the failure 00072's header describes.
    it('carries every guarded column forward and adds the baseline label', () => {
      const from = baselineGuardSql.indexOf(
        'CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns',
      );
      expect(from, '00093 must replace the guard').toBeGreaterThan(-1);
      const body = baselineGuardSql.slice(from);
      const [insertBranch, updateBranch] = body.split('IF TG_OP = \'INSERT\' THEN')[1]!
        .split('RETURN NEW;\n  END IF;');
      const columns = [
        'permission_role',
        'permission_grants',
        'permission_revokes',
        'permission_baseline_id',
      ];
      for (const column of columns) {
        expect(insertBranch!.includes(column), `INSERT branch misses ${column}`).toBe(true);
        expect(updateBranch!.includes(column), `UPDATE branch misses ${column}`).toBe(true);
      }
      // Everything 00087's UPDATE branch named, still named here. Read off that
      // file rather than listed by hand, so a column added to the guard later
      // cannot be dropped by the next replacement without this failing.
      const previous = sql.slice(
        sql.indexOf('CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns'),
      );
      for (const [, column] of previous.matchAll(/NEW\.([a-z_]+)\s+IS DISTINCT FROM/g)) {
        expect(updateBranch!.includes(`NEW.${column}`), `00093 dropped ${column}`).toBe(true);
      }
    });
  });
});
