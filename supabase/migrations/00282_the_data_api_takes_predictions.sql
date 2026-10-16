-- ============================================================
-- 00282 THE DATA API TAKES PREDICTIONS
--
-- WHAT IS ADDED: the data API's first write. A consumer holding the new
-- `predictions:write` scope posts head-to-head win predictions (singles 1v1 or
-- doubles 2v2) by player_ref, and members see them in the app, labelled as a
-- prediction, behind the `predictions` feature switch (off by default).
--
--   1. the scope CHECK on data_api_keys grows from six strings to seven
--   2. the capability vocabulary admits `page.access.predictions` (144 to 145)
--   3. one table, `data_api_predictions`, closed to every API-facing role
--   4. merge_players_disposable: the four side columns join the sixteen
--   5. a purge trigger that forgets a member's predictions on anonymisation
--   6. data_api_write_predictions and data_api_delete_predictions, the only
--      way in, granted to data_api_reader
--   7. get_matchup_prediction and get_my_predictions, the members' read,
--      granted to authenticated
--
-- PREDICTIONS NEVER FEED RATINGS. Nothing that rates a match, recomputes a
-- counter or builds a statistic reads this table, and a test pins that no
-- function outside this file names it. A prediction is a number a consumer's
-- model produced, stored so members can see it, and nothing more.
--
-- ------------------------------------------------------------
-- ONE ROW PER MATCHUP, PER CONSUMER
-- ------------------------------------------------------------
-- A matchup is two unordered sides of unordered players. The row is stored in
-- one fixed order: each side's players ascending, and the side holding the
-- smaller first uuid is side1. side1_win_probability is side1's chance, so a
-- prediction sent with the sides the other way round is stored as 1 - p. The
-- UNIQUE constraint (NULLS NOT DISTINCT, so a singles row's two NULL partners
-- compare equal) then makes a resend with the sides swapped REPLACE the earlier
-- row rather than sit beside it.
--
-- ------------------------------------------------------------
-- THE KEY IS RE-CHECKED IN HERE
-- ------------------------------------------------------------
-- The write function takes the key HASH, never a consumer id, and resolves the
-- key itself: not revoked, not expired, carrying `predictions:write`. So the
-- reader role's JWT alone cannot write anything, and a key revoked a moment ago
-- stops writing at once even while the service still holds it in its 30-second
-- positive cache.
--
-- ------------------------------------------------------------
-- A BAD ITEM IS A RESULT ROW, NEVER AN ERROR
-- ------------------------------------------------------------
-- The service turns any failed database call into a 503 (apps/data-api
-- upstream.ts). A RAISE for a caller's mistake would be reported to the caller
-- as an outage, so validation answers per item with `refused` and a reason,
-- and only a real fault raises.
--
-- An unknown ref and a member who is not published give the SAME answer,
-- `player`, so the endpoint cannot be used to learn who is hidden.
--
-- ------------------------------------------------------------
-- HIDE AND PURGE
-- ------------------------------------------------------------
-- The members' read functions re-check data_api_published_player for every
-- named player on every call, so a member who sets hide_from_leaderboard or
-- asks for deletion disappears from every prediction at once. The rows stay
-- until the purge anonymises the member, and then the trigger below deletes
-- them. It keys on the anonymised email marker that
-- supabase/functions/_shared/anonymize.ts writes, so no edge function changes.
-- A member who cancels a deletion request keeps their predictions.
-- ============================================================

BEGIN;

-- ---- 1. THE SCOPE CHECK ---------------------------------------------------
--
-- 00264's array with the write scope appended. Existing keys keep the scopes
-- they have: nothing back-fills, and no key carries the new one until an
-- officer gives it.
ALTER TABLE public.data_api_keys
  DROP CONSTRAINT IF EXISTS data_api_keys_scope_vocabulary,
  ADD CONSTRAINT data_api_keys_scope_vocabulary
    CHECK (scopes <@ ARRAY[
      'players:read',
      'matches:read',
      'ratings:history:read',
      'seasons:read',
      'tournaments:read',
      'schedule:read',
      'predictions:write'
    ]::text[]);

