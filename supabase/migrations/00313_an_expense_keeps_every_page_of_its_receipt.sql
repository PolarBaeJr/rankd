-- ============================================================
-- 00313: AN EXPENSE KEEPS EVERY PAGE OF ITS RECEIPT
--
-- 00231 gave an expense one receipt photo. A long warehouse-club receipt takes
-- three photos, a printing shop emails a PDF, and one shopping run often mixes
-- the club's shuttles with an exec's own groceries. This keeps every page of a
-- receipt in order, the item lines and tax lines read off it, and which items
-- were the club's, so the amount the club reimburses is the club's share.
--
-- WHAT CHANGES.
--   * The expense-receipts bucket also takes HEIC, HEIF and PDF (as 00288 did
--     for fee-proofs). Same id, same 8 MiB, still private, and its one INSERT
--     policy is untouched. There is still NO SELECT policy, for 00231's reason:
--     reads are service-role signed URLs behind fees.expenses.read.
--   * club_ledger gains vendor and receipt_total_cents, fenced to expense rows
--     with every other expense-only column by club_ledger_reimbursement_is_expense.
--     On an expense with items, amount_cents is the CLUB'S SHARE (the ticked
--     items and their tax) and receipt_total_cents is the total as printed.
--   * Three child tables, each keyed (ledger_id, direction) to a new
--     UNIQUE (id, direction) on club_ledger, with direction pinned to
--     'expense', so an income row cannot own a receipt, an item or a tax line:
--       club_expense_receipts   the files, in order
--       club_expense_items      the item lines, each ticked club or personal
--       club_expense_tax_lines  the tax lines as printed, and which codes each covers
--     Service role only. The console reads them with createAdminClient behind
--     fees.expenses.read, as it reads club_ledger.
--   * Every existing receipt_path becomes the first file of its expense.
--     receipt_path itself STAYS, mirrored to the first file by the writer
--     below, and is dropped in a later migration once no code reads it.
--   * save_club_expense_details: the one writer of all of the above. It locks
--     the ledger row FOR NO KEY UPDATE, refuses a settled row, and replaces the
--     children wholesale. Service role only.
--
-- WHY CHILD TABLES AND NOT COLUMNS. Many files in order, many items each with
-- its own tick and tax code, many tax lines. Arrays on club_ledger would make
-- every save a whole-array rewrite with no per-row constraint.
--
-- NO CHILD HAS A PLAYER COLUMN. Who uploaded a file is the first folder of its
-- path and the audit log. So merge_players and its guard are untouched, and
-- merge_players_disposable() is NOT redefined here (it stays at 00311's rows).
-- An item an exec unticked as personal is stored as "Personal item" with its
-- amounts and tax code (finance.ts, prepareDetails), so this does not keep a
-- record of what an exec bought for themselves.
--
-- APPLY THIS BEFORE THE CODE THAT READS IT. The same silent failure 00231
-- spells out applies to vendor, receipt_total_cents and the child selects:
-- PostgREST refuses a select naming an unknown column or table, the console
-- reads a refused read as an empty list, and the expense ledger renders EMPTY.
--
-- ADDITIVE ONLY. Nothing is dropped except club_ledger_reimbursement_is_expense,
-- recreated at once with two more conjuncts. Both new columns are new and
-- nullable, so every existing income row satisfies them and the validation
-- scan cannot fail.
--
-- There is a top-level COMMIT, so this is NOT applied with --single-transaction.
-- On staging the nightly snapshot replays this against prod data until prod
-- has it applied.
--
-- PRECONDITIONS: 00231 (receipt_path and the expense-receipts bucket).
-- ============================================================

BEGIN;

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_ledger' AND column_name = 'receipt_path') THEN
    RAISE EXCEPTION '00313 needs 00231: club_ledger.receipt_path is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'expense-receipts') THEN
    RAISE EXCEPTION '00313 needs 00231: the expense-receipts bucket is missing';
  END IF;
END
$pre$;

-- ---- the bucket -------------------------------------------------------------

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
 WHERE id = 'expense-receipts';

-- ---- two values on the row, expense only -------------------------------------

ALTER TABLE public.club_ledger ADD COLUMN IF NOT EXISTS vendor text;
ALTER TABLE public.club_ledger ADD COLUMN IF NOT EXISTS receipt_total_cents integer;

ALTER TABLE public.club_ledger DROP CONSTRAINT IF EXISTS club_ledger_vendor_length;
ALTER TABLE public.club_ledger ADD CONSTRAINT club_ledger_vendor_length
  CHECK (vendor IS NULL OR char_length(vendor) BETWEEN 1 AND 80);

ALTER TABLE public.club_ledger DROP CONSTRAINT IF EXISTS club_ledger_receipt_total_nonnegative;
ALTER TABLE public.club_ledger ADD CONSTRAINT club_ledger_receipt_total_nonnegative
  CHECK (receipt_total_cents IS NULL OR receipt_total_cents >= 0);

-- 00231's definition, every term kept, with the two new columns added.
ALTER TABLE public.club_ledger DROP CONSTRAINT IF EXISTS club_ledger_reimbursement_is_expense;
ALTER TABLE public.club_ledger ADD CONSTRAINT club_ledger_reimbursement_is_expense CHECK (
  direction = 'expense'
  OR (paid_by IS NULL AND reimbursed_at IS NULL AND reimbursed_by IS NULL AND quantity IS NULL
      AND receipt_path IS NULL AND vendor IS NULL AND receipt_total_cents IS NULL)
);

COMMENT ON COLUMN public.club_ledger.vendor IS
  'The store the expense was bought at, as printed on its receipt. Expense rows only.';
COMMENT ON COLUMN public.club_ledger.receipt_total_cents IS
  'The receipt total as printed. On an expense with items, amount_cents is the club''s share of it. Expense rows only.';

-- ---- the key the children hang off --------------------------------------------

-- (id, direction) is unique because id is. It exists so a child's foreign key
-- can name the direction too, and its CHECK pins that to 'expense'.
DO $key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_ledger_id_direction_key') THEN
    ALTER TABLE public.club_ledger ADD CONSTRAINT club_ledger_id_direction_key UNIQUE (id, direction);
  END IF;
END
$key$;

-- ---- the files, in order --------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.club_expense_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id    uuid NOT NULL,
  direction    text NOT NULL DEFAULT 'expense' CHECK (direction = 'expense'),
  position     smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  path         text NOT NULL CHECK (char_length(path) BETWEEN 3 AND 512),
  content_type text NOT NULL CHECK (content_type IN
                 ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT club_expense_receipts_ledger_fkey FOREIGN KEY (ledger_id, direction)
    REFERENCES public.club_ledger (id, direction) ON DELETE CASCADE,
  CONSTRAINT club_expense_receipts_position_key UNIQUE (ledger_id, position)
);

COMMENT ON TABLE public.club_expense_receipts IS
  'The receipt files of an expense, in order (00313). Service role only.';
COMMENT ON COLUMN public.club_expense_receipts.path IS
  'Object path in the private expense-receipts bucket. Its first folder is the uploader''s auth.uid(). Sign it on demand; never store a URL.';

-- ---- the item lines ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.club_expense_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id        uuid NOT NULL,
  direction        text NOT NULL DEFAULT 'expense' CHECK (direction = 'expense'),
  position         smallint NOT NULL CHECK (position BETWEEN 1 AND 500),
  description      text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 120),
  quantity         numeric(10,3) CHECK (quantity IS NULL OR quantity > 0),
  unit_price_cents integer,
  -- As printed. May be negative for a refund line.
  line_total_cents integer NOT NULL,
  discount_cents   integer NOT NULL DEFAULT 0 CHECK (discount_cents <= 0),
  tax_code         text CHECK (tax_code IS NULL OR tax_code ~ '^[A-Z0-9]{1,3}$'),
  tax_code_source  text NOT NULL DEFAULT 'receipt' CHECK (tax_code_source IN ('receipt', 'exec')),
  is_club          boolean NOT NULL DEFAULT true,
  CONSTRAINT club_expense_items_ledger_fkey FOREIGN KEY (ledger_id, direction)
    REFERENCES public.club_ledger (id, direction) ON DELETE CASCADE,
  CONSTRAINT club_expense_items_position_key UNIQUE (ledger_id, position)
);

