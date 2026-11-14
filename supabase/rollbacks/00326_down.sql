-- ============================================================
-- ROLLBACK OF 00326: check-in close releases the no-shows
--
-- Drops release_checkin_no_shows. No function from before 00326 is restated:
-- this file added one function and changed none. Entries it already withdrew
-- stay withdrawn, and the warnings it wrote stay.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DROP FUNCTION IF EXISTS public.release_checkin_no_shows(uuid, uuid, boolean);

NOTIFY pgrst, 'reload schema';
