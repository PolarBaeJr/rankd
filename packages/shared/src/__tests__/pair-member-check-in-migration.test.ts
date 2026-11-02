import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00309: EACH PERSON IN A DOUBLES TEAM CHECKS IN ON THEIR OWN.
 *
 * set_pair_member_check_in is a field writer, so it takes the event field lock
 * before it locks a row, exactly as set_field_entry_status does, and it gates a
 * member's own check-in on the window by p_actor IS NULL. The trigger keeps
 * the slots true for every other writer.
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
const migration = () => readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith('00309_'))!), 'utf8');

describe('00309: set_pair_member_check_in', () => {
  const latest = latestBody('set_pair_member_check_in');
  const code = stripComments(latest?.body ?? '');

  it('is defined in 00309', () => {
    expect(latest?.file).toMatch(/^00309_/);
  });

  it('takes the field lock before its first row lock', () => {
    const lock = code.indexOf("pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text))");
    const firstRowLock = code.indexOf('FOR UPDATE');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(firstRowLock).toBeGreaterThan(lock);
  });

  it('gates only a member\'s own check-in on the window', () => {
    expect(code).toMatch(/IF p_here AND p_actor IS NULL AND v_before <> 'checked_in' THEN/);
    expect(code).toContain("'checkin_not_open'");
    expect(code).toContain("'checkin_window_closed'");
  });

  it('refuses a slot other than 1 or 2', () => {
    expect(code).toMatch(/p_slot IS NOT NULL AND p_slot NOT IN \(1, 2\)/);
  });

  it('is service_role only', () => {
    const sql = migration();
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.set_pair_member_check_in(uuid, smallint, boolean, uuid) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.set_pair_member_check_in(uuid, smallint, boolean, uuid) TO service_role;');
  });
});

describe('00309: the slots kept true by a trigger', () => {
  const code = stripComments(latestBody('tournament_pairs_member_check_in')?.body ?? '');

  it('clears a slot whose player changes', () => {
    expect(code).toMatch(/IF NEW\.player1_id IS DISTINCT FROM OLD\.player1_id THEN\s+NEW\.player1_checked_in_at := NULL;/);
    expect(code).toMatch(/IF NEW\.player2_id IS DISTINCT FROM OLD\.player2_id THEN\s+NEW\.player2_checked_in_at := NULL;/);
  });

  it('stamps both slots when the team moves into checked_in', () => {
    expect(code).toMatch(/NEW\.status = 'checked_in' AND OLD\.status IS DISTINCT FROM 'checked_in'/);
    expect(code).toContain('NEW.player1_checked_in_at := COALESCE(NEW.player1_checked_in_at, NEW.checked_in_at, now());');
    expect(code).toContain('NEW.player2_checked_in_at := COALESCE(NEW.player2_checked_in_at, NEW.checked_in_at, now());');
  });

  it('is attached BEFORE UPDATE and unreachable by client roles', () => {
    const sql = migration();
    expect(sql).toMatch(/CREATE TRIGGER tournament_pairs_member_check_in\s+BEFORE UPDATE ON public\.tournament_pairs/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.tournament_pairs_member_check_in() FROM PUBLIC, anon, authenticated;');
  });

  it('backfills every pair already checked in', () => {
    expect(stripComments(migration())).toMatch(
      /UPDATE public\.tournament_pairs\s+SET player1_checked_in_at = COALESCE\(player1_checked_in_at, checked_in_at, now\(\)\),\s+player2_checked_in_at = COALESCE\(player2_checked_in_at, checked_in_at, now\(\)\)\s+WHERE status = 'checked_in';/,
    );
  });

  it('runs in one transaction and reloads the schema cache', () => {
    const sql = stripComments(migration());
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
    expect(sql.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });
});
