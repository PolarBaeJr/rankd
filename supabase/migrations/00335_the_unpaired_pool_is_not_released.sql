-- ============================================================
-- 00335: THE UNPAIRED POOL IS NOT RELEASED AT CHECK-IN CLOSE
--
-- In a doubles event, tournament_participants holds the Generate teams pool:
-- members who signed up alone and have no team yet (00334). The Check-In tab
-- lists teams only, so nobody can check a pool member in, and 00326 still
-- withdrew every one of them at check-in close and warned them for not
-- coming. A member who was in the room and simply had no partner got an
-- attendance warning.
--
-- The release now takes participants only in a singles event, where they are
-- the entries. In a doubles event only pairs nobody checked in are released;
-- the pool stays as it is, for the desk to pair or remove by hand.
--
-- The function is otherwise 00326's, unchanged.
--
-- PRECONDITIONS: 00326.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================
DO $pre$
BEGIN
  IF to_regprocedure('public.release_checkin_no_shows(uuid, uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION '00335 needs 00326: public.release_checkin_no_shows is missing';
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
       AND NOT v_doubles
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

DO $verify$
BEGIN
  IF position('AND NOT v_doubles' IN pg_get_functiondef('public.release_checkin_no_shows(uuid, uuid, boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00335 verification failed: release_checkin_no_shows still releases the doubles pool';
  END IF;
  IF has_function_privilege('authenticated', 'public.release_checkin_no_shows(uuid, uuid, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.release_checkin_no_shows(uuid, uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '00335 verification failed: release_checkin_no_shows grants changed';
  END IF;
  RAISE NOTICE '00335 verified: the doubles pool is left out of the check-in close release.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
