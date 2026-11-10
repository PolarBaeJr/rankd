import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// purge-unfinished-signups (00233) is the only job in the repo that DELETES a
// players row. Its twin purge-inactive-accounts anonymises, and both of the
// existing jobs therefore end with an UPDATE that leaves a partial failure
// retryable. This one cannot, so two of its decisions are inverted from the
// files a future editor will read first, and both look like bugs:
//
//   1. It deletes the players row BEFORE the auth user. Doing it the other way
//      round fires players.user_id ON DELETE SET NULL (00001:152), which makes
//      the stub byte-identical to an unclaimed exec pre-add, permanently
//      invisible to the view's `user_id IS NOT NULL` arm and to every future
//      run. "Make it match the other two" is the natural review comment and it
//      would strand rows unrecoverably.
//   2. Its dry-run gate is PURGE_UNFINISHED_ENABLED, not the existing
//      PURGE_INACTIVE_ENABLED. Reusing the older one would mean arming
//      anonymisation of lapsed members also armed outright deletion here, in
//      one keystroke, invisibly.
//
// Source-text pins, the same technique deleted-identity.test.ts:86-98 uses,
// because nothing here can be exercised without a Deno runtime and a service
// key. COMMENTS ARE STRIPPED FIRST: this file's own subject matter is prose
// about `auth.admin.deleteUser` and `PURGE_INACTIVE_ENABLED`, and the function's
// header is required to discuss both. Asserting against raw source would make
// the header's explanation fail the test that protects it, and the natural fix
// for that is to weaken the assertion.

const REPO = join(__dirname, '../../../../..');
const FN = join(REPO, 'supabase/functions/purge-unfinished-signups/index.ts');
const TWIN = join(REPO, 'supabase/functions/purge-inactive-accounts/index.ts');
// The latest definition of the view: 00323 restated 00233's with the waiver arms.
const VIEW = join(REPO, 'supabase/migrations/00323_unfinished_signup_purge_spares_signed_waivers.sql');

/** A file's executable text, with whole-line `//` or `--` comments removed. */
function codeOnly(path: string): string {
  const src = readFileSync(path, 'utf8');
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|--)/.test(line))
    .join('\n');
  expect(code.length, `${path} is all comment or unreadable`).toBeGreaterThan(200);
  return code;
}

describe('the unfinished-signup purge deletes in the order that fails safely', () => {
  it('deletes the players row before it deletes the auth user', () => {
    const code = codeOnly(FN);
    const rowDelete = code.indexOf("from('players')");
    const authDelete = code.indexOf('auth.admin.deleteUser');

    // Guarded separately so a rename fails loudly instead of passing as
    // -1 < -1 or failing as an unexplained ordering error.
    expect(rowDelete, "the job no longer deletes from 'players'").toBeGreaterThan(-1);
    expect(authDelete, 'the job no longer deletes the auth user').toBeGreaterThan(-1);
    expect(
      rowDelete,
      'the auth user is deleted FIRST: ON DELETE SET NULL then strands the stub ' +
        'with user_id NULL, invisible to the view forever (00001:152)',
    ).toBeLessThan(authDelete);
  });

  it('deletes the players row rather than anonymising it', () => {
    // The inverted order only makes sense for a job that removes the row. If
    // somebody turns this into its twin, the order becomes wrong too.
    const code = codeOnly(FN);
    expect(code).toMatch(/from\('players'\)[\s\S]{0,60}\.delete\(\)/);
    expect(code, 'this job deletes; it must not grow an anonymising update').not.toMatch(
      /anonymizedPlayerFields/,
    );
  });

  it('writes the audit row between the two deletes, not after both', () => {
    // The audit row records the players deletion, which is irreversible and has
    // already happened by then. Behind the auth delete it sits behind a call
    // that can fail, and a `continue` on that failure loses it: the row is gone
    // and nothing anywhere says so, because `errors` ends up in a response body
    // run-edge-fn.sh discards and stderr goes to /dev/null on the cron line
    // (purge-inactive-accounts:25).
    const code = codeOnly(FN);
    const rowDelete = code.indexOf("from('players')");
    const audit = code.indexOf("from('audit_logs')");
    const authDelete = code.indexOf('auth.admin.deleteUser');
    expect(audit, 'the job no longer writes an audit row').toBeGreaterThan(-1);
    expect(audit, 'the audit row is written before the deletion it records').toBeGreaterThan(
      rowDelete,
    );
    expect(
      audit,
      'the audit row is behind the auth delete, so an auth failure erases the only ' +
        'record of an irreversible deletion',
    ).toBeLessThan(authDelete);
  });

  it('does not let an auth failure skip the audit write', () => {
    // The specific shape of the bug above: `continue` inside the auth error
    // branch jumps past everything after it in the loop body.
    const code = codeOnly(FN);
    const authBranch = code.slice(code.indexOf('if (authError'), code.indexOf('purged++'));
    expect(authBranch.length, 'the auth error branch moved or went away').toBeGreaterThan(20);
    expect(authBranch, 'the auth error branch must record and fall through, not continue')
      .not.toMatch(/\bcontinue\b/);
  });

  it('tolerates a missing auth user but nothing else', () => {
    // A 404 means a previous run got this far. Anything else must not be
    // swallowed, because the players row is already gone by then.
    const code = codeOnly(FN);
    expect(code).toMatch(/authError\.status\s*!==\s*404/);
  });
});

