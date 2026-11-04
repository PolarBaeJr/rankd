-- ============================================================
-- 00318: THE CHECK-IN-AFTER-THE-DRAW KILL SWITCH, IN THE DATABASE
--
-- The console's release kill switches (packages/shared/src/utils/release-flags.ts)
-- live in one platform_settings row, key 'release_flags'. Off is a literal JSON
-- false; an absent row, an absent field or anything else is on, the shipped
-- behaviour.
--
-- WHAT CHANGES.
--   * release_flag_on(p_id): the same rule, for a function to ask. Created
--     byte-identical by 00316 (the ladder fix) on its own branch, so the two
--     CREATE OR REPLACE statements converge whichever runs first.
--   * The three functions 00315 restated, restated whole again from 00315 with
--     each new branch asking release_flag_on('check_in_after_draw'):
--       publish_stage_draw: stage 1 is drawn from the checked-in entries only
--         while the switch is on; off, from everyone registered or checked in
--         (00272).
--       set_field_entry_status, set_pair_member_check_in: the undo of a
--         check-in or a no-show is taken past the draw only while the switch
--         is on; off, only at 'checkin' (00276, 00309).
--
-- UNCHANGED. Every other guard, signature and grant. With the switch on (no
-- row, the default) each function behaves exactly as 00315 left it.
--
-- Rollback: supabase/rollbacks/00318_down.sql, run by hand, never automatically.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

-- ===========================================================================
-- release_flag_on: one kill switch, on unless a literal false
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.release_flag_on(p_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.platform_settings ps
    WHERE ps.key = 'release_flags'
      AND ps.value -> p_id = 'false'::jsonb
  );
