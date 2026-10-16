-- ============================================================
-- 00285: DELETION REACHES THE FORM IMPORT
--
-- 00283 and 00284 brought Google Form registrations in, and with them five
-- places a person's TYPED name and email can sit. Nothing in the account
-- deletion path knew about any of them. This file is the half of the purge
-- they were missing.
--
-- WHAT SURVIVED A DELETION BEFORE THIS FILE.
--   The purge (supabase/functions/_shared/anonymize.ts, run by both
--   purge-deleted-accounts and purge-inactive-accounts) rewrites the players
--   row and deletes a fixed list of player_id tables. A member's own form rows
--   are FK-only by CHECK (registration_imports_member_has_no_email,
--   registration_import_entries_member_or_external), so those were fine. What
--   was not fine is everything the form stored about the person BEFORE they
--   were a member, or stored under their address by somebody else, because
--   those rows carry no player id at all and are linked to them only by the
--   email:
--
--     registration_imports.submitter_name / submitter_email
--         their own response, sent while the address matched no member
--     registration_import_entries.external_name / external_email
--         the same, per event
--     registration_import_entries.partner_name / partner_email
--         another person's response naming them as partner, by an address
--         that matched no member at the time
--     club_event_external_signups.full_name / email
--         their place in a club event as a guest (00284)
--     guest_waiver_invites.email
--         the waiver mail owed to them as a guest
--     club_fees.manual_name / manual_email
--         a named fee that claim_named_fees_for_player could NOT move onto
--         their account (they already owed one for that season, tournament
--         or event), so it stayed named
--     tournament_pairs.external1_name / external2_name / pair_name
--         the external team the import entered, in their typed name
--
--   And in audit_logs, keyed by the player id rather than by any address:
--
--     manual_fee_claimed   old_value.manual_name, the typed name of every
--                          named fee the claim trigger moved onto them
--                          (00252 for dues, 00283 and 00284 for the rest)
--     manual_fee_attached  old_value.named_fee, a whole named fee row with
--                          manual_name and manual_email, written by the
--                          console when an exec attached one to them
--     manual_fee_added     new_value.manual_name / manual_email, when the
--                          console created a named fee under their address
--
--   scrub_deleted_identity (00155) reaches audit_logs only for
--   target_type = 'player', and these are all target_type = 'club_fee'.
--
-- THE "DELINKED" COLUMNS WERE NEVER DELINKED. submitter_player_id,
-- entrant_id, requested_partner_id, undone_by and created_by are declared
-- ON DELETE SET NULL. The purge anonymises by UPDATE and never deletes a
-- players row, so not one of those actions has ever fired for a deletion
-- (the same trap _shared/anonymize.ts records for feedback_reports). They are
-- left as they are, on purpose: they now point at a row called Deleted
-- Player, which is how matches, attendance and fees already read, and an
-- entry with no entrant at all would read in the console as a guest.
--
-- HOW. One trigger on players, the shape 00282 already uses for predictions:
-- AFTER UPDATE OF email, when the new address is the purge's marker
-- `deleted+<id>@deleted.invalid`. It is the only moment the real address is
-- still known (OLD.email); a minute later, scrub_deleted_identity's predicate
-- would find the member but could no longer say which typed rows were theirs.
-- Being a trigger on the anonymising UPDATE, it runs for both purge jobs and
-- for any hand-run anonymisation, and nothing in the edge functions changes:
-- the deployed copies of anonymize.ts and the purge jobs need no edit.
--
-- WHICH ADDRESSES. OLD.email, plus every address an external entry was made
-- under whose fee the claim later moved onto the member. That second set is
-- what still finds the guest rows of a member who joined with the address
-- they had entered under and later changed their account email, and of a
-- member purged before this file existed, whose OLD.email is gone.
--
-- WHAT EACH ROW BECOMES. Rows are kept; only the identity goes.
--   * Nullable columns are nulled: registration_imports.submitter_*,
--     registration_import_entries.external_* and partner_*, and a dues fee's
--     manual_email.
--   * Columns a CHECK requires are given placeholders: 'Deleted Player' for a
--     name, `deleted+<row id>@deleted.invalid` for an address. The ROW id,
--     not the player id, so every per-email unique key stays unique and no
--     placeholder ever equals a players.email.
--   * An unsent guest waiver invite is also CANCELLED. claim_guest_waiver_
--     invites does not skip @deleted.invalid, and an invite left live would be
--     mailed to a dead address, which costs the sending domain reputation.
--   * A dues fee whose 'Deleted Player' name is already taken in that season
--     (club_fees_manual_name_season_key) gets the row id's first eight
--     characters after it.
--   * An external pair keeps its result; the slot that was the deleted
--     person becomes 'Deleted Player' ('Deleted Player 2' when the other slot
--     already reads that, for tournament_pairs_member_or_external), and the
--     pair name is rebuilt only when it is the default "A / B".
--   * audit_logs keep every row, action, actor, time and target; the name
--     and email keys come out, as 00155 does for player rows.
--
-- WHAT IS DELIBERATELY LEFT.
--   * guest_waiver_signings. The privacy policy (section 6) keeps a guest's
--     signed waiver permanently as evidence and never joins it to an account.
--   * A partner_name typed with NO address, or with an address that is not
--     the member's. A name alone does not identify anyone, and erasing every
--     "Alex" on a guess would erase other people's records.
--   * A partner's details on the member's OWN entries. Those are the
--     partner's data, kept as the policy keeps external entrants'.
--   * Entry statuses. An entry still awaiting the deleted member is left for
--     an exec to undo; the confirmation mail already skips deleted addresses.
--
-- THE TRIGGER MUST NOT FAIL. It runs inside the anonymising UPDATE, after the
-- auth user is gone. Every value it writes is chosen against the CHECKs and
-- unique indexes on its column (listed beside each statement), so a raise
-- here would be a bug, not a data condition. It is not wrapped in a WARNING:
-- if it ever did raise, the whole UPDATE rolls back and the member stays
-- eligible, so the next night retries rather than half-erasing them.
-- ============================================================

