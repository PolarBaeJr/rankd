-- ============================================================
-- 00327_event_substitutions.sql: substitutions keep the history true.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00327 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00327_event_substitutions.sql
--
-- WHAT IT PROVES
-- --------------
-- A. A partner sub mid-event: the completed match records the old pair in
--    its lineup, the pending match is untouched and now belongs to the new
--    pair, the spare entry is gone and the record says 1 kept, 1 moved.
-- B. Double entry is refused: a member already on another pair, and the
--    substitute just used. Somebody not entered is refused. A restricted
--    member is refused unless an exec confirmed.
-- C. A sub while the entry is on court is refused.
-- D. A team sub in singles: the participant row is the new person's, the
--    completed match keeps the old one in its lineup, the rating columns are
--    the new person's to earn.
-- E. Before play, a sub with a spare who has not checked in: the pair goes
--    back to registered and the partner who stays keeps their check-in, so
--    the check-in close does not release them as absent.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0327-4000-8000-000000000001','sub-harness-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0327-4000-8000-000000000002','sub-harness-2@example.invalid','MemberB','recreational'),
 ('dddddddd-0327-4000-8000-000000000003','sub-harness-3@example.invalid','MemberC','recreational'),
 ('dddddddd-0327-4000-8000-000000000004','sub-harness-4@example.invalid','MemberD','recreational'),
 ('dddddddd-0327-4000-8000-000000000005','sub-harness-5@example.invalid','MemberE','recreational'),
 ('dddddddd-0327-4000-8000-000000000006','sub-harness-6@example.invalid','MemberF','recreational'),
 ('dddddddd-0327-4000-8000-000000000007','sub-harness-7@example.invalid','MemberG','recreational'),
 ('dddddddd-0327-4000-8000-000000000008','sub-harness-8@example.invalid','MemberH','recreational'),
 ('dddddddd-0327-4000-8000-000000000009','sub-harness-exec@example.invalid','MemberExec','recreational');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0327-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0327-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-0000000000a1', 'open_doubles', 'round_robin', 'live'),
 ('dddddddd-0327-4000-8000-0000000000e2', 'dddddddd-0327-4000-8000-0000000000a1', 'open_singles', 'round_robin', 'live');

-- Doubles: pair 1 (A, B) beat pair 2 (C, D) and still has to play them again.
-- E is entered and checked in, waiting for a partner: the spare.
INSERT INTO tournament_pairs (id, event_id, player1_id, player2_id, status, checked_in_at, player1_checked_in_at, player2_checked_in_at) VALUES
 ('dddddddd-0327-4000-8000-0000000000b1', 'dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-000000000001', 'dddddddd-0327-4000-8000-000000000002', 'checked_in', now(), now(), now()),
 ('dddddddd-0327-4000-8000-0000000000b2', 'dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-000000000003', 'dddddddd-0327-4000-8000-000000000004', 'checked_in', now(), now(), now());
INSERT INTO tournament_participants (event_id, player_id, elo_before, status, checked_in_at) VALUES
 ('dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-000000000005', 1000, 'checked_in', now()),
 ('dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-000000000008', 1000, 'checked_in', now());
INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, pair_a_id, pair_b_id, status, scores, winner_pair_id, loser_pair_id) VALUES
 ('dddddddd-0327-4000-8000-0000000000c1', 'dddddddd-0327-4000-8000-0000000000e1', 1, 1, 'dddddddd-0327-4000-8000-0000000000b1', 'dddddddd-0327-4000-8000-0000000000b2', 'completed', '[{"a":21,"b":15}]'::jsonb, 'dddddddd-0327-4000-8000-0000000000b1', 'dddddddd-0327-4000-8000-0000000000b2');
INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, pair_a_id, pair_b_id, status) VALUES
 ('dddddddd-0327-4000-8000-0000000000c2', 'dddddddd-0327-4000-8000-0000000000e1', 2, 1, 'dddddddd-0327-4000-8000-0000000000b2', 'dddddddd-0327-4000-8000-0000000000b1', 'ready');

