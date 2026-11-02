-- ============================================================
-- 00312_waitlist_limit.sql: a waitlist can be capped.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00312 applied:
--
--   docker exec -i supabase_db_cli psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/00312_waitlist_limit.sql
--
-- WHAT IT PROVES
-- --------------
-- A. A tournament event with a limit of 1: the first join is accepted, the
--    second is refused (waitlist_full), and a member already waiting still
--    hears already_waiting. No limit lets the next member through; lowering
--    the limit to 1 with two waiting keeps both and refuses the next.
-- B. The setting: 0 is refused (invalid_limit), and a direct UPDATE to 0
--    breaks the CHECK.
-- C. A club event with capacity 1 and a limit of 1: the same flow.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0312-4000-8000-000000000001','waitlist-limit-harness-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0312-4000-8000-000000000002','waitlist-limit-harness-2@example.invalid','MemberB','recreational'),
 ('dddddddd-0312-4000-8000-000000000003','waitlist-limit-harness-3@example.invalid','MemberC','recreational'),
 ('dddddddd-0312-4000-8000-000000000004','waitlist-limit-harness-4@example.invalid','MemberD','recreational'),
 ('dddddddd-0312-4000-8000-000000000009','waitlist-limit-harness-exec@example.invalid','MemberExec','recreational');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0312-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date) VALUES
 ('dddddddd-0312-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE);

INSERT INTO tournament_events (id, tournament_id, event_type, format, status, max_participants) VALUES
 ('dddddddd-0312-4000-8000-0000000000e1', 'dddddddd-0312-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'registration', 1);

INSERT INTO club_events (id, title, starts_at, capacity, status) VALUES
 ('dddddddd-0312-4000-8000-0000000000c1', 'Team Kestrel Social', now() + interval '1 day', 1, 'published');

-- ------------------------------------------------------------
-- A. A tournament event with a limit
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
  e1 uuid := 'dddddddd-0312-4000-8000-0000000000e1';
  v_exec uuid := 'dddddddd-0312-4000-8000-000000000009';
BEGIN
  v_res := set_event_waitlist(e1, true, true, v_exec);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A0: switching the waitlist on returned %', v_res; END IF;

  v_res := enter_tournament_event(e1, 'dddddddd-0312-4000-8000-000000000001', 1000, false);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A1: the first entry returned %', v_res; END IF;

  v_res := set_event_waitlist_limit(e1, 1, v_exec);
  IF NOT (v_res->>'ok')::boolean OR (v_res->>'limit')::int IS DISTINCT FROM 1
     OR v_res->'previous_limit' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'A2: setting the limit returned %', v_res;
  END IF;

  v_res := join_event_waitlist(e1, 'dddddddd-0312-4000-8000-000000000002', false);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A3: the first join returned %', v_res; END IF;

  v_res := join_event_waitlist(e1, 'dddddddd-0312-4000-8000-000000000003', false);
  IF v_res->>'reason' IS DISTINCT FROM 'waitlist_full' OR (v_res->>'limit')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'A4: a join past the limit returned %', v_res;
  END IF;

  v_res := join_event_waitlist(e1, 'dddddddd-0312-4000-8000-000000000002', false);
  IF v_res->>'reason' IS DISTINCT FROM 'already_waiting' THEN
    RAISE EXCEPTION 'A5: a member already waiting returned %', v_res;
  END IF;

  v_res := set_event_waitlist_limit(e1, NULL, v_exec);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A6: clearing the limit returned %', v_res; END IF;

  v_res := join_event_waitlist(e1, 'dddddddd-0312-4000-8000-000000000003', false);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A7: a join with no limit returned %', v_res; END IF;

  -- Lowering the limit below the queue takes nobody off.
  v_res := set_event_waitlist_limit(e1, 1, v_exec);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A8: lowering the limit returned %', v_res; END IF;
  IF (SELECT count(*) FROM tournament_event_waitlist WHERE event_id = e1 AND status = 'waiting') <> 2 THEN
    RAISE EXCEPTION 'A9: lowering the limit removed somebody';
  END IF;

  v_res := join_event_waitlist(e1, 'dddddddd-0312-4000-8000-000000000004', false);
  IF v_res->>'reason' IS DISTINCT FROM 'waitlist_full' THEN
    RAISE EXCEPTION 'A10: a join past a lowered limit returned %', v_res;
  END IF;

  RAISE NOTICE 'A passed: the tournament waitlist stops at its limit';
END;
$$;

-- ------------------------------------------------------------
-- B. The setting
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
  e1 uuid := 'dddddddd-0312-4000-8000-0000000000e1';
BEGIN
  v_res := set_event_waitlist_limit(e1, 0, 'dddddddd-0312-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'invalid_limit' THEN RAISE EXCEPTION 'B1: a limit of 0 returned %', v_res; END IF;

  BEGIN
    UPDATE tournament_events SET waitlist_limit = 0 WHERE id = e1;
    RAISE EXCEPTION 'B2: a direct UPDATE to 0 was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE club_events SET waitlist_limit = 0 WHERE id = 'dddddddd-0312-4000-8000-0000000000c1';
    RAISE EXCEPTION 'B3: a direct UPDATE to 0 on a club event was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  RAISE NOTICE 'B passed: the limit is at least 1';
END;
$$;

-- ------------------------------------------------------------
-- C. A club event with a limit
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
  c1 uuid := 'dddddddd-0312-4000-8000-0000000000c1';
BEGIN
  INSERT INTO club_event_signups (event_id, player_id) VALUES (c1, 'dddddddd-0312-4000-8000-000000000001');
  UPDATE club_events SET waitlist_limit = 1 WHERE id = c1;

  v_res := club_event_join_waitlist(c1, 'dddddddd-0312-4000-8000-000000000002');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'C1: the first join returned %', v_res; END IF;

  v_res := club_event_join_waitlist(c1, 'dddddddd-0312-4000-8000-000000000003');
  IF v_res->>'reason' IS DISTINCT FROM 'waitlist_full' OR (v_res->>'limit')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'C2: a join past the limit returned %', v_res;
  END IF;

  v_res := club_event_join_waitlist(c1, 'dddddddd-0312-4000-8000-000000000002');
  IF v_res->>'reason' IS DISTINCT FROM 'already_waiting' THEN
    RAISE EXCEPTION 'C3: a member already waiting returned %', v_res;
  END IF;

  UPDATE club_events SET waitlist_limit = NULL WHERE id = c1;
  v_res := club_event_join_waitlist(c1, 'dddddddd-0312-4000-8000-000000000003');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'C4: a join with no limit returned %', v_res; END IF;

  RAISE NOTICE 'C passed: the club event waitlist stops at its limit';
END;
$$;

ROLLBACK;
