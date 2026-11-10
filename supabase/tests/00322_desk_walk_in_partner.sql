-- ============================================================
-- 00322_desk_walk_in_partner.sql: the desk walk-in spares a partner, and
-- the unfinished-signup purge spares a signed waiver (00323).
--
-- NOT a migration. Every statement runs inside one transaction that ends in
-- ROLLBACK, so it leaves nothing behind:
--
--   docker exec -i <db container> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/00322_desk_walk_in_partner.sql
--
-- WHAT IT PROVES
-- --------------
-- A. club_event_desk_entry_walk_in, given a pair where B signed up in advance
--    and has a receipt under review: B's fee, receipt and sign-up are left
--    alone. A player with an unpaid fee and no receipt is still waived. 00317
--    deleted B's fee, and the cascade took the receipt with it.
-- B. purgeable_unfinished_signups lists an abandoned sign-up, and stops
--    listing it once that player has a waiver acceptance.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('eeeeeeee-0322-4000-8000-000000000001','desk-walk-in-harness-1@example.invalid','MemberA','recreational'),
 ('eeeeeeee-0322-4000-8000-000000000002','desk-walk-in-harness-2@example.invalid','MemberB','recreational');

INSERT INTO tournaments (id, name, start_date) VALUES
 ('eeeeeeee-0322-4000-8000-0000000000a1', 'Team Plover Open', CURRENT_DATE);
INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('eeeeeeee-0322-4000-8000-0000000000e1', 'eeeeeeee-0322-4000-8000-0000000000a1', 'open_doubles', 'single_elimination', 'registration');
INSERT INTO club_events (id, title, starts_at, status, tournament_event_id) VALUES
 ('eeeeeeee-0322-4000-8000-0000000000c1', 'Team Plover Social', now() + interval '1 day', 'published',
  'eeeeeeee-0322-4000-8000-0000000000e1');

-- ------------------------------------------------------------
-- A. The desk walk-in
-- ------------------------------------------------------------
DO $$
DECLARE
  c1 uuid := 'eeeeeeee-0322-4000-8000-0000000000c1';
  e1 uuid := 'eeeeeeee-0322-4000-8000-0000000000e1';
  pa uuid := 'eeeeeeee-0322-4000-8000-000000000001';
  pb uuid := 'eeeeeeee-0322-4000-8000-000000000002';
  v_removed integer;
BEGIN
  INSERT INTO club_event_signups (event_id, player_id) VALUES (c1, pa), (c1, pb)
  ON CONFLICT DO NOTHING;
  -- Whatever the sign-up charged, each player owes exactly one unpaid event fee.
  DELETE FROM club_fees WHERE club_event_id = c1;
  INSERT INTO club_fees (player_id, fee_type, club_event_id, amount_cents)
  VALUES (pa, 'event', c1, 1000), (pb, 'event', c1, 1000);
  INSERT INTO fee_submissions (club_fee_id, player_id, status, reference)
  SELECT f.id, pb, 'submitted', 'PLOVER01' FROM club_fees f WHERE f.club_event_id = c1 AND f.player_id = pb;

  v_removed := club_event_desk_entry_walk_in(e1, ARRAY[pa, pb]);

  IF v_removed <> 1 THEN
    RAISE EXCEPTION 'A1: expected 1 fee removed, got %', v_removed;
  END IF;
  IF EXISTS (SELECT 1 FROM club_fees WHERE club_event_id = c1 AND player_id = pa) THEN
    RAISE EXCEPTION 'A2: A owes nothing and has no receipt, so A''s fee should be gone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM club_fees WHERE club_event_id = c1 AND player_id = pb) THEN
    RAISE EXCEPTION 'A3: B''s fee was deleted although B has a receipt under review';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fee_submissions fs JOIN club_fees f ON f.id = fs.club_fee_id
                  WHERE f.club_event_id = c1 AND f.player_id = pb) THEN
    RAISE EXCEPTION 'A4: B''s receipt was deleted';
  END IF;
  IF (SELECT walk_in FROM club_event_signups WHERE event_id = c1 AND player_id = pb) THEN
    RAISE EXCEPTION 'A5: B''s advance sign-up was turned into a walk-in';
  END IF;
  IF NOT (SELECT walk_in FROM club_event_signups WHERE event_id = c1 AND player_id = pa) THEN
    RAISE EXCEPTION 'A6: A should be a walk-in';
  END IF;

  RAISE NOTICE 'A passed: the desk walk-in leaves a partner with a receipt alone';
END;
$$;

-- ------------------------------------------------------------
-- B. The purge view spares a signed waiver
-- ------------------------------------------------------------
DO $$
DECLARE
  pa uuid := 'eeeeeeee-0322-4000-8000-000000000001';
  ua uuid := 'eeeeeeee-0322-4000-8000-0000000000f1';
BEGIN
  DELETE FROM club_event_signups WHERE player_id = pa;
  DELETE FROM club_fees WHERE player_id = pa;
  INSERT INTO auth.users (id, email) VALUES (ua, 'desk-walk-in-harness-auth@example.invalid');
  UPDATE players
     SET user_id = ua, onboarding_completed = false, first_name = '',
         created_at = now() - interval '60 days'
   WHERE id = pa;

  IF NOT EXISTS (SELECT 1 FROM purgeable_unfinished_signups WHERE id = pa) THEN
    RAISE EXCEPTION 'B1: an abandoned sign-up with no waiver should be purgeable';
  END IF;

  INSERT INTO waiver_acceptances (player_id, document, version) VALUES (pa, 'waiver', 'harness');

  IF EXISTS (SELECT 1 FROM purgeable_unfinished_signups WHERE id = pa) THEN
    RAISE EXCEPTION 'B2: a player with a signed waiver is listed for purging';
  END IF;

  RAISE NOTICE 'B passed: the purge view spares a signed waiver';
END;
$$;

ROLLBACK;
