import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVENT DAY, WAVE 2 (00329 onward).
 *
 * Each file checks first and reloads the schema cache last, runs in the one
 * transaction db-migrate wraps it in, keeps any new table to the service role
 * and any new function SECURITY DEFINER on a pinned search path, and has a
 * down script. None restates an entry path or merge_players_disposable: no
 * wave 2 table names a player.
 */

const SUPABASE_DIR = join(__dirname, '../../../../supabase');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');
const ROLLBACKS_DIR = join(SUPABASE_DIR, 'rollbacks');

const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const migrationOf = (prefix: string) =>
  readFileSync(join(MIGRATIONS_DIR, migrationFiles().find((f) => f.startsWith(prefix))!), 'utf8');
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const VERSIONS = ['00329_', '00330_', '00331_', '00332_', '00333_', '00334_'];
// 00333 adds tables and a capability and no function.
const NO_FUNCTION = new Set(['00333_']);

const NOT_RESTATED = [
  'set_field_entry_status',
  'publish_stage_draw',
  'set_pair_member_check_in',
  'fill_event_from_waitlist',
  'enter_tournament_event',
  'add_participants_under_field_lock',
  'join_event_waitlist',
  'delete_stage_matches',
  'merge_players_disposable',
  'substitute_event_entry',
  'release_checkin_no_shows',
  'confirm_event_entry',
  'release_unconfirmed_event_entries',
  'open_event_confirmations',
];

