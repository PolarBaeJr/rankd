-- ============================================================
-- 00307: A TOURNAMENT RUN FOR A CLUB EVENT IS ENTERED FROM THE CLUB EVENT
--
-- A club event linked to a tournament (00292) keeps the two lists in step both
-- ways: a club sign-up enters the tournament, and a tournament entry signs the
-- member up for the club event. The second half let a member skip the club
-- event entirely. Once the tournament was published, its own Register button
-- entered them, the link put them on the club event's list, and the fee
-- trigger charged them with no e-transfer screenshot, which the club event's
-- own sign-up now requires (owner, 2026-10-29). Checked on the staging copy
-- of Chaos Cards: 27 of 27 direct entries landed on the list owing the fee.
--
-- enter_tournament_event and join_event_waitlist, the only two paths a member
-- uses to enter, refuse an event a club event is linked to, with reason
-- 'club_event_linked' and the club event's id. The bodies are 00278's,
-- unchanged apart from that check.
--
-- Officers are untouched: the console enters through
-- add_participants_under_field_lock, and the club sign-up enters through the
-- link trigger, neither of which calls these.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.enter_tournament_event(
  p_event_id    UUID,
  p_player_id   UUID,
  p_elo_before  INTEGER,
  p_doubles     BOOLEAN,
  p_waiver_hash TEXT DEFAULT NULL,
  p_user_agent  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status        TEXT;
  v_max           INTEGER;
  v_tournament    UUID;
  v_cap           INTEGER;
  v_waiver_text   TEXT;
  v_pairs         INTEGER;
  v_unpaired      INTEGER;
  v_before        INTEGER;
  v_after         INTEGER;
  v_singles       INTEGER;
  v_entries       INTEGER;
  v_t_status      TEXT;
  v_suspended     TIMESTAMPTZ;
  v_suspend_why   TEXT;
  v_allowed       membership_type[];
  v_banned        BOOLEAN;
  v_membership    membership_type;
  v_in_pair       BOOLEAN;
  v_event_type    TEXT;
  v_category      TEXT;
  v_required      TEXT;
  v_season        UUID;
  v_exempt        BOOLEAN;
  v_paid          BOOLEAN;
  v_effective     membership_type;
  v_t_reg_opens   TIMESTAMPTZ;
  v_t_reg_closes  TIMESTAMPTZ;
  v_e_reg_opens   TIMESTAMPTZ;
  v_e_reg_closes  TIMESTAMPTZ;
  v_reg_opens     TIMESTAMPTZ;
  v_reg_closes    TIMESTAMPTZ;
  v_win           TEXT;
  v_waitlist      BOOLEAN;
  v_waiting       BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  IF p_elo_before IS NULL THEN
    RAISE EXCEPTION 'enter_tournament_event: p_elo_before may not be null';
  END IF;

  -- Which tournament, read WITHOUT a lock, purely to know which row to lock.
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- 00307: AN EVENT LINKED TO A CLUB EVENT IS ENTERED THROUGH THE CLUB EVENT.
  -- The link copies any entry back as a club sign-up (00292), which charges the
  -- event fee with no screenshot and skips the club event's own list.
  IF EXISTS (SELECT 1 FROM club_events ce WHERE ce.tournament_event_id = p_event_id) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'club_event_linked',
      'club_event_id', (SELECT ce.id FROM club_events ce WHERE ce.tournament_event_id = p_event_id LIMIT 1));
  END IF;

  -- THE FIELD LOCK, FIRST. Everything that changes who is in this event holds
  -- it: pairing, unpairing, swapping a partner, tearing a draw down. An entry
  -- changes who is in the event too, and until now it was the one operation
  -- that did so without asking. Taken before the row locks so the whole schema
  -- acquires these in one order; see the header for why that is the safe
  -- direction and not merely a convention.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- PARENT FIRST. This is the lock the per-member cap needs, because the cap is
  -- a tournament property counted across events; a lock on one event row does
  -- not exclude an entry into a sibling event. Taking it before the event row
  -- also fixes the acquisition order for every caller, so two entries can queue
  -- but never deadlock.
  --
  -- The eligibility columns come off the SAME locked row (00196). They are not
  -- an extra cost and they are not advisory copies of what the caller read:
  -- they are the values as of a state no concurrent exec action can move.
  SELECT t.max_events_per_player,
         NULLIF(BTRIM(COALESCE(t.waiver_text, '')), ''),
         t.status::TEXT,
         t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), ''),
         t.allowed_memberships,
         t.season_id,
         t.registration_opens_at,
         t.registration_closes_at
    INTO v_cap, v_waiver_text, v_t_status, v_suspended, v_suspend_why, v_allowed, v_season,
         v_t_reg_opens, v_t_reg_closes
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  -- Suspension before status, in that order, because it is the more specific
  -- and more actionable answer and it is what the player app says first.
  IF v_suspended IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_suspended',
                              'suspension_reason', v_suspend_why);
  END IF;

  -- The same two statuses refuseClosedTournament refuses. 'draft' is
  -- deliberately NOT one of them: an unpublished tournament is not a closed
  -- one, and the app has always allowed it.
  IF v_t_status IN ('completed', 'archived') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_closed', 'status', v_t_status);
  END IF;

  -- THE MEMBER'S OWN FACTS, NOW UNDER A LOCK (00200). This read used to be
  -- unlocked and the header explained why that was tolerable: a ban or a
  -- membership change landing in the window is a change an exec makes and can
  -- see. That argument never covered competition_category, which is read below
  -- and decides whether this entry is legal at all, so the row is now held
  -- FOR SHARE until this transaction commits. An exec's updatePlayer queues
  -- behind the entry rather than racing it.
  --
  -- FOR SHARE, not FOR UPDATE: several members entering different events at
  -- once must not serialise on each other, and share locks do not conflict
  -- with each other. It is UPDATE that has to wait, and FOR SHARE is enough
  -- to make it.
  --
  -- Position matters: see the header. players is read after tournaments
  -- because merge_players takes them in that order, and reversing it here
  -- would close a cycle.
  --
  -- v_exempt (00260) is isFeeExempt: an exec or a fee-exempt member always
  -- enters as internal, off the same locked row.
  SELECT p.is_banned, p.membership_type, p.competition_category::TEXT,
         (COALESCE(p.is_exec, FALSE) OR COALESCE(p.fee_exempt, FALSE))
    INTO v_banned, v_membership, v_category, v_exempt
    FROM players p WHERE p.id = p_player_id FOR SHARE;

  IF v_banned IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'player_not_found');
  END IF;
  IF v_banned THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'player_suspended');
  END IF;

  -- screenMembershipEntry, in plpgsql (00260). A null or empty array is
  -- "open to everyone", which is the shape a tournament that never set the
  -- field has, and it skips the dues read entirely.
  --
  -- Otherwise the group this member ENTERS as is derived, not read: internal
  -- means this season's club fee is paid (or the member is exempt). The
  -- season is the tournament's own, else the active one; with neither there
  -- is nothing to have paid for and the stored group stands.
  IF v_allowed IS NOT NULL AND array_length(v_allowed, 1) > 0 THEN
    IF v_season IS NULL THEN
      SELECT s.id INTO v_season FROM seasons s WHERE s.active_flag = TRUE LIMIT 1;
    END IF;

    -- Unlocked on purpose; see the header for the residual race it leaves.
    -- A waived row counts, because paid_at is set on it.
    v_paid := v_season IS NOT NULL AND EXISTS (
      SELECT 1 FROM club_fees f
       WHERE f.fee_type = 'dues'
         AND f.player_id = p_player_id
         AND f.season_id = v_season
         AND f.paid_at IS NOT NULL
    );

    v_effective := entry_membership_rule(v_membership, v_exempt, v_paid, v_season IS NOT NULL);

    IF NOT (v_effective = ANY (v_allowed)) THEN
      -- The one refusal paying would fix, so the app can say so.
      IF 'internal' = ANY (v_allowed) AND v_season IS NOT NULL
         AND NOT v_paid AND NOT v_exempt THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'membership_unpaid',
                                  'allowed', to_jsonb(v_allowed));
      END IF;
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'membership_not_allowed',
                                'allowed', to_jsonb(v_allowed));
    END IF;
  END IF;

  -- The waiver gate, checked before anything is written. Presence only: see
  -- 00193's header for why the hash is not recomputed here.
  IF v_waiver_text IS NOT NULL AND NULLIF(BTRIM(COALESCE(p_waiver_hash, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waiver_required');
  END IF;

  -- The event row is still locked, and still for the same reason: capacity and
  -- the duplicate check must see a state no other entry can move. event_type
  -- joins the read in 00200: the category gate below is about what THIS event
  -- requires, so it has to come off the locked row rather than from an argument
  -- the caller chose.
  SELECT e.status::TEXT, e.max_participants, e.event_type::TEXT, e.registration_opens_at, e.registration_closes_at,
         e.waitlist_enabled
    INTO v_status, v_max, v_event_type, v_e_reg_opens, v_e_reg_closes, v_waitlist
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_closed', 'status', v_status);
  END IF;

  -- 00276: THE REGISTRATION WINDOW, a gate on top of the status above and
  -- never a replacement for it. Each bound is the event's own when set, else
  -- the tournament's, both read off the rows this function already holds.
  -- Only the member's own entry passes through here: an exec adding somebody
  -- goes through add_participants_under_field_lock, which has no window.
  v_reg_opens  := COALESCE(v_e_reg_opens, v_t_reg_opens);
  v_reg_closes := COALESCE(v_e_reg_closes, v_t_reg_closes);
  v_win := entry_window_state(v_reg_opens, v_reg_closes, now());
  IF v_win = 'not_open_yet' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_not_open', 'opens_at', v_reg_opens);
  END IF;
  IF v_win = 'closed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_window_closed', 'closes_at', v_reg_closes);
  END IF;

  -- ---- the competition category, re-asked under the lock (00200) -------
  --
  -- categoryRequiredBy, in plpgsql. The open events return NULL and reach
  -- none of this, which is the property that keeps an undeclared member
  -- playing the club's tournaments.
  v_required := CASE v_event_type
                  WHEN 'mens_singles'   THEN 'mens'
                  WHEN 'mens_doubles'   THEN 'mens'
                  WHEN 'womens_singles' THEN 'womens'
                  WHEN 'womens_doubles' THEN 'womens'
                  WHEN 'mixed_doubles'  THEN 'mixed'
                  ELSE NULL
                END;

  IF v_required IS NOT NULL THEN
    -- screenSelfEntry, in plpgsql, and stricter than the console on purpose:
    -- an undeclared member is refused as well as a mismatched one. Every
    -- member is undeclared the day 00111 applies, so a rule that admitted them
    -- would enforce nothing at all on the day it shipped.
    IF v_category IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'category_undeclared',
                                'event_type', v_event_type);
    END IF;
    -- Mixed takes either declared category: the pair rule does the rest.
    IF v_required <> 'mixed' AND v_category <> v_required THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'category_mismatch',
                                'event_type', v_event_type);
    END IF;
  END IF;

  -- ALREADY HALF OF A PAIR. There is no unique constraint that catches this:
  -- the pair lives in a different table from the participant row, so the insert
  -- below succeeds and the member is in the event twice. This is the question
  -- the advisory lock above exists to make answerable: add_tournament_pair
  -- holds the same lock while it decides that neither player is spoken for, so
  -- the two orderings are the only two possible.
  --
  -- Withdrawn and disqualified pairs do not count, consistently with every
  -- other count in this function. The player app's own check is broader (it
  -- refuses on ANY pair row) and still fires first; that difference is its
  -- product decision to keep or change, not something this fence should
  -- silently adopt.
  SELECT EXISTS (
    SELECT 1 FROM tournament_pairs pr
     WHERE pr.event_id = p_event_id
       AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
       AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
  ) INTO v_in_pair;
  IF v_in_pair THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_pair');
  END IF;

  -- 00278: NOBODY JUMPS THE QUEUE. While anybody is waiting for this event,
  -- a free place is theirs, not the next member's to take by entering: the
  -- promoter hands it out in joined order. Waiting rows exist only while the
  -- waitlist is on, because it cannot be switched off with anybody in it.
  SELECT EXISTS (
    SELECT 1 FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting'
  ) INTO v_waiting;
  IF v_waiting THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waitlist_queue');
  END IF;

  -- ---- capacity -------------------------------------------------------
  IF v_max IS NOT NULL AND v_max > 0 THEN
    IF p_doubles THEN
      SELECT COUNT(*) INTO v_pairs
        FROM tournament_pairs
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      SELECT COUNT(*) INTO v_unpaired
        FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

      v_before := v_pairs + CEIL(v_unpaired / 2.0);
      v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);

      IF v_after > v_max AND v_after > v_before THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full', 'waitlist', COALESCE(v_waitlist, FALSE));
      END IF;
    ELSE
      SELECT COUNT(*) INTO v_singles
        FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      IF v_singles >= v_max THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full', 'waitlist', COALESCE(v_waitlist, FALSE));
      END IF;
    END IF;
  END IF;

  -- ---- per-member entry cap (00098), now under the tournament lock -----
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    SELECT (
      (SELECT COUNT(*) FROM tournament_participants tp
         JOIN tournament_events te ON te.id = tp.event_id
        WHERE te.tournament_id = v_tournament AND tp.player_id = p_player_id
          AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      +
      (SELECT COUNT(*) FROM tournament_pairs pr
         JOIN tournament_events te ON te.id = pr.event_id
        WHERE te.tournament_id = v_tournament
          AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
          AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
    ) INTO v_entries;

    IF v_entries >= v_cap THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_cap', 'cap', v_cap);
    END IF;
  END IF;

  -- ---- the write ------------------------------------------------------
  BEGIN
    INSERT INTO tournament_participants (event_id, player_id, elo_before, status)
    VALUES (p_event_id, p_player_id, p_elo_before, 'registered');
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered');
  END;

  -- ---- the evidence, in the same transaction --------------------------
  -- Idempotent on the natural key, so a retry of a partly-failed entry does not
  -- fail on the acceptance row. Nothing here is best-effort any more: if this
  -- raises, the participant row goes with it.
  IF v_waiver_text IS NOT NULL THEN
    INSERT INTO event_waiver_acceptances (player_id, tournament_id, waiver_hash, user_agent)
    VALUES (p_player_id, v_tournament, p_waiver_hash, p_user_agent)
    ON CONFLICT (player_id, tournament_id, waiver_hash) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.enter_tournament_event(uuid, uuid, integer, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enter_tournament_event(uuid, uuid, integer, boolean, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.join_event_waitlist(
  p_event_id    UUID,
  p_player_id   UUID,
  p_doubles     BOOLEAN,
  p_waiver_hash TEXT DEFAULT NULL,
  p_user_agent  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status        TEXT;
  v_max           INTEGER;
  v_tournament    UUID;
  v_cap           INTEGER;
  v_waiver_text   TEXT;
  v_pairs         INTEGER;
  v_unpaired      INTEGER;
  v_before        INTEGER;
  v_after         INTEGER;
  v_singles       INTEGER;
  v_entries       INTEGER;
  v_t_status      TEXT;
  v_suspended     TIMESTAMPTZ;
  v_suspend_why   TEXT;
  v_allowed       membership_type[];
  v_banned        BOOLEAN;
  v_membership    membership_type;
  v_in_pair       BOOLEAN;
  v_event_type    TEXT;
  v_category      TEXT;
  v_required      TEXT;
  v_season        UUID;
  v_exempt        BOOLEAN;
  v_paid          BOOLEAN;
  v_effective     membership_type;
  v_t_reg_opens   TIMESTAMPTZ;
  v_t_reg_closes  TIMESTAMPTZ;
  v_e_reg_opens   TIMESTAMPTZ;
  v_e_reg_closes  TIMESTAMPTZ;
  v_reg_opens     TIMESTAMPTZ;
  v_reg_closes    TIMESTAMPTZ;
  v_win           TEXT;
  v_enabled       BOOLEAN;
  v_auto          BOOLEAN;
  v_external      BOOLEAN;
  v_entry_status  TEXT;
  v_room          BOOLEAN;
  v_id            UUID;
  v_joined        TIMESTAMPTZ;
  v_fill          JSONB;
  v_position      INTEGER;
  v_still         BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  -- Which tournament, read WITHOUT a lock, purely to know which row to lock.
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- 00307: AN EVENT LINKED TO A CLUB EVENT IS ENTERED THROUGH THE CLUB EVENT.
  -- The link copies any entry back as a club sign-up (00292), which charges the
  -- event fee with no screenshot and skips the club event's own list.
  IF EXISTS (SELECT 1 FROM club_events ce WHERE ce.tournament_event_id = p_event_id) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'club_event_linked',
      'club_event_id', (SELECT ce.id FROM club_events ce WHERE ce.tournament_event_id = p_event_id LIMIT 1));
  END IF;

  -- THE FIELD LOCK, FIRST. Everything that changes who is in this event holds
  -- it: pairing, unpairing, swapping a partner, tearing a draw down. An entry
  -- changes who is in the event too, and until now it was the one operation
  -- that did so without asking. Taken before the row locks so the whole schema
  -- acquires these in one order; see the header for why that is the safe
  -- direction and not merely a convention.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- PARENT FIRST. This is the lock the per-member cap needs, because the cap is
  -- a tournament property counted across events; a lock on one event row does
  -- not exclude an entry into a sibling event. Taking it before the event row
  -- also fixes the acquisition order for every caller, so two entries can queue
  -- but never deadlock.
  --
  -- The eligibility columns come off the SAME locked row (00196). They are not
  -- an extra cost and they are not advisory copies of what the caller read:
  -- they are the values as of a state no concurrent exec action can move.
  SELECT t.max_events_per_player,
         NULLIF(BTRIM(COALESCE(t.waiver_text, '')), ''),
         t.status::TEXT,
         t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), ''),
         t.allowed_memberships,
         t.season_id,
         t.registration_opens_at,
         t.registration_closes_at
    INTO v_cap, v_waiver_text, v_t_status, v_suspended, v_suspend_why, v_allowed, v_season,
         v_t_reg_opens, v_t_reg_closes
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  -- Suspension before status, in that order, because it is the more specific
  -- and more actionable answer and it is what the player app says first.
  IF v_suspended IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_suspended',
                              'suspension_reason', v_suspend_why);
  END IF;

  -- The same two statuses refuseClosedTournament refuses. 'draft' is
  -- deliberately NOT one of them: an unpublished tournament is not a closed
  -- one, and the app has always allowed it.
  IF v_t_status IN ('completed', 'archived') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_closed', 'status', v_t_status);
  END IF;

  -- THE MEMBER'S OWN FACTS, NOW UNDER A LOCK (00200). This read used to be
  -- unlocked and the header explained why that was tolerable: a ban or a
  -- membership change landing in the window is a change an exec makes and can
  -- see. That argument never covered competition_category, which is read below
  -- and decides whether this entry is legal at all, so the row is now held
  -- FOR SHARE until this transaction commits. An exec's updatePlayer queues
  -- behind the entry rather than racing it.
  --
  -- FOR SHARE, not FOR UPDATE: several members entering different events at
  -- once must not serialise on each other, and share locks do not conflict
  -- with each other. It is UPDATE that has to wait, and FOR SHARE is enough
  -- to make it.
  --
  -- Position matters: see the header. players is read after tournaments
  -- because merge_players takes them in that order, and reversing it here
  -- would close a cycle.
  --
  -- v_exempt (00260) is isFeeExempt: an exec or a fee-exempt member always
  -- enters as internal, off the same locked row.
  SELECT p.is_banned, p.membership_type, p.competition_category::TEXT,
         (COALESCE(p.is_exec, FALSE) OR COALESCE(p.fee_exempt, FALSE))
    INTO v_banned, v_membership, v_category, v_exempt
    FROM players p WHERE p.id = p_player_id FOR SHARE;

  IF v_banned IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'player_not_found');
  END IF;
  IF v_banned THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'player_suspended');
  END IF;

  -- screenMembershipEntry, in plpgsql (00260). A null or empty array is
  -- "open to everyone", which is the shape a tournament that never set the
  -- field has, and it skips the dues read entirely.
  --
  -- Otherwise the group this member ENTERS as is derived, not read: internal
  -- means this season's club fee is paid (or the member is exempt). The
  -- season is the tournament's own, else the active one; with neither there
  -- is nothing to have paid for and the stored group stands.
  IF v_allowed IS NOT NULL AND array_length(v_allowed, 1) > 0 THEN
    IF v_season IS NULL THEN
      SELECT s.id INTO v_season FROM seasons s WHERE s.active_flag = TRUE LIMIT 1;
    END IF;

    -- Unlocked on purpose; see the header for the residual race it leaves.
    -- A waived row counts, because paid_at is set on it.
    v_paid := v_season IS NOT NULL AND EXISTS (
      SELECT 1 FROM club_fees f
       WHERE f.fee_type = 'dues'
         AND f.player_id = p_player_id
         AND f.season_id = v_season
         AND f.paid_at IS NOT NULL
    );

    v_effective := entry_membership_rule(v_membership, v_exempt, v_paid, v_season IS NOT NULL);

    IF NOT (v_effective = ANY (v_allowed)) THEN
      -- The one refusal paying would fix, so the app can say so.
      IF 'internal' = ANY (v_allowed) AND v_season IS NOT NULL
         AND NOT v_paid AND NOT v_exempt THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'membership_unpaid',
                                  'allowed', to_jsonb(v_allowed));
      END IF;
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'membership_not_allowed',
                                'allowed', to_jsonb(v_allowed));
    END IF;
  END IF;

  -- The waiver gate, checked before anything is written. Presence only: see
  -- 00193's header for why the hash is not recomputed here.
  IF v_waiver_text IS NOT NULL AND NULLIF(BTRIM(COALESCE(p_waiver_hash, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waiver_required');
  END IF;

  -- The event row is still locked, and still for the same reason: capacity and
  -- the duplicate check must see a state no other entry can move. event_type
  -- joins the read in 00200: the category gate below is about what THIS event
  -- requires, so it has to come off the locked row rather than from an argument
  -- the caller chose.
  SELECT e.status::TEXT, e.max_participants, e.event_type::TEXT, e.registration_opens_at, e.registration_closes_at,
         e.waitlist_enabled, e.waitlist_auto_promote, e.external_event
    INTO v_status, v_max, v_event_type, v_e_reg_opens, v_e_reg_closes, v_enabled, v_auto, v_external
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_closed', 'status', v_status);
  END IF;

  -- 00276: THE REGISTRATION WINDOW, a gate on top of the status above and
  -- never a replacement for it. Each bound is the event's own when set, else
  -- the tournament's, both read off the rows this function already holds.
  -- Only the member's own entry passes through here: an exec adding somebody
  -- goes through add_participants_under_field_lock, which has no window.
  v_reg_opens  := COALESCE(v_e_reg_opens, v_t_reg_opens);
  v_reg_closes := COALESCE(v_e_reg_closes, v_t_reg_closes);
  v_win := entry_window_state(v_reg_opens, v_reg_closes, now());
  IF v_win = 'not_open_yet' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_not_open', 'opens_at', v_reg_opens);
  END IF;
  IF v_win = 'closed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_window_closed', 'closes_at', v_reg_closes);
  END IF;

  -- ---- the competition category, re-asked under the lock (00200) -------
  --
  -- categoryRequiredBy, in plpgsql. The open events return NULL and reach
  -- none of this, which is the property that keeps an undeclared member
  -- playing the club's tournaments.
  v_required := CASE v_event_type
                  WHEN 'mens_singles'   THEN 'mens'
                  WHEN 'mens_doubles'   THEN 'mens'
                  WHEN 'womens_singles' THEN 'womens'
                  WHEN 'womens_doubles' THEN 'womens'
                  WHEN 'mixed_doubles'  THEN 'mixed'
                  ELSE NULL
                END;

  IF v_required IS NOT NULL THEN
    -- screenSelfEntry, in plpgsql, and stricter than the console on purpose:
    -- an undeclared member is refused as well as a mismatched one. Every
    -- member is undeclared the day 00111 applies, so a rule that admitted them
    -- would enforce nothing at all on the day it shipped.
    IF v_category IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'category_undeclared',
                                'event_type', v_event_type);
    END IF;
    -- Mixed takes either declared category: the pair rule does the rest.
    IF v_required <> 'mixed' AND v_category <> v_required THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'category_mismatch',
                                'event_type', v_event_type);
    END IF;
  END IF;

  -- ALREADY HALF OF A PAIR. There is no unique constraint that catches this:
  -- the pair lives in a different table from the participant row, so the insert
  -- below succeeds and the member is in the event twice. This is the question
  -- the advisory lock above exists to make answerable: add_tournament_pair
  -- holds the same lock while it decides that neither player is spoken for, so
  -- the two orderings are the only two possible.
  --
  -- Withdrawn and disqualified pairs do not count, consistently with every
  -- other count in this function. The player app's own check is broader (it
  -- refuses on ANY pair row) and still fires first; that difference is its
  -- product decision to keep or change, not something this fence should
  -- silently adopt.
  SELECT EXISTS (
    SELECT 1 FROM tournament_pairs pr
     WHERE pr.event_id = p_event_id
       AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
       AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
  ) INTO v_in_pair;
  IF v_in_pair THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_pair');
  END IF;

  -- ---- the waitlist's own questions ------------------------------------
  IF NOT COALESCE(v_enabled, FALSE) OR COALESCE(v_external, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waitlist_disabled');
  END IF;

  -- Any row, withdrawn included, as the promoter would refuse it.
  SELECT tp.status::TEXT INTO v_entry_status
    FROM tournament_participants tp
   WHERE tp.event_id = p_event_id AND tp.player_id = p_player_id;
  IF v_entry_status IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered', 'entry_status', v_entry_status);
  END IF;

  IF EXISTS (
    SELECT 1 FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.player_id = p_player_id AND w.status = 'waiting'
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_waiting');
  END IF;

  -- In auto mode a waitlist with room and nobody in it is a queue for nothing:
  -- the member should simply enter. In manual mode the desk decides who goes
  -- in, so joining is allowed whenever the waitlist is on.
  IF COALESCE(v_auto, TRUE) AND NOT EXISTS (
    SELECT 1 FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting'
  ) THEN
    v_room := TRUE;
    IF v_max IS NOT NULL AND v_max > 0 THEN
      IF p_doubles THEN
        SELECT COUNT(*) INTO v_pairs
          FROM tournament_pairs
         WHERE event_id = p_event_id
           AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
        SELECT COUNT(*) INTO v_unpaired
          FROM tournament_participants
         WHERE event_id = p_event_id
           AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

        v_before := v_pairs + CEIL(v_unpaired / 2.0);
        v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);

        IF v_after > v_max AND v_after > v_before THEN
          v_room := FALSE;
        END IF;
      ELSE
        SELECT COUNT(*) INTO v_singles
          FROM tournament_participants
         WHERE event_id = p_event_id
           AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
        IF v_singles >= v_max THEN
          v_room := FALSE;
        END IF;
      END IF;
    END IF;
    IF v_room THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_has_room');
    END IF;
  END IF;

  -- ---- per-member entry cap, under the tournament lock -----------------
  -- A member already at the cap could never be promoted, so they are told now
  -- rather than when a place frees up.
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    SELECT (
      (SELECT COUNT(*) FROM tournament_participants tp
         JOIN tournament_events te ON te.id = tp.event_id
        WHERE te.tournament_id = v_tournament AND tp.player_id = p_player_id
          AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      +
      (SELECT COUNT(*) FROM tournament_pairs pr
         JOIN tournament_events te ON te.id = pr.event_id
        WHERE te.tournament_id = v_tournament
          AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
          AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
    ) INTO v_entries;

    IF v_entries >= v_cap THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_cap', 'cap', v_cap);
    END IF;
  END IF;

  -- ---- the write ------------------------------------------------------
  BEGIN
    INSERT INTO tournament_event_waitlist (event_id, player_id, status)
    VALUES (p_event_id, p_player_id, 'waiting')
    RETURNING id, joined_at INTO v_id, v_joined;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_waiting');
  END;

  -- The waiver evidence travels with the join, as it does with an entry, so a
  -- promotion later never lands a member who was not asked.
  IF v_waiver_text IS NOT NULL THEN
    INSERT INTO event_waiver_acceptances (player_id, tournament_id, waiver_hash, user_agent)
    VALUES (p_player_id, v_tournament, p_waiver_hash, p_user_agent)
    ON CONFLICT (player_id, tournament_id, waiver_hash) DO NOTHING;
  END IF;

  -- A self-heal in auto mode: if a place is free while others wait (a fill
  -- that was missed), this hands it out now, in queue order.
  IF COALESCE(v_auto, TRUE) THEN
    v_fill := fill_event_from_waitlist(p_event_id, NULL, NULL);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM tournament_event_waitlist w WHERE w.id = v_id AND w.status = 'waiting'
  ) INTO v_still;
  IF v_still THEN
    SELECT COUNT(*) INTO v_position
      FROM tournament_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting'
       AND (w.joined_at, w.id) <= (v_joined, v_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'waitlist_id', v_id,
    'position', v_position,
    'promoted', COALESCE(v_fill->'promoted', '[]'::jsonb),
    'tournament_id', v_tournament
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.join_event_waitlist(uuid, uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_event_waitlist(uuid, uuid, boolean, text, text) TO service_role;

-- ---- POSTCONDITIONS ---------------------------------------------------------
DO $post$
BEGIN
  IF position('club_event_linked' IN pg_get_functiondef('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)'::regprocedure)) = 0
     OR position('club_event_linked' IN pg_get_functiondef('public.join_event_waitlist(uuid,uuid,boolean,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00307: the club event check is missing';
  END IF;
  IF has_function_privilege('anon', 'public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.join_event_waitlist(uuid,uuid,boolean,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.join_event_waitlist(uuid,uuid,boolean,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00307: a member entry function is executable by a client role';
  END IF;
END
$post$;

COMMIT;
