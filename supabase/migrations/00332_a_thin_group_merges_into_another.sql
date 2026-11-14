-- ============================================================
-- 00332: A THIN GROUP MERGES INTO ANOTHER OF ITS POOL
--
-- Did not come, Left and a check-in after the draw can leave a group with
-- one or two teams. merge_stage_groups replaces two groups of a pool, neither
-- of which has played, with one round robin of everyone still in either. The
-- console builds the rows (packages/shared staged-format/merge.ts, the draw's
-- own scheduler); this deletes the two groups' rows and inserts the new ones
-- in one transaction, under the field lock, so a result or a Start that lands
-- in between refuses the whole merge.
--
-- REFUSED, each a reason: 'superseded' when the draw was redone since the
-- console read it, 'later_stage' once a later stage is drawn, and 'played',
-- 'rated' or 'live' when either group has such a match (delete_stage_matches's
-- codes, 00272). Voided rows are deleted with the rest.
--
-- WHAT A DELETE TAKES WITH IT. tournament_audit_log.match_id is ON DELETE SET
-- NULL (00139 pins it), so the audit row of a merge carries the deleted ids in
-- its details; tournament_match_notes cascades. A group row routes nobody
-- (no winner_to_match_id points at one), so nothing else names them.
--
-- WHAT IS NOT RESTATED: delete_stage_matches, publish_stage_draw and the
-- generation fence (00197), which the INSERT below still passes through.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regprocedure('public.delete_stage_matches(uuid, smallint)') IS NULL THEN
    RAISE EXCEPTION '00332 needs 00272: public.delete_stage_matches is missing';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.merge_stage_groups(
  p_event_id   uuid,
  p_stage      smallint,
  p_pool       smallint,
  p_from_group smallint,
  p_into_group smallint,
  p_generation uuid,
  p_rows       jsonb,
  p_actor      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_generation uuid;
  v_format     text;
  v_deleted    uuid[];
  v_inserted   integer;
  v_bad        integer;
BEGIN
  IF p_from_group = p_into_group OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));
  PERFORM 1 FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;
  SELECT e.draw_generation_id, e.format::text INTO v_generation, v_format
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_format IS DISTINCT FROM 'staged' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_staged');
  END IF;
  IF v_generation IS DISTINCT FROM p_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'superseded');
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_matches m WHERE m.event_id = p_event_id AND m.stage > p_stage) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'later_stage');
  END IF;

  PERFORM 1 FROM tournament_matches m
   WHERE m.event_id = p_event_id AND m.stage = p_stage AND m.pool_number = p_pool
     AND m.group_number IN (p_from_group, p_into_group)
   FOR UPDATE;
  IF EXISTS (SELECT 1 FROM tournament_matches m
              WHERE m.event_id = p_event_id AND m.stage = p_stage AND m.pool_number = p_pool
                AND m.group_number IN (p_from_group, p_into_group) AND m.elo_snapshot IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rated');
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_matches m
              WHERE m.event_id = p_event_id AND m.stage = p_stage AND m.pool_number = p_pool
                AND m.group_number IN (p_from_group, p_into_group)
                AND m.is_bye IS NOT TRUE AND m.status IN ('completed', 'walkover', 'disputed')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'played');
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_matches m
              WHERE m.event_id = p_event_id AND m.stage = p_stage AND m.pool_number = p_pool
                AND m.group_number IN (p_from_group, p_into_group) AND m.status = 'live') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'live');
  END IF;

  -- Every new row belongs to the merged group and this draw; one that does
  -- not refuses the merge before anything is deleted.
  SELECT count(*) INTO v_bad
    FROM jsonb_populate_recordset(NULL::tournament_matches, p_rows) r
   WHERE r.event_id IS DISTINCT FROM p_event_id OR r.stage IS DISTINCT FROM p_stage
      OR r.pool_number IS DISTINCT FROM p_pool OR r.group_number IS DISTINCT FROM p_into_group
      OR r.draw_generation_id IS DISTINCT FROM p_generation OR r.id IS NULL;
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_rows');
  END IF;

  WITH gone AS (
    DELETE FROM tournament_matches m
     WHERE m.event_id = p_event_id AND m.stage = p_stage AND m.pool_number = p_pool
       AND m.group_number IN (p_from_group, p_into_group)
    RETURNING m.id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_deleted FROM gone;

  INSERT INTO tournament_matches (
    id, event_id, draw_generation_id, stage, pool_number, group_number, slot, match_label,
    court, court_id, round_number, round_name, bracket_position, match_number,
    games_per_match, points_per_game, handicap_a, handicap_b, is_bye, is_third_place, status,
    winner_to_match_id, winner_to_position, loser_to_match_id, loser_to_position,
    participant_a_id, participant_b_id, pair_a_id, pair_b_id)
  SELECT
    r.id, r.event_id, r.draw_generation_id, r.stage, r.pool_number, r.group_number, r.slot, r.match_label,
    r.court, r.court_id, r.round_number, r.round_name, r.bracket_position, r.match_number,
    r.games_per_match, r.points_per_game, COALESCE(r.handicap_a, 0), COALESCE(r.handicap_b, 0),
    COALESCE(r.is_bye, false), COALESCE(r.is_third_place, false), r.status,
    r.winner_to_match_id, r.winner_to_position, r.loser_to_match_id, r.loser_to_position,
    r.participant_a_id, r.participant_b_id, r.pair_a_id, r.pair_b_id
  FROM jsonb_populate_recordset(NULL::tournament_matches, p_rows) r;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  INSERT INTO tournament_audit_log (tournament_id, event_id, action, performed_by, details)
  VALUES (v_tournament, p_event_id, 'groups_merged', p_actor,
          jsonb_build_object('stage', p_stage, 'pool', p_pool, 'from', p_from_group, 'into', p_into_group,
                             'deleted_match_ids', to_jsonb(v_deleted), 'inserted', v_inserted));

  RETURN jsonb_build_object('ok', true, 'tournament_id', v_tournament,
                            'deleted', cardinality(v_deleted), 'inserted', v_inserted);
END;
$function$;

REVOKE ALL ON FUNCTION public.merge_stage_groups(uuid, smallint, smallint, smallint, smallint, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_stage_groups(uuid, smallint, smallint, smallint, smallint, uuid, jsonb, uuid) TO service_role;

DO $verify$
DECLARE
  v_fn text := 'public.merge_stage_groups(uuid, smallint, smallint, smallint, smallint, uuid, jsonb, uuid)';
BEGIN
  IF to_regprocedure(v_fn) IS NULL THEN
    RAISE EXCEPTION '00332 verification failed: merge_stage_groups is missing';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00332 verification failed: merge_stage_groups is executable by anon or authenticated';
  END IF;
  RAISE NOTICE '00332 verified: merge_stage_groups is in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
