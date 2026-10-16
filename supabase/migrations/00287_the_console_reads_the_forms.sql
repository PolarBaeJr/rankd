-- ============================================================
-- 00287: THE CONSOLE READS THE FORMS
--
-- 00283 brought Google Form responses in through one road: an Apps Script on
-- each form posts every response to the Data API with a registrations:write
-- key. This file adds a second road. The console holds one Google Cloud
-- service account, every form lives in one Drive folder shared with that
-- account, and a five-minute job reads each linked form through the Google
-- Forms API and feeds its new and edited responses through THE SAME import.
--
-- ONE IMPORT, TWO DOORS. 00283's dispatcher took a key hash, checked it and
-- then did everything else. Its body is now registration_import_apply, granted
-- to nobody, and there are two thin doors in front of it:
--
--   data_api_import_registration(p_key_hash, p_payload)   data_api_reader
--       unchanged signature and grants: checks the key exactly as before and
--       hands the key's consumer to the body;
--   forms_api_import_registration(p_binding_id, p_payload) service_role
--       resolves the binding's own consumer and form id, no key.
--
-- The body is 00283's verbatim (00283 is the only migration that defines the
-- dispatcher; 00284 to 00286 restate none of it) except for five edits, each
-- marked "00287" or visible in the diff: the key block became a delivery check,
-- a polled binding refuses the script, the import row records which road it
-- came by, and the audit row says so. So member matching, the awaiting_member
-- confirm, mutual doubles pairing, fees, guest waiver invites, idempotency by
-- response id and payload hash, edits and supersede cannot drift between the
-- two roads: there is one copy.
--
-- ONE ROAD PER FORM. A binding with a read_mapping is read by the console and
-- the script's posts for it answer not_found (the script treats a 404 as
-- settled and does not retry). Google does not document that the Apps Script
-- response id equals the Forms API responseId, and if they differ the same
-- response arriving by both roads would be two responses by the same person,
-- the second superseding the first. Exclusive delivery makes that impossible
-- instead of unlikely. The console builds the payload exactly as the script
-- and the Data API's shape check do, so when the ids are equal the hashes are
-- too and switching a form from the script to the console replays rather than
-- re-imports.
--
-- registration_imports.key_id becomes nullable: a response read by the
-- console has no key. `source` says which road delivered it last, and a CHECK
-- ties the two together (a key exactly when the Data API delivered it). An
-- edit overwrites both, so they never disagree.
--
-- THE POLL STATE lives on the binding: the mapping (the script's CONFIG, by
-- question title), the watermark (the newest lastSubmittedTime fully
-- imported), the claim, and what the card shows (last read, responses
-- imported, last error). The claim and receipt copy the session reminders
-- (00195): claim before the read, receipt after, a crashed round's claim goes
-- stale after ten minutes, and the receipt only lands for the claim it holds,
-- so two console replicas never read one form at once.
--
-- One form, one polled binding: a partial unique index on form_id over active
-- bindings that have a mapping, or the reader would import one response into
-- two targets.
--
-- No new capability: saving the mapping is binding the form, which needs the
-- capability that edits the target. No personal data is added: the mapping
-- holds question titles and event ids, the error is a short code.
-- ============================================================

BEGIN;

