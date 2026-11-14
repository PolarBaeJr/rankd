-- ============================================================
-- 00333_results_post_and_social_posts.sql: results are posted, and social
-- posts are ready.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00333 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00333_results_post_and_social_posts.sql
--
-- WHAT IT PROVES
-- --------------
-- A. Both vocabulary CHECKs admit announcements.socialposts.read and still
--    refuse an unknown string.
-- B. The two marketing portfolios carry it.
-- C. A set kind outside the three is refused, and a results post goes with
--    its event.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

DO $$
DECLARE
  v_baseline uuid := 'dddddddd-0333-4000-8000-0000000000b1';
BEGIN
  INSERT INTO permission_baselines (id, name, capabilities)
  VALUES (v_baseline, 'Sandpiper social desk', ARRAY['announcements.page', 'announcements.socialposts.read']);
  BEGIN
    INSERT INTO permission_baselines (id, name, capabilities)
    VALUES ('dddddddd-0333-4000-8000-0000000000b2', 'Sandpiper nonsense', ARRAY['announcements.socialposts.write']);
    RAISE EXCEPTION 'A: an unknown capability was admitted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'A passed: the vocabulary admits the new read and nothing else';
END;
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM permission_baselines
       WHERE id IN ('5eed0060-0000-4000-8000-000000000204', '5eed0060-0000-4000-8000-000000000206')
         AND capabilities @> ARRAY['announcements.socialposts.read']) <>
     (SELECT count(*) FROM permission_baselines
       WHERE id IN ('5eed0060-0000-4000-8000-000000000204', '5eed0060-0000-4000-8000-000000000206')) THEN
    RAISE EXCEPTION 'B: a marketing portfolio lacks the capability';
  END IF;
  RAISE NOTICE 'B passed: both marketing portfolios carry it';
END;
$$;

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0333-4000-8000-0000000000a1', 'Team Sandpiper Open', CURRENT_DATE, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('dddddddd-0333-4000-8000-0000000000e1', 'dddddddd-0333-4000-8000-0000000000a1', 'open_doubles', 'single_elimination', 'completed');

DO $$
BEGIN
  BEGIN
    INSERT INTO event_social_post_sets (event_id, kind, entry_ids, caption)
    VALUES ('dddddddd-0333-4000-8000-0000000000e1', 'stories', '{}', 'x');
    RAISE EXCEPTION 'C: an unknown set kind was admitted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO event_results_posts (event_id, top) VALUES ('dddddddd-0333-4000-8000-0000000000e1', '[]'::jsonb);
  DELETE FROM tournament_events WHERE id = 'dddddddd-0333-4000-8000-0000000000e1';
  IF EXISTS (SELECT 1 FROM event_results_posts WHERE event_id = 'dddddddd-0333-4000-8000-0000000000e1') THEN
    RAISE EXCEPTION 'C: the results post outlived its event';
  END IF;
  RAISE NOTICE 'C passed: the set kinds are fixed and a post goes with its event';
END;
$$;

ROLLBACK;
