-- ============================================================
-- 00294 THE DOOR TAKES WALK-INS, NO-SHOWS AND A WAITLIST
--
-- The owner's request, for club events: last-minute changes at the door.
-- Somebody who signed up does not come, somebody who did not sign up walks
-- in, and members who found the event full want the place that frees up.
--
-- WHAT IS ADDED
--   1. no_show_at on club_event_signups and club_event_external_signups. A
--      no-show keeps their sign-up and their fee (the owner: the fee is there
--      so people who paid show up), but no longer takes a place.
--   2. walk_in on club_event_signups. A member added at the door owes no fee
--      (the owner: walk-ins do not pay), so club_event_signup_fee skips them.
--   3. A non-member added at the door is a club_event_external_signups row
--      with walk_in set: a name, an email only if they give one (the column
--      is nullable now, for walk-ins only), no fee and no waiver (the owner
--      chose a "waiver not signed" flag). Kept with the Form's guests so the
--      door can pick the same person again next time.
--      club_event_link_admit_external leaves a guest with no email as a plain
--      sign-up of the club event when the event is run as a tournament: a
--      guest player record needs an email.
--   4. public.club_event_waitlist: a member who found the event full. One
--      'waiting' row per member per event; the rest is history ('promoted',
--      'left', 'removed'). Status names follow tournament_event_waitlist
--      (00278).
--   5. club_event_taken counts members and guests who are not no-shows. Every caller (member sign-up, Form sign-up, the form
--      import, the identity scrub) reads places through it, so they agree.
--   6. club_event_sign_up keeps the queue: while members are waiting, a free
--      place belongs to the head of the waitlist, and a member signing up
--      from the waitlist is marked promoted.
--   7. Functions for the member (join, leave) and for the door (promote,
--      remove, walk-in member, walk-in guest, no-show).
--   8. club_event_offer_place: when a place frees up (a withdrawal, a removal,
--      a no-show), the members at the head of the queue get an in-app
--      notification. Nothing is sent by email or Discord.
--
-- NO AUTOMATIC PROMOTION. A promoted member owes the event fee, so a place is
-- offered, not given: before the event starts the member signs up in the
-- app; once it has started (sign-up is closed then) an exec gives them the
-- place at the door.
--
-- A CLUB EVENT RUN AS A TOURNAMENT (00292) refuses all of this: its door is
-- the tournament's, and the tournament has its own waitlist (00278).
--
-- The waitlist is service role only, no RLS policy, not in the realtime
-- publication. Its player_id and resolved_by join merge_players_disposable,
-- so a merge is not blocked (the verify block checks merge_players_unhandled is empty).
--
-- ORDER. Apply after 00293.
-- ============================================================

BEGIN;

-- ---- 1, 2. THE COLUMNS ------------------------------------------------------
ALTER TABLE public.club_event_signups ADD COLUMN IF NOT EXISTS no_show_at timestamptz;
ALTER TABLE public.club_event_signups ADD COLUMN IF NOT EXISTS walk_in boolean NOT NULL DEFAULT false;
ALTER TABLE public.club_event_external_signups ADD COLUMN IF NOT EXISTS no_show_at timestamptz;
ALTER TABLE public.club_event_external_signups ADD COLUMN IF NOT EXISTS walk_in boolean NOT NULL DEFAULT false;
ALTER TABLE public.club_event_external_signups ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.club_event_external_signups DROP CONSTRAINT IF EXISTS club_event_external_signups_email_or_walk_in;
ALTER TABLE public.club_event_external_signups ADD CONSTRAINT club_event_external_signups_email_or_walk_in
  CHECK (email IS NOT NULL OR walk_in);

GRANT UPDATE (no_show_at) ON public.club_event_external_signups TO service_role;

COMMENT ON COLUMN public.club_event_signups.no_show_at IS
  'Marked a no-show at the door (00294). Keeps the sign-up and its fee, frees the place.';
COMMENT ON COLUMN public.club_event_signups.walk_in IS
  'Added at the door (00294). A walk-in owes no event fee.';
COMMENT ON COLUMN public.club_event_external_signups.no_show_at IS
  'Marked a no-show at the door (00294). Frees the place.';
COMMENT ON COLUMN public.club_event_external_signups.walk_in IS
  'Added at the door (00294): no fee, no waiver, email optional.';

