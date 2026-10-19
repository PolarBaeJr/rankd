import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00290, READ OFF DISK. A Google Form linked to a SEASON files each response's
// e-transfer screenshot against that person's dues for the season: a member's
// own row (made when missing, priced by status), or a named row for somebody
// with no account. The import makes no entry and answers one result row. The
// scenario that proves it end to end (members by tier, a non-member, a name
// already taken, a replay, a purged member, the later claim) was run against a
// local database inside a rolled-back transaction.

const REPO = join(__dirname, '../../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

function fn(sql: string, signature: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`);
  if (start < 0) throw new Error(`${signature} is not defined`);
  return sql.slice(start, sql.indexOf('$function$;', start));
}

const sql = migration('00290_');
const apply = fn(sql, 'registration_import_apply(');
const door = fn(sql, 'forms_api_import_registration(');
const claim = fn(sql, 'claim_registration_form_polls(');
const file = fn(sql, 'file_registration_import_receipts(');
const previousApply = fn(migration('00289_'), 'registration_import_apply(');

describe('00290 a season takes its form', () => {
  it('refuses to run before 00289 and is one transaction that reloads PostgREST', () => {
    const pre = sql.slice(sql.indexOf('DO $pre$'), sql.indexOf('$pre$;'));
    expect(pre).toContain("to_regprocedure('public.club_event_form_alerts_on_publish()') IS NULL");
    expect(pre).toContain("RAISE EXCEPTION '00290 needs 00289");
    expect(sql).toMatch(/\nBEGIN;\n/);
    expect(sql.trimEnd().endsWith("COMMIT;\n\nNOTIFY pgrst, 'reload schema';")).toBe(true);
    expect(sql).toContain('DO $verify$');
  });

  it('adds the season target and keeps every binding to one target', () => {
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES public.seasons(id) ON DELETE SET NULL;',
    );
    expect(sql).toContain("CHECK (target_kind IN ('tournament', 'club_event', 'season'))");
    expect(sql).toContain('CHECK (num_nonnulls(tournament_id, club_event_id, season_id) <= 1');
    expect(sql).toContain("AND (season_id IS NULL OR target_kind = 'season')");
    expect(sql).toContain("AND (tournament_id IS NULL OR target_kind = 'tournament')");
    expect(sql).toContain("AND (club_event_id IS NULL OR target_kind = 'club_event')");
  });

  it('counts a season as a target at every door', () => {
    for (const body of [apply, door]) {
      expect(body).toContain('num_nonnulls(v_binding.tournament_id, v_binding.club_event_id, v_binding.season_id) = 0');
    }
    expect(claim).toContain('num_nonnulls(f.tournament_id, f.club_event_id, f.season_id) = 1');
    // The poll's claim keeps its return shape: adding a column would need a DROP.
    expect(claim).toContain(
      'RETURNS TABLE(id uuid, form_id text, target_kind text, tournament_id uuid, club_event_id uuid,',
    );
  });

  it("answers a season's response with one pending row, before any lock or entry", () => {
    const branch = apply.slice(apply.indexOf("IF v_binding.target_kind = 'season' THEN"));
    const end = branch.indexOf('-- ---- the events asked for ----');
    const season = branch.slice(0, end);
    expect(apply.indexOf("IF v_binding.target_kind = 'season' THEN")).toBeLessThan(
      apply.indexOf('-- ---- the locks, all at top level'),
    );
    expect(apply.indexOf("IF v_binding.target_kind = 'season' THEN")).toBeGreaterThan(
      apply.indexOf('-- ---- an earlier response by the same person is superseded ----'),
    );
    expect(season).toContain("'item', 1, 'event_id', NULL, 'status', 'pending', 'reason', NULL");
    expect(season).toContain('UPDATE registration_imports SET superseded_by = v_import.id');
    expect(season).toContain("'registration_imported'");
    expect(season).not.toContain('registration_import_entries');
    expect(season).not.toContain('club_event_external_sign_up');
    expect(season.match(/RETURN NEXT;\s*RETURN;/g)).toHaveLength(1);
  });

  it("keeps 00289's draft event handling, and the rest of 00289's body, in the import", () => {
    expect(apply).toContain("IF v_club.status NOT IN ('draft', 'published') OR v_club.starts_at <= now() THEN");
    expect(apply).toContain("IF v_status = 'awaiting_member' AND v_club.status = 'published' THEN");
    const added = apply.slice(
      apply.indexOf('  -- ---- 00290'),
      apply.indexOf('  -- ---- the events asked for ----'),
    );
    const restored = apply
      .replace(added, '')
      .replace(', v_binding.season_id) = 0', ') = 0');
    expect(restored).toBe(previousApply);
  });

  it("files a season's receipt on the person's dues for the linked season", () => {
    const arm = file.slice(
      file.indexOf("IF v_binding.target_kind = 'season' THEN"),
      file.indexOf('SELECT en.fee_id INTO v_fee_id'),
    );
    expect(file.indexOf("IF v_binding.target_kind = 'season' THEN")).toBeLessThan(
      file.indexOf('SELECT en.fee_id INTO v_fee_id'),
    );
    expect(arm).toContain('WHERE s.id = v_binding.season_id');
    expect(arm).not.toContain('active_flag');
    // Never charged.
    expect(arm).toContain('IF v_payer.is_exec OR v_payer.fee_exempt OR v_payer.is_banned');
    expect(arm).toContain('OR v_payer.deletion_requested_at IS NOT NULL');
    expect(arm).toContain("OR COALESCE(v_payer.email, '') LIKE '%@deleted.invalid' THEN");
    expect(arm).not.toContain('pending_approval');
    // Priced as /fees prices a member.
    expect(arm).toContain(
      "v_price := CASE WHEN v_payer.status = 'competitive' THEN v_season.competitive_fee_cents",
    );
    expect(arm).toContain('ON CONFLICT (player_id, season_id) WHERE fee_type = \'dues\' AND player_id IS NOT NULL');
    // A non-member: a named row at the recreational price, on the per-email key.
    expect(arm).toContain('v_price := v_season.recreational_fee_cents;');
    expect(arm).toContain(
      "WHERE player_id IS NULL AND fee_type = 'dues' AND manual_email IS NOT NULL",
    );
    // A name taken this season gets the receipt's first eight characters.
    expect(arm).toContain('EXCEPTION WHEN unique_violation THEN');
    expect(arm).toContain("v_import.submitter_name || ' ' || left(v_receipt.id::text, 8)");
    // A non-member who has made an account since is a member.
    expect(arm).toContain('lower(btrim(p.email)) = v_import.submitter_email');
    // An exec's row with no amount gets one, so it can be confirmed.
    expect(arm).toContain('WHERE id = v_fee_id AND amount_cents IS NULL AND paid_at IS NULL;');
    // One fault leaves one receipt pending, not the batch rolled back.
    expect(arm).toContain('EXCEPTION WHEN OTHERS THEN');
  });

  it("files the submission exactly as 00288 does, and never asks a season for entries", () => {
    expect(file).toContain(
      "INSERT INTO fee_submissions (club_fee_id, player_id, reference, method, screenshot_path, import_receipt_id)",
    );
    expect(file).toContain("VALUES (v_fee.id, v_fee.player_id, NULL, 'e_transfer', v_receipt.storage_path, v_receipt.id)");
    expect(file).toContain("v_outcome := 'fee_settled';");
    expect(file).toContain("v_outcome := 'duplicate';");
    expect(file).toContain("ELSIF v_binding.target_kind IS DISTINCT FROM 'season' THEN");
  });

  it('keeps every grant as it was', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.registration_import_apply(uuid, uuid, text, jsonb)\n  FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(sql).not.toMatch(/GRANT[^;]*registration_import_apply/);
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.forms_api_import_registration(uuid, jsonb) TO service_role;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.claim_registration_form_polls(integer, integer) TO service_role;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.file_registration_import_receipts(integer) TO service_role;');
    for (const body of [apply, door, claim, file]) {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    }
  });

  it('has no em dash', () => {
    expect(sql).not.toContain(String.fromCharCode(0x2014));
  });
});
