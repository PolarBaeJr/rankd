-- ============================================================
-- ROLLBACK OF 00334: teams are generated and published
--
-- Drops relink_event_confirmations. Confirmation rows it repointed stay
-- pointed at the entry they were moved to, which is the correct one. Deploy a
-- build without Generate teams first (or turn generate_teams off).
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DROP FUNCTION IF EXISTS public.relink_event_confirmations(uuid, uuid[]);

NOTIFY pgrst, 'reload schema';
