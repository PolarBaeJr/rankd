import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPT_FLAGS } from '../utils/receipt-read';
import { ETRANSFER_DISPLAY_REFERENCE_PATTERN } from '../utils/etransfer-reference';

// 00297, READ OFF DISK. The flags, the hidden e-transfer shape and the order of
// the writes are each written twice, once in SQL and once in TypeScript; this
// keeps them one rule, so a later edit fails here before it reaches a database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(suffix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(suffix));
  if (!name) throw new Error(`no migration ending ${suffix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('_a_read_receipt_confirms_itself.sql');

function functionBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
}

const RPCS: [string, string][] = [
  ['claim_fee_submission_ocr', 'uuid, integer'],
  ['flag_fee_submission_ocr', 'uuid, text, text, text, text'],
  ['auto_confirm_fee_submission', 'uuid, text, text, text, integer'],
  ['undo_auto_confirmed_fee_submission', 'uuid, uuid, text'],
  ['review_fee_submission_confirm', 'uuid, uuid, text, text'],
];

describe('00297 a read receipt confirms itself', () => {
  it('accepts exactly the flags the server can raise', () => {
    const check = /fee_submissions_ocr_flag_check\s+CHECK \(ocr_flag IS NULL OR ocr_flag IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const flags = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(flags.sort()).toEqual([...RECEIPT_FLAGS].sort());
  });

  it('checks the hidden e-transfer shape the way the app does', () => {
    const shape = ETRANSFER_DISPLAY_REFERENCE_PATTERN.source.replace('(?:', '(');
    const quoted = [...sql.matchAll(/~ '(\^\[A-Za-z0-9\]\[A-Za-z0-9\*-\][^']*)'/g)].map((m) => m[1]);
    // The table CHECK, auto_confirm and review_fee_submission_confirm.
    expect(quoted).toHaveLength(3);
    for (const q of quoted) expect(q).toBe(shape);
  });

  it('runs every RPC as its owner with a pinned search_path, for service_role only', () => {
    for (const [name, args] of RPCS) {
      const body = functionBody(name);
      expect(body, name).toContain('SECURITY DEFINER');
      expect(body, name).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(sql, name).toContain(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated;`);
      expect(sql, name).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO service_role;`);
    }
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.fee_reference_key(text, text) FROM PUBLIC, anon, authenticated;');
  });

  it('claims with SKIP LOCKED, so two sweeps never read the same receipt', () => {
    expect(functionBody('claim_fee_submission_ocr')).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('closes the submission before it pays the fee (the 00248 supersede trigger)', () => {
    for (const name of ['auto_confirm_fee_submission', 'undo_auto_confirmed_fee_submission']) {
      const body = functionBody(name);
      const sub = body.indexOf('UPDATE fee_submissions');
      const fee = body.indexOf('UPDATE club_fees');
      expect(sub, name).toBeGreaterThan(-1);
      expect(fee, name).toBeGreaterThan(sub);
    }
  });

  it('writes its own audit rows, with no actor on an automatic confirmation', () => {
    expect(functionBody('auto_confirm_fee_submission')).toContain("'fee_submission_auto_confirmed'");
    expect(functionBody('undo_auto_confirmed_fee_submission')).toContain("'fee_submission_auto_confirm_undone'");
  });

  it('undoes only a fee nobody has marked since', () => {
    const body = functionBody('undo_auto_confirmed_fee_submission');
    expect(body).toContain('paid_at IS DISTINCT FROM');
    expect(body).toContain('marked_by IS NOT NULL');
  });

  it('never queues a receipt filed before it', () => {
    // Added without a default, then defaulted: existing rows stay NULL.
    const add = sql.indexOf('ADD COLUMN IF NOT EXISTS ocr_state');
    const setDefault = sql.indexOf("ALTER COLUMN ocr_state SET DEFAULT 'pending'");
    expect(add).toBeGreaterThan(-1);
    expect(setDefault).toBeGreaterThan(add);
    expect(sql.slice(add, sql.indexOf('\n', add))).not.toMatch(/DEFAULT/);
  });
});
