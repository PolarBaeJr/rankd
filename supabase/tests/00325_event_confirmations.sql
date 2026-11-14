-- ============================================================
-- 00325_event_confirmations.sql: entries confirm before the day.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00325 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00325_event_confirmations.sql
--
-- WHAT IT PROVES
-- --------------
-- A. open_event_confirmations asks every member of an active entry once, both
--    partners of a pair, and a second run asks nobody again.
-- B. The claim hands a row out once, and the receipt records the outcome.
-- C. Either partner confirming keeps the pair; a second confirm is 'already'.
-- D. At the deadline: an entry emailed and unconfirmed is withdrawn and its
--    row released; an entry the email never reached is NOT released and its
--    row is 'unreached'; the confirmed pair stays. The freed place goes to the
--    waitlist when it promotes automatically.
-- E. A member's own confirm after the deadline is refused (past_deadline).
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0325-4000-8000-000000000001','confirm-harness-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0325-4000-8000-000000000002','confirm-harness-2@example.invalid','MemberB','recreational'),
 ('dddddddd-0325-4000-8000-000000000003','confirm-harness-3@example.invalid','MemberC','recreational'),
 ('dddddddd-0325-4000-8000-000000000004','confirm-harness-4@example.invalid','MemberD','recreational'),
 ('dddddddd-0325-4000-8000-000000000005','confirm-harness-5@example.invalid','MemberE','recreational'),
 ('dddddddd-0325-4000-8000-000000000006','confirm-harness-6@example.invalid','MemberF','recreational');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0325-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

-- Three days out with a window of 336 to 1 hours: the window is open now.
INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0325-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE + 3, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status, max_participants,
                               confirm_required, confirm_opens_hours, confirm_deadline_hours,
                               waitlist_enabled, waitlist_auto_promote) VALUES
 ('dddddddd-0325-4000-8000-0000000000e1', 'dddddddd-0325-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'registration', 2,
  true, 336, 1, true, true),
 ('dddddddd-0325-4000-8000-0000000000e2', 'dddddddd-0325-4000-8000-0000000000a1', 'open_doubles', 'single_elimination', 'registration', NULL,
  true, 336, 1, false, false);

INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0325-4000-8000-0000000000e1', 'dddddddd-0325-4000-8000-000000000001', 1000, 'registered'),
 ('dddddddd-0325-4000-8000-0000000000e1', 'dddddddd-0325-4000-8000-000000000002', 1000, 'registered');
INSERT INTO tournament_pairs (event_id, player1_id, player2_id, status) VALUES
 ('dddddddd-0325-4000-8000-0000000000e2', 'dddddddd-0325-4000-8000-000000000003', 'dddddddd-0325-4000-8000-000000000004', 'registered');
INSERT INTO tournament_event_waitlist (event_id, player_id) VALUES
 ('dddddddd-0325-4000-8000-0000000000e1', 'dddddddd-0325-4000-8000-000000000005');

DO $$
DECLARE
  v_n integer;
