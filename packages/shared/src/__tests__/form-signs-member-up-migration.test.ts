import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00291, READ OFF DISK. A club event's Google Form signs a member up at once
// (no confirm step), tells them in the app only, and "Not me" takes the
// sign-up back. Tournaments keep the confirm step. The scenario (a member
// signed up and billed, a draft holding the notice until published, Not me
// withdrawing the sign-up and its unpaid fee) was run against a local
// database inside a rolled-back transaction.

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

const sql = migration('00291_');
const apply = fn(sql, 'registration_import_apply(');
const previousApply = fn(migration('00290_'), 'registration_import_apply(');
const reject = fn(sql, 'reject_registration_import_entry(');
const onPublish = fn(sql, 'club_event_form_alerts_on_publish(');

describe('00291 a form signs a member up', () => {
  it('changes only the club event member branch of the import', () => {
    const memberBranch = (body: string) => {
      const club = body.indexOf('-- ================= a club event =================');
      const start = body.indexOf('IF v_status IS NULL AND v_has_member THEN', club);
      return [start, body.indexOf('ELSIF v_status IS NULL THEN', start)];
    };
    const [a, b] = memberBranch(apply);
    const [c, d] = memberBranch(previousApply);
    expect(apply.slice(0, a)).toBe(previousApply.slice(0, c));
    expect(apply.slice(b)).toBe(previousApply.slice(d));
  });

  it('signs the member up and lets the sign-up trigger bill them', () => {
    expect(apply).toContain('INSERT INTO club_event_signups (event_id, player_id) VALUES (v_ev, v_member.id);');
    expect(apply).not.toContain("v_status := 'awaiting_member';\n            END IF;\n            INSERT INTO registration_import_entries (import_id, item, club_event_id");
    // The tournament branch still waits for the member.
    expect(apply).toContain("v_status := 'awaiting_member'");
  });

  it('holds the in-app notice while the event is a draft and sends it on publish', () => {
    expect(apply).toContain("IF v_status = 'entered' AND v_club.status = 'published' THEN");
    expect(apply).toContain("'registration_import_signed_up'");
    expect(onPublish).toContain("en.status = 'entered'");
    expect(onPublish).toContain("'registration_import_signed_up'");
  });

  it('lets Not me take back an entered club event sign-up, never a tournament entry', () => {
    expect(reject).toContain("(v_entry.status = 'entered' AND v_entry.club_event_id IS NOT NULL)");
    expect(reject).toContain('DELETE FROM club_event_signups s');
    expect(reject).toContain('FOR NO KEY UPDATE');
  });

  it('keeps the grants', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.registration_import_apply(uuid, uuid, text, jsonb)\n  FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.reject_registration_import_entry(uuid, uuid) TO service_role;');
  });
});