-- ---- 2. THE CAPABILITY VOCABULARY ------------------------------------------
--
-- 00256's lists, copied verbatim, with `page.access.predictions` appended: the
-- key the `predictions` feature switch mints (access-level.ts). An admin holds
-- it by level; it is in no baseline.
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
    'page.access.predictions'
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
    'page.access.predictions'
    ]::TEXT[]
  );

-- ---- 3. THE TABLE ----------------------------------------------------------
--
-- ON DELETE RESTRICT on the consumer and the key, for the reason 00241 gives:
-- those rows are the audit record of who could reach the club's data. CASCADE
-- on the players, because a prediction about a member who no longer exists is
-- nobody's record (purge-unfinished-signups really deletes the row).
CREATE TABLE IF NOT EXISTS public.data_api_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id uuid NOT NULL REFERENCES public.data_api_consumers(id) ON DELETE RESTRICT,
  key_id uuid NOT NULL REFERENCES public.data_api_keys(id) ON DELETE RESTRICT,
  format text NOT NULL,
  side1_p1 uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  side1_p2 uuid REFERENCES public.players(id) ON DELETE CASCADE,
  side2_p1 uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  side2_p2 uuid REFERENCES public.players(id) ON DELETE CASCADE,
  side1_win_probability numeric(5,4) NOT NULL,
  model text NOT NULL,
  made_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_api_predictions_format CHECK (format IN ('singles', 'doubles')),
  CONSTRAINT data_api_predictions_probability CHECK (side1_win_probability BETWEEN 0 AND 1),
  CONSTRAINT data_api_predictions_model CHECK (model ~ '^[A-Za-z0-9 ._:+-]{1,64}$'),
  CONSTRAINT data_api_predictions_shape CHECK (
    (format = 'singles' AND side1_p2 IS NULL AND side2_p2 IS NULL)
    OR (format = 'doubles' AND side1_p2 IS NOT NULL AND side2_p2 IS NOT NULL)
  ),
  -- The canonical order. With each side ascending and side1 holding the smaller
  -- first player, the four doubles players are distinct once side1_p2 and
  -- side2_p2 also differ from each other and from the other side's first.
  CONSTRAINT data_api_predictions_canonical CHECK (
    side1_p1 < side2_p1
    AND (side1_p2 IS NULL OR side1_p1 < side1_p2)
    AND (side2_p2 IS NULL OR side2_p1 < side2_p2)
    AND (side1_p2 IS NULL OR (side1_p2 <> side2_p1 AND side1_p2 <> side2_p2))
  ),
  CONSTRAINT data_api_predictions_one_per_matchup
    UNIQUE NULLS NOT DISTINCT (consumer_id, format, side1_p1, side1_p2, side2_p1, side2_p2)
);

CREATE INDEX IF NOT EXISTS idx_data_api_predictions_side1_p1 ON public.data_api_predictions (side1_p1);
CREATE INDEX IF NOT EXISTS idx_data_api_predictions_side1_p2 ON public.data_api_predictions (side1_p2);
CREATE INDEX IF NOT EXISTS idx_data_api_predictions_side2_p1 ON public.data_api_predictions (side2_p1);
CREATE INDEX IF NOT EXISTS idx_data_api_predictions_side2_p2 ON public.data_api_predictions (side2_p2);

ALTER TABLE public.data_api_predictions ENABLE ROW LEVEL SECURITY;

-- No policy, and no grant to anything that faces a request. The service role
-- reads it for a member's data export; every write goes through the definer
-- functions below. data_api_reader is granted nothing on it.
REVOKE ALL ON public.data_api_predictions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.data_api_predictions TO service_role;

COMMENT ON TABLE public.data_api_predictions IS
  'Head-to-head win predictions a data API consumer posted. One row per consumer and matchup, stored in canonical order: side1 holds the smaller first player and side1_win_probability is its chance. Shown to members labelled as a prediction. Predictions never feed ratings: nothing that rates a match or builds a statistic reads this table.';

-- ---- 4. merge_players_disposable ------------------------------------------
--
-- 00279's sixteen, and the four side columns. A merged-away member's
-- predictions are dropped by the CASCADE rather than repointed: a re-key could
-- collide with the survivor's own row for the same matchup, or put one person
-- on both sides, and a consumer re-sends a prediction anyway.
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
    ('data_api_predictions',         'side2_p2')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- ---- 5. THE PURGE TRIGGER --------------------------------------------------
