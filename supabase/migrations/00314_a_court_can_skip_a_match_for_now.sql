-- ============================================================
-- 00314: A COURT CAN SKIP A MATCH FOR NOW
--
-- On event day a match is called and one of its teams is not at the court.
-- The helper (or the desk) now presses "Skip for now": the match comes off
-- the court, goes behind every other match that court can take, and the
-- next one goes on. It is called again once nothing else is waiting.
--
-- WHAT CHANGES.
--   * tournament_matches.deferred_at: when the match was last skipped. NULL
--     is a match never skipped. A court's queue takes the matches with no
--     deferred_at in the draw's order first, then the skipped ones, the
--     longest-skipped first. Nothing else reads it: the match keeps its
--     number, round and court.
--
-- Additive and nullable, so the code before this migration and after it both
-- run against it. No grants: a new column takes the table's.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

ALTER TABLE public.tournament_matches
  ADD COLUMN IF NOT EXISTS deferred_at timestamptz;

COMMENT ON COLUMN public.tournament_matches.deferred_at IS
  'When a court last skipped this match for now (00314). A court takes its other matches first.';

NOTIFY pgrst, 'reload schema';
