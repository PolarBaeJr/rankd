import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00316: THE LADDER COUNTS DOUBLES POINTS.
 *
 * A doubles event writes its finish points onto tournament_pairs, and
 * get_leaderboard() summed tournament_participants alone, so the Tournament
 * Points ladder was empty after a doubles event. The restated function sums
 * both, credits a team's points to both partners, and keeps the grant the
 * signed-out ladder depends on. The pair arms sit behind the
 * ladder_doubles_points release flag, read by release_flag_on().
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
const migration = () => readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith('00316_'))!), 'utf8');

describe('00316: get_leaderboard counts doubles points', () => {
  const latest = latestBody('get_leaderboard');
  const body = stripComments(latest?.body ?? '');
  const sql = migration();
  const code = stripComments(sql);

  it('is defined last in 00316', () => {
    expect(latest?.file).toMatch(/^00316_/);
  });

  it('sums tournament_pairs beside tournament_participants', () => {
    expect(body).toMatch(/FROM tournament_participants tpa/);
    expect(body).toMatch(/FROM tournament_pairs tpr/);
    expect(body).toMatch(/SUM\(earned\.points\)/);
  });

  it('credits a team to both partners, members only', () => {
    expect(body).toMatch(/SELECT tpr\.player1_id, tpr\.points/);
    expect(body).toMatch(/SELECT tpr\.player2_id, tpr\.points/);
    expect(body).toMatch(/tpr\.player1_id IS NOT NULL/);
    expect(body).toMatch(/tpr\.player2_id IS NOT NULL/);
  });

  it('applies the participants status filter to every arm', () => {
    const filters = body.match(/status NOT IN \('withdrawn', 'disqualified'\) AND t\w+\.points > 0/g) ?? [];
    expect(filters).toHaveLength(3);
  });

  it('keeps the outer visibility predicates', () => {
    expect(body).toMatch(/p\.active_flag = TRUE/);
    expect(body).toMatch(/p\.hide_from_leaderboard = FALSE/);
    expect(body).toMatch(/p\.status NOT IN \('pending_approval', 'suspended'\)/);
  });

  it('stays SECURITY DEFINER with a pinned search_path', () => {
    expect(code).toMatch(/STABLE SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
  });

  it('revokes then grants the same roles back, anon included', () => {
    const revoke = code.indexOf('REVOKE ALL ON FUNCTION public.get_leaderboard() FROM PUBLIC, anon, authenticated;');
    const grant = code.indexOf('GRANT EXECUTE ON FUNCTION public.get_leaderboard() TO authenticated, anon, service_role;');
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(revoke);
  });

  it('counts the pair arms only while the ladder_doubles_points flag is on', () => {
    const gates = body.match(/AND \(SELECT public\.release_flag_on\('ladder_doubles_points'\)\)/g) ?? [];
    expect(gates).toHaveLength(2);
    const participants = body.slice(body.indexOf('FROM tournament_participants tpa'), body.indexOf('UNION ALL'));
    expect(participants).not.toMatch(/release_flag_on/);
  });

  it('creates release_flag_on: off only on a literal JSON false', () => {
    const helper = stripComments(latestBody('release_flag_on')?.body ?? '');
    expect(helper).toMatch(/NOT EXISTS/);
    expect(helper).toMatch(/ps\.key = 'release_flags'/);
    expect(helper).toMatch(/ps\.value -> p_id = 'false'::jsonb/);
    expect(code).toMatch(
      /CREATE OR REPLACE FUNCTION public\.release_flag_on\(p_id text\)\s+RETURNS boolean\s+LANGUAGE sql\s+STABLE SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/,
    );
  });

  it('revokes release_flag_on then grants it to anon, authenticated and service_role', () => {
    const revoke = code.indexOf('REVOKE ALL ON FUNCTION public.release_flag_on(text) FROM PUBLIC, anon, authenticated;');
    const grant = code.indexOf('GRANT EXECUTE ON FUNCTION public.release_flag_on(text) TO anon, authenticated, service_role;');
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(revoke);
    expect(grant).toBeLessThan(code.indexOf('CREATE OR REPLACE FUNCTION public.get_leaderboard()'));
  });

  it('has a hand-run rollback restating 00092 with its grant', () => {
    const down = readFileSync(join(MIGRATIONS_DIR, '../rollbacks/00316_down.sql'), 'utf8');
    const original = readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith('00092_'))!), 'utf8');
    const bodyOf = (text: string) =>
      /CREATE (?:OR REPLACE )?FUNCTION public\.get_leaderboard\(\)[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/.exec(text)?.[1];
    expect(bodyOf(down)).toBeDefined();
    expect(bodyOf(down)).toBe(bodyOf(original));
    expect(down).toContain('GRANT EXECUTE ON FUNCTION public.get_leaderboard() TO authenticated, anon, service_role;');
    expect(down).not.toContain('\u2014');
  });

  it('has no top-level COMMIT and reloads the PostgREST schema', () => {
    expect(code).not.toMatch(/^\s*COMMIT\s*;/m);
    expect(sql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';$/);
  });

  it('has no em dash', () => {
    expect(sql).not.toContain('—');
  });
});