--
-- The purge anonymises by UPDATE, so the CASCADE above never fires for it. The
-- marker is the email anonymizedPlayerFields() writes,
-- `deleted+<id>@deleted.invalid`; a test reads both files so the two cannot
-- drift apart.
CREATE OR REPLACE FUNCTION public.data_api_predictions_forget_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM data_api_predictions
   WHERE NEW.id IN (side1_p1, side1_p2, side2_p1, side2_p2);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.data_api_predictions_forget_player() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_data_api_predictions_forget_player ON public.players;
CREATE TRIGGER trg_data_api_predictions_forget_player
  AFTER UPDATE OF email ON public.players
  FOR EACH ROW
  WHEN (NEW.email LIKE 'deleted+%@deleted.invalid' AND OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.data_api_predictions_forget_player();

-- ---- 6. THE WRITE AND THE DELETE -------------------------------------------

-- The published members a consumer can name, as ref to id, built once per call
-- rather than rehashing the roster for every ref in a batch.
CREATE OR REPLACE FUNCTION public.data_api_ref_map(p_consumer_id uuid, p_refs text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_object_agg(r.ref, r.id), '{}'::jsonb)
    FROM (
      SELECT p.id, data_api_player_ref(p_consumer_id, p.id) AS ref
        FROM players p
       WHERE data_api_published_player(p.id)
    ) r
   WHERE r.ref = ANY (p_refs);
$function$;

COMMENT ON FUNCTION public.data_api_ref_map(uuid, text[]) IS
  'A batch of player_refs to published member ids, as a jsonb object. Unknown and unpublished refs are simply absent. Internal: no role is granted EXECUTE, since it turns pseudonyms into ids.';

REVOKE ALL ON FUNCTION public.data_api_ref_map(uuid, text[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.data_api_write_predictions(p_key_hash text, p_predictions jsonb)
RETURNS TABLE(item integer, status text, reason text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_key_id    uuid;
  v_consumer  uuid;
  v_refs      text[];
  v_map       jsonb;
  v_elem      jsonb;
  v_i         integer;
  v_format    text;
  v_size      integer;
  v_a         uuid[];
  v_b         uuid[];
  v_side1     uuid[];
  v_side2     uuid[];
  v_ref       text;
  v_bad       text;
  v_p         numeric;
  v_model     text;
  v_made      timestamptz;
  v_created   boolean;
  v_n_created integer := 0;
  v_n_replaced integer := 0;
  v_n_refused integer := 0;
BEGIN
  SELECT k.id, k.consumer_id INTO v_key_id, v_consumer
    FROM data_api_keys k
   WHERE k.key_hash = p_key_hash
     AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND 'predictions:write' = ANY (k.scopes);
  IF v_key_id IS NULL THEN
    item := 0; status := 'refused'; reason := 'key';
    RETURN NEXT;
    RETURN;
  END IF;

  IF (CASE WHEN jsonb_typeof(p_predictions) = 'array'
          THEN jsonb_array_length(p_predictions) NOT BETWEEN 1 AND 100
          ELSE true END) THEN
    item := 0; status := 'refused'; reason := 'batch';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT r.value), ARRAY[]::text[]) INTO v_refs
    FROM jsonb_array_elements(p_predictions) e,
         LATERAL (
           SELECT x.value FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(e.value -> 'side_a') = 'array' THEN e.value -> 'side_a' ELSE '[]'::jsonb END
             || CASE WHEN jsonb_typeof(e.value -> 'side_b') = 'array' THEN e.value -> 'side_b' ELSE '[]'::jsonb END
           ) x
         ) r
   WHERE jsonb_typeof(e.value) = 'object';
  v_map := data_api_ref_map(v_consumer, v_refs);

  FOR v_i IN 0 .. jsonb_array_length(p_predictions) - 1 LOOP
    v_elem := p_predictions -> v_i;
    v_bad := NULL;
    v_format := NULL;
    v_a := ARRAY[]::uuid[];
    v_b := ARRAY[]::uuid[];

    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object' THEN
      v_bad := 'shape';
    ELSE
      v_format := v_elem ->> 'format';
      IF v_format IS NULL OR v_format NOT IN ('singles', 'doubles') THEN
        v_bad := 'format';
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      v_size := CASE v_format WHEN 'singles' THEN 1 ELSE 2 END;
      IF (CASE WHEN jsonb_typeof(v_elem -> 'side_a') = 'array'
                    AND jsonb_typeof(v_elem -> 'side_b') = 'array'
              THEN jsonb_array_length(v_elem -> 'side_a') <> v_size
                   OR jsonb_array_length(v_elem -> 'side_b') <> v_size
              ELSE true END) THEN
        v_bad := 'sides';
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      FOR v_ref IN SELECT jsonb_array_elements_text(v_elem -> 'side_a') LOOP
        IF v_ref !~ '^[0-9a-f]{64}$' OR NOT (v_map ? v_ref) THEN
          v_bad := 'player';
        ELSE
          v_a := v_a || (v_map ->> v_ref)::uuid;
        END IF;
      END LOOP;
      FOR v_ref IN SELECT jsonb_array_elements_text(v_elem -> 'side_b') LOOP
        IF v_ref !~ '^[0-9a-f]{64}$' OR NOT (v_map ? v_ref) THEN
          v_bad := 'player';
        ELSE
          v_b := v_b || (v_map ->> v_ref)::uuid;
        END IF;
      END LOOP;
    END IF;

    IF v_bad IS NULL
       AND (SELECT count(DISTINCT x) FROM unnest(v_a || v_b) x) <> 2 * v_size THEN
      v_bad := 'duplicate';
    END IF;

    IF v_bad IS NULL THEN
      IF jsonb_typeof(v_elem -> 'probability') IS DISTINCT FROM 'number' THEN
        v_bad := 'probability';
      ELSE
        v_p := (v_elem ->> 'probability')::numeric;
        IF v_p < 0 OR v_p > 1 THEN
          v_bad := 'probability';
        END IF;
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      v_model := v_elem ->> 'model';
      IF jsonb_typeof(v_elem -> 'model') IS DISTINCT FROM 'string'
         OR v_model !~ '^[A-Za-z0-9 ._:+-]{1,64}$' THEN
        v_bad := 'model';
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      v_made := NULL;
      IF jsonb_typeof(v_elem -> 'made_at') = 'string' THEN
        BEGIN
          v_made := (v_elem ->> 'made_at')::timestamptz;
        EXCEPTION WHEN others THEN
          v_made := NULL;
        END;
      END IF;
      IF v_made IS NULL OR v_made > now() + interval '5 minutes' THEN
        v_bad := 'made_at';
      END IF;
    END IF;

    IF v_bad IS NOT NULL THEN
      v_n_refused := v_n_refused + 1;
      item := v_i; status := 'refused'; reason := v_bad;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Canonical order: each side ascending, then the side with the smaller
    -- first player is side1, and the probability follows side A.
    v_a := ARRAY(SELECT x FROM unnest(v_a) x ORDER BY x);
    v_b := ARRAY(SELECT x FROM unnest(v_b) x ORDER BY x);
    IF v_a[1] < v_b[1] THEN
      v_side1 := v_a; v_side2 := v_b;
    ELSE
      v_side1 := v_b; v_side2 := v_a; v_p := 1 - v_p;
    END IF;

    INSERT INTO data_api_predictions AS d
      (consumer_id, key_id, format, side1_p1, side1_p2, side2_p1, side2_p2,
       side1_win_probability, model, made_at)
    VALUES
      (v_consumer, v_key_id, v_format, v_side1[1], v_side1[2], v_side2[1], v_side2[2],
       v_p, v_model, v_made)
    ON CONFLICT ON CONSTRAINT data_api_predictions_one_per_matchup DO UPDATE
      SET side1_win_probability = EXCLUDED.side1_win_probability,
          model = EXCLUDED.model,
          made_at = EXCLUDED.made_at,
          key_id = EXCLUDED.key_id,
          updated_at = now()
    RETURNING (d.xmax = 0) INTO v_created;

    IF v_created THEN
      v_n_created := v_n_created + 1;
      item := v_i; status := 'created'; reason := NULL;
    ELSE
      v_n_replaced := v_n_replaced + 1;
      item := v_i; status := 'replaced'; reason := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'data_api_predictions_written', 'data_api_key', v_key_id,
          jsonb_build_object('consumer_id', v_consumer, 'created', v_n_created,
                             'replaced', v_n_replaced, 'refused', v_n_refused),
          'A data API key posted head-to-head predictions');
