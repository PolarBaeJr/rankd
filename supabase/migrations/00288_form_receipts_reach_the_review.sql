-- ============================================================
-- 00288: FORM RECEIPTS REACH THE REVIEW
--
-- A Google Form read by the console (00287) can carry a file upload question:
-- the Chaos Cards form asks for an "E-transfer screenshot". Until now the poll
-- read text answers only and the screenshot stayed in Drive, where no exec
-- reviewing payments would look. This file gives each such upload a way into
-- fee_submissions, so it lands in the receipt review execs already use on
-- /fees and on a tournament's fees page.
--
-- THE ROAD A SCREENSHOT TAKES, one step per round of the five-minute poll:
--   1. record    the poll imports a response and records the upload's Drive
--                file id against that import. No Drive call yet, and the
--                watermark logic is untouched: a replay records the same id
--                and changes nothing.
--   2. claim     receipts waiting for their bytes are claimed the way the
--                session reminders are (00195): attempted_at is the claim, a
--                claim older than ten minutes is stale, and FOR UPDATE SKIP
--                LOCKED keeps two console replicas off one file.
--   3. settle    the console reads the file's size and type, downloads it,
--                checks its first bytes, uploads it to fee-proofs under
--                forms/<binding>/<import>/ and says what happened.
--   4. file      the receipt is matched to the fee it pays and filed as a
--                waiting submission with no reference. The exec reads the
--                reference off the screenshot (the console offers OCR in the
--                browser) and types or accepts it on confirm.
--
-- WHAT THIS FILE ADDS:
--   1. registration_import_receipts: one row per import that sent a file.
--      Service role only.
--   2. fee_submissions learns to hold a receipt with no member and no
--      reference. A non-member's fee is NAMED (player_id NULL, 00283), so
--      player_id goes nullable, and a plain key on club_fee_id stands in for
--      the composite key, which MATCH SIMPLE skips whenever player_id is NULL.
--      import_receipt_id says which form upload a row came from. A row with no
--      member, or no reference, must have one.
--   3. A trigger that moves a receipt with its named fee: when
--      claim_named_fees_for_player gives the fee to a new account, the
--      submission follows. ON UPDATE CASCADE cannot do it, because a key with
--      a NULL in it matches nothing.
--   4. The fee-proofs bucket widened to 10 MiB, the form's own limit, with
--      HEIC, HEIF and PDF added: a phone's screenshot and a bank's PDF are
--      both what the form accepts. The member upload policy is unchanged and
--      still keys on auth.uid(), so the forms/ prefix is reachable only by the
--      service role (no uid is the text 'forms').
--   5. review_fee_submission_confirm takes the reference the exec typed, used
--      only when the submission carries none.
--   6. registration_import_retire keeps an import-created fee that has a
--      receipt waiting on it.
--
-- THE RETIRE RISK, AND WHY THE FEE IS KEPT. When a form edit or an exec's undo
-- retires a non-member's entry, retire deletes the unpaid fee the import made.
-- The submission would cascade with it and the screenshot would sit in the
-- bucket with nothing pointing at it. A sweep could find those, but the money
-- may have moved, so the fee is kept while a receipt waits on it, exactly as
-- club_event_withdraw_fee (00248) keeps a member's event fee: the review shows
-- it beside the entry's withdrawal and the exec decides. A REJECTED receipt
-- does not hold the fee; its object is still named by the receipt row, which
-- the erasure in supabase/functions/_shared/fee-proofs.ts reads.
--
-- No players key is added, so the merge guard has nothing new to classify.
--
-- PRECONDITION: 00287.
-- ============================================================

BEGIN;

