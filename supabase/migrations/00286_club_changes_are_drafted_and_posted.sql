-- ============================================================
-- 00286 CLUB CHANGES ARE DRAFTED AND POSTED
--
-- The owner's request: when an officer changes a rating setting, an account
-- rule, a member page switch, a club link or an officer role, the console
-- should write a plain-language line about it, let the lines pile up, and let
-- an admin post one line or the whole bundle to members at once.
--
-- WHAT IS ADDED
--   1. public.club_change_drafts: the pending lines. One per setting field or
--      officer role (the partial unique index), plus any number typed by hand.
--   2. public.club_change_entries: what was posted, with the text frozen.
--   3. Two AFTER row triggers, on platform_settings and permission_baselines,
--      that write the drafts. A trigger rather than a hook in the server
--      actions because rating_defaults has two writers (the /ratings form and
--      the exec's repeat challenge card on /matches) and a trigger sees both,
--      and any writer added later.
--   4. post_club_changes: posts a bundle and deletes its drafts in one
--      transaction, and writes its own audit row.
--   5. The capability vocabulary admits `changelog.page` and
--      `changelog.post.write` (145 to 147). Both are admin-only by level and
--      in no baseline.
--
-- WHAT THE TRIGGERS STORE. A structured diff, not text: source, subject (the
-- setting key or the baseline id), field, from_value and to_value. The console
-- turns that into a sentence when it reads it (apps/admin/src/lib/
-- club-change-format.ts), and posting freezes the sentence into the entry, so
-- a later label change never rewrites what members were told.
--
-- COALESCING. A second edit to the same field moves only to_value, so the line
-- always runs from the value before the first edit to the value after the
-- last. An edit back to where it started deletes the line. jsonb compares
-- numbers by value, so 24 and 24.0 are the same value here.
--
-- WHICH WRITES ARE RECORDED. Only an app request: one that came through the
-- API with JWT claims set (request.jwt.claims), named an updated_by, and moved
-- updated_at. A migration, a restore or a hand-written psql UPDATE sets no
-- claims and records nothing, even on a row an officer saved earlier whose
-- updated_by is still filled in. A baseline DELETE carries no updated_by, so
-- for it the claims alone decide.
--
-- PER-PERSON PERMISSION CHANGES ARE NOT DRAFTED. players.permission_* would
-- publish who was given what access. Only the role definitions are.
--
-- NO FOREIGN KEY ON THE ATTRIBUTION COLUMNS. first_actor_id, last_actor_id and
-- posted_by are plain uuids. A foreign key to players would block every member
-- merge until merge_players_disposable learned it, and that function is
-- restated by other migrations in flight. The audit_logs row keeps the real
-- actor with its own foreign key.
--
-- WHO READS THEM. Both tables are closed to anon and authenticated, with RLS on
-- and no policy. The console reads and writes them with the service role, and
-- the members' What's new page reads posted entries with the service role,
-- for signed-in approved members only.
--
-- ORDER. Apply after 00285. This file restates both vocabulary CHECKs from
-- 00282, the last file that defines them; if a migration between 00282 and
-- this one restates them too, copy from that one instead.
-- ============================================================

BEGIN;

-- ---- 1. THE TABLES --------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.club_change_drafts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'setting': a platform_settings field. 'baseline': an officer role.
  -- 'manual': a line an admin typed.
  source             TEXT NOT NULL CHECK (source IN ('setting', 'baseline', 'manual')),
  subject            TEXT,
  field              TEXT,
  from_value         JSONB,
  to_value           JSONB,
  -- The admin's own wording. Required for a manual line, optional otherwise.
  text_override      TEXT CHECK (char_length(btrim(text_override)) BETWEEN 1 AND 300),
  -- The to_value the admin was looking at when they reworded the line. When a
  -- later edit moves to_value away from it, the wording is stale.
  override_to_value  JSONB,
  -- Plain uuids, see the header.
  first_actor_id     UUID,
  last_actor_id      UUID,
  -- Bumped on every change to the line, by the trigger or a rewording. The
  -- console sends back the revision it showed, and posting refuses a line
  -- that moved since.
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT club_change_drafts_manual_has_no_subject
    CHECK ((source = 'manual') = (subject IS NULL AND field IS NULL)),
  CONSTRAINT club_change_drafts_manual_has_text
    CHECK (source <> 'manual' OR text_override IS NOT NULL)
);

-- One pending line per setting field or officer role. Manual lines repeat.
CREATE UNIQUE INDEX IF NOT EXISTS club_change_drafts_one_pending
  ON public.club_change_drafts (source, subject, field)
  WHERE source <> 'manual';

