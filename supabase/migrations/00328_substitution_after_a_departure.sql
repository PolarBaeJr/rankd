-- ============================================================
-- 00328: A SUBSTITUTION IS ONE STEP, AND NEEDS NO FREE PLACE
--
-- Two gaps in 00327's substitute_event_entry, closed by restating it with
-- three new parameters, all defaulted and all last, so the console's existing
-- named-argument call still resolves.
--
-- 1. LEFT, WITH A SUB, IN ONE TRANSACTION. The desk marked a member as left,
--    chose "Sub someone in", and the console then made two calls: the first
--    recorded the departure and voided the match on court, the second made the
--    sub. A sub dialog cancelled between them left the entry neither subbed
--    nor a no-show, with nothing on court and auto-call free to call it.
--    p_departure_reason now does both inside the substitution: the entry's
--    live match is voided, the departure of each OUTGOING person (never the
--    partner who stays) is recorded, and the people change, or nothing at all
--    happens. The console writes the void note, the audits, the warning and
--    the next auto-call after it returns, as voidMatchImpl does after its void.
--
-- 2. THE INCOMING PERSON NEEDS NO ENTRY. 00327 required the person coming in
--    to be entered first as a spare. Mid-event in a full event that is
--    impossible: the entry paths refuse "Event is full" or the event status,
--    and fill_event_from_waitlist enters nobody once the draw is made. A sub
--    reuses the entry, so the count never changes. Now somebody with no entry
--    in the event may come in directly when they are one of:
--      * a reserve whose waiting row is named in p_waitlist_ids, which is
--        resolved here through remove_from_event_waitlist (00278), not by
--        entering them;
--      * an exec, while no reserve is waiting (other than one this call
--        resolves);
--      * a guest (players.is_guest), made by the console with
--        create_desk_guest (00317) just before.
--    Anybody else still has to be entered first ('not_entered'). A direct
--    incoming person is asked what the promoter asks (00278): not suspended,
--    active, and under the tournament's per-member event cap.
--
-- NO FEE for a direct incoming person: the entry already exists and was
-- charged to whoever entered it. The console says so in its audit row.
--
-- WHAT IS NOT RESTATED: set_field_entry_status, publish_stage_draw,
-- set_pair_member_check_in, fill_event_from_waitlist, enter_tournament_event,
-- add_participants_under_field_lock, join_event_waitlist. remove_from_event_
-- waitlist is CALLED, not restated. The lock order is 00327's (the field's
-- advisory lock, then the tournament row, then the event row);
-- remove_from_event_waitlist takes the same advisory lock again, which the
-- same transaction already holds.
--
-- THE OLD SIGNATURE IS DROPPED, not left beside the new one: two overloads
-- that differ only in defaulted trailing parameters make PostgREST refuse the
-- call as ambiguous.
--
-- PRECONDITIONS: 00327 (the function, tournament_matches.lineup,
-- event_substitutions), 00324 (event_departures), 00278
-- (remove_from_event_waitlist), 00317 (create_desk_guest).
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regprocedure('public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer)') IS NULL
     AND to_regprocedure('public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer, uuid[], text, text)') IS NULL THEN
    RAISE EXCEPTION '00328 needs 00327: public.substitute_event_entry is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournament_matches'
                    AND column_name = 'lineup') THEN
    RAISE EXCEPTION '00328 needs 00327: tournament_matches.lineup is missing';
  END IF;
  IF to_regclass('public.event_departures') IS NULL THEN
    RAISE EXCEPTION '00328 needs 00324: public.event_departures is missing';
  END IF;
  IF to_regprocedure('public.remove_from_event_waitlist(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '00328 needs 00278: public.remove_from_event_waitlist is missing';
  END IF;
  IF to_regprocedure('public.create_desk_guest(text, uuid)') IS NULL THEN
    RAISE EXCEPTION '00328 needs 00317: public.create_desk_guest is missing';
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer);