-- Singles: F beat G; H is entered after the draw and in no match.
INSERT INTO tournament_participants (id, event_id, player_id, elo_before, elo_after, elo_change, status, checked_in_at) VALUES
 ('dddddddd-0327-4000-8000-0000000000f1', 'dddddddd-0327-4000-8000-0000000000e2', 'dddddddd-0327-4000-8000-000000000006', 1000, 1012, 12, 'checked_in', now()),
 ('dddddddd-0327-4000-8000-0000000000f2', 'dddddddd-0327-4000-8000-0000000000e2', 'dddddddd-0327-4000-8000-000000000007', 1000, 988, -12, 'checked_in', now()),
 ('dddddddd-0327-4000-8000-0000000000f3', 'dddddddd-0327-4000-8000-0000000000e2', 'dddddddd-0327-4000-8000-000000000008', 1000, NULL, NULL, 'registered', NULL);
INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, participant_a_id, participant_b_id, status, scores, winner_participant_id, loser_participant_id) VALUES
 ('dddddddd-0327-4000-8000-0000000000d1', 'dddddddd-0327-4000-8000-0000000000e2', 1, 1, 'dddddddd-0327-4000-8000-0000000000f1', 'dddddddd-0327-4000-8000-0000000000f2', 'completed', '[{"a":21,"b":10}]'::jsonb, 'dddddddd-0327-4000-8000-0000000000f1', 'dddddddd-0327-4000-8000-0000000000f2');
INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, participant_a_id, participant_b_id, status) VALUES
 ('dddddddd-0327-4000-8000-0000000000d2', 'dddddddd-0327-4000-8000-0000000000e2', 2, 1, 'dddddddd-0327-4000-8000-0000000000f2', 'dddddddd-0327-4000-8000-0000000000f1', 'pending');

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := substitute_event_entry(
    'dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-0000000000b1', 'partner',
    ARRAY['dddddddd-0327-4000-8000-000000000001']::uuid[], ARRAY['dddddddd-0327-4000-8000-000000000005']::uuid[],
    'A twisted an ankle', 'dddddddd-0327-4000-8000-000000000009', false, 'MemberE / MemberB', 1000, NULL);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) OR (v_res->>'kept')::int <> 1 OR (v_res->>'moved')::int <> 1 THEN
    RAISE EXCEPTION 'A1: the partner sub returned %', v_res;
  END IF;
  IF (SELECT lineup->'a' FROM tournament_matches WHERE id = 'dddddddd-0327-4000-8000-0000000000c1')
     IS DISTINCT FROM '["dddddddd-0327-4000-8000-000000000001", "dddddddd-0327-4000-8000-000000000002"]'::jsonb THEN
    RAISE EXCEPTION 'A2: the completed match does not keep A and B';
  END IF;
  IF (SELECT lineup FROM tournament_matches WHERE id = 'dddddddd-0327-4000-8000-0000000000c2') IS NOT NULL THEN
    RAISE EXCEPTION 'A3: the open match was given a lineup';
  END IF;
  IF (SELECT player1_id FROM tournament_pairs WHERE id = 'dddddddd-0327-4000-8000-0000000000b1') <> 'dddddddd-0327-4000-8000-000000000005'
     OR (SELECT pair_name FROM tournament_pairs WHERE id = 'dddddddd-0327-4000-8000-0000000000b1') <> 'MemberE / MemberB' THEN
    RAISE EXCEPTION 'A4: the pair is not E and B';
  END IF;
  IF (SELECT status::text FROM tournament_pairs WHERE id = 'dddddddd-0327-4000-8000-0000000000b1') <> 'checked_in' THEN
    RAISE EXCEPTION 'A5: E was checked in, so the pair should still be';
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_participants WHERE event_id = 'dddddddd-0327-4000-8000-0000000000e1'
               AND player_id = 'dddddddd-0327-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'A6: the spare entry was left behind';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM event_substitutions WHERE pair_id = 'dddddddd-0327-4000-8000-0000000000b1'
                   AND outgoing_player_id = 'dddddddd-0327-4000-8000-000000000001'
                   AND incoming_player_id = 'dddddddd-0327-4000-8000-000000000005'
                   AND matches_kept = 1 AND matches_moved = 1 AND note = 'A twisted an ankle') THEN
    RAISE EXCEPTION 'A7: the substitution was not recorded';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance_warnings WHERE player_id = 'dddddddd-0327-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'A8: a sub on its own warned the outgoing member';
  END IF;
  RAISE NOTICE 'A passed: a partner sub mid-event keeps the played match with who played it';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  -- B is on pair 1: they cannot come in for C on pair 2.
  INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
   ('dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-000000000002', 1000, 'registered');
  v_res := substitute_event_entry(
    'dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-0000000000b2', 'partner',
    ARRAY['dddddddd-0327-4000-8000-000000000003']::uuid[], ARRAY['dddddddd-0327-4000-8000-000000000002']::uuid[],
    NULL, 'dddddddd-0327-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'already_in_event' THEN
    RAISE EXCEPTION 'B1: a member already on a pair came in: %', v_res;
  END IF;
  DELETE FROM tournament_participants WHERE event_id = 'dddddddd-0327-4000-8000-0000000000e1'
    AND player_id = 'dddddddd-0327-4000-8000-000000000002';

  -- E is now on pair 1.
  v_res := substitute_event_entry(
    'dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-0000000000b2', 'partner',
    ARRAY['dddddddd-0327-4000-8000-000000000003']::uuid[], ARRAY['dddddddd-0327-4000-8000-000000000005']::uuid[],
    NULL, 'dddddddd-0327-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'already_in_event' THEN
    RAISE EXCEPTION 'B2: the substitute just used came in again: %', v_res;
  END IF;

  -- The exec has no entry in the event.
  v_res := substitute_event_entry(
    'dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-0000000000b2', 'partner',
    ARRAY['dddddddd-0327-4000-8000-000000000003']::uuid[], ARRAY['dddddddd-0327-4000-8000-000000000009']::uuid[],
    NULL, 'dddddddd-0327-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'not_entered' THEN
    RAISE EXCEPTION 'B3: somebody not entered came in: %', v_res;
  END IF;

  -- H is a spare but restricted.
  INSERT INTO event_entry_restrictions (player_id, reason, starts_at) VALUES
   ('dddddddd-0327-4000-8000-000000000008', 'Two no-shows', now() - interval '1 day');
  v_res := substitute_event_entry(
    'dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-0000000000b2', 'partner',
    ARRAY['dddddddd-0327-4000-8000-000000000003']::uuid[], ARRAY['dddddddd-0327-4000-8000-000000000008']::uuid[],
    NULL, 'dddddddd-0327-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'restricted' THEN
    RAISE EXCEPTION 'B4: a restricted member came in without an exec: %', v_res;
  END IF;
  RAISE NOTICE 'B passed: double entry, not entered and restricted are refused';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  UPDATE tournament_matches SET status = 'live' WHERE id = 'dddddddd-0327-4000-8000-0000000000c2';
  v_res := substitute_event_entry(
    'dddddddd-0327-4000-8000-0000000000e1', 'dddddddd-0327-4000-8000-0000000000b2', 'partner',
    ARRAY['dddddddd-0327-4000-8000-000000000003']::uuid[], ARRAY['dddddddd-0327-4000-8000-000000000008']::uuid[],
    NULL, 'dddddddd-0327-4000-8000-000000000009', true);
  IF v_res->>'reason' IS DISTINCT FROM 'on_court' THEN
    RAISE EXCEPTION 'C1: a sub on court returned %', v_res;
  END IF;
  UPDATE tournament_matches SET status = 'ready' WHERE id = 'dddddddd-0327-4000-8000-0000000000c2';
  RAISE NOTICE 'C passed: never while the entry is on court';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  DELETE FROM event_entry_restrictions WHERE player_id = 'dddddddd-0327-4000-8000-000000000008';
  DELETE FROM tournament_participants WHERE event_id = 'dddddddd-0327-4000-8000-0000000000e1'
    AND player_id = 'dddddddd-0327-4000-8000-000000000008';
  v_res := substitute_event_entry(
    'dddddddd-0327-4000-8000-0000000000e2', 'dddddddd-0327-4000-8000-0000000000f1', 'team',
    ARRAY['dddddddd-0327-4000-8000-000000000006']::uuid[], ARRAY['dddddddd-0327-4000-8000-000000000008']::uuid[],
    NULL, 'dddddddd-0327-4000-8000-000000000009', false, NULL, NULL, 1000);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'D1: the team sub returned %', v_res;
  END IF;
  IF (SELECT player_id FROM tournament_participants WHERE id = 'dddddddd-0327-4000-8000-0000000000f1') <> 'dddddddd-0327-4000-8000-000000000008'
     OR (SELECT elo_change FROM tournament_participants WHERE id = 'dddddddd-0327-4000-8000-0000000000f1') IS NOT NULL THEN
    RAISE EXCEPTION 'D2: the entry is not H''s, with H''s rating to earn';
  END IF;
  IF (SELECT lineup->'a' FROM tournament_matches WHERE id = 'dddddddd-0327-4000-8000-0000000000d1')
     IS DISTINCT FROM '["dddddddd-0327-4000-8000-000000000006"]'::jsonb THEN
    RAISE EXCEPTION 'D3: the completed match does not keep F';
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_participants WHERE id = 'dddddddd-0327-4000-8000-0000000000f3') THEN
    RAISE EXCEPTION 'D4: the spare entry was left behind';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM event_substitutions WHERE participant_id = 'dddddddd-0327-4000-8000-0000000000f1'
                   AND kind = 'team' AND outgoing_elo_change = 12) THEN
    RAISE EXCEPTION 'D5: the record does not keep what F earned';
  END IF;
  RAISE NOTICE 'D passed: a team sub keeps the played match with who played it';
END;
$$;

-- E: a third event, still at check-in. Pair 3 (C, D) is checked in; A is a
-- spare who has not checked in yet.
INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('dddddddd-0327-4000-8000-0000000000e3', 'dddddddd-0327-4000-8000-0000000000a1', 'open_doubles', 'round_robin', 'checkin');
INSERT INTO tournament_pairs (id, event_id, player1_id, player2_id, status, checked_in_at, player1_checked_in_at, player2_checked_in_at) VALUES
 ('dddddddd-0327-4000-8000-0000000000b3', 'dddddddd-0327-4000-8000-0000000000e3', 'dddddddd-0327-4000-8000-000000000003', 'dddddddd-0327-4000-8000-000000000004', 'checked_in', now(), now(), now());
INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0327-4000-8000-0000000000e3', 'dddddddd-0327-4000-8000-000000000001', 1000, 'registered');

DO $$
DECLARE
  v_res jsonb;
  v_row record;
BEGIN
  v_res := substitute_event_entry(
    'dddddddd-0327-4000-8000-0000000000e3', 'dddddddd-0327-4000-8000-0000000000b3', 'partner',
    ARRAY['dddddddd-0327-4000-8000-000000000003']::uuid[], ARRAY['dddddddd-0327-4000-8000-000000000001']::uuid[],
    NULL, 'dddddddd-0327-4000-8000-000000000009');
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'E1: the sub before play returned %', v_res;
  END IF;
  SELECT status::text AS status, player1_checked_in_at, player2_checked_in_at INTO v_row
    FROM tournament_pairs WHERE id = 'dddddddd-0327-4000-8000-0000000000b3';
  IF v_row.status <> 'registered' OR v_row.player1_checked_in_at IS NOT NULL THEN
    RAISE EXCEPTION 'E2: A has not checked in, so the pair should be registered: %', row_to_json(v_row);
  END IF;
  IF v_row.player2_checked_in_at IS NULL THEN
    RAISE EXCEPTION 'E3: D checked in and lost it';
  END IF;
  RAISE NOTICE 'E passed: the partner who stays keeps their check-in';
END;
$$;

ROLLBACK;
