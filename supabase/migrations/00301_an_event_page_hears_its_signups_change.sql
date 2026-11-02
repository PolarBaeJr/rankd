-- ============================================================
-- 00301 AN EVENT PAGE HEARS ITS SIGN-UPS CHANGE
--
-- The console's event page is a server render: an exec watching it saw a new
-- sign-up, a Form import, a waitlist move or a check-in only after reloading.
-- The tournament, match and door pages update live through Supabase Realtime;
-- this gives the event page the same.
--
-- WHY A SIGNAL TABLE, NOT THE SIGN-UP TABLES. A Realtime subscriber hears only
-- the rows its own RLS lets it read. club_event_signups lets a member read
-- their own row (00244) and club_event_external_signups is service role only
-- (00284), so an exec subscribed to either would hear nothing about anybody
-- else, and a subscription that hears nothing never errors. Opening those
-- tables to execs would put guests' names and emails on the socket for a
-- page that only needs to know "something changed". So:
--
--   1. club_event_activity: one row per event, the event's id and when its
--      sign-ups last changed. No person, no player id, nothing to scrub,
--      erase, export or merge.
--   2. Statement-level triggers on club_event_signups,
--      club_event_external_signups and club_event_waitlist (insert, update,
--      delete) touch the row for every event the statement changed. One
--      statement is one signal per event, so a 50-row Form import is one
--      refresh, not 50.
--   3. Execs (is_admin) may read it; members may not, so a draft event's
--      activity stays the console's.
--   4. Published to supabase_realtime. The console refreshes the page on a
--      signal and re-reads everything with its own permissions, as the door
--      list does.
--
-- An event deleted outright leaves no row: the trigger skips events that are
-- gone, so the cascade from club_events never trips on it.
--
-- Until this is applied the console's listener subscribes and hears nothing,
-- and the page behaves as before.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.club_event_activity (
  event_id   uuid PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.club_event_activity ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.club_event_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.club_event_activity TO authenticated;
GRANT ALL ON public.club_event_activity TO service_role;

DROP POLICY IF EXISTS club_event_activity_admin_read ON public.club_event_activity;
CREATE POLICY club_event_activity_admin_read ON public.club_event_activity
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.note_club_event_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.club_event_activity AS activity (event_id, changed_at)
  SELECT DISTINCT changed.event_id, now()
    FROM changed_rows AS changed
   WHERE EXISTS (SELECT 1 FROM public.club_events e WHERE e.id = changed.event_id)
  ON CONFLICT (event_id) DO UPDATE SET changed_at = EXCLUDED.changed_at;
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public.note_club_event_activity() FROM PUBLIC, anon, authenticated;

-- A transition table belongs to one event, so each table gets three triggers.
DO $triggers$
DECLARE
  watched text;
BEGIN
  FOREACH watched IN ARRAY ARRAY['club_event_signups', 'club_event_external_signups', 'club_event_waitlist'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_activity_insert ON public.%I', watched, watched);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_activity_update ON public.%I', watched, watched);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_activity_delete ON public.%I', watched, watched);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_activity_insert AFTER INSERT ON public.%I
         REFERENCING NEW TABLE AS changed_rows
         FOR EACH STATEMENT EXECUTE FUNCTION public.note_club_event_activity()', watched, watched);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_activity_update AFTER UPDATE ON public.%I
         REFERENCING NEW TABLE AS changed_rows
         FOR EACH STATEMENT EXECUTE FUNCTION public.note_club_event_activity()', watched, watched);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_activity_delete AFTER DELETE ON public.%I
         REFERENCING OLD TABLE AS changed_rows
         FOR EACH STATEMENT EXECUTE FUNCTION public.note_club_event_activity()', watched, watched);
  END LOOP;
END
$triggers$;

DO $publish$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                    AND tablename = 'club_event_activity') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.club_event_activity;
  END IF;
END
$publish$;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND tablename = 'club_event_activity') THEN
    RAISE EXCEPTION '00301: club_event_activity is not published';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname LIKE 'trg_club_event_%_activity_%'
         AND c.relname IN ('club_event_signups', 'club_event_external_signups', 'club_event_waitlist')) <> 9 THEN
    RAISE EXCEPTION '00301: expected nine activity triggers';
  END IF;
  IF has_table_privilege('anon', 'public.club_event_activity', 'SELECT')
     OR has_table_privilege('authenticated', 'public.club_event_activity', 'INSERT')
     OR has_table_privilege('authenticated', 'public.club_event_external_signups', 'SELECT') THEN
    RAISE EXCEPTION '00301: grants are wider than intended';
  END IF;
  IF has_function_privilege('anon', 'public.note_club_event_activity()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.note_club_event_activity()', 'EXECUTE') THEN
    RAISE EXCEPTION '00301: note_club_event_activity is callable by clients';
  END IF;
  RAISE NOTICE '00301 verified: an event page hears its sign-ups change.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
