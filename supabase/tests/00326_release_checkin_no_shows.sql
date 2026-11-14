-- ============================================================
-- 00326_release_checkin_no_shows.sql: check-in close releases the no-shows.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00326 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00326_release_checkin_no_shows.sql
--
-- WHAT IT PROVES
-- --------------
-- A. Refused outside check-in.
-- B. In check-in: the registered participant is withdrawn and warned, the
--    checked-in one stays, a pair with one member here stays, a pair with
--    neither is withdrawn and both are warned. Nothing is filled from the
--    waitlist, and the open places are counted.
-- C. p_warn false withdraws without a warning.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0326-4000-8000-000000000001','release-harness-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0326-4000-8000-000000000002','release-harness-2@example.invalid','MemberB','recreational'),
 ('dddddddd-0326-4000-8000-000000000003','release-harness-3@example.invalid','MemberC','recreational'),
 ('dddddddd-0326-4000-8000-000000000004','release-harness-4@example.invalid','MemberD','recreational'),
 ('dddddddd-0326-4000-8000-000000000005','release-harness-5@example.invalid','MemberE','recreational'),
 ('dddddddd-0326-4000-8000-000000000006','release-harness-6@example.invalid','MemberF','recreational'),
 ('dddddddd-0326-4000-8000-000000000007','release-harness-7@example.invalid','MemberG','recreational'),
 ('dddddddd-0326-4000-8000-000000000009','release-harness-exec@example.invalid','MemberExec','recreational');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0326-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0326-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status, max_participants, waitlist_enabled, waitlist_auto_promote) VALUES
 ('dddddddd-0326-4000-8000-0000000000e1', 'dddddddd-0326-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'registration', 4, true, true),
 ('dddddddd-0326-4000-8000-0000000000e2', 'dddddddd-0326-4000-8000-0000000000a1', 'open_doubles', 'single_elimination', 'checkin', 4, false, false);

INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0326-4000-8000-0000000000e1', 'dddddddd-0326-4000-8000-000000000001', 1000, 'registered'),
 ('dddddddd-0326-4000-8000-0000000000e1', 'dddddddd-0326-4000-8000-000000000002', 1000, 'checked_in');
INSERT INTO tournament_event_waitlist (event_id, player_id) VALUES
 ('dddddddd-0326-4000-8000-0000000000e1', 'dddddddd-0326-4000-8000-000000000007');
INSERT INTO tournament_pairs (event_id, player1_id, player2_id, status, player1_checked_in_at) VALUES
 ('dddddddd-0326-4000-8000-0000000000e2', 'dddddddd-0326-4000-8000-000000000003', 'dddddddd-0326-4000-8000-000000000004', 'registered', now());
INSERT INTO tournament_pairs (event_id, player1_id, player2_id, status) VALUES
 ('dddddddd-0326-4000-8000-0000000000e2', 'dddddddd-0326-4000-8000-000000000005', 'dddddddd-0326-4000-8000-000000000006', 'registered');

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := release_checkin_no_shows('dddddddd-0326-4000-8000-0000000000e1', 'dddddddd-0326-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'event_status' THEN
    RAISE EXCEPTION 'A: a release during registration returned %', v_res;
  END IF;
  RAISE NOTICE 'A passed: refused outside check-in';
END;
$$;

UPDATE tournament_events SET status = 'checkin' WHERE id = 'dddddddd-0326-4000-8000-0000000000e1';

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := release_checkin_no_shows('dddddddd-0326-4000-8000-0000000000e1', 'dddddddd-0326-4000-8000-000000000009');
  IF NOT (v_res->>'ok')::boolean OR jsonb_array_length(v_res->'released') <> 1 THEN
    RAISE EXCEPTION 'B1: the singles release returned %', v_res;
  END IF;
  IF (SELECT status::text FROM tournament_participants WHERE player_id = 'dddddddd-0326-4000-8000-000000000001') <> 'withdrawn'
     OR (SELECT status::text FROM tournament_participants WHERE player_id = 'dddddddd-0326-4000-8000-000000000002') <> 'checked_in' THEN
    RAISE EXCEPTION 'B2: the wrong participant was released';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM attendance_warnings WHERE player_id = 'dddddddd-0326-4000-8000-000000000001'
                   AND kind = 'no_show' AND source = 'checkin_close') THEN
    RAISE EXCEPTION 'B3: the released member was not warned';
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_participants WHERE player_id = 'dddddddd-0326-4000-8000-000000000007') THEN
    RAISE EXCEPTION 'B4: the release filled from the waitlist';
  END IF;
  IF (v_res->>'open_slots')::int <> 3 THEN
    RAISE EXCEPTION 'B5: open_slots is %, not 3', v_res->>'open_slots';
  END IF;

  v_res := release_checkin_no_shows('dddddddd-0326-4000-8000-0000000000e2', 'dddddddd-0326-4000-8000-000000000009');
  IF jsonb_array_length(v_res->'released') <> 1 THEN
    RAISE EXCEPTION 'B6: the doubles release returned %', v_res;
  END IF;
  IF (SELECT status::text FROM tournament_pairs WHERE player1_id = 'dddddddd-0326-4000-8000-000000000003') <> 'registered'
     OR (SELECT status::text FROM tournament_pairs WHERE player1_id = 'dddddddd-0326-4000-8000-000000000005') <> 'withdrawn' THEN
    RAISE EXCEPTION 'B7: the wrong pair was released';
  END IF;
  IF (SELECT count(*) FROM attendance_warnings
       WHERE player_id IN ('dddddddd-0326-4000-8000-000000000005', 'dddddddd-0326-4000-8000-000000000006')) <> 2 THEN
    RAISE EXCEPTION 'B8: both members of the released pair were not warned';
  END IF;
  RAISE NOTICE 'B passed: the entries nobody checked in are released and warned';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
   ('dddddddd-0326-4000-8000-0000000000e1', 'dddddddd-0326-4000-8000-000000000006', 1000, 'registered');
  v_res := release_checkin_no_shows('dddddddd-0326-4000-8000-0000000000e1', 'dddddddd-0326-4000-8000-000000000009', false);
  IF jsonb_array_length(v_res->'released') <> 1 THEN RAISE EXCEPTION 'C1: returned %', v_res; END IF;
  IF EXISTS (SELECT 1 FROM attendance_warnings WHERE player_id = 'dddddddd-0326-4000-8000-000000000006'
               AND event_id = 'dddddddd-0326-4000-8000-0000000000e1') THEN
    RAISE EXCEPTION 'C2: a release without warnings wrote one';
  END IF;
  RAISE NOTICE 'C passed: no warning when none is asked';
END;
$$;

ROLLBACK;
