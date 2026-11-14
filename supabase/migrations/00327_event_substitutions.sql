-- ============================================================
-- 00327: SUBSTITUTIONS
--
-- "Allow ways to sub teams." Before or during an event the desk, or the
-- tournament's day lead, puts somebody in for one member of a pair (a partner
-- sub) or for a whole entry (a team sub: the singles player, or both members
-- of a pair). Behind the release kill switch `substitutions`, which the
-- console enforces.
--
-- THE MODEL. A match points at ENTRIES (pair_a_id, participant_a_id), never at
-- people, and the rating reads the entry's members at the moment it rates. So
-- the entry row is kept and its people are rewritten in place: the entry's id
-- is what carries its seed, its group, its standing and every bracket link,
-- and a successor entry would have broken all of them. What the rewrite would
-- also do is put the incoming person's name on matches they never played, so
-- before it, every DECIDED match of the entry (completed, walkover, disputed)
-- records who actually played that side in tournament_matches.lineup. A
-- lineup already written is never overwritten: it was true when written. An
-- open match (pending, ready) takes the incoming person; a match on court
-- refuses the sub until it is finished or voided.
--
-- Ratings follow: a match already rated keeps its elo_snapshot, which names
-- the people it rated, and a re-rate (an edited result) reads the lineup
-- before the entry (the console's applyTournamentMatchElo).
--
-- THE INCOMING PERSON IS ALREADY ENTERED. Every source the desk offers (a
-- member in the event and not playing, a reserve, an exec, a guest) goes
-- through the existing entry path first, which is what charges the fee and
-- asks for the waiver, and arrives as an entry that is in no match. This
-- function takes that entry's person and removes the spare entry. It never
-- enters anybody itself, as swap_tournament_pair_member (00103) does not.
--
-- NOT ALLOWED: an incoming person already in this event in any other way, an
-- entry that has left the event (withdrawn, disqualified, no_show: undo
-- "Did not come" first), a finished event, an external team, and an incoming
-- member with an active entry restriction unless the console says an exec
-- confirmed it.
--
-- THE LOCK ORDER is fill_event_from_waitlist's (00278): the field's advisory
-- lock, then the tournament row, then the event row. Nothing that takes those
-- locks is redefined here.
--
-- event_substitutions keeps one row per person swapped (a team sub of a pair
-- is two rows), with the outgoing singles player's event rating figures,
-- because the participant row they were on now belongs to somebody else.
-- Service role only. Its three player columns join merge_players_disposable;
-- the console moves the rows to the survivor before it merges.
--
-- PRECONDITIONS: 00324 (merge_players_disposable's latest definition, the
-- restrictions table), 00325 (tournament_event_confirmations), 00309 (the
-- per-member check-in stamps).
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'event_departures' AND col = 'marked_by') THEN
    RAISE EXCEPTION '00327 needs 00324: merge_players_disposable does not have event_departures.marked_by';
  END IF;
  IF to_regclass('public.event_entry_restrictions') IS NULL THEN
    RAISE EXCEPTION '00327 needs 00324: public.event_entry_restrictions is missing';
  END IF;
  IF to_regclass('public.tournament_event_confirmations') IS NULL THEN
    RAISE EXCEPTION '00327 needs 00325: public.tournament_event_confirmations is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournament_pairs'
                    AND column_name = 'player1_checked_in_at') THEN
    RAISE EXCEPTION '00327 needs 00309: tournament_pairs.player1_checked_in_at is missing';
  END IF;
END
$pre$;

-- ---- who played a decided match -----------------------------------------------
ALTER TABLE public.tournament_matches
  ADD COLUMN IF NOT EXISTS lineup jsonb;

ALTER TABLE public.tournament_matches
  DROP CONSTRAINT IF EXISTS tournament_matches_lineup_shape;
ALTER TABLE public.tournament_matches
  ADD CONSTRAINT tournament_matches_lineup_shape
  CHECK (lineup IS NULL OR jsonb_typeof(lineup) = 'object');

COMMENT ON COLUMN public.tournament_matches.lineup IS
  'Who played each side, written when a side''s entry was substituted after this match was decided: {"a": [player ids], "b": [...]}. A side with no key is played by its entry''s members. See 00327.';

-- ---- the record -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_substitutions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('partner', 'team')),
  outgoing_player_id  uuid REFERENCES public.players(id) ON DELETE SET NULL,
  incoming_player_id  uuid REFERENCES public.players(id) ON DELETE SET NULL,
  participant_id      uuid,
  pair_id             uuid,
  note                text CHECK (note IS NULL OR char_length(note) <= 500),
  outgoing_elo_before integer,
  outgoing_elo_change integer,
  matches_kept        integer NOT NULL DEFAULT 0,
  matches_moved       integer NOT NULL DEFAULT 0,
  made_by             uuid REFERENCES public.players(id) ON DELETE SET NULL,
  made_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_substitutions_one_entry CHECK ((participant_id IS NULL) <> (pair_id IS NULL))
);

