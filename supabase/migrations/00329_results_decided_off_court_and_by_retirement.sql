-- ============================================================
-- 00329: A RESULT DECIDED OFF COURT, AND A RESULT BY RETIREMENT
--
-- Two kinds of result the desk could only record as a walkover or a void:
--
-- 1. DECIDED OFF COURT. The two sides agreed a winner without playing (time
--    ran out, a coin, the organizers' call). The winner advances and takes the
--    win in the table; no scores are kept and nobody's rating moves.
-- 2. RETIRED. A side stopped part way through, injured. The partial games are
--    kept for the table and the display; the side still on court wins. Rated
--    the way a tournament walkover is: margin 1.0 and no per-game figures (the
--    console does that, not this file).
--
-- COLUMNS, NOT A STATUS. Both are status 'completed' with a winner and a loser
-- set. tournament_matches_status_check, the 00138 assert on it, the console's
-- tallied-status rule, finalize, the fingerprints and the Data API all key on
-- status, so a new status value would reach all of them. NULL result_kind is a
-- match played, which is every row that exists today.
--
-- THE SHAPE is a CHECK on the row, never on its status: a void keeps the kind
-- it was decided with (history), and a match that goes back to playable has
-- both columns cleared by tournament_matches_result_kind_reset, so no undo,
-- restore or SQL reset path has to know about them.
--
-- OFF COURT IS UNRATED in the database as well: a rating snapshot on such a
-- row is refused, as tournament_matches_external_unrated (00269, 00272) does
-- for an unrated event.
--
-- WHAT IS NOT RESTATED: set_field_entry_status, publish_stage_draw,
-- set_pair_member_check_in, fill_event_from_waitlist, enter_tournament_event,
-- add_participants_under_field_lock, join_event_waitlist, delete_stage_matches,
-- substitute_event_entry.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regclass('public.event_departures') IS NULL THEN
    RAISE EXCEPTION '00329 needs 00324: public.event_departures is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournament_matches'
                    AND column_name = 'lineup') THEN
    RAISE EXCEPTION '00329 needs 00327: tournament_matches.lineup is missing';
  END IF;
END
$pre$;

ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS result_kind text;
ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS retired_side text;

COMMENT ON COLUMN public.tournament_matches.result_kind IS
  'How a completed match was decided (00329): NULL played, off_court agreed without playing (unrated, no scores), retired a side stopped part way (partial scores kept).';
COMMENT ON COLUMN public.tournament_matches.retired_side IS
  'The side that retired, a or b, when result_kind is retired (00329).';

ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_result_kind_check;
ALTER TABLE public.tournament_matches ADD CONSTRAINT tournament_matches_result_kind_check
  CHECK (result_kind IS NULL OR result_kind IN ('off_court', 'retired'));

ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_retired_side_check;
ALTER TABLE public.tournament_matches ADD CONSTRAINT tournament_matches_retired_side_check
  CHECK (retired_side IS NULL OR retired_side IN ('a', 'b'));

ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_result_kind_shape;
ALTER TABLE public.tournament_matches ADD CONSTRAINT tournament_matches_result_kind_shape
  -- Every arm is false, never NULL, when result_kind is NULL: a CHECK that
  -- comes out NULL passes, which let a played match take a retired side.
  CHECK (
    (result_kind IS NULL AND retired_side IS NULL)
    OR (COALESCE(result_kind = 'off_court', false) AND retired_side IS NULL
        AND (scores IS NULL OR jsonb_array_length(scores) = 0))
    OR (COALESCE(result_kind = 'retired', false) AND retired_side IS NOT NULL)
  );

-- Back to playable is a result taken off, whichever path did it.
CREATE OR REPLACE FUNCTION public.tournament_matches_result_kind_reset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.result_kind := NULL;
  NEW.retired_side := NULL;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tournament_matches_result_kind_reset() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tournament_matches_result_kind_reset ON public.tournament_matches;
CREATE TRIGGER tournament_matches_result_kind_reset
  BEFORE UPDATE OF status ON public.tournament_matches
  FOR EACH ROW WHEN (NEW.status IN ('pending', 'ready', 'live') AND NEW.result_kind IS NOT NULL)
  EXECUTE FUNCTION public.tournament_matches_result_kind_reset();

-- Refusing the snapshot refuses the whole rating; the WHEN clause keeps the
-- reversal path (which sets it back to NULL) out of it.
CREATE OR REPLACE FUNCTION public.tournament_matches_off_court_unrated()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.result_kind = 'off_court' THEN
    RAISE EXCEPTION 'A result decided off court is unrated and cannot move anybody''s rating.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tournament_matches_off_court_unrated() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tournament_matches_off_court_unrated ON public.tournament_matches;
CREATE TRIGGER tournament_matches_off_court_unrated
  BEFORE UPDATE OF elo_snapshot ON public.tournament_matches
  FOR EACH ROW WHEN (NEW.elo_snapshot IS NOT NULL)
  EXECUTE FUNCTION public.tournament_matches_off_court_unrated();

DO $verify$
DECLARE
  v_bad text[] := '{}';
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tournament_matches'
         AND column_name IN ('result_kind', 'retired_side')) <> 2 THEN
    v_bad := array_append(v_bad, 'tournament_matches.result_kind or retired_side is missing');
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.tournament_matches'::regclass
         AND conname IN ('tournament_matches_result_kind_check', 'tournament_matches_retired_side_check',
                         'tournament_matches_result_kind_shape')) <> 3 THEN
    v_bad := array_append(v_bad, 'a result kind constraint is missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tournament_matches'::regclass
                    AND conname = 'tournament_matches_result_kind_shape'
                    AND pg_get_constraintdef(oid) LIKE '%COALESCE%') THEN
    v_bad := array_append(v_bad, 'tournament_matches_result_kind_shape lets a NULL result_kind take a retired side');
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.tournament_matches'::regclass AND NOT tgisinternal
         AND tgname IN ('tournament_matches_result_kind_reset', 'tournament_matches_off_court_unrated')) <> 2 THEN
    v_bad := array_append(v_bad, 'a result kind trigger is missing');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.tournament_matches'::regclass
                AND conname = 'tournament_matches_status_check'
                AND pg_get_constraintdef(oid) LIKE '%off_court%') THEN
    v_bad := array_append(v_bad, 'tournament_matches_status_check was changed');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00329 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00329 verified: result_kind, retired_side, their shape and the two triggers are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
