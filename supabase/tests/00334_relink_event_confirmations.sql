-- ============================================================
-- 00334_relink_event_confirmations.sql: confirmations follow a team.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00334 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00334_relink_event_confirmations.sql
--
-- WHAT IT PROVES
-- --------------
-- A. Two solos paired: both rows move to the pair, a confirmed member stays
--    confirmed, and a second relink changes nothing.
-- B. The pair split: both rows move back to the solo entries.
-- C. A member with no active entry is left alone.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status) VALUES
 ('dddddddd-0334-4000-8000-000000000001','relink334-1@example.invalid','MemberA','recreational'),
 ('dddddddd-0334-4000-8000-000000000002','relink334-2@example.invalid','MemberB','recreational'),
 ('dddddddd-0334-4000-8000-000000000003','relink334-3@example.invalid','MemberC','recreational');

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0334-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE + 2, 'active');
INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('dddddddd-0334-4000-8000-0000000000e1', 'dddddddd-0334-4000-8000-0000000000a1', 'open_doubles', 'single_elimination', 'registration');

INSERT INTO tournament_participants (id, event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0334-4000-8000-0000000000b1', 'dddddddd-0334-4000-8000-0000000000e1', 'dddddddd-0334-4000-8000-000000000001', 1000, 'registered'),
 ('dddddddd-0334-4000-8000-0000000000b2', 'dddddddd-0334-4000-8000-0000000000e1', 'dddddddd-0334-4000-8000-000000000002', 1000, 'registered');
INSERT INTO tournament_event_confirmations (event_id, player_id, participant_id, status) VALUES
 ('dddddddd-0334-4000-8000-0000000000e1', 'dddddddd-0334-4000-8000-000000000001', 'dddddddd-0334-4000-8000-0000000000b1', 'confirmed'),
 ('dddddddd-0334-4000-8000-0000000000e1', 'dddddddd-0334-4000-8000-000000000002', 'dddddddd-0334-4000-8000-0000000000b2', 'pending'),
 ('dddddddd-0334-4000-8000-0000000000e1', 'dddddddd-0334-4000-8000-000000000003', 'dddddddd-0334-4000-8000-0000000000b3', 'pending');

-- The pairing path replaces the two solo entries with the pair.
DELETE FROM tournament_participants WHERE event_id = 'dddddddd-0334-4000-8000-0000000000e1';
INSERT INTO tournament_pairs (id, event_id, player1_id, player2_id, status) VALUES
 ('dddddddd-0334-4000-8000-0000000000c1', 'dddddddd-0334-4000-8000-0000000000e1',
  'dddddddd-0334-4000-8000-000000000001', 'dddddddd-0334-4000-8000-000000000002', 'registered');

DO $$
DECLARE
  v_moved integer;
BEGIN
  v_moved := relink_event_confirmations('dddddddd-0334-4000-8000-0000000000e1',
    ARRAY['dddddddd-0334-4000-8000-000000000001', 'dddddddd-0334-4000-8000-000000000002']::uuid[]);
  IF v_moved <> 2 THEN
    RAISE EXCEPTION 'A1: % rows moved, expected 2', v_moved;
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_event_confirmations
              WHERE event_id = 'dddddddd-0334-4000-8000-0000000000e1'
                AND player_id IN ('dddddddd-0334-4000-8000-000000000001', 'dddddddd-0334-4000-8000-000000000002')
                AND (pair_id IS DISTINCT FROM 'dddddddd-0334-4000-8000-0000000000c1' OR participant_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'A2: a row is not keyed to the pair';
  END IF;
  IF (SELECT status FROM tournament_event_confirmations
       WHERE player_id = 'dddddddd-0334-4000-8000-000000000001') <> 'confirmed' THEN
    RAISE EXCEPTION 'A3: the confirmed member lost their confirmation';
  END IF;
  IF relink_event_confirmations('dddddddd-0334-4000-8000-0000000000e1',
       ARRAY['dddddddd-0334-4000-8000-000000000001', 'dddddddd-0334-4000-8000-000000000002']::uuid[]) <> 0 THEN
    RAISE EXCEPTION 'A4: a second relink moved rows';
  END IF;
  RAISE NOTICE 'A passed: a pair takes both rows and keeps the confirmation';
END;
$$;

-- The split path replaces the pair with two solo entries.
DELETE FROM tournament_pairs WHERE id = 'dddddddd-0334-4000-8000-0000000000c1';
INSERT INTO tournament_participants (id, event_id, player_id, elo_before, status) VALUES
 ('dddddddd-0334-4000-8000-0000000000b4', 'dddddddd-0334-4000-8000-0000000000e1', 'dddddddd-0334-4000-8000-000000000001', 1000, 'registered'),
 ('dddddddd-0334-4000-8000-0000000000b5', 'dddddddd-0334-4000-8000-0000000000e1', 'dddddddd-0334-4000-8000-000000000002', 1000, 'registered');

DO $$
BEGIN
  IF relink_event_confirmations('dddddddd-0334-4000-8000-0000000000e1',
       ARRAY['dddddddd-0334-4000-8000-000000000001', 'dddddddd-0334-4000-8000-000000000002',
             'dddddddd-0334-4000-8000-000000000003']::uuid[]) <> 2 THEN
    RAISE EXCEPTION 'B1: the split did not move both rows';
  END IF;
  IF (SELECT participant_id FROM tournament_event_confirmations
       WHERE player_id = 'dddddddd-0334-4000-8000-000000000001') <> 'dddddddd-0334-4000-8000-0000000000b4'
     OR (SELECT participant_id FROM tournament_event_confirmations
       WHERE player_id = 'dddddddd-0334-4000-8000-000000000002') <> 'dddddddd-0334-4000-8000-0000000000b5' THEN
    RAISE EXCEPTION 'B2: a row is not keyed to its solo entry';
  END IF;
  RAISE NOTICE 'B passed: a split re-keys to the solo entries';

  IF (SELECT participant_id FROM tournament_event_confirmations
       WHERE player_id = 'dddddddd-0334-4000-8000-000000000003') <> 'dddddddd-0334-4000-8000-0000000000b3' THEN
    RAISE EXCEPTION 'C1: a member with no active entry was moved';
  END IF;
  RAISE NOTICE 'C passed: no active entry, no change';
END;
$$;

ROLLBACK;
