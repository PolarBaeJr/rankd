import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00321: SUPER ADMIN, A LEVEL ABOVE ADMIN.
 *
 * user_role gains 'super_admin'; every helper that treated role = 'admin' as
 * the top treats the admin tier as admin or super_admin; only a super admin on
 * the browser key may make or unmake an admin; the console page switches ride
 * on admin_console_access and draft no club change. Nobody is promoted.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');
const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

/** The latest CREATE of a function across the directory, body bounded by its own dollar tag. */
function latestBody(name: string): { file: string; body: string } | null {
  let found: { file: string; body: string } | null = null;
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = head.exec(sql)) !== null) {
      const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(sql.slice(match.index));
      if (!open) continue;
      const bodyStart = match.index + open.index + open[0].length;
      const bodyEnd = sql.indexOf(open[1]!, bodyStart);
      if (bodyEnd !== -1) found = { file, body: sql.slice(bodyStart, bodyEnd) };
    }
  }
  return found;
}

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const migration = () =>
  readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith('00321_'))!), 'utf8');
const TIER = "role::text IN ('admin', 'super_admin')";

describe('00321: the file', () => {
  const sql = migration();
  const code = stripComments(sql);

  it('adds the enum value idempotently', () => {
    expect(code).toContain("ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'super_admin';");
  });

  it('never casts the new label to user_role in its own transaction', () => {
    expect(code).not.toMatch(/'super_admin'::(public\.)?user_role/);
    expect(code).not.toMatch(/\brole\s*=\s*'super_admin'/);
  });

  it('promotes nobody', () => {
    // Function bodies update players (an auto-suspend), but nothing sets a role.
    expect(code).not.toMatch(/UPDATE\s+(public\.)?players\s+SET\s+role\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+(public\.)?players\b/i);
  });

  it('has no top-level COMMIT, a verify block, and ends with NOTIFY pgrst', () => {
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(code).toContain('DO $verify$');
    expect(sql.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });

  it('contains no em or en dash', () => {
    expect(sql).not.toMatch(/[\u2013\u2014]/);
  });

  it('keeps anon off is_admin, is_admin_or_coach and is_super_admin', () => {
    for (const fn of ['is_admin', 'is_admin_or_coach', 'is_super_admin']) {
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(uuid) TO authenticated, service_role;`);
    }
  });
});

describe('00321: the admin tier', () => {
  for (const name of [
    'is_admin',
    'is_admin_or_coach',
    'admins_with_passkeys',
    'guard_last_admin_passkey_delete',
    'trigger_check_noshow_threshold',
    'reject_registration_import_entry',
    'reset_console_passkey_grace',
  ]) {
    it(`${name} is restated last by 00321 and accepts a super admin`, () => {
      const latest = latestBody(name);
      expect(latest?.file).toMatch(/^00321_/);
      const code = stripComments(latest?.body ?? '');
      expect(code).toContain(TIER);
      expect(code).not.toMatch(/role\s*=\s*'admin'/);
    });
  }

  it('is_super_admin keeps is_admin\'s standing gate on the top value', () => {
    const code = stripComments(latestBody('is_super_admin')?.body ?? '');
    expect(code).toContain("role::text = 'super_admin'");
    for (const clause of [
      'COALESCE(is_banned, FALSE) = FALSE',
      "status NOT IN ('suspended', 'pending_approval')",
      'COALESCE(active_flag, TRUE) = TRUE',
      'COALESCE(onboarding_completed, FALSE) = TRUE',
    ]) {
      expect(code).toContain(clause);
    }
  });

  it('admin_access_level answers super_admin before admin', () => {
    const latest = latestBody('admin_access_level');
    expect(latest?.file).toMatch(/^00321_/);
    const code = stripComments(latest?.body ?? '');
    expect(code.indexOf("RETURN 'super_admin'")).toBeGreaterThan(-1);
    expect(code.indexOf("RETURN 'super_admin'")).toBeLessThan(code.indexOf("RETURN 'admin'"));
  });

  it('guard_last_admin_role treats admin and super_admin as one tier in all three arms', () => {
    const latest = latestBody('guard_last_admin_role');
    expect(latest?.file).toMatch(/^00321_/);
    const code = stripComments(latest?.body ?? '');
    expect(code).toContain("NEW.role::text NOT IN ('admin', 'super_admin')");
    for (const sentence of ['before demoting this one.', 'before banning this one.', 'before deleting this account.']) {
      expect(code).toContain(sentence);
    }
    expect(code.match(/OLD\.role::text IN \('admin', 'super_admin'\)/g)).toHaveLength(3);
  });

  it('purgeable_inactive_players never lists a super admin', () => {
    expect(stripComments(migration())).toContain("AND p.role::text NOT IN ('admin', 'super_admin')");
  });
});

describe('00321: only a super admin makes an admin', () => {
  const latest = latestBody('guard_player_privileged_columns');
  const code = stripComments(latest?.body ?? '');

  it('is restated last by 00321', () => {
    expect(latest?.file).toMatch(/^00321_/);
  });

  it('asks for a super admin before the admin early return', () => {
    const arm = code.indexOf('NOT public.is_super_admin(auth.uid())');
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(code.indexOf('is_admin(auth.uid()) THEN'));
    expect(code).toContain("'Only a super admin may make or unmake an admin'");
  });

  it('covers an insert and a change in either direction', () => {
    expect(code).toContain("TG_OP = 'INSERT' AND NEW.role::text IN ('admin', 'super_admin')");
    expect(code).toContain('NEW.role IS DISTINCT FROM OLD.role');
    expect(code).toContain("OLD.role::text IN ('admin', 'super_admin')");
  });
});

describe('00321: the console page switches', () => {
  it('admin_console_access returns the console_pages row', () => {
    const latest = latestBody('admin_console_access');
    expect(latest?.file).toMatch(/^00321_/);
    expect(stripComments(latest?.body ?? '')).toContain(
      "'console_pages',       (SELECT ps.value FROM platform_settings ps WHERE ps.key = 'console_pages')",
    );
  });

  it('a console_pages save drafts no club change', () => {
    const latest = latestBody('club_change_from_platform_settings');
    expect(latest?.file).toMatch(/^00321_/);
    expect(stripComments(latest?.body ?? '')).toContain("IF NEW.key IN ('release_flags', 'console_pages') THEN");
  });
});
