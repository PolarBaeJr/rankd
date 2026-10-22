-- ============================================================
-- 00299 A SIGN-UP REMEMBERS ITS PREFERRED PARTNER
--
-- A club event's Google Form (Chaos Cards) asks "Doubles: preferred partner's
-- name (Optional)". The answer is free text, usually a first name, and the
-- owner pairs the teams by hand from it. The console's reader ignored it, so
-- the sign-up list never showed it.
--
-- WHAT IS ADDED
--   1. preferred_partner on club_event_signups (members) and on
--      club_event_external_signups (non-members), the two tables a club
--      event's Form signs people into. Free text, at most 120 characters,
--      NULL when the response left it empty. It is shown to the desk and
--      never matched to a member: nothing pairs anybody from it.
--   2. record_form_partner_note: the console's reader calls it after a
--      response is imported (replays included), when the binding's mapping
--      names the partner question. It writes the answer onto every sign-up
--      the response's current import holds, so an edited response, or a
--      mapping saved after the responses came in, updates the note. An empty
--      answer clears it.
--
-- NOT IN THE PAYLOAD. Like the receipt and the waiver, the answer is the
-- console's: the Apps Script and the Data API never carry it, and the hash
-- both roads agree on is untouched.
--
-- WHO SEES IT. club_event_signups_own_read (00244) lets a member read their
-- own rows only, so a member sees their own answer and nobody else's.
-- club_event_external_signups stays service role only (00284).
--
-- PRECONDITION: 00295 (the reader records after the import).
-- ============================================================

BEGIN;

ALTER TABLE public.club_event_signups
  ADD COLUMN IF NOT EXISTS preferred_partner text;
ALTER TABLE public.club_event_external_signups
  ADD COLUMN IF NOT EXISTS preferred_partner text;

ALTER TABLE public.club_event_signups
  DROP CONSTRAINT IF EXISTS club_event_signups_preferred_partner_length;
ALTER TABLE public.club_event_signups
  ADD CONSTRAINT club_event_signups_preferred_partner_length
  CHECK (preferred_partner IS NULL OR char_length(preferred_partner) BETWEEN 1 AND 120);
ALTER TABLE public.club_event_external_signups
  DROP CONSTRAINT IF EXISTS club_event_external_signups_preferred_partner_length;
ALTER TABLE public.club_event_external_signups
  ADD CONSTRAINT club_event_external_signups_preferred_partner_length
  CHECK (preferred_partner IS NULL OR char_length(preferred_partner) BETWEEN 1 AND 120);

COMMENT ON COLUMN public.club_event_signups.preferred_partner IS
  'The partner the member named on the event''s Google Form, as typed (00299). Shown to the desk; never matched to a member.';
COMMENT ON COLUMN public.club_event_external_signups.preferred_partner IS
  'The partner the non-member named on the event''s Google Form, as typed (00299). Shown to the desk; never matched to a member.';

CREATE OR REPLACE FUNCTION public.record_form_partner_note(
  p_binding_id uuid,
  p_response_id text,
  p_note text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Clamped here too: a CHECK failure would hold the reader's watermark.
  v_note    text := nullif(left(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), 120), '');
  v_import  uuid;
  v_members integer;
  v_guests  integer;
BEGIN
  SELECT i.id INTO v_import
    FROM registration_imports i
   WHERE i.binding_id = p_binding_id AND i.response_id = p_response_id
     AND i.superseded_by IS NULL
   ORDER BY i.created_at DESC
   LIMIT 1;
  IF v_import IS NULL THEN
    RETURN 'not_found';
  END IF;

  -- Matched on the sign-up, not the entry's status: a second response from
  -- somebody already signed up is refused 'already_registered', and its
  -- answer is still theirs.
  UPDATE club_event_signups s
     SET preferred_partner = v_note
    FROM registration_import_entries e
   WHERE e.import_id = v_import
     AND e.club_event_id IS NOT NULL
     AND e.entrant_id IS NOT NULL
     AND e.undone_at IS NULL
     AND e.status <> 'superseded'
     AND e.reason IS DISTINCT FROM 'not_me'
     AND s.event_id = e.club_event_id
     AND s.player_id = e.entrant_id
     AND s.preferred_partner IS DISTINCT FROM v_note;
  GET DIAGNOSTICS v_members = ROW_COUNT;

  UPDATE club_event_external_signups x
     SET preferred_partner = v_note
    FROM registration_import_entries e
   WHERE e.import_id = v_import
     AND e.club_event_id IS NOT NULL
     AND e.entrant_id IS NULL
     AND e.undone_at IS NULL
     AND e.status <> 'superseded'
     AND (x.id = e.external_signup_id
          OR (x.event_id = e.club_event_id AND x.email = lower(btrim(e.external_email))))
     AND x.preferred_partner IS DISTINCT FROM v_note;
  GET DIAGNOSTICS v_guests = ROW_COUNT;

  RETURN CASE WHEN v_members + v_guests > 0 THEN 'recorded' ELSE 'unchanged' END;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_form_partner_note(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_form_partner_note(uuid, text, text) TO service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_event_signups'
                    AND column_name = 'preferred_partner')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'club_event_external_signups'
                       AND column_name = 'preferred_partner') THEN
    RAISE EXCEPTION '00299: preferred_partner is missing';
  END IF;
  IF has_table_privilege('anon', 'public.club_event_external_signups', 'SELECT')
     OR has_table_privilege('authenticated', 'public.club_event_external_signups', 'SELECT') THEN
    RAISE EXCEPTION '00299: club_event_external_signups is readable beyond the service role';
  END IF;
  IF has_function_privilege('anon', 'public.record_form_partner_note(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_form_partner_note(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_form_partner_note(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00299: record_form_partner_note has the wrong grants';
  END IF;
  RAISE NOTICE '00299 verified: a sign-up remembers its preferred partner.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