END;
$function$;

COMMENT ON FUNCTION public.data_api_write_predictions(text, jsonb) IS
  'The data API''s one write. Takes a key HASH, re-checks the key and its predictions:write scope, resolves player_refs to published members and upserts one canonical row per matchup. Every bad item is a refused result row, never an error. Writes one audit row per call. Predictions never feed ratings.';

REVOKE ALL ON FUNCTION public.data_api_write_predictions(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_write_predictions(text, jsonb) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_delete_predictions(p_key_hash text, p_matchups jsonb)
RETURNS TABLE(item integer, status text, reason text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_key_id    uuid;
  v_consumer  uuid;
  v_refs      text[];
  v_map       jsonb;
  v_elem      jsonb;
  v_i         integer;
  v_format    text;
  v_size      integer;
  v_a         uuid[];
  v_b         uuid[];
  v_side1     uuid[];
  v_side2     uuid[];
  v_ref       text;
  v_bad       text;
  v_missing   boolean;
  v_rows      integer;
  v_n_deleted integer := 0;
  v_n_missing integer := 0;
  v_n_refused integer := 0;
BEGIN
  SELECT k.id, k.consumer_id INTO v_key_id, v_consumer
    FROM data_api_keys k
   WHERE k.key_hash = p_key_hash
     AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND 'predictions:write' = ANY (k.scopes);
  IF v_key_id IS NULL THEN
    item := 0; status := 'refused'; reason := 'key';
    RETURN NEXT;
    RETURN;
  END IF;

  IF (CASE WHEN jsonb_typeof(p_matchups) = 'array'
          THEN jsonb_array_length(p_matchups) NOT BETWEEN 1 AND 100
          ELSE true END) THEN
    item := 0; status := 'refused'; reason := 'batch';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT r.value), ARRAY[]::text[]) INTO v_refs
    FROM jsonb_array_elements(p_matchups) e,
         LATERAL (
           SELECT x.value FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(e.value -> 'side_a') = 'array' THEN e.value -> 'side_a' ELSE '[]'::jsonb END
             || CASE WHEN jsonb_typeof(e.value -> 'side_b') = 'array' THEN e.value -> 'side_b' ELSE '[]'::jsonb END
           ) x
         ) r
   WHERE jsonb_typeof(e.value) = 'object';
  v_map := data_api_ref_map(v_consumer, v_refs);

  FOR v_i IN 0 .. jsonb_array_length(p_matchups) - 1 LOOP
    v_elem := p_matchups -> v_i;
    v_bad := NULL;
    v_missing := false;
    v_format := NULL;
    v_a := ARRAY[]::uuid[];
    v_b := ARRAY[]::uuid[];

    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object' THEN
      v_bad := 'shape';
    ELSE
      v_format := v_elem ->> 'format';
      IF v_format IS NULL OR v_format NOT IN ('singles', 'doubles') THEN
        v_bad := 'format';
      END IF;
    END IF;

    IF v_bad IS NULL THEN
      v_size := CASE v_format WHEN 'singles' THEN 1 ELSE 2 END;
      IF (CASE WHEN jsonb_typeof(v_elem -> 'side_a') = 'array'
                    AND jsonb_typeof(v_elem -> 'side_b') = 'array'
              THEN jsonb_array_length(v_elem -> 'side_a') <> v_size
                   OR jsonb_array_length(v_elem -> 'side_b') <> v_size
              ELSE true END) THEN
        v_bad := 'sides';
      END IF;
    END IF;

    -- A ref that names nobody this consumer can see is simply not found: the
    -- same answer as a matchup with no row, so a delete reveals nothing about
    -- who is hidden either.
    IF v_bad IS NULL THEN
      FOR v_ref IN SELECT jsonb_array_elements_text(v_elem -> 'side_a') LOOP
        IF v_ref !~ '^[0-9a-f]{64}$' OR NOT (v_map ? v_ref) THEN
          v_missing := true;
        ELSE
          v_a := v_a || (v_map ->> v_ref)::uuid;
        END IF;
      END LOOP;
      FOR v_ref IN SELECT jsonb_array_elements_text(v_elem -> 'side_b') LOOP
        IF v_ref !~ '^[0-9a-f]{64}$' OR NOT (v_map ? v_ref) THEN
          v_missing := true;
        ELSE
          v_b := v_b || (v_map ->> v_ref)::uuid;
        END IF;
      END LOOP;
    END IF;

    IF v_bad IS NOT NULL THEN
      v_n_refused := v_n_refused + 1;
      item := v_i; status := 'refused'; reason := v_bad;
      RETURN NEXT;
      CONTINUE;
    END IF;

    v_rows := 0;
    IF NOT v_missing THEN
      v_a := ARRAY(SELECT x FROM unnest(v_a) x ORDER BY x);
      v_b := ARRAY(SELECT x FROM unnest(v_b) x ORDER BY x);
      IF v_a[1] < v_b[1] THEN
        v_side1 := v_a; v_side2 := v_b;
      ELSE
        v_side1 := v_b; v_side2 := v_a;
      END IF;
      DELETE FROM data_api_predictions d
       WHERE d.consumer_id = v_consumer
         AND d.format = v_format
         AND d.side1_p1 = v_side1[1]
         AND d.side1_p2 IS NOT DISTINCT FROM v_side1[2]
         AND d.side2_p1 = v_side2[1]
         AND d.side2_p2 IS NOT DISTINCT FROM v_side2[2];
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;

    IF v_rows > 0 THEN
      v_n_deleted := v_n_deleted + 1;
      item := v_i; status := 'deleted'; reason := NULL;
    ELSE
      v_n_missing := v_n_missing + 1;
      item := v_i; status := 'not_found'; reason := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (NULL, 'data_api_predictions_deleted', 'data_api_key', v_key_id,
          jsonb_build_object('consumer_id', v_consumer, 'deleted', v_n_deleted,
                             'not_found', v_n_missing, 'refused', v_n_refused),
          'A data API key deleted head-to-head predictions');