-- ---- 4. THE WAITLIST --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.club_event_waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES public.club_events(id) ON DELETE CASCADE,
  player_id   uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting', 'promoted', 'left', 'removed')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  -- When the member was told a place had opened, so they are told once.
  offered_at  timestamptz,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.players(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS club_event_waitlist_one_waiting
  ON public.club_event_waitlist (event_id, player_id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS club_event_waitlist_queue
  ON public.club_event_waitlist (event_id, joined_at) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS club_event_waitlist_player ON public.club_event_waitlist (player_id);
ALTER TABLE public.club_event_waitlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.club_event_waitlist FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.club_event_waitlist TO service_role;

-- ---- 5. THE PLACES ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_event_taken(p_event_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT ((SELECT count(*) FROM club_event_signups s WHERE s.event_id = p_event_id AND s.no_show_at IS NULL)
        + (SELECT count(*) FROM club_event_external_signups x WHERE x.event_id = p_event_id AND x.no_show_at IS NULL))::integer;
$function$;

-- ---- 2. NO FEE FOR A WALK-IN ------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_event_signup_fee()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cost   integer;
  v_exempt boolean;
BEGIN
  -- 00294: walk-ins do not pay.
  IF NEW.walk_in THEN RETURN NULL; END IF;
  SELECT cost_cents INTO v_cost FROM public.club_events WHERE id = NEW.event_id;
  IF v_cost IS NULL OR v_cost = 0 THEN RETURN NULL; END IF;
  SELECT (coalesce(is_exec, FALSE) OR coalesce(fee_exempt, FALSE)) INTO v_exempt
    FROM public.players WHERE id = NEW.player_id;
  IF v_exempt IS DISTINCT FROM FALSE THEN RETURN NULL; END IF;

  INSERT INTO public.club_fees (fee_type, club_event_id, player_id, amount_cents, season_id)
  VALUES ('event', NEW.event_id, NEW.player_id, v_cost,
          (SELECT id FROM public.seasons WHERE active_flag = TRUE LIMIT 1))
  ON CONFLICT (club_event_id, player_id) WHERE fee_type = 'event' DO NOTHING;
  RETURN NULL;
END;
$function$;

-- ---- 6. THE MEMBER'S SIGN-UP KEEPS THE QUEUE --------------------------------
CREATE OR REPLACE FUNCTION public.club_event_sign_up(p_event_id uuid, p_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event    public.club_events%ROWTYPE;
  v_status   text;
  v_banned   boolean;
  v_deleting timestamptz;
  v_taken    integer;
  v_ahead    integer;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  -- The event row is the lock. FOR NO KEY UPDATE is the mode a plain UPDATE
  -- takes, so a console edit of this event queues here too, and the count
  -- below cannot race another sign-up.
  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_event.status = 'cancelled' THEN RETURN jsonb_build_object('ok', false, 'reason', 'cancelled'); END IF;
  IF v_event.status <> 'published' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_published'); END IF;
  IF v_event.starts_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'started'); END IF;
  IF v_event.signup_opens_at IS NOT NULL AND now() < v_event.signup_opens_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open_yet');
  END IF;
  IF v_event.signup_closes_at IS NOT NULL AND now() >= v_event.signup_closes_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'closed');
  END IF;

  -- Unlocked on purpose: an explicit players lock here would invert
  -- merge_players, which locks players and then reaches club_events through
  -- ON DELETE SET NULL.
  SELECT p.status::text, p.is_banned, p.deletion_requested_at
    INTO v_status, v_banned, v_deleting
    FROM public.players p WHERE p.id = p_player_id;
  IF v_status IS NULL OR v_banned OR v_deleting IS NOT NULL
     OR v_status IN ('pending_approval','suspended') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible');
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_event_signups s
              WHERE s.event_id = p_event_id AND s.player_id = p_player_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  IF v_event.capacity IS NOT NULL THEN
    -- 00284: members and guests share the places.
    v_taken := public.club_event_taken(p_event_id);
    IF v_taken >= v_event.capacity THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'full');
    END IF;
    -- 00294: a free place belongs to the members waiting ahead of this one
    -- (everybody waiting, for a member who is not on the waitlist).
    -- The queue order is (joined_at, id): two joins in the same instant still
    -- have one ahead of the other.
    SELECT count(*) INTO v_ahead FROM public.club_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting' AND w.player_id <> p_player_id
       AND NOT EXISTS (SELECT 1 FROM public.club_event_waitlist o
                        WHERE o.event_id = p_event_id AND o.player_id = p_player_id
                          AND o.status = 'waiting' AND (o.joined_at, o.id) < (w.joined_at, w.id));
    IF v_taken + v_ahead >= v_event.capacity THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'waitlist_queue');
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.club_event_signups (event_id, player_id) VALUES (p_event_id, p_player_id);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  UPDATE public.club_event_waitlist SET status = 'promoted', resolved_at = now()
   WHERE event_id = p_event_id AND player_id = p_player_id AND status = 'waiting';
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ---- 7. THE MEMBER JOINS AND LEAVES THE WAITLIST ----------------------------
-- When the event is over a waitlist is no use. An event with no end time is
-- treated as over six hours after it starts.
CREATE OR REPLACE FUNCTION public.club_event_join_waitlist(p_event_id uuid, p_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event    public.club_events%ROWTYPE;
  v_status   text;
  v_banned   boolean;
  v_deleting timestamptz;
  v_position integer;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_event.status = 'cancelled' THEN RETURN jsonb_build_object('ok', false, 'reason', 'cancelled'); END IF;
  IF v_event.status <> 'published' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_published'); END IF;
  IF v_event.tournament_event_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'linked'); END IF;
  IF COALESCE(v_event.ends_at, v_event.starts_at + interval '6 hours') <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ended');
  END IF;
  IF v_event.signup_opens_at IS NOT NULL AND now() < v_event.signup_opens_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open_yet');
  END IF;
  IF v_event.capacity IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_capacity'); END IF;

  SELECT p.status::text, p.is_banned, p.deletion_requested_at
    INTO v_status, v_banned, v_deleting
    FROM public.players p WHERE p.id = p_player_id;
  IF v_status IS NULL OR v_banned OR v_deleting IS NOT NULL
     OR v_status IN ('pending_approval','suspended') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible');
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_event_signups s
              WHERE s.event_id = p_event_id AND s.player_id = p_player_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_event_waitlist w
              WHERE w.event_id = p_event_id AND w.player_id = p_player_id AND w.status = 'waiting') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_waiting');
  END IF;

  -- With a place free and nobody waiting before the start, sign up instead.
  IF v_event.starts_at > now()
     AND public.club_event_taken(p_event_id) < v_event.capacity
     AND NOT EXISTS (SELECT 1 FROM public.club_event_waitlist w
                      WHERE w.event_id = p_event_id AND w.status = 'waiting') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_full');
  END IF;

  INSERT INTO public.club_event_waitlist (event_id, player_id) VALUES (p_event_id, p_player_id);
  SELECT count(*) INTO v_position FROM public.club_event_waitlist w
   WHERE w.event_id = p_event_id AND w.status = 'waiting';
  RETURN jsonb_build_object('ok', true, 'position', v_position);
