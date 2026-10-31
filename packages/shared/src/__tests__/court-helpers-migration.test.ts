import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00310: A CONSOLE MEMBER KEEPS SCORE ON A COURT.
 *
 * tournament_court_helpers is service_role only, names its court and its
 * tournament through ONE composite reference (a second reference to
 * tournament_courts would make every unnamed embed between the two tables
 * ambiguous), and its two player columns are classified for merges.
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
const migration = () => readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith('00310_'))!), 'utf8');

function tableBody(): string {
  const sql = stripComments(migration());
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS public.tournament_court_helpers (');
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('\n);', start));
}

describe('00310: tournament_court_helpers', () => {
  it('keys each row on its court and its person', () => {
    const body = tableBody();
    expect(body).toMatch(/CONSTRAINT tournament_court_helpers_court_player_key UNIQUE \(court_id, player_id\)/);
  });

  it('references its tournament and its people with the right delete actions', () => {
    const body = tableBody();
    expect(body).toMatch(/^\s*tournament_id uuid NOT NULL REFERENCES public\.tournaments\(id\) ON DELETE CASCADE,/m);
    expect(body).toMatch(/^\s*player_id uuid NOT NULL REFERENCES public\.players\(id\) ON DELETE CASCADE,/m);
    expect(body).toMatch(/^\s*created_by uuid REFERENCES public\.players\(id\) ON DELETE SET NULL,/m);
  });

  it('names its court through exactly one composite reference', () => {
    const body = tableBody();
    expect(body).toMatch(
      /CONSTRAINT tournament_court_helpers_court_fkey FOREIGN KEY \(court_id, tournament_id\)\s+REFERENCES public\.tournament_courts\(id, tournament_id\) ON DELETE CASCADE/,
    );
    expect(body.match(/REFERENCES public\.tournament_courts/g)).toHaveLength(1);
    expect(stripComments(migration())).toMatch(
      /ADD CONSTRAINT tournament_courts_id_tournament_key UNIQUE \(id, tournament_id\);/,
    );
  });

  it('is service_role only, with row level security on and no policies', () => {
    const sql = stripComments(migration());
    expect(sql).toContain('ALTER TABLE public.tournament_court_helpers ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON public.tournament_court_helpers FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT ALL ON public.tournament_court_helpers TO service_role;');
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});

describe('00310: merges', () => {
  const latest = latestBody('merge_players_disposable');

  it('restates merge_players_disposable with both helper columns', () => {
    expect(latest?.file).toMatch(/^00310_/);
    const rows = [...(latest?.body ?? '').matchAll(/\('([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(rows).toHaveLength(29);
    expect(rows).toContain('tournament_court_helpers.player_id');
    expect(rows).toContain('tournament_court_helpers.created_by');
  });

  it('keeps every row 00294 had', () => {
    const rowsOf = (file: string) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith(file))!), 'utf8');
      const start = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.merge_players_disposable()');
      const body = sql.slice(start, sql.indexOf('$function$;', start));
      return [...body.matchAll(/\('([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
    };
    const before = rowsOf('00294_');
    expect(before).toHaveLength(27);
    expect(rowsOf('00310_').sort()).toEqual(
      [...before, 'tournament_court_helpers.player_id', 'tournament_court_helpers.created_by'].sort(),
    );
  });

  it('revokes the function from PUBLIC, anon and authenticated', () => {
    const sql = migration();
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;');
  });

  it('verifies the count and the merge guard', () => {
    const verify = migration().slice(migration().indexOf('DO $verify$'));
    expect(verify).toContain('merge_players_disposable()) <> 29');
    expect(verify).toContain('FROM public.merge_players_unhandled()');
  });
});

describe('00310: shape', () => {
  it('runs in one transaction and reloads the schema cache', () => {
    const sql = stripComments(migration());
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });
});
