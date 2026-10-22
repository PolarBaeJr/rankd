-- ============================================================
-- 00298 A FORM RECEIPT CONFIRMS WITHOUT A REFERENCE
--
-- Some banks' e-transfer "sent" screens show the recipient, the email and the
-- amount and no reference number, so an exec reviewing a Google Form receipt
-- had nothing to type and could not confirm it. review_fee_submission_confirm
-- now confirms a Form receipt (import_receipt_id set) with no reference: the
-- submission keeps a NULL reference, which fee_submissions_reference_check
-- already allows for a Form row, and the fee is marked paid with none.
--
-- auto_confirm_fee_submission does the same for the reader: a Form e-transfer
-- receipt with no reference on it settles on the recipient (the club's payee
-- name or e-transfer email) and the amount, both checked by decideAutoConfirm,
-- as long as the amount was read and the screenshot was hashed. The screenshot
-- hash (fee_submissions_image_once) is then what stops one picture settling
-- two fees.
--
-- The reader also holds a receipt sent outside the time its fee could be
-- paid in ('outside_window'): from when the event, tournament or season was
-- made until the event ends (the day after a tournament's or season's last
-- day). A missing date leaves that end unchecked.
--
-- A member's own receipt is unchanged: it always carries a reference, and
-- 'needs_reference' still answers for one that somehow has none. A typed
-- reference on a Form receipt is still checked exactly as before.
--
-- Both functions keep 00297's signatures, grants and every other branch.
-- ============================================================

BEGIN;

-- 'outside_window': sent outside the time the fee could be paid in.
ALTER TABLE public.fee_submissions DROP CONSTRAINT IF EXISTS fee_submissions_ocr_flag_check;
ALTER TABLE public.fee_submissions ADD CONSTRAINT fee_submissions_ocr_flag_check
  CHECK (ocr_flag IS NULL OR ocr_flag IN (
    'no_reference', 'reference_used', 'screenshot_reused', 'amount_mismatch', 'amount_unreadable',
    'payee_mismatch', 'payee_unreadable', 'name_mismatch', 'program_mismatch', 'not_a_receipt',
    'wrong_method', 'unreadable_format', 'ocr_failed', 'ocr_timeout', 'fee_not_payable', 'undone',
    'outside_window'
  ));

-- The reader records the new hold through this, which refuses a flag it does not list.
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
    'wrong_method', 'unreadable_format', 'ocr_failed', 'ocr_timeout', 'fee_not_payable',
    'outside_window'
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

