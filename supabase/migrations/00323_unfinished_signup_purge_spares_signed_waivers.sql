-- ============================================================
-- 00323: THE UNFINISHED-SIGNUP PURGE SPARES ANYBODY WHO SIGNED
--
-- purgeable_unfinished_signups (00233) names the abandoned signup stubs that
-- purge-unfinished-signups DELETES outright. Its header says a matching row
-- has "no name, no waiver, no matches", but only the name and the matches were
-- tested. Both acceptance tables reference players ON DELETE CASCADE (00010,
-- 00015), so a stub that held a signed waiver or event waiver would take the
-- signed record with it when the row is deleted. A signature is a record the
-- club keeps, so a row that holds one is never a stub to delete.
--
-- The view is restated whole from 00233, with the same columns in the same
-- order, plus two NOT EXISTS: no waiver_acceptances row and no
-- event_waiver_acceptances row for the player. Every other arm, and the
-- reasoning for each in 00233's header, is unchanged. A new file rather than
-- an edit to 00233, which is applied.
-- ============================================================

CREATE OR REPLACE VIEW purgeable_unfinished_signups AS
SELECT
  p.id,
  p.user_id,
  -- Returned so the job can log WHY without recomputing the cutoff, and
  -- because created_at is the whole clock here: nothing re-stamps it after the
  -- stub is inserted, so it is the moment of first sign-in.
  p.created_at
FROM players p
WHERE p.user_id IS NOT NULL
  AND p.onboarding_completed = FALSE
  -- READ THE HEADER BEFORE TOUCHING THIS LINE.
  AND p.first_name = ''
  AND p.created_at < NOW() - INTERVAL '30 days'
  -- A row that has appeared in a match is part of the record, never a stub.
  AND NOT EXISTS (
    SELECT 1 FROM match_participants mp WHERE mp.player_id = p.id
  )
  AND p.is_banned = FALSE
  AND p.deletion_requested_at IS NULL
  AND p.role = 'player'
  AND p.is_exec = FALSE
  AND p.is_trainer = FALSE
  AND p.privilege_claim_review IS NULL
  -- 00323: a signed waiver, of either kind, is a record the club keeps.
  AND NOT EXISTS (
    SELECT 1 FROM waiver_acceptances wa WHERE wa.player_id = p.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM event_waiver_acceptances ewa WHERE ewa.player_id = p.id
  );

COMMENT ON VIEW purgeable_unfinished_signups IS
  'Abandoned signup stubs eligible for outright DELETION: signed in (user_id) more than 30 days ago, never finished onboarding, and still carrying the empty first_name that ensure_player_for_user (00132) seeds and only onboarding ever fills. first_name = '''' is what distinguishes a stub from an exec pre-added roster row claimed at first sign-in, which matches the other arms with an arbitrarily old created_at. Excludes banned, deletion-pending, privileged and claim-review rows, anybody who has played a match, and anybody who has signed a waiver or an event waiver (00323). Single source of truth for purge-unfinished-signups. Service role only.';

-- Same posture as 00233: the view names the rows that are about to be erased,
-- so only the service key, which is what the edge function holds.
REVOKE ALL ON purgeable_unfinished_signups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON purgeable_unfinished_signups TO service_role;

DO $verify$
DECLARE
  v_def text := pg_get_viewdef('public.purgeable_unfinished_signups'::regclass);
BEGIN
  IF NOT has_table_privilege('service_role', 'public.purgeable_unfinished_signups', 'SELECT') THEN
    RAISE EXCEPTION '00323 verification failed: service_role cannot read purgeable_unfinished_signups';
  END IF;
  IF has_table_privilege('anon', 'public.purgeable_unfinished_signups', 'SELECT')
     OR has_table_privilege('authenticated', 'public.purgeable_unfinished_signups', 'SELECT') THEN
    RAISE EXCEPTION '00323 verification failed: anon or authenticated can read purgeable_unfinished_signups';
  END IF;
  IF v_def !~ '(^|[^_])waiver_acceptances wa\M' OR v_def !~ 'event_waiver_acceptances ewa\M' THEN
    RAISE EXCEPTION '00323 verification failed: the view does not exclude a player who signed a waiver';
  END IF;
  RAISE NOTICE '00323 verified: the unfinished-signup purge spares anybody who signed a waiver.';
END
$verify$;

-- PostgREST reaches the view through its schema cache; see 00233.
NOTIFY pgrst, 'reload schema';
