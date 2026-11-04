-- ============================================================
-- 00320: LAST SEEN IS THE LAST VISIT
--
-- The console's "Last seen" column read players.last_active_at, which moves
-- only on a session check-in, a reactivation and a few profile writes. For most
-- members that is the day they signed up, so the column said nothing about
-- whether they still open the app. last_active_at drives the inactivity clock
-- (00062) and keeps that meaning; this file adds a second column for the visit.
--
-- WHAT IS ADDED
--   1. players.last_seen_at: when the member last loaded a page of either app.
--   2. touch_last_seen(): the signed-in caller stamps their own row. No
--      parameters, the player is resolved from auth.uid(), and it writes only
--      when the stamp is missing or older than fifteen minutes, so a page load
--      costs one indexed UPDATE that usually matches nothing.
--   3. possible_duplicate_dismissals: an officer's "these two are not the same
--      person", so the console's duplicate check stops showing that pair.
--
-- THE PRIVILEGED-COLUMN GUARD IS LEFT UNCHANGED, and this is its answer for
-- last_seen_at (the 2026-08-20 audit rule: an answer, never an omission). It is
-- NOT in the guard. touch_last_seen writes it as the owner with the member's
-- auth.uid() set, so the guard's UPDATE arm runs, and listing the column would
-- refuse every member's own touch. It grants no access and decides nothing:
-- the inactivity clock reads last_active_at. It gets no column UPDATE grant
-- (00182 stays at twelve) and no SELECT grant, so a member cannot write a time
-- of their choosing; the only writer on their session is the function.
--
-- updated_at MOVES ON EVERY TOUCH. set_updated_at (00004) fires on any UPDATE
-- of players, so a visit now bumps updated_at at most every fifteen minutes,
-- and the backfill below bumps it once for every linked row.
--
-- MERGES. last_seen_at is not a foreign key, so merge_players_unhandled() is
-- unaffected; the survivor keeps its own value and the next visit restamps it.
-- The dismissal table's three player columns are disposable: player_a and
-- player_b cascade (a merged pair is no longer a pair), dismissed_by is set
-- NULL. merge_players_disposable is restated from 00311 with the three rows.
--
-- DELETION. last_seen_at is activity, not identity, like last_active_at, so the
-- purge's IDENTITY_COLUMNS (supabase/functions/_shared/anonymize.ts) do not
-- name it.
--
-- BACKFILL. A linked row starts at the later of last_active_at and the auth
-- user's last sign-in; an unlinked row (a guest, a pre-added record) stays
-- NULL, and the console falls back to last_active_at.
--
-- PRECONDITIONS: 00311 (merge_players_disposable's latest definition), 00207
-- (merge_players_unhandled covers every delete action).
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'club_event_external_signups' AND col = 'preferred_partner_player_id') THEN
    RAISE EXCEPTION '00320 needs 00311: merge_players_disposable does not have club_event_external_signups.preferred_partner_player_id';
  END IF;
  IF to_regprocedure('public.merge_players_unhandled()') IS NULL THEN
    RAISE EXCEPTION '00320 needs 00207: public.merge_players_unhandled() is missing';
  END IF;
END
$pre$;

-- ---- the column ---------------------------------------------------------------

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

COMMENT ON COLUMN public.players.last_seen_at IS
  'When the member last loaded a page of the player app or the console, at most fifteen minutes stale. Written only by touch_last_seen(). Display only: the inactivity clock reads last_active_at (00062). Not in the privileged-column guard, no member grant: see 00320.';

UPDATE public.players p
   SET last_seen_at = GREATEST(p.last_active_at, u.last_sign_in_at)
  FROM auth.users u
 WHERE u.id = p.user_id
   AND p.last_seen_at IS NULL;

