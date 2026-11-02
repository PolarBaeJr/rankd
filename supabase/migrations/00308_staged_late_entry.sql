-- ============================================================
-- 00308: A STAGED EVENT TAKES A LATE ENTRY INTO ITS GROUPS
--
-- A staged event whose first stage is groups drawn from the field is the one
-- draw that can take somebody after it is published without redrawing: the
-- console puts the newcomer into one group and adds only their matches, so no
-- row already drawn moves and no result is touched. Until now the entry paths
-- refused anything past check-in, so a team that turned up after the draw
-- could not be entered at all.
--
-- WHAT CHANGES.
--   * staged_late_entry_open(event): true while that window is open. The event
--     is staged, at bracket_generated or live, not draw locked, its first stage
--     is groups drawn from the field, that stage has matches, and no later
--     stage has any. Once a later stage is drawn the window shuts, because the
--     later stage was filled from the group tables as they stood.
--   * add_participants_under_field_lock (00199), pair_tournament_entrants
--     (00201) and add_external_tournament_pair (00269): the console's three
--     entry paths. The bodies are their latest versions, unchanged apart from
--     the status gate, which now also lets the window through. Each asks the
--     helper after taking the field lock, so the answer cannot move under it.
--     The 00201 comments are recast without em dashes; no code there changed.
--
-- UNCHANGED. A member still cannot enter themselves after the draw:
-- enter_tournament_event (00307) and the club event link (00292) keep their
-- gates. The late entry is an officer's act.
--
-- NEW FUNCTION (service_role only).
--   * staged_late_entry_open(uuid)
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.staged_late_entry_open(p_event_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM tournament_events e
     WHERE e.id = p_event_id
       AND e.format = 'staged'
       AND e.status::TEXT IN ('bracket_generated', 'live')
       AND NOT COALESCE(e.draw_locked, FALSE)
       AND e.format_config -> 'stages' -> 0 ->> 'kind' = 'groups'
       AND e.format_config -> 'stages' -> 0 -> 'entrants' ->> 'from' = 'field'
       AND EXISTS (SELECT 1 FROM tournament_matches m WHERE m.event_id = e.id AND m.stage = 1)
       AND NOT EXISTS (SELECT 1 FROM tournament_matches m WHERE m.event_id = e.id AND m.stage > 1)
  );
$function$;

