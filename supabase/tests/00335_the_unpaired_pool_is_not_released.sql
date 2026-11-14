-- ============================================================
-- 00335_the_unpaired_pool_is_not_released.sql
--
-- NOT a migration. One transaction ending in ROLLBACK, safe against a
-- database that has 00335 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00335_the_unpaired_pool_is_not_released.sql
--
-- WHAT IT PROVES
-- A. In a doubles event, check-in close releases and warns the pair nobody
--    checked in, and leaves the unpaired pool member registered and unwarned.
-- B. In a singles event, a participant nobody checked in is still released.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0335-4000-8000-000000000001','pool-harness-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0335-4000-8000-000000000002','pool-harness-2@example.invalid','MemberB','recreational'),
 ('dddddddd-0335-4000-8000-000000000003','pool-harness-3@example.invalid','MemberC','recreational'),
 ('dddddddd-0335-4000-8000-000000000004','pool-harness-4@example.invalid','MemberD','recreational'),
 ('dddddddd-0335-4000-8000-000000000009','pool-harness-exec@example.invalid','MemberExec','recreational');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0335-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0335-4000-8000-0000000000a1', 'Team Plover Open', CURRENT_DATE, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status, max_participants) VALUES
 ('dddddddd-0335-4000-8000-0000000000e1', 'dddddddd-0335-4000-8000-0000000000a1', 'open_doubles', 'single_elimination', 'checkin', 8),
 ('dddddddd-0335-4000-8000-0000000000e2', 'dddddddd-0335-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'checkin', 8);
INSERT INTO tournament_pairs (event_id, player1_id, player2_id, status) VALUES
 ('dddddddd-0335-4000-8000-0000000000e1', 'dddddddd-0335-4000-8000-000000000001', 'dddddddd-0335-4000-8000-000000000002', 'registered');
INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0335-4000-8000-0000000000e1', 'dddddddd-0335-4000-8000-000000000003', 1000, 'registered'),
 ('dddddddd-0335-4000-8000-0000000000e2', 'dddddddd-0335-4000-8000-000000000004', 1000, 'registered');

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := release_checkin_no_shows('dddddddd-0335-4000-8000-0000000000e1', 'dddddddd-0335-4000-8000-000000000009');
  IF NOT (v_res->>'ok')::boolean OR jsonb_array_length(v_res->'released') <> 1
     OR NOT (v_res->'released'->0->>'is_pair')::boolean THEN
    RAISE EXCEPTION 'A1: the doubles release returned %', v_res;
  END IF;
  IF (SELECT status::text FROM tournament_participants
       WHERE event_id = 'dddddddd-0335-4000-8000-0000000000e1'
         AND player_id = 'dddddddd-0335-4000-8000-000000000003') <> 'registered' THEN
    RAISE EXCEPTION 'A2: the unpaired pool member was released';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance_warnings WHERE player_id = 'dddddddd-0335-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'A3: the unpaired pool member was warned';
  END IF;
  IF (SELECT count(*) FROM attendance_warnings
       WHERE player_id IN ('dddddddd-0335-4000-8000-000000000001', 'dddddddd-0335-4000-8000-000000000002')) <> 2 THEN
    RAISE EXCEPTION 'A4: the absent pair was not warned';
  END IF;
  RAISE NOTICE 'A passed: the pair is released, the pool is left alone';

  v_res := release_checkin_no_shows('dddddddd-0335-4000-8000-0000000000e2', 'dddddddd-0335-4000-8000-000000000009');
  IF jsonb_array_length(v_res->'released') <> 1
     OR (SELECT status::text FROM tournament_participants
          WHERE player_id = 'dddddddd-0335-4000-8000-000000000004') <> 'withdrawn' THEN
    RAISE EXCEPTION 'B1: the singles release returned %', v_res;
  END IF;
  RAISE NOTICE 'B passed: a singles entrant nobody checked in is still released';
END;
$$;

ROLLBACK;
