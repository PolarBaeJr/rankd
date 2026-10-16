-- ============================================================
-- 00284: EXTERNALS SIGN UP FOR CLUB EVENTS
--
-- 00283 lets a club event's Google Form sign members up (after they confirm
-- in the app) and parks everyone else. This file lets a non-member's response
-- sign them up too, with a place, a fee when the event costs money, and a
-- guest waiver invite to the email they typed.
--
-- WHAT CHANGES.
--   1. club_event_external_signups: one row per non-member per event, unique
--      on the email. Service role reads; nothing else touches it.
--   2. club_event_taken counts both tables, and club_event_sign_up (00244) is
--      restated to ask it, so a member and a guest compete for the same
--      places. Every other line of 00244's function is unchanged.
--   3. club_fees: an event fee may be a named row (player_id NULL with
--      manual_name and manual_email), one per email per event, and the
--      manual_email shape admits event rows.
--   4. claim_named_fees_for_player claims named event rows as well.
--   5. club_event_external_sign_up and club_event_external_retire replace
--      00283's stubs. The dispatcher calls them under its club_events lock.
--   6. registration_import_entries.external_signup_id.
--
-- The email is kept as long as the signup (owner decision: external emails
-- are kept); it is never exported to the Data API.
-- ============================================================

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.registration_import_entries') IS NULL
     OR to_regprocedure('public.club_event_taken(uuid)') IS NULL THEN
    RAISE EXCEPTION '00284 needs 00283 (the form import) applied first';
  END IF;
END
$pre$;

-- ---- 1. THE TABLE -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.club_event_external_signups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.club_events(id) ON DELETE RESTRICT,
  full_name       text NOT NULL,
  email           text NOT NULL,
  import_entry_id uuid REFERENCES public.registration_import_entries(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT club_event_external_signups_name_length
    CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 120),
  CONSTRAINT club_event_external_signups_email_shape
    CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(email) <= 254),
  CONSTRAINT club_event_external_signups_event_email_key UNIQUE (event_id, email)
);

ALTER TABLE public.club_event_external_signups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_event_external_signups FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.club_event_external_signups TO service_role;

ALTER TABLE public.registration_import_entries
  ADD COLUMN IF NOT EXISTS external_signup_id uuid
    REFERENCES public.club_event_external_signups(id) ON DELETE SET NULL;

