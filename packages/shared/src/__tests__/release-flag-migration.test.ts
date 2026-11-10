import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00318: THE CHECK-IN-AFTER-THE-DRAW KILL SWITCH, AND THE DOWN SCRIPTS.
 *
 * release_flag_on is byte-identical to 00316's on the ladder branch, so the
 * two CREATE OR REPLACE statements converge. Each function 00315 restated asks
 * the switch for its new branch only. Each of 00315, 00317 and 00318 has a
 * hand-run down script under supabase/rollbacks that restates the previous
 * definition verbatim, and that directory is not exported. The club-changes
 * trigger (00286) is restated to skip the kill switches row, so a flip is
 * never drafted as member news.
 */

const SUPABASE_DIR = join(__dirname, '../../../../supabase');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');
const ROLLBACKS_DIR = join(SUPABASE_DIR, 'rollbacks');
const INCLUDE_TXT = join(__dirname, '../../../../.github/export/include.txt');

const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const migration = (version: string) =>
  readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith(`${version}_`))!), 'utf8');
const rollback = (version: string) => readFileSync(join(ROLLBACKS_DIR, `${version}_down.sql`), 'utf8');

/** The last whole CREATE OR REPLACE statement of a function in some SQL, up to its closing tag. */
function lastStatement(sql: string, name: string): string | null {
  const head = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const at = sql.lastIndexOf(head);
  if (at === -1) return null;
  const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(sql.slice(at));
  if (!open) return null;
  const bodyStart = at + open.index + open[0].length;
  const end = sql.indexOf(`${open[1]!};`, bodyStart);
  return end === -1 ? null : sql.slice(at, end + open[1]!.length + 1);
}

