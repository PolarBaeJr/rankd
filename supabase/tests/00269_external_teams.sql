-- ============================================================
-- 00269_external_teams.sql: external teams play an unrated round robin.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00269 applied:
--
--   psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/00269_external_teams.sql
--
-- WHAT IT PROVES
-- --------------
-- The migration's verify block checks that the columns, constraints,
-- triggers and grants exist. This file drives them: the RPC's happy path
-- and every refusal, the fences between external and member entries, the
-- event flag's lock-in, and that an external match cannot be rated even when
-- apply_tournament_match_rating is handed a real member's ratings row.
--
-- The refusal rows are CHECK-valid on purpose, so each case is refused by
-- the trigger it names and not by tournament_pairs_member_or_external.
--
-- Mutation-proven: with tournament_pairs_external_fence dropped, case D1
-- fails; with tournament_matches_external_unrated dropped, case F2 fails.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name) VALUES
 ('cccccccc-0269-4000-8000-000000000001','external-harness-1@example.invalid','ExternalOne'),
 ('cccccccc-0269-4000-8000-000000000002','external-harness-2@example.invalid','ExternalTwo');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'cccccccc-0269-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date) VALUES
 ('cccccccc-0269-4000-8000-0000000000a1', 'external harness', CURRENT_DATE);

-- G: the external event. N: a normal doubles event beside it.
INSERT INTO tournament_events
  (id, tournament_id, event_type, format, placement_bonus_enabled, group_count, external_event,
   games_per_match, points_per_game)
VALUES
  ('cccccccc-0269-4000-8000-0000000000e1', 'cccccccc-0269-4000-8000-0000000000a1',
   'mixed_doubles', 'round_robin', false, 2, true, 1, 15),
  ('cccccccc-0269-4000-8000-0000000000e2', 'cccccccc-0269-4000-8000-0000000000a1',
   'mixed_doubles', 'round_robin', true, NULL, false, NULL, NULL);

CREATE TEMP TABLE ctx(pair1 uuid, pair2 uuid, match1 uuid) ON COMMIT DROP;
INSERT INTO ctx VALUES (NULL, NULL, NULL);

-- ------------------------------------------------------------
-- B. The RPC's happy path
-- ------------------------------------------------------------
DO $$
DECLARE
  v uuid;
  r record;
BEGIN
  v := add_external_tournament_pair('cccccccc-0269-4000-8000-0000000000e1',
                                 'Alder Finch', ' Birch   Wren ', NULL);
  SELECT * INTO r FROM tournament_pairs WHERE id = v;
  IF r.player1_id IS NOT NULL OR r.player2_id IS NOT NULL THEN
    RAISE EXCEPTION 'B: an external pair carries a player id';
  END IF;
  IF r.external1_name <> 'Alder Finch' OR r.external2_name <> 'Birch Wren' THEN
    RAISE EXCEPTION 'B: names not normalised: % / %', r.external1_name, r.external2_name;
  END IF;
  IF r.pair_name <> 'Alder Finch / Birch Wren' OR r.status <> 'registered' THEN
    RAISE EXCEPTION 'B: pair_name or status wrong: % %', r.pair_name, r.status;
  END IF;
  UPDATE ctx SET pair1 = v;

  v := add_external_tournament_pair('cccccccc-0269-4000-8000-0000000000e1',
                                 'Cedar Lark', 'Dogwood Teal', NULL);
  UPDATE ctx SET pair2 = v;
END $$;

