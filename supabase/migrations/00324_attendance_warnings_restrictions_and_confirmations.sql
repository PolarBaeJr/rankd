-- ============================================================
-- 00324: ATTENDANCE WARNINGS, ENTRY RESTRICTIONS AND CONFIRMATIONS
--
-- The club's event standard: a member confirms their place before the day, a
-- no-show or leaving without telling the desk is a warning on their record,
-- and an exec can restrict a member from entering events. This file holds the
-- tables those need. The functions that use them are 00325 (the
-- confirmation) and 00326 (the release at check-in close); the console and the
-- member app write the rest, each behind its own release kill switch
-- (packages/shared/src/utils/release-flags.ts). No function here asks one.
--
-- WHAT IS ADDED
--   1. attendance_warnings: one row per warning. kind is what happened, source
--      is where it was recorded (check-in close, Did not come, the desk). A
--      warning is rescinded, never deleted, so the record of the undo stays.
--      One ACTIVE warning per member, event and kind: a second press of the
--      same button writes nothing.
--   2. event_entry_restrictions: an exec's "may not enter events until". NULL
--      ends_at is until an exec lifts it. Lifted, never deleted.
--   3. tournament_event_confirmations: one row per member asked to confirm
--      their place, with the mail's claim and receipt columns copied from the
--      registration mail (00283). participant_id or pair_id names the entry,
--      deliberately with no foreign key: a released entry is withdrawn, not
--      deleted, and a deleted event cascades from event_id.
--   4. tournament_events.confirm_required and the two hours, defaulting to the
--      club's 48 and 24.
--   5. tournaments.day_lead_player_id: the one exec who makes the calls on the
--      day. Display only. A SECOND foreign key from tournaments to players, so
--      every embed between the two now names its constraint.
--   6. event_departures: a member who left mid-event, marked by the desk or by
--      a court helper, always with a reason. Only "left without telling
--      anyone" carries a warning, and warning_id points at it; every other
--      reason is on record with none.
--
-- SERVICE ROLE ONLY. All four tables have row level security on and no
-- policy, and no client role is granted anything: the member app reads a
-- member's own rows through the service client, filtered by their id.
--
-- MERGES. Ten new player columns, all disposable: the member's own rows
-- cascade, the officer columns are SET NULL, and day_lead_player_id is SET
-- NULL. The console moves warnings, restrictions and departures to the
-- survivor before it merges. merge_players_disposable is restated from 00320
-- with the ten rows.
--
-- PRECONDITIONS: 00320 (merge_players_disposable's latest definition), 00207
-- (merge_players_unhandled), 00318 (release_flag_on), 00304
-- (tournaments.starts_time).
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'possible_duplicate_dismissals' AND col = 'player_a') THEN
    RAISE EXCEPTION '00324 needs 00320: merge_players_disposable does not have possible_duplicate_dismissals.player_a';
  END IF;
  IF to_regprocedure('public.merge_players_unhandled()') IS NULL THEN
    RAISE EXCEPTION '00324 needs 00207: public.merge_players_unhandled() is missing';
  END IF;
  IF to_regprocedure('public.release_flag_on(text)') IS NULL THEN
    RAISE EXCEPTION '00324 needs 00318: public.release_flag_on(text) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournaments'
                    AND column_name = 'starts_time') THEN
    RAISE EXCEPTION '00324 needs 00304: tournaments.starts_time is missing';
  END IF;
END
$pre$;