-- p_outgoing and p_incoming are paired by position, as in 00327.
-- p_waitlist_ids: the waiting rows of reserves coming in, resolved here.
-- p_departure_reason / p_departure_note: the outgoing people left (00324's
-- reasons); their live match is voided and their departure recorded, in this
-- transaction.
CREATE FUNCTION public.substitute_event_entry(
  p_event_id uuid,
  p_entry_id uuid,
  p_kind text,
  p_outgoing uuid[],
  p_incoming uuid[],
  p_note text,
  p_actor uuid,
  p_allow_restricted boolean DEFAULT false,
  p_pair_name text DEFAULT NULL,
  p_combined_elo integer DEFAULT NULL,
  p_elo_before integer DEFAULT NULL,
  p_waitlist_ids uuid[] DEFAULT NULL,
  p_departure_reason text DEFAULT NULL,
  p_departure_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_status     text;
  v_type       text;
  v_external   boolean;
  v_doubles    boolean;
  v_cap        integer;
  v_entry      record;
  v_members    uuid[];
  v_n          integer;
  v_i          integer;
  v_out        uuid;
  v_in         uuid;
  v_spare      record;
  v_person     record;
  v_live       integer;
  v_kept       integer;
  v_moved      integer;
  v_new1       uuid;
  v_new2       uuid;
  v_stamp1     timestamptz;
  v_stamp2     timestamptz;
  v_waitlist   uuid[] := COALESCE(p_waitlist_ids, '{}'::uuid[]);
  v_wid        uuid;
  v_removed    jsonb;
  v_entries    integer;
  v_departing  boolean := p_departure_reason IS NOT NULL;
  v_dep_note   text := NULLIF(btrim(COALESCE(p_departure_note, '')), '');
  v_voided     uuid[] := '{}'::uuid[];
  v_departures jsonb := '[]'::jsonb;
  v_dep_id     uuid;
BEGIN
  IF p_kind NOT IN ('partner', 'team') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_kind');
  END IF;
  v_n := COALESCE(array_length(p_outgoing, 1), 0);
  IF v_n = 0 OR v_n <> COALESCE(array_length(p_incoming, 1), 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_people');
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_incoming) x) <> v_n
     OR EXISTS (SELECT 1 FROM unnest(p_incoming) x WHERE x = ANY (p_outgoing)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'same_person');
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'note_too_long');
  END IF;
  IF COALESCE(array_length(v_waitlist, 1), 0) > v_n
     OR (SELECT count(DISTINCT x) FROM unnest(v_waitlist) x) <> COALESCE(array_length(v_waitlist, 1), 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_people');
  END IF;
  -- 00324's reasons; "other" needs its note, as event_departures checks.
  IF v_departing AND (
       p_departure_reason NOT IN ('injury', 'told_organizers', 'emergency', 'other', 'without_notice')
       OR (p_departure_reason = 'other' AND v_dep_note IS NULL)
       OR char_length(COALESCE(v_dep_note, '')) > 500) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_departure');
  END IF;

  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));
  SELECT t.max_events_per_player INTO v_cap FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;
  SELECT e.status::text, e.event_type::text, COALESCE(e.external_event, false)
    INTO v_status, v_type, v_external
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_status', 'event_status', v_status);
  END IF;
  -- Somebody leaves a match being played; before play there is none to void.
  IF v_departing AND v_status NOT IN ('live', 'pool_live') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_status', 'event_status', v_status);
  END IF;
  IF v_external THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'external');
  END IF;
  v_doubles := v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');

  -- THE ENTRY, under the locks.
  IF v_doubles THEN
    SELECT pr.id, pr.status::text AS status, pr.player1_id, pr.player2_id,
           NULL::integer AS elo_before, NULL::integer AS elo_change
      INTO v_entry
      FROM tournament_pairs pr
     WHERE pr.id = p_entry_id AND pr.event_id = p_event_id
       FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'entry_not_found'); END IF;
    IF v_entry.player1_id IS NULL OR v_entry.player2_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'external');
    END IF;
    v_members := ARRAY[v_entry.player1_id, v_entry.player2_id];
  ELSE
    SELECT tp.id, tp.status::text AS status, tp.player_id AS player1_id, NULL::uuid AS player2_id, tp.elo_before, tp.elo_change
      INTO v_entry
      FROM tournament_participants tp
     WHERE tp.id = p_entry_id AND tp.event_id = p_event_id
       FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'entry_not_found'); END IF;
    v_members := ARRAY[v_entry.player1_id];
  END IF;

  IF v_entry.status IN ('withdrawn', 'disqualified', 'no_show') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_out', 'entry_status', v_entry.status);
  END IF;

  IF p_kind = 'partner' AND (NOT v_doubles OR v_n <> 1) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_people');
  END IF;
  IF p_kind = 'team' AND v_n <> array_length(v_members, 1) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_people');
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_outgoing) x WHERE NOT (x = ANY (v_members)))
     OR (SELECT count(DISTINCT x) FROM unnest(p_outgoing) x) <> v_n THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_entry');
  END IF;

  -- ON COURT. Without a departure the sub waits for the match to finish or be
  -- voided. With one, the match they walked off is voided below, which a
  -- match carrying a rating could not be (a live match never carries one).
  SELECT count(*) INTO v_live
    FROM tournament_matches m
   WHERE m.event_id = p_event_id AND m.status = 'live'
     AND (NOT v_departing OR m.elo_snapshot IS NOT NULL)
     AND (CASE WHEN v_doubles THEN p_entry_id IN (m.pair_a_id, m.pair_b_id)
               ELSE p_entry_id IN (m.participant_a_id, m.participant_b_id) END);
  IF v_live > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'on_court');
  END IF;

  -- THE RESERVES NAMED: waiting for this event, and coming in on this call.
  FOREACH v_wid IN ARRAY v_waitlist LOOP
    IF NOT EXISTS (SELECT 1 FROM tournament_event_waitlist w
                    WHERE w.id = v_wid AND w.event_id = p_event_id AND w.status = 'waiting'
                      AND w.player_id = ANY (p_incoming)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'reserve_not_waiting', 'waitlist_id', v_wid);
    END IF;
  END LOOP;

  -- EACH INCOMING PERSON: nowhere else in the event, not restricted unless an
  -- exec confirmed, and either entered here as a spare in no match or one of
  -- the people who may come in directly.
  FOR v_i IN 1 .. v_n LOOP
    v_in := p_incoming[v_i];
    IF v_in = ANY (v_members) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'same_person');
    END IF;
    IF EXISTS (SELECT 1 FROM tournament_pairs pr
                WHERE pr.event_id = p_event_id AND pr.id <> p_entry_id
                  AND pr.status::text NOT IN ('withdrawn', 'disqualified')
                  AND v_in IN (pr.player1_id, pr.player2_id)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_in_event', 'player_id', v_in);
    END IF;
    SELECT tp.id, tp.status::text AS status, tp.checked_in_at INTO v_spare
      FROM tournament_participants tp
     WHERE tp.event_id = p_event_id AND tp.player_id = v_in
       AND tp.status::text NOT IN ('withdrawn', 'disqualified', 'no_show');
    IF FOUND THEN
      IF EXISTS (SELECT 1 FROM tournament_matches m
                  WHERE m.event_id = p_event_id
                    AND v_spare.id IN (m.participant_a_id, m.participant_b_id, m.winner_participant_id, m.loser_participant_id)) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_in_event', 'player_id', v_in);
      END IF;
    ELSE
      -- DIRECT. The promoter's questions first (00278), then who may.
      SELECT p.is_banned, p.active_flag, p.is_exec, p.is_guest INTO v_person
        FROM players p WHERE p.id = v_in FOR SHARE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_entered', 'player_id', v_in);
      END IF;
      IF COALESCE(v_person.is_banned, false) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'player_suspended', 'player_id', v_in);
      END IF;
      IF NOT COALESCE(v_person.active_flag, false) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'inactive', 'player_id', v_in);
      END IF;
      IF NOT (
        EXISTS (SELECT 1 FROM tournament_event_waitlist w
                 WHERE w.id = ANY (v_waitlist) AND w.player_id = v_in)
        OR COALESCE(v_person.is_guest, false)
        OR COALESCE(v_person.is_exec, false)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_entered', 'player_id', v_in);
      END IF;
      -- An exec only once no reserve is still waiting: a reserve asked first.
      IF COALESCE(v_person.is_exec, false) AND NOT COALESCE(v_person.is_guest, false)
         AND NOT EXISTS (SELECT 1 FROM tournament_event_waitlist w
                          WHERE w.id = ANY (v_waitlist) AND w.player_id = v_in)
         AND EXISTS (SELECT 1 FROM tournament_event_waitlist w
                      WHERE w.event_id = p_event_id AND w.status = 'waiting'
                        AND NOT (w.id = ANY (v_waitlist))) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'reserves_waiting', 'player_id', v_in);
      END IF;
      -- The per-member cap, as the promoter counts it, under the tournament lock.
      IF v_cap IS NOT NULL AND v_cap > 0 THEN
        SELECT (
          (SELECT count(*) FROM tournament_participants tp
             JOIN tournament_events te ON te.id = tp.event_id
            WHERE te.tournament_id = v_tournament AND tp.player_id = v_in
              AND COALESCE(tp.status::text, '') NOT IN ('withdrawn', 'disqualified'))
          +
          (SELECT count(*) FROM tournament_pairs pr
             JOIN tournament_events te ON te.id = pr.event_id
            WHERE te.tournament_id = v_tournament
              AND (pr.player1_id = v_in OR pr.player2_id = v_in)
              AND COALESCE(pr.status::text, '') NOT IN ('withdrawn', 'disqualified'))
        ) INTO v_entries;
        IF v_entries >= v_cap THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'entry_cap', 'player_id', v_in, 'cap', v_cap);
        END IF;
      END IF;
    END IF;
    IF NOT p_allow_restricted AND EXISTS (
      SELECT 1 FROM event_entry_restrictions r
       WHERE r.player_id = v_in AND r.lifted_at IS NULL
         AND r.starts_at <= now() AND (r.ends_at IS NULL OR r.ends_at > now())
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'restricted', 'player_id', v_in);
    END IF;
  END LOOP;

  -- ---- From here on, the writes that have to happen together ----

  -- 0. LEFT: the match they walked off is voided. Half a match has no winner
  --    to give anybody, and nothing about it was rated or advanced.
  IF v_departing THEN
    WITH voided AS (
      UPDATE tournament_matches m
         SET status = 'voided', updated_at = now()
       WHERE m.event_id = p_event_id AND m.status = 'live'
         AND m.elo_snapshot IS NULL
         AND (CASE WHEN v_doubles THEN p_entry_id IN (m.pair_a_id, m.pair_b_id)
                   ELSE p_entry_id IN (m.participant_a_id, m.participant_b_id) END)
      RETURNING m.id
    )
    SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_voided FROM voided;
  END IF;

  -- 1. Who played the decided matches, for each side this entry is on. A side
  --    already written keeps what it says.
  UPDATE tournament_matches m
     SET lineup = COALESCE(m.lineup, '{}'::jsonb)
                  || jsonb_build_object(
                       CASE WHEN (CASE WHEN v_doubles THEN m.pair_a_id ELSE m.participant_a_id END) = p_entry_id THEN 'a' ELSE 'b' END,
                       to_jsonb(v_members))
   WHERE m.event_id = p_event_id
     AND m.status IN ('completed', 'walkover', 'disputed')
     AND COALESCE(m.is_bye, false) = false
     AND (CASE WHEN v_doubles THEN p_entry_id IN (m.pair_a_id, m.pair_b_id)
               ELSE p_entry_id IN (m.participant_a_id, m.participant_b_id) END)
     AND NOT (COALESCE(m.lineup, '{}'::jsonb) ?
              CASE WHEN (CASE WHEN v_doubles THEN m.pair_a_id ELSE m.participant_a_id END) = p_entry_id THEN 'a' ELSE 'b' END);

  SELECT count(*) FILTER (WHERE m.status IN ('completed', 'walkover', 'disputed')),
         count(*) FILTER (WHERE m.status IN ('pending', 'ready'))
    INTO v_kept, v_moved
    FROM tournament_matches m
   WHERE m.event_id = p_event_id AND COALESCE(m.is_bye, false) = false
     AND (CASE WHEN v_doubles THEN p_entry_id IN (m.pair_a_id, m.pair_b_id)
               ELSE p_entry_id IN (m.participant_a_id, m.participant_b_id) END);

  -- 2. The people change, keeping the entry. A spare's check-in comes with
  --    them and the spare entry goes; a direct incoming person has none.
  v_new1 := v_entry.player1_id;
  v_new2 := v_entry.player2_id;
  FOR v_i IN 1 .. v_n LOOP
    v_out := p_outgoing[v_i];
    v_in := p_incoming[v_i];
    v_stamp1 := NULL;
    SELECT tp.checked_in_at INTO v_stamp1
      FROM tournament_participants tp
     WHERE tp.event_id = p_event_id AND tp.player_id = v_in
       AND tp.status::text NOT IN ('withdrawn', 'disqualified', 'no_show');
    -- During play the desk is putting them on court, so they are here.
    IF v_stamp1 IS NULL AND v_status NOT IN ('registration', 'checkin') THEN
      v_stamp1 := now();
    END IF;
    DELETE FROM tournament_participants tp
     WHERE tp.event_id = p_event_id AND tp.player_id = v_in AND tp.id <> p_entry_id;
    IF v_doubles THEN
      IF v_out = v_entry.player1_id THEN
        v_new1 := v_in;
        -- Two writes: 00309's trigger clears the stamp of a slot whose person
        -- changes, so a stamp set in the same UPDATE as the person is lost.
        UPDATE tournament_pairs SET player1_id = v_in WHERE id = p_entry_id;
        UPDATE tournament_pairs SET player1_checked_in_at = v_stamp1 WHERE id = p_entry_id;
      ELSE
        v_new2 := v_in;
        -- Two writes: 00309's trigger clears the stamp of a slot whose person
        -- changes, so a stamp set in the same UPDATE as the person is lost.
        UPDATE tournament_pairs SET player2_id = v_in WHERE id = p_entry_id;
        UPDATE tournament_pairs SET player2_checked_in_at = v_stamp1 WHERE id = p_entry_id;
      END IF;
    ELSE
      UPDATE tournament_participants
         SET player_id = v_in,
             elo_before = p_elo_before,
             elo_after = NULL,
             elo_change = NULL,
             checked_in_at = COALESCE(v_stamp1, checked_in_at),
             status = CASE WHEN v_stamp1 IS NOT NULL AND status::text = 'registered' THEN 'checked_in' ELSE status END
       WHERE id = p_entry_id;
    END IF;

    INSERT INTO event_substitutions (event_id, kind, outgoing_player_id, incoming_player_id,
                                     participant_id, pair_id, note, outgoing_elo_before, outgoing_elo_change,
                                     matches_kept, matches_moved, made_by)
    VALUES (p_event_id, p_kind, v_out, v_in,
            CASE WHEN v_doubles THEN NULL ELSE p_entry_id END,
            CASE WHEN v_doubles THEN p_entry_id ELSE NULL END,
            NULLIF(btrim(COALESCE(p_note, '')), ''),
            CASE WHEN v_doubles THEN NULL ELSE v_entry.elo_before END,
            CASE WHEN v_doubles THEN NULL ELSE v_entry.elo_change END,
            v_kept, v_moved, p_actor);
  END LOOP;

  IF v_doubles THEN
    SELECT player1_checked_in_at, player2_checked_in_at INTO v_stamp1, v_stamp2
      FROM tournament_pairs WHERE id = p_entry_id;
    UPDATE tournament_pairs
       SET pair_name = COALESCE(p_pair_name, pair_name),
           combined_elo = COALESCE(p_combined_elo, combined_elo),
           checked_in_at = CASE WHEN v_stamp1 IS NOT NULL AND v_stamp2 IS NOT NULL THEN checked_in_at ELSE NULL END,
           status = CASE WHEN status::text = 'checked_in' AND (v_stamp1 IS NULL OR v_stamp2 IS NULL)
                         THEN 'registered' ELSE status END
     WHERE id = p_entry_id;
    -- Back to registered, 00309's trigger reads a pair-level undo and clears
    -- both stamps; the partner who stays checked in keeps theirs.
    UPDATE tournament_pairs
       SET player1_checked_in_at = v_stamp1, player2_checked_in_at = v_stamp2
     WHERE id = p_entry_id
       AND (player1_checked_in_at IS DISTINCT FROM v_stamp1 OR player2_checked_in_at IS DISTINCT FROM v_stamp2);
  END IF;

  -- 3. The outgoing people's open asks to confirm their place (00325).
  UPDATE tournament_event_confirmations c
     SET status = 'void', resolved_at = now()
   WHERE c.event_id = p_event_id AND c.player_id = ANY (p_outgoing)
     AND c.status IN ('pending', 'unreached');

  -- 4. The reserves who came in leave the waitlist, through the desk's own
  --    removal, with the reason saying why. Checked waiting above, under the
  --    lock this transaction still holds, so a refusal here is a fault.
  FOREACH v_wid IN ARRAY v_waitlist LOOP
    v_removed := public.remove_from_event_waitlist(v_wid, p_actor);
    IF NOT COALESCE((v_removed->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'substitute_event_entry: reserve % could not be taken off the waitlist (%)', v_wid, v_removed->>'reason';
    END IF;
    UPDATE tournament_event_waitlist SET reason = 'substituted_in' WHERE id = v_wid;
  END LOOP;

  -- 5. LEFT: one departure for each outgoing person, never for the partner
  --    who stays. The warning, if the reason carries one, is the console's.
  IF v_departing THEN
    FOREACH v_out IN ARRAY p_outgoing LOOP
      v_dep_id := NULL;
      INSERT INTO event_departures (event_id, player_id, participant_id, pair_id, reason, note, marked_by, marked_as)
      VALUES (p_event_id, v_out,
              CASE WHEN v_doubles THEN NULL ELSE p_entry_id END,
              CASE WHEN v_doubles THEN p_entry_id ELSE NULL END,
              p_departure_reason, v_dep_note, p_actor, 'desk')
      ON CONFLICT (event_id, player_id) DO NOTHING
      RETURNING id INTO v_dep_id;
      IF v_dep_id IS NOT NULL THEN
        v_departures := v_departures || jsonb_build_array(jsonb_build_object('player_id', v_out, 'departure_id', v_dep_id));
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'tournament_id', v_tournament,
    'entry_id', p_entry_id,
    'is_pair', v_doubles,
    'kept', v_kept,
    'moved', v_moved,
    'voided', to_jsonb(v_voided),
    'departures', v_departures
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer, uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer, uuid[], text, text) TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_fn  text := 'public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer, uuid[], text, text)';
BEGIN
  IF to_regprocedure(v_fn) IS NULL THEN
    v_bad := array_append(v_bad, 'substitute_event_entry with the 00328 arguments is missing');
  ELSE
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'substitute_event_entry is executable by anon or authenticated');
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'substitute_event_entry is not executable by service_role');
    END IF;
  END IF;
  IF to_regprocedure('public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer)') IS NOT NULL THEN
    v_bad := array_append(v_bad, 'the 00327 signature of substitute_event_entry is still there, which makes the call ambiguous');
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'substitute_event_entry') <> 1 THEN
    v_bad := array_append(v_bad, 'substitute_event_entry is not exactly one function');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00328 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00328 verified: substitute_event_entry takes a departure and a direct incoming person, and is the only one.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
