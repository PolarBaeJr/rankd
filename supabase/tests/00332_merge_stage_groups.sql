-- ============================================================
-- 00332_merge_stage_groups.sql: a thin group merges into another.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00332 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00332_merge_stage_groups.sql
--
-- WHAT IT PROVES
-- --------------
-- A. A stale generation is refused, and so is a live match in either group.
-- B. A row that is not the merged group's refuses the merge, deleting nothing.
-- C. The merge: both groups' rows gone, voided ones too; the new rows in; the
--    audit row names what was deleted.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0332-4000-8000-000000000001','merge332-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0332-4000-8000-000000000002','merge332-2@example.invalid','MemberB','recreational'),
 ('dddddddd-0332-4000-8000-000000000003','merge332-3@example.invalid','MemberC','recreational');
INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0332-4000-8000-0000000000a1', 'Team Curlew Open', CURRENT_DATE, 'active');
-- A staged event needs a version 1 format_config (tournament_events_staged_config).
INSERT INTO tournament_events (id, tournament_id, event_type, format, status, draw_generation_id, format_config) VALUES
 ('dddddddd-0332-4000-8000-0000000000e1', 'dddddddd-0332-4000-8000-0000000000a1', 'open_singles', 'staged', 'live',
  'dddddddd-0332-4000-8000-0000000000aa', '{"version":1,"stages":[{"key":"groups"}]}');
INSERT INTO tournament_participants (id, event_id, player_id, status) VALUES
 ('dddddddd-0332-4000-8000-0000000000f1', 'dddddddd-0332-4000-8000-0000000000e1', 'dddddddd-0332-4000-8000-000000000001', 'checked_in'),
 ('dddddddd-0332-4000-8000-0000000000f2', 'dddddddd-0332-4000-8000-0000000000e1', 'dddddddd-0332-4000-8000-000000000002', 'checked_in'),
 ('dddddddd-0332-4000-8000-0000000000f3', 'dddddddd-0332-4000-8000-0000000000e1', 'dddddddd-0332-4000-8000-000000000003', 'checked_in');
INSERT INTO tournament_matches (id, event_id, draw_generation_id, stage, pool_number, group_number, round_number, bracket_position, match_number, status, participant_a_id, participant_b_id) VALUES
 ('dddddddd-0332-4000-8000-0000000000c1', 'dddddddd-0332-4000-8000-0000000000e1', 'dddddddd-0332-4000-8000-0000000000aa', 1, 1, 1, 1, 1, 1, 'ready',
  'dddddddd-0332-4000-8000-0000000000f1', 'dddddddd-0332-4000-8000-0000000000f2'),
 ('dddddddd-0332-4000-8000-0000000000c2', 'dddddddd-0332-4000-8000-0000000000e1', 'dddddddd-0332-4000-8000-0000000000aa', 1, 1, 2, 2, 2, 2, 'voided',
  'dddddddd-0332-4000-8000-0000000000f3', NULL);

-- The merged group's three matches.
CREATE TEMP TABLE merged_rows ON COMMIT DROP AS
SELECT jsonb_agg(jsonb_build_object(
  'id', gen_random_uuid(), 'event_id', 'dddddddd-0332-4000-8000-0000000000e1',
  'draw_generation_id', 'dddddddd-0332-4000-8000-0000000000aa', 'stage', 1, 'pool_number', 1, 'group_number', 1,
  'round_number', 10 + n, 'bracket_position', n, 'match_number', 10 + n, 'round_name', 'Group', 'status', 'ready',
  'participant_a_id', a, 'participant_b_id', b)) AS rows
FROM (VALUES
  (1, 'dddddddd-0332-4000-8000-0000000000f1'::uuid, 'dddddddd-0332-4000-8000-0000000000f2'::uuid),
  (2, 'dddddddd-0332-4000-8000-0000000000f1'::uuid, 'dddddddd-0332-4000-8000-0000000000f3'::uuid),
  (3, 'dddddddd-0332-4000-8000-0000000000f2'::uuid, 'dddddddd-0332-4000-8000-0000000000f3'::uuid)) AS fixtures(n, a, b);

DO $$
DECLARE
  v_rows jsonb := (SELECT rows FROM merged_rows);
  v_res  jsonb;
BEGIN
  v_res := merge_stage_groups('dddddddd-0332-4000-8000-0000000000e1', 1::smallint, 1::smallint, 2::smallint, 1::smallint,
                              gen_random_uuid(), v_rows, NULL);
  IF v_res->>'reason' IS DISTINCT FROM 'superseded' THEN
    RAISE EXCEPTION 'A1: a stale generation returned %', v_res;
  END IF;
  UPDATE tournament_matches SET status = 'live' WHERE id = 'dddddddd-0332-4000-8000-0000000000c1';
  v_res := merge_stage_groups('dddddddd-0332-4000-8000-0000000000e1', 1::smallint, 1::smallint, 2::smallint, 1::smallint,
                              'dddddddd-0332-4000-8000-0000000000aa', v_rows, NULL);
  IF v_res->>'reason' IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION 'A2: a live match returned %', v_res;
  END IF;
  UPDATE tournament_matches SET status = 'ready' WHERE id = 'dddddddd-0332-4000-8000-0000000000c1';
  RAISE NOTICE 'A passed: stale and live are refused';
END;
$$;

DO $$
DECLARE
  v_rows jsonb := (SELECT rows FROM merged_rows);
  v_res  jsonb;
BEGIN
  v_res := merge_stage_groups('dddddddd-0332-4000-8000-0000000000e1', 1::smallint, 1::smallint, 2::smallint, 1::smallint,
                              'dddddddd-0332-4000-8000-0000000000aa',
                              jsonb_set(v_rows, '{0,group_number}', '2'::jsonb), NULL);
  IF v_res->>'reason' IS DISTINCT FROM 'invalid_rows' THEN
    RAISE EXCEPTION 'B1: a row of another group returned %', v_res;
  END IF;
  IF (SELECT count(*) FROM tournament_matches WHERE event_id = 'dddddddd-0332-4000-8000-0000000000e1') <> 2 THEN
    RAISE EXCEPTION 'B2: a refused merge deleted something';
  END IF;
  RAISE NOTICE 'B passed: a bad row deletes nothing';
END;
$$;

DO $$
DECLARE
  v_rows jsonb := (SELECT rows FROM merged_rows);
  v_res  jsonb;
BEGIN
  v_res := merge_stage_groups('dddddddd-0332-4000-8000-0000000000e1', 1::smallint, 1::smallint, 2::smallint, 1::smallint,
                              'dddddddd-0332-4000-8000-0000000000aa', v_rows, NULL);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) OR (v_res->>'deleted')::integer <> 2 OR (v_res->>'inserted')::integer <> 3 THEN
    RAISE EXCEPTION 'C1: the merge returned %', v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_matches WHERE event_id = 'dddddddd-0332-4000-8000-0000000000e1' AND group_number <> 1) THEN
    RAISE EXCEPTION 'C2: a row of the merged-away group is left';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tournament_audit_log
                  WHERE action = 'groups_merged'
                    AND details->'deleted_match_ids' ? 'dddddddd-0332-4000-8000-0000000000c2') THEN
    RAISE EXCEPTION 'C3: the audit row does not name the voided row it deleted';
  END IF;
  RAISE NOTICE 'C passed: merged in one step, audited';
END;
$$;

ROLLBACK;
