-- ============================================================
-- 00311: THE DESK SETTLES WHO PARTNERS WHOM
--
-- A club event's Google Form asks for a preferred partner, and people type a
-- first name, a nickname or a full name (00299). On event day the desk has to
-- turn those notes into teams. The console now checks each note against the
-- people signed up and flags the problems, and an officer sets a person's
-- partner by picking somebody signed up to the same event.
--
-- WHAT IS ADDED, on club_event_signups (members) and on
-- club_event_external_signups (non-members) alike:
--   * preferred_partner_player_id: the desk's pick, when it is somebody with a
--     player record.
--   * preferred_partner_external_id: the desk's pick, when it is a non-member
--     sign-up of the same event.
--   * preferred_partner_set_at: when the desk chose. NULL means the desk has
--     not chosen, and the typed note stands. Set with both references NULL
--     means the desk said "No preferred partner". Set with one reference is
--     the desk's pick.
--
-- preferred_partner STAYS "AS TYPED". The console's reader replays every
-- response and record_form_partner_note (00299) rewrites the note whenever it
-- differs, so a desk choice written there would be undone by the next poll.
-- The note is written only by the reader; the desk's choice lives in columns
-- the reader never writes, so a replay cannot touch it. record_form_partner_note
-- is not restated.
--
-- MATCHING IS ADVICE. The console suggests which sign-up a note names. Nothing
-- here pairs anybody: a team is made in the linked tournament by an officer.
--
-- NO preferred_partner_set_by. An actor column is a player foreign key that
-- blocks merges (00309's precedent); who chose goes in audit_logs.
--
-- A NON-MEMBER WHO ENTERS THE TOURNAMENT. club_event_link_admit_external
-- deletes their non-member row and signs their new guest record up as a
-- member row. It is restated so the note and the desk's choice move with
-- them, and so anybody whose pick was that non-member now points at the guest
-- record instead of being blanked by ON DELETE SET NULL.
--
-- MERGES. The two new player columns are disposable: a merged-away duplicate
-- named as somebody's partner is blanked, and the desk picks again.
--
-- PRECONDITIONS: 00299 (preferred_partner), 00294 (the admit function's latest
-- definition), 00310 (merge_players_disposable's latest definition).
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_event_signups'
                    AND column_name = 'preferred_partner') THEN
    RAISE EXCEPTION '00311 needs 00299: club_event_signups.preferred_partner is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'tournament_court_helpers' AND col = 'player_id') THEN
    RAISE EXCEPTION '00311 needs 00310: merge_players_disposable does not have tournament_court_helpers.player_id';
  END IF;
END
$pre$;

-- ---- the columns ------------------------------------------------------------

ALTER TABLE public.club_event_signups
  ADD COLUMN IF NOT EXISTS preferred_partner_player_id uuid REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE public.club_event_signups
  ADD COLUMN IF NOT EXISTS preferred_partner_external_id uuid REFERENCES public.club_event_external_signups(id) ON DELETE SET NULL;
ALTER TABLE public.club_event_signups
  ADD COLUMN IF NOT EXISTS preferred_partner_set_at timestamptz;

ALTER TABLE public.club_event_external_signups
  ADD COLUMN IF NOT EXISTS preferred_partner_player_id uuid REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE public.club_event_external_signups
  ADD COLUMN IF NOT EXISTS preferred_partner_external_id uuid REFERENCES public.club_event_external_signups(id) ON DELETE SET NULL;
ALTER TABLE public.club_event_external_signups
  ADD COLUMN IF NOT EXISTS preferred_partner_set_at timestamptz;

CREATE INDEX IF NOT EXISTS club_event_signups_preferred_partner_player_idx
  ON public.club_event_signups (preferred_partner_player_id)
  WHERE preferred_partner_player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS club_event_signups_preferred_partner_external_idx
  ON public.club_event_signups (preferred_partner_external_id)
  WHERE preferred_partner_external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS club_event_external_signups_preferred_partner_player_idx
  ON public.club_event_external_signups (preferred_partner_player_id)
  WHERE preferred_partner_player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS club_event_external_signups_preferred_partner_external_idx
  ON public.club_event_external_signups (preferred_partner_external_id)
  WHERE preferred_partner_external_id IS NOT NULL;

-- ---- the rules --------------------------------------------------------------

ALTER TABLE public.club_event_signups
  DROP CONSTRAINT IF EXISTS club_event_signups_preferred_partner_one_ref;
ALTER TABLE public.club_event_signups
  ADD CONSTRAINT club_event_signups_preferred_partner_one_ref
  CHECK (num_nonnulls(preferred_partner_player_id, preferred_partner_external_id) <= 1);
ALTER TABLE public.club_event_signups
  DROP CONSTRAINT IF EXISTS club_event_signups_preferred_partner_set;
ALTER TABLE public.club_event_signups
  ADD CONSTRAINT club_event_signups_preferred_partner_set
  CHECK ((preferred_partner_player_id IS NULL AND preferred_partner_external_id IS NULL)
         OR preferred_partner_set_at IS NOT NULL);
ALTER TABLE public.club_event_signups
  DROP CONSTRAINT IF EXISTS club_event_signups_preferred_partner_not_self;
ALTER TABLE public.club_event_signups
  ADD CONSTRAINT club_event_signups_preferred_partner_not_self
  CHECK (preferred_partner_player_id IS DISTINCT FROM player_id);

ALTER TABLE public.club_event_external_signups
  DROP CONSTRAINT IF EXISTS club_event_external_signups_preferred_partner_one_ref;
ALTER TABLE public.club_event_external_signups
  ADD CONSTRAINT club_event_external_signups_preferred_partner_one_ref
  CHECK (num_nonnulls(preferred_partner_player_id, preferred_partner_external_id) <= 1);
ALTER TABLE public.club_event_external_signups
  DROP CONSTRAINT IF EXISTS club_event_external_signups_preferred_partner_set;
ALTER TABLE public.club_event_external_signups
  ADD CONSTRAINT club_event_external_signups_preferred_partner_set
  CHECK ((preferred_partner_player_id IS NULL AND preferred_partner_external_id IS NULL)
         OR preferred_partner_set_at IS NOT NULL);
ALTER TABLE public.club_event_external_signups
  DROP CONSTRAINT IF EXISTS club_event_external_signups_preferred_partner_not_self;
ALTER TABLE public.club_event_external_signups
  ADD CONSTRAINT club_event_external_signups_preferred_partner_not_self
  CHECK (preferred_partner_external_id IS DISTINCT FROM id);

COMMENT ON COLUMN public.club_event_signups.preferred_partner IS
  'The partner the member named on the event''s Google Form, as typed (00299). Written only by the Form reader. The console suggests which sign-up it names, as advice only; the desk''s choice is preferred_partner_player_id / _external_id (00311).';
COMMENT ON COLUMN public.club_event_external_signups.preferred_partner IS
  'The partner the non-member named on the event''s Google Form, as typed (00299). Written only by the Form reader. The console suggests which sign-up it names, as advice only; the desk''s choice is preferred_partner_player_id / _external_id (00311).';
COMMENT ON COLUMN public.club_event_signups.preferred_partner_player_id IS
  'The desk''s pick of this member''s partner, when the partner has a player record (00311). Never written by the Form reader.';
COMMENT ON COLUMN public.club_event_signups.preferred_partner_external_id IS
  'The desk''s pick of this member''s partner, when the partner is a non-member sign-up of the same event (00311).';
COMMENT ON COLUMN public.club_event_signups.preferred_partner_set_at IS
  'When the desk chose this member''s partner (00311). NULL: no desk choice, the typed note stands. Set with both references NULL: the desk said no preferred partner.';
COMMENT ON COLUMN public.club_event_external_signups.preferred_partner_player_id IS
  'The desk''s pick of this non-member''s partner, when the partner has a player record (00311). Never written by the Form reader.';
COMMENT ON COLUMN public.club_event_external_signups.preferred_partner_external_id IS
  'The desk''s pick of this non-member''s partner, when the partner is another non-member sign-up of the same event (00311).';
COMMENT ON COLUMN public.club_event_external_signups.preferred_partner_set_at IS
  'When the desk chose this non-member''s partner (00311). NULL: no desk choice, the typed note stands. Set with both references NULL: the desk said no preferred partner.';

-- ---- A NON-MEMBER WHO ENTERS THE TOURNAMENT KEEPS THEIR PARTNER -------------
-- 00294's function. Before the non-member row is deleted, anybody whose pick
-- was that row is pointed at the guest record, and the member row it becomes
-- carries the note and the desk's choice.
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
  INSERT INTO club_event_signups (event_id, player_id, preferred_partner,
                                  preferred_partner_player_id, preferred_partner_external_id,
                                  preferred_partner_set_at)
  VALUES (v_x.event_id, v_player, v_x.preferred_partner,
          CASE WHEN v_x.preferred_partner_player_id = v_player THEN NULL ELSE v_x.preferred_partner_player_id END,
          v_x.preferred_partner_external_id,
          v_x.preferred_partner_set_at)
  ON CONFLICT (event_id, player_id) DO UPDATE
     SET preferred_partner = coalesce(club_event_signups.preferred_partner, EXCLUDED.preferred_partner),
         preferred_partner_player_id = CASE WHEN club_event_signups.preferred_partner_set_at IS NULL
                                            THEN EXCLUDED.preferred_partner_player_id
                                            ELSE club_event_signups.preferred_partner_player_id END,
         preferred_partner_external_id = CASE WHEN club_event_signups.preferred_partner_set_at IS NULL
                                              THEN EXCLUDED.preferred_partner_external_id
                                              ELSE club_event_signups.preferred_partner_external_id END,
         preferred_partner_set_at = coalesce(club_event_signups.preferred_partner_set_at,
                                             EXCLUDED.preferred_partner_set_at);

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'club_event_external_admitted', 'club_event', v_x.event_id,
          jsonb_build_object('player_id', v_player, 'record_made', v_made),
          'A non-member from the Google Form was given a guest player record to enter the tournament');
  RETURN v_player;
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_link_admit_external(uuid) FROM PUBLIC, anon, authenticated;