/** The latest CREATE of a function across the migrations, and its file. */
function latest(name: string): { file: string; statement: string } | null {
  let found: { file: string; statement: string } | null = null;
  for (const file of migrationFiles()) {
    const statement = lastStatement(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'), name);
    if (statement) found = { file, statement };
  }
  return found;
}

const SWITCH = "(SELECT public.release_flag_on('check_in_after_draw'))";

const RELEASE_FLAG_ON = `CREATE OR REPLACE FUNCTION public.release_flag_on(p_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.platform_settings ps
    WHERE ps.key = 'release_flags'
      AND ps.value -> p_id = 'false'::jsonb
  );
$function$;
REVOKE ALL ON FUNCTION public.release_flag_on(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_flag_on(text) TO anon, authenticated, service_role;`;

describe('00318: release_flag_on', () => {
  it('is created byte-identical to the agreed definition, grants included', () => {
    expect(migration('00318')).toContain(RELEASE_FLAG_ON);
  });
});

describe('00318: the three functions ask the switch for their new branch only', () => {
  it('restates each one last', () => {
    for (const name of ['publish_stage_draw', 'set_field_entry_status', 'set_pair_member_check_in']) {
      expect(latest(name)?.file, name).toMatch(/^00318_/);
    }
  });

  it('publish_stage_draw draws checked-in only while the switch is on', () => {
    const code = latest('publish_stage_draw')!.statement;
    expect(code.split(`v_uses_checkin := ${SWITCH} AND EXISTS`).length - 1).toBe(2);
  });

  it('the undo past the draw is taken only while the switch is on', () => {
    for (const name of ['set_field_entry_status', 'set_pair_member_check_in']) {
      const code = latest(name)!.statement;
      expect(code, name).toContain(`IF v_status = 'registration'\n       OR (NOT ${SWITCH} AND v_status <> 'checkin') THEN`);
    }
  });

  it('is otherwise 00315 to the character', () => {
    const before = migration('00315');
    const after = migration('00318');
    for (const name of ['publish_stage_draw', 'set_field_entry_status', 'set_pair_member_check_in']) {
      const strip = (sql: string) =>
        sql
          .replace(/^[ \t]*--[^\n]*\n/gm, '')
          .replace(`\n       OR (NOT ${SWITCH} AND v_status <> 'checkin')`, '')
          .replaceAll(`v_uses_checkin := ${SWITCH} AND `, 'v_uses_checkin := ');
      expect(strip(lastStatement(after, name)!), name).toBe(strip(lastStatement(before, name)!));
    }
  });
});

const TRIGGER = 'club_change_from_platform_settings';
const SKIP = `  -- A kill switch is console-only, never member news: no draft.
  IF NEW.key = 'release_flags' THEN
    RETURN NULL;
  END IF;

`;

describe('00318: a kill switch save drafts no club change', () => {
  it('restates the 00286 trigger function last', () => {
    expect(latest(TRIGGER)?.file).toMatch(/^00318_/);
  });

  it('returns before any draft when the row is release_flags', () => {
    const code = latest(TRIGGER)!.statement;
    expect(code).toContain(`BEGIN\n${SKIP}  IF NEW.updated_by IS NULL`);
    expect(code.indexOf("IF NEW.key = 'release_flags' THEN")).toBeLessThan(code.indexOf('club_change_upsert'));
  });

  it('is otherwise 00286 to the character, its revoke kept', () => {
    expect(lastStatement(migration('00318'), TRIGGER)!.replace(SKIP, '')).toBe(lastStatement(migration('00286'), TRIGGER));
    expect(migration('00318')).toContain(`REVOKE ALL ON FUNCTION public.${TRIGGER}() FROM PUBLIC, anon, authenticated;`);
  });
});

describe('the down scripts', () => {
  it('exist for 00315, 00317, 00318, 00322 and 00323', () => {
    for (const v of ['00315', '00317', '00318', '00322', '00323']) expect(existsSync(join(ROLLBACKS_DIR, `${v}_down.sql`)), v).toBe(true);
  });

  it('00315_down restates 00272, 00276 and 00309 verbatim', () => {
    const down = rollback('00315');
    expect(lastStatement(down, 'publish_stage_draw')).toBe(lastStatement(migration('00272'), 'publish_stage_draw'));
    expect(lastStatement(down, 'set_field_entry_status')).toBe(lastStatement(migration('00276'), 'set_field_entry_status'));
    expect(lastStatement(down, 'set_pair_member_check_in')).toBe(lastStatement(migration('00309'), 'set_pair_member_check_in'));
  });

  it('00318_down restates 00315 verbatim and drops release_flag_on only when nothing asks it', () => {
    const down = rollback('00318');
    for (const name of ['publish_stage_draw', 'set_field_entry_status', 'set_pair_member_check_in']) {
      expect(lastStatement(down, name), name).toBe(lastStatement(migration('00315'), name));
    }
    expect(lastStatement(down, TRIGGER)).toBe(lastStatement(migration('00286'), TRIGGER));
    expect(down).toContain(`REVOKE ALL ON FUNCTION public.${TRIGGER}() FROM PUBLIC, anon, authenticated;`);
    expect(down).toContain("p.prosrc LIKE '%release_flag_on%'");
    expect(down).toContain('DROP FUNCTION IF EXISTS public.release_flag_on(text);');
  });

  it('00322_down restates 00317\'s club_event_desk_entry_walk_in verbatim, grants included', () => {
    const down = rollback('00322');
    const name = 'club_event_desk_entry_walk_in';
    expect(lastStatement(down, name)).not.toBeNull();
    expect(lastStatement(down, name)).toBe(lastStatement(migration('00317'), name));
    expect(down).toContain('REVOKE ALL ON FUNCTION public.club_event_desk_entry_walk_in(uuid, uuid[]) FROM PUBLIC, anon, authenticated;');
    expect(down).toContain('GRANT EXECUTE ON FUNCTION public.club_event_desk_entry_walk_in(uuid, uuid[]) TO service_role;');
  });

  it('00323_down restates 00233\'s purgeable_unfinished_signups verbatim, comment and grants included', () => {
    const view = (sql: string) => {
      const at = sql.lastIndexOf('CREATE OR REPLACE VIEW purgeable_unfinished_signups AS');
      return at === -1 ? null : sql.slice(at, sql.indexOf(';', at) + 1);
    };
    const comment = (sql: string) => /COMMENT ON VIEW purgeable_unfinished_signups IS\n[^\n]*\n/.exec(sql)?.[0] ?? null;
    const down = rollback('00323');
    expect(view(down)).not.toBeNull();
    expect(view(down)).toBe(view(migration('00233')));
    expect(comment(down)).toBe(comment(migration('00233')));
    expect(down).toContain('REVOKE ALL ON purgeable_unfinished_signups FROM PUBLIC, anon, authenticated;');
    expect(down).toContain('GRANT SELECT ON purgeable_unfinished_signups TO service_role;');
  });

  it('00317_down drops the two functions 00317 created', () => {
    const down = rollback('00317');
    expect(down).toContain('DROP FUNCTION IF EXISTS public.create_desk_guest(text, uuid);');
    expect(down).toContain('DROP FUNCTION IF EXISTS public.club_event_desk_entry_walk_in(uuid, uuid[]);');
  });

  it('keep each grant, service_role only', () => {
    for (const v of ['00315', '00318']) {
      const down = rollback(v);
      for (const sig of [
        'publish_stage_draw(uuid, smallint, uuid, boolean, uuid[], jsonb, jsonb)',
        'set_field_entry_status(uuid, boolean, text, uuid)',
        'set_pair_member_check_in(uuid, smallint, boolean, uuid)',
      ]) {
        expect(down, `${v} ${sig}`).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
        expect(down, `${v} ${sig}`).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
      }
    }
  });

  it('are never exported: the default-deny include list does not name supabase/rollbacks', () => {
    const lines = readFileSync(INCLUDE_TXT, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines.some((l) => !l.startsWith('!') && (l.startsWith('supabase/rollbacks') || l === 'supabase/**'))).toBe(false);
  });
});
