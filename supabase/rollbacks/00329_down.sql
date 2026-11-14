-- ============================================================
-- ROLLBACK OF 00329: results decided off court and by retirement
--
-- Drops the two triggers, their functions, the constraints and the two
-- columns. A match recorded off court or by retirement stays completed with
-- its winner, its loser and its scores, and from then on reads as a match
-- played: deploy a build without Decided off court and Retired first.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DROP TRIGGER IF EXISTS tournament_matches_off_court_unrated ON public.tournament_matches;
DROP TRIGGER IF EXISTS tournament_matches_result_kind_reset ON public.tournament_matches;
DROP FUNCTION IF EXISTS public.tournament_matches_off_court_unrated();
DROP FUNCTION IF EXISTS public.tournament_matches_result_kind_reset();

ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_result_kind_shape;
ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_retired_side_check;
ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_result_kind_check;
ALTER TABLE public.tournament_matches DROP COLUMN IF EXISTS retired_side;
ALTER TABLE public.tournament_matches DROP COLUMN IF EXISTS result_kind;

NOTIFY pgrst, 'reload schema';
