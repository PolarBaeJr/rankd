-- ============================================================
-- 00306: AN OFFICER ADDS SOMEBODY TO A CLUB EVENT BY HAND
--
-- Until now a club event's list filled only from the app, the Google Form and
-- the door (a walk-in, who pays nothing). Somebody who paid cash, or who does
-- not use the app, email or the Form at all, could not be put on it. This file
-- lets an officer add them from the event page, with what they paid and their
-- answers, and nothing else asked: no account, no email, no waiver.
--
-- WHAT IS ADDED
--   1. club_event_signups.answers: the Form's other questions, as answered by
--      hand ({"question title": "answer"}). The Form's own answers are not
--      kept anywhere; these are.
--   2. club_event_add_by_hand(): one call that signs the person up, sets their
--      preferred partner, answers and (for a new guest) photo consent, and
--      marks the event fee paid when they paid.
--
-- EVERYBODY ADDED IS A PLAYER RECORD, a member or a guest (00292), never a
-- club_event_external_signups row. A Form non-member becomes a guest record
-- only when the event is linked to a tournament, and one with no email never
-- does (00294), so they could never be entered. A guest record made here is
-- signed up like a member: the fee trigger charges them, and once the event
-- runs as a tournament the link trigger enters them (00292), as for anybody.
--
-- NO EMAIL. players.email is NOT NULL and unique, so a guest who gave none
-- gets guest+<uuid>@no-email.invalid. .invalid is reserved (RFC 2606) and can
-- never be delivered. Guests are never mailed anyway (sendCategoryEmail), and
-- sendEmail refuses any .invalid address outright, so no send can bounce.
--
-- The officer goes in audit_logs (the action), and in club_fees.marked_by as
-- every mark-paid does. No new player column.
-- ============================================================

BEGIN;

ALTER TABLE public.club_event_signups
  ADD COLUMN IF NOT EXISTS answers jsonb;

ALTER TABLE public.club_event_signups
  DROP CONSTRAINT IF EXISTS club_event_signups_answers_shape;
ALTER TABLE public.club_event_signups
  ADD CONSTRAINT club_event_signups_answers_shape
  CHECK (answers IS NULL OR (jsonb_typeof(answers) = 'object' AND octet_length(answers::text) <= 20000));

COMMENT ON COLUMN public.club_event_signups.answers IS
  'Answers to the event Form''s other questions, typed by an officer who added them by hand (00306): {"question title": "answer"}. NULL for everybody else.';

