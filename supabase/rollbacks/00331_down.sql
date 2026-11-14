-- ============================================================
-- ROLLBACK OF 00331: a group can be capped in time
--
-- Unschedules the minute job, then drops the two functions and the table.
-- Matches a cap already voided stay voided, with their "Time cap reached"
-- note; Restore brings one back by hand. Deploy a build without the time cap
-- first.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('group-time-caps')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'group-time-caps');
  END IF;
END
$cron$;

DROP FUNCTION IF EXISTS public.apply_due_group_time_caps();
DROP FUNCTION IF EXISTS public.apply_group_time_cap(uuid, uuid);
DROP TABLE IF EXISTS public.stage_group_time_caps;

NOTIFY pgrst, 'reload schema';