REVOKE ALL ON FUNCTION public.flag_fee_submission_ocr(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_fee_submission_ocr(uuid, text, text, text, text, text) TO service_role;

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
  -- 00298: a Form receipt may be confirmed with none. Some banks' "sent"
  -- screens show no reference at all, and the exec has looked at the
  -- screenshot. A member's own receipt always carries one.
  IF v_reference IS NULL AND v_sub.import_receipt_id IS NOT NULL THEN
    UPDATE public.fee_submissions
       SET status = 'confirmed', reviewed_at = now(), reviewed_by = p_actor, method = v_method
     WHERE id = p_submission_id;
    UPDATE public.club_fees
       SET paid_at = now(), marked_by = p_actor, method = v_method, reference = NULL
     WHERE id = v_fee.id;
    RETURN 'ok';
  END IF;
  IF v_reference IS NULL THEN RETURN 'needs_reference'; END IF;
  -- 00297: an e-transfer number with part of it hidden, as the CHECK takes it.
  v_hidden := v_method = 'e_transfer'
              AND v_reference ~ '^[A-Za-z0-9][A-Za-z0-9*-]{2,30}(\.\.\.[A-Za-z0-9*-]{2,30})?$'
              AND v_reference ~ '\*|\.\.\.'
              AND char_length(v_reference) BETWEEN 6 AND 48;
  IF v_reference !~ '^[A-Za-z0-9-]{4,32}$' AND NOT v_hidden THEN RETURN 'bad_reference'; END IF;
  -- A short reference is only allowed on an SFU Rec receipt; the CHECK would
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
  v_from      timestamptz;
  v_until     timestamptz;
BEGIN
  SELECT * INTO v_sub FROM fee_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO v_fee FROM club_fees WHERE id = v_sub.club_fee_id FOR UPDATE;
  IF v_sub.status <> 'submitted' OR v_sub.ocr_state IS DISTINCT FROM 'pending' THEN RETURN 'not_pending'; END IF;

  -- 00298: the time the fee could be paid in. Either end is NULL when the
  -- event, tournament or season has no such date, and is then not checked.
  IF v_fee.club_event_id IS NOT NULL THEN
    SELECT e.created_at, e.ends_at INTO v_from, v_until FROM club_events e WHERE e.id = v_fee.club_event_id;
  ELSIF v_fee.tournament_id IS NOT NULL THEN
    SELECT t.created_at, ((t.end_date + 1)::timestamp AT TIME ZONE 'America/Vancouver')
      INTO v_from, v_until FROM tournaments t WHERE t.id = v_fee.tournament_id;
  ELSIF v_fee.season_id IS NOT NULL THEN
    SELECT se.created_at, ((se.end_date + 1)::timestamp AT TIME ZONE 'America/Vancouver')
      INTO v_from, v_until FROM seasons se WHERE se.id = v_fee.season_id;
  END IF;

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
  ELSIF (v_from IS NOT NULL AND v_sub.submitted_at < v_from)
        OR (v_until IS NOT NULL AND v_sub.submitted_at > v_until) THEN
    v_flag := 'outside_window';
    v_detail := CASE WHEN v_from IS NOT NULL AND v_sub.submitted_at < v_from
                     THEN 'Sent before this fee existed'
                     ELSE 'Sent after the event ended' END;
  -- 00298: a Form e-transfer receipt whose screen shows no reference settles on
  -- the recipient and amount (checked by the reader) when the amount was read
  -- and the screenshot is hashed, so the same picture cannot settle twice.
  ELSIF NOT (p_method = 'e_transfer' AND v_reference IS NULL AND v_sub.reference IS NULL
             AND v_sub.import_receipt_id IS NOT NULL AND p_amount_cents IS NOT NULL AND v_hash IS NOT NULL)
        AND (v_key IS NULL
        OR NOT (v_reference ~ '^[A-Za-z0-9-]{6,32}$'
                OR (p_method = 'sfu_rec' AND v_reference ~ '^[A-Za-z0-9-]{4,32}$')
                OR (p_method = 'e_transfer'
                    AND v_reference ~ '^[A-Za-z0-9][A-Za-z0-9*-]{2,30}(\.\.\.[A-Za-z0-9*-]{2,30})?$'
                    AND v_reference ~ '\*|\.\.\.'
                    AND char_length(v_reference) BETWEEN 6 AND 48))) THEN
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

REVOKE ALL ON FUNCTION public.auto_confirm_fee_submission(uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_confirm_fee_submission(uuid, text, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text) TO service_role;

DO $verify$
DECLARE
  v_fn  constant text := 'public.review_fee_submission_confirm(uuid,uuid,text,text)';
  v_cfg text[];
BEGIN
  IF position('import_receipt_id IS NOT NULL' IN pg_get_functiondef(v_fn::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00298: review_fee_submission_confirm does not confirm a Form receipt without a reference';
  END IF;
  IF position('v_sub.import_receipt_id IS NOT NULL AND p_amount_cents IS NOT NULL AND v_hash IS NOT NULL'
              IN pg_get_functiondef('public.auto_confirm_fee_submission(uuid,text,text,text,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00298: auto_confirm_fee_submission does not settle a Form receipt without a reference';
  END IF;
  IF position('outside_window' IN pg_get_functiondef('public.auto_confirm_fee_submission(uuid,text,text,text,integer)'::regprocedure)) = 0
     OR position('outside_window' IN pg_get_functiondef('public.flag_fee_submission_ocr(uuid,text,text,text,text,text)'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fee_submissions_ocr_flag_check'
                     AND position('outside_window' IN pg_get_constraintdef(oid)) > 0) THEN
    RAISE EXCEPTION '00298: the outside_window hold is missing';
  END IF;
  IF has_function_privilege('anon', 'public.auto_confirm_fee_submission(uuid,text,text,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.auto_confirm_fee_submission(uuid,text,text,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '00298: auto_confirm_fee_submission is executable by anon or authenticated';
  END IF;
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid = v_fn::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_cfg)) THEN
    RAISE EXCEPTION '00298: % has no pinned search_path: %', v_fn, v_cfg;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00298: % has the wrong grants', v_fn;
  END IF;
  RAISE NOTICE '00298 verified: a Form receipt confirms without a reference.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
