import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00324 TO 00326: THE EVENT STANDARD.
 *
 * 00324 adds the warnings, restrictions, confirmations and departures tables,
 * service role only, and their ten player columns join merge_players_disposable. 00325
 * asks, claims, confirms and releases, taking the field lock before the
 * tournament and the event rows, and its schedule is guarded like 00283's.
 * 00326 releases the entries nobody checked in. None of the three restates an
 * entry path; each has a down script.
 */

const SUPABASE_DIR = join(__dirname, '../../../../supabase');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');
const ROLLBACKS_DIR = join(SUPABASE_DIR, 'rollbacks');

const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const migrationOf = (prefix: string) =>
  readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith(prefix))!), 'utf8');
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** The body of a function in some SQL, bounded by its own dollar tag. */
function bodyOf(sql: string, name: string): string {
  const at = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(at, name).toBeGreaterThan(-1);
  const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(sql.slice(at))!;
  const start = at + open.index + open[0].length;
  return sql.slice(start, sql.indexOf(open[1]!, start));
}

const disposableRows = (prefix: string) => {
  const sql = migrationOf(prefix);
  const start = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.merge_players_disposable()');
  const body = sql.slice(start, sql.indexOf('$function$;', start));
  return [...body.matchAll(/\('([a-z0-9_]+)',\s*'([a-z0-9_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
};

const VERSIONS = ['00324_', '00325_', '00326_'];

describe('00324 to 00326: shape', () => {
  for (const version of VERSIONS) {
    it(`${version} runs in one transaction, checks first and reloads the schema cache last`, () => {
      const sql = stripComments(migrationOf(version));
      expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
      expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
      expect(sql.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
      const pre = sql.indexOf('DO $pre$');
      expect(pre).toBeGreaterThan(-1);
      expect(pre).toBeLessThan(sql.search(/CREATE (TABLE|OR REPLACE FUNCTION)/));
      expect(sql).toContain('DO $verify$');
    });
  }

  it('never names the zone: the start is club_local_instant', () => {
    for (const version of VERSIONS) {
      expect(stripComments(migrationOf(version)), version).not.toMatch(/AT TIME ZONE 'America\/Vancouver'/);
    }
    expect(bodyOf(migrationOf('00325_'), 'event_start_instant'))
      .toContain("club_local_instant(t.start_date, COALESCE(t.starts_time, time '09:00'))");
  });
});

describe('00324: the tables are the service role\'s alone', () => {
  const sql = stripComments(migrationOf('00324_'));

  for (const table of ['attendance_warnings', 'event_entry_restrictions', 'tournament_event_confirmations', 'event_departures']) {
    it(table, () => {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table} (`);
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT ALL ON public.${table} TO service_role;`);
      expect(sql).not.toMatch(new RegExp(`CREATE POLICY[^;]*ON public\\.${table}`));
    });
  }

  it('keeps one active warning per member, event and kind', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS attendance_warnings_one_active\s+ON public\.attendance_warnings \(player_id, event_id, kind\)\s+WHERE rescinded_at IS NULL AND event_id IS NOT NULL;/);
  });

  it('records a departure with a reason from a fixed list, a note for "other", one per member per event', () => {
    expect(sql).toContain("CHECK (reason IN ('injury', 'told_organizers', 'emergency', 'other', 'without_notice'))");
    // COALESCE: a missing note fails the check instead of making it NULL, which a CHECK passes.
    expect(sql).toContain("CHECK (reason <> 'other' OR COALESCE(char_length(btrim(note)), 0) > 0)");
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS event_departures_other_has_note');
    expect(sql).toContain('warning_id     uuid REFERENCES public.attendance_warnings(id) ON DELETE SET NULL');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.event_departures \([\s\S]*UNIQUE \(event_id, player_id\)/);
    expect(sql).toContain("source IN ('checkin_close', 'did_not_come', 'desk', 'court_helper')");
  });

  it('bounds the confirmation window', () => {
    expect(sql).toContain('CHECK (confirm_deadline_hours >= 1 AND confirm_opens_hours <= 336 AND confirm_deadline_hours < confirm_opens_hours)');
    expect(sql).toContain('confirm_opens_hours smallint NOT NULL DEFAULT 48');
    expect(sql).toContain('confirm_deadline_hours smallint NOT NULL DEFAULT 24');
  });

  it('adds the day lead as a SET NULL player column', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS day_lead_player_id uuid REFERENCES public.players(id) ON DELETE SET NULL;');
  });
});

