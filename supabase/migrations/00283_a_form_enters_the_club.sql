-- ============================================================
-- 00283: A FORM ENTERS THE CLUB
--
-- A club that runs registration through a Google Form can now have each
-- response arrive here, through the Data API, as entries the console can see,
-- confirm, park and undo. The form's Apps Script posts one response at a time
-- to POST /v1/registrations with a key carrying `registrations:write`; the
-- service hands the body to data_api_import_registration below and returns
-- what it says.
--
-- WHAT A RESPONSE CAN DO, AND WHAT IT CANNOT.
--   * The email on a form is TYPED, not verified. So a response that names a
--     member's email never enters that member and never bills them. It
--     creates an entry `awaiting_member`, a notification, and a confirmation
--     email to the address on the member's account. The member confirms in
--     the app, which runs the ordinary self-entry path (every gate: waivers,
--     legal documents, category, the solo doubles acknowledgement, rating,
--     entry cap), and only then is there a participant row and a fee. "Not
--     me" refuses the entry and tells the exec who bound the form.
--   * Doubles between members needs BOTH responses: each names the other,
--     each confirms, and only then are they paired. One response never enters
--     or bills another person.
--   * A non-member can be entered directly, and only as half of an
--     all-external team in an event marked external (00269). Their fee is a
--     named row carrying the email they typed (the club_fees widening below),
--     and a guest waiver invite is queued to the SUBMITTER only.
--   * Everything else is parked as `needs_review` for an exec: a member in an
--     external event, a non-member in a member event, a member paired with a
--     non-member, a banned or unapproved or departing member, a member with
--     no rating, a member re-entering an event they left.
--
-- THE ANSWER DOES NOT SAY WHO IS A MEMBER. Per entry the response is
-- `entered`, `pending` or `refused`, and a refusal reason is only ever about
-- the event (full, closed, not open yet, a queue, not in this form's target,
-- listed twice). Anything about the person collapses to `pending`.
--
-- REPLAYS AND EDITS. (binding, response_id) is unique. The same response with
-- the same payload hash is a replay: the stored answer comes back with
-- `replayed: true` and nothing is written. An edited response (same id, new
-- hash) is diffed against what it made before; a new response from the same
-- person on the same form supersedes their earlier one the same way. An entry
-- the edit drops is retired only while nothing is live, or for an external
-- team the import entered, only while its fee is unpaid and before the draw.
-- A member's own confirmed entry is NEVER withdrawn by an edit: it is parked
-- for an exec instead, because the member chose it in the app.
--
-- LOCK ORDER, everywhere in this file: the binding row FOR UPDATE, then each
-- event's field advisory key (00201's exact expression) in id order, then
-- tournaments FOR UPDATE, then players FOR SHARE, then tournament_events FOR
-- UPDATE in id order, then entry rows. A club event takes club_events FOR NO
-- KEY UPDATE where a tournament takes its keys. enter_tournament_event and
-- the other 00278 functions never touch a binding, so taking the binding
-- first adds no cycle; everything after it is the order they already use.
--
-- WHAT CHANGES.
--   1. The scope vocabulary learns `registrations:write`.
--   2. data_api_write_key: the key check every write function makes, once.
--      The two 00282 predictions functions are restated to call it, bodies
--      otherwise verbatim.
--   3. club_fees: a tournament fee may be a named row (player_id NULL,
--      manual_name and manual_email set). manual_email is allowed on dues and
--      tournament rows; one named tournament fee per email per tournament.
--      claim_named_fees_for_player claims named tournament rows too.
--   4. Tables: registration_import_forms (the binding of a form to a
--      tournament or club event), registration_imports (one per response),
--      registration_import_entries (one per event asked for),
--      guest_waiver_invites (the outbox for non-member invites).
--   5. select_fee_tier: selectFeeTier in plpgsql, proven against the same
--      case table as the TypeScript (FEE_TIER_CASES).
--   6. data_api_import_registration: the dispatcher (data_api_reader only).
--   7. Member side: settle_registration_import_entry,
--      pair_registration_import_entries, reject_registration_import_entry.
--   8. Console side: undo_registration_import_entry.
--   9. Mail: claim_guest_waiver_invites, claim_registration_confirm_emails,
--      record_registration_mail_receipt, guest_waiver_status. All drained by
--      the admin cron route, which sends nothing while guest_waivers is off.
--  10. merge_players_disposable learns the five new player columns.
--
-- CLUB EVENT EXTERNALS live in 00284. This file creates the two seams 00284
-- fills: club_event_taken (the capacity count) and
-- club_event_external_sign_up / club_event_external_retire (stubs that park).
--
-- Everything is SECURITY DEFINER with a pinned search_path. Nothing here is
-- granted to anon or authenticated, and data_api_reader can call exactly one
-- function and read no table.
-- ============================================================

BEGIN;

