-- ============================================================
-- 00300 A REVIEWED RECEIPT RECORDS THE AMOUNT PAID
--
-- A member sent a $10.00 e-transfer for a $5.00 event fee. The reader held it
-- as amount_mismatch, and Approve in the console's Review dialog could only
-- mark the fee paid at the $5.00 it already carried, so the extra $5.00 the
-- club received was recorded nowhere.
--
-- review_fee_submission_confirm now takes p_amount_cents, the amount the exec
-- says was paid. NULL keeps the amount the fee already carries, exactly as
-- before; a value replaces club_fees.amount_cents on both settling paths (a
-- Form receipt with no reference, and a receipt with one). A value must be
-- 1 to 1000000 cents, else 'bad_amount'. A fee with no amount can now be
-- settled when one is given, since club_fees_settled_has_amount is then met.
--
-- Adding a parameter changes the signature, so the four-argument function is
-- dropped first: two overloads with defaults would make a four-argument
-- PostgREST call ambiguous. Grants are 00298's, on the new signature. Every
-- other branch is 00298's unchanged.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.review_fee_submission_confirm(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.review_fee_submission_confirm(
  p_submission_id uuid,
  p_actor uuid,
  p_method text DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL
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
  -- 00300: the amount the exec says was paid, when it is not the fee's.
  IF p_amount_cents IS NOT NULL AND (p_amount_cents <= 0 OR p_amount_cents > 1000000) THEN
    RETURN 'bad_amount';
  END IF;
  -- club_fees_settled_has_amount would refuse the update below with a raw 23514.
  IF coalesce(p_amount_cents, v_fee.amount_cents) IS NULL THEN RETURN 'no_amount'; END IF;

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
       SET paid_at = now(), marked_by = p_actor, method = v_method, reference = NULL,
           amount_cents = coalesce(p_amount_cents, amount_cents)
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
  -- the amount the exec gave, else the one the row already carries.
  UPDATE public.club_fees
     SET paid_at = now(), marked_by = p_actor, method = v_method, reference = v_reference,
         amount_cents = coalesce(p_amount_cents, amount_cents)
   WHERE id = v_fee.id;
  RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text, text, integer) TO service_role;

DO $verify$
DECLARE
  v_fn  constant text := 'public.review_fee_submission_confirm(uuid,uuid,text,text,integer)';
  v_def text;
  v_acl text;
  v_cfg text[];
BEGIN
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'review_fee_submission_confirm' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION '00300: expected exactly one review_fee_submission_confirm';
  END IF;
  v_def := pg_get_functiondef(v_fn::regprocedure);
  IF position('amount_cents = coalesce(p_amount_cents, amount_cents)' IN v_def) = 0
     OR position('bad_amount' IN v_def) = 0 THEN
    RAISE EXCEPTION '00300: review_fee_submission_confirm does not record the amount paid';
  END IF;
  IF position('import_receipt_id IS NOT NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION '00300: review_fee_submission_confirm lost 00298''s Form receipt without a reference';
  END IF;
  SELECT proconfig, coalesce(proacl::text, '') INTO v_cfg, v_acl FROM pg_proc WHERE oid = v_fn::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_cfg)) THEN
    RAISE EXCEPTION '00300: % has no pinned search_path: %', v_fn, v_cfg;
  END IF;
  IF v_acl = '' OR v_acl ~ '(^|[{,])=X' THEN
    RAISE EXCEPTION '00300: PUBLIC can execute %: %', v_fn, v_acl;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00300: % has the wrong grants', v_fn;
  END IF;
  RAISE NOTICE '00300 verified: a reviewed receipt records the amount paid.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