-- ---- 0. PRECONDITIONS -------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.data_api_import_registration(text, jsonb)') IS NULL
     OR to_regclass('public.registration_import_forms') IS NULL THEN
    RAISE EXCEPTION '00287 needs 00283 (the form import) applied first';
  END IF;
  IF to_regclass('public.club_event_external_signups') IS NULL THEN
    RAISE EXCEPTION '00287 needs 00284 (club event externals) applied first';
  END IF;
  IF to_regprocedure('public.scrub_registration_identity(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '00287 needs 00285 (deletion reaches the form import) applied first';
  END IF;
END
$pre$;

-- ---- 1. WHICH ROAD A RESPONSE CAME BY ---------------------------------------
ALTER TABLE public.registration_imports
  ALTER COLUMN key_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'data_api';
ALTER TABLE public.registration_imports
  DROP CONSTRAINT IF EXISTS registration_imports_source,
  ADD CONSTRAINT registration_imports_source
    CHECK (source IN ('data_api', 'forms_api') AND (key_id IS NOT NULL) = (source = 'data_api'));

-- ---- 2. THE POLL STATE ON THE BINDING ---------------------------------------
-- read_mapping NULL: the form is not read by the console (the script may
-- post it). Its shape is checked by the console's save action; here only that
-- it is an object.
ALTER TABLE public.registration_import_forms
  ADD COLUMN IF NOT EXISTS read_mapping        jsonb,
  ADD COLUMN IF NOT EXISTS poll_watermark      timestamptz,
  ADD COLUMN IF NOT EXISTS poll_claimed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS poll_attempted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS poll_read_at        timestamptz,
  ADD COLUMN IF NOT EXISTS poll_imported_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS poll_error          text;
ALTER TABLE public.registration_import_forms
  DROP CONSTRAINT IF EXISTS registration_import_forms_read_mapping_shape,
  ADD CONSTRAINT registration_import_forms_read_mapping_shape
    CHECK (read_mapping IS NULL OR (jsonb_typeof(read_mapping) = 'object' AND pg_column_size(read_mapping) <= 32768)),
  DROP CONSTRAINT IF EXISTS registration_import_forms_poll_error_shape,
  ADD CONSTRAINT registration_import_forms_poll_error_shape
    CHECK (poll_error IS NULL OR poll_error ~ '^[a-z_]{1,40}$'),
  DROP CONSTRAINT IF EXISTS registration_import_forms_poll_count,
  ADD CONSTRAINT registration_import_forms_poll_count CHECK (poll_imported_count >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS registration_import_forms_one_reader
  ON public.registration_import_forms (form_id)
  WHERE active AND read_mapping IS NOT NULL;

-- ---- 3. THE IMPORT, ONCE ----------------------------------------------------
-- 00283's data_api_import_registration body, verbatim but for the 00287 edits.
-- Granted to nobody: only the two doors below, which run as the owner, call it.
CREATE OR REPLACE FUNCTION public.registration_import_apply(
  p_consumer uuid, p_key_id uuid, p_source text, p_payload jsonb
)
RETURNS TABLE(item integer, event_id uuid, status text, reason text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  c_event_reasons constant text[] := ARRAY[
    'event_full', 'waitlist_queue', 'registration_closed', 'registration_not_open',
    'registration_window_closed', 'event_not_in_target', 'duplicate_in_submission'];
  v_consumer     uuid;
  v_key_id       uuid;
  v_form_id      text;
  v_response_id  text;
  v_submitted    timestamptz;
  v_email        text;
  v_name         text;
  v_entries      jsonb;
  v_hash         text;
  v_binding      registration_import_forms%ROWTYPE;
  v_import       registration_imports%ROWTYPE;
  v_prior        registration_imports%ROWTYPE;
  v_has_prior    boolean := false;
  v_is_edit      boolean := false;
  v_member       players%ROWTYPE;
  v_has_member   boolean := false;
  v_person_issue text;
  v_partner      players%ROWTYPE;
  v_has_partner  boolean;
  v_tournament   tournaments%ROWTYPE;
  v_event        tournament_events%ROWTYPE;
  v_club         club_events%ROWTYPE;
  v_event_ids    uuid[] := ARRAY[]::uuid[];
  v_lock_ids     uuid[];
  v_lock_id      uuid;
  v_elem         jsonb;
  v_i            integer;
  v_ev           uuid;
  v_partner_mail text;
  v_partner_name text;
  v_category     text;
  v_status       text;
  v_reason       text;
  v_entry_id     uuid;
  v_old          registration_import_entries%ROWTYPE;
  v_found_old    boolean;
  v_current      uuid[] := ARRAY[]::uuid[];
  v_results      jsonb := '[]'::jsonb;
  v_doubles      boolean;
  v_win          text;
  v_pairs        integer;
  v_unpaired     integer;
  v_singles      integer;
  v_before       integer;
  v_after        integer;
  v_waiting      boolean;
  v_rating       integer;
  v_pair_id      uuid;
  v_fee_id       uuid;
  v_tier         jsonb;
  v_signup       jsonb;
  v_why          text;
  v_n_entered    integer := 0;
  v_n_pending    integer := 0;
  v_n_refused    integer := 0;
  v_wants_wait   boolean;
BEGIN
  -- ---- who delivered it (00287) ----
  -- The key was checked by data_api_import_registration, or the binding was
  -- resolved by forms_api_import_registration. A key always comes with the
  -- Data API and never with the Forms API reader.
  IF p_consumer IS NULL
     OR p_source IS NULL OR p_source NOT IN ('data_api', 'forms_api')
     OR (p_source = 'data_api') <> (p_key_id IS NOT NULL) THEN
    RAISE EXCEPTION 'registration_import_apply: bad delivery (%)', p_source
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_consumer := p_consumer;
  v_key_id   := p_key_id;

  -- ---- the shape ----
  v_form_id     := NULLIF(btrim(COALESCE(p_payload ->> 'form_id', '')), '');
  v_response_id := NULLIF(btrim(COALESCE(p_payload ->> 'response_id', '')), '');
  v_email       := lower(btrim(COALESCE(p_payload ->> 'email', '')));
  v_name        := NULLIF(regexp_replace(btrim(COALESCE(p_payload ->> 'name', '')), '\s+', ' ', 'g'), '');
  v_entries     := COALESCE(p_payload -> 'entries', '[]'::jsonb);
  BEGIN
    v_submitted := NULLIF(p_payload ->> 'submitted_at', '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_submitted := NULL;
  END;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR v_form_id IS NULL OR char_length(v_form_id) > 200
     OR v_response_id IS NULL OR char_length(v_response_id) > 200
     OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254
     OR v_email LIKE '%@deleted.invalid'
     OR v_name IS NULL OR char_length(v_name) > 120
     OR jsonb_typeof(v_entries) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_entries) > 20 THEN
    item := 0; event_id := NULL; status := 'refused'; reason := 'bad_payload'; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ---- the binding, locked first (see the header) ----
  SELECT * INTO v_binding FROM registration_import_forms f
   WHERE f.consumer_id = v_consumer AND f.form_id = v_form_id
   FOR UPDATE;
  -- 00287: a binding the console reads through the Forms API takes nothing
  -- from the script, so one response never arrives by two roads.
  IF NOT FOUND OR NOT v_binding.active
     OR num_nonnulls(v_binding.tournament_id, v_binding.club_event_id) = 0
     OR (p_source = 'data_api' AND v_binding.read_mapping IS NOT NULL) THEN
    item := 0; event_id := NULL; status := 'refused'; reason := 'not_found'; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;

  v_hash := md5(p_payload::text);

  -- ---- a replay answers from the record ----
  SELECT * INTO v_import FROM registration_imports i
   WHERE i.binding_id = v_binding.id AND i.response_id = v_response_id;
  IF FOUND AND v_import.payload_hash = v_hash THEN
    FOR v_elem IN SELECT * FROM jsonb_array_elements(v_import.result) LOOP
      item := (v_elem ->> 'item')::integer;
      event_id := NULLIF(v_elem ->> 'event_id', '')::uuid;
      status := v_elem ->> 'status';
      reason := v_elem ->> 'reason';
      replayed := true;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;
  IF FOUND THEN
    v_is_edit := true;
    v_prior := v_import;
    v_has_prior := true;
  END IF;

  -- ---- who is this ----
  SELECT * INTO v_member FROM players p
   WHERE lower(btrim(p.email)) = v_email AND p.email NOT LIKE '%@deleted.invalid'
   ORDER BY p.created_at
   LIMIT 1;
  v_has_member := FOUND;

  -- ---- an earlier response by the same person is superseded ----
  IF NOT v_has_prior THEN
    SELECT * INTO v_prior FROM registration_imports i
     WHERE i.binding_id = v_binding.id
       AND i.superseded_by IS NULL
       AND ((v_has_member AND i.submitter_player_id = v_member.id)
         OR (NOT v_has_member AND i.submitter_email = v_email))
     ORDER BY i.created_at DESC
     LIMIT 1;
    v_has_prior := FOUND;
  END IF;

  -- ---- the events asked for ----
  IF v_binding.target_kind = 'club_event' THEN
    v_event_ids := ARRAY[v_binding.club_event_id];
  ELSE
    FOR v_elem IN SELECT * FROM jsonb_array_elements(v_entries) LOOP
      BEGIN
        v_ev := (v_elem ->> 'event_id')::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_ev := NULL;
      END;
      IF v_ev IS NOT NULL
         AND EXISTS (SELECT 1 FROM tournament_events e
                      WHERE e.id = v_ev AND e.tournament_id = v_binding.tournament_id) THEN
        v_event_ids := array_append(v_event_ids, v_ev);
      END IF;
    END LOOP;
  END IF;

  -- ---- the locks, all at top level, before any subtransaction ----
  IF v_binding.target_kind = 'tournament' THEN
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[]) INTO v_lock_ids
      FROM (
        SELECT unnest(v_event_ids) AS x
        UNION
        SELECT en.tournament_event_id FROM registration_import_entries en
         WHERE v_has_prior AND en.import_id = v_prior.id AND en.tournament_event_id IS NOT NULL
      ) s;
    FOREACH v_lock_id IN ARRAY v_lock_ids LOOP
      PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_lock_id::text));
    END LOOP;
    SELECT * INTO v_tournament FROM tournaments t WHERE t.id = v_binding.tournament_id FOR UPDATE;
    IF v_has_member THEN
      PERFORM 1 FROM players p WHERE p.id = v_member.id FOR SHARE;
    END IF;
    PERFORM 1 FROM tournament_events e WHERE e.id = ANY (v_lock_ids) ORDER BY e.id FOR UPDATE;
  ELSE
    SELECT * INTO v_club FROM club_events ce WHERE ce.id = v_binding.club_event_id FOR NO KEY UPDATE;
    IF v_has_member THEN
      PERFORM 1 FROM players p WHERE p.id = v_member.id FOR SHARE;
    END IF;
  END IF;

  -- ---- the person, once ----
  IF v_has_member THEN
    v_person_issue := CASE
      WHEN v_member.is_banned THEN 'banned'
      WHEN v_member.deletion_requested_at IS NOT NULL THEN 'deletion_pending'
      WHEN v_member.status = 'pending_approval' THEN 'pending_approval'
      WHEN v_member.status = 'suspended' THEN 'suspended'
      ELSE NULL
    END;
  END IF;

  -- ---- the import row ----
  IF v_is_edit THEN
    UPDATE registration_imports
       SET payload_hash = v_hash, submitted_at = v_submitted, key_id = v_key_id, source = p_source,
           submitter_player_id = CASE WHEN v_has_member THEN v_member.id END,
           submitter_name = CASE WHEN v_has_member THEN NULL ELSE v_name END,
           submitter_email = CASE WHEN v_has_member THEN NULL ELSE v_email END,
           updated_at = now()
     WHERE id = v_prior.id
    RETURNING * INTO v_import;
  ELSE
    INSERT INTO registration_imports (binding_id, key_id, source, response_id, submitted_at, payload_hash,
                                      submitter_player_id, submitter_name, submitter_email)
    VALUES (v_binding.id, v_key_id, p_source, v_response_id, v_submitted, v_hash,
            CASE WHEN v_has_member THEN v_member.id END,
            CASE WHEN v_has_member THEN NULL ELSE v_name END,
            CASE WHEN v_has_member THEN NULL ELSE v_email END)
    RETURNING * INTO v_import;
  END IF;

  -- ---- one entry per item ----
  v_i := 0;
  FOR v_elem IN
    SELECT e FROM jsonb_array_elements(
      CASE WHEN v_binding.target_kind = 'club_event' AND jsonb_array_length(v_entries) = 0
           THEN jsonb_build_array(jsonb_build_object('event_id', v_binding.club_event_id))
           ELSE v_entries END) e
  LOOP
    v_i := v_i + 1;
    v_status := NULL; v_reason := NULL; v_entry_id := NULL;
    v_pair_id := NULL; v_fee_id := NULL; v_wants_wait := false;
    BEGIN
      v_ev := (v_elem ->> 'event_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_ev := NULL;
    END;
    v_partner_mail := NULLIF(lower(btrim(COALESCE(v_elem ->> 'partner_email', ''))), '');
    v_partner_name := NULLIF(regexp_replace(btrim(COALESCE(v_elem ->> 'partner_name', '')), '\s+', ' ', 'g'), '');
    v_category     := NULLIF(btrim(COALESCE(v_elem ->> 'category', '')), '');
    IF v_partner_mail IS NOT NULL AND (v_partner_mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_partner_mail) > 254) THEN
      v_partner_mail := NULL;
    END IF;
    IF char_length(v_partner_name) > 120 THEN v_partner_name := left(v_partner_name, 120); END IF;
    IF char_length(v_category) > 40 THEN v_category := NULL; END IF;

    -- Not this form's: refused, and nothing recorded against an event.
    IF v_ev IS NULL OR NOT (
         (v_binding.target_kind = 'tournament' AND v_ev = ANY (v_event_ids))
      OR (v_binding.target_kind = 'club_event' AND v_ev = v_binding.club_event_id)) THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', NULL, 'status', 'refused', 'reason', 'event_not_in_target'));
      v_n_refused := v_n_refused + 1;
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_results) r
                WHERE r ->> 'event_id' = v_ev::text) THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', v_ev, 'status', 'refused', 'reason', 'duplicate_in_submission'));
      v_n_refused := v_n_refused + 1;
      CONTINUE;
    END IF;

    -- What this person's earlier response already made for this event, with
    -- the same partner: kept as it is, under this response.
    SELECT * INTO v_old FROM registration_import_entries en
     WHERE v_has_prior AND en.import_id = v_prior.id
       AND (en.tournament_event_id = v_ev OR en.club_event_id = v_ev)
       AND en.status IN ('entered', 'awaiting_partner', 'awaiting_member', 'needs_review')
       AND (en.requested_partner_id IS NOT DISTINCT FROM (
              SELECT p.id FROM players p
               WHERE v_partner_mail IS NOT NULL AND lower(btrim(p.email)) = v_partner_mail
                 AND p.email NOT LIKE '%@deleted.invalid'
               ORDER BY p.created_at LIMIT 1))
       AND (en.requested_partner_id IS NOT NULL
            OR en.partner_email IS NOT DISTINCT FROM v_partner_mail)
     LIMIT 1;
    v_found_old := FOUND;
    IF v_found_old THEN
      UPDATE registration_import_entries
         SET import_id = v_import.id, item = v_i, updated_at = now()
       WHERE id = v_old.id;
      v_current := array_append(v_current, v_old.id);
      v_status := v_old.status;
      v_reason := v_old.reason;
    ELSE
      BEGIN
        -- ================= a tournament event =================
        IF v_binding.target_kind = 'tournament' THEN
          SELECT * INTO v_event FROM tournament_events e WHERE e.id = v_ev;
          v_doubles := v_event.event_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');
          v_win := entry_window_state(COALESCE(v_event.registration_opens_at, v_tournament.registration_opens_at),
                                      COALESCE(v_event.registration_closes_at, v_tournament.registration_closes_at),
                                      now());
          SELECT EXISTS (SELECT 1 FROM tournament_event_waitlist w
                          WHERE w.event_id = v_ev AND w.status = 'waiting') INTO v_waiting;

          -- The event's own facts, in enter_tournament_event's order.
          IF v_tournament.suspended_at IS NOT NULL
             OR v_tournament.status::text IN ('completed', 'archived')
             OR v_event.status <> 'registration' THEN
            v_status := 'refused'; v_reason := 'registration_closed';
          ELSIF v_win = 'not_open_yet' THEN
            v_status := 'refused'; v_reason := 'registration_not_open';
          ELSIF v_win = 'closed' THEN
            v_status := 'refused'; v_reason := 'registration_window_closed';
          END IF;

          -- Capacity: draw slots for doubles, rows for singles; an external
          -- team is one whole slot.
          IF v_status IS NULL AND v_event.max_participants IS NOT NULL AND v_event.max_participants > 0 THEN
            SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
             WHERE tournament_pairs.event_id = v_ev
               AND COALESCE(tournament_pairs.status::text, '') NOT IN ('withdrawn', 'disqualified');
            SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
             WHERE tournament_participants.event_id = v_ev
               AND COALESCE(tournament_participants.status::text, '') NOT IN ('withdrawn', 'disqualified');
            IF v_event.external_event AND NOT v_has_member THEN
              v_before := v_pairs; v_after := v_pairs + 1;
            ELSIF v_doubles THEN
              v_before := v_pairs + CEIL(v_unpaired / 2.0);
              v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);
            ELSE
              v_before := v_unpaired; v_after := v_unpaired + 1;
            END IF;
            IF v_after > v_event.max_participants AND v_after > v_before THEN
              IF v_has_member AND v_binding.join_waitlist AND v_event.waitlist_enabled
                 AND NOT v_event.external_event THEN
                v_wants_wait := true;
              ELSE
                v_status := 'refused'; v_reason := 'event_full';
              END IF;
            END IF;
          END IF;
          IF v_status IS NULL AND v_waiting AND NOT v_wants_wait THEN
            IF v_has_member AND v_binding.join_waitlist THEN
              v_wants_wait := true;
            ELSE
              v_status := 'refused'; v_reason := 'waitlist_queue';
            END IF;
          END IF;

          -- The person's.
          IF v_status IS NULL AND v_has_member THEN
            v_has_partner := false;
            IF v_doubles AND v_partner_mail IS NOT NULL THEN
              SELECT * INTO v_partner FROM players p
               WHERE lower(btrim(p.email)) = v_partner_mail AND p.email NOT LIKE '%@deleted.invalid'
               ORDER BY p.created_at LIMIT 1;
              v_has_partner := FOUND;
            END IF;
            SELECT CASE WHEN v_doubles THEN r.doubles_elo ELSE r.singles_elo END INTO v_rating
              FROM ratings r WHERE r.player_id = v_member.id;

            IF v_person_issue IS NOT NULL THEN
              v_status := 'needs_review'; v_reason := v_person_issue;
            ELSIF v_event.external_event THEN
              v_status := 'needs_review'; v_reason := 'member_in_external_event';
            ELSIF v_rating IS NULL THEN
              v_status := 'needs_review'; v_reason := 'no_rating';
            ELSIF EXISTS (SELECT 1 FROM tournament_participants tp
                           WHERE tp.event_id = v_ev AND tp.player_id = v_member.id
                             AND tp.status IN ('withdrawn', 'disqualified')) THEN
              v_status := 'needs_review'; v_reason := 'withdrawn_reentry';
            ELSIF EXISTS (SELECT 1 FROM tournament_participants tp
                           WHERE tp.event_id = v_ev AND tp.player_id = v_member.id)
               OR EXISTS (SELECT 1 FROM tournament_pairs pr
                           WHERE pr.event_id = v_ev
                             AND (pr.player1_id = v_member.id OR pr.player2_id = v_member.id)
                             AND COALESCE(pr.status::text, '') NOT IN ('withdrawn', 'disqualified')) THEN
              v_status := 'refused'; v_reason := 'already_registered';
            ELSIF v_doubles AND v_partner_mail IS NOT NULL AND NOT v_has_partner THEN
              v_status := 'needs_review'; v_reason := 'external_partner';
            ELSIF v_doubles AND v_has_partner AND v_partner.id = v_member.id THEN
              v_status := 'needs_review'; v_reason := 'partner_is_self';
            ELSE
              v_status := 'awaiting_member';
            END IF;

            INSERT INTO registration_import_entries (
              import_id, item, tournament_event_id, entrant_id, requested_partner_id,
              partner_name, partner_email, category, wants_waitlist, status, reason)
            VALUES (
              v_import.id, v_i, v_ev, v_member.id,
              CASE WHEN v_doubles AND v_has_partner AND v_partner.id <> v_member.id THEN v_partner.id END,
              CASE WHEN v_doubles AND NOT v_has_partner THEN v_partner_name END,
              CASE WHEN v_doubles AND NOT v_has_partner THEN v_partner_mail END,
              v_category, v_wants_wait, v_status, v_reason)
            RETURNING id INTO v_entry_id;

            IF v_status = 'awaiting_member' THEN
              INSERT INTO notifications (player_id, type, title, body, metadata)
              VALUES (v_member.id, 'general', 'Confirm your entry',
                      format('The form for %s entered you in %s. Confirm it in the app if it was you.',
                             v_tournament.name, initcap(replace(v_event.event_type, '_', ' '))),
                      jsonb_build_object('kind', 'registration_import_confirm', 'entry_id', v_entry_id,
                                         'tournament_id', v_tournament.id, 'event_id', v_ev));
            END IF;

          -- A non-member, in an external event, as a whole team.
          ELSIF v_status IS NULL THEN
            v_has_partner := false;
            IF v_partner_mail IS NOT NULL THEN
              PERFORM 1 FROM players p
               WHERE lower(btrim(p.email)) = v_partner_mail AND p.email NOT LIKE '%@deleted.invalid';
              v_has_partner := FOUND;
            END IF;
            IF NOT v_event.external_event THEN
              v_status := 'needs_review'; v_reason := 'external_in_member_event';
            ELSIF NOT v_doubles OR v_partner_name IS NULL THEN
              v_status := 'needs_review'; v_reason := 'external_without_partner';
            ELSIF v_has_partner THEN
              v_status := 'needs_review'; v_reason := 'member_partner_in_external_event';
            ELSE
              BEGIN
                v_pair_id := public.add_external_tournament_pair_v2(
                  v_ev, v_name, v_partner_name, NULL, NULL, v_category);
                v_status := 'entered';
              EXCEPTION
                WHEN unique_violation THEN
                  v_status := 'needs_review'; v_reason := 'duplicate_team';
                WHEN check_violation THEN
                  v_status := 'needs_review'; v_reason := 'external_pair_refused';
              END;
            END IF;

            INSERT INTO registration_import_entries (
              import_id, item, tournament_event_id, external_name, external_email,
              partner_name, partner_email, category, pair_id, status, reason)
            VALUES (v_import.id, v_i, v_ev, v_name, v_email, v_partner_name, v_partner_mail,
                    v_category, v_pair_id, v_status, v_reason)
            RETURNING id INTO v_entry_id;

            IF v_status = 'entered' THEN
              -- One fee per person per tournament, never overwritten.
              v_tier := public.select_fee_tier('external', public.tournament_fee_tiers_json(v_tournament.id));
              INSERT INTO club_fees (fee_type, tournament_id, player_id, manual_name, manual_email,
                                     season_id, tier_id, amount_cents, paid_at)
              VALUES ('tournament', v_tournament.id, NULL, v_name, v_email, v_tournament.season_id,
                      NULLIF(v_tier ->> 'id', '')::uuid, (v_tier ->> 'amount_cents')::integer, NULL)
              ON CONFLICT (tournament_id, lower(manual_email))
                WHERE fee_type = 'tournament' AND player_id IS NULL
              DO NOTHING
              RETURNING id INTO v_fee_id;
              IF v_fee_id IS NOT NULL THEN
                UPDATE registration_import_entries
                   SET fee_id = v_fee_id, fee_created_by_import = true
                 WHERE id = v_entry_id;
              ELSE
                UPDATE registration_import_entries en
                   SET fee_id = f.id
                  FROM club_fees f
                 WHERE en.id = v_entry_id AND f.fee_type = 'tournament'
                   AND f.tournament_id = v_tournament.id AND f.player_id IS NULL
                   AND lower(f.manual_email) = v_email;
              END IF;

              INSERT INTO guest_waiver_invites (email, target_kind, target_id, import_entry_id)
              VALUES (v_email, 'tournament', v_tournament.id, v_entry_id)
              ON CONFLICT (email, target_kind, target_id) DO UPDATE
                SET cancelled_at = NULL, import_entry_id = EXCLUDED.import_entry_id
                WHERE guest_waiver_invites.sent_at IS NULL AND guest_waiver_invites.cancelled_at IS NOT NULL;
            END IF;
          END IF;

        -- ================= a club event =================
        ELSE
          IF v_club.status IS DISTINCT FROM 'published' OR v_club.starts_at <= now() THEN
            v_status := 'refused'; v_reason := 'registration_closed';
          ELSIF v_club.signup_opens_at IS NOT NULL AND now() < v_club.signup_opens_at THEN
            v_status := 'refused'; v_reason := 'registration_not_open';
          ELSIF v_club.signup_closes_at IS NOT NULL AND now() >= v_club.signup_closes_at THEN
            v_status := 'refused'; v_reason := 'registration_window_closed';
          ELSIF v_club.capacity IS NOT NULL AND public.club_event_taken(v_ev) >= v_club.capacity THEN
            v_status := 'refused'; v_reason := 'event_full';
          END IF;

          IF v_status IS NULL AND v_has_member THEN
            IF v_person_issue IS NOT NULL THEN
              v_status := 'needs_review'; v_reason := v_person_issue;
            ELSIF EXISTS (SELECT 1 FROM club_event_signups s
                           WHERE s.event_id = v_ev AND s.player_id = v_member.id) THEN
              v_status := 'refused'; v_reason := 'already_registered';
            ELSE
              v_status := 'awaiting_member';
            END IF;
            INSERT INTO registration_import_entries (import_id, item, club_event_id, entrant_id, status, reason)
            VALUES (v_import.id, v_i, v_ev, v_member.id, v_status, v_reason)
            RETURNING id INTO v_entry_id;
            IF v_status = 'awaiting_member' THEN
              INSERT INTO notifications (player_id, type, title, body, metadata)
              VALUES (v_member.id, 'general', 'Confirm your sign-up',
                      format('The form for %s signed you up. Confirm it in the app if it was you.', v_club.title),
                      jsonb_build_object('kind', 'registration_import_confirm', 'entry_id', v_entry_id,
                                         'club_event_id', v_ev));
            END IF;
          ELSIF v_status IS NULL THEN
            INSERT INTO registration_import_entries (import_id, item, club_event_id, external_name, external_email, status)
            VALUES (v_import.id, v_i, v_ev, v_name, v_email, 'needs_review')
            RETURNING id INTO v_entry_id;
            v_signup := public.club_event_external_sign_up(v_ev, v_name, v_email, v_entry_id);
            IF COALESCE((v_signup ->> 'ok')::boolean, false) THEN
              v_status := 'entered'; v_reason := NULL;
            ELSIF v_signup ->> 'reason' = ANY (c_event_reasons) THEN
              v_status := 'refused'; v_reason := v_signup ->> 'reason';
            ELSE
              v_status := 'needs_review'; v_reason := COALESCE(v_signup ->> 'reason', 'external_refused');
            END IF;
            UPDATE registration_import_entries
               SET status = v_status, reason = v_reason, updated_at = now()
             WHERE id = v_entry_id;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- Whatever this entry did is rolled back to the subtransaction; the
        -- rest of the response stands. Parked, with the SQLSTATE for the desk.
        v_status := 'needs_review'; v_reason := 'error_' || SQLSTATE;
        v_entry_id := NULL;
        INSERT INTO registration_import_entries (
          import_id, item, tournament_event_id, club_event_id, entrant_id,
          external_name, external_email, status, reason)
        VALUES (v_import.id, v_i,
                CASE WHEN v_binding.target_kind = 'tournament' THEN v_ev END,
                CASE WHEN v_binding.target_kind = 'club_event' THEN v_ev END,
                CASE WHEN v_has_member THEN v_member.id END,
                CASE WHEN v_has_member THEN NULL ELSE v_name END,
                CASE WHEN v_has_member THEN NULL ELSE v_email END,
                v_status, v_reason)
        RETURNING id INTO v_entry_id;
      END;

      -- Every row this call wrote is current, and is never retired below.
      IF v_entry_id IS NOT NULL THEN
        v_current := array_append(v_current, v_entry_id);
      END IF;
      IF v_entry_id IS NOT NULL AND v_status = 'needs_review' THEN
        INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
        VALUES (NULL, 'registration_import_parked', 'registration_import_entry', v_entry_id,
                jsonb_build_object('import_id', v_import.id, 'binding_id', v_binding.id,
                                   'event_id', v_ev, 'reason', v_reason),
                'A form response was parked for review');
      END IF;
    END IF;

    -- The public answer: event reasons only; anything else is pending.
    IF v_status = 'entered' THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', v_ev, 'status', 'entered', 'reason', NULL));
      v_n_entered := v_n_entered + 1;
    ELSIF v_status = 'refused' AND v_reason = ANY (c_event_reasons) THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', v_ev, 'status', 'refused', 'reason', v_reason));
      v_n_refused := v_n_refused + 1;
    ELSE
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'item', v_i, 'event_id', v_ev, 'status', 'pending', 'reason', NULL));
      v_n_pending := v_n_pending + 1;
    END IF;
  END LOOP;

  -- ---- what the earlier response made and this one no longer asks for ----
  IF v_has_prior THEN
    FOR v_old IN
      SELECT * FROM registration_import_entries en
       WHERE en.import_id IN (v_prior.id, v_import.id)
         AND NOT (en.id = ANY (v_current))
         AND en.status IN ('entered', 'awaiting_partner', 'awaiting_member', 'needs_review')
       ORDER BY en.id
    LOOP
      IF v_old.participant_id IS NULL AND v_old.pair_id IS NULL AND v_old.status <> 'entered' THEN
        -- Nothing live: the earlier ask simply lapses.
        UPDATE registration_import_entries
           SET status = 'superseded', reason = 'removed_from_form', updated_at = now()
         WHERE id = v_old.id;
      ELSIF v_old.entrant_id IS NOT NULL THEN
        -- A member's own confirmed entry is never withdrawn by a form edit.
        UPDATE registration_import_entries
           SET status = 'needs_review', reason = 'removed_from_form', updated_at = now()
         WHERE id = v_old.id;
      ELSE
        v_why := public.registration_import_retire(v_old.id);
        UPDATE registration_import_entries
           SET status = CASE WHEN v_why IS NULL THEN 'superseded' ELSE 'needs_review' END,
               reason = CASE WHEN v_why IS NULL THEN 'removed_from_form' ELSE 'removed_from_form_' || v_why END,
               updated_at = now()
         WHERE id = v_old.id;
        IF v_why IS NULL AND v_old.tournament_event_id IS NOT NULL THEN
          PERFORM public.fill_event_from_waitlist(v_old.tournament_event_id, NULL, NULL);
        END IF;
      END IF;
    END LOOP;

    IF NOT v_is_edit THEN
      UPDATE registration_imports SET superseded_by = v_import.id, updated_at = now()
       WHERE id = v_prior.id;
    END IF;
  END IF;

  UPDATE registration_imports SET result = v_results, updated_at = now() WHERE id = v_import.id;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'registration_imported', 'registration_import', v_import.id,
          jsonb_build_object('binding_id', v_binding.id, 'consumer_id', v_consumer, 'key_id', v_key_id,
                             'source', p_source,
                             'edited', v_is_edit, 'superseded', v_has_prior AND NOT v_is_edit,
                             'entered', v_n_entered, 'pending', v_n_pending, 'refused', v_n_refused),
          CASE WHEN p_source = 'forms_api'
               THEN 'A form response was read from Google Forms'
               ELSE 'A form response arrived through the data API' END);

  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_results) LOOP
    item := (v_elem ->> 'item')::integer;
    event_id := NULLIF(v_elem ->> 'event_id', '')::uuid;
    status := v_elem ->> 'status';
    reason := v_elem ->> 'reason';
    replayed := false;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.registration_import_apply(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---- 4. THE DATA API'S DOOR -------------------------------------------------
-- Same signature, same grants, same answers as 00283: an unknown, revoked,
-- expired or unscoped key is item 0 refused 'key', which the service turns
-- into 401.
CREATE OR REPLACE FUNCTION public.data_api_import_registration(p_key_hash text, p_payload jsonb)
RETURNS TABLE(item integer, event_id uuid, status text, reason text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_consumer uuid;
  v_key_id   uuid;
BEGIN
  SELECT w.consumer_id, w.key_id INTO v_consumer, v_key_id
    FROM data_api_write_key(p_key_hash, 'registrations:write') w;
  IF v_key_id IS NULL THEN
    item := 0; event_id := NULL; status := 'refused'; reason := 'key'; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.item, a.event_id, a.status, a.reason, a.replayed
    FROM public.registration_import_apply(v_consumer, v_key_id, 'data_api', p_payload) a;
END;
$function$;

REVOKE ALL ON FUNCTION public.data_api_import_registration(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.data_api_import_registration(text, jsonb) TO data_api_reader;

-- ---- 5. THE CONSOLE'S DOOR --------------------------------------------------
-- The binding names the consumer and the form, so the payload's form_id is
-- overwritten with the binding's own. A binding that is off, has no target or
-- has no mapping answers not_found, as an unbound form does on the Data API.
CREATE OR REPLACE FUNCTION public.forms_api_import_registration(p_binding_id uuid, p_payload jsonb)
RETURNS TABLE(item integer, event_id uuid, status text, reason text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_binding registration_import_forms%ROWTYPE;
BEGIN
  SELECT * INTO v_binding FROM registration_import_forms f WHERE f.id = p_binding_id;
  IF NOT FOUND OR NOT v_binding.active OR v_binding.read_mapping IS NULL
     OR num_nonnulls(v_binding.tournament_id, v_binding.club_event_id) = 0 THEN
    item := 0; event_id := NULL; status := 'refused'; reason := 'not_found'; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    item := 0; event_id := NULL; status := 'refused'; reason := 'bad_payload'; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.item, a.event_id, a.status, a.reason, a.replayed
    FROM public.registration_import_apply(
           v_binding.consumer_id, NULL, 'forms_api',
           jsonb_set(p_payload, '{form_id}', to_jsonb(v_binding.form_id))) a;
END;
$function$;

REVOKE ALL ON FUNCTION public.forms_api_import_registration(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.forms_api_import_registration(uuid, jsonb) TO service_role;

-- ---- 6. CLAIM AND RECEIPT ---------------------------------------------------
-- Claim up to p_limit forms due a read: active, with a target and a mapping,
-- not claimed in the last ten minutes, and not attempted in the last
-- p_min_interval_seconds. Least recently attempted first, so with more forms
-- than one round can read every form still gets its turn.
CREATE OR REPLACE FUNCTION public.claim_registration_form_polls(p_limit integer, p_min_interval_seconds integer)
RETURNS TABLE(id uuid, form_id text, target_kind text, tournament_id uuid, club_event_id uuid,
              read_mapping jsonb, poll_watermark timestamptz, claimed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT f.id
      FROM registration_import_forms f
     WHERE f.active
       AND f.read_mapping IS NOT NULL
       AND num_nonnulls(f.tournament_id, f.club_event_id) = 1
       AND (f.poll_claimed_at IS NULL OR f.poll_claimed_at < now() - interval '10 minutes')
       AND (f.poll_attempted_at IS NULL
            OR f.poll_attempted_at < now() - make_interval(secs => GREATEST(COALESCE(p_min_interval_seconds, 0), 0)))
     ORDER BY f.poll_attempted_at NULLS FIRST, f.id
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 0), 100))
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE registration_import_forms f
       SET poll_claimed_at = clock_timestamp()
      FROM picked
     WHERE f.id = picked.id
    RETURNING f.id, f.form_id, f.target_kind, f.tournament_id, f.club_event_id,
              f.read_mapping, f.poll_watermark, f.poll_claimed_at
  )
  SELECT c.id, c.form_id, c.target_kind, c.tournament_id, c.club_event_id,
         c.read_mapping, c.poll_watermark, c.poll_claimed_at
    FROM claimed c;
END;
$function$;

-- The receipt, for the claim it holds and no other. p_read: the whole listing
-- was read and every response settled, so the watermark may advance (it never
-- moves back). p_error: a short code for the card, never an address or an
-- answer. p_read false with no error releases a claim the round never reached.
-- Returns false when the claim was no longer this round's.
CREATE OR REPLACE FUNCTION public.record_registration_form_poll(
  p_binding_id uuid, p_claimed_at timestamptz, p_read boolean,
  p_watermark timestamptz, p_imported integer, p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_attempted boolean := COALESCE(p_read, false) OR p_error IS NOT NULL;
BEGIN
  IF p_error IS NOT NULL AND p_error !~ '^[a-z_]{1,40}$' THEN
    RAISE EXCEPTION 'record_registration_form_poll: bad error code' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE registration_import_forms f
     SET poll_claimed_at     = NULL,
         poll_attempted_at   = CASE WHEN v_attempted THEN now() ELSE f.poll_attempted_at END,
         poll_read_at        = CASE WHEN p_read THEN now() ELSE f.poll_read_at END,
         poll_watermark      = CASE WHEN p_read AND p_watermark IS NOT NULL
                                    THEN GREATEST(COALESCE(f.poll_watermark, p_watermark), p_watermark)
                                    ELSE f.poll_watermark END,
         poll_imported_count = f.poll_imported_count + GREATEST(COALESCE(p_imported, 0), 0),
         poll_error          = CASE WHEN v_attempted THEN p_error ELSE f.poll_error END
   WHERE f.id = p_binding_id
     AND f.poll_claimed_at IS NOT DISTINCT FROM p_claimed_at
     AND p_claimed_at IS NOT NULL;
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_registration_form_polls(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_registration_form_poll(uuid, timestamptz, boolean, timestamptz, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_registration_form_polls(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_registration_form_poll(uuid, timestamptz, boolean, timestamptz, integer, text)
  TO service_role;

-- ---- 7. THE SCHEDULE --------------------------------------------------------
-- Every five minutes, the call shape of registration-mail (00283) and the
-- session reminders (00034): it follows cron_config wherever admin_url points
-- and calls nothing until reminder_secret is set. The route itself does
-- nothing until the console has the service account key. GUARDED as 00283's.
DO $schedule$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '00287: pg_cron or pg_net is missing, registration-form-poll is NOT scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule('registration-form-poll')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'registration-form-poll');
  PERFORM cron.schedule(
    'registration-form-poll',
    '*/5 * * * *',
    $job$
    SELECT net.http_post(
      url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/registration-form-poll',
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
  v_fn  text;
  v_src text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.registration_import_apply(uuid, uuid, text, jsonb)',
    'public.data_api_import_registration(text, jsonb)',
    'public.forms_api_import_registration(uuid, jsonb)',
    'public.claim_registration_form_polls(integer, integer)',
    'public.record_registration_form_poll(uuid, timestamptz, boolean, timestamptz, integer, text)'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn::regprocedure AND p.prosecdef
                     AND 'search_path=public, pg_temp' = ANY (p.proconfig)) THEN
      v_bad := array_append(v_bad, v_fn || ' is not SECURITY DEFINER with the pinned search_path');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = v_fn::regprocedure AND a.privilege_type = 'EXECUTE'
                  AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))) THEN
      v_bad := array_append(v_bad, v_fn || ' is executable by PUBLIC, anon or authenticated');
    END IF;
  END LOOP;

  -- The body: nobody but its owner.
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = 'public.registration_import_apply(uuid, uuid, text, jsonb)'::regprocedure
                AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) THEN
    v_bad := array_append(v_bad, 'registration_import_apply is executable by a role other than its owner');
  END IF;
  -- The Data API's door: the reader, and not the service role.
  IF NOT has_function_privilege('data_api_reader', 'public.data_api_import_registration(text, jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.data_api_import_registration(text, jsonb)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'data_api_import_registration grants changed');
  END IF;
  -- The console's door, the claim and the receipt: the service role, not the reader.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.forms_api_import_registration(uuid, jsonb)',
    'public.claim_registration_form_polls(integer, integer)',
    'public.record_registration_form_poll(uuid, timestamptz, boolean, timestamptz, integer, text)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'service_role cannot call ' || v_fn);
    END IF;
    IF has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'data_api_reader can call ' || v_fn);
    END IF;
  END LOOP;

  -- The import is in the body, once; the doors only delegate.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.registration_import_apply(uuid, uuid, text, jsonb)'::regprocedure;
  IF position('pg_advisory_xact_lock(hashtext(''tournament_event_field''), hashtext(v_lock_id::text))' in v_src) = 0
     OR position('md5(p_payload::text)' in v_src) = 0 THEN
    v_bad := array_append(v_bad, 'registration_import_apply lost the field key or the payload hash');
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.data_api_import_registration(text, jsonb)',
                              'public.forms_api_import_registration(uuid, jsonb)'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF position('registration_import_apply(' in v_src) = 0 OR position('md5(' in v_src) > 0
       OR position('INSERT' in v_src) > 0 THEN
      v_bad := array_append(v_bad, v_fn || ' does more than delegate to registration_import_apply');
    END IF;
  END LOOP;
  IF position('data_api_write_key(p_key_hash, ''registrations:write'')' in
              (SELECT prosrc FROM pg_proc WHERE oid = 'public.data_api_import_registration(text, jsonb)'::regprocedure)) = 0 THEN
    v_bad := array_append(v_bad, 'data_api_import_registration does not check its key through data_api_write_key');
  END IF;

  -- The tables stay closed to the reader.
  IF has_table_privilege('data_api_reader', 'public.registration_import_forms', 'SELECT')
     OR has_table_privilege('data_api_reader', 'public.registration_imports', 'SELECT') THEN
    v_bad := array_append(v_bad, 'data_api_reader can read the import tables');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00287 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00287 verified: one import body behind two doors, the console door and its claim are service_role only.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