describe('eligibility is the view and only the view', () => {
  it('selects the candidates from purgeable_unfinished_signups', () => {
    const code = codeOnly(FN);
    expect(code).toMatch(/from\('purgeable_unfinished_signups'\)[\s\S]{0,120}\.select\(/);
  });

  it('does not rebuild the onboarding or empty-name predicate in TypeScript', () => {
    // 00064:5-11: a second copy drifts, and the direction it drifts in deletes
    // somebody. Concretely, a TS copy that used the repo's two-column
    // definition of an incomplete signup (players/page.tsx:225) and dropped the
    // empty-name test would delete every claimed exec pre-add on the roster.
    const code = codeOnly(FN);
    expect(code, 'onboarding_completed is filtered in TS').not.toMatch(
      /\.(eq|is|not)\(\s*'onboarding_completed'/,
    );
    expect(code, 'first_name is filtered in TS').not.toMatch(/\.(eq|is|not)\(\s*'first_name'/);
    expect(code, 'user_id is filtered in TS').not.toMatch(/\.(eq|is|not)\(\s*'user_id'/);
    expect(code, 'the 30-day cutoff is recomputed in TS').not.toMatch(
      /\.(lt|gt|lte|gte)\(\s*'created_at'/,
    );
  });

  it('keeps first_name = \'\' in the view, which is what stops it shredding the roster', () => {
    // The single condition separating a true stub (00132:530-531) from an exec
    // pre-add claimed at first sign-in (00132:389-395), whose created_at can be
    // arbitrarily old and which matches every other arm.
    // Anchored on the table alias rather than the bare column, because
    // COMMENT ON VIEW quotes the same condition as escaped SQL text and would
    // otherwise satisfy this on its own after the predicate was removed.
    const sql = codeOnly(VIEW);
    expect(
      sql,
      "the view no longer tests first_name = '', so it now deletes real members",
    ).toMatch(/AND\s+p\.first_name\s*=\s*''/);
    // Without the reload the function gets PGRST205, which is indistinguishable
    // from "found nobody" (00064:112-119).
    expect(sql).toMatch(/NOTIFY pgrst/);
    expect(sql).toMatch(/GRANT SELECT ON purgeable_unfinished_signups TO service_role/);
  });

  it('spares anybody who has signed a waiver or an event waiver', () => {
    // Both tables cascade from players, so deleting a stub that signed would
    // delete the signed record too (00323). Matched by alias, because
    // waiver_acceptances is a substring of event_waiver_acceptances.
    const sql = codeOnly(VIEW);
    expect(sql).toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM waiver_acceptances wa WHERE wa\.player_id = p\.id\s*\)/);
    expect(sql).toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM event_waiver_acceptances ewa WHERE ewa\.player_id = p\.id\s*\)/);
  });
});

describe('the two purge jobs have two separate switches', () => {
  it('is armed by PURGE_UNFINISHED_ENABLED and dry-runs by default', () => {
    const code = codeOnly(FN);
    expect(code).toMatch(/Deno\.env\.get\('PURGE_UNFINISHED_ENABLED'\)\s*!==\s*'true'/);
  });

  it('never reads the inactive job\'s gate, and it never reads this one', () => {
    // Sharing a variable would mean one deliberate act armed two irreversible
    // jobs with different blast radii.
    expect(
      codeOnly(FN),
      'arming anonymisation would silently arm deletion',
    ).not.toMatch(/Deno\.env\.get\('PURGE_INACTIVE_ENABLED'\)/);
    expect(codeOnly(TWIN)).not.toMatch(/Deno\.env\.get\('PURGE_UNFINISHED_ENABLED'\)/);
  });

  it('writes nothing at all on a dry run', () => {
    // An audit trail of things that did not happen makes the real history
    // unreadable, and here "did not happen" means "was not deleted".
    const code = codeOnly(FN);
    const dry = code.slice(code.indexOf('if (dryRun)'), code.indexOf('let purged'));
    expect(dry.length, 'the dry-run branch moved or went away').toBeGreaterThan(100);
    expect(dry).not.toMatch(/\.delete\(\)|\.insert\(|deleteUser/);
    expect(dry).toMatch(/dry_run:\s*true/);
  });
});

describe('nobody is emailed about an abandoned signup', () => {
  it('sends no mail and no push', () => {
    // The owner's rule for this lifecycle: no email is ever sent. There is no
    // member to notify, only an address that proved itself once and left, and a
    // "your account will be deleted" notice would be the club's first and only
    // message to them.
    const code = codeOnly(FN);
    expect(code).not.toMatch(/resend|sendEmail|sendPushToPlayers|_shared\/push/i);
  });
});
