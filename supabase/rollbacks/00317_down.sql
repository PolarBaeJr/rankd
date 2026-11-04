-- ============================================================
-- ROLLBACK OF 00317: desk guests on the spot
--
-- 00317 only created two functions, so this drops them. Run it only with the
-- console's add_on_the_spot kill switch off (or the console rolled back): Add
-- on the spot calls both. Guests it already created stay; they are ordinary
-- guest players.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DROP FUNCTION IF EXISTS public.create_desk_guest(text, uuid);
DROP FUNCTION IF EXISTS public.club_event_desk_entry_walk_in(uuid, uuid[]);

NOTIFY pgrst, 'reload schema';
