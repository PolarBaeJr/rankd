-- ============================================================
-- 00329_result_kind.sql: results decided off court and by retirement.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00329 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00329_result_kind.sql
--
-- WHAT IT PROVES
-- --------------
-- A. The shape: off court takes no scores and no retired side; retired needs
--    a side; a played match takes neither.
-- B. An off-court result refuses a rating snapshot; a retirement takes one.
-- C. Back to playable clears both columns, whichever path does it; a void
--    keeps them.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0329-4000-8000-000000000001','kind329-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0329-4000-8000-000000000002','kind329-2@example.invalid','MemberB','recreational');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0329-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0329-4000-8000-0000000000a1', 'Team Heron Open', CURRENT_DATE, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('dddddddd-0329-4000-8000-0000000000e1', 'dddddddd-0329-4000-8000-0000000000a1', 'open_singles', 'round_robin', 'live');
INSERT INTO tournament_participants (id, event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0329-4000-8000-0000000000f1', 'dddddddd-0329-4000-8000-0000000000e1', 'dddddddd-0329-4000-8000-000000000001', 1000, 'checked_in'),
 ('dddddddd-0329-4000-8000-0000000000f2', 'dddddddd-0329-4000-8000-0000000000e1', 'dddddddd-0329-4000-8000-000000000002', 1000, 'checked_in');
INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, participant_a_id, participant_b_id, status) VALUES
 ('dddddddd-0329-4000-8000-0000000000c1', 'dddddddd-0329-4000-8000-0000000000e1', 1, 1, 'dddddddd-0329-4000-8000-0000000000f1', 'dddddddd-0329-4000-8000-0000000000f2', 'live'),
 ('dddddddd-0329-4000-8000-0000000000c2', 'dddddddd-0329-4000-8000-0000000000e1', 1, 2, 'dddddddd-0329-4000-8000-0000000000f1', 'dddddddd-0329-4000-8000-0000000000f2', 'live');

DO $$
BEGIN
  BEGIN
    UPDATE tournament_matches SET status = 'completed', result_kind = 'off_court', scores = '[{"a":21,"b":15}]'::jsonb
     WHERE id = 'dddddddd-0329-4000-8000-0000000000c1';
    RAISE EXCEPTION 'A1: off court took a score';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE tournament_matches SET status = 'completed', result_kind = 'retired', scores = '[{"a":5,"b":3}]'::jsonb
     WHERE id = 'dddddddd-0329-4000-8000-0000000000c2';
    RAISE EXCEPTION 'A2: a retirement took no side';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE tournament_matches SET retired_side = 'a' WHERE id = 'dddddddd-0329-4000-8000-0000000000c2';
    RAISE EXCEPTION 'A3: a played match took a retired side';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE tournament_matches SET result_kind = 'forfeit' WHERE id = 'dddddddd-0329-4000-8000-0000000000c2';
    RAISE EXCEPTION 'A4: a kind that is not one was taken';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE tournament_matches
     SET status = 'completed', result_kind = 'off_court', scores = '[]'::jsonb,
         winner_participant_id = 'dddddddd-0329-4000-8000-0000000000f1',
         loser_participant_id = 'dddddddd-0329-4000-8000-0000000000f2'
   WHERE id = 'dddddddd-0329-4000-8000-0000000000c1';
  UPDATE tournament_matches
     SET status = 'completed', result_kind = 'retired', retired_side = 'b', scores = '[{"a":21,"b":15},{"a":5,"b":8}]'::jsonb,
         winner_participant_id = 'dddddddd-0329-4000-8000-0000000000f1',
         loser_participant_id = 'dddddddd-0329-4000-8000-0000000000f2'
   WHERE id = 'dddddddd-0329-4000-8000-0000000000c2';
  RAISE NOTICE 'A passed: the shape holds';
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE tournament_matches SET elo_snapshot = '{"a":1}'::jsonb WHERE id = 'dddddddd-0329-4000-8000-0000000000c1';
    RAISE EXCEPTION 'B1: an off-court result took a rating';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE tournament_matches SET elo_snapshot = '{"a":1}'::jsonb WHERE id = 'dddddddd-0329-4000-8000-0000000000c2';
  IF (SELECT elo_snapshot FROM tournament_matches WHERE id = 'dddddddd-0329-4000-8000-0000000000c2') IS NULL THEN
    RAISE EXCEPTION 'B2: a retirement was refused its rating';
  END IF;
  UPDATE tournament_matches SET elo_snapshot = NULL WHERE id = 'dddddddd-0329-4000-8000-0000000000c2';
  RAISE NOTICE 'B passed: off court is unrated, a retirement is rated';
END;
$$;

DO $$
BEGIN
  UPDATE tournament_matches SET status = 'voided' WHERE id = 'dddddddd-0329-4000-8000-0000000000c1';
  IF (SELECT result_kind FROM tournament_matches WHERE id = 'dddddddd-0329-4000-8000-0000000000c1') IS DISTINCT FROM 'off_court' THEN
    RAISE EXCEPTION 'C1: a void lost the kind it was decided with';
  END IF;
  UPDATE tournament_matches
     SET status = 'ready', scores = '[{"a":3,"b":2}]'::jsonb, winner_participant_id = NULL, loser_participant_id = NULL
   WHERE id = 'dddddddd-0329-4000-8000-0000000000c2';
  IF EXISTS (SELECT 1 FROM tournament_matches
              WHERE id = 'dddddddd-0329-4000-8000-0000000000c2'
                AND (result_kind IS NOT NULL OR retired_side IS NOT NULL)) THEN
    RAISE EXCEPTION 'C2: back to playable kept the kind';
  END IF;
  UPDATE tournament_matches SET status = 'pending', scores = NULL WHERE id = 'dddddddd-0329-4000-8000-0000000000c1';
  IF (SELECT result_kind FROM tournament_matches WHERE id = 'dddddddd-0329-4000-8000-0000000000c1') IS NOT NULL THEN
    RAISE EXCEPTION 'C3: an unvoid kept the kind';
  END IF;
  RAISE NOTICE 'C passed: back to playable clears the kind, a void keeps it';
END;
$$;

ROLLBACK;