CREATE TABLE IF NOT EXISTS public.club_change_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 120),
  intro            TEXT CHECK (intro IS NULL OR char_length(btrim(intro)) BETWEEN 1 AND 1000),
  -- An array of strings, frozen at posting.
  lines            JSONB NOT NULL CHECK (
                     jsonb_typeof(lines) = 'array'
                     AND jsonb_array_length(lines) BETWEEN 1 AND 100
                   ),
  posted_by        UUID,
  posted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the entry also went out as a club announcement.
  announcement_id  UUID REFERENCES public.announcements(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS club_change_entries_posted_at
  ON public.club_change_entries (posted_at DESC);

ALTER TABLE public.club_change_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_change_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.club_change_drafts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.club_change_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.club_change_drafts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.club_change_entries TO service_role;

-- ---- 2. THE TRIGGERS ------------------------------------------------------
--
-- A trigger runs inside the officer's own save, so an error here aborts the
-- save. The bodies are kept plain on purpose, and supabase/tests/00286 covers
-- each path.

-- One draft line, created or moved. Never touches from_value or the wording.
CREATE OR REPLACE FUNCTION public.club_change_upsert(
  p_source  TEXT,
  p_subject TEXT,
  p_field   TEXT,
  p_from    JSONB,
  p_to      JSONB,
  p_actor   UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.club_change_drafts
    (source, subject, field, from_value, to_value, first_actor_id, last_actor_id)
  VALUES (p_source, p_subject, p_field, p_from, p_to, p_actor, p_actor)
  ON CONFLICT (source, subject, field) WHERE source <> 'manual'
  DO UPDATE SET
    to_value      = EXCLUDED.to_value,
    last_actor_id = EXCLUDED.last_actor_id,
    revision      = public.club_change_drafts.revision + 1,
    changed_at    = now();

  -- Back where it started: nothing to tell anyone.
  DELETE FROM public.club_change_drafts
   WHERE source = p_source AND subject = p_subject AND field = p_field
     AND from_value IS NOT DISTINCT FROM to_value;
END;
$function$;

-- True only inside an API request, never in a migration or a psql session.
CREATE OR REPLACE FUNCTION public.club_change_is_app_write()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT coalesce(current_setting('request.jwt.claims', true), '') NOT IN ('', '{}');
$function$;

CREATE OR REPLACE FUNCTION public.club_change_from_platform_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old   JSONB;
  v_field TEXT;
BEGIN
  IF NEW.updated_by IS NULL
     OR NOT public.club_change_is_app_write()
     OR (TG_OP = 'UPDATE' AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) THEN
    RETURN NULL;
  END IF;

  v_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.value END;

  IF jsonb_typeof(NEW.value) = 'object'
     AND (v_old IS NULL OR jsonb_typeof(v_old) = 'object') THEN
    FOR v_field IN
      SELECT k FROM jsonb_object_keys(NEW.value) AS k
      UNION
      SELECT k FROM jsonb_object_keys(coalesce(v_old, '{}'::jsonb)) AS k
    LOOP
      IF (v_old -> v_field) IS DISTINCT FROM (NEW.value -> v_field) THEN
        PERFORM public.club_change_upsert(
          'setting', NEW.key, v_field, v_old -> v_field, NEW.value -> v_field, NEW.updated_by);
      END IF;
    END LOOP;
  ELSIF v_old IS DISTINCT FROM NEW.value THEN
    PERFORM public.club_change_upsert('setting', NEW.key, '*', v_old, NEW.value, NEW.updated_by);
  END IF;

  RETURN NULL;
END;
$function$;

-- A role definition as one comparable value: its name and its capabilities,
-- sorted and de-duplicated, so reordering the list is not a change.
CREATE OR REPLACE FUNCTION public.club_change_baseline_value(p_name TEXT, p_capabilities TEXT[])
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'name', p_name,
    'capabilities', to_jsonb(ARRAY(SELECT DISTINCT c FROM unnest(p_capabilities) AS c ORDER BY c)));
$function$;

CREATE OR REPLACE FUNCTION public.club_change_from_permission_baselines()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.club_change_is_app_write() THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.club_change_upsert(
      'baseline', OLD.id::text, 'definition',
      public.club_change_baseline_value(OLD.name, OLD.capabilities), NULL, NULL);
    RETURN NULL;
  END IF;

  IF NEW.updated_by IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) THEN
    RETURN NULL;
  END IF;

  PERFORM public.club_change_upsert(
    'baseline', NEW.id::text, 'definition',
    CASE WHEN TG_OP = 'INSERT' THEN NULL
         ELSE public.club_change_baseline_value(OLD.name, OLD.capabilities) END,
    public.club_change_baseline_value(NEW.name, NEW.capabilities),
    NEW.updated_by);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS club_change_from_platform_settings ON public.platform_settings;
CREATE TRIGGER club_change_from_platform_settings
  AFTER INSERT OR UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.club_change_from_platform_settings();