-- REVOKE ... FROM PUBLIC alone does NOT remove Supabase's default anon grant;
-- anon and authenticated have to be named. See 00126 and 00187.
REVOKE ALL ON FUNCTION public.staged_late_entry_open(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staged_late_entry_open(uuid) TO service_role;

COMMENT ON FUNCTION public.staged_late_entry_open(uuid) IS
  'True while a staged event whose first stage is drawn groups can take a late entry: bracket_generated or live, not draw locked, and no later stage drawn (00308). Service role only.';

-- ============================================================
-- add_participants_under_field_lock: 00199's body, the gate opened
-- ============================================================
CREATE OR REPLACE FUNCTION public.add_participants_under_field_lock(
  p_event_id uuid,
  p_admin_id uuid,
  p_entries  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament   uuid;
  v_status       text;
  v_locked       boolean;
  v_type         text;
  v_max          integer;
  v_doubles      boolean;
  v_t_status     text;
  v_suspended    timestamptz;
  v_suspend_why  text;
  v_cap          integer;
  v_count        integer;
  v_ids          uuid[];
  v_id           uuid;
  v_pairs        integer;
  v_unpaired     integer;
  v_singles      integer;
  v_before       integer;
  v_after        integer;
  v_entries      integer;
  v_rows         jsonb;
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'add_participants_under_field_lock: p_entries must be a json array';
  END IF;

  SELECT COUNT(*) INTO v_count FROM jsonb_array_elements(p_entries);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', TRUE, 'participants', '[]'::jsonb);
  END IF;

  -- Every entry must name a player and carry an elo. A null elo_before was the
  -- fabricated-400 case the bulk path already refuses above this call; it must
  -- not become writable by reaching this one directly.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_entries) e
     WHERE NULLIF(e->>'player_id', '') IS NULL
        OR NULLIF(e->>'elo_before', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'add_participants_under_field_lock: every entry needs player_id and elo_before';
  END IF;

  SELECT array_agg(DISTINCT (e->>'player_id')::uuid)
    INTO v_ids FROM jsonb_array_elements(p_entries) e;

  IF array_length(v_ids, 1) <> v_count THEN
    RAISE EXCEPTION 'add_participants_under_field_lock: p_entries names the same player twice';
  END IF;

  -- Which tournament, unlocked, purely to know which row to lock next.
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- Field lock, then parent, then event -- the one order the whole schema uses
  -- (00196's header explains why this direction and not merely a convention).
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT t.max_events_per_player, t.status::TEXT, t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), '')
    INTO v_cap, v_t_status, v_suspended, v_suspend_why
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  IF v_suspended IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_suspended',
                              'suspension_reason', v_suspend_why);
  END IF;
  IF v_t_status IN ('completed', 'archived') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_closed', 'status', v_t_status);
  END IF;

  SELECT e.status::TEXT, e.draw_locked, e.event_type::TEXT, e.max_participants
    INTO v_status, v_locked, v_type, v_max
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- The admin path's two statuses, not the player path's one: an exec adds a
  -- walk-up during check-in, which is the whole reason that door exists.
  -- 00308: a staged event whose first stage is drawn groups also takes a
  -- late entry, until any later stage is drawn (staged_late_entry_open).
  IF v_status NOT IN ('registration', 'checkin') AND NOT public.staged_late_entry_open(p_event_id) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status', 'status', v_status);
  END IF;
  IF COALESCE(v_locked, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_locked');
  END IF;

  v_doubles := v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');

  -- ALREADY HALF OF A PAIR -- the question with no constraint behind it, and
  -- the reason this function exists. Withdrawn and disqualified pairs do not
  -- count, consistently with 00196 and with every count below.
  SELECT pr.player1_id INTO v_id
    FROM tournament_pairs pr
   WHERE pr.event_id = p_event_id
     AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
     AND (pr.player1_id = ANY (v_ids) OR pr.player2_id = ANY (v_ids))
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_pair');
  END IF;

  -- ALREADY A PARTICIPANT. The unique constraint would catch this, but a
  -- refusal that names the reason beats a 23505 the caller has to interpret,
  -- and a withdrawn row must not read as a live entry.
  SELECT tp.player_id INTO v_id
    FROM tournament_participants tp
   WHERE tp.event_id = p_event_id
     AND tp.player_id = ANY (v_ids)
     AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered', 'player_id', v_id);
  END IF;

  -- ---- capacity, counted in DRAW SLOTS for doubles --------------------
  IF v_max IS NOT NULL AND v_max > 0 THEN
    IF v_doubles THEN
      SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

      v_before := v_pairs + CEIL(v_unpaired / 2.0);
      v_after  := v_pairs + CEIL((v_unpaired + v_count) / 2.0);

      IF v_after > v_max AND v_after > v_before THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
      END IF;
    ELSE
      SELECT COUNT(*) INTO v_singles FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      IF v_singles + v_count > v_max THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
      END IF;
    END IF;
  END IF;

  -- ---- the per-member cap, under the tournament lock ------------------
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    FOREACH v_id IN ARRAY v_ids LOOP
      SELECT (
        (SELECT COUNT(*) FROM tournament_participants tp
           JOIN tournament_events te ON te.id = tp.event_id
          WHERE te.tournament_id = v_tournament AND tp.player_id = v_id
            AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
        +
        (SELECT COUNT(*) FROM tournament_pairs pr
           JOIN tournament_events te ON te.id = pr.event_id
          WHERE te.tournament_id = v_tournament
            AND (pr.player1_id = v_id OR pr.player2_id = v_id)
            AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      ) INTO v_entries;

      IF v_entries >= v_cap THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_cap',
                                  'cap', v_cap, 'player_id', v_id);
      END IF;
    END LOOP;
  END IF;

  -- ---- the write, in one statement ------------------------------------
  BEGIN
    WITH ins AS (
      INSERT INTO tournament_participants (event_id, player_id, elo_before, added_by, status)
      SELECT p_event_id,
             (e->>'player_id')::uuid,
             (e->>'elo_before')::integer,
             p_admin_id,
             'registered'
        FROM jsonb_array_elements(p_entries) e
      RETURNING *
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) INTO v_rows FROM ins;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered');
  END;

  RETURN jsonb_build_object('ok', TRUE, 'participants', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.add_participants_under_field_lock(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_participants_under_field_lock(uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.add_participants_under_field_lock(uuid, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.add_participants_under_field_lock(uuid, uuid, jsonb) TO service_role;

-- ============================================================
-- pair_tournament_entrants: 00201's body, the gate opened
-- ============================================================
CREATE OR REPLACE FUNCTION public.pair_tournament_entrants(
  p_event_id uuid, p_player1_id uuid, p_player2_id uuid,
  p_pair_name text, p_combined_elo integer, p_added_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event       RECORD;
  v_tournament  uuid;
  v_t_status    text;
  v_suspended   timestamptz;
  v_suspend_why text;
  v_cap         integer;
  v_out_count   integer;
  v_pair_id     uuid;
  v_promoted    integer;
  v_pairs       integer;
  v_unpaired    integer;
  v_before      integer;
  v_after       integer;
  v_entries     integer;
  v_half        uuid;
BEGIN
  IF p_player1_id = p_player2_id THEN
    RAISE EXCEPTION 'A pair needs two different players.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The tournament id is needed to take the tournaments lock in the right
  -- order, and reading it costs nothing before any lock is held.
  SELECT e.tournament_id INTO v_tournament
    FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Everything below reads the event's field and then writes it. Serialise the
  -- whole operation on the event so two desks cannot both decide that neither
  -- player is spoken for. Released at commit, whether that is a COMMIT or a
  -- ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- THE TOURNAMENT ROW, LOCKED, because the per-member entry cap below is a
  -- cross-event count and the event key alone does not serialise two entries
  -- into two DIFFERENT events of the same tournament. Same order and same
  -- reason as add_participants_under_field_lock (00199).
  SELECT t.max_events_per_player, t.status::TEXT, t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), '')
    INTO v_cap, v_t_status, v_suspended, v_suspend_why
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  IF v_suspended IS NOT NULL THEN
    RAISE EXCEPTION 'This tournament is currently suspended%',
      COALESCE(': ' || v_suspend_why, '') USING ERRCODE = 'check_violation';
  END IF;
  IF v_t_status IN ('completed', 'archived') THEN
    RAISE EXCEPTION 'This tournament is closed.' USING ERRCODE = 'check_violation';
  END IF;

  -- FOR UPDATE added by 00201. The unlocked read was the other half of the
  -- "decided before the lock" defect: the status this function refuses on could
  -- move after it was read.
  SELECT id, event_type, status, draw_locked, max_participants
    INTO v_event
    FROM tournament_events
   WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- A pair only means anything in a doubles event. The application checks this
  -- too; it is repeated here because this function is the ONLY writer of a pair
  -- row and an invariant guarded in one place cannot be got wrong in another.
  -- All four, transcribed from isDoublesEvent() in packages/shared/src/utils/
  -- constants.ts. open_doubles is easy to miss and is a real event type.
  IF v_event.event_type NOT IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles') THEN
    RAISE EXCEPTION 'This is not a doubles event, so it has no pairs.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE EVENT STATUS, ASKED UNDER THE LOCK (00201). The caller asks this too,
  -- hundreds of milliseconds earlier; this is the ask that the insert actually
  -- lands against. The two statuses are the admin path's, not the player
  -- path's one: an exec adds a walk-up during check-in, which is the whole
  -- reason that door exists.
  -- 00308: a staged event whose first stage is drawn groups also takes a
  -- late entry, until any later stage is drawn (staged_late_entry_open).
  IF v_event.status NOT IN ('registration', 'checkin') AND NOT public.staged_late_entry_open(p_event_id) THEN
    RAISE EXCEPTION 'The draw for this event has already been generated, so pairs can no longer be added. Regenerate the draw if this team should be in it.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Already on a team in this event. Not covered by the unique index (see the
  -- header of 00102), and the one that actually matters: A in two pairs is A in
  -- the draw twice, and two of everyone's entry-cap slots spent on one person.
  --
  -- Entries that have LEFT the event are ignored, exactly as the entry cap
  -- ignores them (ENTRY_CAP_RELEASING_STATUSES in packages/shared): somebody
  -- whose team withdrew is free to be entered again.
  IF EXISTS (
    SELECT 1 FROM tournament_pairs
     WHERE event_id = p_event_id
       AND status NOT IN ('withdrawn', 'disqualified')
       AND (player1_id IN (p_player1_id, p_player2_id)
         OR player2_id IN (p_player1_id, p_player2_id))
  ) THEN
    RAISE EXCEPTION 'One of these players is already in a pair in this event.'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- A pool entrant who has WITHDRAWN is not raw material for a team. Deleting
  -- their row to make the pair would erase the withdrawal and put them back in
  -- the event without anybody deciding to.
  SELECT count(*) INTO v_out_count
    FROM tournament_participants
   WHERE event_id = p_event_id
     AND player_id IN (p_player1_id, p_player2_id)
     AND status IN ('withdrawn', 'disqualified');
  IF v_out_count > 0 THEN
    RAISE EXCEPTION 'One of these players has already withdrawn from this event. Remove their withdrawn entry from the waiting list first, then add them again.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- HOW MANY OF THE TWO ARE ALREADY IN THE POOL. A promotion (pairing up two
  -- people who each entered alone) is slot-neutral and cap-neutral by
  -- construction: their loose rows were already worth one prospective team and
  -- already spent one entry each. Counted here, under the lock, rather than
  -- taken from the caller.
  SELECT count(*) INTO v_promoted
    FROM tournament_participants
   WHERE event_id = p_event_id
     AND player_id IN (p_player1_id, p_player2_id)
     AND status NOT IN ('withdrawn', 'disqualified');

  -- ---- CAPACITY, RECOUNTED UNDER THE LOCK (00201) ---------------------
  -- Draw slots, not head count: two loose entrants are worth one prospective
  -- team. Expression transcribed from add_participants_under_field_lock (00199)
  -- so there is one definition of a doubles draw slot, not two.
  --
  -- The `v_after > v_before` conjunct is load-bearing and is 00199's: an
  -- operation that does not make an over-full event worse is not refused,
  -- which is what lets an exactly-full event still pair up.
  IF v_event.max_participants IS NOT NULL AND v_event.max_participants > 0 THEN
    SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
     WHERE event_id = p_event_id
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
    SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
     WHERE event_id = p_event_id
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

    v_before := v_pairs + CEIL(v_unpaired / 2.0);
    v_after  := (v_pairs + 1) + CEIL((v_unpaired - v_promoted) / 2.0);

    IF v_after > v_event.max_participants AND v_after > v_before THEN
      RAISE EXCEPTION 'Event is full.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ---- THE PER-MEMBER CAP, RECOUNTED UNDER BOTH LOCKS (00201) ---------
  -- Both halves, because a pair row spends one of each player's allowance and
  -- there is no half-entry to fall back to. The promotion is discounted for the
  -- same reason as above: this pair CONSUMES the loose row rather than adding
  -- to it, so without the subtraction, pairing two people who each entered
  -- alone at a one-event-cap tournament would be refused for being at a limit
  -- the operation does not move.
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    FOREACH v_half IN ARRAY ARRAY[p_player1_id, p_player2_id] LOOP
      SELECT (
        (SELECT COUNT(*) FROM tournament_participants tp
           JOIN tournament_events te ON te.id = tp.event_id
          WHERE te.tournament_id = v_tournament AND tp.player_id = v_half
            AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
        +
        (SELECT COUNT(*) FROM tournament_pairs pr
           JOIN tournament_events te ON te.id = pr.event_id
          WHERE te.tournament_id = v_tournament
            AND (pr.player1_id = v_half OR pr.player2_id = v_half)
            AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      ) INTO v_entries;

      -- The loose row in THIS event is about to become the pair row, so it is
      -- not a second entry.
      IF EXISTS (
        SELECT 1 FROM tournament_participants
         WHERE event_id = p_event_id AND player_id = v_half
           AND status NOT IN ('withdrawn', 'disqualified')
      ) THEN
        v_entries := v_entries - 1;
      END IF;

      IF v_entries >= v_cap THEN
        RAISE EXCEPTION 'That player is already entered in % event(s) at this tournament, which is the limit.', v_cap
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  -- THE PROMOTION. Matches two rows when both were loose in the pool, one when
  -- only one was, none when an exec is adding a pair of people who had not
  -- entered separately. All three are ordinary.
  --
  -- Deliberately BEFORE the insert: the unique index on
  -- (event_id, player1_id, player2_id) can still refuse the insert, and if it
  -- does the whole statement, this delete included, rolls back.
  DELETE FROM tournament_participants
   WHERE event_id = p_event_id
     AND player_id IN (p_player1_id, p_player2_id);

  -- 'registered', never 'checked_in', even when both halves had been checked in
  -- individually. Check-in is the gate that refuses an entrant with no current
  -- event-waiver acceptance, and it is asked of the thing that takes the court.
  -- A pair that inherited two check-ins would have passed that gate as two
  -- individuals and never as a team, and if the waiver text moved in between,
  -- it would be a checked-in team nobody has a current signature for.
  INSERT INTO tournament_pairs (
    event_id, player1_id, player2_id, pair_name, combined_elo, added_by, status
  ) VALUES (
    p_event_id, p_player1_id, p_player2_id, p_pair_name, p_combined_elo, p_added_by, 'registered'
  )
  RETURNING id INTO v_pair_id;

  RETURN v_pair_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid)       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid)       TO service_role;

-- ============================================================
-- add_external_tournament_pair: 00269's body, the gate opened
-- ============================================================
CREATE OR REPLACE FUNCTION public.add_external_tournament_pair(
  p_event_id uuid, p_external1_name text, p_external2_name text, p_added_by uuid,
  p_team_name text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event       RECORD;
  v_tournament  uuid;
  v_t_status    text;
  v_suspended   timestamptz;
  v_suspend_why text;
  v_name1       text;
  v_name2       text;
  v_team        text;
  v_pairs       integer;
  v_pair_id     uuid;
BEGIN
  v_name1 := btrim(regexp_replace(COALESCE(p_external1_name, ''), '\s+', ' ', 'g'));
  v_name2 := btrim(regexp_replace(COALESCE(p_external2_name, ''), '\s+', ' ', 'g'));
  IF char_length(v_name1) NOT BETWEEN 1 AND 60 OR char_length(v_name2) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Each player needs a name of 1 to 60 characters.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF lower(v_name1) = lower(v_name2) THEN
    RAISE EXCEPTION 'The two players need different names.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_team := NULLIF(btrim(regexp_replace(COALESCE(p_team_name, ''), '\s+', ' ', 'g')), '');
  IF v_team IS NOT NULL AND char_length(v_team) > 60 THEN
    RAISE EXCEPTION 'A team name can be at most 60 characters.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT e.tournament_id INTO v_tournament
    FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT t.status::TEXT, t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), '')
    INTO v_t_status, v_suspended, v_suspend_why
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  IF v_suspended IS NOT NULL THEN
    RAISE EXCEPTION 'This tournament is currently suspended%',
      COALESCE(': ' || v_suspend_why, '') USING ERRCODE = 'check_violation';
  END IF;
  IF v_t_status IN ('completed', 'archived') THEN
    RAISE EXCEPTION 'This tournament is closed.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, draw_locked, max_participants, external_event
    INTO v_event
    FROM tournament_events
   WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT v_event.external_event THEN
    RAISE EXCEPTION 'External teams can only be entered in an external event.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 00308: a staged event whose first stage is drawn groups also takes a
  -- late entry, until any later stage is drawn (staged_late_entry_open).
  IF v_event.status NOT IN ('registration', 'checkin') AND NOT public.staged_late_entry_open(p_event_id) THEN
    RAISE EXCEPTION 'The draw for this event has already been generated, so pairs can no longer be added. Regenerate the draw if this team should be in it.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- One person on one live team. A withdrawn team frees its names, as a
  -- withdrawn member pair frees its members.
  IF EXISTS (
    SELECT 1 FROM tournament_pairs
     WHERE event_id = p_event_id
       AND player1_id IS NULL
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
       AND (lower(external1_name) IN (lower(v_name1), lower(v_name2))
         OR lower(external2_name) IN (lower(v_name1), lower(v_name2)))
  ) THEN
    RAISE EXCEPTION 'One of these players is already in a team in this event.'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Two live teams under one name would be indistinguishable on every table.
  IF v_team IS NOT NULL AND EXISTS (
    SELECT 1 FROM tournament_pairs
     WHERE event_id = p_event_id
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
       AND lower(pair_name) = lower(v_team)
  ) THEN
    RAISE EXCEPTION '% is already a team in this event', v_team
      USING ERRCODE = 'unique_violation';
  END IF;

  -- An external event has no participant rows (the trigger above), so a draw slot
  -- is simply a live pair.
  IF v_event.max_participants IS NOT NULL AND v_event.max_participants > 0 THEN
    SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
     WHERE event_id = p_event_id
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
    IF v_pairs + 1 > v_event.max_participants THEN
      RAISE EXCEPTION 'Event is full.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO tournament_pairs (
    event_id, player1_id, player2_id, external1_name, external2_name,
    pair_name, combined_elo, added_by, status
  ) VALUES (
    p_event_id, NULL, NULL, v_name1, v_name2,
    COALESCE(v_team, v_name1 || ' / ' || v_name2), NULL, p_added_by, 'registered'
  )
  RETURNING id INTO v_pair_id;

  RETURN v_pair_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_external_tournament_pair(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_external_tournament_pair(uuid, text, text, uuid, text) TO service_role;

-- ---- POSTCONDITIONS ---------------------------------------------------------
DO $post$
BEGIN
  IF to_regprocedure('public.staged_late_entry_open(uuid)') IS NULL THEN
    RAISE EXCEPTION '00308: staged_late_entry_open is missing';
  END IF;
  IF has_function_privilege('anon', 'public.staged_late_entry_open(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.staged_late_entry_open(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00308: staged_late_entry_open is executable by a client role';
  END IF;
  IF position('staged_late_entry_open' IN pg_get_functiondef('public.add_participants_under_field_lock(uuid,uuid,jsonb)'::regprocedure)) = 0
     OR position('staged_late_entry_open' IN pg_get_functiondef('public.pair_tournament_entrants(uuid,uuid,uuid,text,integer,uuid)'::regprocedure)) = 0
     OR position('staged_late_entry_open' IN pg_get_functiondef('public.add_external_tournament_pair(uuid,text,text,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00308: an entry function does not ask staged_late_entry_open';
  END IF;
  IF has_function_privilege('anon', 'public.add_participants_under_field_lock(uuid,uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.add_participants_under_field_lock(uuid,uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pair_tournament_entrants(uuid,uuid,uuid,text,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pair_tournament_entrants(uuid,uuid,uuid,text,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.add_external_tournament_pair(uuid,text,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.add_external_tournament_pair(uuid,text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00308: an entry function is executable by a client role';
  END IF;
END
$post$;

COMMIT;
