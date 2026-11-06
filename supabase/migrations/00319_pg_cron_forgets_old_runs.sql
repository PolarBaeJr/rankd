-- 00319: pg_cron forgets its own runs after 14 days.
--
-- pg_cron writes a row to cron.job_run_details for every run of every job, and
-- nothing ever deleted one. With a dozen jobs on five and ten minute schedules
-- that is thousands of rows a day, and the table had become the largest thing
-- in the database by a wide margin, bigger than every club table put together.
-- The history is only read when a job misbehaves, and two weeks is plenty for
-- that.
--
-- The purge is a plain DELETE run by pg_cron itself, so it needs no function,
-- no grant and no secret, and it calls nothing over the network. 03:30
-- Vancouver time is clear of the 04:00 staging snapshot and the 04:05 deletion
-- purge. The very first run clears the whole backlog in one statement; nothing
-- reads that table, and pg_cron does not wait on it. start_time, not end_time:
-- a run that never recorded its end still has a start.
--
-- Re-runnable: the job is unscheduled by name before it is scheduled again.

DO $schedule$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '00319: pg_cron is missing, cron-history-purge is NOT scheduled';
    RETURN;
  END IF;
  PERFORM cron.unschedule('cron-history-purge')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cron-history-purge');
  -- pg_cron schedules in UTC. BC dropped the winter fallback on 2026-11-01 and
  -- stays at UTC-7 all year, so 10:30 UTC is 03:30 in Vancouver every day.
  PERFORM cron.schedule(
    'cron-history-purge',
    '30 10 * * *',
    $job$DELETE FROM cron.job_run_details WHERE start_time < now() - interval '14 days'$job$
  );
END;
$schedule$;

-- ---- VERIFY -----------------------------------------------------------------
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'cron-history-purge'
       AND schedule = '30 10 * * *'
       AND command LIKE '%DELETE FROM cron.job_run_details%14 days%'
  ) THEN
    RAISE EXCEPTION '00319: cron-history-purge is not scheduled as written';
  END IF;
  RAISE NOTICE '00319 verified: pg_cron forgets runs older than 14 days, nightly.';
END;
$verify$;