$function$;
REVOKE ALL ON FUNCTION public.release_flag_on(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_flag_on(text) TO anon, authenticated, service_role;

-- ===========================================================================
-- publish_stage_draw: 00315's body, the checked-in-only field behind the switch
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.publish_stage_draw(
  p_event_id uuid, p_stage smallint, p_generation uuid, p_doubles boolean,
  p_entrants uuid[], p_digests jsonb, p_source_fingerprint jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status     TEXT;
  v_format     TEXT;
  v_generation UUID;
  v_new_status TEXT;
  v_now        INTEGER;
  v_expected   INTEGER;
  v_left       INTEGER;
  v_extra      INTEGER;
  v_matches    INTEGER;
  v_foreign    INTEGER;
  v_changed    INTEGER;
  v_rows       INTEGER;
  v_uses_checkin BOOLEAN;
BEGIN
  IF p_stage IS NULL OR p_stage NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'publish_stage_draw: a stage is 1 to 8';
  END IF;
  IF p_generation IS NULL THEN
    RAISE EXCEPTION 'publish_stage_draw: p_generation may not be null';
  END IF;
  IF p_entrants IS NULL OR array_length(p_entrants, 1) IS NULL THEN
    RAISE EXCEPTION 'publish_stage_draw: p_entrants may not be null or empty';
  END IF;
  v_expected := array_length(p_entrants, 1);

  IF p_stage = 1 THEN
    IF p_digests IS NULL OR jsonb_typeof(p_digests) <> 'array' THEN
      RAISE EXCEPTION 'publish_stage_draw: p_digests must be a jsonb array';
    END IF;
    IF jsonb_array_length(p_digests) <> v_expected THEN
      RAISE EXCEPTION 'publish_stage_draw: p_digests has % entries for % entrants',
        jsonb_array_length(p_digests), v_expected;
    END IF;
  ELSIF p_source_fingerprint IS NULL OR jsonb_typeof(p_source_fingerprint) <> 'object' THEN
    RAISE EXCEPTION 'publish_stage_draw: a later stage needs p_source_fingerprint';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.format, e.draw_generation_id
    INTO v_status, v_format, v_generation
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_format <> 'staged' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_staged');
  END IF;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed', 'event_status', v_status);
  END IF;
  IF p_stage > 1 AND v_status <> 'live' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_live', 'event_status', v_status);
  END IF;

  IF v_generation IS DISTINCT FROM p_generation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'superseded');
  END IF;

  -- ---- everybody drawn is still in the event ---------------------------
  IF p_doubles THEN
    SELECT COUNT(*) INTO v_left
      FROM unnest(p_entrants) AS e(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM tournament_pairs pr
        WHERE pr.id = e.id AND pr.event_id = p_event_id
          AND pr.status::TEXT IN ('registered', 'checked_in'));
  ELSE
    SELECT COUNT(*) INTO v_left
      FROM unnest(p_entrants) AS e(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM tournament_participants tp
        WHERE tp.id = e.id AND tp.event_id = p_event_id
          AND tp.status::TEXT IN ('registered', 'checked_in'));
  END IF;
  IF v_left > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entrant_left', 'count', v_left);
  END IF;

  IF p_stage = 1 THEN
    -- ---- what the entrants contained: 00202's digest, key for key -------
    IF p_doubles THEN
      SELECT COUNT(*) INTO v_changed
        FROM unnest(p_entrants) WITH ORDINALITY AS e(id, ord)
        JOIN tournament_pairs pr ON pr.id = e.id AND pr.event_id = p_event_id
       WHERE jsonb_build_object(
               'p1',   pr.player1_id,
               'p2',   pr.player2_id,
               'ce',   pr.combined_elo,
               'seed', pr.seed_number,
               'grp',  pr.group_number)
             IS DISTINCT FROM (p_digests -> (e.ord - 1)::INTEGER);
    ELSE
      SELECT COUNT(*) INTO v_changed
        FROM unnest(p_entrants) WITH ORDINALITY AS e(id, ord)
        JOIN tournament_participants tp ON tp.id = e.id AND tp.event_id = p_event_id
       WHERE jsonb_build_object(
               'p',    tp.player_id,
               'eb',   tp.elo_before,
               'ea',   tp.elo_after,
               'seed', tp.seed_number,
               'grp',  tp.group_number)
             IS DISTINCT FROM (p_digests -> (e.ord - 1)::INTEGER);
    END IF;
    IF v_changed > 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'entrant_changed', 'count', v_changed);
    END IF;

    -- ---- nobody in the event is missing from the draw --------------------
    -- 00315: once anybody has checked in, the field is the checked-in entries
    -- only (drawField in the console), so a team still only registered is
    -- left out on purpose, not missed. Nobody checked in: everyone, as before.
    -- 00318: and only while the kill switch check_in_after_draw is on; off,
    -- v_uses_checkin is false and the field is 00272's, registered or checked in.
    IF p_doubles THEN
      v_uses_checkin := (SELECT public.release_flag_on('check_in_after_draw')) AND EXISTS (SELECT 1 FROM tournament_pairs
                                 WHERE event_id = p_event_id AND status::TEXT = 'checked_in');
      SELECT COUNT(*) INTO v_now FROM tournament_pairs
       WHERE event_id = p_event_id
         AND (status::TEXT = 'checked_in' OR (NOT v_uses_checkin AND status::TEXT = 'registered'));
      SELECT COUNT(*) INTO v_extra FROM tournament_pairs
       WHERE event_id = p_event_id
         AND (status::TEXT = 'checked_in' OR (NOT v_uses_checkin AND status::TEXT = 'registered'))
         AND NOT (id = ANY (p_entrants));
    ELSE
      v_uses_checkin := (SELECT public.release_flag_on('check_in_after_draw')) AND EXISTS (SELECT 1 FROM tournament_participants
                                 WHERE event_id = p_event_id AND status::TEXT = 'checked_in');
      SELECT COUNT(*) INTO v_now FROM tournament_participants
       WHERE event_id = p_event_id
         AND (status::TEXT = 'checked_in' OR (NOT v_uses_checkin AND status::TEXT = 'registered'));
      SELECT COUNT(*) INTO v_extra FROM tournament_participants
       WHERE event_id = p_event_id
         AND (status::TEXT = 'checked_in' OR (NOT v_uses_checkin AND status::TEXT = 'registered'))
         AND NOT (id = ANY (p_entrants));
    END IF;
    IF v_extra > 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'field_grew',
                                'expected', v_expected, 'now', v_now);
    END IF;
  ELSE
    -- ---- the results this stage was drawn from have not moved -------------
    IF public.staged_source_fingerprint(p_event_id, p_stage) IS DISTINCT FROM p_source_fingerprint THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'source_changed');
    END IF;
  END IF;

  -- ---- what was actually built (00197) -----------------------------------
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE m.draw_generation_id IS DISTINCT FROM p_generation)
    INTO v_matches, v_foreign
    FROM tournament_matches m
   WHERE m.event_id = p_event_id
     AND m.stage = p_stage;
  IF v_foreign > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'foreign_matches', 'count', v_foreign);
  END IF;
  IF v_matches = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_matches');
  END IF;

  -- A redraw never sends a live event backwards; a later stage is drawn while
  -- the event is live and leaves it there.
  v_new_status := CASE WHEN v_status = 'live' THEN 'live' ELSE 'bracket_generated' END;

  UPDATE tournament_events
     SET status = v_new_status, current_stage = p_stage, updated_at = NOW()
   WHERE id = p_event_id
     AND status::TEXT = v_status;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'publish_stage_draw: event status moved under the lock (% rows updated)', v_rows
      USING ERRCODE = 'serialization_failure';
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'matches', v_matches, 'status', v_new_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.publish_stage_draw(uuid, smallint, uuid, boolean, uuid[], jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_stage_draw(uuid, smallint, uuid, boolean, uuid[], jsonb, jsonb) TO service_role;

-- ===========================================================================
-- set_field_entry_status: 00315's body, the undo past the draw behind the switch
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.set_field_entry_status(p_entry_id uuid, p_is_pair boolean, p_new_status text, p_actor uuid)
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
  v_t_ci_opens  timestamptz;
  v_t_ci_closes timestamptz;
  v_e_ci_opens  timestamptz;
  v_e_ci_closes timestamptz;
  v_ci_opens    timestamptz;
  v_ci_closes   timestamptz;
  v_win         text;
BEGIN
  IF p_new_status NOT IN ('checked_in', 'no_show', 'withdrawn', 'disqualified', 'registered') THEN
    RAISE EXCEPTION 'set_field_entry_status: % is not a settable entry status', p_new_status;
  END IF;
  IF p_entry_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'set_field_entry_status: p_entry_id and p_is_pair may not be null';
  END IF;

  -- Unfenced, and only to learn which event to fence ON. Nothing is decided
  -- from this read; every value it produces is re-read below under the lock.
  IF p_is_pair THEN
    SELECT event_id INTO v_event FROM tournament_pairs WHERE id = p_entry_id;
  ELSE
    SELECT event_id INTO v_event FROM tournament_participants WHERE id = p_entry_id;
  END IF;
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

  -- THE ENTRY, RE-READ UNDER THE LOCK. The row could have moved between the
  -- read above and this point; this is the value the write lands against.
  IF p_is_pair THEN
    SELECT status::TEXT INTO v_before FROM tournament_pairs
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  ELSE
    SELECT status::TEXT INTO v_before FROM tournament_participants
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  END IF;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  -- ---- the narrow status guards, per target status ----------------------
  IF p_new_status IN ('checked_in', 'no_show') THEN
    IF v_status = 'registration' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
  END IF;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;

  -- Check-in is one of the two that moves a row FORWARD into play, so it cares
  -- what the row was: checking in somebody who has withdrawn would put them
  -- back in the field without anybody deciding to.
  IF p_new_status = 'checked_in' AND v_before NOT IN ('registered', 'checked_in') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  -- AND SO IS no_show -- 00202. See the header above this function.
  IF p_new_status = 'no_show' AND v_before NOT IN ('registered', 'checked_in', 'no_show') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  -- 00271: 'registered' IS THE UNDO, and only the undo. It takes a mistaken
  -- check-in or no-show back to waiting. 00315: from check-in until the event
  -- is completed (refused above), not only while it is at 'checkin', because
  -- a staged event keeps checking people in after its draw and the desk has
  -- to be able to take back a press on the wrong row. It never revives a
  -- withdrawn or disqualified entry, and a no-show comes back as waiting, not
  -- as checked in, so the waiver check at the door still runs when they do
  -- turn up.
  IF p_new_status = 'registered' THEN
    -- 00318: kill switch check_in_after_draw off, the undo is 00276's again:
    -- only while the event is at 'checkin'.
    IF v_status = 'registration'
       OR (NOT (SELECT public.release_flag_on('check_in_after_draw')) AND v_status <> 'checkin') THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
    IF v_before NOT IN ('checked_in', 'no_show', 'registered') THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_undoable',
                                'entry_status', v_before, 'event_status', v_status);
    END IF;
  END IF;

  -- 00276: THE MEMBER'S OWN CHECK-IN IS INSIDE THE CHECK-IN WINDOW.
  -- p_actor IS NULL is the discriminator, and it is a contract with the
  -- callers: the player app's self check-in and QR scan pass NULL with
  -- 'checked_in' (nobody at a desk checked them in), and every console
  -- 'checked_in' passes the exec's id. The console's no-show passes NULL too,
  -- but only with 'no_show', which never reaches here. An exec can therefore
  -- still check anybody in at any time. A repeat scan by somebody already
  -- checked in is not gated, so it still reports `already`.
  --
  -- The tournaments read takes NO lock. This function holds the event row,
  -- and the schema's order is tournaments before tournament_events; locking
  -- the parent now would invert it. A window edited in the gap is an exec's
  -- own change and is read on the next scan.
  IF p_new_status = 'checked_in' AND p_actor IS NULL AND v_before <> 'checked_in' THEN
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

  v_already := (v_before = p_new_status);

  -- A REPEAT PRESS WRITES NOTHING BUT IS NOT AN ERROR HERE. exitDrawImpl needs
  -- to distinguish "already withdrawn, nothing to do" from "already withdrawn,
  -- but the forfeit cascade stopped partway and this retry is what finishes
  -- it". Only the caller knows which, because only it runs the cascade.
  IF NOT v_already THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW()
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_by END
       WHERE id = p_entry_id;
    ELSE
      UPDATE tournament_participants
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW()
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_by END
       WHERE id = p_entry_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'already', v_already,
    'entry_status_before', v_before,
    'event_status', v_status,
    'event_id', v_event,
    'tournament_id', v_tournament,
    'draw_locked', COALESCE(v_locked, FALSE)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) TO service_role;

