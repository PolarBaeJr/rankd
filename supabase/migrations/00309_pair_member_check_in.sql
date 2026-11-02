-- ============================================================
-- 00309: EACH PERSON IN A DOUBLES TEAM CHECKS IN ON THEIR OWN
--
-- A doubles team used to check in as one row: the desk pressed Check In when
-- both had turned up, and nothing recorded the partner who arrived first. At
-- the door people arrive one at a time, so the desk now marks each person,
-- and the team is checked in when the second one is.
--
-- WHAT CHANGES.
--   * tournament_pairs.player1_checked_in_at and player2_checked_in_at: when
--     that slot's person was marked here. Per SLOT, not per player, because an
--     external team (00269) has names and no player ids. No _by columns: a new
--     player FK would block merge_players until classified (00207).
--   * Backfill: a pair already checked in has both slots stamped with its
--     checked_in_at.
--   * tournament_pairs_member_check_in, a BEFORE UPDATE trigger, keeps the
--     slots true whoever writes the row: a changed player id clears that slot;
--     a move into checked_in (the pair-level check-in, bulk check-in, the
--     door board, the player app's scan) stamps any empty slot; a move back to
--     registered from checked_in or no_show clears both unless the same UPDATE
--     set a slot itself (the per-person undo below).
--   * set_pair_member_check_in(pair, slot, here, actor): the per-person write.
--     Fenced like set_field_entry_status (00276), whose guards and return keys
--     it shares, plus pair_checked_in. A NULL slot means both, for the
--     pair-level undo.
--
-- UNCHANGED. Every draw still takes registered or checked_in, and the
-- pair-level check-in paths are untouched: the trigger stamps the slots for
-- them.
--
-- NEW FUNCTIONS.
--   * set_pair_member_check_in(uuid, smallint, boolean, uuid) (service_role only)
--   * tournament_pairs_member_check_in() (trigger)
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

-- ---- the columns ----------------------------------------------------------

ALTER TABLE public.tournament_pairs
  ADD COLUMN IF NOT EXISTS player1_checked_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS player2_checked_in_at timestamptz;

COMMENT ON COLUMN public.tournament_pairs.player1_checked_in_at IS
  'When the team''s first person (player1_id, or external1_name on an external team) was marked here at check-in (00309). NULL is not here yet. The team is checked in once both slots are set.';
COMMENT ON COLUMN public.tournament_pairs.player2_checked_in_at IS
  'When the team''s second person (player2_id, or external2_name on an external team) was marked here at check-in (00309). NULL is not here yet. The team is checked in once both slots are set.';

-- ---- the backfill ---------------------------------------------------------

UPDATE public.tournament_pairs
   SET player1_checked_in_at = COALESCE(player1_checked_in_at, checked_in_at, now()),
       player2_checked_in_at = COALESCE(player2_checked_in_at, checked_in_at, now())
 WHERE status = 'checked_in';

-- ---- the trigger ----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tournament_pairs_member_check_in()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A different person in the slot has not been marked here.
  IF NEW.player1_id IS DISTINCT FROM OLD.player1_id THEN
    NEW.player1_checked_in_at := NULL;
  END IF;
  IF NEW.player2_id IS DISTINCT FROM OLD.player2_id THEN
    NEW.player2_checked_in_at := NULL;
  END IF;

  -- The team checked in as a whole: everyone not yet marked is here now.
  IF NEW.status = 'checked_in' AND OLD.status IS DISTINCT FROM 'checked_in' THEN
    NEW.player1_checked_in_at := COALESCE(NEW.player1_checked_in_at, NEW.checked_in_at, now());
    NEW.player2_checked_in_at := COALESCE(NEW.player2_checked_in_at, NEW.checked_in_at, now());
  -- A pair-level undo: back to waiting, both people with it. An UPDATE that
  -- set a slot itself is the per-person undo and keeps what it set.
  ELSIF NEW.status = 'registered' AND OLD.status IN ('checked_in', 'no_show')
        AND NEW.player1_checked_in_at IS NOT DISTINCT FROM OLD.player1_checked_in_at
        AND NEW.player2_checked_in_at IS NOT DISTINCT FROM OLD.player2_checked_in_at THEN
    NEW.player1_checked_in_at := NULL;
    NEW.player2_checked_in_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tournament_pairs_member_check_in() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tournament_pairs_member_check_in ON public.tournament_pairs;
CREATE TRIGGER tournament_pairs_member_check_in
  BEFORE UPDATE ON public.tournament_pairs
  FOR EACH ROW EXECUTE FUNCTION public.tournament_pairs_member_check_in();

-- ===========================================================================
-- set_pair_member_check_in: one person of a pair, here or not
-- ===========================================================================
--
-- The fence, the guards and the self check-in window are set_field_entry_status's
-- (00276), so a person is refused exactly where their team would be.

CREATE OR REPLACE FUNCTION public.set_pair_member_check_in(p_pair_id uuid, p_slot smallint, p_here boolean, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
  v_before     text;
  v_already    boolean;
  v_p1_before  timestamptz;
  v_p2_before  timestamptz;
  v_ci_at      timestamptz;
  v_p1         timestamptz;
  v_p2         timestamptz;
  v_after      text;
  v_t_ci_opens  timestamptz;
  v_t_ci_closes timestamptz;
  v_e_ci_opens  timestamptz;
  v_e_ci_closes timestamptz;
  v_ci_opens    timestamptz;
  v_ci_closes   timestamptz;
  v_win         text;
BEGIN
  IF p_pair_id IS NULL OR p_here IS NULL THEN
    RAISE EXCEPTION 'set_pair_member_check_in: p_pair_id and p_here may not be null';
  END IF;
  IF p_slot IS NOT NULL AND p_slot NOT IN (1, 2) THEN
    RAISE EXCEPTION 'set_pair_member_check_in: % is not a pair slot', p_slot;
  END IF;

  -- Unfenced, and only to learn which event to fence ON. Nothing is decided
  -- from this read; every value it produces is re-read below under the lock.
  SELECT event_id INTO v_event FROM tournament_pairs WHERE id = p_pair_id;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked
    INTO v_status, v_tournament, v_locked
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  SELECT status::TEXT, player1_checked_in_at, player2_checked_in_at, checked_in_at
    INTO v_before, v_p1_before, v_p2_before, v_ci_at
    FROM tournament_pairs
   WHERE id = p_pair_id AND event_id = v_event FOR UPDATE;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  -- ---- the guards, as set_field_entry_status's -----------------------------
  IF p_here AND v_status = 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;
  IF p_here AND v_before NOT IN ('registered', 'checked_in') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;
  -- The undo, only while check-in is open, and never of a withdrawn,
  -- disqualified or no-show team: those have their own undo.
  IF NOT p_here THEN
    IF v_status <> 'checkin' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
    IF v_before NOT IN ('registered', 'checked_in') THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_undoable',
                                'entry_status', v_before, 'event_status', v_status);
    END IF;
  END IF;

  -- 00276's self check-in window, copied. p_actor IS NULL is a member's own
  -- check-in; an exec's is never gated.
  IF p_here AND p_actor IS NULL AND v_before <> 'checked_in' THEN
    SELECT t.checkin_opens_at, t.checkin_closes_at
      INTO v_t_ci_opens, v_t_ci_closes
      FROM tournaments t WHERE t.id = v_tournament;
    -- The event row is already locked above.
    SELECT e.checkin_opens_at, e.checkin_closes_at
      INTO v_e_ci_opens, v_e_ci_closes
      FROM tournament_events e WHERE e.id = v_event;
    v_ci_opens  := COALESCE(v_e_ci_opens, v_t_ci_opens);
    v_ci_closes := COALESCE(v_e_ci_closes, v_t_ci_closes);
    v_win := entry_window_state(v_ci_opens, v_ci_closes, now());
    IF v_win = 'not_open_yet' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'checkin_not_open',
                                'opens_at', v_ci_opens, 'event_status', v_status);
    END IF;
    IF v_win = 'closed' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'checkin_window_closed',
                                'closes_at', v_ci_closes, 'event_status', v_status);
    END IF;
  END IF;

  v_after := v_before;
  IF p_here THEN
    v_p1 := CASE WHEN p_slot IS NULL OR p_slot = 1 THEN COALESCE(v_p1_before, now()) ELSE v_p1_before END;
    v_p2 := CASE WHEN p_slot IS NULL OR p_slot = 2 THEN COALESCE(v_p2_before, now()) ELSE v_p2_before END;
    v_already := v_p1 IS NOT DISTINCT FROM v_p1_before AND v_p2 IS NOT DISTINCT FROM v_p2_before;
    -- The second person in checks the team in.
    IF v_before = 'registered' AND v_p1 IS NOT NULL AND v_p2 IS NOT NULL THEN
      UPDATE tournament_pairs
         SET player1_checked_in_at = v_p1,
             player2_checked_in_at = v_p2,
             status                = 'checked_in',
             checked_in_at         = now(),
             checked_in_by         = p_actor
       WHERE id = p_pair_id;
      v_after := 'checked_in';
      v_already := FALSE;
    ELSIF NOT v_already THEN
      UPDATE tournament_pairs
         SET player1_checked_in_at = v_p1,
             player2_checked_in_at = v_p2
       WHERE id = p_pair_id;
    END IF;
  ELSE
    IF v_before = 'checked_in' THEN
      -- The team goes back to waiting; the other person stays here.
      v_p1 := CASE WHEN p_slot IS NULL OR p_slot = 1 THEN NULL ELSE COALESCE(v_p1_before, v_ci_at) END;
      v_p2 := CASE WHEN p_slot IS NULL OR p_slot = 2 THEN NULL ELSE COALESCE(v_p2_before, v_ci_at) END;
      UPDATE tournament_pairs
         SET player1_checked_in_at = v_p1,
             player2_checked_in_at = v_p2,
             status                = 'registered',
             checked_in_at         = NULL,
             checked_in_by         = NULL
       WHERE id = p_pair_id;
      v_after := 'registered';
      v_already := FALSE;
    ELSE
      v_p1 := CASE WHEN p_slot IS NULL OR p_slot = 1 THEN NULL ELSE v_p1_before END;
      v_p2 := CASE WHEN p_slot IS NULL OR p_slot = 2 THEN NULL ELSE v_p2_before END;
      v_already := v_p1 IS NOT DISTINCT FROM v_p1_before AND v_p2 IS NOT DISTINCT FROM v_p2_before;
      IF NOT v_already THEN
        UPDATE tournament_pairs
           SET player1_checked_in_at = v_p1,
               player2_checked_in_at = v_p2
         WHERE id = p_pair_id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'already', v_already,
    'entry_status_before', v_before,
    'event_status', v_status,
    'event_id', v_event,
    'tournament_id', v_tournament,
    'draw_locked', COALESCE(v_locked, FALSE),
    'pair_checked_in', v_after = 'checked_in'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.set_pair_member_check_in(uuid, smallint, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pair_member_check_in(uuid, smallint, boolean, uuid) TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tournament_pairs'
         AND column_name IN ('player1_checked_in_at', 'player2_checked_in_at')) <> 2 THEN
    v_bad := array_append(v_bad, 'tournament_pairs is missing a slot check-in column');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'tournament_pairs_member_check_in'
                    AND tgrelid = 'public.tournament_pairs'::regclass) THEN
    v_bad := array_append(v_bad, 'the tournament_pairs_member_check_in trigger is missing');
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_pairs
              WHERE status = 'checked_in'
                AND (player1_checked_in_at IS NULL OR player2_checked_in_at IS NULL)) THEN
    v_bad := array_append(v_bad, 'a checked-in pair has an unstamped slot');
  END IF;
  IF has_function_privilege('anon', 'public.set_pair_member_check_in(uuid,smallint,boolean,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_pair_member_check_in(uuid,smallint,boolean,uuid)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'set_pair_member_check_in is executable by anon or authenticated');
  END IF;
  IF NOT has_function_privilege('service_role', 'public.set_pair_member_check_in(uuid,smallint,boolean,uuid)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'set_pair_member_check_in is not executable by service_role');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00309 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00309 verified: the slot columns, the trigger and set_pair_member_check_in are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