-- ---- the touch ----------------------------------------------------------------
-- Takes no player id: it resolves the caller from auth.uid(). A signed-out
-- caller, or a session with no player row yet, touches nothing.
CREATE OR REPLACE FUNCTION public.touch_last_seen()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.players
     SET last_seen_at = now()
   WHERE user_id = auth.uid()
     AND (last_seen_at IS NULL OR last_seen_at < now() - interval '15 minutes');
END;
$function$;

REVOKE ALL ON FUNCTION public.touch_last_seen() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_last_seen() TO authenticated;

-- ---- the dismissals -----------------------------------------------------------
-- One row per pair an officer said are two people. The pair is stored ordered
-- (player_a < player_b), so the primary key holds it once whichever way round
-- it was dismissed. Who dismissed it is a player column that would block
-- merges if it were NO ACTION, so it is SET NULL; who did it also goes in
-- audit_logs.
CREATE TABLE IF NOT EXISTS public.possible_duplicate_dismissals (
  player_a     uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  player_b     uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  dismissed_by uuid REFERENCES public.players(id) ON DELETE SET NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_a, player_b),
  CONSTRAINT possible_duplicate_dismissals_ordered CHECK (player_a < player_b)
);

COMMENT ON TABLE public.possible_duplicate_dismissals IS
  'Pairs of player records an officer said are two different people, so the console stops offering them as possible duplicates. Ordered pair (player_a < player_b). Service role only. See 00320.';

ALTER TABLE public.possible_duplicate_dismissals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.possible_duplicate_dismissals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.possible_duplicate_dismissals TO service_role;

-- ---- MERGES -------------------------------------------------------------------
-- The rows from 00311, and the three dismissal columns this file adds.
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

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_src text := pg_get_functiondef('public.touch_last_seen()'::regprocedure);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'players'
                    AND column_name = 'last_seen_at') THEN
    v_bad := array_append(v_bad, 'players.last_seen_at is missing');
  END IF;
  IF has_column_privilege('authenticated', 'public.players', 'last_seen_at', 'UPDATE')
     OR has_column_privilege('anon', 'public.players', 'last_seen_at', 'UPDATE') THEN
    v_bad := array_append(v_bad, 'players.last_seen_at is writable by a client role');
  END IF;

  IF position('auth.uid()' IN v_src) = 0 OR position('15 minutes' IN v_src) = 0 THEN
    v_bad := array_append(v_bad, 'touch_last_seen does not resolve the caller or throttle the write');
  END IF;
  IF has_function_privilege('anon', 'public.touch_last_seen()', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'touch_last_seen is executable by anon');
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.touch_last_seen()', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'touch_last_seen is not executable by authenticated');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.possible_duplicate_dismissals'::regclass AND relrowsecurity) THEN
    v_bad := array_append(v_bad, 'possible_duplicate_dismissals has row level security off');
  END IF;
  IF has_table_privilege('anon', 'public.possible_duplicate_dismissals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.possible_duplicate_dismissals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.possible_duplicate_dismissals', 'INSERT') THEN
    v_bad := array_append(v_bad, 'possible_duplicate_dismissals is reachable beyond the service role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'possible_duplicate_dismissals_ordered'
                    AND conrelid = 'public.possible_duplicate_dismissals'::regclass
                    AND contype = 'c') THEN
    v_bad := array_append(v_bad, 'possible_duplicate_dismissals_ordered is missing');
  END IF;

  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()
       WHERE tbl = 'possible_duplicate_dismissals') <> 3 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is missing a dismissal column');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'club_event_external_signups' AND col = 'preferred_partner_player_id') THEN
    v_bad := array_append(v_bad, 'merge_players_disposable lost club_event_external_signups.preferred_partner_player_id');
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 34 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the thirty-four rows');
  END IF;
  IF has_function_privilege('anon', 'public.merge_players_disposable()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.merge_players_disposable()', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is executable by anon or authenticated');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00320 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00320 verified: last_seen_at, touch_last_seen, the dismissals table and the merge rows are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