describe('00324: merges', () => {
  it('restates merge_players_disposable as 00320 had it plus the ten new columns', () => {
    const before = disposableRows('00320_');
    expect(before).toHaveLength(34);
    const after = disposableRows('00324_');
    expect(after).toHaveLength(44);
    expect(after.sort()).toEqual(
      [
        ...before,
        'attendance_warnings.player_id',
        'attendance_warnings.issued_by',
        'attendance_warnings.rescinded_by',
        'event_entry_restrictions.player_id',
        'event_entry_restrictions.created_by',
        'event_entry_restrictions.lifted_by',
        'tournament_event_confirmations.player_id',
        'event_departures.player_id',
        'event_departures.marked_by',
        'tournaments.day_lead_player_id',
      ].sort(),
    );
  });

  it('keeps the grants and verifies the count and the guard', () => {
    const sql = migrationOf('00324_');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;');
    const verify = sql.slice(sql.indexOf('DO $verify$'));
    expect(verify).toContain('merge_players_disposable()) <> 44');
    expect(verify).toContain('FROM public.merge_players_unhandled()');
  });
});

describe('00325: the claim', () => {
  const claim = stripComments(bodyOf(migrationOf('00325_'), 'claim_event_confirmation_requests'));

  it('is the registration mail\'s: three attempts, a stale window, SKIP LOCKED', () => {
    expect(claim).toContain('c.email_attempts < 3');
    expect(claim).toContain("c.email_attempted_at < now() - interval '15 minutes'");
    expect(claim).toContain('FOR UPDATE OF c SKIP LOCKED');
    expect(claim).toContain('LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 0), 50))');
    expect(claim).toContain("c.email_outcome IS DISTINCT FROM 'suppressed'");
    expect(claim).toContain("NOT LIKE '%@deleted.invalid'");
  });
});

describe('00325 and 00326: the lock order', () => {
  const ADVISORY = "pg_advisory_xact_lock(hashtext('tournament_event_field')";

  for (const [version, name] of [
    ['00325_', 'release_unconfirmed_event_entries'],
    ['00326_', 'release_checkin_no_shows'],
  ] as const) {
    it(`${name} takes the field lock, then the tournament, then the event`, () => {
      const body = stripComments(bodyOf(migrationOf(version), name));
      const advisory = body.indexOf(ADVISORY);
      const tournament = body.search(/FROM tournaments t WHERE t\.id = v_tournament FOR UPDATE/);
      const event = body.search(/FROM tournament_events e WHERE e\.id = [a-z_.]+ FOR UPDATE/);
      expect(advisory).toBeGreaterThan(-1);
      expect(tournament).toBeGreaterThan(advisory);
      expect(event).toBeGreaterThan(tournament);
    });
  }

  it('the release never releases a member the email did not reach, and writes no warning', () => {
    const body = stripComments(bodyOf(migrationOf('00325_'), 'release_unconfirmed_event_entries'));
    expect(body).toContain('bool_and(c.email_sent_at IS NOT NULL) AS all_reached');
    expect(body).toContain("SET status = 'unreached'");
    expect(body).toContain("set_field_entry_status(v_entry.entry_id, v_entry.is_pair, 'withdrawn', NULL)");
    expect(body).not.toContain('attendance_warnings');
  });

  it('the confirm guards the caller and takes the field lock', () => {
    const body = stripComments(bodyOf(migrationOf('00325_'), 'confirm_event_entry'));
    expect(body).toContain('IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN');
    expect(body.indexOf('auth.uid()')).toBeLessThan(body.indexOf(ADVISORY));
  });

  it('the check-in release withdraws and never fills', () => {
    const body = stripComments(bodyOf(migrationOf('00326_'), 'release_checkin_no_shows'));
    expect(body).toContain("set_field_entry_status(v_entry.entry_id, v_entry.is_pair, 'withdrawn', p_actor)");
    expect(body).not.toContain('fill_event_from_waitlist');
    expect(body).toContain("IF v_status <> 'checkin' OR COALESCE(v_locked, false) THEN");
  });
});

