-- ============================================================
-- 00333: RESULTS ARE POSTED, AND SOCIAL POSTS ARE READY
--
-- Two event-day changes that share a capability.
--
-- 1. THE TOP 4 IS ANNOUNCED (results_post). Finalizing an event posts one
--    short announcement, "<Event> results: 1st ..., 2nd ...", which the 00170
--    relay also posts to Discord, and sends the Marketing holders a notice
--    with the same lines to copy. event_results_posts keeps the one
--    announcement per event, so a re-finalize edits it rather than posting
--    a second.
--
-- 2. SOCIAL POSTS (social_posts). "Meet the teams", "New teams" and draw
--    slides for Instagram, rendered by the console on demand from ids only,
--    so a name always draws as it is now. event_social_post_sets is the list
--    of sets; an older full set is marked superseded rather than deleted.
--
-- THE CAPABILITY announcements.socialposts.read opens the Social posts page
-- and its images. It ends in .read, so every officer holds it through the
-- floor (EXEC_READS); who is NOTIFIED is narrower, the two marketing
-- portfolios seeded in 00237, by id (...204 Director, Social Media and
-- Marketing, and ...206 Coordinator, Marketing), and their label holders.
-- Granted with 00224's append pattern: the rows, then their holders, each
-- guarded so a re-run adds nothing. A revoke is left alone.
--
-- VOCABULARY: both CHECKs restated from 00293, the last file that defines
-- them, with the one string added beside announcements.discord.write.
--
-- No player FK in either table: the actor is the announcement's author or a
-- tournament_audit_log row, so merge_players_disposable is not restated.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

DO $pre$
BEGIN
  IF to_regclass('public.permission_baselines') IS NULL THEN
    RAISE EXCEPTION '00333 needs 00093: public.permission_baselines is missing';
  END IF;
  IF to_regclass('public.announcements') IS NULL THEN
    RAISE EXCEPTION '00333 needs public.announcements';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_permission_vocabulary_check') THEN
    RAISE EXCEPTION '00333 needs 00293: players_permission_vocabulary_check is missing';
  END IF;
END
$pre$;

-- ---- 1. THE CAPABILITY VOCABULARY -------------------------------------------
--
-- 00293's lists, copied verbatim, with `announcements.socialposts.read` added.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_vocabulary_check
  CHECK (
    (permission_grants || permission_revokes) <@ ARRAY[
    'players.page', 'players.read', 'players.approve.write',
    'players.create.write', 'players.update.write', 'players.waiver.resign.write',
    'players.ban.write', 'players.reinstate.write', 'players.editor.varsitynotes.write',
    'players.deletion.cancel.write', 'players.remove.write', 'players.merge.write',
    'players.reliability.write', 'players.privilegedfields.write', 'players.consoleaccess.write',
    'players.discordlink.write',
    'seasons.page', 'seasons.create.write', 'seasons.activate.write',
    'seasons.end.write', 'seasons.fees.write', 'sessions.page',
    'sessions.reminders.write', 'sessions.create.write', 'sessions.update.write',
    'sessions.archive.write', 'sessions.checkin.token.write', 'sessions.attendance.write',
    'sessions.delete.write', 'matches.page', 'matches.void.write',
    'matches.convert.write', 'matches.create.write', 'challenges.page',
    'challenges.create.write', 'challenges.expire.write', 'announcements.page',
    'announcements.create.write', 'announcements.update.write', 'announcements.delete.write',
    'announcements.discord.write', 'announcements.socialposts.read', 'tournaments.page', 'tournaments.manage.create.write',
    'tournaments.manage.update.write', 'tournaments.manage.status.write', 'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write', 'tournaments.manage.archive.write', 'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write', 'tournaments.draw.lock.write', 'tournaments.draw.unlock.write',
    'tournaments.draw.waivers.read', 'tournaments.draw.entrycounts.read', 'tournaments.results.enter.write',
    'tournaments.results.walkover.write', 'tournaments.results.void.write', 'tournaments.results.unvoid.write',
    'tournaments.results.undo.write', 'tournaments.results.edit.write', 'tournaments.results.entry.write',
    'tournaments.results.doublenoshow.write', 'tournaments.results.bonuses.write', 'tournaments.results.standings.write',
    'tournaments.results.finalize.write', 'tournaments.fees.read', 'tournaments.fees.tier.create.write',
    'tournaments.fees.tier.update.write', 'tournaments.fees.tier.delete.write', 'tournaments.fees.markpaid.write',
    'tournaments.fees.markunpaid.write', 'fees.page', 'fees.expenses.read',
    'fees.expenses.add.write', 'fees.expenses.update.write', 'fees.expenses.reimburse.write',
    'fees.expenses.remove.write', 'fees.otherincome.read', 'fees.otherincome.add.write',
    'fees.otherincome.remove.write', 'fees.clubfees.read', 'fees.clubfees.markpaid.write',
    'fees.clubfees.markunpaid.write', 'fees.clubfees.waive.write', 'fees.clubfees.addmanual.write',
    'fees.clubfees.removemanual.write', 'fees.reinstatements.read', 'fees.reinstatements.write',
    'fees.netposition.read', 'fees.playerflags.write', 'legal.page',
    'legal.reacceptance.write', 'legal.documents.write', 'legal.waivertemplate.write',
    'walkovers.page', 'walkovers.confirm.write', 'walkovers.reject.write',
    'disputes.page', 'disputes.resolve.write', 'permissions.page',
    'permissions.write', 'audit.page', 'ratings.page',
    'accounts.page', 'accounts.apikey.read', 'accounts.apikey.mint.write',
    'accounts.apikey.revoke.write', 'platform.page', 'platform.settings.write',
    'page.access.sessions', 'page.access.challenges', 'page.access.tournaments',
    'page.access.leaderboard', 'page.access.my_stats', 'page.access.announcements',
    'page.access.fees',
    'events.page', 'events.signups.read', 'events.signups.remove.write', 'events.signups.checkin.write',
    'events.manage.create.write', 'events.manage.update.write',
    'events.manage.cancel.write', 'events.manage.delete.write',
    'page.access.events',
    'page.access.membership', 'page.access.socials',
    'page.access.guest_waivers',
    'audit.export.read', 'audit.signins.read',
    'page.access.predictions',
    'changelog.page', 'changelog.post.write'
    ]::TEXT[]
  );