COMMENT ON TABLE public.club_expense_items IS
  'The item lines of an expense''s receipt (00313). An unticked (personal) item is stored as "Personal item" with its amounts and tax code. Service role only.';
COMMENT ON COLUMN public.club_expense_items.tax_code IS
  'The code this receipt prints beside the item, or one the exec set (tax_code_source). Codes come from THIS receipt only, never from a table of what a store''s letters mean.';

-- ---- the tax lines ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.club_expense_tax_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id     uuid NOT NULL,
  direction     text NOT NULL DEFAULT 'expense' CHECK (direction = 'expense'),
  position      smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
  label         text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 24),
  rate_ppm      integer CHECK (rate_ppm IS NULL OR rate_ppm BETWEEN 0 AND 500000),
  printed_cents integer CHECK (printed_cents IS NULL OR printed_cents >= 0),
  codes         text[] NOT NULL DEFAULT '{}',
  CONSTRAINT club_expense_tax_lines_ledger_fkey FOREIGN KEY (ledger_id, direction)
    REFERENCES public.club_ledger (id, direction) ON DELETE CASCADE,
  CONSTRAINT club_expense_tax_lines_position_key UNIQUE (ledger_id, position)
);

COMMENT ON TABLE public.club_expense_tax_lines IS
  'The tax lines of an expense''s receipt as printed (00313): GST, PST, HST, TAX 1. Service role only.';