-- ---- 0. PRECONDITIONS -------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.forms_api_import_registration(uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION '00288 needs 00287 (the console reads the forms) applied first';
  END IF;
  -- Section 9 swaps the three-argument form for a four-argument one, so a
  -- second run finds that instead.
  IF to_regprocedure('public.review_fee_submission_confirm(uuid, uuid, text)') IS NULL
     AND to_regprocedure('public.review_fee_submission_confirm(uuid, uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION '00288 needs 00253 (a receipt says how it was paid) applied first';
  END IF;
END
$pre$;

-- ---- 1. THE RECEIPTS --------------------------------------------------------
-- One per import: a response edited to carry a different file supersedes the
-- row in place (section 5). storage_path is the object in fee-proofs once
-- downloaded; it stays after filing so the erasure can find an object whose
-- submission went with a deleted fee. It is nulled when the screenshot is
-- erased (a purge, or an exec's "Erase screenshot"), whatever the status.
CREATE TABLE IF NOT EXISTS public.registration_import_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id         uuid NOT NULL UNIQUE REFERENCES public.registration_imports(id) ON DELETE CASCADE,
  drive_file_id     text NOT NULL,
  mime_type         text,
  size_bytes        bigint,
  storage_path      text,
  status            text NOT NULL DEFAULT 'pending_download',
  attempts          integer NOT NULL DEFAULT 0,
  attempted_at      timestamptz,
  fee_submission_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_import_receipts_file_id_shape
    CHECK (drive_file_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  CONSTRAINT registration_import_receipts_mime_shape
    CHECK (mime_type IS NULL OR mime_type ~ '^[a-z0-9.+-]{1,60}/[a-z0-9.+-]{1,60}$'),
  CONSTRAINT registration_import_receipts_size
    CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT registration_import_receipts_path_shape
    CHECK (storage_path IS NULL OR storage_path ~ '^forms/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif|pdf)$'),
  CONSTRAINT registration_import_receipts_status
    CHECK (status IN ('pending_download', 'pending_fee', 'filed', 'fee_settled', 'duplicate', 'no_fee',
                      'too_large', 'bad_type', 'drive_forbidden', 'download_failed', 'superseded')),
  CONSTRAINT registration_import_receipts_attempts CHECK (attempts >= 0)
);
CREATE INDEX IF NOT EXISTS registration_import_receipts_waiting
  ON public.registration_import_receipts (status, attempted_at)
  WHERE status IN ('pending_download', 'pending_fee');

ALTER TABLE public.registration_import_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.registration_import_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.registration_import_receipts TO service_role;

-- ---- 2. fee_submissions HOLDS A FORM RECEIPT --------------------------------
ALTER TABLE public.fee_submissions ALTER COLUMN player_id DROP NOT NULL;
ALTER TABLE public.fee_submissions ALTER COLUMN reference DROP NOT NULL;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS import_receipt_id uuid;

-- The composite key (00248) still carries a merge's repoint and still checks
-- every row with a member. This one checks the rows without.
DO $keys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fee_submissions_club_fee_fkey') THEN
    ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_club_fee_fkey
      FOREIGN KEY (club_fee_id) REFERENCES public.club_fees (id) ON DELETE CASCADE;
  END IF;
  -- RESTRICT: a filed receipt is part of the club's record of a payment, and
  -- the import it came from is never deleted while one points at it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fee_submissions_import_receipt_fkey') THEN
    ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_import_receipt_fkey
      FOREIGN KEY (import_receipt_id) REFERENCES public.registration_import_receipts (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'registration_import_receipts_submission_fkey') THEN
    ALTER TABLE public.registration_import_receipts ADD CONSTRAINT registration_import_receipts_submission_fkey
      FOREIGN KEY (fee_submission_id) REFERENCES public.fee_submissions (id) ON DELETE SET NULL;
  END IF;
END
$keys$;

ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_member_or_form;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_member_or_form
  CHECK (player_id IS NOT NULL OR import_receipt_id IS NOT NULL);

-- 00253's two arms, now with the NULL case said out loud: a CHECK that
-- evaluates to NULL passes, so without the first arm every row could drop its
-- reference once the column is nullable.
ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_reference_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_reference_check CHECK (
  (reference IS NULL AND import_receipt_id IS NOT NULL)
  OR (reference IS NOT NULL
      AND (reference ~ '^[A-Za-z0-9-]{6,32}$'
           OR (method IS DISTINCT FROM 'e_transfer' AND reference ~ '^[A-Za-z0-9-]{4,32}$')))
);

CREATE INDEX IF NOT EXISTS fee_submissions_import_receipt_idx
  ON public.fee_submissions (import_receipt_id) WHERE import_receipt_id IS NOT NULL;

-- ---- 3. A RECEIPT FOLLOWS ITS FEE ONTO AN ACCOUNT ----------------------------
CREATE OR REPLACE FUNCTION public.fee_submissions_follow_fee_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.fee_submissions
     SET player_id = NEW.player_id
   WHERE club_fee_id = NEW.id AND player_id IS NULL;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fee_submissions_follow_fee_player() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS fee_submissions_follow_fee_player ON public.club_fees;
CREATE TRIGGER fee_submissions_follow_fee_player AFTER UPDATE OF player_id ON public.club_fees
  FOR EACH ROW WHEN (NEW.player_id IS NOT NULL AND OLD.player_id IS DISTINCT FROM NEW.player_id)
  EXECUTE FUNCTION public.fee_submissions_follow_fee_player();

-- ---- 4. THE fee-proofs BUCKET ------------------------------------------------
-- 00248's statement with the new size and types. The one policy is left as it
-- is: a member uploads into the folder named after their auth uid and nowhere
-- else.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'fee-proofs',
  'fee-proofs',
  FALSE,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---- 5. RECORD -------------------------------------------------------------
-- Called by the poll after each import, replays included. The same file id is
-- a no-op. A new one (the person edited the response and uploaded again)
-- resets the row to wait for its bytes; a receipt still waiting for an exec is
-- marked superseded, as a fee settled another way marks it (00248). stale_path
-- is an object nothing will point at any more, for the poll to remove: only
-- when no submission holds it.
CREATE OR REPLACE FUNCTION public.record_registration_import_receipt(
  p_binding_id uuid, p_response_id text, p_drive_file_id text, p_mime_type text
)
RETURNS TABLE(outcome text, stale_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_import_id uuid;
  v_receipt   registration_import_receipts%ROWTYPE;
  v_sub       fee_submissions%ROWTYPE;
  v_mime      text := NULLIF(lower(btrim(COALESCE(p_mime_type, ''))), '');
BEGIN
  IF p_drive_file_id IS NULL OR p_drive_file_id !~ '^[A-Za-z0-9_-]{1,200}$' THEN
    outcome := 'bad_file_id'; stale_path := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_mime IS NOT NULL AND v_mime !~ '^[a-z0-9.+-]{1,60}/[a-z0-9.+-]{1,60}$' THEN
    v_mime := NULL;
  END IF;

  SELECT i.id INTO v_import_id FROM registration_imports i
   WHERE i.binding_id = p_binding_id AND i.response_id = p_response_id;
  IF NOT FOUND THEN
    outcome := 'no_import'; stale_path := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_receipt FROM registration_import_receipts r WHERE r.import_id = v_import_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO registration_import_receipts (import_id, drive_file_id, mime_type)
    VALUES (v_import_id, p_drive_file_id, v_mime)
    ON CONFLICT (import_id) DO NOTHING;
    outcome := 'recorded'; stale_path := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_receipt.drive_file_id = p_drive_file_id THEN
    outcome := 'unchanged'; stale_path := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  stale_path := v_receipt.storage_path;
  IF v_receipt.fee_submission_id IS NOT NULL THEN
    SELECT * INTO v_sub FROM fee_submissions s WHERE s.id = v_receipt.fee_submission_id FOR UPDATE;
    IF FOUND THEN
      IF v_sub.status = 'submitted' THEN
        UPDATE fee_submissions SET status = 'superseded', reviewed_at = now() WHERE id = v_sub.id;
      END IF;
      -- The superseded, confirmed or rejected row keeps its screenshot.
      IF v_sub.screenshot_path IS NOT DISTINCT FROM v_receipt.storage_path THEN
        stale_path := NULL;
      END IF;
    END IF;
  END IF;

  UPDATE registration_import_receipts
     SET drive_file_id = p_drive_file_id, mime_type = v_mime, size_bytes = NULL, storage_path = NULL,
         status = 'pending_download', attempts = 0, attempted_at = NULL, fee_submission_id = NULL,
         updated_at = now()
   WHERE id = v_receipt.id;
  outcome := 'superseded';
  RETURN NEXT;
END;
$function$;

-- ---- 6. CLAIM ----------------------------------------------------------------
-- Up to p_limit receipts waiting for their bytes, not claimed in the last ten
-- minutes. A receipt claimed five times without settling has failed for a
-- reason that is not going away; it is given up first, in the same call.
CREATE OR REPLACE FUNCTION public.claim_registration_import_receipts(p_limit integer)
RETURNS TABLE(id uuid, import_id uuid, binding_id uuid, drive_file_id text, mime_type text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  UPDATE registration_import_receipts r
     SET status = 'download_failed', updated_at = now()
   WHERE r.status = 'pending_download'
     AND r.attempts >= 5
     AND r.attempted_at < now() - interval '10 minutes';

  RETURN QUERY
  WITH picked AS (
    SELECT r.id
      FROM registration_import_receipts r
     WHERE r.status = 'pending_download'
       AND (r.attempted_at IS NULL OR r.attempted_at < now() - interval '10 minutes')
     ORDER BY r.attempted_at NULLS FIRST, r.created_at, r.id
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 0), 100))
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE registration_import_receipts r
       SET attempted_at = clock_timestamp(), attempts = r.attempts + 1, updated_at = now()
      FROM picked
     WHERE r.id = picked.id
    RETURNING r.id, r.import_id, r.drive_file_id, r.mime_type, r.attempts
  )
  SELECT c.id, c.import_id, i.binding_id, c.drive_file_id, c.mime_type, c.attempts
    FROM claimed c
    JOIN registration_imports i ON i.id = c.import_id;
END;
$function$;

-- ---- 7. SETTLE ---------------------------------------------------------------
-- What the download came to. Lands only on a receipt still waiting for the
-- same file, so a download that finishes after a newer upload superseded it
-- writes nothing. 'pending_download' releases a claim the round could not
-- spend (its budget ran out) without counting it as an attempt.
CREATE OR REPLACE FUNCTION public.settle_registration_import_receipt(
  p_receipt_id uuid, p_drive_file_id text, p_status text, p_storage_path text, p_size_bytes bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_status IS NULL
     OR p_status NOT IN ('pending_download', 'pending_fee', 'too_large', 'bad_type', 'drive_forbidden')
     OR (p_status = 'pending_fee') <> (p_storage_path IS NOT NULL) THEN
    RAISE EXCEPTION 'settle_registration_import_receipt: bad settlement' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE registration_import_receipts r
     SET status       = p_status,
         storage_path = p_storage_path,
         size_bytes   = COALESCE(p_size_bytes, r.size_bytes),
         attempts     = CASE WHEN p_status = 'pending_download' THEN GREATEST(r.attempts - 1, 0) ELSE r.attempts END,
         attempted_at = CASE WHEN p_status = 'pending_download' THEN NULL ELSE r.attempted_at END,
         updated_at   = now()
   WHERE r.id = p_receipt_id
     AND r.drive_file_id = p_drive_file_id
     AND r.status = 'pending_download';
  RETURN FOUND;
END;
$function$;

-- ---- 8. FILE -----------------------------------------------------------------
-- Each downloaded receipt is matched to the fee it pays:
--   a non-member's entry: the named fee the import filed (entries.fee_id);
--   a member's entry: their fee for the binding's tournament or club event,
--     filed when they confirm the entry, so until then the receipt waits.
-- The fee is locked before anything is decided. Outcomes:
--   filed        a waiting submission with no reference, method e_transfer
--   fee_settled  the fee was already paid (or waived)
--   duplicate    a receipt is already waiting on that fee (the member sent
--                one in the app); the one-pending index refuses a second
--   superseded   a later response by the same person replaced this one
--   no_fee       nothing live is left to pay for, or a live entry has had no
--                fee for 30 days (an exec or fee-exempt member is never
--                charged)
-- Anything else stays pending_fee and is asked again next round.
CREATE OR REPLACE FUNCTION public.file_registration_import_receipts(p_limit integer)
RETURNS TABLE(receipt_id uuid, outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_receipt  registration_import_receipts%ROWTYPE;
  v_import   registration_imports%ROWTYPE;
  v_binding  registration_import_forms%ROWTYPE;
  v_fee      club_fees%ROWTYPE;
  v_fee_id   uuid;
  v_sub_id   uuid;
  v_live     boolean;
  v_outcome  text;
BEGIN
  FOR v_receipt IN
    SELECT * FROM registration_import_receipts r
     WHERE r.status = 'pending_fee'
     ORDER BY r.updated_at, r.id
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 0), 200))
     FOR UPDATE SKIP LOCKED
  LOOP
    v_outcome := NULL;
    v_fee_id  := NULL;
    SELECT * INTO v_import FROM registration_imports i WHERE i.id = v_receipt.import_id;
    SELECT * INTO v_binding FROM registration_import_forms f WHERE f.id = v_import.binding_id;

    IF v_import.superseded_by IS NOT NULL THEN
      v_outcome := 'superseded';
    ELSE
      SELECT en.fee_id INTO v_fee_id
        FROM registration_import_entries en
       WHERE en.import_id = v_import.id
         AND en.fee_id IS NOT NULL
         AND en.status NOT IN ('undone', 'superseded', 'refused')
       ORDER BY en.item
       LIMIT 1;
      IF v_fee_id IS NULL THEN
        SELECT f.id INTO v_fee_id
          FROM registration_import_entries en
          JOIN club_fees f ON f.player_id = en.entrant_id
         WHERE en.import_id = v_import.id
           AND en.entrant_id IS NOT NULL
           AND en.status NOT IN ('undone', 'superseded', 'refused')
           AND ((v_binding.target_kind = 'tournament' AND f.fee_type = 'tournament'
                 AND f.tournament_id = v_binding.tournament_id)
             OR (v_binding.target_kind = 'club_event' AND f.fee_type = 'event'
                 AND f.club_event_id = v_binding.club_event_id))
         ORDER BY f.paid_at NULLS FIRST, f.created_at
         LIMIT 1;
      END IF;

      IF v_fee_id IS NOT NULL THEN
        SELECT * INTO v_fee FROM club_fees f WHERE f.id = v_fee_id FOR UPDATE;
        IF NOT FOUND THEN
          v_outcome := NULL;
        ELSIF v_fee.paid_at IS NOT NULL THEN
          v_outcome := 'fee_settled';
        ELSE
          BEGIN
            INSERT INTO fee_submissions (club_fee_id, player_id, reference, method, screenshot_path, import_receipt_id)
            VALUES (v_fee.id, v_fee.player_id, NULL, 'e_transfer', v_receipt.storage_path, v_receipt.id)
            RETURNING id INTO v_sub_id;
            v_outcome := 'filed';
          EXCEPTION WHEN unique_violation THEN
            v_outcome := 'duplicate';
          END;
        END IF;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM registration_import_entries en
           WHERE en.import_id = v_import.id
             AND en.status IN ('entered', 'awaiting_member', 'awaiting_partner', 'needs_review')
        ) INTO v_live;
        IF NOT v_live OR v_receipt.created_at < now() - interval '30 days' THEN
          v_outcome := 'no_fee';
        END IF;
      END IF;
    END IF;

    IF v_outcome IS NULL THEN
      -- Still waiting: to the back of the queue.
      UPDATE registration_import_receipts SET updated_at = now() WHERE id = v_receipt.id;
      CONTINUE;
    END IF;
    UPDATE registration_import_receipts
       SET status = v_outcome,
           fee_submission_id = CASE WHEN v_outcome = 'filed' THEN v_sub_id ELSE NULL END,
           updated_at = now()
     WHERE id = v_receipt.id;
    receipt_id := v_receipt.id;
    outcome := v_outcome;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_registration_import_receipt(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_registration_import_receipts(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_registration_import_receipt(uuid, text, text, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_registration_import_receipts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_registration_import_receipt(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_registration_import_receipts(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_registration_import_receipt(uuid, text, text, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.file_registration_import_receipts(integer) TO service_role;

-- ---- 9. CONFIRM TAKES THE REFERENCE --------------------------------------------
-- 00253's body with the reference threaded through the way the method is: the
-- one passed when given, else the one stored, and 'needs_reference' when
-- neither. Checked here so a bad one answers a code rather than a raw 23514.
-- Dropped first, as 00253 did: a new argument is a new overload, and two would
-- make the three-argument call ambiguous.
DROP FUNCTION IF EXISTS public.review_fee_submission_confirm(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.review_fee_submission_confirm(
  p_submission_id uuid,
  p_actor uuid,
  p_method text DEFAULT NULL,
  p_reference text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub       public.fee_submissions%ROWTYPE;
  v_fee       public.club_fees%ROWTYPE;
  v_method    text;
  v_reference text;
BEGIN
  SELECT * INTO v_sub FROM public.fee_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO v_fee FROM public.club_fees WHERE id = v_sub.club_fee_id FOR UPDATE;
  IF v_sub.status <> 'submitted' THEN RETURN 'not_pending'; END IF;
  IF v_fee.paid_at IS NOT NULL THEN RETURN 'already_paid'; END IF;
  -- club_fees_settled_has_amount would refuse the update below with a raw 23514.
  IF v_fee.amount_cents IS NULL THEN RETURN 'no_amount'; END IF;

  v_method := coalesce(p_method, v_sub.method);
  IF v_method IS NULL THEN RETURN 'needs_method'; END IF;
  IF v_method NOT IN ('e_transfer', 'sfu_rec') THEN RETURN 'bad_method'; END IF;
  IF v_method = 'sfu_rec' AND v_fee.fee_type <> 'dues' THEN RETURN 'bad_method'; END IF;

  v_reference := coalesce(NULLIF(btrim(coalesce(p_reference, '')), ''), v_sub.reference);
  IF v_reference IS NULL THEN RETURN 'needs_reference'; END IF;
  IF v_reference !~ '^[A-Za-z0-9-]{4,32}$' THEN RETURN 'bad_reference'; END IF;
  -- A short reference is only allowed on an SFU Rec receipt; the CHECK would
  -- refuse the update below with a raw 23514.
  IF v_reference !~ '^[A-Za-z0-9-]{6,32}$' AND v_method <> 'sfu_rec' THEN
    RETURN 'short_reference';
  END IF;

  UPDATE public.fee_submissions
     SET status = 'confirmed', reviewed_at = now(), reviewed_by = p_actor, method = v_method,
         reference = v_reference
   WHERE id = p_submission_id;

  -- The columns markFeePaid writes (apps/admin/src/lib/actions/fees.ts), with
  -- the amount the row already carries.
  UPDATE public.club_fees
     SET paid_at = now(), marked_by = p_actor, method = v_method, reference = v_reference
   WHERE id = v_fee.id;
  RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text) TO service_role;

-- ---- 10. RETIRE KEEPS A FEE WITH A RECEIPT WAITING ----------------------------
-- 00283's body verbatim but for v_keep_fee: an import-created fee with a
-- receipt waiting or confirmed on it is not deleted, and the entry keeps its
-- link to it. See the header.
CREATE OR REPLACE FUNCTION public.registration_import_retire(p_entry_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_entry     registration_import_entries%ROWTYPE;
  v_status    text;
  v_locked    boolean;
  v_result    jsonb;
  v_fee       club_fees%ROWTYPE;
  v_why       text;
  v_keep_fee  boolean := false;
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
    -- 00288: money may have moved. The exec reviewing the receipt decides.
    v_keep_fee := EXISTS (SELECT 1 FROM fee_submissions s
                           WHERE s.club_fee_id = v_entry.fee_id AND s.status IN ('submitted', 'confirmed'));
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

  IF v_entry.fee_id IS NOT NULL AND v_entry.fee_created_by_import AND NOT v_keep_fee THEN
    DELETE FROM club_fees WHERE id = v_entry.fee_id AND paid_at IS NULL;
  END IF;

  UPDATE guest_waiver_invites
     SET cancelled_at = now()
   WHERE import_entry_id = p_entry_id AND sent_at IS NULL AND cancelled_at IS NULL;

  UPDATE registration_import_entries
     SET pair_id = NULL, participant_id = NULL,
         fee_id = CASE WHEN fee_created_by_import AND NOT v_keep_fee THEN NULL ELSE fee_id END,
         updated_at = now()
   WHERE id = p_entry_id;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.registration_import_retire(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
DO $verify$
DECLARE
  v_bad text[] := ARRAY[]::text[];
  v_fn  text;
  v_acl text;
  v_src text;
BEGIN
  -- The receipts table: RLS on, nobody but the service role.
  SELECT coalesce(relacl::text, '') INTO v_acl FROM pg_class WHERE oid = 'public.registration_import_receipts'::regclass;
  IF v_acl ~ '(^|[{,])(anon|authenticated)=' OR v_acl ~ '(^|[{,])=' THEN
    v_bad := array_append(v_bad, 'anon, authenticated or PUBLIC holds a grant on registration_import_receipts: ' || v_acl);
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.registration_import_receipts'::regclass) THEN
    v_bad := array_append(v_bad, 'RLS is not enabled on registration_import_receipts');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'registration_import_receipts') THEN
    v_bad := array_append(v_bad, 'registration_import_receipts has a policy');
  END IF;
  IF has_table_privilege('data_api_reader', 'public.registration_import_receipts', 'SELECT') THEN
    v_bad := array_append(v_bad, 'data_api_reader can read registration_import_receipts');
  END IF;

  -- fee_submissions: still read-own for members, and nothing more.
  SELECT relacl::text INTO v_acl FROM pg_class WHERE oid = 'public.fee_submissions'::regclass;
  IF v_acl ~ '(^|[{,])anon=' OR v_acl ~ '(^|[{,])=' OR v_acl !~ '(^|[{,])authenticated=r/' THEN
    v_bad := array_append(v_bad, 'fee_submissions grants changed: ' || v_acl);
  END IF;
  IF (SELECT attnotnull FROM pg_attribute
       WHERE attrelid = 'public.fee_submissions'::regclass AND attname = 'player_id') THEN
    v_bad := array_append(v_bad, 'fee_submissions.player_id is still NOT NULL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'fee_submissions_club_fee_fkey' AND conrelid = 'public.fee_submissions'::regclass
                    AND confdeltype = 'c' AND cardinality(conkey) = 1) THEN
    v_bad := array_append(v_bad, 'fee_submissions_club_fee_fkey is missing or not ON DELETE CASCADE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'fee_submissions_fee_fkey' AND confupdtype = 'c' AND confdeltype = 'c') THEN
    v_bad := array_append(v_bad, 'fee_submissions_fee_fkey (the merge repoint) is gone');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'fee_submissions_member_or_form'
                    AND conrelid = 'public.fee_submissions'::regclass) THEN
    v_bad := array_append(v_bad, 'fee_submissions_member_or_form is missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'fee_submissions_reference_check' AND conrelid = 'public.fee_submissions'::regclass
                    AND position('reference IS NULL' IN pg_get_constraintdef(oid)) > 0
                    AND position('import_receipt_id IS NOT NULL' IN pg_get_constraintdef(oid)) > 0
                    AND position('{4,32}' IN pg_get_constraintdef(oid)) > 0) THEN
    v_bad := array_append(v_bad, 'fee_submissions_reference_check does not restrict a NULL reference to form receipts');
  END IF;

  -- The receipt follows its fee.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'fee_submissions_follow_fee_player'
                    AND tgrelid = 'public.club_fees'::regclass AND NOT tgisinternal) THEN
    v_bad := array_append(v_bad, 'the fee_submissions_follow_fee_player trigger is missing');
  END IF;

  -- The functions: definer, pinned path, never PUBLIC, anon or authenticated.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.record_registration_import_receipt(uuid, text, text, text)',
    'public.claim_registration_import_receipts(integer)',
    'public.settle_registration_import_receipt(uuid, text, text, text, bigint)',
    'public.file_registration_import_receipts(integer)',
    'public.review_fee_submission_confirm(uuid, uuid, text, text)',
    'public.registration_import_retire(uuid)',
    'public.fee_submissions_follow_fee_player()'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      v_bad := array_append(v_bad, v_fn || ' is missing');
      CONTINUE;
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
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.record_registration_import_receipt(uuid, text, text, text)',
    'public.claim_registration_import_receipts(integer)',
    'public.settle_registration_import_receipt(uuid, text, text, text, bigint)',
    'public.file_registration_import_receipts(integer)',
    'public.review_fee_submission_confirm(uuid, uuid, text, text)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NOT NULL AND NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'service_role cannot call ' || v_fn);
    END IF;
    IF to_regprocedure(v_fn) IS NOT NULL AND has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'data_api_reader can call ' || v_fn);
    END IF;
  END LOOP;
  -- Retire stays callable by nobody but its owner (00283).
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = 'public.registration_import_retire(uuid)'::regprocedure
                AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) THEN
    v_bad := array_append(v_bad, 'registration_import_retire is executable by a role other than its owner');
  END IF;

  -- Exactly one confirm, the four-argument one.
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'review_fee_submission_confirm' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    v_bad := array_append(v_bad, 'expected exactly one review_fee_submission_confirm');
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.registration_import_retire(uuid)'::regprocedure;
  IF position('v_keep_fee' IN v_src) = 0 THEN
    v_bad := array_append(v_bad, 'registration_import_retire does not keep a fee with a receipt waiting');
  END IF;

  -- The bucket: private, 10 MiB, six types, and still the one member policy,
  -- which keys on auth.uid() so the forms/ folder is the service role's alone.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets
                  WHERE id = 'fee-proofs' AND public = FALSE AND file_size_limit = 10485760
                    AND allowed_mime_types @> ARRAY['image/jpeg', 'image/png', 'image/webp',
                                                    'image/heic', 'image/heif', 'application/pdf']
                    AND cardinality(allowed_mime_types) = 6) THEN
    v_bad := array_append(v_bad, 'the fee-proofs bucket is not private, 10 MiB, six types');
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND (coalesce(qual, '') LIKE '%fee-proofs%' OR coalesce(with_check, '') LIKE '%fee-proofs%')) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'fee_proofs_auth_insert'
                       AND cmd = 'INSERT' AND coalesce(with_check, '') LIKE '%auth.uid()%') THEN
    v_bad := array_append(v_bad, 'expected exactly one fee-proofs storage policy, the member insert keyed on auth.uid()');
  END IF;

  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00288 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00288 verified: form receipts are service_role only, fee_submissions holds them, the bucket takes 10 MiB.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
