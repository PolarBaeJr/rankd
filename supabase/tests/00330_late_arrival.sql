-- ============================================================
-- 00330_late_arrival.sql: a released late arrival comes back.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00330 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00330_late_arrival.sql
--
-- WHAT IT PROVES
-- --------------
-- A. A member who withdrew themselves is not a released entry.
-- B. Reinstated while the place is free: registered, not checked in, and
--    the check-in-close warning rescinded.
-- C. Once somebody else has the place: place_taken, and nothing changes.
-- D. Back to the reserves at the head: the entry is gone, they wait ahead of
--    the reserve already there, and the warning stays.
-- E. A pair: refused once the event has a match; otherwise both members wait
--    at the back, in their order.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0330-4000-8000-000000000001','late330-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0330-4000-8000-000000000002','late330-2@example.invalid','MemberB','recreational'),
 ('dddddddd-0330-4000-8000-000000000003','late330-3@example.invalid','MemberC','recreational'),
 ('dddddddd-0330-4000-8000-000000000004','late330-4@example.invalid','MemberD','recreational'),
 ('dddddddd-0330-4000-8000-000000000005','late330-5@example.invalid','MemberE','recreational'),
 ('dddddddd-0330-4000-8000-000000000006','late330-6@example.invalid','MemberF','recreational'),
 ('dddddddd-0330-4000-8000-000000000007','late330-7@example.invalid','MemberG','recreational'),
 ('dddddddd-0330-4000-8000-000000000008','late330-8@example.invalid','MemberH','recreational'),
 ('dddddddd-0330-4000-8000-000000000009','late330-exec@example.invalid','MemberExec','recreational');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0330-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0330-4000-8000-0000000000a1', 'Team Plover Open', CURRENT_DATE, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status, max_participants, waitlist_enabled, waitlist_auto_promote) VALUES
 ('dddddddd-0330-4000-8000-0000000000e1', 'dddddddd-0330-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'checkin', 2, true, false),
 ('dddddddd-0330-4000-8000-0000000000e2', 'dddddddd-0330-4000-8000-0000000000a1', 'open_doubles', 'single_elimination', 'checkin', 4, true, false);

INSERT INTO tournament_participants (id, event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0330-4000-8000-0000000000f1', 'dddddddd-0330-4000-8000-0000000000e1', 'dddddddd-0330-4000-8000-000000000001', 1000, 'registered'),
 ('dddddddd-0330-4000-8000-0000000000f2', 'dddddddd-0330-4000-8000-0000000000e1', 'dddddddd-0330-4000-8000-000000000002', 1000, 'checked_in'),
 ('dddddddd-0330-4000-8000-0000000000f3', 'dddddddd-0330-4000-8000-0000000000e1', 'dddddddd-0330-4000-8000-000000000003', 1000, 'withdrawn');
INSERT INTO tournament_event_waitlist (event_id, player_id, joined_at) VALUES
 ('dddddddd-0330-4000-8000-0000000000e1', 'dddddddd-0330-4000-8000-000000000004', now() - interval '1 hour'),
 ('dddddddd-0330-4000-8000-0000000000e2', 'dddddddd-0330-4000-8000-000000000008', now() - interval '1 hour');
INSERT INTO tournament_pairs (id, event_id, player1_id, player2_id, status) VALUES
 ('dddddddd-0330-4000-8000-0000000000b1', 'dddddddd-0330-4000-8000-0000000000e2', 'dddddddd-0330-4000-8000-000000000006', 'dddddddd-0330-4000-8000-000000000007', 'registered');

SELECT release_checkin_no_shows('dddddddd-0330-4000-8000-0000000000e1', 'dddddddd-0330-4000-8000-000000000009', true);
SELECT release_checkin_no_shows('dddddddd-0330-4000-8000-0000000000e2', 'dddddddd-0330-4000-8000-000000000009', true);

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := reinstate_released_entry('dddddddd-0330-4000-8000-0000000000f3', false, 'dddddddd-0330-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'not_released' THEN
    RAISE EXCEPTION 'A: a member who withdrew themselves came back with %', v_res;
  END IF;
  RAISE NOTICE 'A passed: only a released entry comes back';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := reinstate_released_entry('dddddddd-0330-4000-8000-0000000000f1', false, 'dddddddd-0330-4000-8000-000000000009');
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'B1: reinstate with the place free returned %', v_res;
  END IF;
  IF (SELECT status::text FROM tournament_participants WHERE id = 'dddddddd-0330-4000-8000-0000000000f1') <> 'registered' THEN
    RAISE EXCEPTION 'B2: a reinstated entry is not registered';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance_warnings
              WHERE player_id = 'dddddddd-0330-4000-8000-000000000001' AND rescinded_at IS NULL) THEN
    RAISE EXCEPTION 'B3: the warning of a member who came was kept';
  END IF;
  RAISE NOTICE 'B passed: reinstated to registered, the warning rescinded';
END;
$$;

-- Released again, and somebody else takes the place.
SELECT release_checkin_no_shows('dddddddd-0330-4000-8000-0000000000e1', 'dddddddd-0330-4000-8000-000000000009', true);
INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0330-4000-8000-0000000000e1', 'dddddddd-0330-4000-8000-000000000005', 1000, 'checked_in');

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := reinstate_released_entry('dddddddd-0330-4000-8000-0000000000f1', false, 'dddddddd-0330-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'place_taken' THEN
    RAISE EXCEPTION 'C1: reinstate into a full event returned %', v_res;
  END IF;
  IF (SELECT status::text FROM tournament_participants WHERE id = 'dddddddd-0330-4000-8000-0000000000f1') <> 'withdrawn' THEN
    RAISE EXCEPTION 'C2: a refused reinstate changed the entry';
  END IF;
  RAISE NOTICE 'C passed: a taken place is refused';
END;
$$;

DO $$
DECLARE
  v_res   jsonb;
  v_first uuid;
BEGIN
  v_res := requeue_released_entry('dddddddd-0330-4000-8000-0000000000f1', false, 'dddddddd-0330-4000-8000-000000000009', true);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'D1: requeue at the head returned %', v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_participants WHERE id = 'dddddddd-0330-4000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'D2: the released entry is still there';
  END IF;
  SELECT player_id INTO v_first FROM tournament_event_waitlist
   WHERE event_id = 'dddddddd-0330-4000-8000-0000000000e1' AND status = 'waiting'
   ORDER BY joined_at, id LIMIT 1;
  IF v_first IS DISTINCT FROM 'dddddddd-0330-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'D3: the head of the reserves is %', v_first;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM attendance_warnings
                  WHERE player_id = 'dddddddd-0330-4000-8000-000000000001' AND rescinded_at IS NULL) THEN
    RAISE EXCEPTION 'D4: the late warning went with the requeue';
  END IF;
  RAISE NOTICE 'D passed: at the head of the reserves, still warned';
END;
$$;

DO $$
DECLARE
  v_res   jsonb;
  v_order uuid[];
BEGIN
  INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, status)
  VALUES ('dddddddd-0330-4000-8000-0000000000c1', 'dddddddd-0330-4000-8000-0000000000e2', 1, 1, 'pending');
  v_res := requeue_released_entry('dddddddd-0330-4000-8000-0000000000b1', true, 'dddddddd-0330-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'drawn' THEN
    RAISE EXCEPTION 'E1: a requeue after the draw returned %', v_res;
  END IF;
  DELETE FROM tournament_matches WHERE id = 'dddddddd-0330-4000-8000-0000000000c1';

  v_res := requeue_released_entry('dddddddd-0330-4000-8000-0000000000b1', true, 'dddddddd-0330-4000-8000-000000000009');
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'E2: a pair requeue returned %', v_res;
  END IF;
  SELECT array_agg(player_id ORDER BY joined_at, id) INTO v_order FROM tournament_event_waitlist
   WHERE event_id = 'dddddddd-0330-4000-8000-0000000000e2' AND status = 'waiting';
  IF v_order IS DISTINCT FROM ARRAY[
       'dddddddd-0330-4000-8000-000000000008',
       'dddddddd-0330-4000-8000-000000000006',
       'dddddddd-0330-4000-8000-000000000007']::uuid[] THEN
    RAISE EXCEPTION 'E3: the doubles reserves read %', v_order;
  END IF;
  RAISE NOTICE 'E passed: refused after the draw; a pair waits at the back, in order';
END;
$$;

ROLLBACK;
