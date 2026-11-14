-- ============================================================
-- 00325: ENTRIES CONFIRM BEFORE THE DAY
--
-- The club's standard: 48 hours before the start a member entered in an event
-- that asks for it is told to confirm their place, and an entry nobody
-- confirmed by 24 hours before the start goes to the waitlist. The hours are
-- the event's own (00324). The console's job (/api/cron/event-confirmations,
-- behind the release kill switch entry_confirmation) sends the email, the
-- push and the in-app notice; this file decides who is asked and who is
-- released, under the locks the entry paths take.
--
-- WHAT IS ADDED
--   1. event_start_instant(tournament): the start date at the start time, club
--      time, 09:00 when the tournament has no start time. club_local_instant
--      (00110), never AT TIME ZONE.
--   2. open_event_confirmations(): one pending row per member of every active
--      entry in an event whose confirmation window is open. Both partners of a
--      pair are asked. Idempotent: ON CONFLICT DO NOTHING.
--   3. claim_event_confirmation_requests(limit): the registration mail's claim
--      (00283): three attempts, a fifteen-minute stale window, SKIP LOCKED, so
--      two backends dispatched on the same tick never claim the same row.
--   4. record_event_confirmation_receipt(id, notified, outcome, error).
--   5. confirm_event_entry(event, player, actor): the member's confirm, or the
--      desk's on their behalf. Either partner confirming keeps the pair.
--   6. release_unconfirmed_event_entries(limit): at the deadline, each entry
--      every member of which was emailed and none confirmed is withdrawn
--      through set_field_entry_status, and the freed places go to the
--      waitlist when it promotes automatically. A member the email never
--      reached is NEVER released: their rows become 'unreached' and the entry
--      stays. No warning is written for a release.
--   7. The schedule: every five minutes, the registration mail's call shape.
--
-- THE LOCK ORDER is fill_event_from_waitlist's (00278): the field's advisory
-- lock, then the tournament row, then the event row. set_field_entry_status
-- and fill_event_from_waitlist take the same locks again inside, which the
-- transaction already holds.
--
-- NOTHING ELSE IS RESTATED. enter_tournament_event, join_event_waitlist,
-- fill_event_from_waitlist, set_field_entry_status and
-- add_participants_under_field_lock are called, never redefined.
--
-- PRECONDITIONS: 00324 (the table and the event columns), 00278
-- (fill_event_from_waitlist), 00110 (club_local_instant).
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regclass('public.tournament_event_confirmations') IS NULL THEN
    RAISE EXCEPTION '00325 needs 00324: public.tournament_event_confirmations is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournament_events'
                    AND column_name = 'confirm_deadline_hours') THEN
    RAISE EXCEPTION '00325 needs 00324: tournament_events.confirm_deadline_hours is missing';
  END IF;
  IF to_regprocedure('public.fill_event_from_waitlist(uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '00325 needs 00278: public.fill_event_from_waitlist is missing';
  END IF;
  IF to_regprocedure('public.club_local_instant(date, time without time zone)') IS NULL THEN
    RAISE EXCEPTION '00325 needs 00110: public.club_local_instant is missing';
  END IF;
END
$pre$;

-- ---- 1. the start -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.event_start_instant(p_tournament_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT club_local_instant(t.start_date, COALESCE(t.starts_time, time '09:00'))
    FROM tournaments t
   WHERE t.id = p_tournament_id;
$function$;

-- ---- 2. who is asked ----------------------------------------------------------
-- An entry is active while it is registered or checked in. A member who was a
-- solo entrant when asked and has since been paired keeps their row, pointed
-- at the pair.
CREATE OR REPLACE FUNCTION public.open_event_confirmations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_events  uuid[];
  v_singles integer;
  v_pairs   integer;
BEGIN
  SELECT COALESCE(array_agg(e.id), '{}') INTO v_events
    FROM tournament_events e
    JOIN tournaments t ON t.id = e.tournament_id
   WHERE e.confirm_required
     AND e.status::text IN ('registration', 'checkin')
     AND NOT COALESCE(e.draw_locked, false)
     AND NOT COALESCE(e.external_event, false)
     AND t.suspended_at IS NULL
     AND t.status::text NOT IN ('completed', 'archived')
     AND now() >= event_start_instant(t.id) - make_interval(hours => e.confirm_opens_hours)
     AND now() <  event_start_instant(t.id) - make_interval(hours => e.confirm_deadline_hours);
  IF cardinality(v_events) = 0 THEN
    RETURN 0;
  END IF;

  WITH inserted AS (
    INSERT INTO tournament_event_confirmations (event_id, player_id, participant_id)
    SELECT tp.event_id, tp.player_id, tp.id
      FROM tournament_participants tp
     WHERE tp.event_id = ANY (v_events)
       AND tp.status::text IN ('registered', 'checked_in')
    ON CONFLICT (event_id, player_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_singles FROM inserted;

  WITH members AS (
    SELECT pr.event_id, pr.player1_id AS player_id, pr.id AS pair_id
      FROM tournament_pairs pr
     WHERE pr.event_id = ANY (v_events)
       AND pr.status::text IN ('registered', 'checked_in') AND pr.player1_id IS NOT NULL
    UNION ALL
    SELECT pr.event_id, pr.player2_id, pr.id
      FROM tournament_pairs pr
     WHERE pr.event_id = ANY (v_events)
       AND pr.status::text IN ('registered', 'checked_in') AND pr.player2_id IS NOT NULL
  )
  UPDATE tournament_event_confirmations c
     SET pair_id = m.pair_id, participant_id = NULL
    FROM members m
   WHERE c.event_id = m.event_id AND c.player_id = m.player_id
     AND c.status = 'pending' AND c.pair_id IS NULL;

  WITH members AS (
    SELECT pr.event_id, pr.player1_id AS player_id, pr.id AS pair_id
      FROM tournament_pairs pr
     WHERE pr.event_id = ANY (v_events)
       AND pr.status::text IN ('registered', 'checked_in') AND pr.player1_id IS NOT NULL
    UNION ALL
    SELECT pr.event_id, pr.player2_id, pr.id
      FROM tournament_pairs pr
     WHERE pr.event_id = ANY (v_events)
       AND pr.status::text IN ('registered', 'checked_in') AND pr.player2_id IS NOT NULL
  ), inserted AS (
    INSERT INTO tournament_event_confirmations (event_id, player_id, pair_id)
    SELECT m.event_id, m.player_id, m.pair_id FROM members m
    ON CONFLICT (event_id, player_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_pairs FROM inserted;

  RETURN v_singles + v_pairs;
END;
$function$;

-- ---- 3. the claim -------------------------------------------------------------
-- To the address on the ACCOUNT. A member with no address is still returned, so
-- the job writes their in-app notice and records the mail as suppressed; a
-- deleted account is not.
CREATE OR REPLACE FUNCTION public.claim_event_confirmation_requests(p_limit integer)
RETURNS TABLE(confirmation_id uuid, player_id uuid, email text, first_name text,
              tournament_id uuid, tournament_name text, event_id uuid, event_type text,
              deadline_at timestamptz, already_notified boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT c.id
      FROM tournament_event_confirmations c
      JOIN tournament_events e ON e.id = c.event_id
     WHERE c.status = 'pending'
       AND c.email_sent_at IS NULL
       AND c.email_outcome IS DISTINCT FROM 'suppressed'
       AND c.email_attempts < 3
       AND (c.email_attempted_at IS NULL
            OR c.email_attempted_at < now() - interval '15 minutes')
       AND event_start_instant(e.tournament_id) - make_interval(hours => e.confirm_deadline_hours) > now()
     ORDER BY c.created_at
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 0), 50))
     FOR UPDATE OF c SKIP LOCKED
  ), claimed AS (
    UPDATE tournament_event_confirmations c
       SET email_attempted_at = now(), email_attempts = c.email_attempts + 1
      FROM picked
     WHERE c.id = picked.id
    RETURNING c.id, c.player_id, c.event_id, c.notified_at
  )
  SELECT cl.id, cl.player_id, p.email, p.first_name,
         t.id, t.name, te.id, te.event_type::text,
         event_start_instant(t.id) - make_interval(hours => te.confirm_deadline_hours),
         cl.notified_at IS NOT NULL
    FROM claimed cl
    JOIN players p ON p.id = cl.player_id
    JOIN tournament_events te ON te.id = cl.event_id
    JOIN tournaments t ON t.id = te.tournament_id
   WHERE p.email IS NULL OR p.email NOT LIKE '%@deleted.invalid';
END;
$function$;

-- ---- 4. the receipt -----------------------------------------------------------
-- p_notified: the in-app row committed. p_error is a short reason, never an
-- address.
CREATE OR REPLACE FUNCTION public.record_event_confirmation_receipt(
  p_id uuid, p_notified boolean, p_outcome text, p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_outcome NOT IN ('sent', 'suppressed', 'failed') THEN
    RAISE EXCEPTION 'unknown confirmation mail outcome %', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE tournament_event_confirmations
     SET notified_at   = CASE WHEN p_notified THEN COALESCE(notified_at, now()) ELSE notified_at END,
         email_sent_at = CASE WHEN p_outcome = 'sent' THEN now() ELSE email_sent_at END,
         email_outcome = p_outcome,
         email_error   = CASE WHEN p_outcome = 'sent' THEN NULL ELSE left(p_error, 200) END
   WHERE id = p_id;
END;
$function$;

-- ---- 5. the confirm -----------------------------------------------------------
-- p_actor NULL is the member's own press; the desk passes its id, and may
-- confirm after the deadline for an entry that was not released.
CREATE OR REPLACE FUNCTION public.confirm_event_entry(p_event_id uuid, p_player_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row        record;
  v_tournament uuid;
  v_deadline   timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT c.* INTO v_row
    FROM tournament_event_confirmations c
   WHERE c.event_id = p_event_id AND c.player_id = p_player_id
     FOR UPDATE;
  IF NOT FOUND OR v_row.status = 'void' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_asked');
  END IF;

  SELECT e.tournament_id,
         event_start_instant(e.tournament_id) - make_interval(hours => e.confirm_deadline_hours)
    INTO v_tournament, v_deadline
    FROM tournament_events e WHERE e.id = p_event_id;

  IF v_row.status = 'confirmed' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'event_id', p_event_id, 'tournament_id', v_tournament);
  END IF;
  IF v_row.status = 'released' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'released');
  END IF;
  IF p_actor IS NULL AND now() >= v_deadline THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'past_deadline', 'deadline_at', v_deadline);
  END IF;

  -- Either partner keeps the pair: every row of the pair is confirmed at once.
  UPDATE tournament_event_confirmations c
     SET status = 'confirmed', confirmed_at = now(),
         confirmed_by = COALESCE(p_actor, p_player_id), resolved_at = now()
   WHERE c.event_id = p_event_id
     AND c.status IN ('pending', 'unreached')
     AND (c.id = v_row.id OR (v_row.pair_id IS NOT NULL AND c.pair_id = v_row.pair_id));

  RETURN jsonb_build_object('ok', true, 'already', false, 'event_id', p_event_id, 'tournament_id', v_tournament);
END;
$function$;

-- ---- 6. the release -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_unconfirmed_event_entries(p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      record;
  v_entry      record;
  v_tournament uuid;
  v_t_name     text;
  v_status     text;
  v_locked     boolean;
  v_required   boolean;
  v_external   boolean;
  v_deadline   timestamptz;
  v_enabled    boolean;
  v_auto       boolean;
  v_label      text;
  v_set        jsonb;
  v_fill       jsonb;
  v_released   integer;
  v_promoted   jsonb;
  v_events     jsonb := '[]'::jsonb;
BEGIN
  FOR v_event IN
    SELECT DISTINCT c.event_id
      FROM tournament_event_confirmations c
      JOIN tournament_events e ON e.id = c.event_id
     WHERE c.status = 'pending'
       AND now() >= event_start_instant(e.tournament_id) - make_interval(hours => e.confirm_deadline_hours)
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 0), 50))
  LOOP
    -- Which tournament, unlocked, purely to know which row to lock next.
    SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = v_event.event_id;
    CONTINUE WHEN v_tournament IS NULL;

    PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event.event_id::text));
    SELECT t.name INTO v_t_name FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;
    SELECT e.status::text, e.draw_locked, e.confirm_required, e.external_event,
           event_start_instant(e.tournament_id) - make_interval(hours => e.confirm_deadline_hours),
           e.waitlist_enabled, e.waitlist_auto_promote, initcap(replace(e.event_type::text, '_', ' '))
      INTO v_status, v_locked, v_required, v_external, v_deadline, v_enabled, v_auto, v_label
      FROM tournament_events e WHERE e.id = v_event.event_id FOR UPDATE;

    -- Re-checked under the locks. The deadline could only have moved later.
    CONTINUE WHEN now() < v_deadline;

    -- The question no longer applies: the event moved on, was drawn, or stopped
    -- asking. Its pending rows are closed so the sweep does not return to them.
    IF v_status NOT IN ('registration', 'checkin') OR COALESCE(v_locked, false)
       OR NOT COALESCE(v_required, false) OR COALESCE(v_external, false) THEN
      UPDATE tournament_event_confirmations c
         SET status = 'void', resolved_at = now()
       WHERE c.event_id = v_event.event_id AND c.status = 'pending';
      CONTINUE;
    END IF;

    -- A partner already confirmed: the pair is kept.
    UPDATE tournament_event_confirmations c
       SET status = 'confirmed', confirmed_at = now(), resolved_at = now()
     WHERE c.event_id = v_event.event_id AND c.status = 'pending' AND c.pair_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM tournament_event_confirmations o
                    WHERE o.pair_id = c.pair_id AND o.status = 'confirmed');

    -- An entry no longer waiting (withdrawn on its own, checked in, gone) is
    -- not released and nobody is told it was.
    UPDATE tournament_event_confirmations c
       SET status = 'void', resolved_at = now()
     WHERE c.event_id = v_event.event_id AND c.status = 'pending'
       AND ((c.participant_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM tournament_participants tp
               WHERE tp.id = c.participant_id AND tp.status::text = 'registered'))
         OR (c.pair_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM tournament_pairs pr
               WHERE pr.id = c.pair_id AND pr.status::text = 'registered')));

    v_released := 0;
    FOR v_entry IN
      SELECT COALESCE(c.pair_id, c.participant_id) AS entry_id,
             (c.pair_id IS NOT NULL) AS is_pair,
             bool_and(c.email_sent_at IS NOT NULL) AS all_reached,
             array_agg(c.player_id) AS players
        FROM tournament_event_confirmations c
       WHERE c.event_id = v_event.event_id AND c.status = 'pending'
       GROUP BY 1, 2
    LOOP
      -- NEVER RELEASED UNREACHED. A member the email did not reach was never
      -- asked, so the whole entry stays and its rows say why.
      IF NOT v_entry.all_reached THEN
        UPDATE tournament_event_confirmations c
           SET status = 'unreached', resolved_at = now()
         WHERE c.event_id = v_event.event_id AND c.status = 'pending'
           AND COALESCE(c.pair_id, c.participant_id) = v_entry.entry_id;
        CONTINUE;
      END IF;

      v_set := set_field_entry_status(v_entry.entry_id, v_entry.is_pair, 'withdrawn', NULL);
      IF NOT COALESCE((v_set->>'ok')::boolean, false) THEN
        UPDATE tournament_event_confirmations c
           SET status = 'void', resolved_at = now()
         WHERE c.event_id = v_event.event_id AND c.status = 'pending'
           AND COALESCE(c.pair_id, c.participant_id) = v_entry.entry_id;
        CONTINUE;
      END IF;

      UPDATE tournament_event_confirmations c
         SET status = 'released', resolved_at = now()
       WHERE c.event_id = v_event.event_id AND c.status = 'pending'
         AND COALESCE(c.pair_id, c.participant_id) = v_entry.entry_id;

      INSERT INTO notifications (player_id, type, title, body, metadata)
      SELECT pid, 'general', 'Your place was released',
             format('You did not confirm your place in %s at %s before the deadline, so it has gone to the waitlist. Ask a tournament admin if you think this is a mistake.', v_label, v_t_name),
             jsonb_build_object('kind', 'confirmation_released', 'event_id', v_event.event_id,
                                'tournament_id', v_tournament)
        FROM unnest(v_entry.players) AS pid;

      v_released := v_released + 1;
    END LOOP;

    v_promoted := '[]'::jsonb;
    IF v_released > 0 AND COALESCE(v_enabled, false) AND COALESCE(v_auto, false) THEN
      v_fill := fill_event_from_waitlist(v_event.event_id, NULL, NULL);
      v_promoted := COALESCE(v_fill->'promoted', '[]'::jsonb);
    END IF;

    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'event_id', v_event.event_id, 'tournament_id', v_tournament,
      'released', v_released, 'promoted', v_promoted));
  END LOOP;

  RETURN jsonb_build_object('events', v_events);
