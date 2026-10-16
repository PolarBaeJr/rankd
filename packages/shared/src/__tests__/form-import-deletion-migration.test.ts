import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00285, READ OFF DISK. Anonymising a member takes their typed name and email
// out of everything the Google Form import (00283, 00284) stored under it:
// responses, entries, guest places, waiver invites, unclaimed named fees,
// external pairs, and the named-fee audit rows. It is a trigger on the purge's
// own UPDATE, so neither purge job can skip it and neither needs editing.
// The scenario that proves it end to end was run against a local database; the
// file's own verify block repeats a smaller version on every apply.

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

const sql = migration('00285_');
const scrub = fn(sql, 'scrub_registration_identity(p_player_id uuid, p_email text)');
const trigger = fn(sql, 'registration_import_forget_player()');

/** One UPDATE statement of the scrub, from its table to its semicolon. */
function update(table: string): string {
  const start = scrub.indexOf(`UPDATE ${table}`);
  expect(start, `the scrub never updates ${table}`).toBeGreaterThan(-1);
  return scrub.slice(start, scrub.indexOf(';', start));
}

describe('00285 deletion reaches the form import', () => {
  it('refuses to run before 00284 and is one transaction that reloads PostgREST', () => {
    const pre = sql.slice(sql.indexOf('DO $pre$'), sql.indexOf('$pre$;'));
    expect(pre).toContain("to_regclass('public.club_event_external_signups') IS NULL");
    expect(pre).toContain("attname = 'external_signup_id'");
    expect(pre).toContain("RAISE EXCEPTION '00285 needs 00284");
    expect(sql).toMatch(/\nBEGIN;\n/);
    expect(sql.trimEnd().endsWith("COMMIT;\n\nNOTIFY pgrst, 'reload schema';")).toBe(true);
  });

  it('pins both functions and gives them to nobody', () => {
    for (const body of [scrub, trigger]) {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain('SET search_path = public, pg_temp');
    }
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.scrub_registration_identity(uuid, text) FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.registration_import_forget_player() FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(sql).not.toMatch(/GRANT[^;]*scrub_registration_identity/);
    expect(sql).not.toMatch(/GRANT[^;]*registration_import_forget_player/);
  });

  it('fires on the marker the purge writes, the same predicate as 00282', () => {
    // anonymize.ts writes the marker; 00282 already keys a purge trigger on it.
    // All three must agree or the scrub silently never runs.
    const anonymize = readFileSync(join(REPO, 'supabase/functions/_shared/anonymize.ts'), 'utf8');
    expect(anonymize).toContain('email: `deleted+${playerId}@deleted.invalid`');
    const when = "WHEN (NEW.email LIKE 'deleted+%@deleted.invalid' AND OLD.email IS DISTINCT FROM NEW.email)";
    expect(migration('00282_')).toContain(when);
    const create = sql.slice(sql.indexOf('CREATE TRIGGER trg_registration_import_forget_player'));
    expect(create).toMatch(/^CREATE TRIGGER trg_registration_import_forget_player\s+AFTER UPDATE OF email ON public\.players\s+FOR EACH ROW/);
    expect(create).toContain(when);
    expect(create).toContain('EXECUTE FUNCTION public.registration_import_forget_player();');
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_registration_import_forget_player ON public.players;');
  });

  it('hands the scrub the address the member HAD, and never swallows a failure', () => {
    // NEW.email is already the marker; only OLD.email can find the typed rows.
    expect(trigger).toContain('PERFORM public.scrub_registration_identity(NEW.id, OLD.email);');
    // A swallowed error would anonymise the row and leave the typed identity
    // behind for good. A raise rolls the purge's UPDATE back, so it retries.
    expect(trigger).not.toContain('EXCEPTION');
    expect(scrub).not.toContain('EXCEPTION');
  });

  it('matches on the normalised address and never on the marker itself', () => {
    expect(scrub).toContain("NULLIF(lower(btrim(COALESCE(p_email, ''))), '')");
    expect(scrub).toContain("IF v_email LIKE '%@deleted.invalid' THEN");
  });

  it('also finds the address a member entered under before they changed it', () => {
    // A guest who joined with their entry address had the fee claimed onto
    // them; that fee still links their entry after an account email change,
    // and it is the only trail for members purged before 00285.
    expect(scrub).toContain('JOIN club_fees f ON f.id = en.fee_id');
    expect(scrub).toContain('WHERE f.player_id = p_player_id');
    expect(scrub).toContain('AND en.entrant_id IS NULL');
    expect(scrub).toContain("AND a.addr NOT LIKE '%@deleted.invalid'");
    // Every address-keyed statement matches the whole set, never one address.
    const keyed = scrub.slice(scrub.indexOf('IF cardinality(v_emails) > 0 THEN'));
    expect(keyed).not.toMatch(/= v_email\b/);
  });

  it('keeps every row: it rewrites identity and deletes nothing', () => {
    expect(scrub).not.toMatch(/\bDELETE\b/);
  });

  it('nulls the nullable typed columns of the import', () => {
    expect(update('registration_import_entries\n       SET external_name')).toContain(
      'SET external_name = NULL, external_email = NULL\n     WHERE external_email = ANY (v_emails)',
    );
    expect(update('registration_import_entries\n       SET partner_name')).toContain(
      'SET partner_name = NULL, partner_email = NULL\n     WHERE partner_email = ANY (v_emails)',
    );
    expect(update('registration_imports')).toContain(
      'SET submitter_name = NULL, submitter_email = NULL\n     WHERE submitter_email = ANY (v_emails)',
    );
  });

  it('gives NOT NULL addresses a per-ROW placeholder, so no unique key collides', () => {
    // Per row, not per player: every per-email unique key stays unique, and no
    // placeholder can ever equal a players.email the claim trigger reads.
    const signups = update('club_event_external_signups');
    expect(signups).toContain("full_name = 'Deleted Player'");
    expect(signups).toContain("email = 'deleted+' || id::text || '@deleted.invalid'");
    const invites = update('guest_waiver_invites');
    expect(invites).toContain("email = 'deleted+' || id::text || '@deleted.invalid'");
    expect(scrub).not.toContain("'deleted+' || p_player_id");
  });

  it('cancels an unsent invite, which the outbox would otherwise mail to a dead address', () => {
    const invites = update('guest_waiver_invites');
    expect(invites).toContain('cancelled_at = CASE WHEN sent_at IS NULL THEN COALESCE(cancelled_at, now())');
    // The claim does not skip deleted addresses on its own; this is why.
    const claim = fn(migration('00283_'), 'claim_guest_waiver_invites(p_limit integer, p_daily_cap integer)');
    expect(claim).not.toContain('deleted.invalid');
  });

  it('renames an unclaimed named fee without breaking the season name key', () => {
    const fees = update('club_fees f');
    expect(fees).toContain('WHERE f.player_id IS NULL');
    expect(fees).toContain('lower(f.manual_email) = ANY (v_emails)');
    // Two dues rows of one season renamed by one statement: only the lowest id
    // may take the plain name, or the season name key refuses the purge.
    expect(fees).toContain('AND o.season_id = f.season_id AND o.id < f.id');
    expect(fees).toContain("WHEN f.fee_type <> 'dues' THEN 'Deleted Player'");
    expect(fees).toContain("AND lower(btrim(d.manual_name)) = 'deleted player'");
    expect(fees).toContain("ELSE 'Deleted Player ' || left(f.id::text, 8)");
    expect(fees).toContain("WHEN f.fee_type = 'dues' THEN NULL");
  });

  it('rewrites only the external pair slot that was the member, and keeps the names distinct', () => {
    expect(scrub).toContain('lower(pr.external1_name) = lower(en.external_name)');
    expect(scrub).toContain('lower(pr.external2_name) = lower(en.partner_name)');
    expect(scrub).toContain('pr.player1_id IS NULL AND pr.player2_id IS NULL');
    expect(scrub).toContain("'Deleted Player 2'");
    expect(scrub).toContain("WHEN pair_name = v_pair.external1_name || ' / ' || v_pair.external2_name");
    // The pair is read before the entries lose the names that identify the slot.
    expect(scrub.indexOf('UPDATE tournament_pairs')).toBeLessThan(
      scrub.indexOf('UPDATE registration_import_entries'),
    );
  });

  it('strips the typed name and address from the three named-fee audit verbs', () => {
    expect(scrub).toContain("l.action_type = 'manual_fee_added'");
    expect(scrub).toContain("l.new_value - 'manual_name' - 'manual_email'");
    expect(scrub).toContain("l.action_type = 'manual_fee_claimed'");
    expect(scrub).toContain("l.old_value - 'manual_name'");
    expect(scrub).toContain("l.action_type = 'manual_fee_attached'");
    expect(scrub).toContain("(l.old_value -> 'named_fee') - 'manual_name' - 'manual_email'");
    // The two keyed on the player id run even with no address, for the backfill.
    const keyedByAddress = scrub.slice(scrub.indexOf('IF cardinality(v_emails) > 0 THEN'), scrub.lastIndexOf('END IF;'));
    expect(keyedByAddress).not.toContain("'manual_fee_claimed'");
    expect(keyedByAddress).not.toContain("'manual_fee_attached'");
  });

  it('backfills members purged before it, by id', () => {
    const backfill = sql.slice(sql.indexOf('DO $backfill$'), sql.indexOf('$backfill$;'));
    expect(backfill).toContain("p.user_id IS NULL AND p.email LIKE 'deleted+%@deleted.invalid'");
    expect(backfill).toContain('public.scrub_registration_identity(v_id, NULL)');
  });

  it('verifies itself against real rows and rolls the fixture back', () => {
    const verify = sql.slice(sql.indexOf('DO $verify$'), sql.indexOf('$verify$;'));
    expect(verify).toContain("RAISE EXCEPTION 'rollback' USING ERRCODE = 'P0285';");
    expect(verify).toContain("WHEN SQLSTATE 'P0285' THEN");
    expect(verify).toContain("public.scrub_registration_identity(gen_random_uuid(), ' Gone@Example.test ')");
    expect(verify).toContain('the self-check scrubbed a different person');
    expect(verify).toContain("'search_path=public, pg_temp' = ANY (p.proconfig)");
    expect(verify).toContain("rolname IN ('anon', 'authenticated', 'service_role', 'data_api_reader')");
  });

  it('is the next migration after 00284', () => {
    const versions = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .map((f) => f.slice(0, 5));
    expect(versions).toContain('00284');
    expect(versions).toContain('00285');
  });
});