DROP TRIGGER IF EXISTS club_change_from_permission_baselines ON public.permission_baselines;
CREATE TRIGGER club_change_from_permission_baselines
  AFTER INSERT OR UPDATE OR DELETE ON public.permission_baselines
  FOR EACH ROW EXECUTE FUNCTION public.club_change_from_permission_baselines();

REVOKE ALL ON FUNCTION public.club_change_upsert(TEXT, TEXT, TEXT, JSONB, JSONB, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_change_is_app_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_change_baseline_value(TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_change_from_platform_settings() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_change_from_permission_baselines() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_change_upsert(TEXT, TEXT, TEXT, JSONB, JSONB, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_change_is_app_write() TO service_role;
GRANT EXECUTE ON FUNCTION public.club_change_baseline_value(TEXT, TEXT[]) TO service_role;

-- ---- 3. POSTING -----------------------------------------------------------
--
-- The console formats the lines on the server from the drafts it just read,
-- and sends the revision of each one it showed the admin. Every draft is
-- locked, and the whole post is refused if one is gone or has moved, so what
-- is posted is what the admin saw. The no-op drafts (a first save that only
-- wrote the defaults) are deleted alongside, but only while they are still at
-- the revision the console judged.
--
-- The error messages start with a stable prefix the console maps to a
-- sentence: stale_missing, stale_changed, bad_lines.
CREATE OR REPLACE FUNCTION public.post_club_changes(
  p_actor            UUID,
  p_draft_ids        UUID[],
  p_revisions        INTEGER[],
  p_lines            TEXT[],
  p_discard_ids      UUID[],
  p_discard_revisions INTEGER[],
  p_title            TEXT,
  p_intro            TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_count    INTEGER;
  v_entry_id UUID;
  v_line     TEXT;
  v_lines    TEXT[] := ARRAY[]::TEXT[];
  v_title    TEXT := nullif(btrim(coalesce(p_title, '')), '');
  v_intro    TEXT := nullif(btrim(coalesce(p_intro, '')), '');
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'bad_lines: no actor';
  END IF;
  IF coalesce(cardinality(p_draft_ids), 0) < 1
     OR cardinality(p_draft_ids) > 100
     OR cardinality(p_draft_ids) <> coalesce(cardinality(p_revisions), 0)
     OR cardinality(p_draft_ids) <> coalesce(cardinality(p_lines), 0)
     OR (SELECT count(DISTINCT d) FROM unnest(p_draft_ids) AS d) <> cardinality(p_draft_ids)
     OR coalesce(cardinality(p_discard_ids), 0) <> coalesce(cardinality(p_discard_revisions), 0) THEN
    RAISE EXCEPTION 'bad_lines: the lines and the drafts do not match';
  END IF;

  FOREACH v_line IN ARRAY p_lines LOOP
    v_line := btrim(coalesce(v_line, ''));
    IF char_length(v_line) NOT BETWEEN 1 AND 300 THEN
      RAISE EXCEPTION 'bad_lines: a line is empty or longer than 300 characters';
    END IF;
    v_lines := array_append(v_lines, v_line);
  END LOOP;

  PERFORM 1 FROM public.club_change_drafts
   WHERE id = ANY (p_draft_ids || coalesce(p_discard_ids, ARRAY[]::UUID[]))
   ORDER BY id
   FOR UPDATE;

  SELECT count(*) INTO v_count FROM public.club_change_drafts WHERE id = ANY (p_draft_ids);
  IF v_count <> cardinality(p_draft_ids) THEN
    RAISE EXCEPTION 'stale_missing: a line was posted or deleted since the page loaded';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(p_draft_ids, p_revisions) AS seen(id, revision)
      JOIN public.club_change_drafts d ON d.id = seen.id
     WHERE d.revision <> seen.revision
  ) THEN
    RAISE EXCEPTION 'stale_changed: a line changed since the page loaded';
  END IF;

  INSERT INTO public.club_change_entries (title, intro, lines, posted_by)
  VALUES (v_title, v_intro, to_jsonb(v_lines), p_actor)
  RETURNING id INTO v_entry_id;

  DELETE FROM public.club_change_drafts WHERE id = ANY (p_draft_ids);

  IF coalesce(cardinality(p_discard_ids), 0) > 0 THEN
    DELETE FROM public.club_change_drafts d
     USING unnest(p_discard_ids, p_discard_revisions) AS seen(id, revision)
     WHERE d.id = seen.id AND d.revision = seen.revision;
  END IF;

  INSERT INTO public.audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (p_actor, 'club_changes_posted', 'club_change_entry', v_entry_id,
          jsonb_build_object('title', v_title, 'intro', v_intro, 'lines', to_jsonb(v_lines),
                             'draft_count', cardinality(p_draft_ids)),
          format('Club changes posted: %s line(s)', cardinality(v_lines)));

  RETURN v_entry_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_club_changes(UUID, UUID[], INTEGER[], TEXT[], UUID[], INTEGER[], TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_club_changes(UUID, UUID[], INTEGER[], TEXT[], UUID[], INTEGER[], TEXT, TEXT)
  TO service_role;

-- ---- 4. THE CAPABILITY VOCABULARY -----------------------------------------
--
-- 00282's lists, copied verbatim, with `changelog.page` and
-- `changelog.post.write` appended. Purely additive: nothing is removed, so no
-- stored grant or revoke needs rewriting. An admin holds both by level; they
-- are in no baseline.
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
    'announcements.discord.write', 'tournaments.page', 'tournaments.manage.create.write',
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
    'events.page', 'events.signups.read', 'events.signups.remove.write',
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
    'announcements.discord.write', 'tournaments.page', 'tournaments.manage.create.write',
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
    'events.page', 'events.signups.read', 'events.signups.remove.write',
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

-- ---- 5. VERIFICATION ------------------------------------------------------
DO $verify$
DECLARE
  v_bad   TEXT[] := ARRAY[]::TEXT[];
  v_oid   oid;
  v_table TEXT;
  r       RECORD;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['club_change_drafts', 'club_change_entries'] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      v_bad := array_append(v_bad, v_table || ' missing');
      CONTINUE;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_table)::regclass) THEN
      v_bad := array_append(v_bad, v_table || ' does not have RLS enabled');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table) THEN
      v_bad := array_append(v_bad, v_table || ' has a policy');
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
       WHERE c.oid = ('public.' || v_table)::regclass
         AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
    ) THEN
      v_bad := array_append(v_bad, v_table || ' relacl still names anon or authenticated');
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE') THEN
      v_bad := array_append(v_bad, v_table || ' is not writable by service_role');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = v_table) THEN
      v_bad := array_append(v_bad, v_table || ' is in a publication');
    END IF;
  END LOOP;

  IF to_regclass('public.club_change_drafts_one_pending') IS NULL THEN
    v_bad := array_append(v_bad, 'the one-pending-line unique index is missing');
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('club_change_upsert', 'public.club_change_upsert(text,text,text,jsonb,jsonb,uuid)', true),
      ('club_change_is_app_write', 'public.club_change_is_app_write()', false),
      ('club_change_baseline_value', 'public.club_change_baseline_value(text,text[])', false),
      ('club_change_from_platform_settings', 'public.club_change_from_platform_settings()', true),
      ('club_change_from_permission_baselines', 'public.club_change_from_permission_baselines()', true),
      ('post_club_changes',
       'public.post_club_changes(uuid,uuid[],integer[],text[],uuid[],integer[],text,text)', true)
    ) AS t(fn, sig, definer)
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = r.fn) <> 1 THEN
      v_bad := array_append(v_bad, format('%s does not have exactly one signature', r.fn));
    END IF;
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, format('%s missing', r.sig));
      CONTINUE;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is executable by anon or authenticated', r.sig));
    END IF;
    IF r.definer AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      v_bad := array_append(v_bad, format('%s is not SECURITY DEFINER', r.sig));
    END IF;
    IF NOT COALESCE((SELECT 'search_path=public, pg_temp' = ANY (proconfig) FROM pg_proc WHERE oid = v_oid), false) THEN
      v_bad := array_append(v_bad, format('%s does not pin search_path', r.sig));
    END IF;
  END LOOP;

  IF NOT has_function_privilege('service_role',
       'public.post_club_changes(uuid,uuid[],integer[],text[],uuid[],integer[],text,text)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'post_club_changes is not executable by service_role');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'club_change_from_platform_settings'
                   AND tgrelid = 'public.platform_settings'::regclass) THEN
    v_bad := array_append(v_bad, 'the platform_settings trigger is missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'club_change_from_permission_baselines'
                   AND tgrelid = 'public.permission_baselines'::regclass) THEN
    v_bad := array_append(v_bad, 'the permission_baselines trigger is missing');
  END IF;

  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname IN ('players_permission_vocabulary_check', 'permission_baselines_vocabulary_check')
  LOOP
    IF position('changelog.page' in r.def) = 0 OR position('changelog.post.write' in r.def) = 0 THEN
      v_bad := array_append(v_bad, r.conname || ' does not admit the two changelog capabilities');
    END IF;
    IF position('page.access.predictions' in r.def) = 0 THEN
      v_bad := array_append(v_bad, r.conname || ' lost page.access.predictions');
    END IF;
  END LOOP;

  -- No foreign key to players, so the merge guard has nothing new to learn.
  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00286 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00286 verified: the draft and entry tables, their triggers, the post function and the vocabulary are in place.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