-- ===========================================================================
-- set_pair_member_check_in: 00315's body, the undo past the draw behind the switch
-- ===========================================================================

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
  -- The undo, from check-in until the event is completed (00315, as
  -- set_field_entry_status), and never of a withdrawn, disqualified or
  -- no-show team: those have their own undo.
  IF NOT p_here THEN
    -- 00318: kill switch check_in_after_draw off, the undo is 00309's again:
    -- only while the event is at 'checkin'.
    IF v_status = 'registration'
       OR (NOT (SELECT public.release_flag_on('check_in_after_draw')) AND v_status <> 'checkin') THEN
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
  v_fn  text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.publish_stage_draw(uuid,smallint,uuid,boolean,uuid[],jsonb,jsonb)',
    'public.set_field_entry_status(uuid,boolean,text,uuid)',
    'public.set_pair_member_check_in(uuid,smallint,boolean,uuid)'
  ] LOOP
    IF position('release_flag_on(''check_in_after_draw'')' IN pg_get_functiondef(v_fn::regprocedure)) = 0 THEN
      v_bad := array_append(v_bad, v_fn || ' does not ask the check_in_after_draw switch');
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, v_fn || ' is executable by anon or authenticated');
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, v_fn || ' is not executable by service_role');
    END IF;
  END LOOP;

  -- The switch reads on with no row, which is every database until a first save.
  IF NOT EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'release_flags')
     AND public.release_flag_on('check_in_after_draw') IS DISTINCT FROM TRUE THEN
    v_bad := array_append(v_bad, 'release_flag_on is not on with no release_flags row');
  END IF;
  IF NOT has_function_privilege('service_role', 'public.release_flag_on(text)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'release_flag_on is not executable by service_role');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00318 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00318 verified: check-in after the draw follows its kill switch.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
