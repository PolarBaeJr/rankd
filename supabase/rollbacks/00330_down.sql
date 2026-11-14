-- ============================================================
-- ROLLBACK OF 00330: a released late arrival comes back
--
-- Drops the three functions. An entry already reinstated stays registered and
-- its rescinded warning stays rescinded; a member already put back on the
-- reserves stays waiting. Deploy a build without Reinstate and Back to the
-- reserves first.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DROP FUNCTION IF EXISTS public.requeue_released_entry(uuid, boolean, uuid, boolean);
DROP FUNCTION IF EXISTS public.reinstate_released_entry(uuid, boolean, uuid);
DROP FUNCTION IF EXISTS public.released_entry_under_lock(uuid, boolean);

NOTIFY pgrst, 'reload schema';