END;
$function$;

REVOKE ALL ON FUNCTION public.event_start_instant(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_event_confirmations() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_event_confirmation_requests(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_event_confirmation_receipt(uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_event_entry(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_unconfirmed_event_entries(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_start_instant(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.open_event_confirmations() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_event_confirmation_requests(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_event_confirmation_receipt(uuid, boolean, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_event_entry(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_unconfirmed_event_entries(integer) TO service_role;

-- ---- 7. the schedule ----------------------------------------------------------
-- Every five minutes, the call shape of registration-mail (00283), so it
-- follows cron_config wherever admin_url points and sends nothing until
-- reminder_secret is set. GUARDED: a database without pg_cron or pg_net skips
-- the schedule with a notice and keeps the rest of this file. Unscheduled
-- first, so a re-run edits the job.
DO $schedule$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '00325: pg_cron or pg_net is missing, event-confirmations is NOT scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule('event-confirmations')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'event-confirmations');
  PERFORM cron.schedule(
    'event-confirmations',
    '*/5 * * * *',
    $job$
    SELECT net.http_post(
      url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/event-confirmations',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || (SELECT value FROM cron_config WHERE key = 'reminder_secret')
                 ),
      body    := '{}'::jsonb
    )
    WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'reminder_secret');
    $job$
  );
END
$schedule$;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_fn  text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.event_start_instant(uuid)',
    'public.open_event_confirmations()',
    'public.claim_event_confirmation_requests(integer)',
    'public.record_event_confirmation_receipt(uuid, boolean, text, text)',
    'public.confirm_event_entry(uuid, uuid, uuid)',
    'public.release_unconfirmed_event_entries(integer)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      v_bad := array_append(v_bad, format('%s is missing', v_fn));
      CONTINUE;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is executable by anon or authenticated', v_fn));
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is not executable by service_role', v_fn));
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00325 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00325 verified: the confirmation functions are in place and the service role''s alone.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