-- ---- MERGES -----------------------------------------------------------------
-- The rows from 00310, and the two player columns this file adds.
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
    ('registration_import_entries',  'undone_by'),
    ('club_event_waitlist',          'player_id'),
    ('club_event_waitlist',          'resolved_by'),
    ('tournament_court_helpers',     'player_id'),
    ('tournament_court_helpers',     'created_by'),
    ('club_event_signups',           'preferred_partner_player_id'),
    ('club_event_external_signups',  'preferred_partner_player_id')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

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
    FOREACH v_column IN ARRAY ARRAY['preferred_partner_player_id', 'preferred_partner_external_id', 'preferred_partner_set_at'] LOOP
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = v_table AND column_name = v_column) THEN
        v_bad := array_append(v_bad, format('%s.%s is missing', v_table, v_column));
      END IF;
    END LOOP;
    FOREACH v_column IN ARRAY ARRAY['preferred_partner_one_ref', 'preferred_partner_set', 'preferred_partner_not_self'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = v_table || '_' || v_column
                        AND conrelid = ('public.' || v_table)::regclass
                        AND contype = 'c') THEN
        v_bad := array_append(v_bad, format('%s_%s is missing', v_table, v_column));
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'club_event_signups' AND col = 'preferred_partner_player_id')
     OR NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                     WHERE tbl = 'club_event_external_signups' AND col = 'preferred_partner_player_id') THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is missing a preferred partner column');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'tournament_court_helpers' AND col = 'player_id') THEN
    v_bad := array_append(v_bad, 'merge_players_disposable lost tournament_court_helpers.player_id');
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 31 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the thirty-one rows');
  END IF;

  IF position('v_x.email IS NULL' IN v_src) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_link_admit_external would make a guest record with no email');
  END IF;
  IF position('preferred_partner_external_id = NULL' IN v_src) = 0 THEN
    v_bad := array_append(v_bad, 'club_event_link_admit_external does not repoint a pick of the non-member');
  END IF;

  IF has_function_privilege('anon', 'public.club_event_link_admit_external(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.club_event_link_admit_external(uuid)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'club_event_link_admit_external is executable by anon or authenticated');
  END IF;
  IF has_function_privilege('anon', 'public.merge_players_disposable()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.merge_players_disposable()', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is executable by anon or authenticated');
  END IF;
  IF has_table_privilege('anon', 'public.club_event_external_signups', 'SELECT')
     OR has_table_privilege('authenticated', 'public.club_event_external_signups', 'SELECT') THEN
    v_bad := array_append(v_bad, 'club_event_external_signups is readable beyond the service role');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00311 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00311 verified: the desk''s partner choice, its rules, the admit restatement and the merge rows are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
