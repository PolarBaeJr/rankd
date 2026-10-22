-- ============================================================
-- 00297 A READ RECEIPT CONFIRMS ITSELF
--
-- Every receipt so far waited for an exec. Most of them are routine: an Campus Rec
-- order number, or an e-transfer confirmation for the right amount to the
-- club. This lets the server read the screenshot (OCR in the app, never in
-- SQL) and settle the routine ones itself. Anything doubtful stays waiting for
-- an exec, with the reason it was held, and an exec can undo an automatic
-- confirmation from the fees list.
--
-- WHAT THIS FILE ADDS:
--   1. fee_submissions columns for the read: a queue state, a claim, what was
--      read, a canonical reference key, the screenshot's sha256, the reason a
--      receipt was held, and when it confirmed itself. ocr_state is added
--      with no default, so every row filed before this file stays NULL (an
--      exec reviews it as before), and only then given its default, so every
--      new row from every door (the Membership page, Discord, a Google Form)
--      is queued with no insert touched.
--   2. The reference CHECK takes an e-transfer number as a bank prints it
--      when it hides part of it: elided ("H99517225...111525803", stored with
--      three ASCII dots) or masked ("C1Aarp***bAz").
--   3. fee_reference_key: the reference as the uniqueness key compares it.
--      Lower case, no leading '#', and for Campus Rec the order number's digits,
--      so "O-600857", "0-600857" (an OCR zero) and "600857" are one order.
--   4. The key backfilled on CONFIRMED rows, first confirmed wins: an older
--      duplicate (one e-transfer settling two fees, say) is counted in a
--      NOTICE and left without a key rather than stopping the migration.
--      Waiting rows are not keyed: their reference is the member's typing.
--   5. Two partial unique indexes over waiting and confirmed rows: a
--      reference key once per method, a screenshot once. A rejected or
--      superseded row frees both, so a member can send again.
--   6. claim_fee_submission_ocr: the 00195 claim. Three attempts, ten
--      minutes apart; the third failure holds the receipt as 'ocr_failed'.
--   7. auto_confirm_fee_submission: rechecks the read inside the locks and
--      either confirms (the submission closed BEFORE the fee is marked paid,
--      as 00248 requires for its supersede trigger, and one audit row with no
--      actor) or holds the receipt with a flag.
--   8. flag_fee_submission_ocr: holds a receipt with a reason, reserving its
--      key and hash when they are free.
--   9. undo_auto_confirmed_fee_submission: an exec puts an automatic
--      confirmation back to waiting. Only while the fee is still exactly as
--      the confirmation left it (its paid_at equal to auto_confirmed_at and
--      no exec's mark on it), so it can never undo an exec's own decision.
--  10. review_fee_submission_confirm: 00288's body, taking the new reference
--      shape and keeping the key when it is free, so an exec is never blocked.
--
-- NOTHING READ IS STORED BUT THE REFERENCE. The OCR text carries a member's
-- name and student ID, so it stays in the app's memory. ocr_flag_detail is a
-- sentence like "Receipt shows $20.00, the fee is $25.00" and never a name.
--
-- PRECONDITION: 00288 (the four-argument confirm).
-- ============================================================

BEGIN;

-- 0. PRECONDITION -----------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.review_fee_submission_confirm(uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '00297: apply 00288 first';
  END IF;
END
$pre$;

-- 1. THE COLUMNS ----------------------------------------------------------------
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS ocr_state text;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS ocr_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS ocr_attempted_at timestamptz;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS ocr_reference text;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS reference_key text;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS image_sha256 text;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS ocr_flag text;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS ocr_flag_detail text;
ALTER TABLE public.fee_submissions ADD COLUMN IF NOT EXISTS auto_confirmed_at timestamptz;

-- SET DEFAULT does not backfill: the rows above stay NULL.
ALTER TABLE public.fee_submissions ALTER COLUMN ocr_state SET DEFAULT 'pending';

ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_ocr_state_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_ocr_state_check
  CHECK (ocr_state IS NULL OR ocr_state IN ('pending', 'done'));

ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_image_sha256_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_image_sha256_check
  CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_ocr_flag_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_ocr_flag_check
  CHECK (ocr_flag IS NULL OR ocr_flag IN (
    'no_reference', 'reference_used', 'screenshot_reused', 'amount_mismatch', 'amount_unreadable',
    'payee_mismatch', 'payee_unreadable', 'name_mismatch', 'program_mismatch', 'not_a_receipt',
    'wrong_method', 'unreadable_format', 'ocr_failed', 'ocr_timeout', 'fee_not_payable', 'undone'
  ));

ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_ocr_flag_detail_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_ocr_flag_detail_check
  CHECK (ocr_flag_detail IS NULL OR char_length(ocr_flag_detail) <= 200);

ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_ocr_reference_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_ocr_reference_check
  CHECK (ocr_reference IS NULL OR char_length(ocr_reference) <= 64);

-- An automatic confirmation is a confirmed row nobody reviewed.
ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_auto_confirmed_shape;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_auto_confirmed_shape
  CHECK (auto_confirmed_at IS NULL OR (status = 'confirmed' AND reviewed_by IS NULL));

COMMENT ON COLUMN public.fee_submissions.ocr_state IS
  'The server''s read of the screenshot: pending (queued), done, or NULL for a receipt filed before 00297, which an exec reviews.';
COMMENT ON COLUMN public.fee_submissions.reference_key IS
  'fee_reference_key of the reference the server read or an exec confirmed. Never the member''s typing. Unique per method among waiting and confirmed rows.';
COMMENT ON COLUMN public.fee_submissions.ocr_flag IS
  'Why the server held this receipt for an exec, when it did.';
COMMENT ON COLUMN public.fee_submissions.auto_confirmed_at IS
  'When the server confirmed this receipt itself. Equal to the fee''s paid_at until somebody changes the fee.';

-- 2. THE REFERENCE --------------------------------------------------------------
-- 00288's arms, plus one: an e-transfer number with part of it hidden. It has
-- to hide something (a '*' or '...'), so a plain 4 or 5 character e-transfer
-- reference is still refused.
ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_reference_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_reference_check CHECK (
  (reference IS NULL AND import_receipt_id IS NOT NULL)
  OR (reference IS NOT NULL
      AND (reference ~ '^[A-Za-z0-9-]{6,32}$'
           OR (method IS DISTINCT FROM 'e_transfer' AND reference ~ '^[A-Za-z0-9-]{4,32}$')
           OR (method = 'e_transfer'
               AND reference ~ '^[A-Za-z0-9][A-Za-z0-9*-]{2,30}(\.\.\.[A-Za-z0-9*-]{2,30})?$'
               AND reference ~ '\*|\.\.\.'
               AND char_length(reference) BETWEEN 6 AND 48)))
);

-- 3. THE KEY ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fee_reference_key(p_method text, p_reference text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v text;
BEGIN
  v := lower(btrim(coalesce(p_reference, '')));
  v := regexp_replace(v, '^#\s*', '');
  v := replace(v, U&'\2026', '...');
  IF p_method = 'sfu_rec' THEN
    v := regexp_replace(v, '^[o0]\s*-\s*', '');
  END IF;
  IF char_length(v) < 4 THEN RETURN NULL; END IF;
  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.fee_reference_key(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fee_reference_key(text, text) TO service_role;

-- 4. BACKFILL -----------------------------------------------------------------
DO $backfill$
DECLARE
  v_dupes integer;
BEGIN
  WITH ranked AS (
    SELECT s.id,
           public.fee_reference_key(s.method, s.reference) AS k,
           row_number() OVER (PARTITION BY s.method, public.fee_reference_key(s.method, s.reference)
                              ORDER BY s.reviewed_at, s.submitted_at, s.id) AS n
      FROM public.fee_submissions s
     WHERE s.status = 'confirmed' AND s.reference IS NOT NULL AND s.reference_key IS NULL
  )
  SELECT count(*) INTO v_dupes FROM ranked WHERE k IS NOT NULL AND n > 1;

  UPDATE public.fee_submissions s
     SET reference_key = ranked.k
    FROM (
      SELECT s2.id,
             public.fee_reference_key(s2.method, s2.reference) AS k,
             row_number() OVER (PARTITION BY s2.method, public.fee_reference_key(s2.method, s2.reference)
                                ORDER BY s2.reviewed_at, s2.submitted_at, s2.id) AS n
        FROM public.fee_submissions s2
       WHERE s2.status = 'confirmed' AND s2.reference IS NOT NULL AND s2.reference_key IS NULL
    ) ranked
   WHERE s.id = ranked.id AND ranked.k IS NOT NULL AND ranked.n = 1;

  IF v_dupes > 0 THEN
    RAISE NOTICE '00297: % confirmed receipt(s) repeat an earlier confirmed reference and were left without a key', v_dupes;
  END IF;
END
$backfill$;

-- 5. THE INDEXES ----------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS fee_submissions_reference_key_once
  ON public.fee_submissions (method, reference_key)
  WHERE reference_key IS NOT NULL AND status IN ('submitted', 'confirmed');

CREATE UNIQUE INDEX IF NOT EXISTS fee_submissions_image_once
  ON public.fee_submissions (image_sha256)
  WHERE image_sha256 IS NOT NULL AND status IN ('submitted', 'confirmed');

CREATE INDEX IF NOT EXISTS fee_submissions_ocr_queue
  ON public.fee_submissions (ocr_attempted_at)
  WHERE ocr_state = 'pending' AND status = 'submitted';

-- 6. THE CLAIM ------------------------------------------------------------------
-- One receipt by id (the app, right after filing it) or the oldest few (the
-- sweep). A claim older than ten minutes is a process that died mid-read.
CREATE OR REPLACE FUNCTION public.claim_fee_submission_ocr(
  p_submission_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 5
)
RETURNS TABLE(
  submission_id uuid,
  club_fee_id uuid,
  screenshot_path text,
  method text,
  fee_type text,
  amount_cents integer,
  payer_name text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_stale timestamptz := clock_timestamp() - interval '10 minutes';
BEGIN
  -- Out of attempts: held for an exec.
  UPDATE fee_submissions s
     SET ocr_state = 'done', ocr_flag = 'ocr_failed'
   WHERE s.status = 'submitted' AND s.ocr_state = 'pending' AND s.ocr_attempts >= 3
     AND (s.ocr_attempted_at IS NULL OR s.ocr_attempted_at < v_stale)
     AND (p_submission_id IS NULL OR s.id = p_submission_id);

  RETURN QUERY
  WITH picked AS (
    SELECT s.id
      FROM fee_submissions s
     WHERE s.status = 'submitted' AND s.ocr_state = 'pending' AND s.ocr_attempts < 3
       AND (s.ocr_attempted_at IS NULL OR s.ocr_attempted_at < v_stale)
       AND (p_submission_id IS NULL OR s.id = p_submission_id)
     ORDER BY s.submitted_at, s.id
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 0), 20))
     FOR UPDATE SKIP LOCKED
  ), stamped AS (
    UPDATE fee_submissions s
       SET ocr_attempted_at = clock_timestamp(), ocr_attempts = s.ocr_attempts + 1
      FROM picked
     WHERE s.id = picked.id
    RETURNING s.id, s.club_fee_id, s.screenshot_path, s.method, s.ocr_attempts
  )
  SELECT st.id, st.club_fee_id, st.screenshot_path, st.method, f.fee_type, f.amount_cents,
         COALESCE(p.full_name, f.manual_name), st.ocr_attempts
    FROM stamped st
    JOIN club_fees f ON f.id = st.club_fee_id
    LEFT JOIN players p ON p.id = f.player_id;
END;
$function$;

-- 8 before 7: auto_confirm holds a receipt through this one.
-- 8. HOLD FOR AN EXEC -------------------------------------------------------------
-- Acts only on a waiting row still queued. The key and the hash are reserved
-- when free, so a second copy of the same receipt is held too; a taken one is
-- simply not stored. Never raises on a duplicate. The method the read saw is
-- kept when the member gave none, so the receipt waits under the right heading.
DROP FUNCTION IF EXISTS public.flag_fee_submission_ocr(uuid, text, text, text, text);
CREATE OR REPLACE FUNCTION public.flag_fee_submission_ocr(
  p_submission_id uuid,
  p_flag text,
  p_detail text DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_image_sha256 text DEFAULT NULL,
  p_method text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub       fee_submissions%ROWTYPE;
  v_method    text;
  v_reference text;
  v_key       text;
  v_hash      text;
BEGIN
  IF p_flag IS NULL OR p_flag NOT IN (
    'no_reference', 'reference_used', 'screenshot_reused', 'amount_mismatch', 'amount_unreadable',
    'payee_mismatch', 'payee_unreadable', 'name_mismatch', 'program_mismatch', 'not_a_receipt',
    'wrong_method', 'unreadable_format', 'ocr_failed', 'ocr_timeout', 'fee_not_payable'
  ) THEN
    RETURN 'bad_flag';
  END IF;
  SELECT * INTO v_sub FROM fee_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_sub.status <> 'submitted' OR v_sub.ocr_state IS DISTINCT FROM 'pending' THEN RETURN 'not_pending'; END IF;

  v_reference := left(NULLIF(replace(btrim(coalesce(p_reference, '')), U&'\2026', '...'), ''), 64);
  v_method := coalesce(v_sub.method, CASE WHEN p_method IN ('e_transfer', 'sfu_rec') THEN p_method END);
  -- fee_submissions_reference_check refuses a 4 or 5 character e-transfer
  -- reference, so such a row stays without a method.
  IF v_sub.method IS NULL AND v_method = 'e_transfer' AND v_sub.reference !~ '^[A-Za-z0-9-]{6,32}$' THEN
    v_method := NULL;
  END IF;
  v_key := CASE WHEN v_method IS NOT NULL THEN fee_reference_key(v_method, v_reference) END;
  v_hash := CASE WHEN lower(p_image_sha256) ~ '^[0-9a-f]{64}$' THEN lower(p_image_sha256) END;
  IF v_key IS NOT NULL AND (v_sub.reference_key IS NOT NULL OR EXISTS (
       SELECT 1 FROM fee_submissions o
        WHERE o.id <> v_sub.id AND o.method = v_method AND o.reference_key = v_key
          AND o.status IN ('submitted', 'confirmed'))) THEN
    v_key := NULL;
  END IF;
  IF v_hash IS NOT NULL AND (v_sub.image_sha256 IS NOT NULL OR EXISTS (
       SELECT 1 FROM fee_submissions o
        WHERE o.id <> v_sub.id AND o.image_sha256 = v_hash AND o.status IN ('submitted', 'confirmed'))) THEN
    v_hash := NULL;
  END IF;

  BEGIN
    UPDATE fee_submissions
       SET ocr_state = 'done', ocr_flag = p_flag, ocr_flag_detail = left(p_detail, 200),
           ocr_reference = v_reference, method = v_method,
           reference_key = coalesce(reference_key, v_key),
           image_sha256 = coalesce(image_sha256, v_hash)
     WHERE id = v_sub.id;
  EXCEPTION WHEN unique_violation THEN
    -- Another row took the key or the hash in between: held without them.
    UPDATE fee_submissions
       SET ocr_state = 'done', ocr_flag = p_flag, ocr_flag_detail = left(p_detail, 200),
           ocr_reference = v_reference, method = v_method
     WHERE id = v_sub.id;
  END;
  RETURN 'ok';
END;
$function$;

-- 7. CONFIRM ITSELF ---------------------------------------------------------------
-- The app has read the receipt and found it clean. Every rule that the
-- database can check is checked again here, inside the locks, so a stale or
-- wrong read can only hold a receipt, never settle the wrong fee.
CREATE OR REPLACE FUNCTION public.auto_confirm_fee_submission(
  p_submission_id uuid,
  p_method text,
  p_reference text,
  p_image_sha256 text DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub       fee_submissions%ROWTYPE;
  v_fee       club_fees%ROWTYPE;
  v_now       timestamptz := now();
  v_reference text;
  v_key       text;
  v_hash      text;
  v_flag      text;
  v_detail    text;
  v_index     text;
BEGIN
  SELECT * INTO v_sub FROM fee_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO v_fee FROM club_fees WHERE id = v_sub.club_fee_id FOR UPDATE;
  IF v_sub.status <> 'submitted' OR v_sub.ocr_state IS DISTINCT FROM 'pending' THEN RETURN 'not_pending'; END IF;

  v_reference := NULLIF(replace(btrim(coalesce(p_reference, '')), U&'\2026', '...'), '');
  v_key := fee_reference_key(p_method, v_reference);
  v_hash := CASE WHEN lower(p_image_sha256) ~ '^[0-9a-f]{64}$' THEN lower(p_image_sha256) END;

  IF v_fee.id IS NULL OR v_fee.paid_at IS NOT NULL OR v_fee.amount_cents IS NULL THEN
    v_flag := 'fee_not_payable';
  ELSIF p_method IS NULL OR p_method NOT IN ('e_transfer', 'sfu_rec')
        OR (p_method = 'sfu_rec' AND v_fee.fee_type <> 'dues') THEN
    v_flag := 'wrong_method';
  ELSIF p_amount_cents IS NOT NULL AND p_amount_cents <> v_fee.amount_cents THEN
    v_flag := 'amount_mismatch';
    v_detail := format('Receipt shows $%s, the fee is $%s',
                       to_char(p_amount_cents / 100.0, 'FM999990.00'),
                       to_char(v_fee.amount_cents / 100.0, 'FM999990.00'));
  ELSIF v_key IS NULL
        OR NOT (v_reference ~ '^[A-Za-z0-9-]{6,32}$'
                OR (p_method = 'sfu_rec' AND v_reference ~ '^[A-Za-z0-9-]{4,32}$')
                OR (p_method = 'e_transfer'
                    AND v_reference ~ '^[A-Za-z0-9][A-Za-z0-9*-]{2,30}(\.\.\.[A-Za-z0-9*-]{2,30})?$'
                    AND v_reference ~ '\*|\.\.\.'
                    AND char_length(v_reference) BETWEEN 6 AND 48)) THEN
    v_flag := 'no_reference';
  ELSIF EXISTS (SELECT 1 FROM fee_submissions o
                 WHERE o.id <> v_sub.id AND o.method = p_method AND o.reference_key = v_key
                   AND o.status IN ('submitted', 'confirmed')) THEN
    v_flag := 'reference_used';
  ELSIF v_hash IS NOT NULL AND EXISTS (SELECT 1 FROM fee_submissions o
                 WHERE o.id <> v_sub.id AND o.image_sha256 = v_hash
                   AND o.status IN ('submitted', 'confirmed')) THEN
    v_flag := 'screenshot_reused';
  END IF;

  IF v_flag IS NOT NULL THEN
    PERFORM flag_fee_submission_ocr(v_sub.id, v_flag, v_detail, v_reference, v_hash, p_method);
    RETURN v_flag;
  END IF;

  BEGIN
    -- Closed BEFORE the fee is marked paid: the supersede trigger (00248)
    -- fires on that UPDATE of paid_at and would otherwise supersede this row.
    UPDATE fee_submissions
       SET status = 'confirmed', reviewed_at = v_now, reviewed_by = NULL, method = p_method,
           reference = v_reference, ocr_reference = left(v_reference, 64), reference_key = v_key,
           image_sha256 = coalesce(v_hash, image_sha256), ocr_state = 'done',
           ocr_flag = NULL, ocr_flag_detail = NULL, auto_confirmed_at = v_now
     WHERE id = v_sub.id;

    -- The columns markFeePaid writes, with nobody's mark on it.
    UPDATE club_fees
       SET paid_at = v_now, marked_by = NULL, method = p_method, reference = v_reference
     WHERE id = v_fee.id;

    INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
    VALUES (NULL, 'fee_submission_auto_confirmed', 'club_fee', v_fee.id,
            jsonb_build_object('paid', false),
            jsonb_build_object('paid', true, 'method', p_method, 'fee_submission_id', v_sub.id,
                               'amount_cents', v_fee.amount_cents, 'reference', v_reference),
            'Receipt read and confirmed automatically');
  EXCEPTION WHEN unique_violation THEN
    -- Another row took the key or the screenshot between the check and here.
    GET STACKED DIAGNOSTICS v_index = CONSTRAINT_NAME;
    v_flag := CASE WHEN v_index = 'fee_submissions_image_once' THEN 'screenshot_reused' ELSE 'reference_used' END;
    PERFORM flag_fee_submission_ocr(v_sub.id, v_flag, NULL, v_reference, NULL, p_method);
    RETURN v_flag;
  END;
  RETURN 'ok';
END;
$function$;

-- 9. UNDO -------------------------------------------------------------------------
-- Back to waiting, for an exec's ordinary Confirm or Reject. The key and the
-- hash stay on the row, so the number stays reserved while it waits, and the
-- row is never queued again. 'fee_changed' is the compare-and-swap: somebody
-- has marked the fee since, and that decision is theirs to reverse.
CREATE OR REPLACE FUNCTION public.undo_auto_confirmed_fee_submission(
  p_submission_id uuid,
  p_actor uuid,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub    fee_submissions%ROWTYPE;
  v_fee    club_fees%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO v_sub FROM fee_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO v_fee FROM club_fees WHERE id = v_sub.club_fee_id FOR UPDATE;
  IF v_sub.auto_confirmed_at IS NULL OR v_sub.status <> 'confirmed' THEN RETURN 'not_auto'; END IF;
  IF char_length(v_reason) NOT BETWEEN 3 AND 500 THEN RETURN 'bad_reason'; END IF;
  IF v_fee.paid_at IS DISTINCT FROM v_sub.auto_confirmed_at OR v_fee.marked_by IS NOT NULL THEN
    RETURN 'fee_changed';
  END IF;

  BEGIN
    UPDATE fee_submissions
       SET status = 'submitted', reviewed_at = NULL, reviewed_by = NULL, auto_confirmed_at = NULL,
           ocr_flag = 'undone', ocr_flag_detail = NULL
     WHERE id = v_sub.id;
    UPDATE club_fees
       SET paid_at = NULL, marked_by = NULL, method = NULL, reference = NULL
     WHERE id = v_fee.id;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'pending_exists';
  END;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (p_actor, 'fee_submission_auto_confirm_undone', 'club_fee', v_fee.id,
          jsonb_build_object('paid', true, 'method', v_fee.method, 'fee_submission_id', v_sub.id),
          jsonb_build_object('paid', false, 'fee_submission_id', v_sub.id),
          'Automatic confirmation undone: ' || v_reason);
  RETURN 'ok';
END;
$function$;

-- 10. CONFIRM TAKES THE NEW SHAPE --------------------------------------------------
-- 00288's body with two changes: an e-transfer reference with part of it hidden
-- passes the two reference checks, and the key is stored when it is free.
-- A taken key is not an exec's problem: the receipt is confirmed without one.
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
  v_hidden    boolean;
  v_key       text;
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
  -- 00297: an e-transfer number with part of it hidden, as the CHECK takes it.
  v_hidden := v_method = 'e_transfer'
              AND v_reference ~ '^[A-Za-z0-9][A-Za-z0-9*-]{2,30}(\.\.\.[A-Za-z0-9*-]{2,30})?$'
              AND v_reference ~ '\*|\.\.\.'
              AND char_length(v_reference) BETWEEN 6 AND 48;
  IF v_reference !~ '^[A-Za-z0-9-]{4,32}$' AND NOT v_hidden THEN RETURN 'bad_reference'; END IF;
  -- A short reference is only allowed on an Campus Rec receipt; the CHECK would
  -- refuse the update below with a raw 23514.
  IF v_reference !~ '^[A-Za-z0-9-]{6,32}$' AND v_method <> 'sfu_rec' AND NOT v_hidden THEN
    RETURN 'short_reference';
  END IF;

  v_key := coalesce(v_sub.reference_key, public.fee_reference_key(v_method, v_reference));
  IF v_key IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.fee_submissions o
        WHERE o.id <> v_sub.id AND o.method = v_method AND o.reference_key = v_key
          AND o.status IN ('submitted', 'confirmed')) THEN
    v_key := NULL;
  END IF;

  UPDATE public.fee_submissions
     SET status = 'confirmed', reviewed_at = now(), reviewed_by = p_actor, method = v_method,
         reference = v_reference, reference_key = v_key
   WHERE id = p_submission_id;

  -- The columns markFeePaid writes (apps/admin/src/lib/actions/fees.ts), with
  -- the amount the row already carries.
  UPDATE public.club_fees
     SET paid_at = now(), marked_by = p_actor, method = v_method, reference = v_reference
   WHERE id = v_fee.id;
  RETURN 'ok';
END;
$function$;

-- 11. GRANTS ------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.claim_fee_submission_ocr(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flag_fee_submission_ocr(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auto_confirm_fee_submission(uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.undo_auto_confirmed_fee_submission(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_fee_submission_ocr(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flag_fee_submission_ocr(uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_confirm_fee_submission(uuid, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.undo_auto_confirmed_fee_submission(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text) TO service_role;

-- 12. VERIFY ------------------------------------------------------------------------
DO $verify$
DECLARE
  v_fn  text;
  v_acl text;
  v_def boolean;
  v_cfg text[];
  v_col text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['ocr_state', 'ocr_attempts', 'ocr_attempted_at', 'ocr_reference',
                               'reference_key', 'image_sha256', 'ocr_flag', 'ocr_flag_detail',
                               'auto_confirmed_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'fee_submissions' AND column_name = v_col) THEN
      RAISE EXCEPTION '00297: fee_submissions.% is missing', v_col;
    END IF;
  END LOOP;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'fee_submissions' AND column_name = 'ocr_state')
     IS DISTINCT FROM '''pending''::text' THEN
    RAISE EXCEPTION '00297: fee_submissions.ocr_state does not default to pending';
  END IF;

  FOREACH v_col IN ARRAY ARRAY['fee_submissions_reference_key_once', 'fee_submissions_image_once',
                               'fee_submissions_ocr_queue'] LOOP
    IF to_regclass('public.' || v_col) IS NULL THEN
      RAISE EXCEPTION '00297: index % is missing', v_col;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.fee_submissions'::regclass AND conname = 'fee_submissions_reference_check'
       AND position('\.\.\.' IN pg_get_constraintdef(oid)) > 0
       AND position('{4,32}' IN pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION '00297: fee_submissions_reference_check does not take a hidden e-transfer reference';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.claim_fee_submission_ocr(uuid,integer)',
    'public.flag_fee_submission_ocr(uuid,text,text,text,text,text)',
    'public.auto_confirm_fee_submission(uuid,text,text,text,integer)',
    'public.undo_auto_confirmed_fee_submission(uuid,uuid,text)',
    'public.review_fee_submission_confirm(uuid,uuid,text,text)'
  ] LOOP
    SELECT prosecdef, proconfig, coalesce(proacl::text, '') INTO v_def, v_cfg, v_acl
      FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF NOT v_def THEN
      RAISE EXCEPTION '00297: % is not SECURITY DEFINER', v_fn;
    END IF;
    IF v_cfg IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_cfg)) THEN
      RAISE EXCEPTION '00297: % has no pinned search_path: %', v_fn, v_cfg;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00297: % is executable by anon or authenticated', v_fn;
    END IF;
    IF v_acl = '' OR v_acl ~ '(^|[{,])=X' THEN
      RAISE EXCEPTION '00297: PUBLIC can execute %: %', v_fn, v_acl;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00297: service_role cannot execute %', v_fn;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.fee_reference_key(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fee_reference_key(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00297: fee_reference_key is executable by anon or authenticated';
  END IF;

  IF public.fee_reference_key('sfu_rec', '0-600857') IS DISTINCT FROM public.fee_reference_key('sfu_rec', 'O-600857')
     OR public.fee_reference_key('sfu_rec', '#600857') IS DISTINCT FROM '600857' THEN
    RAISE EXCEPTION '00297: fee_reference_key does not treat an OCR zero as the order prefix';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