CREATE INDEX IF NOT EXISTS event_substitutions_event ON public.event_substitutions (event_id, made_at);

COMMENT ON TABLE public.event_substitutions IS
  'One row per person swapped by substitute_event_entry: who went out, who came in, on which entry, and how many matches stayed with the outgoing person. Service role only. See 00327.';

ALTER TABLE public.event_substitutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_substitutions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.event_substitutions TO service_role;

-- ---- the substitution ---------------------------------------------------------
-- p_outgoing and p_incoming are paired by position. A partner sub is one of
-- each, a team sub one (singles) or two (a pair). The console works out the
-- new pair name, combined rating and the incoming singles player's rating, as
-- swapPairMember does, and passes them in.
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
           -- A team whose members are not both here again is not checked in.
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

-- ---- MERGES -------------------------------------------------------------------
-- The rows from 00324, and the three player columns this file adds.
CREATE OR REPLACE FUNCTION public.merge_players_disposable()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',                'player_id'),
    ('push_subscriptions',           'player_id'),
    ('calendar_feed_tokens',         'player_id'),
    ('ratings',                      'player_id'),
    ('reliability_metrics',          'player_id'),
    ('discord_outbox',               'requested_by'),
    ('data_api_consumers',           'created_by'),
    ('data_api_keys',                'minted_by'),
    ('data_api_keys',                'revoked_by'),
    ('club_event_signups',           'player_id'),
    ('club_events',                  'created_by'),
    ('fee_submissions',              'reviewed_by'),
    ('tournament_event_waitlist',    'player_id'),
    ('tournament_event_waitlist',    'resolved_by'),
    ('tournament_category_requests', 'requested_by'),
    ('tournament_category_requests', 'resolved_by'),
    ('data_api_predictions',         'side1_p1'),
    ('data_api_predictions',         'side1_p2'),
    ('data_api_predictions',         'side2_p1'),
    ('data_api_predictions',         'side2_p2'),
    ('registration_import_forms',    'created_by'),
    ('registration_imports',         'submitter_player_id'),
    ('registration_import_entries',  'entrant_id'),
    ('registration_import_entries',  'requested_partner_id'),
    ('registration_import_entries',  'undone_by'),
    ('club_event_waitlist',          'player_id'),
    ('club_event_waitlist',          'resolved_by'),
    ('tournament_court_helpers',     'player_id'),
    ('tournament_court_helpers',     'created_by'),
    ('club_event_signups',           'preferred_partner_player_id'),
    ('club_event_external_signups',  'preferred_partner_player_id'),
    ('possible_duplicate_dismissals', 'player_a'),
    ('possible_duplicate_dismissals', 'player_b'),
    ('possible_duplicate_dismissals', 'dismissed_by'),
    ('attendance_warnings',          'player_id'),
    ('attendance_warnings',          'issued_by'),
    ('attendance_warnings',          'rescinded_by'),
    ('event_entry_restrictions',     'player_id'),
    ('event_entry_restrictions',     'created_by'),
    ('event_entry_restrictions',     'lifted_by'),
    ('tournament_event_confirmations', 'player_id'),
    ('event_departures',             'player_id'),
    ('event_departures',             'marked_by'),
    ('tournaments',                  'day_lead_player_id'),
    ('event_substitutions',          'outgoing_player_id'),
    ('event_substitutions',          'incoming_player_id'),
    ('event_substitutions',          'made_by')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_fn  text := 'public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer)';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.event_substitutions'::regclass AND relrowsecurity) THEN
    v_bad := array_append(v_bad, 'event_substitutions has row level security off');
  END IF;
  IF has_table_privilege('anon', 'public.event_substitutions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.event_substitutions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.event_substitutions', 'INSERT') THEN
    v_bad := array_append(v_bad, 'event_substitutions is reachable beyond the service role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournament_matches'
                    AND column_name = 'lineup') THEN
    v_bad := array_append(v_bad, 'tournament_matches.lineup is missing');
  END IF;

  IF to_regprocedure(v_fn) IS NULL THEN
    v_bad := array_append(v_bad, 'substitute_event_entry is missing');
  ELSE
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'substitute_event_entry is executable by anon or authenticated');
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'substitute_event_entry is not executable by service_role');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 47 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the forty-seven rows');
  END IF;
  IF has_function_privilege('anon', 'public.merge_players_disposable()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.merge_players_disposable()', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is executable by anon or authenticated');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00327 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00327 verified: event_substitutions, tournament_matches.lineup, substitute_event_entry and the merge rows are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