CREATE OR REPLACE FUNCTION public.club_event_add_by_hand(
  p_event_id uuid,
  p_player_id uuid,
  p_name text,
  p_email text,
  p_partner text,
  p_media_consent boolean,
  p_answers jsonb,
  p_paid_method text,
  p_actor uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event    public.club_events%ROWTYPE;
  v_player   uuid := p_player_id;
  v_name     text := btrim(COALESCE(p_name, ''));
  v_email    text := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  v_partner  text := NULLIF(btrim(COALESCE(p_partner, '')), '');
  v_method   text := NULLIF(btrim(COALESCE(p_paid_method, '')), '');
  v_answers  jsonb;
  v_first    text;
  v_status   text;
  v_banned   boolean;
  v_deleting timestamptz;
  v_guest    boolean;
  v_made     boolean := false;
  v_fee      uuid;
  v_paid     boolean := false;
BEGIN
  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_event.status = 'cancelled' THEN RETURN jsonb_build_object('ok', false, 'reason', 'cancelled'); END IF;

  IF v_partner IS NOT NULL AND char_length(v_partner) > 120 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_partner');
  END IF;
  IF v_method IS NOT NULL AND (char_length(v_method) > 60 OR v_method = 'waived') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_method');
  END IF;
  -- Only answered questions are kept, so a skipped one leaves no key.
  IF p_answers IS NOT NULL THEN
    IF jsonb_typeof(p_answers) <> 'object' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bad_answers');
    END IF;
    SELECT jsonb_object_agg(key, btrim(value #>> '{}'))
      INTO v_answers
      FROM jsonb_each(p_answers)
     WHERE jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> '';
    IF EXISTS (SELECT 1 FROM jsonb_each(p_answers)
                WHERE jsonb_typeof(value) <> 'string' OR char_length(key) > 300
                   OR char_length(value #>> '{}') > 2000)
       OR (SELECT count(*) FROM jsonb_object_keys(p_answers)) > 40 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bad_answers');
    END IF;
  END IF;

  IF v_player IS NULL THEN
    IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bad_name');
    END IF;
    IF v_email IS NOT NULL THEN
      IF char_length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR v_email LIKE '%.invalid' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_email');
      END IF;
      SELECT p.id, p.is_guest INTO v_player, v_guest FROM public.players p WHERE lower(p.email) = v_email;
      -- A member's email: they are added as the member, from the member tab.
      IF v_player IS NOT NULL AND NOT v_guest THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'email_is_member');
      END IF;
      IF EXISTS (SELECT 1 FROM public.club_event_external_signups x
                  WHERE x.event_id = p_event_id AND lower(x.email) = v_email) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
      END IF;
    END IF;
    IF v_player IS NULL THEN
      v_first := split_part(v_name, ' ', 1);
      v_player := public.create_guest_player(
        COALESCE(v_email, 'guest+' || gen_random_uuid()::text || '@no-email.invalid'),
        v_first, NULLIF(btrim(substr(v_name, char_length(v_first) + 1)), ''), v_name);
      v_made := true;
    END IF;
    -- Photo consent is the guest's own answer, given to the officer. A
    -- member's stays theirs to set in the app.
    IF p_media_consent IS NOT NULL THEN
      UPDATE public.players SET media_consent = p_media_consent
       WHERE id = v_player AND is_guest AND media_consent IS DISTINCT FROM p_media_consent;
    END IF;
  ELSE
    SELECT p.status::text, p.is_banned, p.deletion_requested_at
      INTO v_status, v_banned, v_deleting
      FROM public.players p WHERE p.id = v_player;
    IF v_status IS NULL OR v_banned OR v_deleting IS NOT NULL
       OR v_status IN ('pending_approval', 'suspended') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_event_signups s
              WHERE s.event_id = p_event_id AND s.player_id = v_player) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- Over capacity if need be, as at the door: an officer is deciding. The fee
  -- trigger charges the event's cost; a linked event's trigger enters them.
  INSERT INTO public.club_event_signups (event_id, player_id, preferred_partner, answers)
  VALUES (p_event_id, v_player, v_partner, v_answers);
  UPDATE public.club_event_waitlist SET status = 'promoted', resolved_at = now()
   WHERE event_id = p_event_id AND player_id = v_player AND status = 'waiting';

  SELECT f.id, f.paid_at IS NOT NULL INTO v_fee, v_paid
    FROM public.club_fees f
   WHERE f.fee_type = 'event' AND f.club_event_id = p_event_id AND f.player_id = v_player;
  IF v_fee IS NOT NULL AND v_method IS NOT NULL AND NOT v_paid THEN
    UPDATE public.club_fees
       SET paid_at = now(), method = v_method, marked_by = p_actor
     WHERE id = v_fee AND paid_at IS NULL;
    v_paid := true;
  END IF;

  RETURN jsonb_build_object('ok', true, 'player_id', v_player, 'record_made', v_made,
                            'fee_id', v_fee, 'paid', v_paid);
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_add_by_hand(uuid, uuid, text, text, text, boolean, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_add_by_hand(uuid, uuid, text, text, text, boolean, jsonb, text, uuid)
  TO service_role;

-- ---- POSTCONDITIONS ---------------------------------------------------------
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_event_signups' AND column_name = 'answers') THEN
    RAISE EXCEPTION '00306: club_event_signups.answers is missing';
  END IF;
  IF has_function_privilege('anon', 'public.club_event_add_by_hand(uuid,uuid,text,text,text,boolean,jsonb,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.club_event_add_by_hand(uuid,uuid,text,text,text,boolean,jsonb,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00306: club_event_add_by_hand is executable by a client role';
  END IF;
END
$post$;

COMMIT;
