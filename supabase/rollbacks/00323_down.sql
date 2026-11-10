-- ============================================================
-- ROLLBACK OF 00323: the unfinished-signup purge spares anybody who signed
--
-- Puts back 00233's purgeable_unfinished_signups, which does not test for a
-- signed waiver or event waiver. Run it only with the purge disarmed
-- (PURGE_UNFINISHED_ENABLED not 'true'), or the next armed run deletes a stub
-- that holds a signature, and the signature with it.
--
-- NEVER RUN AUTOMATICALLY. Not a migration: db-migrate.sh does not read this
-- directory, and nothing in CI or a deploy runs it. Run by hand with psql
-- against one database, after deciding to; afterwards record the rollback in
-- the migrations ledger, which still lists the migration as applied.
--
-- The view, its comment and its grants are restated verbatim from 00233.
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
  AND p.privilege_claim_review IS NULL;

COMMENT ON VIEW purgeable_unfinished_signups IS
  'Abandoned signup stubs eligible for outright DELETION: signed in (user_id) more than 30 days ago, never finished onboarding, and still carrying the empty first_name that ensure_player_for_user (00132) seeds and only onboarding ever fills. first_name = '''' is what distinguishes a stub from an exec pre-added roster row claimed at first sign-in, which matches the other arms with an arbitrarily old created_at. Excludes banned, deletion-pending, privileged and claim-review rows, and anybody who has played a match. Single source of truth for purge-unfinished-signups. Service role only.';

-- Same posture as purgeable_inactive_players (00064:106-110) and cron_config
-- (00061): the view names the rows that are about to be erased, which is not a
-- members'-app read. Only the service key, which is what the edge function
-- holds.
REVOKE ALL ON purgeable_unfinished_signups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON purgeable_unfinished_signups TO service_role;

NOTIFY pgrst, 'reload schema';
