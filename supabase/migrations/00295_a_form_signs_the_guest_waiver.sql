-- ============================================================
-- 00295 A FORM SIGNS THE GUEST WAIVER
--
-- The club's event Forms carry the participation waiver: the waiver text, an
-- "I agree", a typed signature, and the photo and video question. Until now
-- the console read only the name, the email and the receipt, so a guest who
-- signed on the Form showed "Not signed" beside a held waiver email.
--
-- WHAT IS ADDED
--   1. guest_waiver_signings.source ('page' for the /guest-waiver page, the
--      only writer until now, and 'form') with the Form and response it came
--      from. One signing per (form, response, email): reading a response again
--      writes nothing.
--   2. record_form_guest_waiver: the console's reader calls it after a
--      response is imported (replays included), when the binding's mapping
--      names the waiver questions and the response agreed. It signs every
--      guest the response entered and cancels their unsent waiver email.
--
-- THE PRIVACY POLICY. The Form shows no privacy policy and asks for no tick.
-- The owner's ruling (2026-10-21): the privacy policy is the club's policy and
-- applies to everybody who joins club activities, so a Form signing records
-- the live privacy version exactly as the page does. `source` keeps the two
-- apart for anybody who needs to tell them apart later.
--
-- THE VERSIONS ARE STILL THE DATABASE'S (00254). The caller passes the waiver
-- version the Form's text carries, and nothing is signed unless it is the live
-- one: once an officer publishes a new waiver, a Form still showing the old
-- text signs nobody until its mapping is updated.
--
-- AGE. The waiver's clause 5 is the age attestation ("19 or older, or a parent
-- or guardian's consent"), and the Form's "I agree" accepts the whole text, so
-- age_attestation is true, as the CHECK requires.
--
-- PHOTOS AND VIDEO (00255). The new row carries the Form's answer. "No" also
-- withdraws consent on every earlier signing under the email, as
-- set_guest_media_consent does; "Allow" never turns an earlier row on.
--
-- MEMBERS are not signed here: a member's waiver is waiver_acceptances, signed
-- in the app, and the import enters them by account, not by email.
--
-- Signed records are kept: nothing here deletes a signing, and the deletion
-- path (00285) leaves guest_waiver_signings alone, Form rows included.
-- ============================================================

BEGIN;

ALTER TABLE public.guest_waiver_signings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'page',
  ADD COLUMN IF NOT EXISTS form_id text,
  ADD COLUMN IF NOT EXISTS form_response_id text;

ALTER TABLE public.guest_waiver_signings
  DROP CONSTRAINT IF EXISTS guest_waiver_signings_source;
ALTER TABLE public.guest_waiver_signings
  ADD CONSTRAINT guest_waiver_signings_source CHECK (
    (source = 'page' AND form_id IS NULL AND form_response_id IS NULL)
    OR (source = 'form' AND form_id IS NOT NULL AND form_response_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS guest_waiver_signings_form_response
  ON public.guest_waiver_signings (form_id, form_response_id, email)
  WHERE source = 'form';

COMMENT ON COLUMN public.guest_waiver_signings.source IS
  'page: signed on /guest-waiver. form: signed on a Google Form the console reads (00295); privacy_version is the live policy, which applies to everyone joining club activities.';

CREATE OR REPLACE FUNCTION public.record_form_guest_waiver(
  p_binding_id uuid,
  p_response_id text,
  p_signature text,
  p_media_consent boolean,
  p_waiver_version text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_form_id text;
  v_import record;
  v_waiver text;
  v_privacy text;
  v_signature text := left(btrim(regexp_replace(coalesce(p_signature, ''), '\s+', ' ', 'g')), 100);
  v_guest record;
  v_signed integer := 0;
BEGIN
  SELECT f.form_id INTO v_form_id FROM registration_import_forms f WHERE f.id = p_binding_id;
  IF v_form_id IS NULL THEN
    RETURN 'not_found';
  END IF;

  SELECT i.id, i.submitted_at INTO v_import
    FROM registration_imports i
   WHERE i.binding_id = p_binding_id AND i.response_id = p_response_id
     AND i.superseded_by IS NULL
   ORDER BY i.created_at DESC
   LIMIT 1;
  IF v_import.id IS NULL THEN
    RETURN 'not_found';
  END IF;

  SELECT d.version INTO v_waiver FROM legal_documents d WHERE d.document = 'waiver';
  SELECT d.version INTO v_privacy FROM legal_documents d WHERE d.document = 'privacy_policy';
  IF v_waiver IS NULL OR v_privacy IS NULL THEN
    RETURN 'not_published';
  END IF;
  IF p_waiver_version IS DISTINCT FROM v_waiver THEN
    RETURN 'version_mismatch';
  END IF;

  FOR v_guest IN
    SELECT DISTINCT ON (lower(e.external_email))
           lower(btrim(e.external_email)) AS email, e.external_name AS name
      FROM registration_import_entries e
     WHERE e.import_id = v_import.id
       AND e.entrant_id IS NULL
       AND e.external_email IS NOT NULL
       AND e.undone_at IS NULL
     ORDER BY lower(e.external_email), e.item
  LOOP
    INSERT INTO guest_waiver_signings
      (full_name, email, waiver_version, privacy_version, accepted_at, age_attestation,
       token, media_consent, source, form_id, form_response_id)
    VALUES
      (coalesce(nullif(v_signature, ''), left(btrim(v_guest.name), 100)), v_guest.email,
       v_waiver, v_privacy, coalesce(v_import.submitted_at, now()), true,
       encode(extensions.gen_random_bytes(24), 'hex'), coalesce(p_media_consent, false),
       'form', v_form_id, p_response_id)
    ON CONFLICT (form_id, form_response_id, email) WHERE source = 'form' DO NOTHING;

    IF FOUND THEN
      v_signed := v_signed + 1;
      IF p_media_consent IS NOT TRUE THEN
        UPDATE guest_waiver_signings g SET media_consent = false
         WHERE g.email = v_guest.email AND g.media_consent;
      END IF;
    END IF;

    -- Signed on the Form: the waiver email has nothing left to ask.
    UPDATE guest_waiver_invites gi SET cancelled_at = now()
     WHERE lower(gi.email) = v_guest.email
       AND gi.import_entry_id IN (SELECT e.id FROM registration_import_entries e WHERE e.import_id = v_import.id)
       AND gi.sent_at IS NULL AND gi.cancelled_at IS NULL;
  END LOOP;

  RETURN CASE WHEN v_signed > 0 THEN 'signed' ELSE 'already_signed' END;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_form_guest_waiver(uuid, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_form_guest_waiver(uuid, text, text, boolean, text) TO service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'guest_waiver_signings' AND column_name = 'source') THEN
    RAISE EXCEPTION '00295: guest_waiver_signings.source is missing';
  END IF;
  IF has_function_privilege('anon', 'public.record_form_guest_waiver(uuid, text, text, boolean, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00295: anon can run record_form_guest_waiver';
  END IF;
  RAISE NOTICE '00295 verified: a Form signs the guest waiver.';
END
$verify$;

COMMIT;
