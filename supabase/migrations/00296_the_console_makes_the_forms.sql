-- ============================================================
-- 00296: THE CONSOLE MAKES THE FORMS
--
-- Until now an exec built each event's Google Form by hand, copied its id into
-- the console, bound it and typed its question titles. This file lets the
-- console make the Form itself. A small Apps Script web app, deployed once by
-- the owner under the club's Google account (integrations/google-forms/
-- form-maker.gs), copies one of two template Forms into the forms folder,
-- writes the event's title, description, payment text and (for a tournament)
-- the event choices, shares it with the reader's service account and answers
-- with the new Form's id and links. The console then binds it and saves the
-- question mapping exactly as an exec would, and from then on 00287's reader
-- reads it like any other Form.
--
-- WHAT IS ADDED
--   1. managed_registration_forms: one row per Form the console made, with its
--      target, its links, the claim the maker call holds, whether the Form is
--      taking responses and why not, and the fingerprint of the content last
--      written to it. A replaced Form is RETIRED, not deleted, so the row that
--      made a binding is always there to say so.
--   2. A data API consumer, "Google Forms made by the console", that owns the
--      bindings of these Forms. It holds no key, so it reads nothing.
--   3. registration_form_accepting: whether a Form for a target should take
--      responses now, and the reason when not. Its predicates are the refusals
--      of registration_import_apply (00292, the latest), so a Form closes when
--      every response it took would be refused anyway.
--   4. A five-minute job, managed-form-sync, that keeps each made Form in step
--      with its event: content, choices, open or closed.
--
-- ONE FORM PER TARGET. A partial unique index on each target column over rows
-- that are not retired, so two console replicas pressing Create at once make
-- one Form: the second insert answers 23505 and reads the first one's claim.
-- The claim copies 00287's: a crashed call's claim goes stale after ten
-- minutes and may be taken again.
--
-- NO PERSONAL DATA. The row holds a Form id, two Google links, short codes and
-- timestamps. There is no player column at all, not even created_by: the
-- audit row names the officer, and a player FK here would block merges
-- (00207) for nothing.
--
-- The targets are ON DELETE SET NULL, as the bindings' are: a deleted event's
-- row stays, with no target, and the job closes its Form with 'deleted'.
--
-- No new capability: making a Form is editing the event it fills, as binding
-- one is (00283).
-- ============================================================

BEGIN;

-- ---- 0. PRECONDITIONS -------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.registration_import_forms') IS NULL THEN
    RAISE EXCEPTION '00296 needs 00283 (the form import) applied first';
  END IF;
  IF to_regprocedure('public.club_event_taken(uuid)') IS NULL THEN
    RAISE EXCEPTION '00296 needs club_event_taken(uuid) (00284)';
  END IF;
  IF to_regprocedure('public.entry_window_state(timestamptz, timestamptz, timestamptz)') IS NULL THEN
    RAISE EXCEPTION '00296 needs entry_window_state (00276)';
  END IF;
  IF to_regprocedure('public.record_form_guest_waiver(uuid, text, text, boolean, text)') IS NULL THEN
    RAISE EXCEPTION '00296 needs 00295 (a form signs the guest waiver) applied first';
  END IF;
END
$pre$;