describe('00325: the schedule is guarded', () => {
  const sql = migrationOf('00325_');
  const block = sql.slice(sql.indexOf('DO $schedule$'), sql.indexOf('$schedule$;'));

  it('skips without pg_cron or pg_net, and sends nothing without the secret', () => {
    expect(block).toContain("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'");
    expect(block).toContain("SELECT 1 FROM pg_extension WHERE extname = 'pg_net'");
    expect(block).toContain("PERFORM cron.unschedule('event-confirmations')");
    expect(block).toContain("'*/5 * * * *'");
    expect(block).toContain("'/api/cron/event-confirmations'");
    expect(block).toContain("WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'reminder_secret');");
    // Filtered reads only: an unfiltered cron_config read returns the secret.
    expect(block).not.toMatch(/FROM cron_config\s*\)/);
  });
});

describe('00324 to 00326: no entry path is redefined', () => {
  it('leaves the entry functions to their own migrations', () => {
    for (const version of VERSIONS) {
      const sql = migrationOf(version);
      for (const name of [
        'enter_tournament_event',
        'fill_event_from_waitlist',
        'join_event_waitlist',
        'set_field_entry_status',
        'add_participants_under_field_lock',
      ]) {
        expect(sql, `${version} ${name}`).not.toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\(`, 'i'));
      }
    }
  });

  it('revokes every new function from PUBLIC, anon and authenticated, and grants the service role', () => {
    for (const [version, sigs] of [
      ['00325_', [
        'event_start_instant(uuid)',
        'open_event_confirmations()',
        'claim_event_confirmation_requests(integer)',
        'record_event_confirmation_receipt(uuid, boolean, text, text)',
        'confirm_event_entry(uuid, uuid, uuid)',
        'release_unconfirmed_event_entries(integer)',
      ]],
      ['00326_', ['release_checkin_no_shows(uuid, uuid, boolean)']],
    ] as const) {
      const sql = migrationOf(version);
      for (const sig of sigs) {
        expect(sql, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
        expect(sql, sig).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
      }
    }
  });
});

// supabase/rollbacks is private; skipped on the exported tree.
describe.skipIf(!existsSync(ROLLBACKS_DIR))('00324 to 00326: the down scripts', () => {
  it('exist', () => {
    for (const version of ['00324', '00325', '00326']) {
      expect(existsSync(join(ROLLBACKS_DIR, `${version}_down.sql`)), version).toBe(true);
    }
  });

  it('00324_down restates 00320\'s merge_players_disposable verbatim', () => {
    const down = readFileSync(join(ROLLBACKS_DIR, '00324_down.sql'), 'utf8');
    const statement = (sql: string) => {
      const at = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.merge_players_disposable()');
      return sql.slice(at, sql.indexOf('$function$;', at));
    };
    expect(statement(down)).toBe(statement(migrationOf('00320_')));
    expect(down).toContain('DROP TABLE IF EXISTS public.attendance_warnings;');
    expect(down).toContain('DROP TABLE IF EXISTS public.event_departures;');
    expect(down).toContain('DROP COLUMN IF EXISTS day_lead_player_id;');
  });

  it('00325_down and 00326_down drop what they added', () => {
    const down325 = readFileSync(join(ROLLBACKS_DIR, '00325_down.sql'), 'utf8');
    expect(down325).toContain("cron.unschedule('event-confirmations')");
    expect(down325).toContain('DROP FUNCTION IF EXISTS public.release_unconfirmed_event_entries(integer);');
    const down326 = readFileSync(join(ROLLBACKS_DIR, '00326_down.sql'), 'utf8');
    expect(down326).toContain('DROP FUNCTION IF EXISTS public.release_checkin_no_shows(uuid, uuid, boolean);');
  });
});