ALTER TABLE public.permission_baselines
  DROP CONSTRAINT IF EXISTS permission_baselines_vocabulary_check;
ALTER TABLE public.permission_baselines
  ADD CONSTRAINT permission_baselines_vocabulary_check
  CHECK (
    capabilities <@ ARRAY[
    'players.page', 'players.read', 'players.approve.write',
    'players.create.write', 'players.update.write', 'players.waiver.resign.write',
    'players.ban.write', 'players.reinstate.write', 'players.editor.varsitynotes.write',
    'players.deletion.cancel.write', 'players.remove.write', 'players.merge.write',
    'players.reliability.write', 'players.privilegedfields.write', 'players.consoleaccess.write',
    'players.discordlink.write',
    'seasons.page', 'seasons.create.write', 'seasons.activate.write',
    'seasons.end.write', 'seasons.fees.write', 'sessions.page',
    'sessions.reminders.write', 'sessions.create.write', 'sessions.update.write',
    'sessions.archive.write', 'sessions.checkin.token.write', 'sessions.attendance.write',
    'sessions.delete.write', 'matches.page', 'matches.void.write',
    'matches.convert.write', 'matches.create.write', 'challenges.page',
    'challenges.create.write', 'challenges.expire.write', 'announcements.page',
    'announcements.create.write', 'announcements.update.write', 'announcements.delete.write',
    'announcements.discord.write', 'announcements.socialposts.read', 'tournaments.page', 'tournaments.manage.create.write',
    'tournaments.manage.update.write', 'tournaments.manage.status.write', 'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write', 'tournaments.manage.archive.write', 'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write', 'tournaments.draw.lock.write', 'tournaments.draw.unlock.write',
    'tournaments.draw.waivers.read', 'tournaments.draw.entrycounts.read', 'tournaments.results.enter.write',
    'tournaments.results.walkover.write', 'tournaments.results.void.write', 'tournaments.results.unvoid.write',
    'tournaments.results.undo.write', 'tournaments.results.edit.write', 'tournaments.results.entry.write',
    'tournaments.results.doublenoshow.write', 'tournaments.results.bonuses.write', 'tournaments.results.standings.write',
    'tournaments.results.finalize.write', 'tournaments.fees.read', 'tournaments.fees.tier.create.write',
    'tournaments.fees.tier.update.write', 'tournaments.fees.tier.delete.write', 'tournaments.fees.markpaid.write',
    'tournaments.fees.markunpaid.write', 'fees.page', 'fees.expenses.read',
    'fees.expenses.add.write', 'fees.expenses.update.write', 'fees.expenses.reimburse.write',
    'fees.expenses.remove.write', 'fees.otherincome.read', 'fees.otherincome.add.write',
    'fees.otherincome.remove.write', 'fees.clubfees.read', 'fees.clubfees.markpaid.write',
    'fees.clubfees.markunpaid.write', 'fees.clubfees.waive.write', 'fees.clubfees.addmanual.write',
    'fees.clubfees.removemanual.write', 'fees.reinstatements.read', 'fees.reinstatements.write',
    'fees.netposition.read', 'fees.playerflags.write', 'legal.page',
    'legal.reacceptance.write', 'legal.documents.write', 'legal.waivertemplate.write',
    'walkovers.page', 'walkovers.confirm.write', 'walkovers.reject.write',
    'disputes.page', 'disputes.resolve.write', 'permissions.page',
    'permissions.write', 'audit.page', 'ratings.page',
    'accounts.page', 'accounts.apikey.read', 'accounts.apikey.mint.write',
    'accounts.apikey.revoke.write', 'platform.page', 'platform.settings.write',
    'page.access.sessions', 'page.access.challenges', 'page.access.tournaments',
    'page.access.leaderboard', 'page.access.my_stats', 'page.access.announcements',
    'page.access.fees',
    'events.page', 'events.signups.read', 'events.signups.remove.write', 'events.signups.checkin.write',
    'events.manage.create.write', 'events.manage.update.write',
    'events.manage.cancel.write', 'events.manage.delete.write',
    'page.access.events',
    'page.access.membership', 'page.access.socials',
    'page.access.guest_waivers',
    'audit.export.read', 'audit.signins.read',
    'page.access.predictions',
    'changelog.page', 'changelog.post.write'
    ]::TEXT[]
  );