COMMENT ON COLUMN public.club_expense_tax_lines.rate_ppm IS
  'The printed rate in parts per million: 5.000% is 50000. NULL when the receipt prints no rate.';
COMMENT ON COLUMN public.club_expense_tax_lines.codes IS
  'The item tax codes this line applies to, as this receipt''s own legend says or as the exec set them.';

-- ---- grants: service role only --------------------------------------------------------

ALTER TABLE public.club_expense_receipts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_expense_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_expense_tax_lines ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.club_expense_receipts  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.club_expense_items     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.club_expense_tax_lines FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.club_expense_receipts  TO service_role;
GRANT ALL ON TABLE public.club_expense_items     TO service_role;
GRANT ALL ON TABLE public.club_expense_tax_lines TO service_role;

-- ---- every existing receipt is the first file of its expense ------------------------------

INSERT INTO public.club_expense_receipts (ledger_id, position, path, content_type)
SELECT id, 1, receipt_path,
       CASE lower(substring(receipt_path from '\.([A-Za-z]+)$'))
         WHEN 'png' THEN 'image/png'
         WHEN 'webp' THEN 'image/webp'
         ELSE 'image/jpeg'
       END
  FROM public.club_ledger
 WHERE direction = 'expense' AND receipt_path IS NOT NULL
ON CONFLICT (ledger_id, position) DO NOTHING;

-- ---- the one writer ----------------------------------------------------------------------