describe('wave 2: shape', () => {
  for (const version of VERSIONS) {
    it(`${version} runs in one transaction, checks first and reloads the schema cache last`, () => {
      const sql = stripComments(migrationOf(version));
      expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
      expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
      expect(sql.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
      const pre = sql.indexOf('DO $pre$');
      expect(pre).toBeGreaterThan(-1);
      expect(pre).toBeLessThan(sql.search(/CREATE (TABLE|OR REPLACE FUNCTION)|ALTER TABLE/));
      expect(sql).toContain('DO $verify$');
    });

    it(`${version} restates no entry path and no merge function`, () => {
      const sql = stripComments(migrationOf(version));
      for (const name of NOT_RESTATED) {
        expect(sql, `${version} ${name}`).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`));
      }
    });

    it(`${version} keeps every new function off anon and authenticated`, () => {
      const sql = stripComments(migrationOf(version));
      const names = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1]!);
      if (NO_FUNCTION.has(version)) expect(names).toEqual([]);
      else expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(sql, name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
      }
    });

    it(`${version} never uses an em dash`, () => {
      expect(migrationOf(version)).not.toContain('\u2014');
    });
  }
});

describe('00329: results decided off court and by retirement', () => {
  const sql = stripComments(migrationOf('00329_'));

  it('adds two columns, not a status value', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS result_kind text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS retired_side text');
    expect(sql).not.toMatch(/tournament_matches_status_check\s+CHECK/);
  });

  it('shapes the row: off court has no scores and no side, retired has a side', () => {
    expect(sql).toMatch(/result_kind = 'off_court' AND retired_side IS NULL\s+AND \(scores IS NULL OR jsonb_array_length\(scores\) = 0\)/);
    expect(sql).toMatch(/result_kind = 'retired' AND retired_side IS NOT NULL/);
  });

  it('refuses a rating on off court, and clears the kind when a match goes back to playable', () => {
    expect(sql).toMatch(/CREATE TRIGGER tournament_matches_off_court_unrated\s+BEFORE UPDATE OF elo_snapshot/);
    expect(sql).toMatch(/CREATE TRIGGER tournament_matches_result_kind_reset\s+BEFORE UPDATE OF status[\s\S]*?NEW\.status IN \('pending', 'ready', 'live'\)/);
  });
});

describe('00330: a released late arrival comes back', () => {
  const sql = stripComments(migrationOf('00330_'));
  const body = (name: string) => {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return sql.slice(start, sql.indexOf('$function$;', start));
  };

  it('every function is SECURITY DEFINER on a pinned search path, for the service role', () => {
    for (const name of ['released_entry_under_lock', 'reinstate_released_entry', 'requeue_released_entry']) {
      expect(body(name), name).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
      expect(sql, name).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`));
    }
  });

  it('locks the field, then the tournament, then the event, as the release does', () => {
    const lock = body('released_entry_under_lock');
    const field = lock.indexOf("pg_advisory_xact_lock(hashtext('tournament_event_field')");
    const tournament = lock.indexOf('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE');
    const event = lock.indexOf('FROM tournament_events e WHERE e.id = v_event FOR UPDATE');
    expect(field).toBeGreaterThan(-1);
    expect(field).toBeLessThan(tournament);
    expect(tournament).toBeLessThan(event);
  });

  it('only a released entry, only at check-in, never once drawn', () => {
    const lock = body('released_entry_under_lock');
    expect(lock).toContain("v_status <> 'checkin'");
    expect(lock).toMatch(/draw_locked[\s\S]*?EXISTS \(SELECT 1 FROM tournament_matches/);
    expect(lock).toContain("'checkin_no_shows_released'");
    expect(lock).toContain("w.source = 'checkin_close' AND w.rescinded_at IS NULL");
    expect(lock).toContain("'not_released'");
  });

  it('reinstates to registered, never checked in, and rescinds the warning; the requeue keeps it', () => {
    const reinstate = body('reinstate_released_entry');
    expect(reinstate).toContain("SET status = 'registered'");
    expect(reinstate).not.toContain("'checked_in'");
    expect(reinstate).toMatch(/UPDATE attendance_warnings\s+SET rescinded_at = now\(\)/);
    expect(reinstate).toContain("'place_taken'");
    expect(body('requeue_released_entry')).not.toContain('attendance_warnings');
  });

  it('the requeue refuses a linked event, whose reserves are the club queue', () => {
    expect(body('requeue_released_entry')).toContain("'club_event_linked'");
  });
});

describe('00331: a group can be capped in time', () => {
  const sql = stripComments(migrationOf('00331_'));

  it('keeps the table to the service role, with RLS on and no player FK', () => {
    expect(sql).toContain('ALTER TABLE public.stage_group_time_caps ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.stage_group_time_caps FROM PUBLIC, anon, authenticated;');
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).not.toMatch(/REFERENCES public\.players/);
  });

  it('voids only unrated pending and ready matches of the scope, leaving live ones to finish', () => {
    expect(sql).toMatch(/m\.status IN \('pending', 'ready'\)\s+AND m\.elo_snapshot IS NULL\s+AND m\.is_bye IS NOT TRUE/);
    expect(sql).not.toMatch(/m\.status IN \([^)]*'live'/);
  });

  it('the minute job asks the switch, skips locked rows, and is pure SQL behind a pg_cron guard', () => {
    expect(sql).toContain("IF NOT release_flag_on('group_time_cap') THEN");
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'\)/);
    expect(sql).toContain("cron.schedule('group-time-caps', '* * * * *', 'SELECT public.apply_due_group_time_caps();')");
    expect(sql).not.toMatch(/net\.http_post|cron_config/);
  });
});

