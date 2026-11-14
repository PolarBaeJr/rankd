-- ============================================================
-- ROLLBACK OF 00328: a substitution after a departure, and with no entry
--
-- Drops the 00328 signature of substitute_event_entry and restates 00327's,
-- verbatim, with its grants. The console then has no one-step "Left, with a
-- sub" and no direct incoming person: deploy a build without them first.
-- Departures, substitutions and waitlist rows 00328 already wrote stay as
-- they are; they are true records.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================


DROP FUNCTION IF EXISTS public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer, uuid[], text, text);

-- 00327's substitute_event_entry, verbatim.
CREATE OR REPLACE FUNCTION public.substitute_event_entry(
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
  p_elo_before integer DEFAULT NULL
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
  v_entry      record;
  v_members    uuid[];
  v_n          integer;
  v_i          integer;
  v_out        uuid;
  v_in         uuid;
  v_spare      record;
  v_live       integer;
  v_kept       integer;
  v_moved      integer;
  v_new1       uuid;
  v_new2       uuid;
  v_stamp1     timestamptz;
  v_stamp2     timestamptz;
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

  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));
  PERFORM 1 FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;
  SELECT e.status::text, e.event_type::text, COALESCE(e.external_event, false)
    INTO v_status, v_type, v_external
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status = 'completed' THEN
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

  -- The shape: a partner sub swaps one of a pair; a team sub swaps everybody.
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

  -- Never while the entry is on court: who played that match would be a guess.
  SELECT count(*) INTO v_live
    FROM tournament_matches m
   WHERE m.event_id = p_event_id AND m.status = 'live'
     AND (CASE WHEN v_doubles THEN p_entry_id IN (m.pair_a_id, m.pair_b_id)
               ELSE p_entry_id IN (m.participant_a_id, m.participant_b_id) END);
  IF v_live > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'on_court');
  END IF;

  -- EACH INCOMING PERSON: entered here as a spare, in no match, nowhere else in
  -- the event, and not restricted unless an exec confirmed.
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
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_entered', 'player_id', v_in);
    END IF;
    IF EXISTS (SELECT 1 FROM tournament_matches m
                WHERE m.event_id = p_event_id
                  AND v_spare.id IN (m.participant_a_id, m.participant_b_id, m.winner_participant_id, m.loser_participant_id)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_in_event', 'player_id', v_in);
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

  -- 2. The people change, keeping the entry. The incoming person's check-in
  --    comes with them from their spare entry, which then goes.
  v_new1 := v_entry.player1_id;
  v_new2 := v_entry.player2_id;
  FOR v_i IN 1 .. v_n LOOP
    v_out := p_outgoing[v_i];
    v_in := p_incoming[v_i];
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
        UPDATE tournament_pairs SET player1_id = v_in, player1_checked_in_at = v_stamp1 WHERE id = p_entry_id;
      ELSE
        v_new2 := v_in;
        UPDATE tournament_pairs SET player2_id = v_in, player2_checked_in_at = v_stamp1 WHERE id = p_entry_id;
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
           -- A team whose members are not both here again is not checked in.
           checked_in_at = CASE WHEN v_stamp1 IS NOT NULL AND v_stamp2 IS NOT NULL THEN checked_in_at ELSE NULL END,
           status = CASE WHEN status::text = 'checked_in' AND (v_stamp1 IS NULL OR v_stamp2 IS NULL)
                         THEN 'registered' ELSE status END
     WHERE id = p_entry_id;
  END IF;

  -- 3. The outgoing people's open asks to confirm their place (00325).
  UPDATE tournament_event_confirmations c
     SET status = 'void', resolved_at = now()
   WHERE c.event_id = p_event_id AND c.player_id = ANY (p_outgoing)
     AND c.status IN ('pending', 'unreached');

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'tournament_id', v_tournament,
    'entry_id', p_entry_id,
    'is_pair', v_doubles,
    'kept', v_kept,
    'moved', v_moved
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer) TO service_role;


NOTIFY pgrst, 'reload schema';
