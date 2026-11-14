-- ============================================================
-- 00328_substitution_after_a_departure.sql: a sub in a full event mid-play.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00328 applied:
--
--   psql -v ON_ERROR_STOP=1 < supabase/tests/00328_substitution_after_a_departure.sql
--
-- WHAT IT PROVES
-- --------------
-- A. "Left, with a sub" in a full doubles event: the match they walked off
--    is voided, an exec comes in with no entry, the departure is recorded
--    for the member who went out and never for the partner who stays.
-- B. A departure before play, or with a reason that is not one, writes
--    nothing at all.
-- C. A full singles event with a reserve waiting: an exec is refused, the
--    reserve comes in directly and their waitlist row is resolved.
-- D. A guest comes in directly; a member with no entry who is neither a
--    reserve, an exec nor a guest is refused.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name, status, is_exec, is_guest) VALUES
 ('dddddddd-0328-4000-8000-000000000001','sub328-1@example.invalid','MemberA','recreational', false, false),
 ('dddddddd-0328-4000-8000-000000000002','sub328-2@example.invalid','MemberB','recreational', false, false),
 ('dddddddd-0328-4000-8000-000000000003','sub328-3@example.invalid','MemberC','recreational', false, false),
 ('dddddddd-0328-4000-8000-000000000004','sub328-4@example.invalid','MemberD','recreational', false, false),
 ('dddddddd-0328-4000-8000-000000000005','sub328-5@example.invalid','MemberF','recreational', false, false),
 ('dddddddd-0328-4000-8000-000000000006','sub328-6@example.invalid','MemberG','recreational', false, false),
 ('dddddddd-0328-4000-8000-000000000007','sub328-7@example.invalid','MemberReserve','recreational', false, false),
 ('dddddddd-0328-4000-8000-000000000008','sub328-8@example.invalid','MemberNobody','recreational', false, false),
 ('dddddddd-0328-4000-8000-000000000009','sub328-exec@example.invalid','MemberExec','recreational', true, false),
 ('dddddddd-0328-4000-8000-00000000000a','sub328-guest@example.invalid','Guest','recreational', false, true);
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0328-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date, status) VALUES
 ('dddddddd-0328-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE, 'active');
-- Both events are full: two places, two entries.
INSERT INTO tournament_events (id, tournament_id, event_type, format, status, max_participants) VALUES
 ('dddddddd-0328-4000-8000-0000000000e1', 'dddddddd-0328-4000-8000-0000000000a1', 'open_doubles', 'round_robin', 'live', 2),
 ('dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-0000000000a1', 'open_singles', 'round_robin', 'live', 2),
 ('dddddddd-0328-4000-8000-0000000000e3', 'dddddddd-0328-4000-8000-0000000000a1', 'open_singles', 'round_robin', 'checkin', 2);

INSERT INTO tournament_pairs (id, event_id, player1_id, player2_id, status, checked_in_at, player1_checked_in_at, player2_checked_in_at) VALUES
 ('dddddddd-0328-4000-8000-0000000000b1', 'dddddddd-0328-4000-8000-0000000000e1', 'dddddddd-0328-4000-8000-000000000001', 'dddddddd-0328-4000-8000-000000000002', 'checked_in', now(), now(), now()),
 ('dddddddd-0328-4000-8000-0000000000b2', 'dddddddd-0328-4000-8000-0000000000e1', 'dddddddd-0328-4000-8000-000000000003', 'dddddddd-0328-4000-8000-000000000004', 'checked_in', now(), now(), now());
-- Pair 1 is on court when A walks off.
INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, pair_a_id, pair_b_id, status) VALUES
 ('dddddddd-0328-4000-8000-0000000000c1', 'dddddddd-0328-4000-8000-0000000000e1', 1, 1, 'dddddddd-0328-4000-8000-0000000000b1', 'dddddddd-0328-4000-8000-0000000000b2', 'live');

INSERT INTO tournament_participants (id, event_id, player_id, elo_before, status, checked_in_at) VALUES
 ('dddddddd-0328-4000-8000-0000000000f1', 'dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-000000000005', 1000, 'checked_in', now()),
 ('dddddddd-0328-4000-8000-0000000000f2', 'dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-000000000006', 1000, 'checked_in', now()),
 ('dddddddd-0328-4000-8000-0000000000f3', 'dddddddd-0328-4000-8000-0000000000e3', 'dddddddd-0328-4000-8000-000000000005', 1000, 'checked_in', now());