BEGIN;

-- ---- 0. PRECONDITIONS -------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.club_event_external_signups') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = 'public.registration_import_entries'::regclass
                       AND attname = 'external_signup_id' AND NOT attisdropped)
     OR to_regclass('public.club_fees_event_manual_email_key') IS NULL THEN
    RAISE EXCEPTION '00285 needs 00284 (externals sign up for club events) applied first';
  END IF;
  IF to_regprocedure('public.scrub_deleted_identity()') IS NULL THEN
    RAISE EXCEPTION '00285 needs 00155 (scrub_deleted_identity) applied first';
  END IF;
END
$pre$;

-- ---- 1. THE SCRUB -----------------------------------------------------------
-- p_player_id is the member being anonymised; p_email is the address they had
-- until this moment (OLD.email), or NULL when it is not known, in which case
-- only the addresses found through their claimed fees and the rows keyed by
-- the player id are scrubbed. Returns a count per place, for the backfill
-- below and for anyone running it by hand.
CREATE OR REPLACE FUNCTION public.scrub_registration_identity(p_player_id uuid, p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email    text := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  v_emails   text[];
  v_pair     record;
  v_new1     text;
  v_new2     text;
  v_pairs    integer := 0;
  v_entries  integer := 0;
  v_partners integer := 0;
  v_imports  integer := 0;
  v_signups  integer := 0;
  v_invites  integer := 0;
  v_fees     integer := 0;
  v_audit    integer := 0;
  v_n        integer;
BEGIN
  -- The purge marker itself is never a real address.
  IF v_email LIKE '%@deleted.invalid' THEN
    v_email := NULL;
  END IF;

  -- Every address the typed rows can be under. The account's own address is
  -- not enough: a member who submitted as a guest, joined with that address
  -- (the claim moved the fee onto them) and later changed their account email
  -- would leave everything under the first address behind. The fee the claim
  -- moved still links the entry to them by player id, and the import only ever
  -- links an external entry to a fee named with the entry's own address. This
  -- is also what lets the backfill reach members purged before 00285, whose
  -- old address is otherwise gone.
  SELECT COALESCE(array_agg(DISTINCT a.addr), ARRAY[]::text[])
    INTO v_emails
    FROM (
      SELECT v_email AS addr
      UNION ALL
      SELECT lower(btrim(en.external_email))
        FROM registration_import_entries en
        JOIN club_fees f ON f.id = en.fee_id
       WHERE f.player_id = p_player_id
         AND en.entrant_id IS NULL
         AND en.external_email IS NOT NULL
    ) a
   WHERE a.addr IS NOT NULL
     AND a.addr NOT LIKE '%@deleted.invalid';

  IF cardinality(v_emails) > 0 THEN
    -- ---- tournament_pairs, FIRST: the entry's typed names say which slot ----
    -- The dispatcher builds an external team as (submitter, partner), so the
    -- entry whose external_email is theirs names slot 1, and the entry whose
    -- partner_email is theirs names slot 2. A slot is rewritten only while it
    -- still holds the name the entry typed. CHECK tournament_pairs_member_or_
    -- external: names 1 to 60 characters, trimmed, and different from each
    -- other; pair_name not null.
    FOR v_pair IN
      SELECT pr.id, pr.external1_name, pr.external2_name, pr.pair_name,
             bool_or(en.external_email = ANY (v_emails)
                     AND lower(pr.external1_name) = lower(en.external_name)) AS is_first,
             bool_or(en.partner_email = ANY (v_emails)
                     AND lower(pr.external2_name) = lower(en.partner_name)) AS is_second
        FROM registration_import_entries en
        JOIN tournament_pairs pr ON pr.id = en.pair_id
       WHERE (en.external_email = ANY (v_emails) OR en.partner_email = ANY (v_emails))
         AND pr.player1_id IS NULL AND pr.player2_id IS NULL
       GROUP BY pr.id, pr.external1_name, pr.external2_name, pr.pair_name
       ORDER BY pr.id
    LOOP
      CONTINUE WHEN NOT (v_pair.is_first OR v_pair.is_second);
      v_new1 := CASE WHEN v_pair.is_first THEN 'Deleted Player' ELSE v_pair.external1_name END;
      v_new2 := CASE WHEN v_pair.is_second THEN 'Deleted Player' ELSE v_pair.external2_name END;
      IF lower(v_new1) = lower(v_new2) THEN
        IF v_pair.is_second THEN
          v_new2 := 'Deleted Player 2';
        ELSE
          v_new1 := 'Deleted Player 2';
        END IF;
      END IF;
      UPDATE tournament_pairs
         SET external1_name = v_new1,
             external2_name = v_new2,
             pair_name = CASE
               WHEN pair_name = v_pair.external1_name || ' / ' || v_pair.external2_name
               THEN v_new1 || ' / ' || v_new2
               ELSE pair_name
             END
       WHERE id = v_pair.id;
      v_pairs := v_pairs + 1;
    END LOOP;

    -- ---- registration_import_entries ----------------------------------------
    -- Nullable. CHECK registration_import_entries_member_or_external and
    -- _partner_or_named only constrain rows that carry a player id, and both
    -- allow NULL names; the email shape CHECK allows NULL.
    UPDATE registration_import_entries
       SET external_name = NULL, external_email = NULL
     WHERE external_email = ANY (v_emails);
    GET DIAGNOSTICS v_entries = ROW_COUNT;

    UPDATE registration_import_entries
       SET partner_name = NULL, partner_email = NULL
     WHERE partner_email = ANY (v_emails);
    GET DIAGNOSTICS v_partners = ROW_COUNT;

    -- ---- registration_imports -----------------------------------------------
    -- Nullable; registration_imports_member_has_no_email asks for exactly this.
    UPDATE registration_imports
       SET submitter_name = NULL, submitter_email = NULL
     WHERE submitter_email = ANY (v_emails);
    GET DIAGNOSTICS v_imports = ROW_COUNT;

    -- ---- club_event_external_signups ----------------------------------------
    -- NOT NULL. Name 1 to 120 characters; email in the shape CHECK; UNIQUE
    -- (event_id, email), which a per-row address cannot collide with. The row
    -- is the guest's place and stays in club_event_taken's count.
    UPDATE club_event_external_signups
       SET full_name = 'Deleted Player',
           email = 'deleted+' || id::text || '@deleted.invalid'
     WHERE email = ANY (v_emails);
    GET DIAGNOSTICS v_signups = ROW_COUNT;

    -- ---- guest_waiver_invites -----------------------------------------------
    -- NOT NULL, shape CHECK, UNIQUE (email, target_kind, target_id): a per-row
    -- address again. Unsent rows are cancelled so the outbox never mails it.
    UPDATE guest_waiver_invites
       SET email = 'deleted+' || id::text || '@deleted.invalid',
           last_error = NULL,
           cancelled_at = CASE WHEN sent_at IS NULL THEN COALESCE(cancelled_at, now())
                               ELSE cancelled_at END
     WHERE email = ANY (v_emails);
    GET DIAGNOSTICS v_invites = ROW_COUNT;

    -- ---- club_fees, named rows the claim could not move -----------------------
    -- Tournament and event rows must keep a name and an email (club_fees_shape_
    -- check); the email keys are per tournament and per event, and a per-row
    -- address cannot collide. A dues row may drop its email, and its name key
    -- (club_fees_manual_name_season_key, per season) is why the fallback name
    -- exists. There is one named dues row per email per season (club_fees_
    -- manual_email_season_key), but with several addresses one statement can
    -- rename two rows of one season, and both see the same snapshot: only the
    -- lowest row id of those may take the plain name.
    UPDATE club_fees f
       SET manual_name = CASE
             WHEN f.fee_type <> 'dues' THEN 'Deleted Player'
             WHEN NOT EXISTS (
               SELECT 1 FROM club_fees d
                WHERE d.player_id IS NULL AND d.fee_type = 'dues'
                  AND d.season_id = f.season_id AND d.id <> f.id
                  AND lower(btrim(d.manual_name)) = 'deleted player')
              AND NOT EXISTS (
               SELECT 1 FROM club_fees o
                WHERE o.player_id IS NULL AND o.fee_type = 'dues'
                  AND o.season_id = f.season_id AND o.id < f.id
                  AND lower(o.manual_email) = ANY (v_emails))
             THEN 'Deleted Player'
             ELSE 'Deleted Player ' || left(f.id::text, 8)
           END,
           manual_email = CASE
             WHEN f.fee_type = 'dues' THEN NULL
             ELSE 'deleted+' || f.id::text || '@deleted.invalid'
           END
     WHERE f.player_id IS NULL
       AND f.manual_email IS NOT NULL
       AND lower(f.manual_email) = ANY (v_emails);
    GET DIAGNOSTICS v_fees = ROW_COUNT;

    -- ---- audit_logs keyed by the address ------------------------------------
    UPDATE audit_logs l
       SET new_value = l.new_value - 'manual_name' - 'manual_email'
     WHERE l.action_type = 'manual_fee_added'
       AND l.target_type = 'club_fee'
       AND jsonb_typeof(l.new_value) = 'object'
       AND lower(l.new_value ->> 'manual_email') = ANY (v_emails);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_audit := v_audit + v_n;
  END IF;

  -- ---- audit_logs keyed by the player id ----------------------------------
  -- These need no address, so they also run for the backfill below.
  UPDATE audit_logs l
     SET old_value = l.old_value - 'manual_name'
   WHERE l.action_type = 'manual_fee_claimed'
     AND l.target_type = 'club_fee'
     AND l.new_value ->> 'player_id' = p_player_id::text
     AND jsonb_typeof(l.old_value) = 'object'
     AND l.old_value ? 'manual_name';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_audit := v_audit + v_n;

  UPDATE audit_logs l
     SET old_value = jsonb_set(l.old_value, '{named_fee}',
                               (l.old_value -> 'named_fee') - 'manual_name' - 'manual_email', false)
   WHERE l.action_type = 'manual_fee_attached'
     AND l.target_type = 'club_fee'
     AND l.new_value ->> 'player_id' = p_player_id::text
     AND jsonb_typeof(l.old_value -> 'named_fee') = 'object'
     AND ((l.old_value -> 'named_fee') ? 'manual_name' OR (l.old_value -> 'named_fee') ? 'manual_email');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_audit := v_audit + v_n;

  RETURN jsonb_build_object(
    'pairs', v_pairs, 'entries', v_entries, 'partner_entries', v_partners,
    'imports', v_imports, 'external_signups', v_signups, 'invites', v_invites,
    'named_fees', v_fees, 'audit_rows', v_audit);
END;
$function$;

REVOKE ALL ON FUNCTION public.scrub_registration_identity(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.scrub_registration_identity(uuid, text) IS
  '00285. Removes a member''s typed name and email from the form import tables, guest places and invites, unclaimed named fees, external pairs and the named-fee audit rows, keeping every row. Called by the purge trigger on players with the address the member had (OLD.email), and also matches the addresses of external entries whose fee was claimed onto the member; with a NULL address only those and the rows keyed by the player id are scrubbed. Granted to nobody.';

-- ---- 2. THE TRIGGER ---------------------------------------------------------
-- 00282's predicate, word for word: the purge marker arriving on the row.
CREATE OR REPLACE FUNCTION public.registration_import_forget_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.scrub_registration_identity(NEW.id, OLD.email);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.registration_import_forget_player() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_registration_import_forget_player ON public.players;
CREATE TRIGGER trg_registration_import_forget_player
  AFTER UPDATE OF email ON public.players
  FOR EACH ROW
  WHEN (NEW.email LIKE 'deleted+%@deleted.invalid' AND OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.registration_import_forget_player();

-- ---- 3. THE BACKFILL --------------------------------------------------------
-- Members purged before this file: their account address is gone, so what
-- can be reached is the player-keyed audit rows (back to 00252, when the
-- claim first wrote a typed name into manual_fee_claimed) and the typed rows
-- under any address whose import fee was claimed onto them. A member purged
-- between 00283 and this file who entered as a guest under an address the
-- claim never matched cannot be traced; apply this before the first purge
-- that follows 00283.
DO $backfill$
DECLARE
  v_rows  integer := 0;
  v_audit integer := 0;
  v_one   jsonb;
  v_id    uuid;
  v_key   text;
BEGIN
  FOR v_id IN
    SELECT p.id FROM public.players p
     WHERE p.user_id IS NULL AND p.email LIKE 'deleted+%@deleted.invalid'
  LOOP
    v_one := public.scrub_registration_identity(v_id, NULL);
    v_audit := v_audit + (v_one ->> 'audit_rows')::integer;
    FOR v_key IN SELECT jsonb_object_keys(v_one) LOOP
      IF v_key <> 'audit_rows' THEN
        v_rows := v_rows + (v_one ->> v_key)::integer;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE '00285 backfill: % audit row(s) and % form import row(s) of already-purged members scrubbed',
    v_audit, v_rows;
END
$backfill$;

-- ============================================================
-- VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_bad      text[] := ARRAY[]::text[];
  v_fn       text;
  v_def      text;
  v_consumer uuid := '00000000-0000-0000-0000-000000000285';
  v_key      uuid;
  v_binding  uuid;
  v_import   uuid;
  v_other    uuid;
  v_invite   uuid;
  v_count    jsonb;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.scrub_registration_identity(uuid, text)',
    'public.registration_import_forget_player()'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn::regprocedure AND p.prosecdef
                     AND 'search_path=public, pg_temp' = ANY (p.proconfig)) THEN
      v_bad := array_append(v_bad, v_fn || ' is not SECURITY DEFINER with the pinned search_path');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = v_fn::regprocedure AND a.privilege_type = 'EXECUTE'
                  AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles
                        WHERE rolname IN ('anon', 'authenticated', 'service_role', 'data_api_reader')))) THEN
      v_bad := array_append(v_bad, v_fn || ' is executable by an application role');
    END IF;
  END LOOP;

  -- The trigger, on the marker the purge writes (anonymize.ts:
  -- deleted+${playerId}@deleted.invalid; a test reads both files).
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.players'::regclass AND t.tgname = 'trg_registration_import_forget_player';
  IF v_def IS NULL
     OR position('AFTER UPDATE OF email' in v_def) = 0
     OR position('deleted+%@deleted.invalid' in v_def) = 0
     OR position('registration_import_forget_player()' in v_def) = 0 THEN
    v_bad := array_append(v_bad, 'trg_registration_import_forget_player is missing or not on the purge marker');
  END IF;

  -- A self-check against real rows, rolled back by the sentinel: a response
  -- under one address, and a second response naming that address as partner,
  -- plus an unsent invite and an address-keyed audit row. The scrub must empty
  -- every one of them and leave another person's rows alone.
  BEGIN
    INSERT INTO public.data_api_consumers (id, name) VALUES (v_consumer, '00285 self-check');
    INSERT INTO public.data_api_keys (consumer_id, key_hash, key_prefix, scopes)
    VALUES (v_consumer, repeat('5', 64), 'clubld_x', ARRAY['registrations:write'])
    RETURNING id INTO v_key;
    INSERT INTO public.registration_import_forms (consumer_id, form_id, target_kind)
    VALUES (v_consumer, '00285-self-check', 'club_event')
    RETURNING id INTO v_binding;
    INSERT INTO public.registration_imports (binding_id, key_id, response_id, payload_hash,
                                             submitter_name, submitter_email)
    VALUES (v_binding, v_key, 'r1', 'h1', 'Gone Person', 'gone@example.test')
    RETURNING id INTO v_import;
    INSERT INTO public.registration_import_entries (import_id, item, external_name, external_email, status)
    VALUES (v_import, 1, 'Gone Person', 'gone@example.test', 'needs_review');
    INSERT INTO public.registration_imports (binding_id, key_id, response_id, payload_hash,
                                             submitter_name, submitter_email)
    VALUES (v_binding, v_key, 'r2', 'h2', 'Stays Here', 'stays@example.test')
    RETURNING id INTO v_other;
    INSERT INTO public.registration_import_entries (import_id, item, external_name, external_email,
                                                    partner_name, partner_email, status)
    VALUES (v_other, 1, 'Stays Here', 'stays@example.test', 'Gone Person', 'gone@example.test', 'needs_review');
    INSERT INTO public.guest_waiver_invites (email, target_kind, target_id)
    VALUES ('gone@example.test', 'club_event', v_consumer)
    RETURNING id INTO v_invite;
    INSERT INTO public.audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
    VALUES (NULL, 'manual_fee_added', 'club_fee', v_consumer,
            jsonb_build_object('manual_name', 'Gone Person', 'manual_email', 'gone@example.test'),
            '00285 self-check');

    v_count := public.scrub_registration_identity(gen_random_uuid(), ' Gone@Example.test ');

    IF EXISTS (SELECT 1 FROM public.registration_imports
                WHERE binding_id = v_binding
                  AND (submitter_email = 'gone@example.test' OR submitter_name = 'Gone Person'))
       OR EXISTS (SELECT 1 FROM public.registration_import_entries
                   WHERE import_id IN (v_import, v_other)
                     AND ('gone@example.test' IN (external_email, partner_email)
                          OR 'Gone Person' IN (external_name, partner_name)))
       OR EXISTS (SELECT 1 FROM public.guest_waiver_invites
                   WHERE id = v_invite AND (email = 'gone@example.test' OR cancelled_at IS NULL))
       OR EXISTS (SELECT 1 FROM public.audit_logs
                   WHERE target_id = v_consumer AND new_value::text LIKE '%Gone Person%') THEN
      v_bad := array_append(v_bad, 'the self-check found the scrubbed address or name still in place: ' || v_count::text);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.registration_imports
                    WHERE id = v_other AND submitter_email = 'stays@example.test'
                      AND submitter_name = 'Stays Here')
       OR NOT EXISTS (SELECT 1 FROM public.registration_import_entries
                       WHERE import_id = v_other AND external_email = 'stays@example.test') THEN
      v_bad := array_append(v_bad, 'the self-check scrubbed a different person''s rows');
    END IF;
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'P0285';
  EXCEPTION
    WHEN SQLSTATE 'P0285' THEN
      NULL;
  END;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00285 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00285 verified: anonymising a member now takes their typed name and email out of the form import, guest places, named fees and their audit rows.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
