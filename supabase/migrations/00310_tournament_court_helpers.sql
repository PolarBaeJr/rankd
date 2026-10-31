-- ============================================================
-- 00310: A CONSOLE MEMBER KEEPS SCORE ON A COURT
--
-- On event day the desk cannot watch every court. An officer now names
-- console members as helpers on a court, and a helper enters the result of
-- the match on that court from /my-courts. The save goes through the console's
-- one result path; the authority is this table, checked against the match's
-- current court inside the result's own UPDATE.
--
-- WHAT CHANGES.
--   * tournament_courts gets UNIQUE (id, tournament_id), so a helper row can
--     name its court and its tournament together and never disagree.
--   * tournament_court_helpers: one row per (court, person). The same person
--     may help on several courts. Its ONLY reference to tournament_courts is
--     the composite one: a second would make every unnamed embed between the
--     two tables ambiguous (PGRST201).
--   * merge_players_disposable() gains the table's two player columns. A
--     merged-away duplicate's helper assignments are dropped, not moved: an
--     assignment is event-day operations and the officer adds it again.
--
-- No policies: every read and write is the console's, as service_role.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

-- ---- the court key ---------------------------------------------------------

DO $court_key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tournament_courts_id_tournament_key'
                    AND conrelid = 'public.tournament_courts'::regclass) THEN
    ALTER TABLE public.tournament_courts
      ADD CONSTRAINT tournament_courts_id_tournament_key UNIQUE (id, tournament_id);
  END IF;
END
$court_key$;

-- ---- the table -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tournament_court_helpers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  court_id uuid NOT NULL,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.players(id) ON DELETE SET NULL,
  CONSTRAINT tournament_court_helpers_court_fkey FOREIGN KEY (court_id, tournament_id)
    REFERENCES public.tournament_courts(id, tournament_id) ON DELETE CASCADE,
  CONSTRAINT tournament_court_helpers_court_player_key UNIQUE (court_id, player_id)
);

CREATE INDEX IF NOT EXISTS tournament_court_helpers_player_id_idx
  ON public.tournament_court_helpers (player_id);
CREATE INDEX IF NOT EXISTS tournament_court_helpers_tournament_id_idx
  ON public.tournament_court_helpers (tournament_id);

ALTER TABLE public.tournament_court_helpers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_court_helpers FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tournament_court_helpers TO service_role;

COMMENT ON TABLE public.tournament_court_helpers IS
  'Console members named to keep score on one tournament court (00310). A helper enters the result of the match currently on that court from /my-courts. Many to many: one person may help on several courts.';

-- ---- MERGES -----------------------------------------------------------------
-- The rows from 00294, and the two player columns this file adds.
CREATE OR REPLACE FUNCTION public.merge_players_disposable()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',                'player_id'),
    ('push_subscriptions',           'player_id'),
    ('calendar_feed_tokens',         'player_id'),
    ('ratings',                      'player_id'),
    ('reliability_metrics',          'player_id'),
    ('discord_outbox',               'requested_by'),
    ('data_api_consumers',           'created_by'),
    ('data_api_keys',                'minted_by'),
    ('data_api_keys',                'revoked_by'),
    ('club_event_signups',           'player_id'),
    ('club_events',                  'created_by'),
    ('fee_submissions',              'reviewed_by'),
    ('tournament_event_waitlist',    'player_id'),
    ('tournament_event_waitlist',    'resolved_by'),
    ('tournament_category_requests', 'requested_by'),
    ('tournament_category_requests', 'resolved_by'),
    ('data_api_predictions',         'side1_p1'),
    ('data_api_predictions',         'side1_p2'),
    ('data_api_predictions',         'side2_p1'),
    ('data_api_predictions',         'side2_p2'),
    ('registration_import_forms',    'created_by'),
    ('registration_imports',         'submitter_player_id'),
    ('registration_import_entries',  'entrant_id'),
    ('registration_import_entries',  'requested_partner_id'),
    ('registration_import_entries',  'undone_by'),
    ('club_event_waitlist',          'player_id'),
    ('club_event_waitlist',          'resolved_by'),
    ('tournament_court_helpers',     'player_id'),
    ('tournament_court_helpers',     'created_by')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
BEGIN
  IF to_regclass('public.tournament_court_helpers') IS NULL THEN
    v_bad := array_append(v_bad, 'tournament_court_helpers is missing');
  ELSE
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tournament_court_helpers'::regclass) THEN
      v_bad := array_append(v_bad, 'tournament_court_helpers does not have row level security on');
    END IF;
    IF has_table_privilege('anon', 'public.tournament_court_helpers', 'SELECT')
       OR has_table_privilege('anon', 'public.tournament_court_helpers', 'INSERT')
       OR has_table_privilege('anon', 'public.tournament_court_helpers', 'UPDATE')
       OR has_table_privilege('anon', 'public.tournament_court_helpers', 'DELETE')
       OR has_table_privilege('authenticated', 'public.tournament_court_helpers', 'SELECT')
       OR has_table_privilege('authenticated', 'public.tournament_court_helpers', 'INSERT')
       OR has_table_privilege('authenticated', 'public.tournament_court_helpers', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.tournament_court_helpers', 'DELETE') THEN
      v_bad := array_append(v_bad, 'tournament_court_helpers is reachable by anon or authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'tournament_court_helpers_court_player_key'
                      AND conrelid = 'public.tournament_court_helpers'::regclass
                      AND contype = 'u') THEN
      v_bad := array_append(v_bad, 'tournament_court_helpers_court_player_key is missing');
    END IF;
    IF (SELECT count(*) FROM pg_constraint
         WHERE conrelid = 'public.tournament_court_helpers'::regclass
           AND confrelid = 'public.tournament_courts'::regclass
           AND contype = 'f') <> 1 THEN
      v_bad := array_append(v_bad, 'tournament_court_helpers must have exactly one reference to tournament_courts');
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tournament_courts_id_tournament_key'
                    AND conrelid = 'public.tournament_courts'::regclass) THEN
    v_bad := array_append(v_bad, 'tournament_courts_id_tournament_key is missing');
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 29 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the twenty-nine rows');
  END IF;
  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00310 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00310 verified: tournament_court_helpers, its court key and the merge rows are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
