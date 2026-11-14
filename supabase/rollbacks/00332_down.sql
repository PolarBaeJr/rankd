-- ============================================================
-- ROLLBACK OF 00332: a thin group merges into another of its pool
--
-- Drops merge_stage_groups. A merge already made stays made: the merged group
-- is a group like any other. Deploy a build without the merge first.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DROP FUNCTION IF EXISTS public.merge_stage_groups(uuid, smallint, smallint, smallint, smallint, uuid, jsonb, uuid);

NOTIFY pgrst, 'reload schema';
