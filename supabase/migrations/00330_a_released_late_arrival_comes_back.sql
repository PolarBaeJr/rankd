-- ============================================================
-- 00330: A LATE ARRIVAL WHOSE PLACE WAS RELEASED COMES BACK
--
-- Check-in closed, release_checkin_no_shows (00326) withdrew the entries
-- nobody checked in, and then one of them walks in. Until now the only way
-- back was Add on the spot, as a new entry. Two desk actions instead, both
-- only between check-in and the draw:
--
-- 1. reinstate_released_entry: the place is still free, so the entry goes
--    back to 'registered' (never straight to checked in: the console then
--    runs its normal check-in, so the waiver gate still applies) and the
--    no-show warning the release wrote is rescinded: they came.
-- 2. requeue_released_entry: the place has gone, so the withdrawn row is
--    deleted and each member waits again, at the back of the reserves, or at
--    the head when the desk overrides. The warning stays: they were late.
--
-- WHAT PROVES A RELEASE. A withdrawn entry is not necessarily a released one:
-- a member can withdraw themselves. The release is proved by the console's
-- audit row for it ('checkin_no_shows_released', which lists the entry ids)
-- or by an active checkin_close warning on a member, which the release writes
-- only while attendance warnings are on. Either is enough; neither refuses
-- with 'not_released'.
--
-- WHY THE REQUEUE WRITES THE WAITING ROW ITSELF. join_event_waitlist refuses
-- outside 'registration' ('registration_closed') and asks for a waiver hash,
-- so it can never take somebody at check-in. The member was entered already,
-- which is when membership, category and the waiver were asked. The row is
-- the one join_event_waitlist would write, with the desk's joined_at.
--
-- THE FEE (00292, 00248, 00294). On a linked club event the release removed
-- the club sign-up at commit and with it an unpaid fee; a paid one, or one a
-- receipt is waiting on, stayed. Reinstating re-adds the sign-up, whose fee
-- trigger inserts ON CONFLICT DO NOTHING, so a fee kept is never charged
-- twice and a fee removed comes back. A linked club event never offers a
-- freed place to its own queue (club_event_offer_place skips it), so nothing
-- was given away there.
--
-- THE LOCK ORDER is release_checkin_no_shows's: the field's advisory lock,
-- then the tournament row, then the event row.
--
-- WHAT IS NOT RESTATED: set_field_entry_status (it never revives a withdrawn
-- entry, on purpose, so this file writes the status itself), publish_stage_draw,
-- set_pair_member_check_in, fill_event_from_waitlist, enter_tournament_event,
-- add_participants_under_field_lock, join_event_waitlist, delete_stage_matches.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regprocedure('public.release_checkin_no_shows(uuid, uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION '00330 needs 00326: public.release_checkin_no_shows is missing';
  END IF;
  IF to_regclass('public.tournament_event_waitlist') IS NULL THEN
    RAISE EXCEPTION '00330 needs 00278: public.tournament_event_waitlist is missing';
  END IF;
END
$pre$;

-- The released entry as both functions read it, under the locks. Reasons are
-- the console's to word.
CREATE OR REPLACE FUNCTION public.released_entry_under_lock(p_entry_id uuid, p_is_pair boolean)
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
  v_max        integer;
  v_type       text;
  v_entry      text;
  v_players    uuid[];
BEGIN
  IF p_is_pair THEN
    SELECT pr.event_id INTO v_event FROM tournament_pairs pr WHERE pr.id = p_entry_id;
  ELSE
    SELECT tp.event_id INTO v_event FROM tournament_participants tp WHERE tp.id = p_entry_id;
  END IF;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_not_found');
  END IF;
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = v_event;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));
  PERFORM 1 FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;
  SELECT e.status::text, e.draw_locked, e.max_participants, e.event_type::text
    INTO v_status, v_locked, v_max, v_type
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;

  IF v_status <> 'checkin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_status', 'event_status', v_status);
  END IF;
  IF COALESCE(v_locked, false) OR EXISTS (SELECT 1 FROM tournament_matches m WHERE m.event_id = v_event) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'drawn');
  END IF;

  IF p_is_pair THEN
    SELECT pr.status::text, array_remove(ARRAY[pr.player1_id, pr.player2_id], NULL)
      INTO v_entry, v_players
      FROM tournament_pairs pr WHERE pr.id = p_entry_id FOR UPDATE;
  ELSE
    SELECT tp.status::text, ARRAY[tp.player_id]
      INTO v_entry, v_players
      FROM tournament_participants tp WHERE tp.id = p_entry_id FOR UPDATE;
  END IF;
  IF v_entry IS DISTINCT FROM 'withdrawn' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_status', 'entry_status', v_entry);
  END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM tournament_audit_log a
             WHERE a.event_id = v_event AND a.action = 'checkin_no_shows_released'
               AND COALESCE(a.details->'entry_ids', '[]'::jsonb) ? p_entry_id::text)
    OR EXISTS (SELECT 1 FROM attendance_warnings w
                WHERE w.event_id = v_event AND w.player_id = ANY (v_players)
                  AND w.source = 'checkin_close' AND w.rescinded_at IS NULL)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_released');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', v_event,
    'tournament_id', v_tournament,
    'max', v_max,
    'doubles', v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles'),
    'player_ids', to_jsonb(v_players));
