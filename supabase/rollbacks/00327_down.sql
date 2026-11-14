-- ============================================================
-- ROLLBACK OF 00327: substitutions
--
-- Drops substitute_event_entry and event_substitutions, and restates 00324's
-- merge_players_disposable without the three substitution rows. The lineup
-- column on tournament_matches is dropped last: a decided match a substitution
-- already snapshotted then reads its entry's CURRENT members again, which is
-- the incoming person. Run this only before the first substitution, or
-- accept that.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
-- ============================================================

DROP FUNCTION IF EXISTS public.substitute_event_entry(uuid, uuid, text, uuid[], uuid[], text, uuid, boolean, text, integer, integer);
DROP TABLE IF EXISTS public.event_substitutions;

-- 00324's merge_players_disposable, verbatim.
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
    ('possible_duplicate_dismissals', 'dismissed_by'),
    ('attendance_warnings',          'player_id'),
    ('attendance_warnings',          'issued_by'),
    ('attendance_warnings',          'rescinded_by'),
    ('event_entry_restrictions',     'player_id'),
    ('event_entry_restrictions',     'created_by'),
    ('event_entry_restrictions',     'lifted_by'),
    ('tournament_event_confirmations', 'player_id'),
    ('event_departures',             'player_id'),
    ('event_departures',             'marked_by'),
    ('tournaments',                  'day_lead_player_id')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_lineup_shape;
ALTER TABLE public.tournament_matches DROP COLUMN IF EXISTS lineup;

NOTIFY pgrst, 'reload schema';