END;
$function$;

COMMENT ON FUNCTION public.data_api_delete_predictions(text, jsonb) IS
  'Deletes the calling consumer''s own predictions by matchup. The same key check and canonical order as data_api_write_predictions. Writes one audit row per call.';

REVOKE ALL ON FUNCTION public.data_api_delete_predictions(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_delete_predictions(text, jsonb) TO data_api_reader;

-- ---- 7. THE MEMBERS' READ --------------------------------------------------
--
-- Neither function checks the feature switch: the app does, so a switched-off
-- feature costs no call at all. Neither returns anything about the consumer or
-- the key. When more than one consumer has predicted the same matchup, the
-- newest made_at is the one shown.
--
-- A MEMBER SEES ONLY THEIR OWN MATCHUPS. Both functions answer only for a
-- matchup the caller plays in: get_matchup_prediction returns nothing unless
-- the caller's player id is on side A or side B, and get_my_predictions reads
-- only rows naming the caller. The app shows a prediction only on the
-- challenge screens of a member who is part of the challenge; the check here
-- means a hand-made RPC call cannot read anyone else's matchup either.
--
-- get_my_predictions returns other members' ids. A signed-in member can
-- already read every member's id off the leaderboard, so this widens nothing;
-- and every id it returns is a published member.
CREATE OR REPLACE FUNCTION public.get_matchup_prediction(p_format text, p_side_a uuid[], p_side_b uuid[])
RETURNS TABLE(side_a_win_probability numeric, model text, made_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH me AS (
    SELECT get_player_id(auth.uid()) AS id
  ),
  sides AS (
    SELECT ARRAY(SELECT x FROM unnest(p_side_a) x ORDER BY x) AS a,
           ARRAY(SELECT x FROM unnest(p_side_b) x ORDER BY x) AS b
  ),
  canon AS (
    SELECT CASE WHEN s.a[1] < s.b[1] THEN s.a ELSE s.b END AS side1,
           CASE WHEN s.a[1] < s.b[1] THEN s.b ELSE s.a END AS side2,
           s.a[1] < s.b[1] AS a_is_side1
      FROM sides s, me
     WHERE auth.uid() IS NOT NULL
       AND me.id IS NOT NULL
       AND me.id = ANY (s.a || s.b)
       AND p_format IN ('singles', 'doubles')
       AND cardinality(s.a) = CASE p_format WHEN 'singles' THEN 1 ELSE 2 END
       AND cardinality(s.b) = cardinality(s.a)
       AND NOT EXISTS (
         SELECT 1 FROM unnest(s.a || s.b) x WHERE x IS NULL OR NOT data_api_published_player(x)
       )
  )
  SELECT CASE WHEN c.a_is_side1 THEN d.side1_win_probability ELSE 1 - d.side1_win_probability END,
         d.model,
         d.made_at
    FROM canon c
    JOIN data_api_predictions d
      ON d.format = p_format
     AND d.side1_p1 = c.side1[1]
     AND d.side1_p2 IS NOT DISTINCT FROM c.side1[2]
     AND d.side2_p1 = c.side2[1]
     AND d.side2_p2 IS NOT DISTINCT FROM c.side2[2]
   ORDER BY d.made_at DESC
   LIMIT 1;
$function$;

COMMENT ON FUNCTION public.get_matchup_prediction(text, uuid[], uuid[]) IS
  'The newest prediction for one matchup, oriented to the caller''s side A. Nothing unless the caller plays in the matchup, and nothing when any named player is not published. Never says which consumer made it. A prediction only: it never feeds ratings.';

REVOKE ALL ON FUNCTION public.get_matchup_prediction(text, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_matchup_prediction(text, uuid[], uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_predictions()
RETURNS TABLE(format text, side_a uuid[], side_b uuid[], side_a_win_probability numeric, model text, made_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH me AS (
    SELECT get_player_id(auth.uid()) AS id
  ),
  newest AS (
    SELECT DISTINCT ON (d.format, d.side1_p1, d.side1_p2, d.side2_p1, d.side2_p2)
           d.format,
           array_remove(ARRAY[d.side1_p1, d.side1_p2], NULL) AS side1,
           array_remove(ARRAY[d.side2_p1, d.side2_p2], NULL) AS side2,
           d.side1_win_probability,
           d.model,
           d.made_at
      FROM data_api_predictions d, me
     WHERE me.id IS NOT NULL
       AND me.id IN (d.side1_p1, d.side1_p2, d.side2_p1, d.side2_p2)
     ORDER BY d.format, d.side1_p1, d.side1_p2, d.side2_p1, d.side2_p2, d.made_at DESC
  )
  SELECT n.format,
         CASE WHEN me.id = ANY (n.side1) THEN n.side1 ELSE n.side2 END,
         CASE WHEN me.id = ANY (n.side1) THEN n.side2 ELSE n.side1 END,
         CASE WHEN me.id = ANY (n.side1) THEN n.side1_win_probability ELSE 1 - n.side1_win_probability END,
         n.model,
         n.made_at
    FROM newest n, me
   WHERE NOT EXISTS (
     SELECT 1 FROM unnest(n.side1 || n.side2) x WHERE NOT data_api_published_player(x)
   );
$function$;

COMMENT ON FUNCTION public.get_my_predictions() IS
  'Every prediction naming the caller, the newest per matchup, oriented with the caller''s side as side A. Only matchups whose every player is published. A prediction only: it never feeds ratings.';

REVOKE ALL ON FUNCTION public.get_my_predictions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_predictions() TO authenticated;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad  TEXT[] := ARRAY[]::TEXT[];
  v_oid  oid;
  r      RECORD;
BEGIN
  -- ---- every stored key still satisfies the scope CHECK -------------------
  IF EXISTS (
    SELECT 1 FROM public.data_api_keys
     WHERE NOT scopes <@ ARRAY['players:read', 'matches:read', 'ratings:history:read',
                               'seasons:read', 'tournaments:read', 'schedule:read',
                               'predictions:write']::text[]
  ) THEN
    v_bad := array_append(v_bad, 'a stored key carries a scope outside the new vocabulary');
  END IF;

  -- ---- the scope CHECK admits the write scope and refuses an unknown one ---
  BEGIN
    INSERT INTO public.data_api_consumers (id, name)
    VALUES ('00000000-0000-0000-0000-000000000282', '00282 self-check');
    INSERT INTO public.data_api_keys (consumer_id, key_hash, key_prefix, scopes)
    VALUES ('00000000-0000-0000-0000-000000000282', repeat('1', 64), 'clubld_x', ARRAY['predictions:write']);
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'P0282';
  EXCEPTION
    WHEN check_violation THEN
      v_bad := array_append(v_bad, 'the scope CHECK refuses predictions:write');
    WHEN SQLSTATE 'P0282' THEN
      NULL;
  END;
  BEGIN
    INSERT INTO public.data_api_consumers (id, name)
    VALUES ('00000000-0000-0000-0000-000000000282', '00282 self-check');
    INSERT INTO public.data_api_keys (consumer_id, key_hash, key_prefix, scopes)
    VALUES ('00000000-0000-0000-0000-000000000282', repeat('1', 64), 'clubld_x', ARRAY['predictions:read']);
    v_bad := array_append(v_bad, 'the scope CHECK accepted an unknown scope');
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'P0282';
  EXCEPTION
    WHEN check_violation THEN NULL;
    WHEN SQLSTATE 'P0282' THEN NULL;
  END;

  -- ---- the vocabulary admits the new key ----------------------------------
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname IN ('players_permission_vocabulary_check', 'permission_baselines_vocabulary_check')
  LOOP
    IF position(quote_literal('page.access.predictions') IN r.def) = 0 THEN
      v_bad := array_append(v_bad, format('%s does not admit page.access.predictions', r.conname));
    END IF;
  END LOOP;

  -- ---- the table, closed to every role that faces a request ---------------
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.data_api_predictions'::regclass) THEN
    v_bad := array_append(v_bad, 'data_api_predictions does not have RLS enabled');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'data_api_predictions') THEN
    v_bad := array_append(v_bad, 'data_api_predictions has a policy');
  END IF;
  FOR r IN SELECT unnest(ARRAY['data_api_reader', 'anon', 'authenticated']) AS role LOOP
    IF has_table_privilege(r.role, 'public.data_api_predictions', 'SELECT')
       OR has_table_privilege(r.role, 'public.data_api_predictions', 'INSERT')
       OR has_table_privilege(r.role, 'public.data_api_predictions', 'UPDATE')
       OR has_table_privilege(r.role, 'public.data_api_predictions', 'DELETE') THEN
      v_bad := array_append(v_bad, format('%s can reach data_api_predictions directly', r.role));
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.data_api_predictions', 'SELECT') THEN
    v_bad := array_append(v_bad, 'service_role cannot read data_api_predictions for the export');
  END IF;

  -- ---- the write and the delete: data_api_reader only ---------------------
  FOR r IN SELECT unnest(ARRAY[
    'public.data_api_write_predictions(text,jsonb)',
    'public.data_api_delete_predictions(text,jsonb)'
  ]) AS sig LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, format('%s missing', r.sig));
      CONTINUE;
    END IF;
    IF NOT has_function_privilege('data_api_reader', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is not executable by data_api_reader', r.sig));
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is executable by anon or authenticated', r.sig));
    END IF;
  END LOOP;

  -- ---- the members' read: authenticated only ------------------------------
  FOR r IN SELECT unnest(ARRAY[
    'public.get_matchup_prediction(text,uuid[],uuid[])',
    'public.get_my_predictions()'
  ]) AS sig LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, format('%s missing', r.sig));
      CONTINUE;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is not executable by authenticated', r.sig));
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('data_api_reader', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is executable by anon or data_api_reader', r.sig));
    END IF;
  END LOOP;

  -- ---- the internals: nobody ---------------------------------------------
  FOR r IN SELECT unnest(ARRAY[
    'public.data_api_ref_map(uuid,text[])',
    'public.data_api_predictions_forget_player()'
  ]) AS sig LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, format('%s missing', r.sig));
      CONTINUE;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('data_api_reader', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is executable by a request-facing role', r.sig));
    END IF;
  END LOOP;

  -- ---- the purge trigger --------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.players'::regclass
       AND tgname = 'trg_data_api_predictions_forget_player'
       AND NOT tgisinternal
  ) THEN
    v_bad := array_append(v_bad, 'the purge trigger on players is missing');
  END IF;

  -- ---- merge_players ------------------------------------------------------
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 20 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the twenty rows');
  END IF;
  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00282 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00282 verified: seven scopes, 145 capabilities, the predictions table closed, its functions granted as intended, the purge trigger and the merge rows in place.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
