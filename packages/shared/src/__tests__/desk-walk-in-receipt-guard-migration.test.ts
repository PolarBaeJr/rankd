import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00322: THE DESK'S WALK-IN SPARES A FEE THAT HOLDS A RECEIPT.
 *
 * club_event_desk_entry_walk_in (00317) deleted every unpaid event fee it was
 * given, and fee_submissions cascades from club_fees, so a partner's waiting
 * receipt went with their fee. 00322's two statements skip a fee with a
 * receipt submitted or confirmed, as the withdraw trigger (00248) does.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');
const file = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('00322_'))!;
const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
const code = sql.replace(/--[^\n]*/g, ' ');

describe('00322: the desk walk-in spares a fee that holds a receipt', () => {
  it('replaces the function under the same signature', () => {
    expect(code).toContain(
      'CREATE OR REPLACE FUNCTION public.club_event_desk_entry_walk_in(p_tournament_event_id uuid, p_player_ids uuid[])',
    );
  });

  it('deletes no fee with a receipt submitted or confirmed', () => {
    expect(code).toMatch(
      /DELETE FROM club_fees f[\s\S]*AND NOT EXISTS \(SELECT 1 FROM public\.fee_submissions s\s+WHERE s\.club_fee_id = f\.id AND s\.status IN \('submitted', 'confirmed'\)\)/,
    );
  });

  it('makes no walk-in of a sign-up whose fee holds a receipt', () => {
    const update = code.slice(code.indexOf('UPDATE club_event_signups s SET walk_in = true'), code.indexOf('DELETE FROM club_fees f'));
    expect(update).toMatch(/AND NOT EXISTS \(SELECT 1 FROM public\.club_fees f2/);
    expect(update).toMatch(/f2\.fee_type = 'event' AND f2\.club_event_id = v_club AND f2\.player_id = s\.player_id/);
    expect(update).toMatch(/fs\.status IN \('submitted', 'confirmed'\)/);
  });

  it('still returns the number of fees the DELETE removed', () => {
    expect(code).toMatch(/DELETE FROM club_fees f[\s\S]*GET DIAGNOSTICS v_removed = ROW_COUNT;\s+RETURN v_removed;/);
  });

  it('keeps the function service_role only', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.club_event_desk_entry_walk_in(uuid, uuid[]) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.club_event_desk_entry_walk_in(uuid, uuid[]) TO service_role;');
  });

  it('verifies itself and reloads PostgREST', () => {
    expect(code).toMatch(/DO \$verify\$/);
    expect(code).toContain("pg_get_functiondef('public.club_event_desk_entry_walk_in(uuid, uuid[])'::regprocedure)");
    expect(code).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('has no top-level COMMIT and no em dash', () => {
    expect(sql).not.toMatch(/^COMMIT;/m);
    expect(sql).not.toContain('\u2014');
  });
});