END;
$function$;

REVOKE ALL ON FUNCTION public.released_entry_under_lock(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.released_entry_under_lock(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.reinstate_released_entry(p_entry_id uuid, p_is_pair boolean, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_read     jsonb := released_entry_under_lock(p_entry_id, p_is_pair);
  v_event    uuid;
  v_max      integer;
  v_pairs    integer;
  v_unpaired integer;
  v_taken    integer;
  v_players  uuid[];
BEGIN
  IF NOT COALESCE((v_read->>'ok')::boolean, false) THEN
    RETURN v_read;
  END IF;
  v_event := (v_read->>'event_id')::uuid;
  v_max := NULLIF(v_read->>'max', '')::integer;
  SELECT array_agg(value::uuid) INTO v_players FROM jsonb_array_elements_text(v_read->'player_ids');

  -- The places taken once this entry is back, by the slot rule every entry
  -- path counts with (00326's).
  IF v_max IS NOT NULL AND v_max > 0 THEN
    IF (v_read->>'doubles')::boolean THEN
      SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
       WHERE event_id = v_event AND COALESCE(status::text, '') NOT IN ('withdrawn', 'disqualified');
      SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
       WHERE event_id = v_event AND COALESCE(status::text, '') NOT IN ('withdrawn', 'disqualified');
      v_taken := CASE WHEN p_is_pair THEN v_pairs + 1 + CEIL(v_unpaired / 2.0)
                      ELSE v_pairs + CEIL((v_unpaired + 1) / 2.0) END;
    ELSE
      SELECT COUNT(*) + 1 INTO v_taken FROM tournament_participants
       WHERE event_id = v_event AND COALESCE(status::text, '') NOT IN ('withdrawn', 'disqualified');
    END IF;
    IF v_taken > v_max THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'place_taken');
    END IF;
  END IF;

  IF p_is_pair THEN
    UPDATE tournament_pairs SET status = 'registered' WHERE id = p_entry_id;
  ELSE
    UPDATE tournament_participants SET status = 'registered' WHERE id = p_entry_id;
  END IF;

  UPDATE attendance_warnings
     SET rescinded_at = now(), rescinded_by = p_actor, rescind_reason = 'Arrived late; reinstated by the desk'
   WHERE event_id = v_event AND player_id = ANY (v_players)
     AND source = 'checkin_close' AND rescinded_at IS NULL;

  INSERT INTO tournament_audit_log (tournament_id, event_id, action, performed_by, details)
  VALUES ((v_read->>'tournament_id')::uuid, v_event, 'entry_reinstated', p_actor,
          jsonb_build_object('entry_id', p_entry_id, 'is_pair', p_is_pair, 'player_ids', to_jsonb(v_players)));

  RETURN jsonb_build_object('ok', true, 'event_id', v_event, 'player_ids', to_jsonb(v_players));
END;
$function$;

REVOKE ALL ON FUNCTION public.reinstate_released_entry(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reinstate_released_entry(uuid, boolean, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.requeue_released_entry(p_entry_id uuid, p_is_pair boolean, p_actor uuid, p_head boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_read    jsonb := released_entry_under_lock(p_entry_id, p_is_pair);
  v_event   uuid;
  v_players uuid[];
  v_player  uuid;
  v_at      timestamptz := now();
  v_ids     uuid[] := '{}';
  v_id      uuid;
BEGIN
  IF NOT COALESCE((v_read->>'ok')::boolean, false) THEN
    RETURN v_read;
  END IF;
  v_event := (v_read->>'event_id')::uuid;
  SELECT array_agg(value::uuid) INTO v_players FROM jsonb_array_elements_text(v_read->'player_ids');
  IF cardinality(v_players) IS DISTINCT FROM (CASE WHEN p_is_pair THEN 2 ELSE 1 END) THEN
    -- An external team has nobody to put on a waitlist.
    RETURN jsonb_build_object('ok', false, 'reason', 'no_members');
  END IF;
  -- A linked event's reserves are the club event's queue (00307), which
  -- join_event_waitlist refuses the same way.
  IF EXISTS (SELECT 1 FROM club_events ce WHERE ce.tournament_event_id = v_event) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_event_linked');
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_event_waitlist w
              WHERE w.event_id = v_event AND w.player_id = ANY (v_players) AND w.status = 'waiting') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_waiting');
  END IF;

  IF p_head THEN
    SELECT COALESCE(MIN(w.joined_at), now()) - interval '1 second' INTO v_at
      FROM tournament_event_waitlist w WHERE w.event_id = v_event AND w.status = 'waiting';
  END IF;

  IF p_is_pair THEN
    DELETE FROM tournament_pairs WHERE id = p_entry_id;
  ELSE
    DELETE FROM tournament_participants WHERE id = p_entry_id;
  END IF;

  -- One row each, a pair's two in the order they were entered, the second a
  -- microsecond behind so the queue order (event, joined_at, id) is theirs.
  FOREACH v_player IN ARRAY v_players LOOP
    INSERT INTO tournament_event_waitlist (event_id, player_id, status, joined_at)
    VALUES (v_event, v_player, 'waiting', v_at)
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
    v_at := v_at + interval '1 microsecond';
  END LOOP;

  INSERT INTO tournament_audit_log (tournament_id, event_id, action, performed_by, details)
  VALUES ((v_read->>'tournament_id')::uuid, v_event, 'entry_requeued', p_actor,
          jsonb_build_object('entry_id', p_entry_id, 'is_pair', p_is_pair, 'head', p_head,
                             'player_ids', to_jsonb(v_players), 'waitlist_ids', to_jsonb(v_ids)));

  RETURN jsonb_build_object('ok', true, 'event_id', v_event, 'player_ids', to_jsonb(v_players), 'waitlist_ids', to_jsonb(v_ids));
END;
$function$;

REVOKE ALL ON FUNCTION public.requeue_released_entry(uuid, boolean, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_released_entry(uuid, boolean, uuid, boolean) TO service_role;

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_fn  text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.released_entry_under_lock(uuid, boolean)',
    'public.reinstate_released_entry(uuid, boolean, uuid)',
    'public.requeue_released_entry(uuid, boolean, uuid, boolean)'] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      v_bad := array_append(v_bad, v_fn || ' is missing');
    ELSE
      IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
        v_bad := array_append(v_bad, v_fn || ' is executable by anon or authenticated');
      END IF;
      IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
        v_bad := array_append(v_bad, v_fn || ' is not executable by service_role');
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00330 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00330 verified: reinstate_released_entry and requeue_released_entry are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