-- ---- 0. PRECONDITIONS -------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.data_api_predictions') IS NULL
     OR to_regprocedure('public.data_api_write_predictions(text, jsonb)') IS NULL THEN
    RAISE EXCEPTION '00283 needs 00282 (the predictions write) applied first';
  END IF;
  IF to_regclass('public.tournament_event_waitlist') IS NULL
     OR to_regprocedure('public.fill_event_from_waitlist(uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '00283 needs 00278 (the event waitlist) applied first';
  END IF;
  IF to_regprocedure('public.add_external_tournament_pair_v2(uuid, text, text, uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION '00283 needs 00274 (add_external_tournament_pair_v2) applied first';
  END IF;
  IF to_regclass('public.guest_waiver_signings') IS NULL THEN
    RAISE EXCEPTION '00283 needs 00254 (guest waivers) applied first';
  END IF;
END
$pre$;

-- ---- 1. THE SCOPE VOCABULARY ------------------------------------------------
ALTER TABLE public.data_api_keys
  DROP CONSTRAINT IF EXISTS data_api_keys_scope_vocabulary,
  ADD CONSTRAINT data_api_keys_scope_vocabulary
    CHECK (scopes <@ ARRAY[
      'players:read',
      'matches:read',
      'ratings:history:read',
      'seasons:read',
      'tournaments:read',
      'schedule:read',
      'predictions:write',
      'registrations:write'
    ]::text[]);

-- ---- 2. ONE KEY CHECK FOR EVERY WRITE ---------------------------------------
-- The key a write presents, re-checked in the database because the service's
-- 30-second cache can still hold a key revoked, expired or narrowed a moment
-- ago. Granted to nobody: only the SECURITY DEFINER write functions, which run
-- as the owner, call it. data_api_consumers has no active flag (00264), so the
-- key's own state is the whole answer.
CREATE OR REPLACE FUNCTION public.data_api_write_key(p_key_hash text, p_scope text)
RETURNS TABLE(consumer_id uuid, key_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT k.consumer_id, k.id
    FROM data_api_keys k
   WHERE k.key_hash = p_key_hash
     AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND p_scope = ANY (k.scopes);
$function$;

REVOKE ALL ON FUNCTION public.data_api_write_key(text, text) FROM PUBLIC, anon, authenticated, service_role;

-- The two 00282 write functions, verbatim except that the key check is the
-- helper's. Grants are unchanged (data_api_reader only), restated for clarity.
CREATE OR REPLACE FUNCTION public.data_api_write_predictions(p_key_hash text, p_predictions jsonb)
 RETURNS TABLE(item integer, status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_key_id    uuid;
  v_consumer  uuid;
  v_refs      text[];
  v_map       jsonb;
  v_elem      jsonb;
  v_i         integer;
  v_format    text;
  v_size      integer;
  v_a         uuid[];
  v_b         uuid[];
  v_side1     uuid[];
  v_side2     uuid[];
  v_ref       text;
  v_bad       text;
  v_p         numeric;
  v_model     text;
  v_made      timestamptz;
  v_created   boolean;
  v_n_created integer := 0;
  v_n_replaced integer := 0;
  v_n_refused integer := 0;
BEGIN
  SELECT w.key_id, w.consumer_id INTO v_key_id, v_consumer
    FROM data_api_write_key(p_key_hash, 'predictions:write') w;
  IF v_key_id IS NULL THEN
    item := 0; status := 'refused'; reason := 'key';
    RETURN NEXT;
    RETURN;
  END IF;

  IF (CASE WHEN jsonb_typeof(p_predictions) = 'array'
          THEN jsonb_array_length(p_predictions) NOT BETWEEN 1 AND 100
          ELSE true END) THEN
    item := 0; status := 'refused'; reason := 'batch';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT r.value), ARRAY[]::text[]) INTO v_refs
    FROM jsonb_array_elements(p_predictions) e,
         LATERAL (
           SELECT x.value FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(e.value -> 'side_a') = 'array' THEN e.value -> 'side_a' ELSE '[]'::jsonb END
             || CASE WHEN jsonb_typeof(e.value -> 'side_b') = 'array' THEN e.value -> 'side_b' ELSE '[]'::jsonb END
           ) x
         ) r
   WHERE jsonb_typeof(e.value) = 'object';
  v_map := data_api_ref_map(v_consumer, v_refs);

  FOR v_i IN 0 .. jsonb_array_length(p_predictions) - 1 LOOP
    v_elem := p_predictions -> v_i;
    v_bad := NULL;
    v_format := NULL;
    v_a := ARRAY[]::uuid[];
    v_b := ARRAY[]::uuid[];

    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object' THEN
      v_bad := 'shape';
    ELSE
      v_format := v_elem ->> 'format';
      IF v_format IS NULL OR v_format NOT IN ('singles', 'doubles') THEN
        v_bad := 'format';
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      v_size := CASE v_format WHEN 'singles' THEN 1 ELSE 2 END;
      IF (CASE WHEN jsonb_typeof(v_elem -> 'side_a') = 'array'
                    AND jsonb_typeof(v_elem -> 'side_b') = 'array'
              THEN jsonb_array_length(v_elem -> 'side_a') <> v_size
                   OR jsonb_array_length(v_elem -> 'side_b') <> v_size
              ELSE true END) THEN
        v_bad := 'sides';
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      FOR v_ref IN SELECT jsonb_array_elements_text(v_elem -> 'side_a') LOOP
        IF v_ref !~ '^[0-9a-f]{64}$' OR NOT (v_map ? v_ref) THEN
          v_bad := 'player';
        ELSE
          v_a := v_a || (v_map ->> v_ref)::uuid;
        END IF;
      END LOOP;
      FOR v_ref IN SELECT jsonb_array_elements_text(v_elem -> 'side_b') LOOP
        IF v_ref !~ '^[0-9a-f]{64}$' OR NOT (v_map ? v_ref) THEN
          v_bad := 'player';
        ELSE
          v_b := v_b || (v_map ->> v_ref)::uuid;
        END IF;
      END LOOP;
    END IF;

    IF v_bad IS NULL
       AND (SELECT count(DISTINCT x) FROM unnest(v_a || v_b) x) <> 2 * v_size THEN
      v_bad := 'duplicate';
    END IF;

    IF v_bad IS NULL THEN
      IF jsonb_typeof(v_elem -> 'probability') IS DISTINCT FROM 'number' THEN
        v_bad := 'probability';
      ELSE
        v_p := (v_elem ->> 'probability')::numeric;
        IF v_p < 0 OR v_p > 1 THEN
          v_bad := 'probability';
        END IF;
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      v_model := v_elem ->> 'model';
      IF jsonb_typeof(v_elem -> 'model') IS DISTINCT FROM 'string'
         OR v_model !~ '^[A-Za-z0-9 ._:+-]{1,64}$' THEN
        v_bad := 'model';
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      v_made := NULL;
      IF jsonb_typeof(v_elem -> 'made_at') = 'string' THEN
        BEGIN
          v_made := (v_elem ->> 'made_at')::timestamptz;
        EXCEPTION WHEN others THEN
          v_made := NULL;
        END;
      END IF;
      IF v_made IS NULL OR v_made > now() + interval '5 minutes' THEN
        v_bad := 'made_at';
      END IF;
    END IF;

    IF v_bad IS NOT NULL THEN
      v_n_refused := v_n_refused + 1;
      item := v_i; status := 'refused'; reason := v_bad;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Canonical order: each side ascending, then the side with the smaller
    -- first player is side1, and the probability follows side A.
    v_a := ARRAY(SELECT x FROM unnest(v_a) x ORDER BY x);
    v_b := ARRAY(SELECT x FROM unnest(v_b) x ORDER BY x);
    IF v_a[1] < v_b[1] THEN
      v_side1 := v_a; v_side2 := v_b;
    ELSE
      v_side1 := v_b; v_side2 := v_a; v_p := 1 - v_p;
    END IF;

    INSERT INTO data_api_predictions AS d
      (consumer_id, key_id, format, side1_p1, side1_p2, side2_p1, side2_p2,
       side1_win_probability, model, made_at)
    VALUES
      (v_consumer, v_key_id, v_format, v_side1[1], v_side1[2], v_side2[1], v_side2[2],
       v_p, v_model, v_made)
    ON CONFLICT ON CONSTRAINT data_api_predictions_one_per_matchup DO UPDATE
      SET side1_win_probability = EXCLUDED.side1_win_probability,
          model = EXCLUDED.model,
          made_at = EXCLUDED.made_at,
          key_id = EXCLUDED.key_id,
          updated_at = now()
    RETURNING (d.xmax = 0) INTO v_created;

    IF v_created THEN
      v_n_created := v_n_created + 1;
      item := v_i; status := 'created'; reason := NULL;
    ELSE
      v_n_replaced := v_n_replaced + 1;
      item := v_i; status := 'replaced'; reason := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'data_api_predictions_written', 'data_api_key', v_key_id,
          jsonb_build_object('consumer_id', v_consumer, 'created', v_n_created,
                             'replaced', v_n_replaced, 'refused', v_n_refused),
          'A data API key posted head-to-head predictions');
END;
$function$;

CREATE OR REPLACE FUNCTION public.data_api_delete_predictions(p_key_hash text, p_matchups jsonb)
 RETURNS TABLE(item integer, status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_key_id    uuid;
  v_consumer  uuid;
  v_refs      text[];
  v_map       jsonb;
  v_elem      jsonb;
  v_i         integer;
  v_format    text;
  v_size      integer;
  v_a         uuid[];
  v_b         uuid[];
  v_side1     uuid[];
  v_side2     uuid[];
  v_ref       text;
  v_bad       text;
  v_missing   boolean;
  v_rows      integer;
  v_n_deleted integer := 0;
  v_n_missing integer := 0;
  v_n_refused integer := 0;
BEGIN
  SELECT w.key_id, w.consumer_id INTO v_key_id, v_consumer
    FROM data_api_write_key(p_key_hash, 'predictions:write') w;
  IF v_key_id IS NULL THEN
    item := 0; status := 'refused'; reason := 'key';
    RETURN NEXT;
    RETURN;
  END IF;

  IF (CASE WHEN jsonb_typeof(p_matchups) = 'array'
          THEN jsonb_array_length(p_matchups) NOT BETWEEN 1 AND 100
          ELSE true END) THEN
    item := 0; status := 'refused'; reason := 'batch';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT r.value), ARRAY[]::text[]) INTO v_refs
    FROM jsonb_array_elements(p_matchups) e,
         LATERAL (
           SELECT x.value FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(e.value -> 'side_a') = 'array' THEN e.value -> 'side_a' ELSE '[]'::jsonb END
             || CASE WHEN jsonb_typeof(e.value -> 'side_b') = 'array' THEN e.value -> 'side_b' ELSE '[]'::jsonb END
           ) x
         ) r
   WHERE jsonb_typeof(e.value) = 'object';
  v_map := data_api_ref_map(v_consumer, v_refs);

  FOR v_i IN 0 .. jsonb_array_length(p_matchups) - 1 LOOP
    v_elem := p_matchups -> v_i;
    v_bad := NULL;
    v_missing := false;
    v_format := NULL;
    v_a := ARRAY[]::uuid[];
    v_b := ARRAY[]::uuid[];

    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object' THEN
      v_bad := 'shape';
    ELSE
      v_format := v_elem ->> 'format';
      IF v_format IS NULL OR v_format NOT IN ('singles', 'doubles') THEN
        v_bad := 'format';
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      v_size := CASE v_format WHEN 'singles' THEN 1 ELSE 2 END;
      IF (CASE WHEN jsonb_typeof(v_elem -> 'side_a') = 'array'
                    AND jsonb_typeof(v_elem -> 'side_b') = 'array'
              THEN jsonb_array_length(v_elem -> 'side_a') <> v_size
                   OR jsonb_array_length(v_elem -> 'side_b') <> v_size
              ELSE true END) THEN
        v_bad := 'sides';
      END IF;
    END IF;

    -- A ref that names nobody this consumer can see is simply not found: the
    -- same answer as a matchup with no row, so a delete reveals nothing about
    -- who is hidden either.
    IF v_bad IS NULL THEN
      FOR v_ref IN SELECT jsonb_array_elements_text(v_elem -> 'side_a') LOOP
        IF v_ref !~ '^[0-9a-f]{64}$' OR NOT (v_map ? v_ref) THEN
          v_missing := true;
        ELSE
          v_a := v_a || (v_map ->> v_ref)::uuid;
        END IF;
      END LOOP;
      FOR v_ref IN SELECT jsonb_array_elements_text(v_elem -> 'side_b') LOOP
        IF v_ref !~ '^[0-9a-f]{64}$' OR NOT (v_map ? v_ref) THEN
          v_missing := true;
        ELSE
          v_b := v_b || (v_map ->> v_ref)::uuid;
        END IF;
      END LOOP;
    END IF;

    IF v_bad IS NOT NULL THEN
      v_n_refused := v_n_refused + 1;
      item := v_i; status := 'refused'; reason := v_bad;
      RETURN NEXT;
      CONTINUE;
    END IF;

    v_rows := 0;
    IF NOT v_missing THEN
      v_a := ARRAY(SELECT x FROM unnest(v_a) x ORDER BY x);
      v_b := ARRAY(SELECT x FROM unnest(v_b) x ORDER BY x);
      IF v_a[1] < v_b[1] THEN
        v_side1 := v_a; v_side2 := v_b;
      ELSE
        v_side1 := v_b; v_side2 := v_a;
      END IF;
      DELETE FROM data_api_predictions d
       WHERE d.consumer_id = v_consumer
         AND d.format = v_format
         AND d.side1_p1 = v_side1[1]
         AND d.side1_p2 IS NOT DISTINCT FROM v_side1[2]
         AND d.side2_p1 = v_side2[1]
         AND d.side2_p2 IS NOT DISTINCT FROM v_side2[2];
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;

    IF v_rows > 0 THEN
      v_n_deleted := v_n_deleted + 1;
      item := v_i; status := 'deleted'; reason := NULL;
    ELSE
      v_n_missing := v_n_missing + 1;
      item := v_i; status := 'not_found'; reason := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'data_api_predictions_deleted', 'data_api_key', v_key_id,
          jsonb_build_object('consumer_id', v_consumer, 'deleted', v_n_deleted,
                             'not_found', v_n_missing, 'refused', v_n_refused),
          'A data API key deleted head-to-head predictions');
