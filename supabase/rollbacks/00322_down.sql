-- ============================================================
-- ROLLBACK OF 00322: the desk walk-in spares a fee that holds a receipt
--
-- Puts back 00317's club_event_desk_entry_walk_in, which deletes every unpaid
-- event fee of the players it is given, receipt or not. The console still
-- passes only the players its own add brought in, so this undoes the database
-- backstop only.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
--
-- The function is restated whole and verbatim from 00317, under the same
-- signature and grants.
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

NOTIFY pgrst, 'reload schema';
