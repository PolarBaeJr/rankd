-- ============================================================
-- 00331_group_time_caps.sql: a group can be capped in time.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00331 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00331_group_time_caps.sql
--
-- WHAT IT PROVES
-- --------------
-- A. With the switch off, the sweep applies nothing.
-- B. A group cap voids that group's pending and ready matches, keeps the live
--    one and the completed one, and leaves the other group alone; applying it
--    again changes nothing.
-- C. A whole-stage cap reaches every group.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0331-4000-8000-0000000000a1', 'Team Sandpiper Open', CURRENT_DATE, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('dddddddd-0331-4000-8000-0000000000e1', 'dddddddd-0331-4000-8000-0000000000a1', 'open_singles', 'staged', 'pool_live');

INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, stage, pool_number, group_number, status) VALUES
 ('dddddddd-0331-4000-8000-0000000000c1', 'dddddddd-0331-4000-8000-0000000000e1', 1, 1, 1, 1, 1, 'pending'),
 ('dddddddd-0331-4000-8000-0000000000c2', 'dddddddd-0331-4000-8000-0000000000e1', 1, 2, 1, 1, 1, 'ready'),
 ('dddddddd-0331-4000-8000-0000000000c3', 'dddddddd-0331-4000-8000-0000000000e1', 1, 3, 1, 1, 1, 'live'),
 ('dddddddd-0331-4000-8000-0000000000c4', 'dddddddd-0331-4000-8000-0000000000e1', 1, 4, 1, 1, 1, 'completed'),
 ('dddddddd-0331-4000-8000-0000000000c5', 'dddddddd-0331-4000-8000-0000000000e1', 1, 5, 1, 1, 2, 'ready');

INSERT INTO stage_group_time_caps (id, event_id, stage, pool_number, group_number, cap_at) VALUES
 ('dddddddd-0331-4000-8000-0000000000d1', 'dddddddd-0331-4000-8000-0000000000e1', 1, 1, 1, now() - interval '1 minute');

DO $$
BEGIN
  INSERT INTO platform_settings (key, value) VALUES ('release_flags', '{"group_time_cap": false}'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = COALESCE(platform_settings.value, '{}'::jsonb) || '{"group_time_cap": false}'::jsonb;
  IF apply_due_group_time_caps() <> 0 THEN
    RAISE EXCEPTION 'A1: the sweep ran with the switch off';
  END IF;
  IF (SELECT applied_at FROM stage_group_time_caps WHERE id = 'dddddddd-0331-4000-8000-0000000000d1') IS NOT NULL THEN
    RAISE EXCEPTION 'A2: a cap was applied with the switch off';
  END IF;
  UPDATE platform_settings SET value = value || '{"group_time_cap": true}'::jsonb WHERE key = 'release_flags';
  RAISE NOTICE 'A passed: off sweeps nothing';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  IF apply_due_group_time_caps() <> 1 THEN
    RAISE EXCEPTION 'B1: the due cap was not applied';
  END IF;
  IF (SELECT array_agg(status::text ORDER BY bracket_position) FROM tournament_matches
       WHERE event_id = 'dddddddd-0331-4000-8000-0000000000e1')
     IS DISTINCT FROM ARRAY['voided', 'voided', 'live', 'completed', 'ready'] THEN
    RAISE EXCEPTION 'B2: the statuses after the cap read %', (SELECT array_agg(status::text ORDER BY bracket_position)
      FROM tournament_matches WHERE event_id = 'dddddddd-0331-4000-8000-0000000000e1');
  END IF;
  IF (SELECT note FROM tournament_match_notes WHERE match_id = 'dddddddd-0331-4000-8000-0000000000c1') <> 'Time cap reached' THEN
    RAISE EXCEPTION 'B3: a capped match has no note';
  END IF;
  IF (SELECT applied_how FROM stage_group_time_caps WHERE id = 'dddddddd-0331-4000-8000-0000000000d1') <> 'automatic' THEN
    RAISE EXCEPTION 'B4: the sweep did not say it was automatic';
  END IF;
  v_res := apply_group_time_cap('dddddddd-0331-4000-8000-0000000000d1', NULL);
  IF NOT COALESCE((v_res->>'already')::boolean, false) THEN
    RAISE EXCEPTION 'B5: a second apply returned %', v_res;
  END IF;
  RAISE NOTICE 'B passed: one group capped, live and completed kept, once';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  INSERT INTO stage_group_time_caps (id, event_id, stage, cap_at) VALUES
   ('dddddddd-0331-4000-8000-0000000000d2', 'dddddddd-0331-4000-8000-0000000000e1', 1, now() + interval '1 hour');
  v_res := apply_group_time_cap('dddddddd-0331-4000-8000-0000000000d2', NULL);
  IF (v_res->>'voided')::integer <> 1
     OR (SELECT status::text FROM tournament_matches WHERE id = 'dddddddd-0331-4000-8000-0000000000c5') <> 'voided' THEN
    RAISE EXCEPTION 'C: a whole-stage cap returned %', v_res;
  END IF;
  RAISE NOTICE 'C passed: a whole-stage cap reaches every group';
END;
$$;

ROLLBACK;
