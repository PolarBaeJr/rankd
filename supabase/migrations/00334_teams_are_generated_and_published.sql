-- ============================================================
-- 00334: TEAMS ARE GENERATED AND PUBLISHED
--
-- The desk generates doubles teams days before an event and publishes them
-- (generate_teams). Pairing, splitting and swapping go through the existing
-- entry paths; the run log is tournament_audit_log rows (teams_published,
-- team_added, team_edited, team_split), so there is no new table.
--
-- ONE FUNCTION, relink_event_confirmations. Inside the confirmation window
-- (00325) a member's confirmation row is keyed to the entry they had when it
-- opened. Pairing two solos, or splitting a pair, replaces that entry, and a
-- row keyed to a deleted entry is matched by neither confirm_event_entry nor
-- release_unconfirmed_event_entries. This repoints each named member's row to
-- their current active entry: the pair they are in, else their solo entry. It
-- never writes status, so a member who confirmed stays confirmed, and with the
-- either-partner rule one confirmed partner keeps the pair. A member with no
-- active entry is left alone, and a member with no row yet gets one from
-- open_event_confirmations on its next tick.
--
-- No player FK and no new table, so merge_players_disposable is not restated.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regclass('public.tournament_event_confirmations') IS NULL THEN
    RAISE EXCEPTION '00334 needs 00324: public.tournament_event_confirmations is missing';
  END IF;
  IF to_regprocedure('public.open_event_confirmations()') IS NULL THEN
    RAISE EXCEPTION '00334 needs 00325: public.open_event_confirmations is missing';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.relink_event_confirmations(p_event_id uuid, p_player_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_paired integer;
  v_solo   integer;
BEGIN
  IF p_event_id IS NULL OR p_player_ids IS NULL OR cardinality(p_player_ids) = 0 THEN
    RETURN 0;
  END IF;

  -- In an active pair: the row is the pair's. Both columns in one statement,
  -- for tournament_event_confirmations_one_entry.
  WITH members AS (
    SELECT pr.player1_id AS player_id, pr.id AS pair_id
      FROM tournament_pairs pr
     WHERE pr.event_id = p_event_id
       AND pr.status::text IN ('registered', 'checked_in')
       AND pr.player1_id = ANY (p_player_ids)
    UNION ALL
    SELECT pr.player2_id, pr.id
      FROM tournament_pairs pr
     WHERE pr.event_id = p_event_id
       AND pr.status::text IN ('registered', 'checked_in')
       AND pr.player2_id = ANY (p_player_ids)
  ), moved AS (
    UPDATE tournament_event_confirmations c
       SET pair_id = m.pair_id, participant_id = NULL
      FROM members m
     WHERE c.event_id = p_event_id AND c.player_id = m.player_id
       AND c.pair_id IS DISTINCT FROM m.pair_id
    RETURNING 1
  )
  SELECT count(*) INTO v_paired FROM moved;

  -- Not in an active pair but entered alone: the row is the solo entry's.
  WITH solos AS (
    SELECT tp.player_id, tp.id AS participant_id
      FROM tournament_participants tp
     WHERE tp.event_id = p_event_id
       AND tp.status::text IN ('registered', 'checked_in')
       AND tp.player_id = ANY (p_player_ids)
       AND NOT EXISTS (
         SELECT 1 FROM tournament_pairs pr
          WHERE pr.event_id = p_event_id
            AND pr.status::text IN ('registered', 'checked_in')
            AND tp.player_id IN (pr.player1_id, pr.player2_id))
  ), moved AS (
    UPDATE tournament_event_confirmations c
       SET participant_id = s.participant_id, pair_id = NULL
      FROM solos s
     WHERE c.event_id = p_event_id AND c.player_id = s.player_id
       AND c.participant_id IS DISTINCT FROM s.participant_id
    RETURNING 1
  )
  SELECT count(*) INTO v_solo FROM moved;

  RETURN v_paired + v_solo;
END;
$function$;

COMMENT ON FUNCTION public.relink_event_confirmations(uuid, uuid[]) IS
  'Repoints the named members'' confirmation rows to their current active entry, pair first. Never writes status. See 00334.';

REVOKE ALL ON FUNCTION public.relink_event_confirmations(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relink_event_confirmations(uuid, uuid[]) TO service_role;

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_fn  text := 'public.relink_event_confirmations(uuid, uuid[])';
BEGIN
  IF to_regprocedure(v_fn) IS NULL THEN
    v_bad := array_append(v_bad, v_fn || ' is missing');
  ELSIF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    v_bad := array_append(v_bad, v_fn || ' is executable by anon or authenticated');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00334 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00334 verified: relink_event_confirmations is in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
