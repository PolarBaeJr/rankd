-- ============================================================
-- 00326: CHECK-IN CLOSE RELEASES THE NO-SHOWS
--
-- The club's standard: check-in closes 15 minutes before the start, and the
-- final draw comes after it. An entry nobody checked in by then gives up its
-- place, which goes to the reserves on the waitlist and then to the execs.
-- This file is the first step, run by the desk from the Check-In tab (behind
-- the release kill switch fill_empty_places): every entry still waiting is
-- withdrawn, with a warning on each of its members when the console asks for
-- one (the attendance_warnings switch). The fill is the desk's next press,
-- never this function's: the desk calls the reserves by name, because a
-- reserve who is not in the room cannot take a place.
--
-- WHAT IS RELEASED. A participant registered or marked no-show, and a pair
-- registered or marked no-show of which NEITHER member checked in (00309's
-- per-member stamps). A pair one of whom is here keeps its place.
--
-- WHY WITHDRAWN AND NOT no_show. Every capacity count frees only withdrawn and
-- disqualified entries (00278, 00308), so a no-show still holds its slot. A
-- latecomer comes back through Add on the spot.
--
-- THE LOCK ORDER is fill_event_from_waitlist's (00278): the field's advisory
-- lock, then the tournament row, then the event row. set_field_entry_status
-- takes them again inside, which the transaction already holds. It is called,
-- never redefined.
--
-- PRECONDITIONS: 00324 (attendance_warnings), 00309 (the per-member check-in
-- stamps), 00318 (set_field_entry_status).
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regclass('public.attendance_warnings') IS NULL THEN
    RAISE EXCEPTION '00326 needs 00324: public.attendance_warnings is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournament_pairs'
                    AND column_name = 'player1_checked_in_at') THEN
    RAISE EXCEPTION '00326 needs 00309: tournament_pairs.player1_checked_in_at is missing';
  END IF;
  IF to_regprocedure('public.set_field_entry_status(uuid, boolean, text, uuid)') IS NULL THEN
    RAISE EXCEPTION '00326 needs 00318: public.set_field_entry_status is missing';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.release_checkin_no_shows(p_event_id uuid, p_actor uuid, p_warn boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_t_name     text;
  v_status     text;
  v_locked     boolean;
  v_type       text;
  v_max        integer;
  v_doubles    boolean;
  v_label      text;
  v_entry      record;
  v_set        jsonb;
  v_warned     uuid[];
  v_released   jsonb := '[]'::jsonb;
  v_pairs      integer;
  v_unpaired   integer;
  v_taken      integer;
BEGIN
  -- Which tournament, unlocked, purely to know which row to lock next.
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));
  SELECT t.name INTO v_t_name FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;
  SELECT e.status::text, e.draw_locked, e.event_type::text, e.max_participants
    INTO v_status, v_locked, v_type, v_max
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  -- Only between check-in and the draw: once a draw exists, a missing entry is
  -- a walkover, not a free place.
  IF v_status <> 'checkin' OR COALESCE(v_locked, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_status', 'event_status', v_status);
  END IF;

  v_doubles := v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');
  v_label := initcap(replace(v_type, '_', ' '));

  FOR v_entry IN
    SELECT tp.id AS entry_id, false AS is_pair, ARRAY[tp.player_id] AS players
      FROM tournament_participants tp
     WHERE tp.event_id = p_event_id
       AND tp.status::text IN ('registered', 'no_show')
    UNION ALL
    SELECT pr.id, true, array_remove(ARRAY[pr.player1_id, pr.player2_id], NULL)
      FROM tournament_pairs pr
     WHERE pr.event_id = p_event_id
       AND pr.status::text IN ('registered', 'no_show')
       AND pr.player1_checked_in_at IS NULL
       AND pr.player2_checked_in_at IS NULL
  LOOP
    v_warned := '{}';
    IF p_warn AND cardinality(v_entry.players) > 0 THEN
      WITH issued AS (
        INSERT INTO attendance_warnings (player_id, tournament_id, event_id, kind, source, issued_by)
        SELECT pid, v_tournament, p_event_id, 'no_show', 'checkin_close', p_actor
          FROM unnest(v_entry.players) AS pid
        ON CONFLICT DO NOTHING
        RETURNING player_id
      )
      SELECT COALESCE(array_agg(player_id), '{}') INTO v_warned FROM issued;

      INSERT INTO notifications (player_id, type, title, body, metadata)
      SELECT pid, 'general', 'Attendance warning',
             format('You were not checked in for %s at %s when check-in closed, so your place went to the waitlist. No-shows, or leaving without telling the organizers, get a warning and may be restricted from future events.', v_label, v_t_name),
             jsonb_build_object('kind', 'attendance_warning', 'event_id', p_event_id,
                                'tournament_id', v_tournament)
        FROM unnest(v_warned) AS pid;
    END IF;

    v_set := set_field_entry_status(v_entry.entry_id, v_entry.is_pair, 'withdrawn', p_actor);
    IF COALESCE((v_set->>'ok')::boolean, false) THEN
      v_released := v_released || jsonb_build_array(jsonb_build_object(
        'entry_id', v_entry.entry_id, 'is_pair', v_entry.is_pair,
        'player_ids', to_jsonb(v_entry.players), 'warned', to_jsonb(v_warned)));
    END IF;
  END LOOP;

  -- The places now free, by the slot rule every entry path counts with.
  IF v_max IS NULL OR v_max <= 0 THEN
    v_taken := NULL;
  ELSIF v_doubles THEN
    SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
     WHERE event_id = p_event_id AND COALESCE(status::text, '') NOT IN ('withdrawn', 'disqualified');
    SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
     WHERE event_id = p_event_id AND COALESCE(status::text, '') NOT IN ('withdrawn', 'disqualified');
    v_taken := v_pairs + CEIL(v_unpaired / 2.0);
  ELSE
    SELECT COUNT(*) INTO v_taken FROM tournament_participants
     WHERE event_id = p_event_id AND COALESCE(status::text, '') NOT IN ('withdrawn', 'disqualified');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'tournament_id', v_tournament,
    'released', v_released,
    'open_slots', CASE WHEN v_taken IS NULL THEN NULL ELSE GREATEST(v_max - v_taken, 0) END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.release_checkin_no_shows(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_checkin_no_shows(uuid, uuid, boolean) TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
BEGIN
  IF to_regprocedure('public.release_checkin_no_shows(uuid, uuid, boolean)') IS NULL THEN
    v_bad := array_append(v_bad, 'release_checkin_no_shows is missing');
  ELSE
    IF has_function_privilege('anon', 'public.release_checkin_no_shows(uuid, uuid, boolean)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.release_checkin_no_shows(uuid, uuid, boolean)', 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'release_checkin_no_shows is executable by anon or authenticated');
    END IF;
    IF NOT has_function_privilege('service_role', 'public.release_checkin_no_shows(uuid, uuid, boolean)', 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'release_checkin_no_shows is not executable by service_role');
    END IF;
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00326 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00326 verified: release_checkin_no_shows is in place and the service role''s alone.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