INSERT INTO tournament_matches (id, event_id, round_number, bracket_position, participant_a_id, participant_b_id, status) VALUES
 ('dddddddd-0328-4000-8000-0000000000d1', 'dddddddd-0328-4000-8000-0000000000e2', 1, 1, 'dddddddd-0328-4000-8000-0000000000f1', 'dddddddd-0328-4000-8000-0000000000f2', 'pending');
INSERT INTO tournament_event_waitlist (id, event_id, player_id, status) VALUES
 ('dddddddd-0328-4000-8000-0000000000a9', 'dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-000000000007', 'waiting');

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := substitute_event_entry(
    'dddddddd-0328-4000-8000-0000000000e1', 'dddddddd-0328-4000-8000-0000000000b1', 'partner',
    ARRAY['dddddddd-0328-4000-8000-000000000001']::uuid[], ARRAY['dddddddd-0328-4000-8000-000000000009']::uuid[],
    NULL, 'dddddddd-0328-4000-8000-000000000009', false, 'MemberExec / MemberB', 1000, NULL,
    NULL, 'without_notice', NULL);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'A1: Left with a sub returned %', v_res;
  END IF;
  IF (SELECT status::text FROM tournament_matches WHERE id = 'dddddddd-0328-4000-8000-0000000000c1') <> 'voided'
     OR NOT (v_res->'voided' ? 'dddddddd-0328-4000-8000-0000000000c1') THEN
    RAISE EXCEPTION 'A2: the match they walked off was not voided: %', v_res;
  END IF;
  IF (SELECT player1_id FROM tournament_pairs WHERE id = 'dddddddd-0328-4000-8000-0000000000b1') <> 'dddddddd-0328-4000-8000-000000000009' THEN
    RAISE EXCEPTION 'A3: the exec is not on the pair';
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_participants WHERE event_id = 'dddddddd-0328-4000-8000-0000000000e1') THEN
    RAISE EXCEPTION 'A4: an entry was made for the exec';
  END IF;
  IF (SELECT count(*) FROM event_departures WHERE event_id = 'dddddddd-0328-4000-8000-0000000000e1') <> 1
     OR NOT EXISTS (SELECT 1 FROM event_departures WHERE event_id = 'dddddddd-0328-4000-8000-0000000000e1'
                      AND player_id = 'dddddddd-0328-4000-8000-000000000001' AND reason = 'without_notice') THEN
    RAISE EXCEPTION 'A5: the departure is not exactly the member who went out';
  END IF;
  IF (SELECT status::text FROM tournament_pairs WHERE id = 'dddddddd-0328-4000-8000-0000000000b1') IN ('no_show', 'withdrawn') THEN
    RAISE EXCEPTION 'A6: the entry was marked out';
  END IF;
  RAISE NOTICE 'A passed: Left with a sub in a full event is one call, the place is kept';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := substitute_event_entry(
    'dddddddd-0328-4000-8000-0000000000e3', 'dddddddd-0328-4000-8000-0000000000f3', 'team',
    ARRAY['dddddddd-0328-4000-8000-000000000005']::uuid[], ARRAY['dddddddd-0328-4000-8000-00000000000a']::uuid[],
    NULL, 'dddddddd-0328-4000-8000-000000000009', false, NULL, NULL, 1000,
    NULL, 'injury', NULL);
  IF v_res->>'reason' IS DISTINCT FROM 'event_status' THEN
    RAISE EXCEPTION 'B1: a departure before play was taken: %', v_res;
  END IF;
  v_res := substitute_event_entry(
    'dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-0000000000f1', 'team',
    ARRAY['dddddddd-0328-4000-8000-000000000005']::uuid[], ARRAY['dddddddd-0328-4000-8000-00000000000a']::uuid[],
    NULL, 'dddddddd-0328-4000-8000-000000000009', false, NULL, NULL, 1000,
    NULL, 'bored', NULL);
  IF v_res->>'reason' IS DISTINCT FROM 'bad_departure' THEN
    RAISE EXCEPTION 'B2: a reason that is not one was taken: %', v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM event_departures WHERE event_id IN ('dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-0000000000e3'))
     OR (SELECT player_id FROM tournament_participants WHERE id = 'dddddddd-0328-4000-8000-0000000000f1') <> 'dddddddd-0328-4000-8000-000000000005' THEN
    RAISE EXCEPTION 'B3: a refusal wrote something';
  END IF;
  RAISE NOTICE 'B passed: a refused departure writes nothing';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := substitute_event_entry(
    'dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-0000000000f1', 'team',
    ARRAY['dddddddd-0328-4000-8000-000000000005']::uuid[], ARRAY['dddddddd-0328-4000-8000-000000000009']::uuid[],
    NULL, 'dddddddd-0328-4000-8000-000000000009', false, NULL, NULL, 1000);
  IF v_res->>'reason' IS DISTINCT FROM 'reserves_waiting' THEN
    RAISE EXCEPTION 'C1: an exec came in ahead of a waiting reserve: %', v_res;
  END IF;
  v_res := substitute_event_entry(
    'dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-0000000000f1', 'team',
    ARRAY['dddddddd-0328-4000-8000-000000000005']::uuid[], ARRAY['dddddddd-0328-4000-8000-000000000007']::uuid[],
    NULL, 'dddddddd-0328-4000-8000-000000000009', false, NULL, NULL, 1000,
    ARRAY['dddddddd-0328-4000-8000-0000000000a9']::uuid[]);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'C2: the reserve sub returned %', v_res;
  END IF;
  IF (SELECT player_id FROM tournament_participants WHERE id = 'dddddddd-0328-4000-8000-0000000000f1') <> 'dddddddd-0328-4000-8000-000000000007' THEN
    RAISE EXCEPTION 'C3: the reserve does not hold the entry';
  END IF;
  IF (SELECT status FROM tournament_event_waitlist WHERE id = 'dddddddd-0328-4000-8000-0000000000a9') = 'waiting'
     OR (SELECT reason FROM tournament_event_waitlist WHERE id = 'dddddddd-0328-4000-8000-0000000000a9') IS DISTINCT FROM 'substituted_in' THEN
    RAISE EXCEPTION 'C4: the waitlist row was not resolved as substituted_in';
  END IF;
  IF (SELECT count(*) FROM tournament_participants WHERE event_id = 'dddddddd-0328-4000-8000-0000000000e2') <> 2 THEN
    RAISE EXCEPTION 'C5: the reserve took a place of their own';
  END IF;
  RAISE NOTICE 'C passed: a reserve comes in directly and the exec waits behind them';