-- ---- 2. THE TWO MARKETING PORTFOLIOS ----------------------------------------
--
-- By id, not by name: a renamed portfolio is still the same job.
UPDATE public.permission_baselines
   SET capabilities = capabilities || ARRAY['announcements.socialposts.read']::TEXT[]
 WHERE id IN ('5eed0060-0000-4000-8000-000000000204', '5eed0060-0000-4000-8000-000000000206')
   AND NOT (capabilities @> ARRAY['announcements.socialposts.read']::TEXT[]);

-- Their label holders: assigning a portfolio copies its capabilities onto the
-- row (00093), so widening the row alone would reach nobody.
UPDATE public.players p
   SET permission_grants = p.permission_grants || ARRAY['announcements.socialposts.read']::TEXT[]
 WHERE p.permission_baseline_id IN ('5eed0060-0000-4000-8000-000000000204', '5eed0060-0000-4000-8000-000000000206')
   AND NOT (p.permission_grants @> ARRAY['announcements.socialposts.read']::TEXT[]);

-- ---- 3. ONE RESULTS POST PER EVENT ------------------------------------------
--
-- `top` holds ids only, [{position, entry_id}], so a name is read when the
-- post is written and never kept here.
CREATE TABLE IF NOT EXISTS public.event_results_posts (
  event_id              uuid PRIMARY KEY REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  announcement_id       uuid REFERENCES public.announcements(id) ON DELETE SET NULL,
  top                   jsonb NOT NULL,
  posted_at             timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  marketing_notified_at timestamptz
);

COMMENT ON TABLE public.event_results_posts IS
  'The one results announcement per finalized event (00333). A re-finalize edits the same announcement.';

ALTER TABLE public.event_results_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.event_results_posts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_results_posts TO service_role;

-- ---- 4. SOCIAL POST SETS ----------------------------------------------------
--
-- teams_full: every team; teams_new: the teams one run added; draw: the
-- groups or the bracket. entry_ids are pair or participant ids, groups the
-- draw's shape in ids. A set's slides are rendered on demand.
CREATE TABLE IF NOT EXISTS public.event_social_post_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('teams_full', 'teams_new', 'draw')),
  entry_ids     uuid[] NOT NULL,
  groups        jsonb,
  caption       text NOT NULL,
  superseded_at timestamptz,
  notified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.event_social_post_sets IS
  'Slides for Instagram, as ids (00333). A newer full set supersedes the older one.';

CREATE INDEX IF NOT EXISTS event_social_post_sets_event
  ON public.event_social_post_sets (event_id, created_at DESC);

ALTER TABLE public.event_social_post_sets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.event_social_post_sets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_social_post_sets TO service_role;

-- ---- 5. VERIFY ---------------------------------------------------------------
DO $verify$
DECLARE
  v_bad   text[] := '{}';
  v_table text;
  r       RECORD;
BEGIN
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname IN ('players_permission_vocabulary_check', 'permission_baselines_vocabulary_check')
  LOOP
    IF position(quote_literal('announcements.socialposts.read') IN r.def) = 0 THEN
      v_bad := array_append(v_bad, format('%s does not admit announcements.socialposts.read', r.conname));
    END IF;
    IF position(quote_literal('events.signups.checkin.write') IN r.def) = 0 THEN
      v_bad := array_append(v_bad, format('%s lost events.signups.checkin.write', r.conname));
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.permission_baselines
              WHERE id IN ('5eed0060-0000-4000-8000-000000000204', '5eed0060-0000-4000-8000-000000000206')
                AND NOT (capabilities @> ARRAY['announcements.socialposts.read']::TEXT[])) THEN
    v_bad := array_append(v_bad, 'a marketing portfolio does not carry announcements.socialposts.read');
  END IF;

  FOREACH v_table IN ARRAY ARRAY['event_results_posts', 'event_social_post_sets'] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      v_bad := array_append(v_bad, v_table || ' is missing');
    ELSE
      IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_table)::regclass) THEN
        v_bad := array_append(v_bad, v_table || ' has RLS off');
      END IF;
      IF has_table_privilege('anon', 'public.' || v_table, 'SELECT')
         OR has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') THEN
        v_bad := array_append(v_bad, v_table || ' is readable by anon or authenticated');
      END IF;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, 'merge_players_unhandled() is not empty');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00333 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00333 verified: the capability, the two portfolios and both tables are in place.';
END
$verify$;

NOTIFY pgrst, 'reload schema';
