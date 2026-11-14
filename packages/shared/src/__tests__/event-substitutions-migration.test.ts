import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00327: SUBSTITUTIONS.
 *
 * One function rewrites an entry's people in place, after writing who played
 * every decided match into tournament_matches.lineup, under the field lock,
 * then the tournament row, then the event row. The record table is the service
 * role's alone, its three player columns join merge_players_disposable, and no
 * entry path is restated.
 */

const SUPABASE_DIR = join(__dirname, '../../../../supabase');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');
const ROLLBACKS_DIR = join(SUPABASE_DIR, 'rollbacks');

const migrationOf = (prefix: string) => {
  const file = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).find((f) => f.startsWith(prefix));
  return readFileSync(join(MIGRATIONS_DIR, file!), 'utf8');
};
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const disposableStatement = (sql: string) => {
  const at = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.merge_players_disposable()');
  return sql.slice(at, sql.indexOf('$function$;', at));
};
const disposableRows = (sql: string) =>
  [...disposableStatement(sql).matchAll(/\('([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);

const SQL = migrationOf('00327_');
const CODE = stripComments(SQL);
const SIGNATURE = 'substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer)';

function body(): string {
  const at = CODE.indexOf('CREATE OR REPLACE FUNCTION public.substitute_event_entry(');
  expect(at).toBeGreaterThan(-1);
  const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(CODE.slice(at))!;
  const start = at + open.index + open[0].length;
  return CODE.slice(start, CODE.indexOf(open[1]!, start));
}

describe('00327: shape', () => {
  it('runs in one transaction, checks first and reloads the schema cache last', () => {
    expect(CODE).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(CODE.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
    expect(CODE.indexOf('DO $pre$')).toBeGreaterThan(-1);
    expect(CODE.indexOf('DO $pre$')).toBeLessThan(CODE.search(/CREATE (TABLE|OR REPLACE FUNCTION)/));
    expect(CODE).toContain('DO $verify$');
  });

  it('keeps the record the service role\'s alone', () => {
    expect(CODE).toContain('ALTER TABLE public.event_substitutions ENABLE ROW LEVEL SECURITY;');
    expect(CODE).toContain('REVOKE ALL ON public.event_substitutions FROM PUBLIC, anon, authenticated;');
    expect(CODE).toContain('GRANT ALL ON public.event_substitutions TO service_role;');
    expect(CODE).not.toMatch(/CREATE POLICY[\s\S]{0,80}event_substitutions/);
    expect(CODE).toContain(`REVOKE ALL ON FUNCTION public.${SIGNATURE} FROM PUBLIC, anon, authenticated;`);
    expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION public.${SIGNATURE} TO service_role;`);
  });

  it('adds the lineup as a nullable object', () => {
    expect(CODE).toContain('ADD COLUMN IF NOT EXISTS lineup jsonb;');
    expect(CODE).toContain("CHECK (lineup IS NULL OR jsonb_typeof(lineup) = 'object')");
  });
});

describe('00327: the substitution', () => {
  it('takes the field lock, then the tournament, then the event', () => {
    const code = body();
    const advisory = code.indexOf("pg_advisory_xact_lock(hashtext('tournament_event_field')");
    const tournament = code.search(/FROM tournaments t WHERE t\.id = v_tournament FOR UPDATE/);
    const event = code.search(/FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE/);
    expect(advisory).toBeGreaterThan(-1);
    expect(tournament).toBeGreaterThan(advisory);
    expect(event).toBeGreaterThan(tournament);
  });

  it('writes the lineup before the people change, and never overwrites one', () => {
    const code = body();
    const lineup = code.indexOf('SET lineup = COALESCE(m.lineup');
    expect(lineup).toBeGreaterThan(-1);
    expect(code.indexOf('UPDATE tournament_pairs')).toBeGreaterThan(lineup);
    expect(code).toContain('AND NOT (COALESCE(m.lineup');
  });

  it('refuses a person on court, a double entry, somebody not entered and a restricted member', () => {
    const code = body();
    for (const reason of ['on_court', 'already_in_event', 'not_entered', 'restricted', 'entry_out', 'not_in_entry']) {
      expect(code, reason).toContain(`'reason', '${reason}'`);
    }
    expect(code).toContain('IF NOT p_allow_restricted AND EXISTS (');
  });

  it('restates no entry path', () => {
    for (const name of [
      'set_field_entry_status',
      'publish_stage_draw',
      'set_pair_member_check_in',
      'fill_event_from_waitlist',
      'enter_tournament_event',
      'add_participants_under_field_lock',
    ]) {
      expect(CODE, name).not.toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\(`, 'i'));
    }
  });
});

describe('00327: merges', () => {
  it('restates merge_players_disposable as 00324 had it plus the three new columns', () => {
    const before = disposableRows(migrationOf('00324_'));
    const after = disposableRows(SQL);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.filter((row) => !before.includes(row)).sort()).toEqual([
      'event_substitutions.incoming_player_id',
      'event_substitutions.made_by',
      'event_substitutions.outgoing_player_id',
    ]);
    expect(after).toHaveLength(47);
    expect(CODE).toContain('merge_players_disposable()) <> 47');
  });
});

// supabase/rollbacks is private; skipped on the exported tree.
describe.skipIf(!existsSync(ROLLBACKS_DIR))('00327: the down script', () => {
  it('drops what it added and restates 00324\'s merge_players_disposable verbatim', () => {
    const down = readFileSync(join(ROLLBACKS_DIR, '00327_down.sql'), 'utf8');
    expect(disposableStatement(down)).toBe(disposableStatement(migrationOf('00324_')));
    expect(down).toContain(`DROP FUNCTION IF EXISTS public.${SIGNATURE};`);
    expect(down).toContain('DROP TABLE IF EXISTS public.event_substitutions;');
    expect(down).toContain('DROP COLUMN IF EXISTS lineup;');
  });
});
