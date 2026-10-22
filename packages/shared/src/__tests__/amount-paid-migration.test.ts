import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00300, READ OFF DISK: confirming a receipt records the amount the exec says
// was paid, on both of review_fee_submission_confirm's settling paths.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');
const name = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith('_a_reviewed_receipt_records_the_amount_paid.sql'));
const sql = readFileSync(join(MIGRATIONS_DIR, name!), 'utf8');

describe('00300 a reviewed receipt records the amount paid', () => {
  it('drops the four-argument confirm before creating the five-argument one', () => {
    const drop = sql.indexOf('DROP FUNCTION IF EXISTS public.review_fee_submission_confirm(uuid, uuid, text, text);');
    const create = sql.indexOf('CREATE OR REPLACE FUNCTION public.review_fee_submission_confirm(');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(sql).toContain('p_amount_cents integer DEFAULT NULL');
  });

  it('writes the amount on both the Form path and the referenced path', () => {
    const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('$function$;'));
    expect(body.match(/amount_cents = coalesce\(p_amount_cents, amount_cents\)/g)).toHaveLength(2);
    expect(body).toContain('IF p_amount_cents IS NOT NULL AND (p_amount_cents <= 0 OR p_amount_cents > 1000000) THEN');
  });

  it('runs as its owner for the service role only', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text, integer) TO service_role;',
    );
  });

  it('commits, then reloads the PostgREST schema', () => {
    expect(sql.trimEnd()).toMatch(/COMMIT;\s+NOTIFY pgrst, 'reload schema';$/);
  });
});
