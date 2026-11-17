-- ============================================================
-- 00336: A SIGN-UP REMEMBERS RESUBMISSION AND STUDENT ANSWERS
--
-- A club event's Google Form can ask two yes/no questions the console's
-- reader ignored: "Are you resubmitting the registration form for this
-- event?" and the SFU student question. Somebody who resubmits
-- under a different email shows up twice, and the desk had no way to tell.
--
-- WHAT IS ADDED, on club_event_signups (members) and on
-- club_event_external_signups (non-members) alike:
--   * resubmission: the answer to the resubmission question. NULL when the
--     response left it empty, the answer was neither yes nor no, or the
--     mapping does not name the question.
--   * resubmission_replaced: whether this response replaced an earlier one on
--     the same binding (an earlier import superseded by this one). NULL when
--     resubmission is NULL. A "yes" that replaced nothing is what the desk is
--     asked to check: an earlier sign-up under another email.
--   * sfu_student: the answer to the student question. Shown to the desk
--     only; nothing prices, admits or ranks anybody from it.
--   * record_form_signup_answers: the console's reader calls it after a
--     response is imported (replays included), when the binding's mapping
--     names either question. Each answer has its own set flag, so a question
--     the mapping does not name leaves its column alone. It finds the
--     sign-ups exactly as record_form_partner_note (00299) does.
--
-- NOT IN THE PAYLOAD. Like the partner note, the answers are the console's:
-- the Apps Script and the Data API never carry them, and the hash both roads
-- agree on is untouched.
--
-- WHO SEES IT. club_event_signups_own_read (00244) lets a member read their
-- own rows only, so a member sees their own answers and nobody else's.
-- club_event_external_signups stays service role only (00284).
--
-- A KNOWN FALSE POSITIVE. An edited Google response keeps its response id, so
-- it supersedes nothing new. Somebody who edits their response to answer
-- "yes" with no earlier distinct response is flagged anyway; the desk checks
-- and finds nothing. Accepted.
--
-- A NON-MEMBER WHO ENTERS THE TOURNAMENT. club_event_link_admit_external is
-- restated from 00311 so the three answers move with them onto the member
-- row. Only its final INSERT changes; a row already there keeps its own
-- answers.
--
-- No player foreign key and no CHECK: nothing here blocks a merge, and no
-- answer can fail a write and hold the reader's watermark.
--
-- PRECONDITIONS: 00299 (record_form_partner_note), 00311 (the admit
-- function's latest definition).
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_event_signups'
                    AND column_name = 'preferred_partner_set_at') THEN
    RAISE EXCEPTION '00336 needs 00311: club_event_signups.preferred_partner_set_at is missing';
  END IF;
  IF to_regprocedure('public.record_form_partner_note(uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION '00336 needs 00299: public.record_form_partner_note is missing';
  END IF;
END
$pre$;

-- ---- the columns ------------------------------------------------------------

ALTER TABLE public.club_event_signups ADD COLUMN IF NOT EXISTS resubmission boolean;
ALTER TABLE public.club_event_signups ADD COLUMN IF NOT EXISTS resubmission_replaced boolean;
ALTER TABLE public.club_event_signups ADD COLUMN IF NOT EXISTS sfu_student boolean;
ALTER TABLE public.club_event_external_signups ADD COLUMN IF NOT EXISTS resubmission boolean;
ALTER TABLE public.club_event_external_signups ADD COLUMN IF NOT EXISTS resubmission_replaced boolean;
ALTER TABLE public.club_event_external_signups ADD COLUMN IF NOT EXISTS sfu_student boolean;

COMMENT ON COLUMN public.club_event_signups.resubmission IS
  'The member''s answer to the event Form''s resubmission question (00336). Written only by the Form reader. NULL: unanswered, not yes or no, or not read.';
COMMENT ON COLUMN public.club_event_signups.resubmission_replaced IS
  'Whether the response replaced an earlier one on the same Form binding (00336). Written only by the Form reader. NULL when resubmission is NULL.';
COMMENT ON COLUMN public.club_event_signups.sfu_student IS
  'The member''s answer to the event Form''s student question (00336). Written only by the Form reader. Display only. NULL: unanswered, not yes or no, or not read.';
COMMENT ON COLUMN public.club_event_external_signups.resubmission IS
  'The non-member''s answer to the event Form''s resubmission question (00336). Written only by the Form reader. NULL: unanswered, not yes or no, or not read.';
COMMENT ON COLUMN public.club_event_external_signups.resubmission_replaced IS
  'Whether the response replaced an earlier one on the same Form binding (00336). Written only by the Form reader. NULL when resubmission is NULL.';
COMMENT ON COLUMN public.club_event_external_signups.sfu_student IS
  'The non-member''s answer to the event Form''s student question (00336). Written only by the Form reader. Display only. NULL: unanswered, not yes or no, or not read.';

-- ---- the reader's write -----------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_form_signup_answers(
  p_binding_id uuid,
  p_response_id text,
  p_set_resubmission boolean,
  p_resubmission boolean,
  p_set_sfu_student boolean,
  p_sfu_student boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_import   uuid;
  v_set_r    boolean := coalesce(p_set_resubmission, false);
  v_set_s    boolean := coalesce(p_set_sfu_student, false);
  v_replaced boolean;
  v_members  integer;
  v_guests   integer;
BEGIN
  IF NOT v_set_r AND NOT v_set_s THEN
    RETURN 'unchanged';
  END IF;

  SELECT i.id INTO v_import
    FROM registration_imports i
   WHERE i.binding_id = p_binding_id AND i.response_id = p_response_id
     AND i.superseded_by IS NULL
   ORDER BY i.created_at DESC
   LIMIT 1;
  IF v_import IS NULL THEN
    RETURN 'not_found';
  END IF;

  -- Replaced: an earlier import on this binding was superseded by this one.
  v_replaced := CASE WHEN p_resubmission IS NULL THEN NULL
                     ELSE EXISTS (SELECT 1 FROM registration_imports p
                                   WHERE p.binding_id = p_binding_id AND p.superseded_by = v_import)
                END;

  -- The rows are found as record_form_partner_note (00299) finds them.
  UPDATE club_event_signups s
     SET resubmission = CASE WHEN v_set_r THEN p_resubmission ELSE s.resubmission END,
         resubmission_replaced = CASE WHEN v_set_r THEN v_replaced ELSE s.resubmission_replaced END,
         sfu_student = CASE WHEN v_set_s THEN p_sfu_student ELSE s.sfu_student END
    FROM registration_import_entries e
   WHERE e.import_id = v_import
     AND e.club_event_id IS NOT NULL
     AND e.entrant_id IS NOT NULL
     AND e.undone_at IS NULL
     AND e.status <> 'superseded'
     AND e.reason IS DISTINCT FROM 'not_me'
     AND s.event_id = e.club_event_id
     AND s.player_id = e.entrant_id
     AND ((v_set_r AND (s.resubmission IS DISTINCT FROM p_resubmission
                        OR s.resubmission_replaced IS DISTINCT FROM v_replaced))
          OR (v_set_s AND s.sfu_student IS DISTINCT FROM p_sfu_student));
  GET DIAGNOSTICS v_members = ROW_COUNT;

  UPDATE club_event_external_signups x
     SET resubmission = CASE WHEN v_set_r THEN p_resubmission ELSE x.resubmission END,
         resubmission_replaced = CASE WHEN v_set_r THEN v_replaced ELSE x.resubmission_replaced END,
         sfu_student = CASE WHEN v_set_s THEN p_sfu_student ELSE x.sfu_student END
    FROM registration_import_entries e
   WHERE e.import_id = v_import
     AND e.club_event_id IS NOT NULL
     AND e.entrant_id IS NULL
     AND e.undone_at IS NULL
     AND e.status <> 'superseded'
     AND (x.id = e.external_signup_id
          OR (x.event_id = e.club_event_id AND x.email = lower(btrim(e.external_email))))
     AND ((v_set_r AND (x.resubmission IS DISTINCT FROM p_resubmission
                        OR x.resubmission_replaced IS DISTINCT FROM v_replaced))
          OR (v_set_s AND x.sfu_student IS DISTINCT FROM p_sfu_student));
  GET DIAGNOSTICS v_guests = ROW_COUNT;

  RETURN CASE WHEN v_members + v_guests > 0 THEN 'recorded' ELSE 'unchanged' END;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_form_signup_answers(uuid, text, boolean, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_form_signup_answers(uuid, text, boolean, boolean, boolean, boolean) TO service_role;

-- ---- A NON-MEMBER WHO ENTERS THE TOURNAMENT KEEPS THEIR ANSWERS -------------
-- 00311's function, unchanged but for the final INSERT into club_event_signups.
CREATE OR REPLACE FUNCTION public.club_event_link_admit_external(p_external_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_x club_event_external_signups%ROWTYPE;
  v_email text;
  v_name text;
  v_first text;
  v_player uuid;
  v_made boolean := false;
BEGIN
  SELECT * INTO v_x FROM club_event_external_signups x WHERE x.id = p_external_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- After the draw nobody new enters (club_event_link_assert_field_open): they
  -- stay a non-member sign-up of the club event, which an officer can enter from
  -- the tournament by hand.
  IF NOT EXISTS (SELECT 1 FROM club_events ce JOIN tournament_events te ON te.id = ce.tournament_event_id
                  WHERE ce.id = v_x.event_id AND te.status IN ('registration', 'checkin')
                    AND NOT coalesce(te.draw_locked, false)) THEN
    RETURN NULL;
  END IF;
  -- 00294: a walk-in who gave no email cannot have a guest player record
  -- (players.email is NOT NULL), so they stay a sign-up of the club event,
  -- as somebody does who signed up after the draw.
  IF v_x.email IS NULL THEN
    RETURN NULL;
  END IF;
  v_email := lower(btrim(v_x.email));
  v_name := btrim(v_x.full_name);

  -- A record this email already has (made for an earlier event, say) is reused.
  SELECT p.id INTO v_player FROM players p
   WHERE lower(p.email) = v_email
   ORDER BY (p.user_id IS NOT NULL) DESC, p.created_at
   LIMIT 1;
  IF v_player IS NULL THEN
    v_first := split_part(v_name, ' ', 1);
    -- Not create_player_with_rating: its auth.role() check refuses the Data
    -- API's reader role, whose import fires this at commit.
    v_player := create_guest_player(v_email, v_first,
      nullif(btrim(substr(v_name, char_length(v_first) + 1)), ''), v_name);
    v_made := true;
  END IF;

  -- Their named fee becomes theirs, so the sign-up's own fee trigger finds a
  -- fee already there and makes no second one. A receipt already filed against
  -- it stays with it. (A NEW record has usually taken it already: 00284's
  -- claim on players moves named event fees to the account with that email.)
  UPDATE club_fees f SET player_id = v_player, manual_name = NULL, manual_email = NULL
   WHERE f.fee_type = 'event' AND f.club_event_id = v_x.event_id
     AND f.player_id IS NULL AND lower(f.manual_email) = v_email
     AND NOT EXISTS (SELECT 1 FROM club_fees g
                      WHERE g.fee_type = 'event' AND g.club_event_id = v_x.event_id
                        AND g.player_id = v_player);

  -- The Form entry now names the player, so Undo and receipts follow them.
  UPDATE registration_import_entries en
     SET entrant_id = v_player, external_name = NULL, external_email = NULL,
         external_signup_id = NULL
   WHERE en.external_signup_id = v_x.id;

  -- A guest is sent nothing, and the Form already carried the waiver.
  UPDATE guest_waiver_invites gi SET cancelled_at = now()
   WHERE gi.target_kind = 'club_event' AND gi.target_id = v_x.event_id
     AND lower(gi.email) = v_email AND gi.sent_at IS NULL AND gi.cancelled_at IS NULL;

  -- 00311: a desk pick of this non-member follows them to the guest record,
  -- before the DELETE below would blank it. A member who picked their own
  -- other self is left with "no preferred partner".
  UPDATE club_event_signups
     SET preferred_partner_player_id = CASE WHEN player_id = v_player THEN NULL ELSE v_player END,
         preferred_partner_external_id = NULL
   WHERE preferred_partner_external_id = v_x.id;
  UPDATE club_event_external_signups
     SET preferred_partner_player_id = v_player,
         preferred_partner_external_id = NULL
   WHERE preferred_partner_external_id = v_x.id AND id <> v_x.id;

  DELETE FROM club_event_external_signups WHERE id = v_x.id;
  -- 00311: the note and the desk's choice go with them. A row already there
  -- keeps its own note and its own desk choice.
  -- 00336: so do the Form's resubmission and student answers, the same way.
  INSERT INTO club_event_signups (event_id, player_id, preferred_partner,
                                  preferred_partner_player_id, preferred_partner_external_id,
                                  preferred_partner_set_at,
                                  resubmission, resubmission_replaced, sfu_student)
  VALUES (v_x.event_id, v_player, v_x.preferred_partner,
          CASE WHEN v_x.preferred_partner_player_id = v_player THEN NULL ELSE v_x.preferred_partner_player_id END,
          v_x.preferred_partner_external_id,
          v_x.preferred_partner_set_at,
          v_x.resubmission, v_x.resubmission_replaced, v_x.sfu_student)
  ON CONFLICT (event_id, player_id) DO UPDATE
     SET preferred_partner = coalesce(club_event_signups.preferred_partner, EXCLUDED.preferred_partner),
         preferred_partner_player_id = CASE WHEN club_event_signups.preferred_partner_set_at IS NULL
                                            THEN EXCLUDED.preferred_partner_player_id
                                            ELSE club_event_signups.preferred_partner_player_id END,
         preferred_partner_external_id = CASE WHEN club_event_signups.preferred_partner_set_at IS NULL
                                              THEN EXCLUDED.preferred_partner_external_id
                                              ELSE club_event_signups.preferred_partner_external_id END,
         preferred_partner_set_at = coalesce(club_event_signups.preferred_partner_set_at,
                                             EXCLUDED.preferred_partner_set_at),
         resubmission_replaced = CASE WHEN club_event_signups.resubmission IS NULL
                                      THEN EXCLUDED.resubmission_replaced
                                      ELSE club_event_signups.resubmission_replaced END,
         resubmission = coalesce(club_event_signups.resubmission, EXCLUDED.resubmission),
         sfu_student = coalesce(club_event_signups.sfu_student, EXCLUDED.sfu_student);

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'club_event_external_admitted', 'club_event', v_x.event_id,
          jsonb_build_object('player_id', v_player, 'record_made', v_made),
          'A non-member from the Google Form was given a guest player record to enter the tournament');
  RETURN v_player;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_admit_external(uuid) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_table text;
  v_column text;
  v_src text := pg_get_functiondef('public.club_event_link_admit_external(uuid)'::regprocedure);
BEGIN
  FOREACH v_table IN ARRAY ARRAY['club_event_signups', 'club_event_external_signups'] LOOP
    FOREACH v_column IN ARRAY ARRAY['resubmission', 'resubmission_replaced', 'sfu_student'] LOOP
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = v_table AND column_name = v_column) THEN
        v_bad := array_append(v_bad, format('%s.%s is missing', v_table, v_column));
      END IF;
    END LOOP;
  END LOOP;

  IF has_function_privilege('anon', 'public.record_form_signup_answers(uuid, text, boolean, boolean, boolean, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_form_signup_answers(uuid, text, boolean, boolean, boolean, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_form_signup_answers(uuid, text, boolean, boolean, boolean, boolean)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'record_form_signup_answers has the wrong grants');
  END IF;

  IF position('v_x.email IS NULL' IN v_src) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_link_admit_external would make a guest record with no email');
  END IF;
  IF position('preferred_partner_external_id = NULL' IN v_src) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_link_admit_external does not repoint a pick of the non-member');
  END IF;
  IF position('v_x.sfu_student' IN v_src) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_link_admit_external does not carry the Form answers');
  END IF;

  IF has_function_privilege('anon', 'public.club_event_link_admit_external(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.club_event_link_admit_external(uuid)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'club_event_link_admit_external is executable by anon or authenticated');
  END IF;
  IF has_table_privilege('anon', 'public.club_event_external_signups', 'SELECT')
     OR has_table_privilege('authenticated', 'public.club_event_external_signups', 'SELECT') THEN
    v_bad := array_append(v_bad, 'club_event_external_signups is readable beyond the service role');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00336 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00336 verified: the resubmission and student answers, their reader write and the admit restatement are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
