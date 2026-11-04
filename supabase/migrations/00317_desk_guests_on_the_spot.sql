-- ============================================================
-- 00317: THE DESK ADDS SOMEBODY ON THE SPOT
--
-- At a live event the desk adds whoever is standing there: a member, or a
-- guest by name alone, straight into the tournament event, before or after the
-- draw. Two functions make that possible; the entry itself goes through the
-- tournament's own add (add_participants_under_field_lock and the pair add),
-- so the field lock, the capacity and the entry cap all still apply.
--
--   1. create_desk_guest(): a guest player record, made exactly as
--      club_event_add_by_hand (00306) makes one for a guest with no email:
--      create_guest_player (00292) with guest+<uuid>@no-email.invalid. The
--      same function makes the same row, so erase_guest, make_guest_member,
--      the merge classification and the member export already treat it as
--      every other guest; nothing new is needed for them.
--      Until now the only way to make a guest was a club-event sign-up, which
--      00292 refuses once the linked draw is made, and which an unlinked
--      tournament does not have at all.
--
--   2. club_event_desk_entry_walk_in(): the fee left off on a LINKED club
--      event. Entering the tournament reconciles a club-event sign-up (00292,
--      origin 'tournament', so the "draw is already made" refusal is never
--      reached: the player is already in the event), and that sign-up's insert
--      charges the club-event fee (club_event_signup_fee). When the desk did
--      not tick "Charge the event fee", the sign-up is made a walk-in, as the
--      door's walk-ins are (00294), and the unpaid fee just charged is
--      removed. A fee already paid, or any fee on an unlinked event, is never
--      touched.
--
-- Both are service_role only: the console calls them after its own
-- capability check.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_desk_guest(p_display_name text, p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_first text;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'create_desk_guest needs the officer adding them' USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Type a name, up to 120 characters.' USING ERRCODE = 'check_violation';
  END IF;
  v_first := split_part(v_name, ' ', 1);
  RETURN public.create_guest_player(
    'guest+' || gen_random_uuid()::text || '@no-email.invalid',
    v_first, NULLIF(btrim(substr(v_name, char_length(v_first) + 1)), ''), v_name);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_desk_guest(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_desk_guest(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.club_event_desk_entry_walk_in(p_tournament_event_id uuid, p_player_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club    uuid;
  v_removed integer;
BEGIN
  SELECT ce.id INTO v_club FROM club_events ce WHERE ce.tournament_event_id = p_tournament_event_id;
  IF v_club IS NULL OR p_player_ids IS NULL OR cardinality(p_player_ids) = 0 THEN
    RETURN 0;
  END IF;
  UPDATE club_event_signups s SET walk_in = true
   WHERE s.event_id = v_club AND s.player_id = ANY (p_player_ids) AND NOT s.walk_in;
  DELETE FROM club_fees f
   WHERE f.fee_type = 'event' AND f.club_event_id = v_club
     AND f.player_id = ANY (p_player_ids) AND f.paid_at IS NULL;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_desk_entry_walk_in(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_desk_entry_walk_in(uuid, uuid[]) TO service_role;

DO $verify$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.create_desk_guest(text,uuid)',
    'public.club_event_desk_entry_walk_in(uuid,uuid[])'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00317 verification failed: % is executable by anon or authenticated', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00317 verification failed: % is not executable by service_role', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE '00317 verified: the desk can add a guest on the spot, and leave the club-event fee off.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