-- ---- attendance_warnings ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attendance_warnings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  tournament_id  uuid REFERENCES public.tournaments(id) ON DELETE SET NULL,
  event_id       uuid REFERENCES public.tournament_events(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('no_show', 'left_without_notice')),
  source         text NOT NULL CHECK (source IN ('checkin_close', 'did_not_come', 'desk', 'court_helper')),
  note           text CHECK (note IS NULL OR char_length(note) <= 500),
  issued_by      uuid REFERENCES public.players(id) ON DELETE SET NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  rescinded_at   timestamptz,
  rescinded_by   uuid REFERENCES public.players(id) ON DELETE SET NULL,
  rescind_reason text CHECK (rescind_reason IS NULL OR char_length(rescind_reason) <= 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_warnings_one_active
  ON public.attendance_warnings (player_id, event_id, kind)
  WHERE rescinded_at IS NULL AND event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attendance_warnings_player
  ON public.attendance_warnings (player_id, issued_at DESC);

COMMENT ON TABLE public.attendance_warnings IS
  'A warning on a member for a no-show or leaving an event without telling the desk. Rescinded, never deleted. One active warning per member, event and kind. Service role only. See 00324.';

ALTER TABLE public.attendance_warnings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_warnings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.attendance_warnings TO service_role;

-- ---- event_entry_restrictions -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_entry_restrictions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id  uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  reason     text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  starts_at  timestamptz NOT NULL DEFAULT now(),
  ends_at    timestamptz,
  created_by uuid REFERENCES public.players(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz,
  lifted_by  uuid REFERENCES public.players(id) ON DELETE SET NULL,
  CONSTRAINT event_entry_restrictions_ends_after_start CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS event_entry_restrictions_active
  ON public.event_entry_restrictions (player_id) WHERE lifted_at IS NULL;

COMMENT ON TABLE public.event_entry_restrictions IS
  'An exec''s restriction on a member entering events themselves, until ends_at or until lifted. Covers the member''s own entry and waitlist joins, never an exec''s add. Service role only. See 00324.';

ALTER TABLE public.event_entry_restrictions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_entry_restrictions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.event_entry_restrictions TO service_role;

-- ---- tournament_event_confirmations -------------------------------------------
-- confirmed_by has no foreign key on purpose: it is the member themselves or
-- the desk, and it is attribution, not a link a merge has to follow.
CREATE TABLE IF NOT EXISTS public.tournament_event_confirmations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  player_id          uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  participant_id     uuid,
  pair_id            uuid,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'confirmed', 'released', 'unreached', 'void')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  notified_at        timestamptz,
  email_attempted_at timestamptz,
  email_attempts     integer NOT NULL DEFAULT 0,
  email_sent_at      timestamptz,
  email_outcome      text CHECK (email_outcome IN ('sent', 'suppressed', 'failed')),
  email_error        text,
  confirmed_at       timestamptz,
  confirmed_by       uuid,
  resolved_at        timestamptz,
  CONSTRAINT tournament_event_confirmations_one_entry CHECK ((participant_id IS NULL) <> (pair_id IS NULL)),
  UNIQUE (event_id, player_id)
);

CREATE INDEX IF NOT EXISTS tournament_event_confirmations_pending
  ON public.tournament_event_confirmations (event_id) WHERE status = 'pending';

COMMENT ON TABLE public.tournament_event_confirmations IS
  'A member asked to confirm their place in an event before the day: the request, its email claim and receipt, and how it ended. One row per member per event; a pair has one per partner. Service role only. See 00324 and 00325.';

ALTER TABLE public.tournament_event_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_event_confirmations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tournament_event_confirmations TO service_role;

-- ---- event_departures -------------------------------------------------------
-- participant_id or pair_id names the entry with no foreign key, as in the
-- confirmations above. One departure per member per event: a second press is
-- the same departure.
CREATE TABLE IF NOT EXISTS public.event_departures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  player_id      uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  participant_id uuid,
  pair_id        uuid,
  reason         text NOT NULL
                   CHECK (reason IN ('injury', 'told_organizers', 'emergency', 'other', 'without_notice')),
  note           text CHECK (note IS NULL OR char_length(note) <= 500),
  marked_by      uuid REFERENCES public.players(id) ON DELETE SET NULL,
  marked_as      text NOT NULL CHECK (marked_as IN ('desk', 'court_helper')),
  marked_at      timestamptz NOT NULL DEFAULT now(),
  warning_id     uuid REFERENCES public.attendance_warnings(id) ON DELETE SET NULL,
  CONSTRAINT event_departures_one_entry CHECK ((participant_id IS NULL) <> (pair_id IS NULL)),
  UNIQUE (event_id, player_id)
);