END;
$function$;

REVOKE ALL ON FUNCTION public.data_api_write_predictions(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.data_api_delete_predictions(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_write_predictions(text, jsonb) TO data_api_reader;
GRANT EXECUTE ON FUNCTION public.data_api_delete_predictions(text, jsonb) TO data_api_reader;

-- ---- 3. A TOURNAMENT FEE CAN BE OWED BY SOMEBODY WITHOUT AN ACCOUNT --------
-- The tournament arm splits in two: a member's row as before, or a named row
-- (player_id NULL) that must carry both the name and the email it was entered
-- under, so it can be claimed when that person signs up (section 3b) and
-- reconciled until then. num_nonnulls(player_id, manual_name) = 1 already
-- forbids a row with both or neither.
ALTER TABLE public.club_fees DROP CONSTRAINT IF EXISTS club_fees_shape_check;
ALTER TABLE public.club_fees ADD CONSTRAINT club_fees_shape_check CHECK (
  CASE fee_type
    WHEN 'dues' THEN ((season_id IS NOT NULL) AND (tournament_id IS NULL) AND (tier_id IS NULL)
                      AND (ban_started_at IS NULL) AND (ban_reason IS NULL) AND (club_event_id IS NULL))
    WHEN 'tournament' THEN ((tournament_id IS NOT NULL) AND (ban_started_at IS NULL) AND (ban_reason IS NULL)
                      AND (club_event_id IS NULL)
                      AND ((player_id IS NOT NULL AND manual_name IS NULL AND manual_email IS NULL)
                        OR (player_id IS NULL AND manual_name IS NOT NULL AND manual_email IS NOT NULL)))
    WHEN 'reinstatement' THEN ((ban_started_at IS NOT NULL) AND (manual_name IS NULL) AND (tournament_id IS NULL)
                      AND (tier_id IS NULL) AND (club_event_id IS NULL))
    WHEN 'event' THEN ((club_event_id IS NOT NULL) AND (player_id IS NOT NULL) AND (manual_name IS NULL)
                      AND (tournament_id IS NULL) AND (tier_id IS NULL) AND (ban_started_at IS NULL)
                      AND (ban_reason IS NULL))
    ELSE false
  END);

ALTER TABLE public.club_fees DROP CONSTRAINT IF EXISTS club_fees_manual_email_shape;
ALTER TABLE public.club_fees ADD CONSTRAINT club_fees_manual_email_shape CHECK (
  manual_email IS NULL OR (
    manual_name IS NOT NULL
    AND player_id IS NULL
    AND fee_type IN ('dues', 'tournament')
    AND manual_email = lower(btrim(manual_email))
    AND manual_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND char_length(manual_email) <= 254
  ));

CREATE UNIQUE INDEX IF NOT EXISTS club_fees_tournament_manual_email_key
  ON public.club_fees (tournament_id, lower(manual_email))
  WHERE fee_type = 'tournament' AND player_id IS NULL;

-- ---- 3b. THE CLAIM REACHES TOURNAMENT ROWS ----------------------------------
-- 00252's trigger, with a second block for named tournament rows. Each block
-- is its own subtransaction and only WARNS, as 00252's does: a fee that cannot
-- be moved must never stop an account being created. A tournament row is not
-- claimed when the new account already owes a fee for that tournament (the
-- one-row-per-member-per-tournament index would refuse it); it stays named and
-- visible on the fees page.
CREATE OR REPLACE FUNCTION public.claim_named_fees_for_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' OR NEW.email LIKE '%@deleted.invalid' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.email IS NOT DISTINCT FROM NEW.email THEN
    RETURN NULL;
  END IF;

  BEGIN
    WITH claimable AS (
      SELECT f.id, f.manual_name
        FROM public.club_fees f
       WHERE f.player_id IS NULL
         AND f.fee_type = 'dues'
         AND lower(f.manual_email) = NEW.email
         AND NOT EXISTS (
           SELECT 1 FROM public.club_fees d
            WHERE d.player_id = NEW.id
              AND d.fee_type = 'dues'
              AND d.season_id = f.season_id
         )
       FOR UPDATE
    ), claimed AS (
      UPDATE public.club_fees f
         SET player_id = NEW.id, manual_name = NULL, manual_email = NULL
        FROM claimable c
       WHERE f.id = c.id
      RETURNING f.id, f.season_id, c.manual_name
    )
    INSERT INTO public.audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
    SELECT NULL, 'manual_fee_claimed', 'club_fee', claimed.id,
           jsonb_build_object('manual_name', claimed.manual_name),
           jsonb_build_object('player_id', NEW.id, 'season_id', claimed.season_id),
           'A named payment moved onto the account that signed up with its email'
      FROM claimed;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00252: could not claim named fees for player %: %', NEW.id, SQLERRM;
  END;

  BEGIN
    WITH claimable AS (
      SELECT f.id, f.manual_name
        FROM public.club_fees f
       WHERE f.player_id IS NULL
         AND f.fee_type = 'tournament'
         AND lower(f.manual_email) = NEW.email
         AND NOT EXISTS (
           SELECT 1 FROM public.club_fees d
            WHERE d.player_id = NEW.id
              AND d.fee_type = 'tournament'
              AND d.tournament_id = f.tournament_id
         )
       FOR UPDATE
    ), claimed AS (
      UPDATE public.club_fees f
         SET player_id = NEW.id, manual_name = NULL, manual_email = NULL
        FROM claimable c
       WHERE f.id = c.id
      RETURNING f.id, f.tournament_id, c.manual_name
    )
    INSERT INTO public.audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
    SELECT NULL, 'manual_fee_claimed', 'club_fee', claimed.id,
           jsonb_build_object('manual_name', claimed.manual_name),
           jsonb_build_object('player_id', NEW.id, 'tournament_id', claimed.tournament_id),
           'A named tournament fee moved onto the account that signed up with its email'
      FROM claimed;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00283: could not claim named tournament fees for player %: %', NEW.id, SQLERRM;
  END;

  RETURN NULL;
END;
$function$;

-- ---- 4. THE TABLES ----------------------------------------------------------

-- 4a. A form bound to exactly one target. The target columns are SET NULL so
-- deleting a tournament never deletes the record of what its form sent (owner
-- decision: imports are kept); a binding left with no target answers
-- not_found.
CREATE TABLE IF NOT EXISTS public.registration_import_forms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id      uuid NOT NULL REFERENCES public.data_api_consumers(id) ON DELETE RESTRICT,
  form_id          text NOT NULL,
  target_kind      text NOT NULL,
  tournament_id    uuid REFERENCES public.tournaments(id) ON DELETE SET NULL,
  club_event_id    uuid REFERENCES public.club_events(id) ON DELETE SET NULL,
  join_waitlist    boolean NOT NULL DEFAULT false,
  solo_doubles_ack boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES public.players(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_import_forms_form_id_shape
    CHECK (char_length(btrim(form_id)) BETWEEN 1 AND 200 AND form_id = btrim(form_id)),
  CONSTRAINT registration_import_forms_target_kind
    CHECK (target_kind IN ('tournament', 'club_event')),
  CONSTRAINT registration_import_forms_one_target
    CHECK (num_nonnulls(tournament_id, club_event_id) <= 1
           AND (tournament_id IS NULL OR target_kind = 'tournament')
           AND (club_event_id IS NULL OR target_kind = 'club_event')),
  CONSTRAINT registration_import_forms_consumer_form_key UNIQUE (consumer_id, form_id)
);
CREATE INDEX IF NOT EXISTS registration_import_forms_tournament
  ON public.registration_import_forms (tournament_id) WHERE tournament_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS registration_import_forms_club_event
  ON public.registration_import_forms (club_event_id) WHERE club_event_id IS NOT NULL;

-- 4b. One row per form response. submitter_name and submitter_email are kept
-- ONLY when the email matched no member; a member is the player id.
CREATE TABLE IF NOT EXISTS public.registration_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id          uuid NOT NULL REFERENCES public.registration_import_forms(id) ON DELETE RESTRICT,
  key_id              uuid NOT NULL REFERENCES public.data_api_keys(id) ON DELETE RESTRICT,
  response_id         text NOT NULL,
  submitted_at        timestamptz,
  payload_hash        text NOT NULL,
  result              jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitter_player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  submitter_name      text,
  submitter_email     text,
  superseded_by       uuid REFERENCES public.registration_imports(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_imports_response_shape
    CHECK (char_length(response_id) BETWEEN 1 AND 200),
  CONSTRAINT registration_imports_submitter_email_shape
    CHECK (submitter_email IS NULL OR (submitter_email = lower(btrim(submitter_email))
           AND char_length(submitter_email) <= 254)),
  CONSTRAINT registration_imports_member_has_no_email
    CHECK (submitter_player_id IS NULL OR (submitter_email IS NULL AND submitter_name IS NULL)),
  CONSTRAINT registration_imports_binding_response_key UNIQUE (binding_id, response_id)
);
CREATE INDEX IF NOT EXISTS registration_imports_submitter_player
  ON public.registration_imports (binding_id, submitter_player_id) WHERE submitter_player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS registration_imports_submitter_email
  ON public.registration_imports (binding_id, submitter_email) WHERE submitter_email IS NOT NULL;

-- 4c. One row per event a response asked for. The partner's name and email
-- are kept only when they matched no member.
CREATE TABLE IF NOT EXISTS public.registration_import_entries (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id                  uuid NOT NULL REFERENCES public.registration_imports(id) ON DELETE CASCADE,
  item                       integer NOT NULL,
  tournament_event_id        uuid REFERENCES public.tournament_events(id) ON DELETE SET NULL,
  club_event_id              uuid REFERENCES public.club_events(id) ON DELETE SET NULL,
  entrant_id                 uuid REFERENCES public.players(id) ON DELETE SET NULL,
  requested_partner_id       uuid REFERENCES public.players(id) ON DELETE SET NULL,
  external_name              text,
  external_email             text,
  partner_name               text,
  partner_email              text,
  category                   text,
  participant_id             uuid REFERENCES public.tournament_participants(id) ON DELETE SET NULL,
  pair_id                    uuid REFERENCES public.tournament_pairs(id) ON DELETE SET NULL,
  fee_id                     uuid REFERENCES public.club_fees(id) ON DELETE SET NULL,
  fee_created_by_import      boolean NOT NULL DEFAULT false,
  wants_waitlist             boolean NOT NULL DEFAULT false,
  status                     text NOT NULL,
  reason                     text,
  confirmed_at               timestamptz,
  confirm_email_attempted_at timestamptz,
  confirm_email_attempts     integer NOT NULL DEFAULT 0,
  confirm_email_sent_at      timestamptz,
  confirm_email_error        text,
  undone_at                  timestamptz,
  undone_by                  uuid REFERENCES public.players(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_import_entries_status CHECK (status IN (
    'entered', 'awaiting_partner', 'awaiting_member', 'needs_review', 'refused', 'undone', 'superseded')),
  CONSTRAINT registration_import_entries_one_event
    CHECK (num_nonnulls(tournament_event_id, club_event_id) <= 1),
  CONSTRAINT registration_import_entries_member_or_external
    CHECK (entrant_id IS NULL OR (external_name IS NULL AND external_email IS NULL)),
  CONSTRAINT registration_import_entries_partner_or_named
    CHECK (requested_partner_id IS NULL OR (partner_name IS NULL AND partner_email IS NULL)),
  CONSTRAINT registration_import_entries_email_shape
    CHECK ((external_email IS NULL OR (external_email = lower(btrim(external_email)) AND char_length(external_email) <= 254))
       AND (partner_email IS NULL OR (partner_email = lower(btrim(partner_email)) AND char_length(partner_email) <= 254))),
  CONSTRAINT registration_import_entries_attempts CHECK (confirm_email_attempts >= 0)
);
CREATE INDEX IF NOT EXISTS registration_import_entries_import
  ON public.registration_import_entries (import_id);
CREATE INDEX IF NOT EXISTS registration_import_entries_event
  ON public.registration_import_entries (tournament_event_id) WHERE tournament_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS registration_import_entries_club_event
  ON public.registration_import_entries (club_event_id) WHERE club_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS registration_import_entries_entrant
  ON public.registration_import_entries (entrant_id) WHERE entrant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS registration_import_entries_confirm_outbox
  ON public.registration_import_entries (created_at)
  WHERE status = 'awaiting_member' AND confirm_email_sent_at IS NULL;

-- 4d. The guest waiver outbox. One invite per email per target, ever.
CREATE TABLE IF NOT EXISTS public.guest_waiver_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  target_kind     text NOT NULL,
  target_id       uuid NOT NULL,
  import_entry_id uuid REFERENCES public.registration_import_entries(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  attempted_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  sent_at         timestamptz,
  cancelled_at    timestamptz,
  last_error      text,
  CONSTRAINT guest_waiver_invites_email_shape
    CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(email) <= 254),
  CONSTRAINT guest_waiver_invites_target_kind CHECK (target_kind IN ('tournament', 'club_event')),
  CONSTRAINT guest_waiver_invites_attempts CHECK (attempts >= 0),
  CONSTRAINT guest_waiver_invites_email_target_key UNIQUE (email, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS guest_waiver_invites_outbox
  ON public.guest_waiver_invites (created_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- Service role reads and writes through the functions below and the console's
-- reads; nobody else touches these tables at all.
ALTER TABLE public.registration_import_forms   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_imports        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_import_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_waiver_invites        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.registration_import_forms   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.registration_imports        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.registration_import_entries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.guest_waiver_invites        FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.registration_import_forms TO service_role;
GRANT SELECT ON public.registration_imports        TO service_role;
GRANT SELECT ON public.registration_import_entries TO service_role;
GRANT SELECT ON public.guest_waiver_invites        TO service_role;

-- ---- 5. selectFeeTier, IN PLPGSQL -------------------------------------------
-- Tiers are passed as a jsonb array of {id, name, amount_cents, is_default,
-- sort_order, applies_to}, so the proof block below can run the function
-- against the case table without a tournament. Names compare with COLLATE "C";
-- the case table avoids names whose order differs between that and
-- localeCompare, and a real tournament's tier names are unique per tournament.
CREATE OR REPLACE FUNCTION public.select_fee_tier(p_group text, p_tiers jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH tiers AS (
    SELECT t AS tier,
           t ->> 'name' AS name,
           COALESCE((t ->> 'sort_order')::integer, 0) AS sort_order,
           COALESCE((t ->> 'is_default')::boolean, false) AS is_default,
           CASE WHEN jsonb_typeof(t -> 'applies_to') = 'array'
                THEN ARRAY(SELECT jsonb_array_elements_text(t -> 'applies_to')) END AS applies_to
      FROM jsonb_array_elements(COALESCE(p_tiers, '[]'::jsonb)) t
  ), picked AS (
    (SELECT tier, 1 AS rank_group, cardinality(applies_to) AS specificity, sort_order, name
       FROM tiers
      WHERE applies_to IS NOT NULL AND COALESCE(p_group, 'internal') = ANY (applies_to))
    UNION ALL
    (SELECT tier, 2, 0, sort_order, name
       FROM tiers
      WHERE applies_to IS NULL OR cardinality(applies_to) = 0)
    UNION ALL
    (SELECT tier, 3, 0, sort_order, name FROM tiers WHERE is_default)
  )
  SELECT tier FROM picked
   ORDER BY rank_group, specificity, sort_order, name COLLATE "C"
   LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.select_fee_tier(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.select_fee_tier(text, jsonb) TO service_role;

-- The case table, byte for byte the TypeScript FEE_TIER_CASES
-- (packages/shared/src/utils/fee-tiers.ts). The suite reads it off this file.
DO $proof$
DECLARE
  v_source text := $cases$
-- @fee-tier-cases-begin
[
  {"name": "no tiers at all", "group": "external", "tiers": [], "expected": null},
  {"name": "only a default", "group": "external", "tiers": [{"id": "d", "name": "Standard", "amount_cents": 1500, "is_default": true, "sort_order": 0, "applies_to": null}], "expected": "d"},
  {"name": "targeted beats anyone", "group": "external", "tiers": [{"id": "a", "name": "Anyone", "amount_cents": 1000, "is_default": false, "sort_order": 0, "applies_to": null}, {"id": "x", "name": "Guests", "amount_cents": 2500, "is_default": false, "sort_order": 5, "applies_to": ["external"]}], "expected": "x"},
  {"name": "fewest groups wins", "group": "external", "tiers": [{"id": "w", "name": "Wide", "amount_cents": 2000, "is_default": false, "sort_order": 0, "applies_to": ["external", "alumni"]}, {"id": "n", "name": "Narrow", "amount_cents": 2500, "is_default": false, "sort_order": 9, "applies_to": ["external"]}], "expected": "n"},
  {"name": "sort order breaks a tie", "group": "internal", "tiers": [{"id": "b", "name": "Bravo", "amount_cents": 900, "is_default": false, "sort_order": 2, "applies_to": ["internal"]}, {"id": "a", "name": "Alpha", "amount_cents": 800, "is_default": false, "sort_order": 1, "applies_to": ["internal"]}], "expected": "a"},
  {"name": "name breaks a sort tie", "group": "internal", "tiers": [{"id": "b", "name": "Bravo", "amount_cents": 900, "is_default": false, "sort_order": 1, "applies_to": ["internal"]}, {"id": "a", "name": "Alpha", "amount_cents": 800, "is_default": false, "sort_order": 1, "applies_to": ["internal"]}], "expected": "a"},
  {"name": "another group falls to anyone", "group": "alumni", "tiers": [{"id": "i", "name": "Members", "amount_cents": 1000, "is_default": false, "sort_order": 0, "applies_to": ["internal"]}, {"id": "o", "name": "Open", "amount_cents": 1800, "is_default": false, "sort_order": 3, "applies_to": null}], "expected": "o"},
  {"name": "empty applies_to reads as anyone", "group": "external", "tiers": [{"id": "e", "name": "Everyone", "amount_cents": 1200, "is_default": false, "sort_order": 0, "applies_to": []}], "expected": "e"},
  {"name": "default only when nobody else fits", "group": "external", "tiers": [{"id": "i", "name": "Members", "amount_cents": 1000, "is_default": false, "sort_order": 0, "applies_to": ["internal"]}, {"id": "d", "name": "Fallback", "amount_cents": 3000, "is_default": true, "sort_order": 9, "applies_to": ["internal"]}], "expected": "d"},
  {"name": "no match and no default", "group": "external", "tiers": [{"id": "i", "name": "Members", "amount_cents": 1000, "is_default": false, "sort_order": 0, "applies_to": ["internal"]}], "expected": null},
  {"name": "a null group reads as internal", "group": null, "tiers": [{"id": "i", "name": "Members", "amount_cents": 1000, "is_default": false, "sort_order": 0, "applies_to": ["internal"]}, {"id": "o", "name": "Open", "amount_cents": 1800, "is_default": false, "sort_order": 0, "applies_to": null}], "expected": "i"}
]
-- @fee-tier-cases-end
$cases$;
  v_cases jsonb;
  v_case jsonb;
  v_got  text;
BEGIN
  v_cases := substring(v_source from '\[.*\]')::jsonb;
  FOR v_case IN SELECT * FROM jsonb_array_elements(v_cases) LOOP
    v_got := public.select_fee_tier(v_case ->> 'group', v_case -> 'tiers') ->> 'id';
    IF v_got IS DISTINCT FROM (v_case ->> 'expected') THEN
      RAISE EXCEPTION '00283: select_fee_tier disagrees with selectFeeTier on "%": got %, expected %',
        v_case ->> 'name', v_got, v_case ->> 'expected';
    END IF;
  END LOOP;
END
$proof$;

-- The tiers of one tournament, in the shape select_fee_tier takes.
CREATE OR REPLACE FUNCTION public.tournament_fee_tiers_json(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'amount_cents', t.amount_cents,
           'is_default', t.is_default, 'sort_order', t.sort_order,
           'applies_to', to_jsonb(t.applies_to))), '[]'::jsonb)
    FROM tournament_fee_tiers t
   WHERE t.tournament_id = p_tournament_id;
$function$;

REVOKE ALL ON FUNCTION public.tournament_fee_tiers_json(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 6. THE SEAMS 00284 FILLS -----------------------------------------------
-- How many places of a club event are taken. 00284 adds the external signups.
CREATE OR REPLACE FUNCTION public.club_event_taken(p_event_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT count(*)::integer FROM club_event_signups WHERE event_id = p_event_id;
$function$;

REVOKE ALL ON FUNCTION public.club_event_taken(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_taken(uuid) TO service_role;

-- Until 00284, a non-member who answers a club event's form is parked.
CREATE OR REPLACE FUNCTION public.club_event_external_sign_up(
  p_event_id uuid, p_name text, p_email text, p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN jsonb_build_object('ok', false, 'reason', 'external_not_available');
END;
$function$;

CREATE OR REPLACE FUNCTION public.club_event_external_retire(p_entry_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN 'external_not_available';
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_external_sign_up(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.club_event_external_retire(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 7. RETIRING AN ENTRY ---------------------------------------------------
-- Takes an entry out of play: removes what it made live, deletes the fee only
-- when this import created it and it is unpaid, cancels an unsent invite.
-- Returns NULL on success, otherwise why it could not. The CALLER holds the
-- locks (binding, field key, tournaments, event) and decides the new status;
-- this only does the work. Never granted: called by the dispatcher and by
-- undo_registration_import_entry.
CREATE OR REPLACE FUNCTION public.registration_import_retire(p_entry_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_entry  registration_import_entries%ROWTYPE;
  v_status text;
  v_locked boolean;
  v_result jsonb;
  v_fee    club_fees%ROWTYPE;
  v_why    text;
BEGIN
  SELECT * INTO v_entry FROM registration_import_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'entry_not_found';
  END IF;

  -- The club event side lives in 00284.
  IF v_entry.club_event_id IS NOT NULL AND v_entry.entrant_id IS NULL
     AND v_entry.status = 'entered' THEN
    v_why := public.club_event_external_retire(p_entry_id);
    IF v_why IS NOT NULL THEN
      RETURN v_why;
    END IF;
  END IF;

  IF v_entry.pair_id IS NOT NULL OR v_entry.participant_id IS NOT NULL THEN
    SELECT e.status::text, e.draw_locked INTO v_status, v_locked
      FROM tournament_events e WHERE e.id = v_entry.tournament_event_id;
    IF v_status IS NULL OR v_status NOT IN ('registration', 'checkin') OR COALESCE(v_locked, false) THEN
      RETURN 'draw_exists';
    END IF;
  END IF;

  -- The fee first: a paid fee stops the whole retirement, so nothing is
  -- removed from the field for an entry the club has taken money for.
  IF v_entry.fee_id IS NOT NULL AND v_entry.fee_created_by_import THEN
    SELECT * INTO v_fee FROM club_fees WHERE id = v_entry.fee_id FOR UPDATE;
    IF FOUND AND v_fee.paid_at IS NOT NULL THEN
      RETURN 'fee_paid';
    END IF;
  END IF;

  IF v_entry.pair_id IS NOT NULL THEN
    v_result := public.remove_field_entry(v_entry.pair_id, true);
    IF NOT COALESCE((v_result ->> 'ok')::boolean, false)
       AND v_result ->> 'reason' IS DISTINCT FROM 'entry_not_found' THEN
      RETURN COALESCE(v_result ->> 'reason', 'remove_failed');
    END IF;
  END IF;
  IF v_entry.participant_id IS NOT NULL THEN
    v_result := public.remove_field_entry(v_entry.participant_id, false);
    IF NOT COALESCE((v_result ->> 'ok')::boolean, false)
       AND v_result ->> 'reason' IS DISTINCT FROM 'entry_not_found' THEN
      RETURN COALESCE(v_result ->> 'reason', 'remove_failed');
    END IF;
  END IF;

  IF v_entry.fee_id IS NOT NULL AND v_entry.fee_created_by_import THEN
    DELETE FROM club_fees WHERE id = v_entry.fee_id AND paid_at IS NULL;
  END IF;

  UPDATE guest_waiver_invites
     SET cancelled_at = now()
   WHERE import_entry_id = p_entry_id AND sent_at IS NULL AND cancelled_at IS NULL;

  UPDATE registration_import_entries
     SET pair_id = NULL, participant_id = NULL,
         fee_id = CASE WHEN fee_created_by_import THEN NULL ELSE fee_id END,
         updated_at = now()
   WHERE id = p_entry_id;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.registration_import_retire(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 8. THE DISPATCHER ------------------------------------------------------
--
-- p_payload, as the Apps Script sends it (the service validates the shape
-- first and this re-checks it):
--   { "form_id": text, "response_id": text, "submitted_at": iso text or null,
--     "email": text, "name": text,
--     "entries": [ { "event_id": uuid, "partner_email": text?,
--                    "partner_name": text?, "category": text? } ] }
-- A club event binding needs no entries: the one event is the binding's.
--
-- One row per entry, plus item 0 alone when the whole response is refused
-- (key, bad_payload, not_found). The service turns a `key` refusal into 401.
CREATE OR REPLACE FUNCTION public.data_api_import_registration(p_key_hash text, p_payload jsonb)
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
  -- ---- the key ----
  SELECT w.consumer_id, w.key_id INTO v_consumer, v_key_id
    FROM data_api_write_key(p_key_hash, 'registrations:write') w;
  IF v_key_id IS NULL THEN
    item := 0; event_id := NULL; status := 'refused'; reason := 'key'; replayed := false;
    RETURN NEXT;
    RETURN;
  END IF;

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
  IF NOT FOUND OR NOT v_binding.active
     OR num_nonnulls(v_binding.tournament_id, v_binding.club_event_id) = 0 THEN
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
       SET payload_hash = v_hash, submitted_at = v_submitted, key_id = v_key_id,
           submitter_player_id = CASE WHEN v_has_member THEN v_member.id END,
           submitter_name = CASE WHEN v_has_member THEN NULL ELSE v_name END,
           submitter_email = CASE WHEN v_has_member THEN NULL ELSE v_email END,
           updated_at = now()
     WHERE id = v_prior.id
    RETURNING * INTO v_import;
  ELSE
    INSERT INTO registration_imports (binding_id, key_id, response_id, submitted_at, payload_hash,
                                      submitter_player_id, submitter_name, submitter_email)
    VALUES (v_binding.id, v_key_id, v_response_id, v_submitted, v_hash,
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
                             'edited', v_is_edit, 'superseded', v_has_prior AND NOT v_is_edit,
                             'entered', v_n_entered, 'pending', v_n_pending, 'refused', v_n_refused),
          'A form response arrived through the data API');

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

REVOKE ALL ON FUNCTION public.data_api_import_registration(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.data_api_import_registration(text, jsonb) TO data_api_reader;

-- ---- 9. THE MEMBER'S SIDE ---------------------------------------------------
-- The app has already run the member's own entry (registerForEvent or
-- signUpForClubEvent) when it calls this; this records it. Ownership is
-- checked here: p_player_id is the signed-in member, and the entry must be
-- theirs and still waiting on them. Returns {ok, status, partner_entry_id,
-- partner_player_id}; when partner_entry_id is set the app pairs the two
-- with pair_registration_import_entries.
CREATE OR REPLACE FUNCTION public.settle_registration_import_entry(p_entry_id uuid, p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_peek     registration_import_entries%ROWTYPE;
  v_entry    registration_import_entries%ROWTYPE;
  v_binding  uuid;
  v_part     uuid;
  v_partner  registration_import_entries%ROWTYPE;
  v_doubles  boolean;
  v_status   text;
BEGIN
  SELECT * INTO v_peek FROM registration_import_entries WHERE id = p_entry_id;
  IF NOT FOUND OR v_peek.entrant_id IS DISTINCT FROM p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT i.binding_id INTO v_binding FROM registration_imports i WHERE i.id = v_peek.import_id;
  PERFORM 1 FROM registration_import_forms f WHERE f.id = v_binding FOR UPDATE;
  IF v_peek.tournament_event_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_peek.tournament_event_id::text));
  END IF;

  SELECT * INTO v_entry FROM registration_import_entries WHERE id = p_entry_id FOR UPDATE;
  IF v_entry.entrant_id IS DISTINCT FROM p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_entry.status NOT IN ('awaiting_member', 'awaiting_partner') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_waiting', 'status', v_entry.status);
  END IF;

  IF v_entry.club_event_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM club_event_signups s
                    WHERE s.event_id = v_entry.club_event_id AND s.player_id = p_player_id) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_entered');
    END IF;
    UPDATE registration_import_entries
       SET status = 'entered', reason = NULL, confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
     WHERE id = p_entry_id;
    INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
    VALUES (p_player_id, 'registration_import_confirmed', 'registration_import_entry', p_entry_id,
            jsonb_build_object('club_event_id', v_entry.club_event_id), 'A member confirmed a form sign-up');
    RETURN jsonb_build_object('ok', true, 'status', 'entered');
  END IF;

  SELECT tp.id INTO v_part FROM tournament_participants tp
   WHERE tp.event_id = v_entry.tournament_event_id AND tp.player_id = p_player_id
     AND tp.status NOT IN ('withdrawn', 'disqualified');
  IF v_part IS NULL THEN
    -- Already paired some other way counts as entered, unpaired from here.
    IF EXISTS (SELECT 1 FROM tournament_pairs pr
                WHERE pr.event_id = v_entry.tournament_event_id
                  AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
                  AND COALESCE(pr.status::text, '') NOT IN ('withdrawn', 'disqualified')) THEN
      UPDATE registration_import_entries
         SET status = 'entered', reason = 'paired_elsewhere',
             confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
       WHERE id = p_entry_id;
      RETURN jsonb_build_object('ok', true, 'status', 'entered');
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'not_entered');
  END IF;

  SELECT e.event_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles') INTO v_doubles
    FROM tournament_events e WHERE e.id = v_entry.tournament_event_id;

  v_status := CASE WHEN v_doubles AND v_entry.requested_partner_id IS NOT NULL
                   THEN 'awaiting_partner' ELSE 'entered' END;
  UPDATE registration_import_entries
     SET status = v_status, reason = NULL, participant_id = v_part,
         confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
   WHERE id = p_entry_id;

  IF v_entry.status = 'awaiting_member' THEN
    INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
    VALUES (p_player_id, 'registration_import_confirmed', 'registration_import_entry', p_entry_id,
            jsonb_build_object('event_id', v_entry.tournament_event_id), 'A member confirmed a form entry');
  END IF;

  IF v_status = 'awaiting_partner' THEN
    -- The partner's entry: theirs, naming this member, confirmed, unpaired.
    SELECT * INTO v_partner FROM registration_import_entries en
     WHERE en.tournament_event_id = v_entry.tournament_event_id
       AND en.entrant_id = v_entry.requested_partner_id
       AND en.requested_partner_id = p_player_id
       AND en.status = 'awaiting_partner'
       AND en.participant_id IS NOT NULL
     ORDER BY en.created_at DESC
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'status', v_status,
                                'partner_entry_id', v_partner.id,
                                'partner_player_id', v_partner.entrant_id);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$function$;

-- Pair two mutually confirmed entries. The app computes the pair name and the
-- combined rating with the same code the console uses (calculateTeamRating),
-- per 00070's rule that the arithmetic stays out of the database.
CREATE OR REPLACE FUNCTION public.pair_registration_import_entries(
  p_entry_id uuid, p_player_id uuid, p_pair_name text, p_combined_elo integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_peek    registration_import_entries%ROWTYPE;
  v_mine    registration_import_entries%ROWTYPE;
  v_theirs  registration_import_entries%ROWTYPE;
  v_binding uuid;
  v_pair    uuid;
BEGIN
  SELECT * INTO v_peek FROM registration_import_entries WHERE id = p_entry_id;
  IF NOT FOUND OR v_peek.entrant_id IS DISTINCT FROM p_player_id OR v_peek.tournament_event_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT i.binding_id INTO v_binding FROM registration_imports i WHERE i.id = v_peek.import_id;
  PERFORM 1 FROM registration_import_forms f WHERE f.id = v_binding FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_peek.tournament_event_id::text));

  SELECT * INTO v_mine FROM registration_import_entries WHERE id = p_entry_id FOR UPDATE;
  SELECT * INTO v_theirs FROM registration_import_entries en
   WHERE en.tournament_event_id = v_mine.tournament_event_id
     AND en.entrant_id = v_mine.requested_partner_id
     AND en.requested_partner_id = p_player_id
     AND en.status = 'awaiting_partner'
     AND en.participant_id IS NOT NULL
   ORDER BY en.created_at DESC
   LIMIT 1
   FOR UPDATE;
  IF v_mine.status <> 'awaiting_partner' OR v_theirs.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_mutual');
  END IF;

  BEGIN
    v_pair := public.pair_tournament_entrants(
      v_mine.tournament_event_id, v_mine.entrant_id, v_theirs.entrant_id,
      left(COALESCE(p_pair_name, ''), 200), p_combined_elo, NULL);
  EXCEPTION WHEN check_violation OR unique_violation OR no_data_found THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pairing_refused', 'detail', SQLERRM);
  END;

  UPDATE registration_import_entries
     SET status = 'entered', reason = NULL, pair_id = v_pair, participant_id = NULL, updated_at = now()
   WHERE id IN (v_mine.id, v_theirs.id);

  RETURN jsonb_build_object('ok', true, 'pair_id', v_pair);
END;
$function$;

-- "Not me". Nothing went live, so this is a status change, an audit row and a
-- word to the exec who bound the form (or the admins when nobody did).
CREATE OR REPLACE FUNCTION public.reject_registration_import_entry(p_entry_id uuid, p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_entry   registration_import_entries%ROWTYPE;
  v_creator uuid;
  v_title   text;
BEGIN
  SELECT * INTO v_entry FROM registration_import_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND OR v_entry.entrant_id IS DISTINCT FROM p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_entry.status <> 'awaiting_member' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_waiting', 'status', v_entry.status);
  END IF;

  UPDATE registration_import_entries
     SET status = 'refused', reason = 'not_me', updated_at = now()
   WHERE id = p_entry_id;

  SELECT f.created_by,
         COALESCE(t.name, ce.title, 'a form')
    INTO v_creator, v_title
    FROM registration_imports i
    JOIN registration_import_forms f ON f.id = i.binding_id
    LEFT JOIN tournaments t ON t.id = f.tournament_id
    LEFT JOIN club_events ce ON ce.id = f.club_event_id
   WHERE i.id = v_entry.import_id;

  INSERT INTO notifications (player_id, type, title, body, metadata)
  SELECT p.id, 'admin_alert', 'A form entry was not theirs',
         format('A member says a response to the form for %s used their email but was not them. Check the imported entries.', v_title),
         jsonb_build_object('kind', 'registration_import_rejected', 'entry_id', p_entry_id)
    FROM players p
   WHERE (v_creator IS NOT NULL AND p.id = v_creator)
      OR (v_creator IS NULL AND p.role = 'admin');

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (p_player_id, 'registration_import_rejected', 'registration_import_entry', p_entry_id,
          jsonb_build_object('import_id', v_entry.import_id), 'A member said a form response was not theirs');

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_registration_import_entry(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pair_registration_import_entries(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_registration_import_entry(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_registration_import_entry(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pair_registration_import_entries(uuid, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_registration_import_entry(uuid, uuid) TO service_role;

-- ---- 10. UNDO, FROM THE CONSOLE ---------------------------------------------
-- The console checks the capability (the remove capability of the field the
-- entry is in) and passes the exec. Refuses once the draw exists or when the
-- fee this import created has been paid.
CREATE OR REPLACE FUNCTION public.undo_registration_import_entry(p_entry_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_peek       registration_import_entries%ROWTYPE;
  v_entry      registration_import_entries%ROWTYPE;
  v_binding    uuid;
  v_tournament uuid;
  v_why        text;
  v_fill       jsonb;
BEGIN
  SELECT * INTO v_peek FROM registration_import_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT i.binding_id INTO v_binding FROM registration_imports i WHERE i.id = v_peek.import_id;
  PERFORM 1 FROM registration_import_forms f WHERE f.id = v_binding FOR UPDATE;
  IF v_peek.tournament_event_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_peek.tournament_event_id::text));
    SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = v_peek.tournament_event_id;
    PERFORM 1 FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;
    PERFORM 1 FROM tournament_events e WHERE e.id = v_peek.tournament_event_id FOR UPDATE;
  ELSIF v_peek.club_event_id IS NOT NULL THEN
    PERFORM 1 FROM club_events ce WHERE ce.id = v_peek.club_event_id FOR NO KEY UPDATE;
  END IF;

  SELECT * INTO v_entry FROM registration_import_entries WHERE id = p_entry_id FOR UPDATE;
  IF v_entry.status IN ('undone', 'superseded', 'refused') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_live', 'status', v_entry.status);
  END IF;

  -- A member's confirmed club sign-up is withdrawn the way the member would.
  IF v_entry.club_event_id IS NOT NULL AND v_entry.entrant_id IS NOT NULL AND v_entry.status = 'entered' THEN
    DELETE FROM club_event_signups s
     WHERE s.event_id = v_entry.club_event_id AND s.player_id = v_entry.entrant_id;
  END IF;

  v_why := public.registration_import_retire(p_entry_id);
  IF v_why IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_why);
  END IF;

  UPDATE registration_import_entries
     SET status = 'undone', undone_at = now(), undone_by = p_actor, updated_at = now()
   WHERE id = p_entry_id;

  IF v_entry.tournament_event_id IS NOT NULL
     AND (v_entry.pair_id IS NOT NULL OR v_entry.participant_id IS NOT NULL) THEN
    v_fill := public.fill_event_from_waitlist(v_entry.tournament_event_id, p_actor, NULL);
  END IF;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (p_actor, 'registration_import_undone', 'registration_import_entry', p_entry_id,
          jsonb_build_object('status', v_entry.status),
          jsonb_build_object('event_id', COALESCE(v_entry.tournament_event_id, v_entry.club_event_id),
                             'import_id', v_entry.import_id),
          'An imported form entry was undone');

  RETURN jsonb_build_object('ok', true, 'filled', v_fill);
END;
$function$;

REVOKE ALL ON FUNCTION public.undo_registration_import_entry(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_registration_import_entry(uuid, uuid) TO service_role;

-- ---- 11. MAIL ---------------------------------------------------------------
-- Whether an email has a current guest waiver: the current waiver version,
-- signed within a year (the member rule, getMissingLegalDocuments).
CREATE OR REPLACE FUNCTION public.guest_waiver_status(p_email text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'signed', s.accepted_at IS NOT NULL,
    'signed_at', s.accepted_at)
    FROM (SELECT max(g.accepted_at) AS accepted_at
            FROM guest_waiver_signings g
            JOIN legal_documents d ON d.document = 'waiver' AND d.version = g.waiver_version
           WHERE lower(g.email) = lower(btrim(p_email))
             AND g.accepted_at > now() - interval '365 days'
             AND (d.reacceptance_required_since IS NULL OR g.accepted_at >= d.reacceptance_required_since)) s;
$function$;

REVOKE ALL ON FUNCTION public.guest_waiver_status(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guest_waiver_status(text) TO service_role;

-- Claim up to p_limit invites to send now. The claim (attempted_at) is taken
-- before the send and the receipt (sent_at) after, as the session reminder job
-- does (00195): a crash between the two leaves a claimed row that is retried
-- after 15 minutes, never one that is silently dropped. Throttles: three
-- attempts per invite, two sent per email per day, p_daily_cap sent in all
-- per day. An email that already holds a current guest waiver is cancelled,
-- not sent.
CREATE OR REPLACE FUNCTION public.claim_guest_waiver_invites(p_limit integer, p_daily_cap integer)
RETURNS TABLE(id uuid, email text, target_kind text, target_id uuid, target_name text, target_starts date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_room integer;
BEGIN
  UPDATE guest_waiver_invites gi
     SET cancelled_at = now()
   WHERE gi.sent_at IS NULL AND gi.cancelled_at IS NULL
     AND (public.guest_waiver_status(gi.email) ->> 'signed')::boolean;

  SELECT GREATEST(0, LEAST(COALESCE(p_limit, 0), 50,
           COALESCE(p_daily_cap, 0) - (SELECT count(*) FROM guest_waiver_invites g
                                        WHERE g.sent_at > now() - interval '24 hours')))
    INTO v_room;
  IF v_room = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT gi.id
      FROM guest_waiver_invites gi
     WHERE gi.sent_at IS NULL AND gi.cancelled_at IS NULL
       AND gi.attempts < 3
       AND (gi.attempted_at IS NULL OR gi.attempted_at < now() - interval '15 minutes')
       AND (SELECT count(*) FROM guest_waiver_invites g2
             WHERE g2.email = gi.email AND g2.sent_at > now() - interval '24 hours') < 2
     ORDER BY gi.created_at
     LIMIT v_room
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE guest_waiver_invites gi
       SET attempted_at = now(), attempts = gi.attempts + 1
      FROM picked
     WHERE gi.id = picked.id
    RETURNING gi.id, gi.email, gi.target_kind, gi.target_id
  )
  SELECT c.id, c.email, c.target_kind, c.target_id,
         COALESCE(t.name, ce.title),
         COALESCE(t.start_date, (ce.starts_at AT TIME ZONE 'America/Vancouver')::date)
    FROM claimed c
    LEFT JOIN tournaments t ON c.target_kind = 'tournament' AND t.id = c.target_id
    LEFT JOIN club_events ce ON c.target_kind = 'club_event' AND ce.id = c.target_id;
END;
$function$;

-- The member confirmations: to the address on the ACCOUNT, never the one
-- typed into the form.
CREATE OR REPLACE FUNCTION public.claim_registration_confirm_emails(p_limit integer)
RETURNS TABLE(entry_id uuid, email text, first_name text, target_name text, event_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT en.id
      FROM registration_import_entries en
     WHERE en.status = 'awaiting_member'
       AND en.confirm_email_sent_at IS NULL
       AND en.confirm_email_attempts < 3
       AND (en.confirm_email_attempted_at IS NULL
            OR en.confirm_email_attempted_at < now() - interval '15 minutes')
     ORDER BY en.created_at
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 0), 50))
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE registration_import_entries en
       SET confirm_email_attempted_at = now(), confirm_email_attempts = en.confirm_email_attempts + 1
      FROM picked
     WHERE en.id = picked.id
    RETURNING en.id, en.entrant_id, en.tournament_event_id, en.club_event_id
  )
  SELECT c.id, p.email, p.first_name,
         COALESCE(t.name, ce.title), te.event_type
    FROM claimed c
    JOIN players p ON p.id = c.entrant_id
    LEFT JOIN tournament_events te ON te.id = c.tournament_event_id
    LEFT JOIN tournaments t ON t.id = te.tournament_id
    LEFT JOIN club_events ce ON ce.id = c.club_event_id
   WHERE p.email NOT LIKE '%@deleted.invalid';
END;
$function$;

-- The receipt for either kind. p_error is a short reason, never an address.
CREATE OR REPLACE FUNCTION public.record_registration_mail_receipt(
  p_kind text, p_id uuid, p_sent boolean, p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid;
BEGIN
  IF p_kind = 'guest_waiver_invite' THEN
    UPDATE guest_waiver_invites
       SET sent_at = CASE WHEN p_sent THEN now() ELSE sent_at END,
           last_error = CASE WHEN p_sent THEN NULL ELSE left(p_error, 200) END
     WHERE id = p_id
    RETURNING target_id INTO v_target;
    IF p_sent AND v_target IS NOT NULL THEN
      INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
      VALUES (NULL, 'guest_waiver_invite_sent', 'guest_waiver_invite', p_id,
              jsonb_build_object('target_id', v_target), 'A guest waiver invite was sent');
    END IF;
  ELSIF p_kind = 'registration_confirm' THEN
    UPDATE registration_import_entries
       SET confirm_email_sent_at = CASE WHEN p_sent THEN now() ELSE confirm_email_sent_at END,
           confirm_email_error = CASE WHEN p_sent THEN NULL ELSE left(p_error, 200) END
     WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'unknown mail kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_guest_waiver_invites(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_registration_confirm_emails(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_registration_mail_receipt(text, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_guest_waiver_invites(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_registration_confirm_emails(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_registration_mail_receipt(text, uuid, boolean, text) TO service_role;

-- The schedule: every five minutes, the same call shape as session-reminders
-- (00034), so it follows cron_config wherever admin_url points and sends
-- nothing until reminder_secret is set. GUARDED: a database without pg_cron
-- or pg_net (a local CLI stack) skips the schedule with a notice and keeps the
-- rest of this file. Unscheduled first, so a re-run edits the job.
DO $schedule$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '00283: pg_cron or pg_net is missing, registration-mail is NOT scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule('registration-mail')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'registration-mail');
  PERFORM cron.schedule(
    'registration-mail',
    '*/5 * * * *',
    $job$
    SELECT net.http_post(
      url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/registration-mail',
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

-- ---- 12. MERGES -------------------------------------------------------------
-- 00282's twenty rows, then the five player columns this file adds. All five
-- are SET NULL attribution or identity of a form response, and a merge lets
-- them go: an import record is history, and a pending confirmation of the
-- merged-away account is one the survivor can be re-sent from the console.
CREATE OR REPLACE FUNCTION public.merge_players_disposable()
RETURNS TABLE(tbl text, col text)
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',                'player_id'),
    ('push_subscriptions',           'player_id'),
    ('calendar_feed_tokens',         'player_id'),
    ('ratings',                      'player_id'),
    ('reliability_metrics',          'player_id'),
    ('discord_outbox',               'requested_by'),
    ('data_api_consumers',           'created_by'),
    ('data_api_keys',                'minted_by'),
    ('data_api_keys',                'revoked_by'),
    ('club_event_signups',           'player_id'),
    ('club_events',                  'created_by'),
    ('fee_submissions',              'reviewed_by'),
    ('tournament_event_waitlist',    'player_id'),
    ('tournament_event_waitlist',    'resolved_by'),
    ('tournament_category_requests', 'requested_by'),
    ('tournament_category_requests', 'resolved_by'),
    ('data_api_predictions',         'side1_p1'),
    ('data_api_predictions',         'side1_p2'),
    ('data_api_predictions',         'side2_p1'),
    ('data_api_predictions',         'side2_p2'),
    ('registration_import_forms',    'created_by'),
    ('registration_imports',         'submitter_player_id'),
    ('registration_import_entries',  'entrant_id'),
    ('registration_import_entries',  'requested_partner_id'),
    ('registration_import_entries',  'undone_by')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- ============================================================
-- VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_bad  text[] := ARRAY[]::text[];
  v_fn   text;
  v_tbl  text;
  v_def  text;
BEGIN
  -- Every function here: SECURITY DEFINER (select_fee_tier excepted, it is a
  -- pure function), pinned path, nothing for PUBLIC, anon or authenticated.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_write_key(text, text)',
    'public.data_api_write_predictions(text, jsonb)',
    'public.data_api_delete_predictions(text, jsonb)',
    'public.claim_named_fees_for_player()',
    'public.tournament_fee_tiers_json(uuid)',
    'public.club_event_taken(uuid)',
    'public.club_event_external_sign_up(uuid, text, text, uuid)',
    'public.club_event_external_retire(uuid)',
    'public.registration_import_retire(uuid)',
    'public.data_api_import_registration(text, jsonb)',
    'public.settle_registration_import_entry(uuid, uuid)',
    'public.pair_registration_import_entries(uuid, uuid, text, integer)',
    'public.reject_registration_import_entry(uuid, uuid)',
    'public.undo_registration_import_entry(uuid, uuid)',
    'public.guest_waiver_status(text)',
    'public.claim_guest_waiver_invites(integer, integer)',
    'public.claim_registration_confirm_emails(integer)',
    'public.record_registration_mail_receipt(text, uuid, boolean, text)'
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

  -- The dispatcher is data_api_reader's only new door, and the reader cannot
  -- reach the key helper or the internals.
  IF NOT has_function_privilege('data_api_reader', 'public.data_api_import_registration(text, jsonb)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'data_api_reader cannot call data_api_import_registration');
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_write_key(text, text)',
    'public.registration_import_retire(uuid)',
    'public.undo_registration_import_entry(uuid, uuid)',
    'public.settle_registration_import_entry(uuid, uuid)',
    'public.claim_guest_waiver_invites(integer, integer)'
  ] LOOP
    IF has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'data_api_reader can call ' || v_fn);
    END IF;
  END LOOP;
  IF has_function_privilege('service_role', 'public.data_api_write_key(text, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.data_api_import_registration(text, jsonb)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'service_role can call the key helper or the dispatcher');
  END IF;

  -- No table here is readable by the reader, anon or authenticated (relacl).
  FOREACH v_tbl IN ARRAY ARRAY['registration_import_forms', 'registration_imports',
                               'registration_import_entries', 'guest_waiver_invites'] LOOP
    IF has_table_privilege('data_api_reader', 'public.' || v_tbl, 'SELECT')
       OR has_table_privilege('data_api_reader', 'public.' || v_tbl, 'INSERT') THEN
      v_bad := array_append(v_bad, 'data_api_reader can touch ' || v_tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
                WHERE c.oid = ('public.' || v_tbl)::regclass
                  AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))) THEN
      v_bad := array_append(v_bad, v_tbl || ' grants something to PUBLIC, anon or authenticated');
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_tbl)::regclass) THEN
      v_bad := array_append(v_bad, v_tbl || ' has row level security off');
    END IF;
  END LOOP;

  -- The scope CHECK.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.data_api_keys'::regclass AND conname = 'data_api_keys_scope_vocabulary';
  IF v_def IS NULL OR position('registrations:write' in v_def) = 0 OR position('predictions:write' in v_def) = 0 THEN
    v_bad := array_append(v_bad, 'the scope CHECK does not carry registrations:write and predictions:write');
  END IF;

  -- The predictions functions now ask the helper.
  FOREACH v_fn IN ARRAY ARRAY['public.data_api_write_predictions(text, jsonb)',
                              'public.data_api_delete_predictions(text, jsonb)'] LOOP
    IF position('data_api_write_key(p_key_hash, ''predictions:write'')' in
                (SELECT prosrc FROM pg_proc WHERE oid = v_fn::regprocedure)) = 0 THEN
      v_bad := array_append(v_bad, v_fn || ' does not check its key through data_api_write_key');
    END IF;
  END LOOP;

  -- The dispatcher takes 00201's field key, at top level.
  IF position('pg_advisory_xact_lock(hashtext(''tournament_event_field''), hashtext(v_lock_id::text))' in
              (SELECT prosrc FROM pg_proc WHERE oid = 'public.data_api_import_registration(text, jsonb)'::regprocedure)) = 0 THEN
    v_bad := array_append(v_bad, 'the dispatcher does not take the event field key');
  END IF;

  -- club_fees: a named tournament row is legal, a half-named one is not.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.club_fees'::regclass AND conname = 'club_fees_manual_email_shape';
  IF position('tournament' in v_def) = 0 THEN
    v_bad := array_append(v_bad, 'club_fees_manual_email_shape does not admit tournament rows');
  END IF;
  IF to_regclass('public.club_fees_tournament_manual_email_key') IS NULL THEN
    v_bad := array_append(v_bad, 'club_fees_tournament_manual_email_key is missing');
  END IF;

  -- Merges.
  IF (SELECT count(*) FROM merge_players_disposable()) <> 25 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable does not hold 25 rows');
  END IF;
  IF EXISTS (SELECT 1 FROM merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, 'merge_players_unhandled is not empty: '
      || (SELECT string_agg(tbl || '.' || col, ', ') FROM merge_players_unhandled()));
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00283 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00283 verified: the form dispatcher is data_api_reader only, the tables are closed, and merges still classify every player column.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