describe('00332: a thin group merges into another', () => {
  const sql = stripComments(migrationOf('00332_'));

  it('refuses a stale draw, a later stage, and a group that has played, is rated or is on court', () => {
    for (const reason of ['superseded', 'later_stage', 'played', 'rated', 'live', 'invalid_rows']) {
      expect(sql, reason).toContain(`'reason', '${reason}'`);
    }
  });

  it('checks every new row before it deletes anything, and audits the deleted ids', () => {
    expect(sql.indexOf("'invalid_rows'")).toBeLessThan(sql.indexOf('DELETE FROM tournament_matches'));
    expect(sql).toContain("'groups_merged'");
    expect(sql).toContain("'deleted_match_ids'");
  });

  it('names the columns it inserts, so no default is overwritten with a null', () => {
    expect(sql).toMatch(/INSERT INTO tournament_matches \(\s+id, event_id, draw_generation_id/);
    expect(sql).not.toMatch(/INSERT INTO tournament_matches\s+SELECT \*/);
  });
});

describe.skipIf(!existsSync(ROLLBACKS_DIR))('wave 2: the down scripts', () => {
  for (const version of VERSIONS) {
    it(`${version} has one`, () => {
      expect(existsSync(join(ROLLBACKS_DIR, `${version}down.sql`)), version).toBe(true);
    });
  }

  it('00331 unschedules the minute job before dropping what it calls', () => {
    const down = readFileSync(join(ROLLBACKS_DIR, '00331_down.sql'), 'utf8');
    expect(down.indexOf("cron.unschedule('group-time-caps')"))
      .toBeLessThan(down.indexOf('DROP FUNCTION IF EXISTS public.apply_due_group_time_caps()'));
  });

  it('00329 drops the triggers before the columns', () => {
    const down = readFileSync(join(ROLLBACKS_DIR, '00329_down.sql'), 'utf8');
    expect(down.indexOf('DROP TRIGGER IF EXISTS tournament_matches_off_court_unrated'))
      .toBeLessThan(down.indexOf('DROP COLUMN IF EXISTS result_kind'));
  });
});

describe('00333: results are posted, and social posts are ready', () => {
  const sql = stripComments(migrationOf('00333_'));

  it('keeps both tables to the service role, with RLS on and no player FK', () => {
    for (const table of ['event_results_posts', 'event_social_post_sets']) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toMatch(new RegExp(`GRANT [A-Z, ]+ ON TABLE public\\.${table} TO service_role;`));
    }
    expect(sql).not.toMatch(/REFERENCES public\.players/);
  });

  it('admits the capability in both CHECKs and grants it to the two marketing portfolios by id', () => {
    expect(sql.match(/'announcements\.discord\.write', 'announcements\.socialposts\.read'/g)).toHaveLength(2);
    expect(sql).toMatch(/UPDATE public\.permission_baselines[\s\S]*?5eed0060-0000-4000-8000-000000000204[\s\S]*?5eed0060-0000-4000-8000-000000000206[\s\S]*?AND NOT \(capabilities @>/);
    expect(sql).toMatch(/UPDATE public\.players p[\s\S]*?permission_baseline_id IN[\s\S]*?AND NOT \(p\.permission_grants @>/);
    expect(sql).not.toMatch(/SET permission_revokes/);
  });

  it('names the three set kinds', () => {
    expect(sql).toContain("kind IN ('teams_full', 'teams_new', 'draw')");
  });

  it.skipIf(!existsSync(ROLLBACKS_DIR))('the down script strips the string from every stored array before restoring the old CHECK', () => {
    const down = readFileSync(join(ROLLBACKS_DIR, '00333_down.sql'), 'utf8');
    const strip = down.indexOf("array_remove(permission_grants, 'announcements.socialposts.read')");
    const restore = down.indexOf('ADD CONSTRAINT players_permission_vocabulary_check');
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(restore);
    expect(down).toContain("array_remove(capabilities, 'announcements.socialposts.read')");
    expect(down.slice(restore)).not.toContain('announcements.socialposts.read');
  });
});

describe('00334: confirmations follow a team', () => {
  const sql = stripComments(migrationOf('00334_'));
  const body = sql.slice(sql.indexOf('FUNCTION public.relink_event_confirmations'), sql.indexOf('REVOKE ALL ON FUNCTION'));

  it('adds only relink_event_confirmations, to the service role', () => {
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1])).toEqual(['relink_event_confirmations']);
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.relink_event_confirmations(uuid, uuid[]) TO service_role;');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('never writes status, and sets both entry columns in one statement', () => {
    expect(body).not.toMatch(/SET[^;]*\bstatus\s*=/);
    expect(body).toContain('SET pair_id = m.pair_id, participant_id = NULL');
    expect(body).toContain('SET participant_id = s.participant_id, pair_id = NULL');
  });
});