-- ------------------------------------------------------------
-- C. The RPC's refusals
-- ------------------------------------------------------------
CREATE FUNCTION pg_temp.refuses(p_label text, p_event uuid, p_a text, p_b text, p_code text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    PERFORM add_external_tournament_pair(p_event, p_a, p_b, NULL);
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_code THEN ok := true;
    ELSE RAISE EXCEPTION '%: wrong error % (%)', p_label, SQLSTATE, SQLERRM;
    END IF;
  END;
  IF NOT ok THEN RAISE EXCEPTION '%: was accepted', p_label; END IF;
END $$;

DO $$
BEGIN
  PERFORM pg_temp.refuses('C1 blank name', 'cccccccc-0269-4000-8000-0000000000e1', '   ', 'Elm Heron', '23514');
  PERFORM pg_temp.refuses('C2 61 characters', 'cccccccc-0269-4000-8000-0000000000e1', repeat('x', 61), 'Elm Heron', '23514');
  PERFORM pg_temp.refuses('C3 same name twice', 'cccccccc-0269-4000-8000-0000000000e1', 'Elm Heron', 'ELM  heron', '23514');
  PERFORM pg_temp.refuses('C4 already on a team', 'cccccccc-0269-4000-8000-0000000000e1', 'birch wren', 'Elm Heron', '23505');
  PERFORM pg_temp.refuses('C5 normal event', 'cccccccc-0269-4000-8000-0000000000e2', 'Elm Heron', 'Fir Robin', '23514');
  PERFORM pg_temp.refuses('C6 no such event', 'cccccccc-0269-4000-8000-0000000000ff', 'Elm Heron', 'Fir Robin', 'P0002');

  -- 60 characters is accepted.
  PERFORM add_external_tournament_pair('cccccccc-0269-4000-8000-0000000000e1', repeat('y', 60), 'Elm Heron', NULL);

  UPDATE tournament_events SET draw_locked = true WHERE id = 'cccccccc-0269-4000-8000-0000000000e1';
  PERFORM pg_temp.refuses('C7 draw locked', 'cccccccc-0269-4000-8000-0000000000e1', 'Fir Robin', 'Gum Swift', '23514');
  UPDATE tournament_events SET draw_locked = false, status = 'live' WHERE id = 'cccccccc-0269-4000-8000-0000000000e1';
  PERFORM pg_temp.refuses('C8 past check-in', 'cccccccc-0269-4000-8000-0000000000e1', 'Fir Robin', 'Gum Swift', '23514');
  UPDATE tournament_events SET status = 'registration' WHERE id = 'cccccccc-0269-4000-8000-0000000000e1';

  -- A withdrawn team frees its names.
  UPDATE tournament_pairs SET status = 'withdrawn'
   WHERE event_id = 'cccccccc-0269-4000-8000-0000000000e1' AND external2_name = 'Elm Heron';
  PERFORM add_external_tournament_pair('cccccccc-0269-4000-8000-0000000000e1', 'Elm Heron', 'Fir Robin', NULL);
END $$;

-- ------------------------------------------------------------
-- C9-C11. The optional team name
-- ------------------------------------------------------------
DO $$
DECLARE
  v uuid;
  r record;
  ok boolean := false;
BEGIN
  v := add_external_tournament_pair('cccccccc-0269-4000-8000-0000000000e1',
                                 'Hazel Ibis', 'Juniper Kite', NULL, '  Night   Owls ');
  SELECT * INTO r FROM tournament_pairs WHERE id = v;
  IF r.pair_name IS DISTINCT FROM 'Night Owls'
     OR r.external1_name <> 'Hazel Ibis' OR r.external2_name <> 'Juniper Kite' THEN
    RAISE EXCEPTION 'C9: named team stored as % (% / %)', r.pair_name, r.external1_name, r.external2_name;
  END IF;

  v := add_external_tournament_pair('cccccccc-0269-4000-8000-0000000000e1',
                                 'Larch Merlin', 'Maple Nuthatch', NULL, '   ');
  SELECT pair_name INTO r FROM tournament_pairs WHERE id = v;
  IF r.pair_name IS DISTINCT FROM 'Larch Merlin / Maple Nuthatch' THEN
    RAISE EXCEPTION 'C10: a blank team name did not fall back: %', r.pair_name;
  END IF;

  BEGIN
    PERFORM add_external_tournament_pair('cccccccc-0269-4000-8000-0000000000e1',
                                         'Oak Plover', 'Pine Quail', NULL, 'night OWLS');
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '23505' AND SQLERRM = 'night OWLS is already a team in this event' THEN ok := true;
    ELSE RAISE EXCEPTION 'C11: wrong error % (%)', SQLSTATE, SQLERRM;
    END IF;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'C11: a duplicate team name was accepted'; END IF;

  BEGIN
    PERFORM add_external_tournament_pair('cccccccc-0269-4000-8000-0000000000e1',
                                         'Oak Plover', 'Pine Quail', NULL, repeat('z', 61));
    RAISE EXCEPTION 'C12: a 61 character team name was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Out of the way of the draw below.
  UPDATE tournament_pairs SET status = 'withdrawn'
   WHERE event_id = 'cccccccc-0269-4000-8000-0000000000e1'
     AND external1_name IN ('Hazel Ibis', 'Larch Merlin');
END $$;

-- ------------------------------------------------------------
-- D. The fences between external and member entries
-- ------------------------------------------------------------
DO $$
DECLARE
  ok boolean;
BEGIN
  -- D1: a member pair (CHECK-valid) into the external event.
  ok := false;
  BEGIN
    INSERT INTO tournament_pairs (event_id, player1_id, player2_id, pair_name)
    VALUES ('cccccccc-0269-4000-8000-0000000000e1',
            'cccccccc-0269-4000-8000-000000000001', 'cccccccc-0269-4000-8000-000000000002', 'ExternalOne / ExternalTwo');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'D1: a member pair entered an external event'; END IF;

  -- D2: an external pair (CHECK-valid) into the normal event.
  ok := false;
  BEGIN
    INSERT INTO tournament_pairs (event_id, external1_name, external2_name, pair_name)
    VALUES ('cccccccc-0269-4000-8000-0000000000e2', 'Hazel Owl', 'Ivy Crane', 'Hazel Owl / Ivy Crane');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'D2: an external pair entered a normal event'; END IF;

  -- D3: a member entering the external event alone.
  ok := false;
  BEGIN
    INSERT INTO tournament_participants (event_id, player_id)
    VALUES ('cccccccc-0269-4000-8000-0000000000e1', 'cccccccc-0269-4000-8000-000000000001');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'D3: a participant entered an external event'; END IF;

  -- D4: half an external pair (one id, names) is neither shape.
  ok := false;
  BEGIN
    INSERT INTO tournament_pairs (event_id, player1_id, external1_name, external2_name, pair_name)
    VALUES ('cccccccc-0269-4000-8000-0000000000e1', 'cccccccc-0269-4000-8000-000000000001',
            'Hazel Owl', 'Ivy Crane', 'Hazel Owl / Ivy Crane');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'D4: a mixed-shape pair was accepted'; END IF;

  -- D5: the member pair and participant rows still land in the normal event.
  INSERT INTO tournament_pairs (event_id, player1_id, player2_id, pair_name)
  VALUES ('cccccccc-0269-4000-8000-0000000000e2',
          'cccccccc-0269-4000-8000-000000000001', 'cccccccc-0269-4000-8000-000000000002', 'ExternalOne / ExternalTwo');
END $$;

-- ------------------------------------------------------------
-- E. The event flag and shape
-- ------------------------------------------------------------
DO $$
DECLARE
  ok boolean;
BEGIN
  ok := false;
  BEGIN
    UPDATE tournament_events SET external_event = false WHERE id = 'cccccccc-0269-4000-8000-0000000000e1';
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'E1: an external event with entries was switched off'; END IF;

  ok := false;
  BEGIN
    UPDATE tournament_events SET external_event = true WHERE id = 'cccccccc-0269-4000-8000-0000000000e2';
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'E2: a normal event with entries was switched to external'; END IF;

  ok := false;
  BEGIN
    UPDATE tournament_events SET format = 'single_elimination' WHERE id = 'cccccccc-0269-4000-8000-0000000000e2';
    UPDATE tournament_events SET seeded_from_event_id = 'cccccccc-0269-4000-8000-0000000000e1'
     WHERE id = 'cccccccc-0269-4000-8000-0000000000e2';
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'E3: an event was seeded from an external event'; END IF;

  ok := false;
  BEGIN
    UPDATE tournament_events SET placement_bonus_enabled = true WHERE id = 'cccccccc-0269-4000-8000-0000000000e1';
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'E4: an external event took a placement bonus'; END IF;

  ok := false;
  BEGIN
    UPDATE tournament_events SET format = 'single_elimination', group_count = NULL
     WHERE id = 'cccccccc-0269-4000-8000-0000000000e1';
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'E5: an external event became a knockout'; END IF;
END $$;

-- ------------------------------------------------------------
-- F. An external match is scored and never rated
-- ------------------------------------------------------------
DO $$
DECLARE
  v_match uuid;
  ok boolean;
BEGIN
  INSERT INTO tournament_matches (event_id, round_number, bracket_position, pair_a_id, pair_b_id, status)
  SELECT 'cccccccc-0269-4000-8000-0000000000e1', 1, 1, pair1, pair2, 'ready' FROM ctx
  RETURNING id INTO v_match;
  UPDATE ctx SET match1 = v_match;

  -- F1: the result lands.
  UPDATE tournament_matches m SET status = 'completed', scores = '[{"a":15,"b":12}]'::jsonb,
         winner_pair_id = c.pair1, loser_pair_id = c.pair2
    FROM ctx c WHERE m.id = v_match;

  -- F2: no snapshot can be written.
  ok := false;
  BEGIN
    UPDATE tournament_matches SET elo_snapshot = '{}'::jsonb WHERE id = v_match;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'F2: an external match took an elo_snapshot'; END IF;
END $$;

-- ------------------------------------------------------------
-- G. apply_tournament_match_rating, handed a real ratings row, moves nothing
-- ------------------------------------------------------------
DO $$
DECLARE
  v_before text;
  v_after  text;
  ok boolean := false;
BEGIN
  SELECT md5(string_agg(r::text, ',' ORDER BY r.player_id)) INTO v_before
    FROM ratings r WHERE player_id::text LIKE 'cccccccc-0269-4000-8000-%';
  BEGIN
    PERFORM apply_tournament_match_rating(
      (SELECT match1 FROM ctx), 'doubles',
      jsonb_build_array(jsonb_build_object(
        'player_id', 'cccccccc-0269-4000-8000-000000000001',
        'before', 1000, 'after', 1020, 'delta', 20, 'won', true)));
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'G: an external match was rated'; END IF;
  SELECT md5(string_agg(r::text, ',' ORDER BY r.player_id)) INTO v_after
    FROM ratings r WHERE player_id::text LIKE 'cccccccc-0269-4000-8000-%';
  IF v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'G: ratings moved'; END IF;
  IF (SELECT elo_snapshot FROM tournament_matches WHERE id = (SELECT match1 FROM ctx)) IS NOT NULL THEN
    RAISE EXCEPTION 'G: snapshot written';
  END IF;
END $$;

-- ------------------------------------------------------------
-- H. An external pair cannot be split or have a member swapped in
-- ------------------------------------------------------------
-- Against a pair with no match, so the draw guard does not answer first.
DO $$
DECLARE
  ok boolean;
BEGIN
  UPDATE ctx SET pair2 = (SELECT id FROM tournament_pairs
    WHERE event_id = 'cccccccc-0269-4000-8000-0000000000e1' AND external1_name = 'Elm Heron');
  -- Swap requires the incoming member on the event's waiting list, which the
  -- participants fence already refuses, so place the row behind the trigger.
  -- 00292's deferred constraint trigger would queue an event for this insert,
  -- and ALTER TABLE refuses to run with an event pending. Fire it at once.
  SET CONSTRAINTS club_event_link_participant_changed IMMEDIATE;
  ALTER TABLE tournament_participants DISABLE TRIGGER tournament_participants_external_fence;
  INSERT INTO tournament_participants (event_id, player_id)
  VALUES ('cccccccc-0269-4000-8000-0000000000e1', 'cccccccc-0269-4000-8000-000000000001');
  ALTER TABLE tournament_participants ENABLE TRIGGER tournament_participants_external_fence;
  SET CONSTRAINTS club_event_link_participant_changed DEFERRED;

  ok := false;
  BEGIN
    PERFORM unpair_tournament_pair((SELECT pair2 FROM ctx), NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; RAISE NOTICE 'H refused: %', SQLERRM;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'H1: an external pair was split'; END IF;

  ok := false;
  BEGIN
    PERFORM swap_tournament_pair_member((SELECT pair2 FROM ctx),
      NULL,
      'cccccccc-0269-4000-8000-000000000001', 'x', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; RAISE NOTICE 'H refused: %', SQLERRM;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'H2: a member was swapped into an external pair'; END IF;

  IF NOT EXISTS (SELECT 1 FROM tournament_pairs WHERE id = (SELECT pair2 FROM ctx) AND player1_id IS NULL) THEN
    RAISE EXCEPTION 'H: the external pair did not survive';
  END IF;
END $$;

-- ------------------------------------------------------------
-- I. Grants
-- ------------------------------------------------------------
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.add_external_tournament_pair(uuid,text,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.add_external_tournament_pair(uuid,text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'I: add_external_tournament_pair is callable by members';
  END IF;
  RAISE NOTICE '00269 external teams: all cases passed';
END $$;

ROLLBACK;
