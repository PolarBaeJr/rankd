import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00312, READ OFF DISK. Pins the properties its verify block checks at apply
// time, and that both join functions are their previous bodies plus only the
// lines marked 00312.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00312_');
const linked = migration('00307_');
const door = migration('00294_');

/** The body of one CREATE FUNCTION, from its header to the closing tag. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = source.indexOf('$function$;', start);
  return source.slice(start, end);
}

/** The body with the 00312 block and every line marked 00312 taken out. */
function without00312(body: string): string {
  return body
    .replace(/^ *-- ---- 00312: the waitlist limit[\s\S]*?^ *-- ---- end 00312\n\n/gm, '')
    .replace(/^.*-- 00312\n/gm, '');
}

const ADVISORY = "pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text))";
const TOURNAMENT_LOCK = 'FROM tournaments t WHERE t.id = v_tournament FOR UPDATE';
const EVENT_LOCK = 'FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE';

const SIGNATURES = [
  'join_event_waitlist(uuid, uuid, boolean, text, text)',
  'club_event_join_waitlist(uuid, uuid)',
  'set_event_waitlist_limit(uuid, integer, uuid)',
];

describe('00312: a waitlist can be capped', () => {
  it('adds a nullable limit of at least 1 to both kinds of event', () => {
    for (const table of ['tournament_events', 'club_events']) {
      expect(sql).toContain(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS waitlist_limit integer;`);
      expect(sql).toContain(`ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${table}_waitlist_limit_positive;`);
      expect(sql).toMatch(new RegExp(
        `ALTER TABLE public\\.${table} ADD CONSTRAINT ${table}_waitlist_limit_positive\\s+CHECK \\(waitlist_limit IS NULL OR waitlist_limit >= 1\\);`,
      ));
      expect(sql).toContain(`COMMENT ON COLUMN public.${table}.waitlist_limit IS`);
    }
  });

  it('leaves join_event_waitlist as 00307 had it, apart from the lines marked 00312', () => {
    const after = functionBody(sql, 'join_event_waitlist');
    expect(after).toContain('-- ---- 00312: the waitlist limit');
    expect(without00312(after)).toBe(functionBody(linked, 'join_event_waitlist'));
  });

  it('leaves club_event_join_waitlist as 00294 had it, apart from the lines marked 00312', () => {
    const after = functionBody(sql, 'club_event_join_waitlist');
    expect(after).toContain('-- ---- 00312: the waitlist limit');
    expect(without00312(after)).toBe(functionBody(door, 'club_event_join_waitlist'));
  });

  it('refuses a full waitlist under the event row lock, after already_waiting and before the write', () => {
    const join = functionBody(sql, 'join_event_waitlist');
    const full = join.indexOf("'reason', 'waitlist_full'");
    expect(full).toBeGreaterThan(join.indexOf(EVENT_LOCK));
    expect(full).toBeGreaterThan(join.indexOf("'reason', 'already_waiting'"));
    expect(full).toBeLessThan(join.indexOf('-- ---- the write'));
    expect(join).toContain('club_event_linked');

    const club = functionBody(sql, 'club_event_join_waitlist');
    const clubFull = club.indexOf("'reason', 'waitlist_full'");
    expect(clubFull).toBeGreaterThan(club.indexOf('FOR NO KEY UPDATE'));
    expect(clubFull).toBeGreaterThan(club.indexOf("'reason', 'already_waiting'"));
    expect(clubFull).toBeLessThan(club.indexOf('INSERT INTO public.club_event_waitlist'));
  });

  it('sets the limit under the field key, then the tournament row, then the event row', () => {
    const body = functionBody(sql, 'set_event_waitlist_limit');
    const advisory = body.indexOf(ADVISORY);
    const tournament = body.indexOf(TOURNAMENT_LOCK);
    const event = body.indexOf(EVENT_LOCK);
    expect(advisory).toBeGreaterThan(-1);
    expect(tournament).toBeGreaterThan(advisory);
    expect(event).toBeGreaterThan(tournament);
    expect(body.indexOf("'invalid_limit'")).toBeGreaterThan(event);
    expect(body).toContain("'event_status'");
    expect(body).toContain("'external_event'");
    expect(body).toContain('SECURITY DEFINER');
  });

  it('revokes every function from the client roles and grants it to service_role', () => {
    for (const sig of SIGNATURES) {
      expect(sql, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(sql, sig).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('does not redefine set_event_waitlist', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.set_event_waitlist(');
  });

  it('commits once and ends by reloading the PostgREST schema', () => {
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });
});
