import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00328: "Left, with a sub" is one transaction, and the incoming person needs
 * no entry (a reserve resolved off the waitlist, an exec, a guest), so a full
 * event can still sub mid-play.
 */

const SUPABASE_DIR = join(__dirname, '../../../../supabase');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');
const ROLLBACKS_DIR = join(SUPABASE_DIR, 'rollbacks');

const migrationOf = (prefix: string) => {
  const file = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).find((f) => f.startsWith(prefix));
  return readFileSync(join(MIGRATIONS_DIR, file!), 'utf8');
};
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const SQL = migrationOf('00328_');
const CODE = stripComments(SQL);
const OLD = 'substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer)';
const NEW = 'substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer, uuid[], text, text)';

function body(): string {
  const at = CODE.indexOf('CREATE FUNCTION public.substitute_event_entry(');
  expect(at).toBeGreaterThan(-1);
  const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(CODE.slice(at))!;
  const start = at + open.index + open[0].length;
  return CODE.slice(start, CODE.indexOf(open[1]!, start));
}

describe('00328: shape', () => {
  it('runs in one transaction, checks first and reloads the schema cache last', () => {
    expect(CODE).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(CODE.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
    expect(CODE.indexOf('DO $pre$')).toBeGreaterThan(-1);
    expect(CODE.indexOf('DO $pre$')).toBeLessThan(CODE.indexOf('CREATE FUNCTION'));
    expect(CODE).toContain('DO $verify$');
  });

  it('drops the 00327 signature so PostgREST has one candidate, and grants only the service role', () => {
    expect(CODE).toContain(`DROP FUNCTION IF EXISTS public.${OLD};`);
    expect(CODE.indexOf(`DROP FUNCTION IF EXISTS public.${OLD};`)).toBeLessThan(CODE.indexOf('CREATE FUNCTION'));
    expect(CODE).toContain(`REVOKE ALL ON FUNCTION public.${NEW} FROM PUBLIC, anon, authenticated;`);
    expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION public.${NEW} TO service_role;`);
  });

  it('adds the new parameters last, each with a default', () => {
    const header = CODE.slice(CODE.indexOf('CREATE FUNCTION public.substitute_event_entry('), CODE.indexOf('RETURNS jsonb'));
    expect(header).toMatch(/p_elo_before integer DEFAULT NULL,\s*p_waitlist_ids uuid\[\] DEFAULT NULL,\s*p_departure_reason text DEFAULT NULL,\s*p_departure_note text DEFAULT NULL\s*\)/);
  });
});

describe('00328: the substitution', () => {
  it('keeps 00327\'s lock order', () => {
    const code = body();
    const advisory = code.indexOf("pg_advisory_xact_lock(hashtext('tournament_event_field')");
    const tournament = code.search(/FROM tournaments t WHERE t\.id = v_tournament FOR UPDATE/);
    const event = code.search(/FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE/);
    expect(advisory).toBeGreaterThan(-1);
    expect(tournament).toBeGreaterThan(advisory);
    expect(event).toBeGreaterThan(tournament);
  });

  it('asks every question before the first write', () => {
    const code = body();
    const firstWrite = code.search(/UPDATE tournament_matches m\s+SET status = 'voided'/);
    expect(firstWrite).toBeGreaterThan(-1);
    for (const reason of ['on_court', 'already_in_event', 'not_entered', 'restricted', 'entry_out', 'not_in_entry',
      'reserve_not_waiting', 'reserves_waiting', 'entry_cap', 'player_suspended', 'inactive', 'bad_departure']) {
      const at = code.indexOf(`'reason', '${reason}'`);
      expect(at, reason).toBeGreaterThan(-1);
      expect(at, reason).toBeLessThan(firstWrite);
    }
  });

  it('voids the live match before the people change, and records a departure only for who went out', () => {
    const code = body();
    const voided = code.search(/SET status = 'voided'/);
    const people = code.indexOf('UPDATE tournament_pairs SET player1_id');
    expect(voided).toBeGreaterThan(-1);
    expect(people).toBeGreaterThan(voided);
    expect(code).toMatch(/FOREACH v_out IN ARRAY p_outgoing LOOP[\s\S]*?INSERT INTO event_departures/);
    expect(code).toContain('ON CONFLICT (event_id, player_id) DO NOTHING');
  });

  it('lets a reserve, an exec or a guest in without an entry, and resolves the reserve through the desk\'s removal', () => {
    const code = body();
    expect(code).toContain('COALESCE(v_person.is_guest, false)');
    expect(code).toContain('COALESCE(v_person.is_exec, false)');
    expect(code).toContain('public.remove_from_event_waitlist(v_wid, p_actor)');
    // Never through an entry path that counts the event's places.
    expect(code).not.toMatch(/fill_event_from_waitlist|add_participants_under_field_lock|enter_tournament_event/);
  });

  it('restates no entry path', () => {
    for (const name of [
      'set_field_entry_status',
      'publish_stage_draw',
      'set_pair_member_check_in',
      'fill_event_from_waitlist',
      'enter_tournament_event',
      'add_participants_under_field_lock',
      'join_event_waitlist',
      'remove_from_event_waitlist',
    ]) {
      expect(CODE, name).not.toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\(`, 'i'));
    }
  });
});

// supabase/rollbacks is private; skipped on the exported tree.
describe.skipIf(!existsSync(ROLLBACKS_DIR))('00328: the down script', () => {
  it('drops the new signature and restates 00327\'s function verbatim', () => {
    const down = readFileSync(join(ROLLBACKS_DIR, '00328_down.sql'), 'utf8');
    const old = migrationOf('00327_');
    const from = old.indexOf('CREATE OR REPLACE FUNCTION public.substitute_event_entry(');
    const to = old.indexOf(`GRANT EXECUTE ON FUNCTION public.${OLD} TO service_role;`);
    expect(down).toContain(`DROP FUNCTION IF EXISTS public.${NEW};`);
    expect(down).toContain(old.slice(from, to));
    expect(down).toContain(`GRANT EXECUTE ON FUNCTION public.${OLD} TO service_role;`);
  });
});