-- ---- 2. ONE COUNT OF PLACES -------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_event_taken(p_event_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT ((SELECT count(*) FROM club_event_signups s WHERE s.event_id = p_event_id)
        + (SELECT count(*) FROM club_event_external_signups x WHERE x.event_id = p_event_id))::integer;
$function$;

REVOKE ALL ON FUNCTION public.club_event_taken(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_taken(uuid) TO service_role;

-- 00244's function with one line changed: the capacity count.
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
  END IF;

  BEGIN
    INSERT INTO public.club_event_signups (event_id, player_id) VALUES (p_event_id, p_player_id);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_sign_up(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_sign_up(uuid, uuid) TO service_role;

-- ---- 3. A NAMED EVENT FEE ---------------------------------------------------
ALTER TABLE public.club_fees DROP CONSTRAINT IF EXISTS club_fees_shape_check;
ALTER TABLE public.club_fees ADD CONSTRAINT club_fees_shape_check CHECK (
  CASE fee_type
    WHEN 'dues' THEN ((season_id IS NOT NULL) AND (tournament_id IS NULL) AND (tier_id IS NULL)
                      AND (ban_started_at IS NULL) AND (ban_reason IS NULL) AND (club_event_id IS NULL))
    WHEN 'tournament' THEN ((tournament_id IS NOT NULL) AND (ban_started_at IS NULL) AND (ban_reason IS NULL)
                      AND (club_event_id IS NULL)
                      AND ((player_id IS NOT NULL AND manual_name IS NULL AND manual_email IS NULL)
                        OR (player_id IS NULL AND manual_name IS NOT NULL AND manual_email IS NOT NULL)))
    WHEN 'reinstatement' THEN ((ban_started_at IS NOT NULL) AND (manual_name IS NULL) AND (tournament_id IS NULL)
                      AND (tier_id IS NULL) AND (club_event_id IS NULL))
    WHEN 'event' THEN ((club_event_id IS NOT NULL) AND (tournament_id IS NULL) AND (tier_id IS NULL)
                      AND (ban_started_at IS NULL) AND (ban_reason IS NULL)
                      AND ((player_id IS NOT NULL AND manual_name IS NULL AND manual_email IS NULL)
                        OR (player_id IS NULL AND manual_name IS NOT NULL AND manual_email IS NOT NULL)))
    ELSE false
  END);

ALTER TABLE public.club_fees DROP CONSTRAINT IF EXISTS club_fees_manual_email_shape;
ALTER TABLE public.club_fees ADD CONSTRAINT club_fees_manual_email_shape CHECK (
  manual_email IS NULL OR (
    manual_name IS NOT NULL
    AND player_id IS NULL
    AND fee_type IN ('dues', 'tournament', 'event')
    AND manual_email = lower(btrim(manual_email))
    AND manual_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND char_length(manual_email) <= 254
  ));

CREATE UNIQUE INDEX IF NOT EXISTS club_fees_event_manual_email_key
  ON public.club_fees (club_event_id, lower(manual_email))
  WHERE fee_type = 'event' AND player_id IS NULL;

-- ---- 4. THE CLAIM REACHES EVENT ROWS ----------------------------------------
-- 00283's function and a third block, the same shape.
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
  IF TG_OP = 'UPDATE' AND OLD.email IS NOT DISTINCT FROM NEW.email THEN
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

-- ---- 5. THE SIGN-UP AND ITS UNDOING -----------------------------------------
-- Called by the dispatcher, which already holds the club_events row FOR NO
-- KEY UPDATE and has checked the event's status and window; capacity and the
-- duplicate are re-asked here, under that lock. The entry row exists (the
-- dispatcher wrote it) and is updated with what this made.
CREATE OR REPLACE FUNCTION public.club_event_external_sign_up(
  p_event_id uuid, p_name text, p_email text, p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event  club_events%ROWTYPE;
  v_email  text := lower(btrim(COALESCE(p_email, '')));
  v_name   text := btrim(COALESCE(p_name, ''));
  v_signup uuid;
  v_fee    uuid;
BEGIN
  SELECT * INTO v_event FROM club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_event.status <> 'published' OR v_event.starts_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_event.capacity IS NOT NULL AND public.club_event_taken(p_event_id) >= v_event.capacity THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_full');
  END IF;
  IF EXISTS (SELECT 1 FROM club_event_external_signups x
              WHERE x.event_id = p_event_id AND x.email = v_email) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  INSERT INTO club_event_external_signups (event_id, full_name, email, import_entry_id)
  VALUES (p_event_id, left(v_name, 120), v_email, p_entry_id)
  RETURNING id INTO v_signup;

  IF COALESCE(v_event.cost_cents, 0) > 0 THEN
    INSERT INTO club_fees (fee_type, club_event_id, player_id, manual_name, manual_email, amount_cents, season_id)
    VALUES ('event', p_event_id, NULL, left(v_name, 120), v_email, v_event.cost_cents,
            (SELECT s.id FROM seasons s WHERE s.active_flag = TRUE LIMIT 1))
    ON CONFLICT (club_event_id, lower(manual_email)) WHERE fee_type = 'event' AND player_id IS NULL
    DO NOTHING
    RETURNING id INTO v_fee;
  END IF;

  UPDATE registration_import_entries
     SET external_signup_id = v_signup,
         fee_id = v_fee,
         fee_created_by_import = v_fee IS NOT NULL,
         updated_at = now()
   WHERE id = p_entry_id;

  INSERT INTO guest_waiver_invites (email, target_kind, target_id, import_entry_id)
  VALUES (v_email, 'club_event', p_event_id, p_entry_id)
  ON CONFLICT (email, target_kind, target_id) DO UPDATE
    SET cancelled_at = NULL, import_entry_id = EXCLUDED.import_entry_id
    WHERE guest_waiver_invites.sent_at IS NULL AND guest_waiver_invites.cancelled_at IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'signup_id', v_signup, 'fee_id', v_fee);
END;
$function$;

-- Removes the guest's place. A paid fee stops it before anything is removed;
-- registration_import_retire (00283) then deletes the unpaid fee this import
-- created and cancels an unsent invite.
CREATE OR REPLACE FUNCTION public.club_event_external_retire(p_entry_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_entry registration_import_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM registration_import_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'entry_not_found';
  END IF;
  IF v_entry.fee_id IS NOT NULL AND v_entry.fee_created_by_import
     AND EXISTS (SELECT 1 FROM club_fees f WHERE f.id = v_entry.fee_id AND f.paid_at IS NOT NULL) THEN
    RETURN 'fee_paid';
  END IF;
  IF v_entry.external_signup_id IS NOT NULL THEN
    DELETE FROM club_event_external_signups WHERE id = v_entry.external_signup_id;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_external_sign_up(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.club_event_external_retire(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_bad text[] := ARRAY[]::text[];
  v_fn  text;
  v_src text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.club_event_taken(uuid)',
    'public.club_event_sign_up(uuid, uuid)',
    'public.claim_named_fees_for_player()',
    'public.club_event_external_sign_up(uuid, text, text, uuid)',
    'public.club_event_external_retire(uuid)'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn::regprocedure AND p.prosecdef
                     AND 'search_path=public, pg_temp' = ANY (p.proconfig)) THEN
      v_bad := array_append(v_bad, v_fn || ' is not SECURITY DEFINER with the pinned search_path');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = v_fn::regprocedure AND a.privilege_type = 'EXECUTE'
                  AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'data_api_reader')))) THEN
      v_bad := array_append(v_bad, v_fn || ' is executable beyond the service role');
    END IF;
  END LOOP;

  -- The sign-up still locks the event before it counts, and counts both tables.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.club_event_sign_up(uuid, uuid)'::regprocedure;
  IF position('FOR NO KEY UPDATE' in v_src) = 0
     OR position('public.club_event_taken(p_event_id)' in v_src) = 0
     OR position('FOR NO KEY UPDATE' in v_src) > position('public.club_event_taken(p_event_id)' in v_src)
     OR position('public.club_event_taken(p_event_id)' in v_src) > position('INSERT INTO public.club_event_signups' in v_src) THEN
    v_bad := array_append(v_bad, 'club_event_sign_up does not lock, then count both tables, then insert');
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.club_event_taken(uuid)'::regprocedure;
  IF position('club_event_external_signups' in v_src) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_taken does not count the guests');
  END IF;

  IF has_table_privilege('data_api_reader', 'public.club_event_external_signups', 'SELECT')
     OR has_table_privilege('anon', 'public.club_event_external_signups', 'SELECT')
     OR has_table_privilege('authenticated', 'public.club_event_external_signups', 'SELECT') THEN
    v_bad := array_append(v_bad, 'club_event_external_signups is readable beyond the service role');
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.club_event_external_signups'::regclass) THEN
    v_bad := array_append(v_bad, 'club_event_external_signups has row level security off');
  END IF;

  IF to_regclass('public.club_fees_event_manual_email_key') IS NULL THEN
    v_bad := array_append(v_bad, 'club_fees_event_manual_email_key is missing');
  END IF;
  IF EXISTS (SELECT 1 FROM merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, 'merge_players_unhandled is not empty');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00284 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00284 verified: guests share a club event''s places, owe a named fee, and nothing outside the service role can see them.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
