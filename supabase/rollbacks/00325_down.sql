-- ============================================================
-- ROLLBACK OF 00325: entries confirm before the day
--
-- Unschedules the event-confirmations job and drops the six functions. The
-- confirmations table stays (00324_down.sql drops it). No function from before
-- 00325 is restated: this file added functions and changed none.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DO $unschedule$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('event-confirmations')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'event-confirmations');
  END IF;
END
$unschedule$;

DROP FUNCTION IF EXISTS public.release_unconfirmed_event_entries(integer);
DROP FUNCTION IF EXISTS public.confirm_event_entry(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.record_event_confirmation_receipt(uuid, boolean, text, text);
DROP FUNCTION IF EXISTS public.claim_event_confirmation_requests(integer);
DROP FUNCTION IF EXISTS public.open_event_confirmations();
DROP FUNCTION IF EXISTS public.event_start_instant(uuid);

NOTIFY pgrst, 'reload schema';
