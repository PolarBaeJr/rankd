-- ============================================================
-- 00304 A TOURNAMENT KEEPS ITS OWN TIMES AND PLACE
--
-- The Discord events tab needs a start instant, an end instant and a location
-- for every tournament, and `tournaments` had none of them: start_date and
-- end_date are DATEs, and there was never a location column. So the times and
-- place came from three club-wide discord_settings keys, set with /config
-- tournament, and every tournament the club ran started at the same hour in
-- the same gym. The owner asked for a tournament's own details instead, set
-- where the rest of the tournament is set: the console, and /tourney.
--
-- These are NEW columns. 00109 dropped some tournament columns that only
-- pretended to carry this sort of thing; nothing here brings those back.
--
--   1. tournaments.starts_time, ends_time and location. All nullable: a
--      tournament without them behaves as before, taking the old
--      discord_settings keys and then 09:00, 18:00 and no location. The end
--      must be after the start when both are set, which is what Discord asks
--      of a one-day event; a tournament over several days whose last day ends
--      earlier in the day than its first began is refused too, on purpose,
--      because one rule is easier to explain than two. Location is capped at
--      200, the same as a session's and a club event's.
--
--   2. discord_tournament_events.synced_location, so a changed location is
--      noticed and pushed, as discord_club_events already does (00245). The
--      existing rows are filled from the club-wide key, which is what those
--      Discord events were created with, so applying this does not PATCH every
--      announced tournament on the next tick.
--
-- WHO MAY WRITE is unchanged: the console's tournaments.manage.update.write,
-- through the service role. `tournaments` has no column guard trigger and no
-- column-level grants (RLS from 00005, the anon revoke from 00128), so new
-- columns need nothing more. Nothing here is personal: a time of day and the
-- name of a venue, which members already see on the tournament page.
--
-- Apply this BEFORE the app that reads it: the Discord relay selects the new
-- columns, and answers 503 (so changes nothing) until they exist.
-- ============================================================

BEGIN;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS starts_time time,
  ADD COLUMN IF NOT EXISTS ends_time   time,
  ADD COLUMN IF NOT EXISTS location    text;

ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_location_length,
  ADD CONSTRAINT tournaments_location_length
    CHECK (location IS NULL OR char_length(location) <= 200),
  DROP CONSTRAINT IF EXISTS tournaments_ends_after_starts,
  ADD CONSTRAINT tournaments_ends_after_starts
    CHECK (starts_time IS NULL OR ends_time IS NULL OR ends_time > starts_time);

COMMENT ON COLUMN public.tournaments.starts_time IS
  'Club wall-clock time play starts each day (00304). NULL falls back to the old discord_settings key, then 09:00.';
COMMENT ON COLUMN public.tournaments.ends_time IS
  'Club wall-clock time play ends each day (00304). NULL falls back to the old discord_settings key, then 18:00.';
COMMENT ON COLUMN public.tournaments.location IS
  'Where the tournament is held (00304), at most 200 characters. NULL falls back to the old discord_settings key, then none.';

ALTER TABLE public.discord_tournament_events
  ADD COLUMN IF NOT EXISTS synced_location text;

COMMENT ON COLUMN public.discord_tournament_events.synced_location IS
  'The location last pushed to Discord, the app''s value rather than the bot''s fallback; NULL when there was none (00304).';

-- Only rows that have never recorded a location, so a re-run cannot overwrite
-- what a newer bot has recorded since.
UPDATE public.discord_tournament_events m
   SET synced_location = s.location
  FROM (
    SELECT left(btrim(value), 100) AS location
      FROM public.discord_settings
     WHERE key = 'tournament_event_location' AND btrim(coalesce(value, '')) <> ''
  ) s
 WHERE m.synced_location IS NULL;

DO $verify$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tournaments'
         AND column_name IN ('starts_time', 'ends_time', 'location')) <> 3 THEN
    RAISE EXCEPTION '00304: tournaments is missing one of starts_time, ends_time, location';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'discord_tournament_events'
                    AND column_name = 'synced_location') THEN
    RAISE EXCEPTION '00304: discord_tournament_events.synced_location is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tournaments'::regclass
                    AND conname = 'tournaments_ends_after_starts') THEN
    RAISE EXCEPTION '00304: the end-after-start check is missing';
  END IF;
  RAISE NOTICE '00304 verified: % tournament(s) with their own times, % with a location.',
    (SELECT count(*) FROM public.tournaments WHERE starts_time IS NOT NULL OR ends_time IS NOT NULL),
    (SELECT count(*) FROM public.tournaments WHERE location IS NOT NULL);
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
