-- ============================================================
-- 00267 THE STANDINGS CHECK THEIR SEASON CHEAPLY
--
-- WHAT IS ADDED: data_api_season_header(consumer, season), one public function
-- for data_api_reader behind seasons:read (00264).
--
-- WHY: /v1/seasons/:id/standings answered its 404 by calling data_api_seasons,
-- which builds every match in history through data_api_match_rows() to count
-- the season's totals, and then threw the totals away. That doubled the
-- database work of every standings request, and under ten concurrent requests
-- (redacted in export)
-- nothing else: id, name and whether it is the active season.
--
-- SAME VISIBILITY as data_api_seasons: a hidden season is zero rows, so it
-- 404s exactly as before.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.data_api_season_header(p_consumer_id uuid, p_season_id uuid)
RETURNS TABLE(id uuid, name text, active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.id, s.name, s.active_flag
    FROM seasons s
   WHERE s.id = p_season_id
     AND s.hidden_flag = FALSE;
$function$;
COMMENT ON FUNCTION public.data_api_season_header(uuid, uuid) IS
  'A visible season''s id, name and active flag, with no totals. The standings route checks its season with this rather than data_api_seasons, which scans every match. A hidden season is zero rows.';
REVOKE ALL ON FUNCTION public.data_api_season_header(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_season_header(uuid, uuid) TO data_api_reader;

-- ------------------------------------------------------------
-- Verification
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_fn text := 'public.data_api_season_header(uuid,uuid)';
  v_hidden uuid;
  v_n integer;
BEGIN
  IF NOT has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00267 verification failed: data_api_reader cannot execute %', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00267 verification failed: anon or authenticated can execute %', v_fn;
  END IF;

  SET LOCAL ROLE data_api_reader;
  PERFORM count(*) FROM public.data_api_season_header(gen_random_uuid(), gen_random_uuid());
  RESET ROLE;

  SELECT s.id INTO v_hidden FROM public.seasons s WHERE s.hidden_flag LIMIT 1;
  IF v_hidden IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.data_api_season_header(gen_random_uuid(), v_hidden);
    IF v_n <> 0 THEN
      RAISE EXCEPTION '00267: a hidden season has a header';
    END IF;
  END IF;

  RAISE NOTICE '00267 verified: data_api_season_header is reachable by data_api_reader only and hides hidden seasons.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
