-- ============================================================
-- ROLLBACK OF 00336: a sign-up remembers resubmission and SFU student answers
--
-- Drops record_form_signup_answers and restates club_event_link_admit_external
-- as 00311 left it. The six columns stay: nothing writes them once the
-- function is gone, so they are inert; drop them by hand if wanted. Deploy a
-- build without the reader's call first (or turn form_signup_answers off).
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DROP FUNCTION IF EXISTS public.record_form_signup_answers(uuid, text, boolean, boolean, boolean, boolean);

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

NOTIFY pgrst, 'reload schema';
