-- ============================================================
-- 00292: A CLUB EVENT RUNS AS A TOURNAMENT
--
-- A club event (Chaos Cards, a social with a bracket) had no draw, no scores
-- and no check-in: those all live on a tournament event. The owner asked for a
-- club event that needs them to get "the same thing in tournament, linked and
-- connected", and for every later tournament feature to work there too.
--
-- So nothing is copied. An exec links the club event to ONE tournament event,
-- made for it here, and from then on the tournament pages run it: draw,
-- pairing, check-in, scores, standings, whatever is added to tournaments
-- later. The two lists of people are kept the same both ways:
--
--   CLUB TO TOURNAMENT (immediate, club_event_signups triggers)
--     * A sign-up becomes a loose entry in the tournament event (a solo entry
--       in a doubles event, for the exec to pair, exactly as a member entering
--       alone is). A withdrawn entry is put back to registered.
--     * A withdrawal ("Not me", the member leaving, an exec removing them)
--       withdraws the entry. In a pair before the draw, the pair is split with
--       unpair_tournament_pair and the partner stays in as a loose entry;
--       after the draw (or a locked draw), the pair is withdrawn.
--
--   TOURNAMENT TO CLUB (at COMMIT, deferred constraint triggers)
--     * Whoever is in the tournament event (an active loose entry or an
--       active pair) is signed up to the club event, and whoever is not is
--       not. The club's own triggers bill and refund (club_event_signup_fee,
--       club_event_withdraw_fee), so the fee is the club event's, once.
--     * Deferred to commit because pairing DELETES the two loose entries and
--       INSERTS the pair: checked row by row, the two people would look gone
--       for a moment and lose their sign-up and their fee.
--     * A change that STARTED on the club side is not echoed back
--       (club_event_link.origin): a member leaving a withdrawn pair must not
--       also take their partner's sign-up with them.
--
-- NON-MEMBERS. A tournament entry is a player, and a non-member a Google Form
-- signed up (club_event_external_signups, 00284) had none. Once the event runs
-- as a tournament, each one gets a GUEST player record: no login, recreational,
-- external, players.is_guest. Their named event fee moves onto it and they
-- become an ordinary sign-up, so they are entered. A guest gets nothing from
-- the app (no in-app notice, no email, no waiver invite: the Form carried the
-- waiver) and owes no season dues. When they sign in with that email the record
-- becomes theirs (claim_player_row, 00132) and stops being a guest.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.reject_registration_import_entry(uuid, uuid)') IS NULL
     OR position('club_event_signups' IN pg_get_functiondef('public.reject_registration_import_entry(uuid, uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00292 needs 00291 (a form signs a member up) applied first';
  END IF;
  IF to_regprocedure('public.unpair_tournament_pair(uuid, uuid, text, uuid)') IS NULL THEN
    RAISE EXCEPTION '00292 needs unpair_tournament_pair(uuid, uuid, text, uuid)';
  END IF;
END
$pre$;

-- ---- 1. The link ---------------------------------------------------------

ALTER TABLE public.club_events
  ADD COLUMN IF NOT EXISTS tournament_event_id uuid
    REFERENCES public.tournament_events(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS club_events_tournament_event_id_key
  ON public.club_events (tournament_event_id)
  WHERE tournament_event_id IS NOT NULL;

COMMENT ON COLUMN public.club_events.tournament_event_id IS
  'The tournament event that runs this club event (00292). Sign-ups and entries are kept the same both ways.';

-- ---- 2. One test of "in the event" -----------------------------------------

-- Withdrawn and disqualified entries have left; a no-show was still signed up.
CREATE OR REPLACE FUNCTION public.club_event_link_in_event(p_tournament_event_id uuid, p_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1 FROM tournament_participants tp
            WHERE tp.event_id = p_tournament_event_id AND tp.player_id = p_player_id
              AND tp.status NOT IN ('withdrawn', 'disqualified'))
      OR EXISTS (
           SELECT 1 FROM tournament_pairs pr
            WHERE pr.event_id = p_tournament_event_id
              AND p_player_id IN (pr.player1_id, pr.player2_id)
              AND pr.status NOT IN ('withdrawn', 'disqualified'));
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_in_event(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Makes the club sign-up match the tournament entry. Inserting or deleting the
-- sign-up fires the club's fee triggers, which is the point.
CREATE OR REPLACE FUNCTION public.club_event_link_reconcile(p_club_event_id uuid, p_tournament_event_id uuid, p_player_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_in_tournament boolean := club_event_link_in_event(p_tournament_event_id, p_player_id);
  v_in_club boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM club_event_signups s
                  WHERE s.event_id = p_club_event_id AND s.player_id = p_player_id)
    INTO v_in_club;
  IF v_in_tournament AND NOT v_in_club THEN
    INSERT INTO club_event_signups (event_id, player_id)
    VALUES (p_club_event_id, p_player_id)
    ON CONFLICT DO NOTHING;
  ELSIF v_in_club AND NOT v_in_tournament THEN
    DELETE FROM club_event_signups s
     WHERE s.event_id = p_club_event_id AND s.player_id = p_player_id;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_reconcile(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---- 3. Linking -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.link_club_event_tournament(
  p_club_event_id uuid,
  p_actor_id uuid,
  p_event_type text,
  p_format text,
  p_rated boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club club_events%ROWTYPE;
  v_season uuid;
  v_seasons integer;
  v_tournament uuid;
  v_event uuid;
  v_doubles boolean := p_event_type LIKE '%doubles';
  v_entered integer;
BEGIN
  IF p_format NOT IN ('single_elimination', 'round_robin', 'pool_to_bracket') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_format');
  END IF;

  SELECT * INTO v_club FROM club_events ce WHERE ce.id = p_club_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_club.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cancelled');
  END IF;
  IF v_club.tournament_event_id IS NOT NULL THEN
    SELECT te.tournament_id INTO v_tournament FROM tournament_events te WHERE te.id = v_club.tournament_event_id;
    RETURN jsonb_build_object('ok', true, 'already', true,
                              'tournament_id', v_tournament, 'event_id', v_club.tournament_event_id);
  END IF;

  -- The active season, as a tournament made in the console takes. Two active
  -- seasons is refused rather than guessed.
  SELECT count(*), min(s.id::text)::uuid INTO v_seasons, v_season FROM seasons s WHERE s.active_flag;
  IF v_seasons <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_active_season');
  END IF;

  INSERT INTO tournaments (name, start_date, end_date, status, season_id, created_by,
                           placement_bonus_enabled)
  VALUES (v_club.title,
          (v_club.starts_at AT TIME ZONE 'America/Vancouver')::date,
          (v_club.ends_at AT TIME ZONE 'America/Vancouver')::date,
          'draft', v_season, p_actor_id, false)
  RETURNING id INTO v_tournament;

  INSERT INTO tournament_events (tournament_id, event_type, format, rated, placement_bonus_enabled)
  VALUES (v_tournament, p_event_type, p_format, coalesce(p_rated, false), false)
  RETURNING id INTO v_event;

  UPDATE club_events SET tournament_event_id = v_event WHERE id = p_club_event_id;

  -- Everyone already signed up, as loose entries, rated on the discipline's
  -- own number the way the console's add-entrant path stamps it.
  INSERT INTO tournament_participants (event_id, player_id, status, elo_before, added_by)
  SELECT v_event, s.player_id, 'registered',
         coalesce(CASE WHEN v_doubles THEN r.doubles_elo ELSE r.singles_elo END, 400),
         p_actor_id
    FROM club_event_signups s
    LEFT JOIN ratings r ON r.player_id = s.player_id
   WHERE s.event_id = p_club_event_id
   ORDER BY s.created_at;
  GET DIAGNOSTICS v_entered = ROW_COUNT;

  -- Non-members already in from the Form become sign-ups too, each entered by
  -- the sign-up trigger above.
  PERFORM club_event_link_admit_external(x.id)
     FROM club_event_external_signups x WHERE x.event_id = p_club_event_id;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value)
  VALUES (p_actor_id, 'club_event_tournament_linked', 'club_event', p_club_event_id,
          jsonb_build_object('tournament_id', v_tournament, 'event_id', v_event,
                             'event_type', p_event_type, 'format', p_format,
                             'rated', coalesce(p_rated, false), 'entered', v_entered));

  RETURN jsonb_build_object('ok', true, 'already', false,
                            'tournament_id', v_tournament, 'event_id', v_event, 'entered', v_entered);
END;
$function$;

REVOKE ALL ON FUNCTION public.link_club_event_tournament(uuid, uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_club_event_tournament(uuid, uuid, text, text, boolean) TO service_role;

-- ---- 4a. Club to tournament ------------------------------------------------

-- The field is open while the event is in registration or check-in and its draw
-- is not locked: the window unpair_tournament_pair and withdrawal allow. Takes
-- the event row lock the tournament's own field changes take (00201).
CREATE OR REPLACE FUNCTION public.club_event_link_assert_field_open(p_event_id uuid, p_message text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
  v_locked boolean;
BEGIN
  SELECT te.status, te.draw_locked INTO v_status, v_locked
    FROM tournament_events te WHERE te.id = p_event_id FOR UPDATE;
  IF v_status NOT IN ('registration', 'checkin') OR coalesce(v_locked, false) THEN
    RAISE EXCEPTION '%', p_message USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_assert_field_open(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.club_event_link_signup_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event uuid;
  v_type text;
BEGIN
  SELECT ce.tournament_event_id, te.event_type INTO v_event, v_type
    FROM club_events ce JOIN tournament_events te ON te.id = ce.tournament_event_id
   WHERE ce.id = NEW.event_id;
  IF v_event IS NULL OR club_event_link_in_event(v_event, NEW.player_id) THEN
    RETURN NULL;
  END IF;
  -- Entering is the tournament's own rule: open only before the draw, under
  -- the event row lock every field change takes (00201). After that an officer
  -- enters them from the tournament, where the draw's safeguards are.
  PERFORM club_event_link_assert_field_open(v_event,
    'The linked tournament''s draw is already made, so a sign-up cannot be added here. Enter them from the tournament page.');
  -- Inside a change the tournament side started (the sync putting a sign-up
  -- back), the origin is already set and stays 'tournament'.
  IF coalesce(current_setting('club_event_link.origin', true), '') = '' THEN
    PERFORM set_config('club_event_link.origin', 'club', true);
  END IF;

  INSERT INTO tournament_participants (event_id, player_id, status, elo_before)
  SELECT v_event, NEW.player_id, 'registered',
         coalesce(CASE WHEN v_type LIKE '%doubles' THEN r.doubles_elo ELSE r.singles_elo END, 400)
    FROM (SELECT 1) one
    LEFT JOIN ratings r ON r.player_id = NEW.player_id
  ON CONFLICT (event_id, player_id) DO UPDATE
    SET status = 'registered', checked_in_at = NULL, checked_in_by = NULL
  WHERE tournament_participants.status = 'withdrawn';
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.club_event_link_signup_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event uuid;
  v_pair uuid;
BEGIN
  SELECT ce.tournament_event_id INTO v_event FROM club_events ce WHERE ce.id = OLD.event_id;
  IF v_event IS NULL OR NOT club_event_link_in_event(v_event, OLD.player_id) THEN
    RETURN NULL;
  END IF;
  -- Leaving after the draw is a withdrawal from a drawn field (forfeits, the
  -- waitlist, the audit), which the tournament does and this trigger must not.
  PERFORM club_event_link_assert_field_open(v_event,
    'The linked tournament''s draw is already made, so this sign-up cannot be removed here. Withdraw them from the tournament page.');
  IF coalesce(current_setting('club_event_link.origin', true), '') = '' THEN
    PERFORM set_config('club_event_link.origin', 'club', true);
  END IF;

  UPDATE tournament_participants tp SET status = 'withdrawn'
   WHERE tp.event_id = v_event AND tp.player_id = OLD.player_id
     AND tp.status NOT IN ('withdrawn', 'disqualified');

  SELECT pr.id INTO v_pair FROM tournament_pairs pr
   WHERE pr.event_id = v_event AND OLD.player_id IN (pr.player1_id, pr.player2_id)
     AND pr.status NOT IN ('withdrawn', 'disqualified')
   LIMIT 1;
  IF v_pair IS NOT NULL THEN
    -- Before the draw (asserted above) the partner stays in, loose. An unpair
    -- that still refuses raises, and the sign-up stays.
    PERFORM unpair_tournament_pair(v_pair, OLD.player_id, 'Left the club event', NULL);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_signup_added() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_link_signup_removed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS club_event_link_signup_added ON public.club_event_signups;
CREATE TRIGGER club_event_link_signup_added
  AFTER INSERT ON public.club_event_signups
  FOR EACH ROW EXECUTE FUNCTION public.club_event_link_signup_added();

DROP TRIGGER IF EXISTS club_event_link_signup_removed ON public.club_event_signups;
CREATE TRIGGER club_event_link_signup_removed
  AFTER DELETE ON public.club_event_signups
  FOR EACH ROW EXECUTE FUNCTION public.club_event_link_signup_removed();

-- ---- 4b. Tournament to club, at commit ---------------------------------------

CREATE OR REPLACE FUNCTION public.club_event_link_entry_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event uuid;
  v_club uuid;
  v_player uuid;
  v_players uuid[];
BEGIN
  IF current_setting('club_event_link.origin', true) = 'club' THEN
    RETURN NULL;
  END IF;
  v_event := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
  SELECT ce.id INTO v_club FROM club_events ce WHERE ce.tournament_event_id = v_event;
  IF v_club IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'tournament_participants' THEN
    v_players := ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.player_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.player_id END];
  ELSE
    v_players := ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.player1_id END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.player2_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.player1_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.player2_id END];
  END IF;

  PERFORM set_config('club_event_link.origin', 'tournament', true);
  FOR v_player IN SELECT DISTINCT p FROM unnest(v_players) p WHERE p IS NOT NULL LOOP
    PERFORM club_event_link_reconcile(v_club, v_event, v_player);
  END LOOP;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_entry_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS club_event_link_participant_changed ON public.tournament_participants;
CREATE CONSTRAINT TRIGGER club_event_link_participant_changed
  AFTER INSERT OR UPDATE OF status, player_id OR DELETE ON public.tournament_participants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.club_event_link_entry_changed();

DROP TRIGGER IF EXISTS club_event_link_pair_changed ON public.tournament_pairs;
CREATE CONSTRAINT TRIGGER club_event_link_pair_changed
  AFTER INSERT OR UPDATE OF status, player1_id, player2_id OR DELETE ON public.tournament_pairs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.club_event_link_entry_changed();

-- ---- 5. Non-members become sign-ups ------------------------------------------

-- create_player_with_rating made with a division status has failed since 00220:
-- init_player_records writes the ratings row on that insert, and this
-- function's own insert of it then hits ratings_player_id_key. That is the
-- console's Add Player with Competitive or Recreational. The values here are
-- the column defaults, so the trigger's row is the same row; it is kept.
CREATE OR REPLACE FUNCTION public.create_player_with_rating(p_user_id uuid, p_email text, p_first_name text, p_last_name text DEFAULT NULL::text, p_display_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_status player_status DEFAULT 'pending_approval'::player_status, p_role user_role DEFAULT 'player'::user_role)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player_id uuid;
BEGIN
  -- Mirror the self-onboarding RLS intent of players_self_insert
  -- (00005_rls.sql): a regular user may only create their own pending
  -- player row; anything else requires the service role.
  IF NOT (
    auth.role() = 'service_role'
    OR (
      p_user_id IS NOT NULL
      AND p_user_id = auth.uid()
      AND p_status = 'pending_approval'
      AND p_role = 'player'
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to create this player';
  END IF;

  INSERT INTO players (user_id, email, first_name, last_name, display_name, phone, status, role, onboarding_completed)
  VALUES (p_user_id, p_email, p_first_name, p_last_name, p_display_name, p_phone, p_status, p_role, p_user_id IS NOT NULL)
  RETURNING id INTO v_player_id;

  INSERT INTO ratings (
    player_id, singles_elo, doubles_elo,
    singles_provisional, doubles_provisional,
    singles_k_factor, doubles_k_factor
  ) VALUES (v_player_id, 400, 400, TRUE, TRUE, 80, 64)
  ON CONFLICT (player_id) DO NOTHING;

  RETURN v_player_id;
END;
$function$;

-- As 00126 left it: authenticated for self-onboarding (the guard above pins it
-- to the caller's own pending row), service_role for the console; never anon.
REVOKE ALL ON FUNCTION public.create_player_with_rating(uuid, text, text, text, text, text, player_status, user_role)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_player_with_rating(uuid, text, text, text, text, text, player_status, user_role)
  TO authenticated, service_role;

ALTER TABLE public.players ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.players.is_guest IS
  'A record made for a Google Form non-member so they can be entered in a tournament (00292). Silent and off the dues lists until they sign in with its email, which clears it.';

-- Making a guest a member without them signing in is an admin's decision. An
-- exec may ask; the ask sits on the record until an admin confirms or declines.
-- No foreign key on purpose: a players-to-players FK has to be classified in
-- merge_players before a merge will run (00207), and this is a note, not a link.
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS guest_member_requested_by uuid;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS guest_member_requested_at timestamptz;
COMMENT ON COLUMN public.players.guest_member_requested_by IS
  'The officer who asked an admin to make this guest a member (00292); cleared when an admin decides or the guest signs in.';

-- Signing in claims the record by filling user_id; that is the moment a guest
-- becomes a person with an account.
-- A guest in one statement, flagged from the insert on, so no caller ever sees
-- (or mails, or lists) a half-made member. SECURITY DEFINER and owned by the
-- migration role, so the players guard admits the flag whoever the caller is;
-- callable only by the service role (the console's Add Player) and by the
-- functions here. Ratings ON CONFLICT: init_player_records may have written it.
CREATE OR REPLACE FUNCTION public.create_guest_player(p_email text, p_first_name text, p_last_name text, p_display_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player uuid;
BEGIN
  INSERT INTO players (user_id, email, first_name, last_name, display_name, status, role,
                       onboarding_completed, membership_type, is_guest, hide_from_leaderboard)
  VALUES (NULL, lower(btrim(p_email)), p_first_name, p_last_name, p_display_name, 'recreational', 'player',
          false, 'external', true, true)
  RETURNING id INTO v_player;

  INSERT INTO ratings (player_id, singles_elo, doubles_elo, singles_provisional, doubles_provisional,
                       singles_k_factor, doubles_k_factor)
  VALUES (v_player, 400, 400, TRUE, TRUE, 80, 64)
  ON CONFLICT (player_id) DO NOTHING;
  RETURN v_player;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_guest_player(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_guest_player(text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.player_guest_ends_at_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.is_guest AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL THEN
    NEW.is_guest := false;
    -- Set only because they were a guest; theirs to choose from here.
    NEW.hide_from_leaderboard := false;
    NEW.guest_member_requested_by := NULL;
    NEW.guest_member_requested_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- Named to fire BEFORE guard_player_privileged_columns_trg (alphabetical), and
-- the guard allows exactly this change.
DROP TRIGGER IF EXISTS a_player_guest_ends_at_claim_trg ON public.players;
CREATE TRIGGER a_player_guest_ends_at_claim_trg
  BEFORE UPDATE OF user_id ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.player_guest_ends_at_claim();

CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- THE OPENING IS 00131'S, NOT THIS FILE'S ORIGINAL.
  --
  -- This migration was written in parallel with 00131, from a body that
  -- predated it, and shipped `IF auth.uid() IS NULL OR is_admin(auth.uid())`.
  -- Applied in order that silently reverted 00131's hardening: auth.uid() is
  -- NULL for `anon` as well as for the service-role console, so the guard
  -- returned early for an unauthenticated caller. The table-grant revokes in
  -- 00128/00131 mask it today; any future anon grant would unmask it.
  --
  -- BOTH halves are required: current_user alone would admit a member inside a
  -- postgres-owned SECURITY DEFINER function, and auth.uid() alone is what let
  -- anon through.
  IF (current_user = 'service_role' OR current_user NOT IN ('anon', 'authenticated'))
     AND auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- An admin editing a row from the player app, on the browser key.
  -- auth.uid() IS NOT NULL first, so this branch can never be the one that
  -- decides an anonymous request.
  IF auth.uid() IS NOT NULL AND is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A self-created row may only ever be an ordinary, unapproved member.
    IF COALESCE(NEW.is_exec, FALSE)
       OR COALESCE(NEW.is_trainer, FALSE)
       OR COALESCE(NEW.fee_exempt, FALSE)
       OR COALESCE(NEW.is_banned, FALSE)
       OR NEW.role IS DISTINCT FROM 'player'
       OR NEW.status IS DISTINCT FROM 'pending_approval'
       -- Added: a self-created row claiming an office is the same escalation as
       -- editing one in, and get_executives() would publish it.
       OR NEW.exec_title IS NOT NULL
       -- REPLACES 00086's portfolio line, for the same reason it existed: a
       -- self-created row cannot be an exec at all (is_exec is refused above),
       -- so permissions on one are meaningless — but they must not be a way to
       -- pre-stage values that come into force the moment an admin grants
       -- is_exec. cardinality(), not IS NOT NULL: see the note above.
       OR NEW.permission_role IS NOT NULL
       OR cardinality(COALESCE(NEW.permission_grants, '{}')) > 0
       OR cardinality(COALESCE(NEW.permission_revokes, '{}')) > 0
       -- Added by 00092: signing up is not the club letting you in, so a signup
       -- that arrives already numbered is claiming a membership nobody granted.
       OR NEW.member_code IS NOT NULL
       -- Added by 00132. Written only by ensure_player_for_user and cleared
       -- only by an admin resolving it; a row that arrives carrying one is
       -- inventing a claim decision nobody made.
       OR NEW.privilege_claim_review IS NOT NULL
       -- Added by 00164, for the line above's reason. Written only by
       -- merge_players; a signup carrying one is claiming to be the survivor of
       -- a merge that never happened, which would put a review badge on the
       -- roster pointing at nothing.
       OR NEW.elo_review IS NOT NULL
       -- 00093, restored alongside the UPDATE arm: pre-staging in its purest
       -- form, a label that grants nothing today and is filled in by the next
       -- edit to that baseline.
       OR NEW.permission_baseline_id IS NOT NULL
       OR COALESCE(NEW.is_guest, FALSE)
       OR NEW.guest_member_requested_by IS NOT NULL
       OR NEW.guest_member_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'Not authorized to create a privileged player row';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     -- Published to anonymous visitors by get_executives(), so an unguarded
     -- write is a public claim to an office the member does not hold, not a
     -- cosmetic field on their own profile.
     OR NEW.exec_title   IS DISTINCT FROM OLD.exec_title
     -- ADDED BY 00225, and it is the line above's reason read the other way
     -- round. exec_title is guarded because a member must not put THEMSELVES
     -- on the public page; this is guarded because a member must not take
     -- themselves OFF it. Who the club presents as its officers is the club's
     -- call in both directions, and an unguarded UPDATE here would let the one
     -- person with a motive to disappear do it without an exec ever seeing.
     OR NEW.exec_hidden  IS DISTINCT FROM OLD.exec_hidden
     -- THE 00087 REPLACEMENT for 00086's portfolio line. All three, because
     -- omitting any one of them leaves a complete escalation path: the role
     -- alone chooses the base, a grant alone adds to it, and clearing a revoke
     -- alone hands back whatever the club took away.
     OR NEW.permission_role IS DISTINCT FROM OLD.permission_role
     OR NEW.permission_grants IS DISTINCT FROM OLD.permission_grants
     OR NEW.permission_revokes IS DISTINCT FROM OLD.permission_revokes
     -- Added by 00092. Assigned once by assign_member_code() and permanent;
     -- there is no legitimate self-edit, including clearing it.
     OR NEW.member_code IS DISTINCT FROM OLD.member_code
     -- Added by 00132. Setting it is meaningless and clearing it erases an
     -- admin's only durable prompt to review a privilege the member did not
     -- get — see the section header.
     OR NEW.privilege_claim_review IS DISTINCT FROM OLD.privilege_claim_review
     -- Added by 00164. THE POINT OF THIS MIGRATION: the member this flag is
     -- about is the one person with a motive to clear it, and an unqualified
     -- UPDATE reached it without needing SELECT on the table.
     OR NEW.elo_review IS DISTINCT FROM OLD.elo_review
     -- 00093's fourth, RESTORED: this file dropped it. It is a promise of
     -- access rather than access itself, and clearing it makes baseline
     -- propagation skip the member — so a capability the club revoked stays
     -- revoked for everyone except them.
     OR NEW.permission_baseline_id IS DISTINCT FROM OLD.permission_baseline_id
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer
     -- is_guest (00292) keeps a record off the dues lists and silent, so a member
     -- may not set it. The one change allowed is the flag clearing in the same
     -- update that claims the record at first sign-in.
     OR (NEW.is_guest IS DISTINCT FROM OLD.is_guest
         AND NOT (OLD.is_guest AND NOT NEW.is_guest
                  AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL))
     -- The ask to make a guest a member: the console's, never a member's. The
     -- claim trigger above clears it, which is the same update as the flag.
     OR ((NEW.guest_member_requested_by IS DISTINCT FROM OLD.guest_member_requested_by
          OR NEW.guest_member_requested_at IS DISTINCT FROM OLD.guest_member_requested_at)
         AND NOT (OLD.is_guest AND NOT NEW.is_guest
                  AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;


-- Nobody can challenge a guest: they have no login to answer with.
CREATE OR REPLACE FUNCTION public.challenge_participants_refuse_guests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM players p WHERE p.id = NEW.player_id AND p.is_guest) THEN
    RAISE EXCEPTION 'A guest cannot be challenged until they sign in'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.challenge_participants_refuse_guests() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS challenge_participants_refuse_guests_trg ON public.challenge_participants;
CREATE TRIGGER challenge_participants_refuse_guests_trg
  BEFORE INSERT ON public.challenge_participants
  FOR EACH ROW EXECUTE FUNCTION public.challenge_participants_refuse_guests();

-- No Discord account is linked to a guest, by /link, the console's force-link
-- or anything later. Discord's /signup claims the record first (the sign-in
-- claim clears is_guest), so it links a member, not a guest.
CREATE OR REPLACE FUNCTION public.player_discord_links_refuse_guests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM players p WHERE p.id = NEW.player_id AND p.is_guest) THEN
    RAISE EXCEPTION 'A guest cannot be linked to Discord until they sign in'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.player_discord_links_refuse_guests() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS player_discord_links_refuse_guests_trg ON public.player_discord_links;
CREATE TRIGGER player_discord_links_refuse_guests_trg
  BEFORE INSERT OR UPDATE OF player_id ON public.player_discord_links
  FOR EACH ROW EXECUTE FUNCTION public.player_discord_links_refuse_guests();

-- No in-app notice reaches a guest, whatever writes it.
CREATE OR REPLACE FUNCTION public.notifications_skip_guests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM players p WHERE p.id = NEW.player_id AND p.is_guest) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.notifications_skip_guests() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS notifications_skip_guests_trg ON public.notifications;
CREATE TRIGGER notifications_skip_guests_trg
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_skip_guests();

CREATE OR REPLACE FUNCTION public.club_event_link_admit_external(p_external_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_x club_event_external_signups%ROWTYPE;
  v_email text;
  v_name text;
  v_first text;
  v_player uuid;
  v_made boolean := false;
BEGIN
  SELECT * INTO v_x FROM club_event_external_signups x WHERE x.id = p_external_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- After the draw nobody new enters (club_event_link_assert_field_open): they
  -- stay a non-member sign-up of the club event, which an officer can enter from
  -- the tournament by hand.
  IF NOT EXISTS (SELECT 1 FROM club_events ce JOIN tournament_events te ON te.id = ce.tournament_event_id
                  WHERE ce.id = v_x.event_id AND te.status IN ('registration', 'checkin')
                    AND NOT coalesce(te.draw_locked, false)) THEN
    RETURN NULL;
  END IF;
  v_email := lower(btrim(v_x.email));
  v_name := btrim(v_x.full_name);

  -- A record this email already has (made for an earlier event, say) is reused.
  SELECT p.id INTO v_player FROM players p
   WHERE lower(p.email) = v_email
   ORDER BY (p.user_id IS NOT NULL) DESC, p.created_at
   LIMIT 1;
  IF v_player IS NULL THEN
    v_first := split_part(v_name, ' ', 1);
    -- Not create_player_with_rating: its auth.role() check refuses the Data
    -- API's reader role, whose import fires this at commit.
    v_player := create_guest_player(v_email, v_first,
      nullif(btrim(substr(v_name, char_length(v_first) + 1)), ''), v_name);
    v_made := true;
  END IF;

  -- Their named fee becomes theirs, so the sign-up's own fee trigger finds a
  -- fee already there and makes no second one. A receipt already filed against
  -- it stays with it. (A NEW record has usually taken it already: 00284's
  -- claim on players moves named event fees to the account with that email.)
  UPDATE club_fees f SET player_id = v_player, manual_name = NULL, manual_email = NULL
   WHERE f.fee_type = 'event' AND f.club_event_id = v_x.event_id
     AND f.player_id IS NULL AND lower(f.manual_email) = v_email
     AND NOT EXISTS (SELECT 1 FROM club_fees g
                      WHERE g.fee_type = 'event' AND g.club_event_id = v_x.event_id
                        AND g.player_id = v_player);

  -- The Form entry now names the player, so Undo and receipts follow them.
  UPDATE registration_import_entries en
     SET entrant_id = v_player, external_name = NULL, external_email = NULL,
         external_signup_id = NULL
   WHERE en.external_signup_id = v_x.id;

  -- A guest is sent nothing, and the Form already carried the waiver.
  UPDATE guest_waiver_invites gi SET cancelled_at = now()
   WHERE gi.target_kind = 'club_event' AND gi.target_id = v_x.event_id
     AND lower(gi.email) = v_email AND gi.sent_at IS NULL AND gi.cancelled_at IS NULL;

  DELETE FROM club_event_external_signups WHERE id = v_x.id;
  INSERT INTO club_event_signups (event_id, player_id)
  VALUES (v_x.event_id, v_player)
  ON CONFLICT DO NOTHING;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'club_event_external_admitted', 'club_event', v_x.event_id,
          jsonb_build_object('player_id', v_player, 'record_made', v_made),
          'A non-member from the Google Form was given a guest player record to enter the tournament');
  RETURN v_player;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_admit_external(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.club_event_link_external_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM club_events ce
              WHERE ce.id = NEW.event_id AND ce.tournament_event_id IS NOT NULL) THEN
    PERFORM club_event_link_admit_external(NEW.id);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_external_added() FROM PUBLIC, anon, authenticated;

-- At COMMIT: the Form import inserts this row, then the named fee, then points
-- its entry at the row (club_event_external_sign_up, 00284). Converting at the
-- insert would delete the row under it and leave the fee behind.
DROP TRIGGER IF EXISTS club_event_link_external_added ON public.club_event_external_signups;
CREATE CONSTRAINT TRIGGER club_event_link_external_added
  AFTER INSERT ON public.club_event_external_signups
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.club_event_link_external_added();

-- ---- 6. Erasing a guest ---------------------------------------------------------
-- A guest cannot sign in, so cannot start a deletion the way a member does
-- (only the member can, and an admin can only cancel one). An exec erases a
-- guest on a request to the privacy address. The record stays, so draws,
-- results and fees still add up, under a label: "Former guest#" and six hex
-- characters of the id's md5, so two erased guests in one draw stay apart.
-- The same sentinel email as the member purge sets off the same scrubs
-- (00285's Form-import scrub by trigger, and scrub_deleted_identity for audit
-- copies), and like the purge it never touches a signed waiver.
-- Their e-transfer screenshots are removed from storage by the console action
-- before this runs, because storage is not reachable from SQL.

CREATE OR REPLACE FUNCTION public.erase_guest(p_player_id uuid, p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player players%ROWTYPE;
  v_label text;
BEGIN
  SELECT * INTO v_player FROM players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF NOT v_player.is_guest OR v_player.user_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_guest');
  END IF;
  IF v_player.email LIKE 'deleted+%@deleted.invalid' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'label', v_player.full_name);
  END IF;

  v_label := 'Former guest#' || left(md5(p_player_id::text), 6);

  -- _shared/anonymize.ts PERSONAL_ARTIFACT_TABLES and DELINKED_TABLES. A guest
  -- has none of these today; listed so a later path that gives them one is
  -- still covered.
  DELETE FROM push_subscriptions WHERE player_id = p_player_id;
  DELETE FROM passkey_credentials WHERE player_id = p_player_id;
  DELETE FROM notifications WHERE player_id = p_player_id;
  DELETE FROM player_discord_links WHERE player_id = p_player_id;
  DELETE FROM calendar_feed_tokens WHERE player_id = p_player_id;
  UPDATE feedback_reports SET player_id = NULL WHERE player_id = p_player_id;

  -- anonymizedPlayerFields, with the label in place of "Deleted Player".
  -- full_name is generated from first_name and last_name.
  UPDATE players
     SET first_name = v_label, last_name = NULL, display_name = NULL, handle = NULL,
         email = 'deleted+' || p_player_id::text || '@deleted.invalid',
         phone = NULL, avatar_url = NULL, exec_photo_url = NULL, bio = NULL, exec_bio = NULL,
         active_flag = false
   WHERE id = p_player_id;

  PERFORM scrub_deleted_identity();

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (p_actor_id, 'guest_erased', 'player', p_player_id,
          jsonb_build_object('label', v_label),
          'A guest was erased on request; the record stays under a label');
  RETURN jsonb_build_object('ok', true, 'label', v_label);
END;
$function$;

REVOKE ALL ON FUNCTION public.erase_guest(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_guest(uuid, uuid) TO service_role;

-- ---- 7. An admin makes a guest a member ---------------------------------------

-- The other way out of being a guest, beside signing in. Admin-only, which the
-- console checks (it calls this with the service role): an exec's way is to ask,
-- which fills guest_member_requested_by for an admin to confirm here. They get a
-- member code like anybody the console lets in; still no login until they sign
-- in with the email, which then claims this record as before.
CREATE OR REPLACE FUNCTION public.make_guest_member(p_player_id uuid, p_actor_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player players%ROWTYPE;
BEGIN
  SELECT * INTO v_player FROM players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF NOT v_player.is_guest THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_guest');
  END IF;
  IF v_player.email LIKE 'deleted+%@deleted.invalid' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'erased');
  END IF;

  UPDATE players
     SET is_guest = false, hide_from_leaderboard = false,
         guest_member_requested_by = NULL, guest_member_requested_at = NULL
   WHERE id = p_player_id;
  IF v_player.member_code IS NULL THEN
    PERFORM assign_member_code(p_player_id);
  END IF;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (p_actor_id, 'guest_made_member', 'player', p_player_id,
          jsonb_build_object('requested_by', v_player.guest_member_requested_by),
          jsonb_build_object('is_guest', false),
          p_reason);
  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.make_guest_member(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.make_guest_member(uuid, uuid, text) TO service_role;


-- ---- 8. A guest is a non-member to the Form and to named fees -----------------

-- registration_import_apply as 00291 left it, with a guest read as a non-member
-- in its four email lookups. Matched as a member, a guest's later Form entry sat
-- at awaiting_member for a confirmation they cannot give (no login, no notice,
-- no mail); as a non-member it goes the way it did before they had a record:
-- a linked club event reuses the guest record, anything else is reviewed or
-- entered as external.
CREATE OR REPLACE FUNCTION public.registration_import_apply(
  p_consumer uuid, p_key_id uuid, p_source text, p_payload jsonb
)
RETURNS TABLE(item integer, event_id uuid, status text, reason text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  c_event_reasons constant text[] := ARRAY[
    'event_full', 'waitlist_queue', 'registration_closed', 'registration_not_open',
    'registration_window_closed', 'event_not_in_target', 'duplicate_in_submission'];
  v_consumer     uuid;
  v_key_id       uuid;
  v_form_id      text;
  v_response_id  text;
  v_submitted    timestamptz;
  v_email        text;
  v_name         text;
  v_entries      jsonb;
  v_hash         text;
  v_binding      registration_import_forms%ROWTYPE;
  v_import       registration_imports%ROWTYPE;
  v_prior        registration_imports%ROWTYPE;
  v_has_prior    boolean := false;
  v_is_edit      boolean := false;
  v_member       players%ROWTYPE;
  v_has_member   boolean := false;
  v_person_issue text;
  v_partner      players%ROWTYPE;
  v_has_partner  boolean;
  v_tournament   tournaments%ROWTYPE;
  v_event        tournament_events%ROWTYPE;
  v_club         club_events%ROWTYPE;
  v_event_ids    uuid[] := ARRAY[]::uuid[];
  v_lock_ids     uuid[];
  v_lock_id      uuid;
  v_elem         jsonb;
  v_i            integer;
  v_ev           uuid;
  v_partner_mail text;
  v_partner_name text;
  v_category     text;
  v_status       text;
  v_reason       text;
  v_entry_id     uuid;
  v_old          registration_import_entries%ROWTYPE;
  v_found_old    boolean;
  v_current      uuid[] := ARRAY[]::uuid[];
  v_results      jsonb := '[]'::jsonb;
  v_doubles      boolean;
  v_win          text;
  v_pairs        integer;
  v_unpaired     integer;
  v_singles      integer;
  v_before       integer;
  v_after        integer;
  v_waiting      boolean;
  v_rating       integer;
  v_pair_id      uuid;
  v_fee_id       uuid;
  v_tier         jsonb;
  v_signup       jsonb;
  v_why          text;
  v_n_entered    integer := 0;
  v_n_pending    integer := 0;
  v_n_refused    integer := 0;
  v_wants_wait   boolean;
BEGIN
  -- ---- who delivered it (00287) ----
  -- The key was checked by data_api_import_registration, or the binding was
  -- resolved by forms_api_import_registration. A key always comes with the
  -- Data API and never with the Forms API reader.
  IF p_consumer IS NULL
     OR p_source IS NULL OR p_source NOT IN ('data_api', 'forms_api')
     OR (p_source = 'data_api') <> (p_key_id IS NOT NULL) THEN
    RAISE EXCEPTION 'registration_import_apply: bad delivery (%)', p_source
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_consumer := p_consumer;
  v_key_id   := p_key_id;

  -- ---- the shape ----
  v_form_id     := NULLIF(btrim(COALESCE(p_payload ->> 'form_id', '')), '');
  v_response_id := NULLIF(btrim(COALESCE(p_payload ->> 'response_id', '')), '');
  v_email       := lower(btrim(COALESCE(p_payload ->> 'email', '')));
  v_name        := NULLIF(regexp_replace(btrim(COALESCE(p_payload ->> 'name', '')), '\s+', ' ', 'g'), '');
  v_entries     := COALESCE(p_payload -> 'entries', '[]'::jsonb);
  BEGIN
    v_submitted := NULLIF(p_payload ->> 'submitted_at', '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_submitted := NULL;
  END;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR v_form_id IS NULL OR char_length(v_form_id) > 200
     OR v_response_id IS NULL OR char_length(v_response_id) > 200
     OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254
     OR v_email LIKE '%@deleted.invalid'
     OR v_name IS NULL OR char_length(v_name) > 120
     OR jsonb_typeof(v_entries) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_entries) > 20 THEN
    item := 0; event_id := NULL; status := 'refused'; reason := 'bad_payload'; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ---- the binding, locked first (see the header) ----
  SELECT * INTO v_binding FROM registration_import_forms f
   WHERE f.consumer_id = v_consumer AND f.form_id = v_form_id
   FOR UPDATE;
  -- 00287: a binding the console reads through the Forms API takes nothing
  -- from the script, so one response never arrives by two roads.
  IF NOT FOUND OR NOT v_binding.active
     OR num_nonnulls(v_binding.tournament_id, v_binding.club_event_id, v_binding.season_id) = 0
     OR (p_source = 'data_api' AND v_binding.read_mapping IS NOT NULL) THEN
    item := 0; event_id := NULL; status := 'refused'; reason := 'not_found'; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;

  v_hash := md5(p_payload::text);

  -- ---- a replay answers from the record ----
  SELECT * INTO v_import FROM registration_imports i
   WHERE i.binding_id = v_binding.id AND i.response_id = v_response_id;
  IF FOUND AND v_import.payload_hash = v_hash THEN
    FOR v_elem IN SELECT * FROM jsonb_array_elements(v_import.result) LOOP
      item := (v_elem ->> 'item')::integer;
      event_id := NULLIF(v_elem ->> 'event_id', '')::uuid;
      status := v_elem ->> 'status';
      reason := v_elem ->> 'reason';
      replayed := true;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;
  IF FOUND THEN
    v_is_edit := true;
    v_prior := v_import;
    v_has_prior := true;
  END IF;

  -- ---- who is this ----
  SELECT * INTO v_member FROM players p
   WHERE lower(btrim(p.email)) = v_email AND p.email NOT LIKE '%@deleted.invalid' AND NOT p.is_guest
   ORDER BY p.created_at
   LIMIT 1;
  v_has_member := FOUND;

  -- ---- an earlier response by the same person is superseded ----
  IF NOT v_has_prior THEN
    SELECT * INTO v_prior FROM registration_imports i
     WHERE i.binding_id = v_binding.id
       AND i.superseded_by IS NULL
       AND ((v_has_member AND i.submitter_player_id = v_member.id)
         OR (NOT v_has_member AND i.submitter_email = v_email))
     ORDER BY i.created_at DESC
     LIMIT 1;
    v_has_prior := FOUND;
  END IF;

  -- ---- 00290: a season's form files no entry ----
  -- The receipt is the whole of it, filed by file_registration_import_receipts.
  -- Here only the import row, the supersede and the one result row.
  IF v_binding.target_kind = 'season' THEN
    IF v_is_edit THEN
      UPDATE registration_imports
         SET payload_hash = v_hash, submitted_at = v_submitted, key_id = v_key_id, source = p_source,
             submitter_player_id = CASE WHEN v_has_member THEN v_member.id END,
             submitter_name = CASE WHEN v_has_member THEN NULL ELSE v_name END,
             submitter_email = CASE WHEN v_has_member THEN NULL ELSE v_email END,
             updated_at = now()
       WHERE id = v_prior.id
      RETURNING * INTO v_import;
    ELSE
      INSERT INTO registration_imports (binding_id, key_id, source, response_id, submitted_at, payload_hash,
                                        submitter_player_id, submitter_name, submitter_email)
      VALUES (v_binding.id, v_key_id, p_source, v_response_id, v_submitted, v_hash,
              CASE WHEN v_has_member THEN v_member.id END,
              CASE WHEN v_has_member THEN NULL ELSE v_name END,
              CASE WHEN v_has_member THEN NULL ELSE v_email END)
      RETURNING * INTO v_import;
    END IF;
    IF v_has_prior AND NOT v_is_edit THEN
      UPDATE registration_imports SET superseded_by = v_import.id, updated_at = now()
       WHERE id = v_prior.id;
    END IF;

    v_results := jsonb_build_array(jsonb_build_object(
      'item', 1, 'event_id', NULL, 'status', 'pending', 'reason', NULL));
    UPDATE registration_imports SET result = v_results, updated_at = now() WHERE id = v_import.id;

    INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
    VALUES (NULL, 'registration_imported', 'registration_import', v_import.id,
            jsonb_build_object('binding_id', v_binding.id, 'consumer_id', v_consumer, 'key_id', v_key_id,
                               'source', p_source, 'season_id', v_binding.season_id,
                               'edited', v_is_edit, 'superseded', v_has_prior AND NOT v_is_edit,
                               'entered', 0, 'pending', 1, 'refused', 0),
            CASE WHEN p_source = 'forms_api'
                 THEN 'A form response was read from Google Forms'
                 ELSE 'A form response arrived through the data API' END);

    item := 1; event_id := NULL; status := 'pending'; reason := NULL; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ---- the events asked for ----
  IF v_binding.target_kind = 'club_event' THEN
    v_event_ids := ARRAY[v_binding.club_event_id];
  ELSE
    FOR v_elem IN SELECT * FROM jsonb_array_elements(v_entries) LOOP
      BEGIN
        v_ev := (v_elem ->> 'event_id')::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_ev := NULL;
      END;
      IF v_ev IS NOT NULL
         AND EXISTS (SELECT 1 FROM tournament_events e
                      WHERE e.id = v_ev AND e.tournament_id = v_binding.tournament_id) THEN
        v_event_ids := array_append(v_event_ids, v_ev);
      END IF;
    END LOOP;
  END IF;

  -- ---- the locks, all at top level, before any subtransaction ----
  IF v_binding.target_kind = 'tournament' THEN
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[]) INTO v_lock_ids
      FROM (
        SELECT unnest(v_event_ids) AS x
        UNION
        SELECT en.tournament_event_id FROM registration_import_entries en
         WHERE v_has_prior AND en.import_id = v_prior.id AND en.tournament_event_id IS NOT NULL
      ) s;
    FOREACH v_lock_id IN ARRAY v_lock_ids LOOP
      PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_lock_id::text));
    END LOOP;
    SELECT * INTO v_tournament FROM tournaments t WHERE t.id = v_binding.tournament_id FOR UPDATE;
    IF v_has_member THEN
      PERFORM 1 FROM players p WHERE p.id = v_member.id FOR SHARE;
    END IF;
    PERFORM 1 FROM tournament_events e WHERE e.id = ANY (v_lock_ids) ORDER BY e.id FOR UPDATE;
  ELSE
    SELECT * INTO v_club FROM club_events ce WHERE ce.id = v_binding.club_event_id FOR NO KEY UPDATE;
    IF v_has_member THEN
      PERFORM 1 FROM players p WHERE p.id = v_member.id FOR SHARE;
    END IF;
  END IF;

  -- ---- the person, once ----
  IF v_has_member THEN
    v_person_issue := CASE
      WHEN v_member.is_banned THEN 'banned'
      WHEN v_member.deletion_requested_at IS NOT NULL THEN 'deletion_pending'
      WHEN v_member.status = 'pending_approval' THEN 'pending_approval'
      WHEN v_member.status = 'suspended' THEN 'suspended'
      ELSE NULL
    END;
  END IF;

  -- ---- the import row ----
  IF v_is_edit THEN
    UPDATE registration_imports
       SET payload_hash = v_hash, submitted_at = v_submitted, key_id = v_key_id, source = p_source,
           submitter_player_id = CASE WHEN v_has_member THEN v_member.id END,
           submitter_name = CASE WHEN v_has_member THEN NULL ELSE v_name END,
           submitter_email = CASE WHEN v_has_member THEN NULL ELSE v_email END,
           updated_at = now()
     WHERE id = v_prior.id
    RETURNING * INTO v_import;
  ELSE
    INSERT INTO registration_imports (binding_id, key_id, source, response_id, submitted_at, payload_hash,
                                      submitter_player_id, submitter_name, submitter_email)
    VALUES (v_binding.id, v_key_id, p_source, v_response_id, v_submitted, v_hash,
            CASE WHEN v_has_member THEN v_member.id END,
            CASE WHEN v_has_member THEN NULL ELSE v_name END,
            CASE WHEN v_has_member THEN NULL ELSE v_email END)
    RETURNING * INTO v_import;
  END IF;

  -- ---- one entry per item ----
  v_i := 0;
  FOR v_elem IN
    SELECT e FROM jsonb_array_elements(
      CASE WHEN v_binding.target_kind = 'club_event' AND jsonb_array_length(v_entries) = 0
           THEN jsonb_build_array(jsonb_build_object('event_id', v_binding.club_event_id))
           ELSE v_entries END) e
  LOOP
    v_i := v_i + 1;
    v_status := NULL; v_reason := NULL; v_entry_id := NULL;
    v_pair_id := NULL; v_fee_id := NULL; v_wants_wait := false;
    BEGIN
      v_ev := (v_elem ->> 'event_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_ev := NULL;
    END;
    v_partner_mail := NULLIF(lower(btrim(COALESCE(v_elem ->> 'partner_email', ''))), '');
    v_partner_name := NULLIF(regexp_replace(btrim(COALESCE(v_elem ->> 'partner_name', '')), '\s+', ' ', 'g'), '');
    v_category     := NULLIF(btrim(COALESCE(v_elem ->> 'category', '')), '');
    IF v_partner_mail IS NOT NULL AND (v_partner_mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_partner_mail) > 254) THEN
      v_partner_mail := NULL;
    END IF;
    IF char_length(v_partner_name) > 120 THEN v_partner_name := left(v_partner_name, 120); END IF;
    IF char_length(v_category) > 40 THEN v_category := NULL; END IF;

    -- Not this form's: refused, and nothing recorded against an event.
    IF v_ev IS NULL OR NOT (
         (v_binding.target_kind = 'tournament' AND v_ev = ANY (v_event_ids))
      OR (v_binding.target_kind = 'club_event' AND v_ev = v_binding.club_event_id)) THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', NULL, 'status', 'refused', 'reason', 'event_not_in_target'));
      v_n_refused := v_n_refused + 1;
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_results) r
                WHERE r ->> 'event_id' = v_ev::text) THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', v_ev, 'status', 'refused', 'reason', 'duplicate_in_submission'));
      v_n_refused := v_n_refused + 1;
      CONTINUE;
    END IF;

    -- What this person's earlier response already made for this event, with
    -- the same partner: kept as it is, under this response.
    SELECT * INTO v_old FROM registration_import_entries en
     WHERE v_has_prior AND en.import_id = v_prior.id
       AND (en.tournament_event_id = v_ev OR en.club_event_id = v_ev)
       AND en.status IN ('entered', 'awaiting_partner', 'awaiting_member', 'needs_review')
       AND (en.requested_partner_id IS NOT DISTINCT FROM (
              SELECT p.id FROM players p
               WHERE v_partner_mail IS NOT NULL AND lower(btrim(p.email)) = v_partner_mail
                 AND p.email NOT LIKE '%@deleted.invalid' AND NOT p.is_guest
               ORDER BY p.created_at LIMIT 1))
       AND (en.requested_partner_id IS NOT NULL
            OR en.partner_email IS NOT DISTINCT FROM v_partner_mail)
     LIMIT 1;
    v_found_old := FOUND;
    IF v_found_old THEN
      UPDATE registration_import_entries
         SET import_id = v_import.id, item = v_i, updated_at = now()
       WHERE id = v_old.id;
      v_current := array_append(v_current, v_old.id);
      v_status := v_old.status;
      v_reason := v_old.reason;
    ELSE
      BEGIN
        -- ================= a tournament event =================
        IF v_binding.target_kind = 'tournament' THEN
          SELECT * INTO v_event FROM tournament_events e WHERE e.id = v_ev;
          v_doubles := v_event.event_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');
          v_win := entry_window_state(COALESCE(v_event.registration_opens_at, v_tournament.registration_opens_at),
                                      COALESCE(v_event.registration_closes_at, v_tournament.registration_closes_at),
                                      now());
          SELECT EXISTS (SELECT 1 FROM tournament_event_waitlist w
                          WHERE w.event_id = v_ev AND w.status = 'waiting') INTO v_waiting;

          -- The event's own facts, in enter_tournament_event's order.
          IF v_tournament.suspended_at IS NOT NULL
             OR v_tournament.status::text IN ('completed', 'archived')
             OR v_event.status <> 'registration' THEN
            v_status := 'refused'; v_reason := 'registration_closed';
          ELSIF v_win = 'not_open_yet' THEN
            v_status := 'refused'; v_reason := 'registration_not_open';
          ELSIF v_win = 'closed' THEN
            v_status := 'refused'; v_reason := 'registration_window_closed';
          END IF;

          -- Capacity: draw slots for doubles, rows for singles; an external
          -- team is one whole slot.
          IF v_status IS NULL AND v_event.max_participants IS NOT NULL AND v_event.max_participants > 0 THEN
            SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
             WHERE tournament_pairs.event_id = v_ev
               AND COALESCE(tournament_pairs.status::text, '') NOT IN ('withdrawn', 'disqualified');
            SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
             WHERE tournament_participants.event_id = v_ev
               AND COALESCE(tournament_participants.status::text, '') NOT IN ('withdrawn', 'disqualified');
            IF v_event.external_event AND NOT v_has_member THEN
              v_before := v_pairs; v_after := v_pairs + 1;
            ELSIF v_doubles THEN
              v_before := v_pairs + CEIL(v_unpaired / 2.0);
              v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);
            ELSE
              v_before := v_unpaired; v_after := v_unpaired + 1;
            END IF;
            IF v_after > v_event.max_participants AND v_after > v_before THEN
              IF v_has_member AND v_binding.join_waitlist AND v_event.waitlist_enabled
                 AND NOT v_event.external_event THEN
                v_wants_wait := true;
              ELSE
                v_status := 'refused'; v_reason := 'event_full';
              END IF;
            END IF;
          END IF;
          IF v_status IS NULL AND v_waiting AND NOT v_wants_wait THEN
            IF v_has_member AND v_binding.join_waitlist THEN
              v_wants_wait := true;
            ELSE
              v_status := 'refused'; v_reason := 'waitlist_queue';
            END IF;
          END IF;

          -- The person's.
          IF v_status IS NULL AND v_has_member THEN
            v_has_partner := false;
            IF v_doubles AND v_partner_mail IS NOT NULL THEN
              SELECT * INTO v_partner FROM players p
               WHERE lower(btrim(p.email)) = v_partner_mail AND p.email NOT LIKE '%@deleted.invalid' AND NOT p.is_guest
               ORDER BY p.created_at LIMIT 1;
              v_has_partner := FOUND;
            END IF;
            SELECT CASE WHEN v_doubles THEN r.doubles_elo ELSE r.singles_elo END INTO v_rating
              FROM ratings r WHERE r.player_id = v_member.id;

            IF v_person_issue IS NOT NULL THEN
              v_status := 'needs_review'; v_reason := v_person_issue;
            ELSIF v_event.external_event THEN
              v_status := 'needs_review'; v_reason := 'member_in_external_event';
            ELSIF v_rating IS NULL THEN
              v_status := 'needs_review'; v_reason := 'no_rating';
            ELSIF EXISTS (SELECT 1 FROM tournament_participants tp
                           WHERE tp.event_id = v_ev AND tp.player_id = v_member.id
                             AND tp.status IN ('withdrawn', 'disqualified')) THEN
              v_status := 'needs_review'; v_reason := 'withdrawn_reentry';
            ELSIF EXISTS (SELECT 1 FROM tournament_participants tp
                           WHERE tp.event_id = v_ev AND tp.player_id = v_member.id)
               OR EXISTS (SELECT 1 FROM tournament_pairs pr
                           WHERE pr.event_id = v_ev
                             AND (pr.player1_id = v_member.id OR pr.player2_id = v_member.id)
                             AND COALESCE(pr.status::text, '') NOT IN ('withdrawn', 'disqualified')) THEN
              v_status := 'refused'; v_reason := 'already_registered';
            ELSIF v_doubles AND v_partner_mail IS NOT NULL AND NOT v_has_partner THEN
              v_status := 'needs_review'; v_reason := 'external_partner';
            ELSIF v_doubles AND v_has_partner AND v_partner.id = v_member.id THEN
              v_status := 'needs_review'; v_reason := 'partner_is_self';
            ELSE
              v_status := 'awaiting_member';
            END IF;

            INSERT INTO registration_import_entries (
              import_id, item, tournament_event_id, entrant_id, requested_partner_id,
              partner_name, partner_email, category, wants_waitlist, status, reason)
            VALUES (
              v_import.id, v_i, v_ev, v_member.id,
              CASE WHEN v_doubles AND v_has_partner AND v_partner.id <> v_member.id THEN v_partner.id END,
              CASE WHEN v_doubles AND NOT v_has_partner THEN v_partner_name END,
              CASE WHEN v_doubles AND NOT v_has_partner THEN v_partner_mail END,
              v_category, v_wants_wait, v_status, v_reason)
            RETURNING id INTO v_entry_id;

            IF v_status = 'awaiting_member' THEN
              INSERT INTO notifications (player_id, type, title, body, metadata)
              VALUES (v_member.id, 'general', 'Confirm your entry',
                      format('The form for %s entered you in %s. Confirm it in the app if it was you.',
                             v_tournament.name, initcap(replace(v_event.event_type, '_', ' '))),
                      jsonb_build_object('kind', 'registration_import_confirm', 'entry_id', v_entry_id,
                                         'tournament_id', v_tournament.id, 'event_id', v_ev));
            END IF;

          -- A non-member, in an external event, as a whole team.
          ELSIF v_status IS NULL THEN
            v_has_partner := false;
            IF v_partner_mail IS NOT NULL THEN
              PERFORM 1 FROM players p
               WHERE lower(btrim(p.email)) = v_partner_mail AND p.email NOT LIKE '%@deleted.invalid' AND NOT p.is_guest;
              v_has_partner := FOUND;
            END IF;
            IF NOT v_event.external_event THEN
              v_status := 'needs_review'; v_reason := 'external_in_member_event';
            ELSIF NOT v_doubles OR v_partner_name IS NULL THEN
              v_status := 'needs_review'; v_reason := 'external_without_partner';
            ELSIF v_has_partner THEN
              v_status := 'needs_review'; v_reason := 'member_partner_in_external_event';
            ELSE
              BEGIN
                v_pair_id := public.add_external_tournament_pair_v2(
                  v_ev, v_name, v_partner_name, NULL, NULL, v_category);
                v_status := 'entered';
              EXCEPTION
                WHEN unique_violation THEN
                  v_status := 'needs_review'; v_reason := 'duplicate_team';
                WHEN check_violation THEN
                  v_status := 'needs_review'; v_reason := 'external_pair_refused';
              END;
            END IF;

            INSERT INTO registration_import_entries (
              import_id, item, tournament_event_id, external_name, external_email,
              partner_name, partner_email, category, pair_id, status, reason)
            VALUES (v_import.id, v_i, v_ev, v_name, v_email, v_partner_name, v_partner_mail,
                    v_category, v_pair_id, v_status, v_reason)
            RETURNING id INTO v_entry_id;

            IF v_status = 'entered' THEN
              -- One fee per person per tournament, never overwritten.
              v_tier := public.select_fee_tier('external', public.tournament_fee_tiers_json(v_tournament.id));
              INSERT INTO club_fees (fee_type, tournament_id, player_id, manual_name, manual_email,
                                     season_id, tier_id, amount_cents, paid_at)
              VALUES ('tournament', v_tournament.id, NULL, v_name, v_email, v_tournament.season_id,
                      NULLIF(v_tier ->> 'id', '')::uuid, (v_tier ->> 'amount_cents')::integer, NULL)
              ON CONFLICT (tournament_id, lower(manual_email))
                WHERE fee_type = 'tournament' AND player_id IS NULL
              DO NOTHING
              RETURNING id INTO v_fee_id;
              IF v_fee_id IS NOT NULL THEN
                UPDATE registration_import_entries
                   SET fee_id = v_fee_id, fee_created_by_import = true
                 WHERE id = v_entry_id;
              ELSE
                UPDATE registration_import_entries en
                   SET fee_id = f.id
                  FROM club_fees f
                 WHERE en.id = v_entry_id AND f.fee_type = 'tournament'
                   AND f.tournament_id = v_tournament.id AND f.player_id IS NULL
                   AND lower(f.manual_email) = v_email;
              END IF;

              INSERT INTO guest_waiver_invites (email, target_kind, target_id, import_entry_id)
              VALUES (v_email, 'tournament', v_tournament.id, v_entry_id)
              ON CONFLICT (email, target_kind, target_id) DO UPDATE
                SET cancelled_at = NULL, import_entry_id = EXCLUDED.import_entry_id
                WHERE guest_waiver_invites.sent_at IS NULL AND guest_waiver_invites.cancelled_at IS NOT NULL;
            END IF;
          END IF;

        -- ================= a club event =================
        ELSE
          IF v_club.status NOT IN ('draft', 'published') OR v_club.starts_at <= now() THEN
            v_status := 'refused'; v_reason := 'registration_closed';
          ELSIF v_club.signup_opens_at IS NOT NULL AND now() < v_club.signup_opens_at THEN
            v_status := 'refused'; v_reason := 'registration_not_open';
          ELSIF v_club.signup_closes_at IS NOT NULL AND now() >= v_club.signup_closes_at THEN
            v_status := 'refused'; v_reason := 'registration_window_closed';
          ELSIF v_club.capacity IS NOT NULL AND public.club_event_taken(v_ev) >= v_club.capacity THEN
            v_status := 'refused'; v_reason := 'event_full';
          END IF;

          IF v_status IS NULL AND v_has_member THEN
            IF v_person_issue IS NOT NULL THEN
              v_status := 'needs_review'; v_reason := v_person_issue;
            ELSIF EXISTS (SELECT 1 FROM club_event_signups s
                           WHERE s.event_id = v_ev AND s.player_id = v_member.id) THEN
              v_status := 'refused'; v_reason := 'already_registered';
            ELSE
              v_status := 'entered';
            END IF;
            INSERT INTO registration_import_entries (import_id, item, club_event_id, entrant_id, status, reason)
            VALUES (v_import.id, v_i, v_ev, v_member.id, v_status, v_reason)
            RETURNING id INTO v_entry_id;
            -- 00291: the form signs the member up. The sign-up's own trigger
            -- (club_event_signup_fee) bills them, as a sign-up in the app does.
            IF v_status = 'entered' THEN
              INSERT INTO club_event_signups (event_id, player_id) VALUES (v_ev, v_member.id);
            END IF;
            -- 00289: a draft holds the member's notice until it is published.
            IF v_status = 'entered' AND v_club.status = 'published' THEN
              INSERT INTO notifications (player_id, type, title, body, metadata)
              VALUES (v_member.id, 'general', 'You are signed up',
                      format('The form for %s signed you up. If that was not you, open this to undo it.', v_club.title),
                      jsonb_build_object('kind', 'registration_import_signed_up', 'entry_id', v_entry_id,
                                         'club_event_id', v_ev));
            END IF;
          ELSIF v_status IS NULL THEN
            INSERT INTO registration_import_entries (import_id, item, club_event_id, external_name, external_email, status)
            VALUES (v_import.id, v_i, v_ev, v_name, v_email, 'needs_review')
            RETURNING id INTO v_entry_id;
            v_signup := public.club_event_external_sign_up(v_ev, v_name, v_email, v_entry_id);
            IF COALESCE((v_signup ->> 'ok')::boolean, false) THEN
              v_status := 'entered'; v_reason := NULL;
            ELSIF v_signup ->> 'reason' = ANY (c_event_reasons) THEN
              v_status := 'refused'; v_reason := v_signup ->> 'reason';
            ELSE
              v_status := 'needs_review'; v_reason := COALESCE(v_signup ->> 'reason', 'external_refused');
            END IF;
            UPDATE registration_import_entries
               SET status = v_status, reason = v_reason, updated_at = now()
             WHERE id = v_entry_id;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- Whatever this entry did is rolled back to the subtransaction; the
        -- rest of the response stands. Parked, with the SQLSTATE for the desk.
        v_status := 'needs_review'; v_reason := 'error_' || SQLSTATE;
        v_entry_id := NULL;
        INSERT INTO registration_import_entries (
          import_id, item, tournament_event_id, club_event_id, entrant_id,
          external_name, external_email, status, reason)
        VALUES (v_import.id, v_i,
                CASE WHEN v_binding.target_kind = 'tournament' THEN v_ev END,
                CASE WHEN v_binding.target_kind = 'club_event' THEN v_ev END,
                CASE WHEN v_has_member THEN v_member.id END,
                CASE WHEN v_has_member THEN NULL ELSE v_name END,
                CASE WHEN v_has_member THEN NULL ELSE v_email END,
                v_status, v_reason)
        RETURNING id INTO v_entry_id;
      END;

      -- Every row this call wrote is current, and is never retired below.
      IF v_entry_id IS NOT NULL THEN
        v_current := array_append(v_current, v_entry_id);
      END IF;
      IF v_entry_id IS NOT NULL AND v_status = 'needs_review' THEN
        INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
        VALUES (NULL, 'registration_import_parked', 'registration_import_entry', v_entry_id,
                jsonb_build_object('import_id', v_import.id, 'binding_id', v_binding.id,
                                   'event_id', v_ev, 'reason', v_reason),
                'A form response was parked for review');
      END IF;
    END IF;

    -- The public answer: event reasons only; anything else is pending.
    IF v_status = 'entered' THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', v_ev, 'status', 'entered', 'reason', NULL));
      v_n_entered := v_n_entered + 1;
    ELSIF v_status = 'refused' AND v_reason = ANY (c_event_reasons) THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', v_ev, 'status', 'refused', 'reason', v_reason));
      v_n_refused := v_n_refused + 1;
    ELSE
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', v_ev, 'status', 'pending', 'reason', NULL));
      v_n_pending := v_n_pending + 1;
    END IF;
  END LOOP;

  -- ---- what the earlier response made and this one no longer asks for ----
  IF v_has_prior THEN
    FOR v_old IN
      SELECT * FROM registration_import_entries en
       WHERE en.import_id IN (v_prior.id, v_import.id)
         AND NOT (en.id = ANY (v_current))
         AND en.status IN ('entered', 'awaiting_partner', 'awaiting_member', 'needs_review')
       ORDER BY en.id
    LOOP
      IF v_old.participant_id IS NULL AND v_old.pair_id IS NULL AND v_old.status <> 'entered' THEN
        -- Nothing live: the earlier ask simply lapses.
        UPDATE registration_import_entries
           SET status = 'superseded', reason = 'removed_from_form', updated_at = now()
         WHERE id = v_old.id;
      ELSIF v_old.entrant_id IS NOT NULL THEN
        -- A member's own confirmed entry is never withdrawn by a form edit.
        UPDATE registration_import_entries
           SET status = 'needs_review', reason = 'removed_from_form', updated_at = now()
         WHERE id = v_old.id;
      ELSE
        v_why := public.registration_import_retire(v_old.id);
        UPDATE registration_import_entries
           SET status = CASE WHEN v_why IS NULL THEN 'superseded' ELSE 'needs_review' END,
               reason = CASE WHEN v_why IS NULL THEN 'removed_from_form' ELSE 'removed_from_form_' || v_why END,
               updated_at = now()
         WHERE id = v_old.id;
        IF v_why IS NULL AND v_old.tournament_event_id IS NOT NULL THEN
          PERFORM public.fill_event_from_waitlist(v_old.tournament_event_id, NULL, NULL);
        END IF;
      END IF;
    END LOOP;

    IF NOT v_is_edit THEN
      UPDATE registration_imports SET superseded_by = v_import.id, updated_at = now()
       WHERE id = v_prior.id;
    END IF;
  END IF;

  UPDATE registration_imports SET result = v_results, updated_at = now() WHERE id = v_import.id;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'registration_imported', 'registration_import', v_import.id,
          jsonb_build_object('binding_id', v_binding.id, 'consumer_id', v_consumer, 'key_id', v_key_id,
                             'source', p_source,
                             'edited', v_is_edit, 'superseded', v_has_prior AND NOT v_is_edit,
                             'entered', v_n_entered, 'pending', v_n_pending, 'refused', v_n_refused),
          CASE WHEN p_source = 'forms_api'
               THEN 'A form response was read from Google Forms'
               ELSE 'A form response arrived through the data API' END);

  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_results) LOOP
    item := (v_elem ->> 'item')::integer;
    event_id := NULLIF(v_elem ->> 'event_id', '')::uuid;
    status := v_elem ->> 'status';
    reason := v_elem ->> 'reason';
    replayed := false;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.registration_import_apply(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- claim_named_fees_for_player as 00284 left it, skipping guests: a guest
-- record made for one event otherwise took every named dues and event fee for
-- that email, off the lists that leave guests out.
CREATE OR REPLACE FUNCTION public.claim_named_fees_for_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' OR NEW.email LIKE '%@deleted.invalid' THEN
    RETURN NULL;
  END IF;
  -- 00292: a guest claims nothing. Their linked event's fee is moved by
  -- club_event_link_admit_external; the rest (dues, other events) waits until
  -- they stop being a guest, at sign-in or make_guest_member, which runs this
  -- again from claim_named_fees_at_guest_end_trg.
  IF NEW.is_guest THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.email IS NOT DISTINCT FROM NEW.email
     AND NOT (OLD.is_guest AND NOT NEW.is_guest) THEN
    RETURN NULL;
  END IF;

  BEGIN
    WITH claimable AS (
      SELECT f.id, f.manual_name
        FROM public.club_fees f
       WHERE f.player_id IS NULL
         AND f.fee_type = 'dues'
         AND lower(f.manual_email) = NEW.email
         AND NOT EXISTS (
           SELECT 1 FROM public.club_fees d
            WHERE d.player_id = NEW.id
              AND d.fee_type = 'dues'
              AND d.season_id = f.season_id
         )
       FOR UPDATE
    ), claimed AS (
      UPDATE public.club_fees f
         SET player_id = NEW.id, manual_name = NULL, manual_email = NULL
        FROM claimable c
       WHERE f.id = c.id
      RETURNING f.id, f.season_id, c.manual_name
    )
    INSERT INTO public.audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
    SELECT NULL, 'manual_fee_claimed', 'club_fee', claimed.id,
           jsonb_build_object('manual_name', claimed.manual_name),
           jsonb_build_object('player_id', NEW.id, 'season_id', claimed.season_id),
           'A named payment moved onto the account that signed up with its email'
      FROM claimed;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00252: could not claim named fees for player %: %', NEW.id, SQLERRM;
  END;

  BEGIN
    WITH claimable AS (
      SELECT f.id, f.manual_name
        FROM public.club_fees f
       WHERE f.player_id IS NULL
         AND f.fee_type = 'tournament'
         AND lower(f.manual_email) = NEW.email
         AND NOT EXISTS (
           SELECT 1 FROM public.club_fees d
            WHERE d.player_id = NEW.id
              AND d.fee_type = 'tournament'
              AND d.tournament_id = f.tournament_id
         )
       FOR UPDATE
    ), claimed AS (
      UPDATE public.club_fees f
         SET player_id = NEW.id, manual_name = NULL, manual_email = NULL
        FROM claimable c
       WHERE f.id = c.id
      RETURNING f.id, f.tournament_id, c.manual_name
    )
    INSERT INTO public.audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
    SELECT NULL, 'manual_fee_claimed', 'club_fee', claimed.id,
           jsonb_build_object('manual_name', claimed.manual_name),
           jsonb_build_object('player_id', NEW.id, 'tournament_id', claimed.tournament_id),
           'A named tournament fee moved onto the account that signed up with its email'
      FROM claimed;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00283: could not claim named tournament fees for player %: %', NEW.id, SQLERRM;
  END;

  BEGIN
    WITH claimable AS (
      SELECT f.id, f.manual_name
        FROM public.club_fees f
       WHERE f.player_id IS NULL
         AND f.fee_type = 'event'
         AND lower(f.manual_email) = NEW.email
         AND NOT EXISTS (
           SELECT 1 FROM public.club_fees d
            WHERE d.player_id = NEW.id
              AND d.fee_type = 'event'
              AND d.club_event_id = f.club_event_id
         )
       FOR UPDATE
    ), claimed AS (
      UPDATE public.club_fees f
         SET player_id = NEW.id, manual_name = NULL, manual_email = NULL
        FROM claimable c
       WHERE f.id = c.id
      RETURNING f.id, f.club_event_id, c.manual_name
    )
    INSERT INTO public.audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
    SELECT NULL, 'manual_fee_claimed', 'club_fee', claimed.id,
           jsonb_build_object('manual_name', claimed.manual_name),
           jsonb_build_object('player_id', NEW.id, 'club_event_id', claimed.club_event_id),
           'A named event fee moved onto the account that signed up with its email'
      FROM claimed;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00284: could not claim named event fees for player %: %', NEW.id, SQLERRM;
  END;

  RETURN NULL;
END;
$function$;

-- The sign-in claim and make_guest_member clear is_guest without naming it in
-- the UPDATE (the claim trigger does it), so a column list would not fire; the
-- WHEN reads the final row.
DROP TRIGGER IF EXISTS claim_named_fees_at_guest_end_trg ON public.players;
CREATE TRIGGER claim_named_fees_at_guest_end_trg
  AFTER UPDATE ON public.players
  FOR EACH ROW
  WHEN (OLD.is_guest AND NOT NEW.is_guest AND OLD.email IS NOT DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.claim_named_fees_for_player();

-- ---- Verify -------------------------------------------------------------------

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_events'
                    AND column_name = 'tournament_event_id') THEN
    RAISE EXCEPTION '00292: club_events.tournament_event_id is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('club_event_link_signup_added', 'club_event_link_signup_removed',
                        'club_event_link_participant_changed', 'club_event_link_pair_changed',
                        'club_event_link_external_added')
         AND NOT tgisinternal) <> 5 THEN
    RAISE EXCEPTION '00292: the five link triggers are not all in place';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('club_event_link_participant_changed', 'club_event_link_pair_changed')
         AND tgdeferrable AND tginitdeferred) <> 2 THEN
    RAISE EXCEPTION '00292: the tournament side triggers must be deferred to commit';
  END IF;
  IF has_function_privilege('authenticated', 'public.link_club_event_tournament(uuid, uuid, text, text, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.link_club_event_tournament(uuid, uuid, text, text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '00292: link_club_event_tournament must be service_role only';
  END IF;
  RAISE NOTICE '00292 verified: a club event runs as a linked tournament event.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