END;
$function$;

CREATE OR REPLACE FUNCTION public.club_event_leave_waitlist(p_event_id uuid, p_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;
  UPDATE public.club_event_waitlist SET status = 'left', resolved_at = now()
   WHERE event_id = p_event_id AND player_id = p_player_id AND status = 'waiting';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_waiting'); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ---- 8. A FREED PLACE IS OFFERED --------------------------------------------
-- Tells the members at the head of the queue, as many as there are free
-- places, once each. Called from the triggers below; never fails the change
-- that freed the place.
CREATE OR REPLACE FUNCTION public.club_event_offer_place(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event public.club_events%ROWTYPE;
  v_free  integer;
  v_row   record;
  v_body  text;
BEGIN
  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id;
  IF NOT FOUND OR v_event.status <> 'published' OR v_event.capacity IS NULL
     OR v_event.tournament_event_id IS NOT NULL
     OR COALESCE(v_event.ends_at, v_event.starts_at + interval '6 hours') <= now() THEN
    RETURN;
  END IF;
  v_free := v_event.capacity - public.club_event_taken(p_event_id);
  IF v_free <= 0 THEN RETURN; END IF;

  v_body := CASE WHEN v_event.starts_at > now()
    THEN 'A place opened up. Sign up in the app to take it; the first in the queue get it first.'
    ELSE 'A place opened up. Ask an exec at the door and they can give it to you.' END;

  FOR v_row IN
    SELECT w.id, w.player_id, w.offered_at FROM public.club_event_waitlist w
     WHERE w.event_id = p_event_id AND w.status = 'waiting'
     ORDER BY w.joined_at, w.id
     LIMIT v_free
  LOOP
    CONTINUE WHEN v_row.offered_at IS NOT NULL;
    UPDATE public.club_event_waitlist SET offered_at = now() WHERE id = v_row.id;
    INSERT INTO public.notifications (player_id, type, title, body, metadata)
    VALUES (v_row.player_id, 'general', left('A place opened: ' || v_event.title, 200), v_body,
            jsonb_build_object('kind', 'club_event_place_offered', 'club_event_id', p_event_id));
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'club_event_offer_place(%): %', p_event_id, SQLERRM;
END;
$function$;

CREATE OR REPLACE FUNCTION public.club_event_place_freed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.club_event_offer_place(OLD.event_id);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS club_event_signup_place_freed ON public.club_event_signups;
CREATE TRIGGER club_event_signup_place_freed
  AFTER DELETE OR UPDATE OF no_show_at ON public.club_event_signups
  FOR EACH ROW EXECUTE FUNCTION public.club_event_place_freed();
DROP TRIGGER IF EXISTS club_event_external_place_freed ON public.club_event_external_signups;
CREATE TRIGGER club_event_external_place_freed
  AFTER DELETE OR UPDATE OF no_show_at ON public.club_event_external_signups
  FOR EACH ROW EXECUTE FUNCTION public.club_event_place_freed();

-- ---- 7. THE DOOR ------------------------------------------------------------
-- The door's own checks, shared: the event exists, is not cancelled or run as
-- a tournament, and is not a draft. Returns the refusal reason, or NULL.
CREATE OR REPLACE FUNCTION public.club_event_door_refusal(v_event public.club_events)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN v_event.id IS NULL THEN 'not_found'
    WHEN v_event.status = 'cancelled' THEN 'cancelled'
    WHEN v_event.status <> 'published' THEN 'not_published'
    WHEN v_event.tournament_event_id IS NOT NULL THEN 'linked'
  END;
$function$;

-- An exec gives a waiting member the place. Unlike the member's own sign-up
-- it works after the start, which is when no-shows are known. Still one
-- place: it is refused while the event is full. The member owes the fee as
-- for any sign-up, and is told in the app.
CREATE OR REPLACE FUNCTION public.club_event_promote_waiting(p_waitlist_id uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wait     public.club_event_waitlist%ROWTYPE;
  v_event    public.club_events%ROWTYPE;
  v_refusal  text;
  v_status   text;
  v_banned   boolean;
  v_deleting timestamptz;
BEGIN
  SELECT * INTO v_wait FROM public.club_event_waitlist WHERE id = p_waitlist_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_waiting'); END IF;
  SELECT * INTO v_event FROM public.club_events WHERE id = v_wait.event_id FOR NO KEY UPDATE;
  v_refusal := public.club_event_door_refusal(v_event);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', v_refusal); END IF;

  -- Read again under the event lock: another exec may have just acted.
  SELECT * INTO v_wait FROM public.club_event_waitlist WHERE id = p_waitlist_id;
  IF v_wait.status <> 'waiting' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_waiting'); END IF;

  SELECT p.status::text, p.is_banned, p.deletion_requested_at
    INTO v_status, v_banned, v_deleting
    FROM public.players p WHERE p.id = v_wait.player_id;
  IF v_status IS NULL OR v_banned OR v_deleting IS NOT NULL
     OR v_status IN ('pending_approval','suspended') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible');
  END IF;

  IF v_event.capacity IS NOT NULL AND public.club_event_taken(v_event.id) >= v_event.capacity THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'full');
  END IF;

  INSERT INTO public.club_event_signups (event_id, player_id) VALUES (v_event.id, v_wait.player_id)
  ON CONFLICT DO NOTHING;
  UPDATE public.club_event_waitlist
     SET status = 'promoted', resolved_at = now(), resolved_by = p_actor
   WHERE id = p_waitlist_id;
  INSERT INTO public.notifications (player_id, type, title, body, metadata)
  VALUES (v_wait.player_id, 'general', left('You are in: ' || v_event.title, 200),
          'A place opened up and the club gave it to you from the waitlist.',
          jsonb_build_object('kind', 'club_event_waitlist_promoted', 'club_event_id', v_event.id));
  RETURN jsonb_build_object('ok', true, 'player_id', v_wait.player_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.club_event_remove_waiting(p_waitlist_id uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.club_event_waitlist
     SET status = 'removed', resolved_at = now(), resolved_by = p_actor
   WHERE id = p_waitlist_id AND status = 'waiting';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_waiting'); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- A member who walks in: signed up as a walk-in (no fee) and checked in, over
-- capacity if need be, since they are already standing there. Someone who is
-- signed up already is just checked in. A member on the waitlist leaves it.
CREATE OR REPLACE FUNCTION public.club_event_walk_in_member(p_event_id uuid, p_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event    public.club_events%ROWTYPE;
  v_refusal  text;
  v_status   text;
  v_banned   boolean;
  v_deleting timestamptz;
BEGIN
  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  v_refusal := public.club_event_door_refusal(v_event);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', v_refusal); END IF;

  SELECT p.status::text, p.is_banned, p.deletion_requested_at
    INTO v_status, v_banned, v_deleting
    FROM public.players p WHERE p.id = p_player_id;
  IF v_status IS NULL OR v_banned OR v_deleting IS NOT NULL
     OR v_status IN ('pending_approval','suspended') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible');
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_event_signups s
              WHERE s.event_id = p_event_id AND s.player_id = p_player_id) THEN
    UPDATE public.club_event_signups
       SET checked_in_at = COALESCE(checked_in_at, now()), no_show_at = NULL
     WHERE event_id = p_event_id AND player_id = p_player_id;
    RETURN jsonb_build_object('ok', true, 'already_signed_up', true);
  END IF;

  INSERT INTO public.club_event_signups (event_id, player_id, walk_in, checked_in_at)
  VALUES (p_event_id, p_player_id, true, now());
  UPDATE public.club_event_waitlist SET status = 'promoted', resolved_at = now()
   WHERE event_id = p_event_id AND player_id = p_player_id AND status = 'waiting';
  RETURN jsonb_build_object('ok', true, 'already_signed_up', false);
END;
$function$;

-- A non-member who walks in: a name, an email if they gave one, checked in.
-- No fee and no waiver invite. The same email twice at one event is refused.
CREATE OR REPLACE FUNCTION public.club_event_walk_in_guest(p_event_id uuid, p_name text, p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event   public.club_events%ROWTYPE;
  v_refusal text;
  v_name    text := btrim(COALESCE(p_name, ''));
  v_email   text := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  v_id      uuid;
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_name');
  END IF;
  IF v_email IS NOT NULL AND (char_length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_email');
  END IF;
  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  v_refusal := public.club_event_door_refusal(v_event);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', v_refusal); END IF;

  BEGIN
    INSERT INTO public.club_event_external_signups (event_id, full_name, email, walk_in, checked_in_at)
    VALUES (p_event_id, v_name, v_email, true, now())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

-- A no-show, or its undo. Refused for somebody checked in: undo the check-in
-- first. The sign-up and any fee stay.
CREATE OR REPLACE FUNCTION public.club_event_set_no_show(p_event_id uuid, p_kind text, p_id uuid, p_no_show boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event   public.club_events%ROWTYPE;
  v_refusal text;
  v_here    timestamptz;
BEGIN
  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  v_refusal := public.club_event_door_refusal(v_event);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', v_refusal); END IF;

  IF p_kind = 'member' THEN
    SELECT checked_in_at INTO v_here FROM public.club_event_signups
     WHERE event_id = p_event_id AND player_id = p_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_registered'); END IF;
  ELSIF p_kind = 'guest' THEN
    SELECT checked_in_at INTO v_here FROM public.club_event_external_signups
     WHERE event_id = p_event_id AND id = p_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_registered'); END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_kind');
  END IF;

  IF p_no_show AND v_here IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'checked_in');
  END IF;
  -- Undoing a no-show takes the place back, so it needs a free one.
  IF NOT p_no_show AND v_event.capacity IS NOT NULL
     AND public.club_event_taken(p_event_id) >= v_event.capacity THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'full');
  END IF;

  IF p_kind = 'member' THEN
    UPDATE public.club_event_signups
       SET no_show_at = CASE WHEN p_no_show THEN COALESCE(no_show_at, now()) END
     WHERE event_id = p_event_id AND player_id = p_id;
  ELSE
    UPDATE public.club_event_external_signups
       SET no_show_at = CASE WHEN p_no_show THEN COALESCE(no_show_at, now()) END
     WHERE event_id = p_event_id AND id = p_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ---- THE GRANTS -------------------------------------------------------------
REVOKE ALL ON FUNCTION public.club_event_join_waitlist(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_leave_waitlist(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_offer_place(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_place_freed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_door_refusal(public.club_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_promote_waiting(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_remove_waiting(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_walk_in_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_walk_in_guest(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_set_no_show(uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_join_waitlist(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_event_leave_waitlist(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_event_promote_waiting(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_event_remove_waiting(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_event_walk_in_member(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_event_walk_in_guest(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_event_set_no_show(uuid, text, uuid, boolean) TO service_role;
-- Restated above, so their grants are restated too (a CREATE OR REPLACE keeps
-- them, but the anon revoke is written out in every migration that touches a
-- function; see 00126 and 00187).
REVOKE ALL ON FUNCTION public.club_event_taken(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_signup_fee() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_sign_up(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_link_admit_external(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_taken(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_event_sign_up(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- ---- 3. A GUEST WITH NO EMAIL STAYS A SIGN-UP WHEN THE EVENT IS LINKED ---
-- 00292's function, with the one guard.
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
  -- 00294: a walk-in who gave no email cannot have a guest player record
  -- (players.email is NOT NULL), so they stay a sign-up of the club event,
  -- as somebody does who signed up after the draw.
  IF v_x.email IS NULL THEN
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

-- ---- MERGES -----------------------------------------------------------------
-- The rows from 00286, and the two player columns this file adds.
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
    ('club_event_waitlist',          'resolved_by')
  ) AS t(tbl, col);
$function$;

-- ---- VERIFY -----------------------------------------------------------------
DO $verify$
DECLARE
  v_bad text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_event_signups' AND column_name = 'no_show_at')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_event_signups' AND column_name = 'walk_in')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_event_external_signups' AND column_name = 'no_show_at') THEN
    v_bad := array_append(v_bad, 'a no_show_at or walk_in column is missing');
  END IF;
  IF to_regclass('public.club_event_waitlist') IS NULL THEN
    v_bad := array_append(v_bad, 'club_event_waitlist is missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_event_external_signups'
                    AND column_name = 'email' AND is_nullable = 'YES') THEN
    v_bad := array_append(v_bad, 'club_event_external_signups.email is still NOT NULL');
  END IF;
  IF position('v_x.email IS NULL' IN pg_get_functiondef('public.club_event_link_admit_external(uuid)'::regprocedure)) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_link_admit_external would make a guest record with no email');
  END IF;
  IF position('no_show_at IS NULL' IN pg_get_functiondef('public.club_event_taken(uuid)'::regprocedure)) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_taken does not skip no-shows');
  END IF;
  IF position('NEW.walk_in' IN pg_get_functiondef('public.club_event_signup_fee()'::regprocedure)) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_signup_fee still charges walk-ins');
  END IF;
  IF position('waitlist_queue' IN pg_get_functiondef('public.club_event_sign_up(uuid,uuid)'::regprocedure)) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_sign_up does not keep the queue');
  END IF;
  IF has_function_privilege('authenticated', 'public.club_event_promote_waiting(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.club_event_walk_in_guest(uuid,text,text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.club_event_waitlist', 'SELECT')
     OR has_table_privilege('anon', 'public.club_event_waitlist', 'SELECT') THEN
    v_bad := array_append(v_bad, 'a new function or table is reachable by anon or authenticated');
  END IF;
  IF NOT has_column_privilege('service_role', 'public.club_event_external_signups', 'no_show_at', 'UPDATE') THEN
    v_bad := array_append(v_bad, 'service_role cannot set no_show_at on external sign-ups');
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 27 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the twenty-seven rows');
  END IF;
  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION '00294 verify failed: %', array_to_string(v_bad, '; ');
  END IF;
END;
$verify$;

COMMIT;
