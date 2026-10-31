import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00308 OPENS THE CONSOLE'S THREE ENTRY PATHS FOR A LATE ENTRY.
 *
 * The status gate in each now also lets staged_late_entry_open through. The
 * gate is only worth anything if it is asked AFTER the field lock is taken:
 * asked before it, a later stage could be drawn between the answer and the
 * insert, and the entry would land in a group whose table has already filled
 * the next stage. A member's own entry keeps its gate; the late entry is an
 * officer's act.
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

describe('00308: the late-entry gate', () => {
  it.each(['add_participants_under_field_lock', 'pair_tournament_entrants', 'add_external_tournament_pair'])(
    '%s asks staged_late_entry_open after the field lock, in its status gate',
    (name) => {
      const latest = latestBody(name);
      expect(latest?.file).toMatch(/^00308_/);
      const code = stripComments(latest!.body);
      const lock = code.indexOf('pg_advisory_xact_lock');
      const helper = code.indexOf('staged_late_entry_open');
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(helper).toBeGreaterThan(lock);
      expect(code).toMatch(/NOT IN \('registration', 'checkin'\) AND NOT public\.staged_late_entry_open\(p_event_id\)/);
    },
  );

  it('keeps the helper away from client roles', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith('00308_'))!), 'utf8');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.staged_late_entry_open(uuid) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.staged_late_entry_open(uuid) TO service_role;');
  });

  it('leaves a member entering themselves shut after the draw', () => {
    const own = latestBody('enter_tournament_event');
    expect(own).not.toBeNull();
    expect(stripComments(own!.body)).not.toContain('staged_late_entry_open');
  });
});
