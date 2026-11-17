import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00336: A SIGN-UP REMEMBERS RESUBMISSION AND STUDENT ANSWERS.
 *
 * The Form reader writes three plain columns per sign-up through one service
 * role function that finds its rows as record_form_partner_note (00299) does,
 * and a non-member admitted into the linked tournament keeps their answers.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');
const ROLLBACKS_DIR = join(__dirname, '../../../../supabase/rollbacks');
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
const migration = () => migrationOf('00336_');

const SIGNATURE = 'public.record_form_signup_answers(uuid, text, boolean, boolean, boolean, boolean)';

describe('00336: the columns', () => {
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
  });

  it('adds the three columns on both tables, with no player reference', () => {
    for (const table of ['club_event_signups', 'club_event_external_signups']) {
      for (const column of ['resubmission', 'resubmission_replaced', 'sfu_student']) {
        expect(sql).toContain(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS ${column} boolean;`);
      }
    }
    expect(sql).not.toContain('REFERENCES public.players');
  });
});

describe('00336: the reader writes the answers', () => {
  const latest = latestBody('record_form_signup_answers');
  const code = stripComments(latest?.body ?? '');

  it('is defined in 00336', () => {
    expect(latest?.file).toMatch(/^00336_/);
  });

  it('is a security definer with a pinned search path', () => {
    const sql = migration();
    const head = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.record_form_signup_answers('));
    const header = head.slice(0, head.indexOf('AS $function$'));
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('calls a response replaced when an earlier import was superseded by it', () => {
    expect(code).toContain('p.superseded_by = v_import');
  });

  it('touches none of the partner columns', () => {
    expect(code).not.toContain('preferred_partner');
  });

  it('is the service role\'s only', () => {
    const sql = migration();
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC, anon, authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role;`);
    expect(sql).toContain("has_function_privilege('anon', 'public.record_form_signup_answers(");
  });

  it('leaves record_form_partner_note as 00299 wrote it', () => {
    expect(latestBody('record_form_partner_note')?.file).toMatch(/^00299_/);
  });
});

describe('00336: a non-member who enters the tournament keeps their answers', () => {
  const latest = latestBody('club_event_link_admit_external');
  const code = stripComments(latest?.body ?? '');
  const insert = code.slice(code.indexOf('INSERT INTO club_event_signups'));

  it('is defined in 00336', () => {
    expect(latest?.file).toMatch(/^00336_/);
  });

  it('carries the three answers onto the member row, without overwriting one already there', () => {
    expect(insert).toContain('resubmission, resubmission_replaced, sfu_student)');
    expect(insert).toContain('v_x.resubmission, v_x.resubmission_replaced, v_x.sfu_student)');
    expect(insert).toContain('resubmission = coalesce(club_event_signups.resubmission, EXCLUDED.resubmission)');
    expect(insert).toContain('sfu_student = coalesce(club_event_signups.sfu_student, EXCLUDED.sfu_student)');
    expect(insert.indexOf('ON CONFLICT')).toBeLessThan(insert.indexOf('INSERT INTO audit_logs'));
  });

  it('is otherwise 00311\'s body', () => {
    const before = latestBodyIn('00311_', 'club_event_link_admit_external');
    const strip = (body: string) =>
      stripComments(body.slice(0, body.indexOf('INSERT INTO club_event_signups'))).replace(/\s+/g, ' ');
    expect(strip(latest?.body ?? '')).toBe(strip(before));
    const tail = (body: string) => body.slice(body.indexOf('INSERT INTO audit_logs'));
    expect(tail(latest?.body ?? '')).toBe(tail(before));
  });

  it('stays unreachable by client roles', () => {
    expect(migration()).toContain(
      'REVOKE ALL ON FUNCTION public.club_event_link_admit_external(uuid) FROM PUBLIC, anon, authenticated;',
    );
  });
});

describe('00336: the rollback', () => {
  it.skipIf(!existsSync(join(ROLLBACKS_DIR, '00336_down.sql')))('drops the function and restates 00311\'s admit', () => {
    const down = readFileSync(join(ROLLBACKS_DIR, '00336_down.sql'), 'utf8');
    expect(down).toContain(`DROP FUNCTION IF EXISTS ${SIGNATURE};`);
    expect(down).toContain('CREATE OR REPLACE FUNCTION public.club_event_link_admit_external(p_external_id uuid)');
    expect(stripComments(down)).not.toContain('sfu_student');
  });
});

/** One file's CREATE of a function, body bounded by its own dollar tag. */
function latestBodyIn(prefix: string, name: string): string {
  const sql = migrationOf(prefix);
  const match = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, 'i').exec(sql);
  if (!match) return '';
  const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(sql.slice(match.index))!;
  const bodyStart = match.index + open.index + open[0].length;
  return sql.slice(bodyStart, sql.indexOf(open[1]!, bodyStart));
}