END;
$$;

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := substitute_event_entry(
    'dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-0000000000f2', 'team',
    ARRAY['dddddddd-0328-4000-8000-000000000006']::uuid[], ARRAY['dddddddd-0328-4000-8000-000000000008']::uuid[],
    NULL, 'dddddddd-0328-4000-8000-000000000009', false, NULL, NULL, 1000);
  IF v_res->>'reason' IS DISTINCT FROM 'not_entered' THEN
    RAISE EXCEPTION 'D1: a member with no standing came in: %', v_res;
  END IF;
  v_res := substitute_event_entry(
    'dddddddd-0328-4000-8000-0000000000e2', 'dddddddd-0328-4000-8000-0000000000f2', 'team',
    ARRAY['dddddddd-0328-4000-8000-000000000006']::uuid[], ARRAY['dddddddd-0328-4000-8000-00000000000a']::uuid[],
    NULL, 'dddddddd-0328-4000-8000-000000000009', false, NULL, NULL, 400);
  IF NOT COALESCE((v_res->>'ok')::boolean, false)
     OR (SELECT player_id FROM tournament_participants WHERE id = 'dddddddd-0328-4000-8000-0000000000f2') <> 'dddddddd-0328-4000-8000-00000000000a' THEN
    RAISE EXCEPTION 'D2: the guest did not come in: %', v_res;
  END IF;
  RAISE NOTICE 'D passed: a guest comes in directly, a member with no standing does not';
END;
$$;

ROLLBACK;
