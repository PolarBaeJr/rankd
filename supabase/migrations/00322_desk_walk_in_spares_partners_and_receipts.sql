-- ============================================================
-- 00322: THE DESK'S WALK-IN SPARES A FEE THAT HOLDS A RECEIPT
--
-- club_event_desk_entry_walk_in (00317) leaves a linked club event's fee off
-- when the desk adds somebody on the spot without "Charge the event fee". It
-- deleted every unpaid event fee of every player it was given, and the console
-- gave it the whole entry: the person added AND the partner picked for them.
-- A partner already signed up for the club event, who had sent an e-transfer
-- screenshot that an exec had not confirmed yet, lost their fee, and with it
-- the receipt: fee_submissions references club_fees ON DELETE CASCADE
-- (00248), so the row and the record of the money went together. Their
-- sign-up was turned into a walk-in as well.
--
-- Two fixes, one here and one in the console:
--
--   1. Here: the DELETE spares any fee with a receipt waiting or confirmed,
--      with the same NOT EXISTS the withdraw trigger has used since 00248
--      (club_event_withdraw_fee), and the walk-in UPDATE spares the sign-up
--      whose fee holds one. An entrant who already sent a receipt now stays a
--      paying entrant.
--   2. In the console: Add on the spot passes only the players its own add
--      brought into the club event, never one who was signed up before.
--
-- A new file rather than an edit to 00317, which is applied. The signature,
-- the return value (the number of fees removed) and the grants are unchanged,
-- so the console's call needs nothing new.
-- ============================================================

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
   WHERE s.event_id = v_club AND s.player_id = ANY (p_player_ids) AND NOT s.walk_in
     AND NOT EXISTS (SELECT 1 FROM public.club_fees f2
                       JOIN public.fee_submissions fs ON fs.club_fee_id = f2.id
                      WHERE f2.fee_type = 'event' AND f2.club_event_id = v_club AND f2.player_id = s.player_id
                        AND fs.status IN ('submitted', 'confirmed'));
  DELETE FROM club_fees f
   WHERE f.fee_type = 'event' AND f.club_event_id = v_club
     AND f.player_id = ANY (p_player_ids) AND f.paid_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.fee_submissions s
                      WHERE s.club_fee_id = f.id AND s.status IN ('submitted', 'confirmed'));
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_desk_entry_walk_in(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_desk_entry_walk_in(uuid, uuid[]) TO service_role;

DO $verify$
DECLARE
  v_fn text := 'public.club_event_desk_entry_walk_in(uuid,uuid[])';
BEGIN
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00322 verification failed: % is executable by anon or authenticated', v_fn;
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00322 verification failed: % is not executable by service_role', v_fn;
  END IF;
  IF position('fee_submissions' IN pg_get_functiondef('public.club_event_desk_entry_walk_in(uuid, uuid[])'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00322 verification failed: % does not spare a fee that holds a receipt', v_fn;
  END IF;
  RAISE NOTICE '00322 verified: the desk walk-in leaves a fee with a receipt, and its sign-up, alone.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
