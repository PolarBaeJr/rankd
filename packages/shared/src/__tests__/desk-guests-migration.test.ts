import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00317: THE DESK ADDS SOMEBODY ON THE SPOT.
 *
 * create_desk_guest makes a guest the way 00306 makes one with no email, and
 * club_event_desk_entry_walk_in leaves a linked club event's fee off only when
 * it is unpaid.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');
const file = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('00317_'))!;
const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
const code = sql.replace(/--[^\n]*/g, ' ');

describe('00317: desk guests on the spot', () => {
  it('makes the guest through create_guest_player with an undeliverable address, as 00306 does', () => {
    expect(code).toContain("public.create_guest_player(\n    'guest+' || gen_random_uuid()::text || '@no-email.invalid'");
    expect(code).toMatch(/char_length\(v_name\) NOT BETWEEN 1 AND 120/);
    expect(code).toMatch(/IF p_actor IS NULL THEN/);
  });

  it('waives only an unpaid club-event fee, and makes the sign-up a walk-in', () => {
    expect(code).toContain('SET walk_in = true');
    expect(code).toMatch(/f\.fee_type = 'event' AND f\.club_event_id = v_club[\s\S]*f\.paid_at IS NULL/);
    expect(code).toMatch(/IF v_club IS NULL OR p_player_ids IS NULL/);
  });

  it('keeps both functions service_role only', () => {
    for (const sig of ['create_desk_guest(text, uuid)', 'club_event_desk_entry_walk_in(uuid, uuid[])']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('has no top-level COMMIT and no em dash', () => {
    expect(sql).not.toMatch(/^COMMIT;/m);
    expect(sql).not.toContain('\u2014');
  });
});
