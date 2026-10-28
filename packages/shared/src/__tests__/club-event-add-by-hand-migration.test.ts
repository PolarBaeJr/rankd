import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00306, READ OFF DISK. Somebody an officer adds by hand must end up a player
// record signed up like a member, so the fee trigger charges them and a
// tournament link enters them; and with no email they must hold an address no
// mail can reach.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');
const name = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith('_an_officer_adds_somebody_by_hand.sql'));
const sql = readFileSync(join(MIGRATIONS_DIR, name as string), 'utf8');
const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.club_event_add_by_hand('), sql.indexOf('$function$;'));

describe('00306 club_event_add_by_hand', () => {
  it('signs everybody up as a player record, never a name-only external row', () => {
    expect(body).toContain('INSERT INTO public.club_event_signups (event_id, player_id, preferred_partner, answers)');
    expect(body).not.toContain('INSERT INTO public.club_event_external_signups');
    expect(body).toContain('public.create_guest_player(');
  });

  it('gives a guest with no email an undeliverable .invalid address', () => {
    expect(body).toContain("'guest+' || gen_random_uuid()::text || '@no-email.invalid'");
    // A typed address on the reserved domain is refused, so only the
    // placeholder ever holds one.
    expect(body).toContain("v_email LIKE '%.invalid'");
  });

  it('adds a member only when they could sign up themselves', () => {
    expect(body).toContain("v_status IN ('pending_approval', 'suspended')");
    expect(body).toContain('v_banned OR v_deleting IS NOT NULL');
  });

  it('marks only the fee the trigger made, and never as waived', () => {
    expect(body).toContain("v_method = 'waived'");
    expect(body).toContain('WHERE id = v_fee AND paid_at IS NULL');
  });

  it('is the service role only, both client roles named', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.club_event_add_by_hand\([^)]*\)\s+FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.club_event_add_by_hand\([^)]*\)\s+TO service_role;/);
  });
});
