-- ============================================================
-- 00331: A GROUP CAN BE CAPPED IN TIME
--
-- Round-robin groups overrun. The desk sets a time on a groups stage, a pool
-- or one group; at that time every match of it not yet on court is voided,
-- the ones on court finish, and the table stands as it is. "Cap now" does the
-- same at once.
--
-- AUTOMATIC, IN SQL. The cap is applied by a pg_cron job every minute that is
-- pure SQL: no pg_net call and no console route, so it never reaches another
-- deployment's console, and no member's capability is asked because none is
-- needed. Voiding a pending or ready group match is safe here: it has no
-- rating to reverse (elo_snapshot IS NULL is pinned) and a group match routes
-- nobody onward (no winner_to_match_id), so nothing needs clearing. The job
-- asks the group_time_cap kill switch itself, which makes that switch read in
-- SQL as well as in the console.
--
-- THE LOCK ORDER is the field's: the advisory lock, then the tournament row,
-- then the event row, then the cap row.
--
-- No player FK: the actor is in tournament_audit_log.performed_by, so
-- merge_players_disposable is not restated.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regprocedure('public.release_flag_on(text)') IS NULL THEN
    RAISE EXCEPTION '00331 needs 00318: public.release_flag_on is missing';
  END IF;
  IF to_regclass('public.tournament_match_notes') IS NULL THEN
    RAISE EXCEPTION '00331 needs 00118: public.tournament_match_notes is missing';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.stage_group_time_caps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  stage        smallint NOT NULL CHECK (stage BETWEEN 1 AND 8),
  -- A null group is the whole pool; a null pool is the whole stage.
  pool_number  smallint,
  group_number smallint,
  cap_at       timestamptz NOT NULL,
  applied_at   timestamptz,
  applied_how  text CHECK (applied_how IN ('desk', 'automatic')),
  voided       integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_group_time_caps_scope CHECK (group_number IS NULL OR pool_number IS NOT NULL)
);

COMMENT ON TABLE public.stage_group_time_caps IS
  'A time after which a groups stage, pool or group plays no new match (00331). Applied once, by the desk or the minute job.';

CREATE UNIQUE INDEX IF NOT EXISTS stage_group_time_caps_one_per_scope
  ON public.stage_group_time_caps (event_id, stage, COALESCE(pool_number, 0), COALESCE(group_number, 0));
CREATE INDEX IF NOT EXISTS stage_group_time_caps_due
  ON public.stage_group_time_caps (cap_at) WHERE applied_at IS NULL;

ALTER TABLE public.stage_group_time_caps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stage_group_time_caps FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stage_group_time_caps TO service_role;