-- Called by addExpense and updateExpense (finance.ts), which have already
-- checked every path against the uploader, assigned positions and recomputed
-- the club's share. This locks the row so a reimbursement cannot land between
-- the check and the write (markExpenseReimbursed's UPDATE conflicts with this
-- lock), refuses a settled row, and replaces the children wholesale.
CREATE OR REPLACE FUNCTION public.save_club_expense_details(
  p_ledger_id uuid,
  p_amount_cents integer,
  p_vendor text,
  p_receipt_total_cents integer,
  p_receipts jsonb,
  p_items jsonb,
  p_tax_lines jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row public.club_ledger%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.club_ledger
   WHERE id = p_ledger_id AND direction = 'expense'
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_row.reimbursed_at IS NOT NULL THEN
    RETURN 'settled';
  END IF;

  UPDATE public.club_ledger
     SET amount_cents = p_amount_cents,
         vendor = p_vendor,
         receipt_total_cents = p_receipt_total_cents,
         -- The first file, so a reader still on receipt_path stays truthful.
         receipt_path = (SELECT r->>'path' FROM jsonb_array_elements(COALESCE(p_receipts, '[]'::jsonb)) r
                          ORDER BY (r->>'position')::int LIMIT 1)
   WHERE id = p_ledger_id;

  DELETE FROM public.club_expense_receipts  WHERE ledger_id = p_ledger_id;
  DELETE FROM public.club_expense_items     WHERE ledger_id = p_ledger_id;
  DELETE FROM public.club_expense_tax_lines WHERE ledger_id = p_ledger_id;

  INSERT INTO public.club_expense_receipts (ledger_id, position, path, content_type)
  SELECT p_ledger_id, (r->>'position')::smallint, r->>'path', r->>'content_type'
    FROM jsonb_array_elements(COALESCE(p_receipts, '[]'::jsonb)) r;

  INSERT INTO public.club_expense_items (
    ledger_id, position, description, quantity, unit_price_cents, line_total_cents,
    discount_cents, tax_code, tax_code_source, is_club)
  SELECT p_ledger_id, (i->>'position')::smallint, i->>'description', (i->>'quantity')::numeric,
         (i->>'unit_price_cents')::integer, (i->>'line_total_cents')::integer,
         COALESCE((i->>'discount_cents')::integer, 0), i->>'tax_code',
         COALESCE(i->>'tax_code_source', 'receipt'), COALESCE((i->>'is_club')::boolean, true)
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) i;

  INSERT INTO public.club_expense_tax_lines (ledger_id, position, label, rate_ppm, printed_cents, codes)
  SELECT p_ledger_id, (t->>'position')::smallint, t->>'label', (t->>'rate_ppm')::integer,
         (t->>'printed_cents')::integer,
         ARRAY(SELECT jsonb_array_elements_text(COALESCE(t->'codes', '[]'::jsonb)))
    FROM jsonb_array_elements(COALESCE(p_tax_lines, '[]'::jsonb)) t;

  RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.save_club_expense_details(uuid, integer, text, integer, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_club_expense_details(uuid, integer, text, integer, jsonb, jsonb, jsonb) TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad   text[] := '{}';
  v_table text;
  v_sig   text := 'public.save_club_expense_details(uuid,integer,text,integer,jsonb,jsonb,jsonb)';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets
                  WHERE id = 'expense-receipts' AND public = FALSE AND file_size_limit = 8388608
                    AND allowed_mime_types::text[] @> ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
                    AND cardinality(allowed_mime_types) = 6) THEN
    v_bad := array_append(v_bad, 'the expense-receipts bucket is not private, 8 MiB, with exactly the six types');
  END IF;

  IF (SELECT count(*) FROM pg_policy
       WHERE polrelid = 'storage.objects'::regclass
         AND (polname LIKE 'expense_receipts%'
              OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE '%expense-receipts%'
              OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE '%expense-receipts%')) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policy
                     WHERE polrelid = 'storage.objects'::regclass
                       AND polname = 'expense_receipts_auth_insert' AND polcmd = 'a') THEN
    v_bad := array_append(v_bad, 'expense-receipts must have exactly one storage policy, the INSERT one, and no read policy');
  END IF;

  FOREACH v_table IN ARRAY ARRAY['club_expense_receipts', 'club_expense_items', 'club_expense_tax_lines'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_table)::regclass) THEN
      v_bad := array_append(v_bad, format('%s does not have row level security on', v_table));
    END IF;
    IF EXISTS (SELECT 1
                 FROM pg_class c, unnest(COALESCE(c.relacl, '{}'::aclitem[])) a
                WHERE c.oid = ('public.' || v_table)::regclass
                  AND (a::text LIKE 'anon=%' OR a::text LIKE 'authenticated=%' OR a::text LIKE '=%')) THEN
      v_bad := array_append(v_bad, format('%s grants something to anon, authenticated or PUBLIC', v_table));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = v_table || '_ledger_fkey'
                      AND conrelid = ('public.' || v_table)::regclass
                      AND confrelid = 'public.club_ledger'::regclass
                      AND contype = 'f' AND confdeltype = 'c'
                      AND conkey = ARRAY[
                        (SELECT attnum FROM pg_attribute WHERE attrelid = ('public.' || v_table)::regclass AND attname = 'ledger_id'),
                        (SELECT attnum FROM pg_attribute WHERE attrelid = ('public.' || v_table)::regclass AND attname = 'direction')
                      ]::smallint[]) THEN
      v_bad := array_append(v_bad, format('%s is not keyed (ledger_id, direction) to club_ledger ON DELETE CASCADE', v_table));
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY['club_ledger_vendor_length', 'club_ledger_receipt_total_nonnegative',
                                 'club_ledger_reimbursement_is_expense', 'club_ledger_id_direction_key'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = v_table AND conrelid = 'public.club_ledger'::regclass) THEN
      v_bad := array_append(v_bad, format('%s is missing', v_table));
    END IF;
  END LOOP;
  IF position('receipt_total_cents' IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                          WHERE conname = 'club_ledger_reimbursement_is_expense'
                                            AND conrelid = 'public.club_ledger'::regclass)) = 0 THEN
    v_bad := array_append(v_bad, 'club_ledger_reimbursement_is_expense does not fence receipt_total_cents to expenses');
  END IF;

  IF to_regprocedure(v_sig) IS NULL THEN
    v_bad := array_append(v_bad, 'save_club_expense_details is missing');
  ELSE
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'save_club_expense_details is executable by anon or authenticated');
    END IF;
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'save_club_expense_details is not executable by service_role');
    END IF;
    IF position('FOR NO KEY UPDATE' IN pg_get_functiondef(v_sig::regprocedure)) = 0 THEN
      v_bad := array_append(v_bad, 'save_club_expense_details does not lock the ledger row');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_ledger l
              WHERE l.direction = 'expense' AND l.receipt_path IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.club_expense_receipts r WHERE r.ledger_id = l.id)) THEN
    v_bad := array_append(v_bad, 'an expense with a receipt_path has no club_expense_receipts row');
  END IF;

  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00313 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00313 verified: the bucket, the two columns, the three child tables, the backfill and save_club_expense_details are in place.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- AFTER THE MIGRATION
--
-- Regenerate database.gen.ts against a database that has this applied and READ
-- the diff: vendor and receipt_total_cents on club_ledger, the three tables
-- and save_club_expense_details, nothing else. Then regenerate the manifest:
--
--   ./scripts/gen-migration-manifest.sh
-- ============================================================================
