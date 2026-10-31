import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00311: THE DESK SETTLES WHO PARTNERS WHOM.
 *
 * The desk's choice lives in columns the Form reader never writes, so a replay
 * cannot undo it. A non-member admitted into the linked tournament keeps their
 * note and the desk's choice, and a pick of them follows them to the guest
 * record before the DELETE blanks it.
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
const migrationOf = (prefix: string) =>
  readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith(prefix))!), 'utf8');
const migration = () => migrationOf('00311_');

const disposableRows = (prefix: string) => {
  const sql = migrationOf(prefix);
  const start = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.merge_players_disposable()');
  const body = sql.slice(start, sql.indexOf('$function$;', start));
  return [...body.matchAll(/\('([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
};

describe('00311: the desk\'s partner columns', () => {
  const sql = stripComments(migration());

  it('runs in one transaction and reloads the schema cache last', () => {
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });

  it('adds the three columns on both tables', () => {
    for (const table of ['club_event_signups', 'club_event_external_signups']) {
      expect(sql).toContain(
        `ALTER TABLE public.${table}\n  ADD COLUMN IF NOT EXISTS preferred_partner_player_id uuid REFERENCES public.players(id) ON DELETE SET NULL;`,
      );
      expect(sql).toContain(
        `ALTER TABLE public.${table}\n  ADD COLUMN IF NOT EXISTS preferred_partner_external_id uuid REFERENCES public.club_event_external_signups(id) ON DELETE SET NULL;`,
      );
      expect(sql).toContain(`ALTER TABLE public.${table}\n  ADD COLUMN IF NOT EXISTS preferred_partner_set_at timestamptz;`);
    }
  });

  it('holds at most one reference, a reference only with a time, and never self', () => {
    for (const table of ['club_event_signups', 'club_event_external_signups']) {
      expect(sql).toMatch(
        new RegExp(`${table}_preferred_partner_one_ref\\s+CHECK \\(num_nonnulls\\(preferred_partner_player_id, preferred_partner_external_id\\) <= 1\\)`),
      );
      expect(sql).toMatch(
        new RegExp(
          `${table}_preferred_partner_set\\s+CHECK \\(\\(preferred_partner_player_id IS NULL AND preferred_partner_external_id IS NULL\\)\\s+OR preferred_partner_set_at IS NOT NULL\\)`,
        ),
      );
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${table}_preferred_partner_not_self;`);
    }
    expect(sql).toMatch(/club_event_signups_preferred_partner_not_self\s+CHECK \(preferred_partner_player_id IS DISTINCT FROM player_id\)/);
    expect(sql).toMatch(/club_event_external_signups_preferred_partner_not_self\s+CHECK \(preferred_partner_external_id IS DISTINCT FROM id\)/);
  });

  it('checks its preconditions before it changes anything', () => {
    const pre = sql.indexOf('DO $pre$');
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(sql.indexOf('ALTER TABLE'));
    const block = sql.slice(pre, sql.indexOf('$pre$;'));
    expect(block).toContain("column_name = 'preferred_partner'");
    expect(block).toContain("tbl = 'tournament_court_helpers' AND col = 'player_id'");
  });
});

describe('00311: the reader still writes only the note', () => {
  it('leaves record_form_partner_note as 00299 wrote it, naming none of the new columns', () => {
    const latest = latestBody('record_form_partner_note');
    expect(latest?.file).toMatch(/^00299_/);
    for (const column of ['preferred_partner_player_id', 'preferred_partner_external_id', 'preferred_partner_set_at']) {
      expect(latest?.body).not.toContain(column);
    }
  });
});

describe('00311: a non-member who enters the tournament keeps their partner', () => {
  const latest = latestBody('club_event_link_admit_external');
  const code = stripComments(latest?.body ?? '');

  it('is defined in 00311', () => {
    expect(latest?.file).toMatch(/^00311_/);
  });

  it('keeps the no-email guard', () => {
    expect(code).toContain('IF v_x.email IS NULL THEN');
  });

  it('points a pick of the non-member at the guest record before the DELETE', () => {
    const memberRepoint = code.indexOf(
      'UPDATE club_event_signups\n     SET preferred_partner_player_id = CASE WHEN player_id = v_player THEN NULL ELSE v_player END,\n         preferred_partner_external_id = NULL\n   WHERE preferred_partner_external_id = v_x.id;',
    );
    const guestRepoint = code.indexOf(
      'UPDATE club_event_external_signups\n     SET preferred_partner_player_id = v_player,\n         preferred_partner_external_id = NULL\n   WHERE preferred_partner_external_id = v_x.id AND id <> v_x.id;',
    );
    const remove = code.indexOf('DELETE FROM club_event_external_signups WHERE id = v_x.id;');
    expect(memberRepoint).toBeGreaterThan(-1);
    expect(guestRepoint).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(memberRepoint);
    expect(remove).toBeGreaterThan(guestRepoint);
  });

  it('carries the note and the desk\'s choice onto the member row, without overwriting one already there', () => {
    const insert = code.slice(code.indexOf('INSERT INTO club_event_signups'));
    expect(insert).toMatch(/VALUES \(v_x\.event_id, v_player, v_x\.preferred_partner,/);
    expect(insert).toContain('CASE WHEN v_x.preferred_partner_player_id = v_player THEN NULL ELSE v_x.preferred_partner_player_id END');
    expect(insert).toContain('ON CONFLICT (event_id, player_id) DO UPDATE');
    expect(insert).toContain('preferred_partner = coalesce(club_event_signups.preferred_partner, EXCLUDED.preferred_partner)');
    expect(insert).toContain('WHEN club_event_signups.preferred_partner_set_at IS NULL');
    expect(insert.indexOf('ON CONFLICT')).toBeLessThan(insert.indexOf('INSERT INTO audit_logs'));
  });

  it('is unreachable by client roles, as 00292 and 00294 left it', () => {
    expect(migration()).toContain(
      'REVOKE ALL ON FUNCTION public.club_event_link_admit_external(uuid) FROM PUBLIC, anon, authenticated;',
    );
  });
});

describe('00311: merges', () => {
  it('restates merge_players_disposable as 00310 had it plus the two partner columns', () => {
    expect(latestBody('merge_players_disposable')?.file).toMatch(/^00311_/);
    const before = disposableRows('00310_');
    expect(before).toHaveLength(29);
    const after = disposableRows('00311_');
    expect(after).toHaveLength(31);
    expect(after.sort()).toEqual(
      [...before, 'club_event_signups.preferred_partner_player_id', 'club_event_external_signups.preferred_partner_player_id'].sort(),
    );
  });

  it('revokes the function from PUBLIC, anon and authenticated', () => {
    const sql = migration();
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;');
  });

  it('verifies the count, the merge guard, the admit body and the grants', () => {
    const verify = migration().slice(migration().indexOf('DO $verify$'));
    expect(verify).toContain('merge_players_disposable()) <> 31');
    expect(verify).toContain('FROM public.merge_players_unhandled()');
    expect(verify).toContain("position('v_x.email IS NULL' IN v_src) = 0");
    expect(verify).toContain("position('preferred_partner_external_id = NULL' IN v_src) = 0");
    expect(verify).toContain("has_table_privilege('anon', 'public.club_event_external_signups', 'SELECT')");
  });
});