CREATE OR REPLACE FUNCTION public.apply_group_time_cap(p_cap_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_format     text;
  v_cap        public.stage_group_time_caps%ROWTYPE;
  v_ids        uuid[];
  v_how        text := CASE WHEN p_actor IS NULL THEN 'automatic' ELSE 'desk' END;
BEGIN
  SELECT c.event_id INTO v_event FROM stage_group_time_caps c WHERE c.id = p_cap_id;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cap_not_found');
  END IF;
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = v_event;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));
  PERFORM 1 FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;
  SELECT e.status::text, e.format::text INTO v_status, v_format
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  SELECT * INTO v_cap FROM stage_group_time_caps c WHERE c.id = p_cap_id FOR UPDATE;

  IF v_cap.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'voided', COALESCE(v_cap.voided, 0));
  END IF;
  IF v_format IS DISTINCT FROM 'staged' OR v_status NOT IN ('live', 'pool_live') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_status', 'event_status', v_status);
  END IF;

  -- Live matches finish. A rated row is never voided here: it would need its
  -- rating reversed, which is the console's.
  WITH capped AS (
    UPDATE tournament_matches m
       SET status = 'voided', updated_at = now()
     WHERE m.event_id = v_event
       AND m.stage = v_cap.stage
       AND (v_cap.pool_number IS NULL OR m.pool_number = v_cap.pool_number)
       AND (v_cap.group_number IS NULL OR m.group_number = v_cap.group_number)
       AND m.status IN ('pending', 'ready')
       AND m.elo_snapshot IS NULL
       AND m.is_bye IS NOT TRUE
    RETURNING m.id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_ids FROM capped;

  INSERT INTO tournament_match_notes (match_id, note, author_id)
  SELECT id, 'Time cap reached', p_actor FROM unnest(v_ids) AS id
  ON CONFLICT (match_id) DO UPDATE
    SET note = EXCLUDED.note, author_id = EXCLUDED.author_id, updated_at = now();

  UPDATE stage_group_time_caps
     SET applied_at = now(), applied_how = v_how, voided = cardinality(v_ids)
   WHERE id = p_cap_id;

  INSERT INTO tournament_audit_log (tournament_id, event_id, action, performed_by, details)
  VALUES (v_tournament, v_event, 'group_time_cap_applied', p_actor,
          jsonb_build_object('cap_id', p_cap_id, 'stage', v_cap.stage, 'pool', v_cap.pool_number,
                             'group', v_cap.group_number, 'match_ids', to_jsonb(v_ids), 'how', v_how));

  RETURN jsonb_build_object('ok', true, 'already', false, 'event_id', v_event,
                            'tournament_id', v_tournament, 'voided', cardinality(v_ids));
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_group_time_cap(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_group_time_cap(uuid, uuid) TO service_role;

-- The minute job. Twenty a tick, oldest first; SKIP LOCKED so a tick that
-- overlaps the desk's Cap now, or the previous tick, passes the row by.
CREATE OR REPLACE FUNCTION public.apply_due_group_time_caps()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id      uuid;
  v_applied integer := 0;
BEGIN
  IF NOT release_flag_on('group_time_cap') THEN
    RETURN 0;
  END IF;
  FOR v_id IN
    SELECT c.id FROM stage_group_time_caps c
     WHERE c.applied_at IS NULL AND c.cap_at <= now()
     ORDER BY c.cap_at
     LIMIT 20
     FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      IF COALESCE((apply_group_time_cap(v_id, NULL)->>'ok')::boolean, false) THEN
        v_applied := v_applied + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One cap that fails never holds up the others.
      RAISE WARNING 'apply_due_group_time_caps(%): %', v_id, SQLERRM;
    END;
  END LOOP;
  RETURN v_applied;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_due_group_time_caps() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_due_group_time_caps() TO service_role;

-- GUARDED: a database without pg_cron skips the schedule with a notice, and
-- the desk's Cap now still works.
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '00331: pg_cron is missing, group-time-caps is NOT scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule('group-time-caps')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'group-time-caps');
  PERFORM cron.schedule('group-time-caps', '* * * * *', 'SELECT public.apply_due_group_time_caps();');
END
$cron$;

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_fn  text;
BEGIN
  IF to_regclass('public.stage_group_time_caps') IS NULL THEN
    v_bad := array_append(v_bad, 'stage_group_time_caps is missing');
  ELSE
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stage_group_time_caps'::regclass) THEN
      v_bad := array_append(v_bad, 'stage_group_time_caps has RLS off');
    END IF;
    IF has_table_privilege('anon', 'public.stage_group_time_caps', 'SELECT')
       OR has_table_privilege('authenticated', 'public.stage_group_time_caps', 'SELECT') THEN
      v_bad := array_append(v_bad, 'stage_group_time_caps is readable by anon or authenticated');
    END IF;
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.apply_group_time_cap(uuid, uuid)',
    'public.apply_due_group_time_caps()'] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      v_bad := array_append(v_bad, v_fn || ' is missing');
    ELSIF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, v_fn || ' is executable by anon or authenticated');
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00331 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00331 verified: stage_group_time_caps and its two functions are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