BEGIN
  v_n := open_event_confirmations();
  IF v_n <> 4 THEN RAISE EXCEPTION 'A1: the first run asked % members, not 4', v_n; END IF;
  v_n := open_event_confirmations();
  IF v_n <> 0 THEN RAISE EXCEPTION 'A2: the second run asked % members again', v_n; END IF;
  IF (SELECT count(*) FROM tournament_event_confirmations
       WHERE event_id = 'dddddddd-0325-4000-8000-0000000000e2' AND pair_id IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'A3: both partners of the pair were not asked';
  END IF;
  RAISE NOTICE 'A passed: every member is asked once';
END;
$$;

DO $$
DECLARE
  v_claimed integer;
  v_again   integer;
  v_row     record;
BEGIN
  SELECT count(*) INTO v_claimed FROM claim_event_confirmation_requests(50);
  SELECT count(*) INTO v_again FROM claim_event_confirmation_requests(50);
  IF v_claimed <> 4 OR v_again <> 0 THEN
    RAISE EXCEPTION 'B1: claimed % then %, not 4 then 0', v_claimed, v_again;
  END IF;
  -- Everyone but MemberB was reached.
  FOR v_row IN SELECT id, player_id FROM tournament_event_confirmations
                WHERE player_id::text LIKE 'dddddddd-0325-4000-8000-%' LOOP
    PERFORM record_event_confirmation_receipt(v_row.id, true,
      CASE WHEN v_row.player_id = 'dddddddd-0325-4000-8000-000000000002' THEN 'failed' ELSE 'sent' END,
      'harness');
  END LOOP;
  IF (SELECT count(*) FROM tournament_event_confirmations WHERE email_sent_at IS NOT NULL
        AND player_id::text LIKE 'dddddddd-0325-4000-8000-%') <> 3 THEN
    RAISE EXCEPTION 'B2: the receipts did not record three sends';
  END IF;
  RAISE NOTICE 'B passed: a row is claimed once and its receipt recorded';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := confirm_event_entry('dddddddd-0325-4000-8000-0000000000e2', 'dddddddd-0325-4000-8000-000000000003');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'C1: the confirm returned %', v_res; END IF;
  IF (SELECT status FROM tournament_event_confirmations
       WHERE player_id = 'dddddddd-0325-4000-8000-000000000004') <> 'confirmed' THEN
    RAISE EXCEPTION 'C2: the partner was not confirmed with the pair';
  END IF;
  v_res := confirm_event_entry('dddddddd-0325-4000-8000-0000000000e2', 'dddddddd-0325-4000-8000-000000000004');
  IF NOT (v_res->>'already')::boolean THEN RAISE EXCEPTION 'C3: a second confirm returned %', v_res; END IF;
  RAISE NOTICE 'C passed: either partner keeps the pair';
END;
$$;

-- The deadline passes.
UPDATE tournaments SET start_date = CURRENT_DATE - 1 WHERE id = 'dddddddd-0325-4000-8000-0000000000a1';

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := confirm_event_entry('dddddddd-0325-4000-8000-0000000000e1', 'dddddddd-0325-4000-8000-000000000001');
  IF v_res->>'reason' IS DISTINCT FROM 'past_deadline' THEN
    RAISE EXCEPTION 'E: a confirm after the deadline returned %', v_res;
  END IF;
  RAISE NOTICE 'E passed: the member cannot confirm after the deadline';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := release_unconfirmed_event_entries(10);
  IF (SELECT status::text FROM tournament_participants
       WHERE player_id = 'dddddddd-0325-4000-8000-000000000001'
         AND event_id = 'dddddddd-0325-4000-8000-0000000000e1') <> 'withdrawn' THEN
    RAISE EXCEPTION 'D1: the reached, unconfirmed entry was not withdrawn: %', v_res;
  END IF;
  IF (SELECT status FROM tournament_event_confirmations
       WHERE player_id = 'dddddddd-0325-4000-8000-000000000001') <> 'released' THEN
    RAISE EXCEPTION 'D2: its row is not released';
  END IF;
  IF (SELECT status::text FROM tournament_participants
       WHERE player_id = 'dddddddd-0325-4000-8000-000000000002'
         AND event_id = 'dddddddd-0325-4000-8000-0000000000e1') <> 'registered'
     OR (SELECT status FROM tournament_event_confirmations
          WHERE player_id = 'dddddddd-0325-4000-8000-000000000002') <> 'unreached' THEN
    RAISE EXCEPTION 'D3: the unreached member was released';
  END IF;
  IF (SELECT status::text FROM tournament_pairs
       WHERE event_id = 'dddddddd-0325-4000-8000-0000000000e2') <> 'registered' THEN
    RAISE EXCEPTION 'D4: the confirmed pair was released';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tournament_participants
                  WHERE player_id = 'dddddddd-0325-4000-8000-000000000005'
                    AND event_id = 'dddddddd-0325-4000-8000-0000000000e1') THEN
    RAISE EXCEPTION 'D5: the waitlist was not promoted into the freed place: %', v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM attendance_warnings WHERE player_id::text LIKE 'dddddddd-0325-4000-8000-%') THEN
    RAISE EXCEPTION 'D6: a release wrote a warning';
  END IF;
  RAISE NOTICE 'D passed: released when reached, kept when not, filled from the waitlist';
END;
$$;

ROLLBACK;
