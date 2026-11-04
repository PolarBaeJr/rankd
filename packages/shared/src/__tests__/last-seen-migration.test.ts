import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00320: LAST SEEN IS THE LAST VISIT.
 *
 * players.last_seen_at is stamped by touch_last_seen() for the signed-in
 * caller only, at most every fifteen minutes, and last_active_at keeps its
 * meaning. possible_duplicate_dismissals records "not the same person", and
 * its three player columns join merge_players_disposable so a merge is never
 * refused by the guard.
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
const migration = () => migrationOf('00320_');

const disposableRows = (prefix: string) => {
  const sql = migrationOf(prefix);
  const start = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.merge_players_disposable()');
  const body = sql.slice(start, sql.indexOf('$function$;', start));
  return [...body.matchAll(/\('([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
};

describe('00320: shape', () => {
  const sql = stripComments(migration());

  it('runs in one transaction and reloads the schema cache last', () => {
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });

  it('checks its preconditions before it changes anything', () => {
    const pre = sql.indexOf('DO $pre$');
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(sql.indexOf('ALTER TABLE'));
    const block = sql.slice(pre, sql.indexOf('$pre$;'));
    expect(block).toContain("tbl = 'club_event_external_signups' AND col = 'preferred_partner_player_id'");
    expect(block).toContain("to_regprocedure('public.merge_players_unhandled()')");
  });
});

describe('00320: last_seen_at', () => {
  const sql = stripComments(migration());

  it('adds the column and leaves last_active_at alone', () => {
    expect(sql).toContain('ALTER TABLE public.players\n  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;');
    expect(sql).not.toMatch(/SET\s+last_active_at/i);
  });

  it('backfills linked rows from the later of last_active_at and the last sign-in', () => {
    expect(sql).toContain('SET last_seen_at = GREATEST(p.last_active_at, u.last_sign_in_at)');
    expect(sql).toContain('FROM auth.users u');
    expect(sql).toContain('WHERE u.id = p.user_id');
  });

  it('grants the column to no client role and keeps it out of the privilege guard', () => {
    expect(sql).not.toMatch(/GRANT\s+UPDATE\s*\([^)]*last_seen_at/i);
    expect(latestBody('guard_player_privileged_columns')?.body).not.toContain('last_seen_at');
  });
});

describe('00320: touch_last_seen', () => {
  const latest = latestBody('touch_last_seen');
  const code = stripComments(latest?.body ?? '');

  it('is defined here, with no parameters, as a definer', () => {
    expect(latest?.file).toMatch(/^00320_/);
    const sql = migration();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.touch_last_seen()\nRETURNS void');
    const head = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.touch_last_seen()'), sql.indexOf('AS $function$', sql.indexOf('touch_last_seen()')));
    expect(head).toContain('SECURITY DEFINER');
    expect(head).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('touches only the caller, and only a stale stamp', () => {
    expect(code).toContain('IF auth.uid() IS NULL THEN');
    expect(code).toContain('WHERE user_id = auth.uid()');
    expect(code).toContain("AND (last_seen_at IS NULL OR last_seen_at < now() - interval '15 minutes');");
  });

  it('is executable by authenticated only', () => {
    const sql = migration();
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.touch_last_seen() FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.touch_last_seen() TO authenticated;');
  });
});

describe('00320: possible_duplicate_dismissals', () => {
  const sql = stripComments(migration());

  it('stores an ordered pair once, and lets a merge delete it', () => {
    expect(sql).toContain('player_a     uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,');
    expect(sql).toContain('player_b     uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,');
    expect(sql).toContain('dismissed_by uuid REFERENCES public.players(id) ON DELETE SET NULL,');
    expect(sql).toContain('PRIMARY KEY (player_a, player_b),');
    expect(sql).toContain('CONSTRAINT possible_duplicate_dismissals_ordered CHECK (player_a < player_b)');
  });

  it('is the service role\'s alone', () => {
    expect(sql).toContain('ALTER TABLE public.possible_duplicate_dismissals ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON public.possible_duplicate_dismissals FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT ALL ON public.possible_duplicate_dismissals TO service_role;');
  });
});

describe('00320: merges', () => {
  it('restates merge_players_disposable as 00311 had it plus the three dismissal columns', () => {
    expect(latestBody('merge_players_disposable')?.file).toMatch(/^00320_/);
    const before = disposableRows('00311_');
    expect(before).toHaveLength(31);
    const after = disposableRows('00320_');
    expect(after).toHaveLength(34);
    expect(after.sort()).toEqual(
      [
        ...before,
        'possible_duplicate_dismissals.player_a',
        'possible_duplicate_dismissals.player_b',
        'possible_duplicate_dismissals.dismissed_by',
      ].sort(),
    );
  });

  it('revokes the function from PUBLIC, anon and authenticated', () => {
    const sql = migration();
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;');
  });

  it('verifies the count, the merge guard and the grants', () => {
    const verify = migration().slice(migration().indexOf('DO $verify$'));
    expect(verify).toContain('merge_players_disposable()) <> 34');
    expect(verify).toContain('FROM public.merge_players_unhandled()');
    expect(verify).toContain("has_function_privilege('anon', 'public.touch_last_seen()', 'EXECUTE')");
    expect(verify).toContain("has_column_privilege('authenticated', 'public.players', 'last_seen_at', 'UPDATE')");
    expect(verify).toContain("has_table_privilege('authenticated', 'public.possible_duplicate_dismissals', 'SELECT')");
  });
});