-- "other" needs a note, as parseDeparture (departure-reasons.ts) requires. A
-- missing note has to fail the check, not make it NULL, which a CHECK lets
-- through. Outside the CREATE so a rerun over an existing table restates it.
ALTER TABLE public.event_departures DROP CONSTRAINT IF EXISTS event_departures_other_has_note;
ALTER TABLE public.event_departures ADD CONSTRAINT event_departures_other_has_note
  CHECK (reason <> 'other' OR COALESCE(char_length(btrim(note)), 0) > 0);

CREATE INDEX IF NOT EXISTS event_departures_player
  ON public.event_departures (player_id, marked_at DESC);

COMMENT ON TABLE public.event_departures IS
  'A member who left an event part way through, with the reason the desk or a court helper chose. Only without_notice carries a warning (warning_id). Service role only. See 00324.';

ALTER TABLE public.event_departures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_departures FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.event_departures TO service_role;

-- ---- the event's confirmation settings ----------------------------------------
ALTER TABLE public.tournament_events
  ADD COLUMN IF NOT EXISTS confirm_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirm_opens_hours smallint NOT NULL DEFAULT 48,
  ADD COLUMN IF NOT EXISTS confirm_deadline_hours smallint NOT NULL DEFAULT 24;

ALTER TABLE public.tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_confirm_window;
ALTER TABLE public.tournament_events
  ADD CONSTRAINT tournament_events_confirm_window
  CHECK (confirm_deadline_hours >= 1 AND confirm_opens_hours <= 336 AND confirm_deadline_hours < confirm_opens_hours);

-- ---- the day lead -------------------------------------------------------------
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS day_lead_player_id uuid REFERENCES public.players(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tournaments.day_lead_player_id IS
  'The exec who makes the calls on the day. Display only. A second foreign key to players: embeds name tournaments_created_by_fkey or tournaments_day_lead_player_id_fkey. See 00324.';

-- ---- MERGES -------------------------------------------------------------------
-- The rows from 00320, and the ten player columns this file adds.
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

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad   text[] := '{}';
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['attendance_warnings', 'event_entry_restrictions', 'tournament_event_confirmations', 'event_departures'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
                    WHERE oid = format('public.%I', v_table)::regclass AND relrowsecurity) THEN
      v_bad := array_append(v_bad, format('%s has row level security off', v_table));
    END IF;
    IF has_table_privilege('anon', format('public.%I', v_table), 'SELECT')
       OR has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
       OR has_table_privilege('authenticated', format('public.%I', v_table), 'INSERT') THEN
      v_bad := array_append(v_bad, format('%s is reachable beyond the service role', v_table));
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tournament_events_confirm_window'
                    AND conrelid = 'public.tournament_events'::regclass
                    AND contype = 'c') THEN
    v_bad := array_append(v_bad, 'tournament_events_confirm_window is missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'event_departures_other_has_note'
                    AND conrelid = 'public.event_departures'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%COALESCE%') THEN
    v_bad := array_append(v_bad, 'event_departures_other_has_note is missing or lets a missing note through');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournaments'
                    AND column_name = 'day_lead_player_id') THEN
    v_bad := array_append(v_bad, 'tournaments.day_lead_player_id is missing');
  END IF;

  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 44 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the forty-four rows');
  END IF;
  IF has_function_privilege('anon', 'public.merge_players_disposable()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.merge_players_disposable()', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is executable by anon or authenticated');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00324 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00324 verified: the warnings, restrictions, confirmations and departures tables, the event settings, the day lead and the merge rows are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
