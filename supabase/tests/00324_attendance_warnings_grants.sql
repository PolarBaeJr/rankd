-- ============================================================
-- 00324_attendance_warnings_grants.sql: the event standard's tables.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00324 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00324_attendance_warnings_grants.sql
--
-- WHAT IT PROVES
-- --------------
-- A. anon and authenticated hold no privilege on the four tables, and the
--    service role holds them all.
-- B. One active warning per member, event and kind: a second is refused, a
--    rescinded one makes room again.
-- C. A restriction cannot end before it starts; an event's confirmation
--    window cannot close before it opens.
-- D. A merge moves the new player columns: merge_players_unhandled() is empty.
-- E. A departure names one entry, "other" needs a note, and a member leaves an
--    event once.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0324-4000-8000-000000000001','attendance-harness-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0324-4000-8000-000000000009','attendance-harness-exec@example.invalid','MemberExec','recreational');

INSERT INTO tournaments (id, name, start_date) VALUES
 ('dddddddd-0324-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE);
INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('dddddddd-0324-4000-8000-0000000000e1', 'dddddddd-0324-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'registration');

DO $$
DECLARE
  v_table text;
  v_role  text;
  v_priv  text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['attendance_warnings', 'event_entry_restrictions', 'tournament_event_confirmations', 'event_departures'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(v_role, format('public.%I', v_table), v_priv) THEN
          RAISE EXCEPTION 'A: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT has_table_privilege('service_role', format('public.%I', v_table), 'SELECT, INSERT, UPDATE, DELETE') THEN
      RAISE EXCEPTION 'A: service_role is missing a privilege on %', v_table;
    END IF;
  END LOOP;
  RAISE NOTICE 'A passed: the four tables are the service role''s alone';
END;
$$;

DO $$
DECLARE
  p1 uuid := 'dddddddd-0324-4000-8000-000000000001';
  e1 uuid := 'dddddddd-0324-4000-8000-0000000000e1';
  t1 uuid := 'dddddddd-0324-4000-8000-0000000000a1';
BEGIN
  INSERT INTO attendance_warnings (player_id, tournament_id, event_id, kind, source)
  VALUES (p1, t1, e1, 'no_show', 'checkin_close');
  BEGIN
    INSERT INTO attendance_warnings (player_id, tournament_id, event_id, kind, source)
    VALUES (p1, t1, e1, 'no_show', 'did_not_come');
    RAISE EXCEPTION 'B1: a second active no-show warning was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  UPDATE attendance_warnings SET rescinded_at = now() WHERE player_id = p1 AND event_id = e1;
  INSERT INTO attendance_warnings (player_id, tournament_id, event_id, kind, source)
  VALUES (p1, t1, e1, 'no_show', 'desk');
  INSERT INTO attendance_warnings (player_id, tournament_id, event_id, kind, source)
  VALUES (p1, t1, e1, 'left_without_notice', 'desk');
  RAISE NOTICE 'B passed: one active warning per member, event and kind';
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO event_entry_restrictions (player_id, reason, starts_at, ends_at)
    VALUES ('dddddddd-0324-4000-8000-000000000001', 'Two no-shows', now(), now() - interval '1 day');
    RAISE EXCEPTION 'C1: a restriction ending before it starts was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE tournament_events SET confirm_opens_hours = 12, confirm_deadline_hours = 24
     WHERE id = 'dddddddd-0324-4000-8000-0000000000e1';
    RAISE EXCEPTION 'C2: a window closing before it opens was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'C passed: the bounds hold';
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM merge_players_unhandled()) THEN
    RAISE EXCEPTION 'D: merge_players_unhandled() is not empty: %',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM merge_players_unhandled());
  END IF;
  RAISE NOTICE 'D passed: every player column is handled by a merge';
END;
$$;

DO $$
DECLARE
  p1 uuid := 'dddddddd-0324-4000-8000-000000000001';
  e1 uuid := 'dddddddd-0324-4000-8000-0000000000e1';
  x1 uuid := 'dddddddd-0324-4000-8000-0000000000f1';
BEGIN
  INSERT INTO event_departures (event_id, player_id, participant_id, reason, marked_as)
  VALUES (e1, p1, x1, 'injury', 'court_helper');
  BEGIN
    INSERT INTO event_departures (event_id, player_id, participant_id, reason, marked_as)
    VALUES (e1, p1, x1, 'emergency', 'desk');
    RAISE EXCEPTION 'E1: a second departure for the same member and event was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO event_departures (event_id, player_id, participant_id, reason, marked_as)
    VALUES (e1, 'dddddddd-0324-4000-8000-000000000009', x1, 'other', 'desk');
    RAISE EXCEPTION 'E2: "other" with no note was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO event_departures (event_id, player_id, participant_id, pair_id, reason, marked_as)
    VALUES (e1, 'dddddddd-0324-4000-8000-000000000009', x1, x1, 'injury', 'desk');
    RAISE EXCEPTION 'E3: a departure naming two entries was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'E passed: departures are one per member per event, with a reason';
END;
$$;

ROLLBACK;