-- ---- 1. THE FORMS THE CONSOLE MADE ------------------------------------------
CREATE TABLE IF NOT EXISTS public.managed_registration_forms (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind             text NOT NULL,
  club_event_id           uuid REFERENCES public.club_events(id) ON DELETE SET NULL,
  tournament_id           uuid REFERENCES public.tournaments(id) ON DELETE SET NULL,
  generation              integer NOT NULL DEFAULT 1,
  binding_id              uuid REFERENCES public.registration_import_forms(id) ON DELETE SET NULL,
  form_id                 text,
  responder_url           text,
  edit_url                text,
  template_waiver_version text,
  state                   text NOT NULL DEFAULT 'creating',
  claimed_at              timestamptz,
  accepting               boolean,
  close_reason            text,
  closed_at               timestamptz,
  synced_fingerprint      text,
  synced_at               timestamptz,
  attempted_at            timestamptz,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT managed_registration_forms_target_kind
    CHECK (target_kind IN ('club_event', 'tournament')),
  CONSTRAINT managed_registration_forms_one_target
    CHECK (num_nonnulls(club_event_id, tournament_id) <= 1
           AND (club_event_id IS NULL OR target_kind = 'club_event')
           AND (tournament_id IS NULL OR target_kind = 'tournament')),
  CONSTRAINT managed_registration_forms_generation CHECK (generation >= 1),
  -- The same shape registration_import_forms_form_id_shape holds a bound id to.
  CONSTRAINT managed_registration_forms_form_id_shape
    CHECK (form_id IS NULL OR (char_length(btrim(form_id)) BETWEEN 1 AND 200 AND form_id = btrim(form_id))),
  CONSTRAINT managed_registration_forms_responder_url
    CHECK (responder_url IS NULL OR responder_url ~ '^https://docs\.google\.com/forms/\S+/viewform'),
  CONSTRAINT managed_registration_forms_edit_url
    CHECK (edit_url IS NULL OR edit_url ~ '^https://docs\.google\.com/forms/d/[A-Za-z0-9_-]+/edit'),
  CONSTRAINT managed_registration_forms_waiver_version
    CHECK (template_waiver_version IS NULL OR char_length(template_waiver_version) <= 40),
  CONSTRAINT managed_registration_forms_state
    CHECK (state IN ('creating', 'failed', 'unverified', 'live', 'retired')),
  CONSTRAINT managed_registration_forms_close_reason
    CHECK (close_reason IS NULL OR close_reason IN (
      'cancelled', 'deleted', 'started', 'finished', 'suspended', 'not_open', 'closed_time', 'full', 'no_events', 'draft')),
  CONSTRAINT managed_registration_forms_fingerprint
    CHECK (synced_fingerprint IS NULL OR synced_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT managed_registration_forms_last_error
    CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$')
);

COMMENT ON TABLE public.managed_registration_forms IS
  'One row per Google Form the console made through the form maker web app (00296). No personal data: a Form id, its links, short codes and times.';

CREATE UNIQUE INDEX IF NOT EXISTS managed_registration_forms_one_per_club_event
  ON public.managed_registration_forms (club_event_id)
  WHERE club_event_id IS NOT NULL AND state <> 'retired';
CREATE UNIQUE INDEX IF NOT EXISTS managed_registration_forms_one_per_tournament
  ON public.managed_registration_forms (tournament_id)
  WHERE tournament_id IS NOT NULL AND state <> 'retired';
CREATE UNIQUE INDEX IF NOT EXISTS managed_registration_forms_form_id
  ON public.managed_registration_forms (form_id)
  WHERE form_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS managed_registration_forms_due
  ON public.managed_registration_forms (state, attempted_at);

ALTER TABLE public.managed_registration_forms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.managed_registration_forms FROM PUBLIC, anon, authenticated, service_role;
-- No DELETE: a retired row is the record that a Form was made and replaced.
GRANT SELECT, INSERT, UPDATE ON public.managed_registration_forms TO service_role;

-- ---- 2. THE CONSUMER THAT OWNS THEIR BINDINGS -------------------------------
-- A binding needs a consumer (00283). This one is never issued a key.
INSERT INTO public.data_api_consumers (name, notes)
VALUES ('Google Forms made by the console',
        'Owns the bindings of the forms the console makes. Holds no key, so it reads nothing.')
ON CONFLICT (name) DO NOTHING;

-- ---- 3. WHETHER A FORM SHOULD TAKE RESPONSES ---------------------------------
-- The refusals of registration_import_apply as 00292 left them, asked of the
-- target instead of one response. A club event: cancelled, finished, started,
-- not open yet, closed, or full. A tournament: suspended, finished, no event
-- in registration, or every event in registration either outside its window
-- or full. A doubles event counts draw slots, and an odd loose entry leaves a
-- place for a partner, exactly as the apply does. A full event with a waitlist
-- still takes responses when the binding sends members to the waitlist.
CREATE OR REPLACE FUNCTION public.registration_form_accepting(
  p_kind text, p_target uuid, p_join_waitlist boolean
)
RETURNS TABLE(accepting boolean, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_club       record;
  v_tournament record;
  v_event      record;
  v_win        text;
  v_pairs      integer;
  v_unpaired   integer;
  v_before     integer;
  v_after      integer;
  v_doubles    boolean;
  v_waiting    boolean;
  v_full       boolean;
  v_any        boolean := false;
  v_not_open   boolean := false;
  v_any_full   boolean := false;
BEGIN
  IF p_kind = 'club_event' THEN
    SELECT ce.status, ce.starts_at, ce.signup_opens_at, ce.signup_closes_at, ce.capacity
      INTO v_club
      FROM club_events ce WHERE ce.id = p_target;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'deleted'::text; RETURN;
    END IF;
    IF v_club.status = 'cancelled' THEN
      RETURN QUERY SELECT false, 'cancelled'::text; RETURN;
    END IF;
    IF v_club.status NOT IN ('draft', 'published') THEN
      RETURN QUERY SELECT false, 'finished'::text; RETURN;
    END IF;
    -- A draft is not announced yet, so its Form waits closed until publish.
    IF v_club.status = 'draft' THEN
      RETURN QUERY SELECT false, 'draft'::text; RETURN;
    END IF;
    IF v_club.starts_at <= now() THEN
      RETURN QUERY SELECT false, 'started'::text; RETURN;
    END IF;
    IF v_club.signup_opens_at IS NOT NULL AND now() < v_club.signup_opens_at THEN
      RETURN QUERY SELECT false, 'not_open'::text; RETURN;
    END IF;
    IF v_club.signup_closes_at IS NOT NULL AND now() >= v_club.signup_closes_at THEN
      RETURN QUERY SELECT false, 'closed_time'::text; RETURN;
    END IF;
    IF v_club.capacity IS NOT NULL AND public.club_event_taken(p_target) >= v_club.capacity THEN
      RETURN QUERY SELECT false, 'full'::text; RETURN;
    END IF;
    RETURN QUERY SELECT true, NULL::text; RETURN;
  END IF;

  IF p_kind <> 'tournament' THEN
    RAISE EXCEPTION 'registration_form_accepting: bad kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT t.status, t.suspended_at, t.registration_opens_at, t.registration_closes_at
    INTO v_tournament
    FROM tournaments t WHERE t.id = p_target;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'deleted'::text; RETURN;
  END IF;
  IF v_tournament.suspended_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'suspended'::text; RETURN;
  END IF;
  IF v_tournament.status::text IN ('completed', 'archived') THEN
    RETURN QUERY SELECT false, 'finished'::text; RETURN;
  END IF;
  IF v_tournament.status::text = 'draft' THEN
    RETURN QUERY SELECT false, 'draft'::text; RETURN;
  END IF;

  FOR v_event IN
    SELECT e.id, e.event_type, e.registration_opens_at, e.registration_closes_at,
           e.max_participants, e.waitlist_enabled, e.external_event
      FROM tournament_events e
     WHERE e.tournament_id = p_target AND e.status = 'registration'
  LOOP
    v_any := true;
    v_win := entry_window_state(COALESCE(v_event.registration_opens_at, v_tournament.registration_opens_at),
                                COALESCE(v_event.registration_closes_at, v_tournament.registration_closes_at),
                                now());
    IF v_win = 'not_open_yet' THEN
      v_not_open := true;
      CONTINUE;
    END IF;
    IF v_win = 'closed' THEN
      CONTINUE;
    END IF;

    -- 00292's slot count, for one more respondent who is not a member.
    v_full := false;
    IF v_event.max_participants IS NOT NULL AND v_event.max_participants > 0 THEN
      v_doubles := v_event.event_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');
      SELECT COUNT(*) INTO v_pairs FROM tournament_pairs tp
       WHERE tp.event_id = v_event.id
         AND COALESCE(tp.status::text, '') NOT IN ('withdrawn', 'disqualified');
      SELECT COUNT(*) INTO v_unpaired FROM tournament_participants tpa
       WHERE tpa.event_id = v_event.id
         AND COALESCE(tpa.status::text, '') NOT IN ('withdrawn', 'disqualified');
      IF v_event.external_event THEN
        v_before := v_pairs; v_after := v_pairs + 1;
      ELSIF v_doubles THEN
        v_before := v_pairs + CEIL(v_unpaired / 2.0);
        v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);
      ELSE
        v_before := v_unpaired; v_after := v_unpaired + 1;
      END IF;
      v_full := v_after > v_event.max_participants AND v_after > v_before;
    END IF;
    -- Somebody already waiting: a newcomer is refused unless they may queue.
    SELECT EXISTS (SELECT 1 FROM tournament_event_waitlist w
                    WHERE w.event_id = v_event.id AND w.status = 'waiting') INTO v_waiting;
    IF (v_full OR v_waiting)
       AND NOT (COALESCE(p_join_waitlist, false) AND v_event.waitlist_enabled AND NOT v_event.external_event) THEN
      v_any_full := true;
      CONTINUE;
    END IF;

    RETURN QUERY SELECT true, NULL::text; RETURN;
  END LOOP;

  IF NOT v_any THEN
    RETURN QUERY SELECT false, 'no_events'::text; RETURN;
  END IF;
  IF v_not_open THEN
    RETURN QUERY SELECT false, 'not_open'::text; RETURN;
  END IF;
  IF v_any_full THEN
    RETURN QUERY SELECT false, 'full'::text; RETURN;
  END IF;
  RETURN QUERY SELECT false, 'closed_time'::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.registration_form_accepting(text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_form_accepting(text, uuid, boolean) TO service_role;

-- ---- 4. THE SCHEDULE --------------------------------------------------------
-- Every five minutes, two minutes after the reader's round, the call shape of
-- registration-form-poll (00287): it follows cron_config wherever admin_url
-- points and calls nothing until reminder_secret is set. The route itself does
-- nothing until the console has the form maker's address and secret.
DO $schedule$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '00296: pg_cron or pg_net is missing, managed-form-sync is NOT scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule('managed-form-sync')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'managed-form-sync');
  PERFORM cron.schedule(
    'managed-form-sync',
    '2-59/5 * * * *',
    $job$
    SELECT net.http_post(
      url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/managed-form-sync',
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

-- ============================================================
DO $verify$
DECLARE
  v_bad text[] := ARRAY[]::text[];
  v_fn  text := 'public.registration_form_accepting(text, uuid, boolean)';
  v_role text;
BEGIN
  IF to_regclass('public.managed_registration_forms') IS NULL THEN
    RAISE EXCEPTION '00296: managed_registration_forms is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.managed_registration_forms'::regclass) THEN
    v_bad := array_append(v_bad, 'managed_registration_forms does not have row level security on');
  END IF;

  IF NOT has_table_privilege('service_role', 'public.managed_registration_forms', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.managed_registration_forms', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.managed_registration_forms', 'UPDATE') THEN
    v_bad := array_append(v_bad, 'service_role cannot read, insert and update managed_registration_forms');
  END IF;
  IF has_table_privilege('service_role', 'public.managed_registration_forms', 'DELETE') THEN
    v_bad := array_append(v_bad, 'service_role can delete managed_registration_forms');
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'data_api_reader'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)
       AND (has_table_privilege(v_role, 'public.managed_registration_forms', 'SELECT')
            OR has_table_privilege(v_role, 'public.managed_registration_forms', 'INSERT')
            OR has_table_privilege(v_role, 'public.managed_registration_forms', 'UPDATE')
            OR has_table_privilege(v_role, 'public.managed_registration_forms', 'DELETE')) THEN
      v_bad := array_append(v_bad, v_role || ' holds a privilege on managed_registration_forms');
    END IF;
  END LOOP;

  -- No player column: a players FK here would block merges (00207).
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.conrelid = 'public.managed_registration_forms'::regclass
                AND c.contype = 'f' AND c.confrelid = 'public.players'::regclass) THEN
    v_bad := array_append(v_bad, 'managed_registration_forms references players');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn::regprocedure AND p.prosecdef
                   AND 'search_path=public, pg_temp' = ANY (p.proconfig)) THEN
    v_bad := array_append(v_bad, v_fn || ' is not SECURITY DEFINER with the pinned search_path');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = v_fn::regprocedure AND a.privilege_type = 'EXECUTE'
                AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))) THEN
    v_bad := array_append(v_bad, v_fn || ' is executable by PUBLIC, anon or authenticated');
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'service_role cannot call ' || v_fn);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.data_api_consumers WHERE name = 'Google Forms made by the console') THEN
    v_bad := array_append(v_bad, 'the console forms consumer is missing');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00296 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00296 verified: the console makes the forms, service_role only, no player column.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
