import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00292, READ OFF DISK. A club event runs on a linked tournament event, and the
// two lists of people stay the same both ways. The scenario that proves it
// (link with two sign-ups, a club sign-up, an exec entry billed once, pairing
// keeping both sign-ups, a member leaving a pair before the draw, an exec
// withdrawal taking the unpaid fee, signing up again; Form non-members before
// and after the link, and a replay) was run against a local database inside
// rolled-back transactions, and the exec add and withdraw with real commits.

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

const sql = migration('00292_');
const link = fn(sql, 'link_club_event_tournament(');
const added = fn(sql, 'club_event_link_signup_added(');
const removed = fn(sql, 'club_event_link_signup_removed(');
const changed = fn(sql, 'club_event_link_entry_changed(');

describe('00292 a club event runs as a tournament', () => {
  it('runs in one transaction after 00291', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("RAISE EXCEPTION '00292 needs 00291");
  });

  it('checks the tournament side at commit, so pairing never looks like leaving', () => {
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER club_event_link_participant_changed[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER club_event_link_pair_changed[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
  });

  it('does not echo a change the club side started', () => {
    expect(changed).toContain("IF current_setting('club_event_link.origin', true) = 'club' THEN");
    expect(added).toContain("set_config('club_event_link.origin', 'club', true)");
    expect(removed).toContain("set_config('club_event_link.origin', 'club', true)");
  });

  it('bills through the club sign-up, never a tournament fee', () => {
    const reconcile = fn(sql, 'club_event_link_reconcile(');
    expect(reconcile).toContain('INSERT INTO club_event_signups');
    expect(reconcile).toContain('DELETE FROM club_event_signups');
    // The link's own functions; registration_import_apply, copied here for
    // its guest lookups, prices tournament entries as it always did.
    for (const name of ['link_club_event_tournament(', 'club_event_link_reconcile(', 'club_event_link_admit_external(',
      'club_event_link_signup_added(', 'club_event_link_signup_removed(']) {
      expect(fn(sql, name)).not.toContain('tournament_fee');
    }
  });

  it('keeps a partner in when one half of a pair leaves before the draw', () => {
    expect(removed).toContain("unpair_tournament_pair(v_pair, OLD.player_id, 'Left the club event', NULL)");
    // No catch-all: an unpair that refuses raises rather than withdrawing a pair.
    expect(removed).not.toContain('EXCEPTION WHEN OTHERS');
  });

  it('changes the field only before the draw, under the event lock', () => {
    const open = fn(sql, 'club_event_link_assert_field_open(');
    expect(open).toContain("FROM tournament_events te WHERE te.id = p_event_id FOR UPDATE");
    expect(open).toContain("IF v_status NOT IN ('registration', 'checkin') OR coalesce(v_locked, false) THEN");
    expect(fn(sql, 'club_event_link_signup_added(')).toContain('PERFORM club_event_link_assert_field_open(v_event,');
    expect(removed).toContain('PERFORM club_event_link_assert_field_open(v_event,');
    expect(fn(sql, 'club_event_link_admit_external(')).toContain("te.status IN ('registration', 'checkin')");
  });

  it('reads a guest as a non-member to the Form, and gives a guest no named fees', () => {
    const apply = fn(sql, 'registration_import_apply(');
    expect(apply.split("p.email NOT LIKE '%@deleted.invalid' AND NOT p.is_guest").length - 1).toBe(4);
    const claim = fn(sql, 'claim_named_fees_for_player(');
    expect(claim).toContain('IF NEW.is_guest THEN');
    expect(sql).toMatch(/CREATE TRIGGER claim_named_fees_at_guest_end_trg[\s\S]*?WHEN \(OLD\.is_guest AND NOT NEW\.is_guest/);
  });

  it('makes a draft, unrated unless asked, with no placement bonus, and audits it', () => {
    expect(link).toContain("'draft', v_season, p_actor_id, false)");
    expect(link).toContain('coalesce(p_rated, false), false)');
    expect(link).toContain("'club_event_tournament_linked'");
    expect(link).toContain("IF v_club.tournament_event_id IS NOT NULL THEN");
  });

  it('gives a Form non-member a record with no login, at commit, and keeps one fee', () => {
    const admit = fn(sql, 'club_event_link_admit_external(');
    // Not create_player_with_rating, which refuses the Data API's reader role.
    expect(admit).not.toContain('create_player_with_rating(');
    expect(admit).toContain('v_player := create_guest_player(v_email, v_first,');
    expect(fn(sql, 'create_guest_player(')).toContain("'recreational', 'player',\n          false, 'external', true, true)");
    expect(admit).toContain('UPDATE club_fees f SET player_id = v_player, manual_name = NULL, manual_email = NULL');
    expect(admit).toContain('INSERT INTO club_event_signups (event_id, player_id)');
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER club_event_link_external_added[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
    expect(link).toContain('PERFORM club_event_link_admit_external(x.id)');
  });

  it('keeps a guest silent, unflaggable by a member, and ends it at sign-in', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false');
    expect(fn(sql, 'notifications_skip_guests(')).toContain('RETURN NULL');
    expect(sql).toMatch(/BEFORE INSERT ON public\.notifications/);
    const guard = fn(sql, 'guard_player_privileged_columns(');
    expect(guard).toContain('OR COALESCE(NEW.is_guest, FALSE)');
    expect(guard).toContain('AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL');
    expect(fn(sql, 'player_guest_ends_at_claim(')).toContain('NEW.is_guest := false');
    expect(fn(sql, 'player_guest_ends_at_claim(')).toContain('NEW.hide_from_leaderboard := false');
    expect(fn(sql, 'create_guest_player(')).toContain('membership_type, is_guest, hide_from_leaderboard)');
    expect(fn(sql, 'challenge_participants_refuse_guests(')).toContain("USING ERRCODE = 'check_violation'");
    expect(sql).toMatch(/BEFORE INSERT ON public\.challenge_participants/);
    // Sorts before the guard, which reads the cleared flag as the allowed change.
    expect('a_player_guest_ends_at_claim_trg' < 'guard_player_privileged_columns_trg').toBe(true);
  });

  it('blocks Discord links to a guest, and erases one under a label', () => {
    expect(fn(sql, 'player_discord_links_refuse_guests(')).toContain("USING ERRCODE = 'check_violation'");
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF player_id ON public\.player_discord_links/);
    const erase = fn(sql, 'erase_guest(');
    expect(erase).toContain("v_label := 'Former guest#' || left(md5(p_player_id::text), 6)");
    expect(erase).toContain("email = 'deleted+' || p_player_id::text || '@deleted.invalid'");
    expect(erase).toContain("'not_a_guest'");
    expect(erase).toContain('PERFORM scrub_deleted_identity()');
  });

  it('lets Add Player make a division member again (ratings collision since 00220)', () => {
    expect(fn(sql, 'create_player_with_rating(')).toContain('ON CONFLICT (player_id) DO NOTHING');
  });

  it('lets an admin make a guest a member, and keeps the ask off member writes', () => {
    const make = fn(sql, 'make_guest_member(');
    expect(make).toContain('SET is_guest = false, hide_from_leaderboard = false');
    expect(make).toContain('PERFORM assign_member_code(p_player_id)');
    expect(make).toContain("'guest_made_member'");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.make_guest_member\(uuid, uuid, text\) FROM PUBLIC, anon, authenticated/);
    const guard = fn(sql, 'guard_player_privileged_columns(');
    expect(guard).toContain('NEW.guest_member_requested_by IS DISTINCT FROM OLD.guest_member_requested_by');
  });

  it('lets only the service role link', () => {
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.link_club_event_tournament(uuid, uuid, text, text, boolean) TO service_role;',
    );
    expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
  });
});
