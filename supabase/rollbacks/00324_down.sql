-- ============================================================
-- ROLLBACK OF 00324: attendance warnings, entry restrictions and confirmations
--
-- Drops the three tables, the event's confirmation settings and the day lead,
-- and puts back 00320's merge_players_disposable. Run 00326_down.sql and
-- 00325_down.sql first: their functions read these tables.
--
-- THE ROWS ARE LOST. Every warning, restriction and confirmation goes with its
-- table, so take a copy first if any of them matters.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
--
-- The function is restated whole and verbatim from 00320, under the same
-- signature and grants.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_players_disposable()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',                'player_id'),
    ('push_subscriptions',           'player_id'),
    ('calendar_feed_tokens',         'player_id'),
    ('ratings',                      'player_id'),
    ('reliability_metrics',          'player_id'),
    ('discord_outbox',               'requested_by'),
    ('data_api_consumers',           'created_by'),
    ('data_api_keys',                'minted_by'),
    ('data_api_keys',                'revoked_by'),
    ('club_event_signups',           'player_id'),
    ('club_events',                  'created_by'),
    ('fee_submissions',              'reviewed_by'),
    ('tournament_event_waitlist',    'player_id'),
    ('tournament_event_waitlist',    'resolved_by'),
    ('tournament_category_requests', 'requested_by'),
    ('tournament_category_requests', 'resolved_by'),
    ('data_api_predictions',         'side1_p1'),
    ('data_api_predictions',         'side1_p2'),
    ('data_api_predictions',         'side2_p1'),
    ('data_api_predictions',         'side2_p2'),
    ('registration_import_forms',    'created_by'),
    ('registration_imports',         'submitter_player_id'),
    ('registration_import_entries',  'entrant_id'),
    ('registration_import_entries',  'requested_partner_id'),
    ('registration_import_entries',  'undone_by'),
    ('club_event_waitlist',          'player_id'),
    ('club_event_waitlist',          'resolved_by'),
    ('tournament_court_helpers',     'player_id'),
    ('tournament_court_helpers',     'created_by'),
    ('club_event_signups',           'preferred_partner_player_id'),
    ('club_event_external_signups',  'preferred_partner_player_id'),
    ('possible_duplicate_dismissals', 'player_a'),
    ('possible_duplicate_dismissals', 'player_b'),
    ('possible_duplicate_dismissals', 'dismissed_by')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

DROP TABLE IF EXISTS public.event_departures;
DROP TABLE IF EXISTS public.tournament_event_confirmations;
DROP TABLE IF EXISTS public.event_entry_restrictions;
DROP TABLE IF EXISTS public.attendance_warnings;

ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_confirm_window;
ALTER TABLE public.tournament_events
  DROP COLUMN IF EXISTS confirm_required,
  DROP COLUMN IF EXISTS confirm_opens_hours,
  DROP COLUMN IF EXISTS confirm_deadline_hours;
ALTER TABLE public.tournaments DROP COLUMN IF EXISTS day_lead_player_id;

NOTIFY pgrst, 'reload schema';
