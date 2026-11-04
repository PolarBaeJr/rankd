-- ============================================================
-- 00321: SUPER ADMIN, A LEVEL ABOVE ADMIN
--
-- The owner: "There should probably be a page that super admins can access to
-- disable pages", "And then remove platform systems from admins".
--
-- players.role gains a third value, 'super_admin'. The console resolves it to
-- the super_admin level, which holds every capability; an admin now holds
-- every capability except PLATFORM_ONLY (packages/shared/src/utils/access-level.ts):
-- the platform settings and the data API keys. Every database helper that
-- treated role = 'admin' as the top treats 'super_admin' as at least admin.
--
-- NOBODY IS PROMOTED HERE. The owner sets the first super admin by hand.
--
-- WHAT CHANGES.
--   * user_role gains 'super_admin'. players.role is an ENUM, not a CHECK, so
--     this is ALTER TYPE ... ADD VALUE.
--   * is_super_admin(p_user_id): new, is_admin's standing gate on
--     role = 'super_admin'.
--   * is_admin, is_admin_or_coach: the admin tier is admin or super_admin. 45
--     RLS policies call is_admin, so a super admin passes every one of them.
--   * admin_access_level: returns 'super_admin' for a super admin. The string
--     is byte-identical to the console's AccessLevel.
--   * admin_console_access: also returns the console page switches
--     (platform_settings key 'console_pages', console-pages.ts), so the
--     middleware reads them in the round trip it already makes.
--   * admins_with_passkeys, guard_last_admin_passkey_delete,
--     guard_last_admin_role: the last-admin guards count and guard the admin
--     tier, so moving an admin to super_admin is not a demotion. The two
--     guards' bodies are 00050's with 00145's patches applied, restated whole.
--   * guard_player_privileged_columns (whole from 00292): on the browser key,
--     only a super admin may make or unmake an admin or a super admin.
--   * reset_console_passkey_grace (00262), trigger_check_noshow_threshold
--     (00004), reject_registration_import_entry (00291): the admin tier.
--   * club_change_from_platform_settings (whole from 00318): a save of the
--     'console_pages' row drafts no club change, like 'release_flags'.
--   * purgeable_inactive_players (00064): a super admin is never purgeable.
--
-- UNCHANGED. Every other guard, signature and grant. With no super admin in
-- the table every function answers exactly as before.
--
-- THE NEW LABEL IS NOT USABLE IN THIS TRANSACTION. db-migrate.sh wraps a file
-- without a top-level COMMIT in --single-transaction, and Postgres refuses an
-- enum value added in the same transaction ("unsafe use of new value"). So
-- every comparison below is role::text against text, which never casts the
-- literal to user_role, including the verify block.
--
-- No BEGIN/COMMIT: db-migrate.sh wraps a file without a top-level COMMIT in
-- --single-transaction.
-- ============================================================

ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'super_admin';

-- ===========================================================================
-- is_super_admin: is_admin's predicate on the top value only
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.is_super_admin(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- is_admin's standing gate, verbatim, on role = 'super_admin'.
  RETURN EXISTS (
    SELECT 1 FROM players
     WHERE user_id = p_user_id
       AND role::text = 'super_admin'
       AND COALESCE(is_banned, FALSE) = FALSE
       AND status NOT IN ('suspended', 'pending_approval')
       AND COALESCE(active_flag, TRUE) = TRUE
       AND COALESCE(onboarding_completed, FALSE) = TRUE
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.is_super_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.is_super_admin(uuid) IS
  'TRUE only for a super admin IN GOOD STANDING (00321). The same standing gate '
  'as is_admin. guard_player_privileged_columns asks it before an admin on the '
  'browser key may make or unmake an admin.';

-- ===========================================================================
-- is_admin, is_admin_or_coach: the admin tier (00140's bodies)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.is_admin(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The standing gate and the role test in ONE EXISTS, so the function stays a
  -- single indexed lookup on idx_players_user_id. This is evaluated per row by
  -- 45 RLS policies on a live database; delegating to admin_access_level()
  -- would have kept one copy of the predicate but turned each of those into up
  -- to four sequential EXISTS, which is not a trade worth making here. The
  -- price is that this predicate and admin_access_level's must be kept in step
  -- BY HAND: they are written identically so the diff is trivial.
  --
  -- 00321: a super admin is at least an admin.
  RETURN EXISTS (
    SELECT 1 FROM players
     WHERE user_id = p_user_id
       AND role::text IN ('admin', 'super_admin')
       AND COALESCE(is_banned, FALSE) = FALSE
       AND status NOT IN ('suspended', 'pending_approval')
       AND COALESCE(active_flag, TRUE) = TRUE
       -- 00132: an unfinished account holds no privilege. A claimed roster row
       -- can now be linked to a login before its owner has given a name or
       -- signed a waiver, and admin-level data access must not arrive first.
       AND COALESCE(onboarding_completed, FALSE) = TRUE
  );
END;
$function$;
-- The grants 00208 left: not anon, which may not ask who is an admin.
-- Revoked and granted back so they are stated here.
REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_admin_or_coach(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- user_role was simplified to player/admin; 'coach_executive' no longer
  -- exists (the old IN ('admin','coach_executive') literal errored at runtime
  -- post-simplification). Body kept identical to is_admin so the two cannot
  -- drift: the three varsity_notes policies are the reason this matters.
  RETURN EXISTS (
    SELECT 1 FROM players
     WHERE user_id = p_user_id
       AND role::text IN ('admin', 'super_admin')
       AND COALESCE(is_banned, FALSE) = FALSE
       AND status NOT IN ('suspended', 'pending_approval')
       AND COALESCE(active_flag, TRUE) = TRUE
       AND COALESCE(onboarding_completed, FALSE) = TRUE
  );
END;
$function$;
-- The grants 00230 left: not anon.
REVOKE ALL ON FUNCTION public.is_admin_or_coach(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_or_coach(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.is_admin(uuid) IS
  'TRUE only for an admin or super admin IN GOOD STANDING: not banned, not '
  'suspended, not pending_approval, active_flag TRUE, onboarding complete '
  '(00140, 00321). The predicate is a verbatim copy of admin_access_level()''s '
  'standing gate and MUST BE KEPT IN STEP WITH IT.';

-- ===========================================================================
-- admin_access_level: 00132's body, the super_admin level first
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.admin_access_level(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ok BOOLEAN;
BEGIN
  -- Standing gate, evaluated once. A row failing this holds no level at all,
  -- rather than holding one the caller has to remember to re-check.
  SELECT EXISTS (
    SELECT 1 FROM players
     WHERE user_id = p_user_id
       AND COALESCE(is_banned, FALSE) = FALSE
       AND status NOT IN ('suspended', 'pending_approval')
       AND COALESCE(active_flag, TRUE) = TRUE
       -- 00132: an unfinished account holds no console level. A claimed roster
       -- row can now be linked to a login before its owner has given a name or
       -- signed a waiver, and console access must not arrive first.
       AND COALESCE(onboarding_completed, FALSE) = TRUE
  ) INTO v_ok;

  IF NOT v_ok THEN
    RETURN NULL;
  END IF;

  -- 00321: 'super_admin' is byte-identical to the console's AccessLevel.
  IF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND role::text = 'super_admin') THEN
    RETURN 'super_admin';
  ELSIF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND role::text = 'admin') THEN
    RETURN 'admin';
  ELSIF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND is_exec = TRUE) THEN
    RETURN 'exec';
  ELSIF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND is_trainer = TRUE) THEN
    RETURN 'trainer';
  ELSE
    RETURN NULL;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_access_level(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_access_level(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_access_level(uuid) IS
  'The console level a signed-in user holds: super_admin, admin, exec, trainer '
  'or NULL, gated on good standing AND a finished onboarding (00057, 00132, 00321).';

-- ===========================================================================
-- admin_console_access: 00087's body, plus the console page switches
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.admin_console_access(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'level',               admin_access_level(p_user_id),
    'permission_role',     p.permission_role,
    'permission_grants',   to_jsonb(p.permission_grants),
    'permission_revokes',  to_jsonb(p.permission_revokes),
    -- 00321: the raw row; console-pages.ts reads it (off only for a literal false).
    'console_pages',       (SELECT ps.value FROM platform_settings ps WHERE ps.key = 'console_pages')
  )
  FROM players p
  WHERE p.user_id = p_user_id;
$function$;
REVOKE ALL ON FUNCTION public.admin_console_access(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_console_access(uuid) TO authenticated, service_role;

-- ===========================================================================
-- The last-admin guards: the admin tier (00050, 00051, 00145)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.admins_with_passkeys(
  p_excluding_credential uuid DEFAULT NULL,
  p_excluding_player uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COUNT(DISTINCT p.id)::INTEGER
  FROM players p
  JOIN passkey_credentials pc ON pc.player_id = p.id
  WHERE p.role::text IN ('admin', 'super_admin')
    AND p.is_banned = FALSE
    AND pc.enrolled_via = 'admin'
    AND (p_excluding_credential IS NULL OR pc.id <> p_excluding_credential)
    AND (p_excluding_player IS NULL OR p.id <> p_excluding_player);
$function$;
REVOKE ALL ON FUNCTION public.admins_with_passkeys(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admins_with_passkeys(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.admins_with_passkeys(uuid, uuid) IS
  'Number of admin or super admin players who are NOT banned and hold an admin-enrolled passkey, optionally excluding a credential or player about to be removed. The is_banned clause is 00145; the super admin is 00321.';

CREATE OR REPLACE FUNCTION public.guard_last_admin_passkey_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only the last credential of the last passkey-holding admin is protected.
  -- Enrol the replacement first and this never fires, which is the order you
  -- want anyway when moving to a new phone.
  IF admins_with_passkeys(p_excluding_credential => OLD.id) = 0
     AND EXISTS (SELECT 1 FROM players WHERE id = OLD.player_id AND role::text IN ('admin', 'super_admin'))
  THEN
    RAISE EXCEPTION 'This is the only passkey belonging to an admin. Enrol another passkey first, or the admin console becomes unreachable.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_last_admin_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Demotion. Unchanged roles fall straight through, so ordinary profile
  -- updates on an admin are unaffected. 00321: the tier is admin and
  -- super_admin, so a move between the two is not a demotion.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.role::text IN ('admin', 'super_admin')
       AND NEW.role::text NOT IN ('admin', 'super_admin')
       AND admins_with_passkeys(p_excluding_player => OLD.id) = 0
    THEN
      RAISE EXCEPTION 'This is the only admin with a passkey. Give another admin a passkey before demoting this one.'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Banning. THE FOURTH WAY, and the only one an exec can reach.
    -- players.ban.write is exec-level, and since 00140 a banned admin fails
    -- is_admin() (45 RLS policies) and is refused by requireAdminPlayer, so
    -- a ban now takes a door away exactly as a demotion does. The TRANSITION
    -- is guarded, not the value: gating on NEW.is_banned alone would raise on
    -- every later UPDATE against an already-banned admin, the unban included.
    IF OLD.role::text IN ('admin', 'super_admin') AND NEW.is_banned AND NOT OLD.is_banned
       AND admins_with_passkeys(p_excluding_player => OLD.id) = 0
    THEN
      RAISE EXCEPTION 'This is the only admin with a passkey. Give another admin a passkey before banning this one.'
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- Deletion. The cascade to passkey_credentials would otherwise trip the
  -- delete guard above with a message about credentials, which is a confusing
  -- way to be told you are removing your own last way in.
  IF OLD.role::text IN ('admin', 'super_admin') AND admins_with_passkeys(p_excluding_player => OLD.id) = 0 THEN
    RAISE EXCEPTION 'This is the only admin with a passkey. Give another admin a passkey before deleting this account.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$function$;

-- ===========================================================================
-- guard_player_privileged_columns: 00292's body, plus the super admin arm
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- THE OPENING IS 00131'S, NOT THIS FILE'S ORIGINAL.
  --
  -- This migration was written in parallel with 00131, from a body that
  -- predated it, and shipped `IF auth.uid() IS NULL OR is_admin(auth.uid())`.
  -- Applied in order that silently reverted 00131's hardening: auth.uid() is
  -- NULL for `anon` as well as for the service-role console, so the guard
  -- returned early for an unauthenticated caller. The table-grant revokes in
  -- 00128/00131 mask it today; any future anon grant would unmask it.
  --
  -- BOTH halves are required: current_user alone would admit a member inside a
  -- postgres-owned SECURITY DEFINER function, and auth.uid() alone is what let
  -- anon through.
  IF (current_user = 'service_role' OR current_user NOT IN ('anon', 'authenticated'))
     AND auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- 00321: THE TOP TWO LEVELS ARE THE SUPER ADMIN'S TO HAND OUT. Ahead of the
  -- admin return below, which would otherwise let an admin on the browser key
  -- write role = 'super_admin' onto their own row. Making or unmaking an admin
  -- or a super admin needs a super admin. The service-role console and a
  -- superuser session returned above; the console asks the same question in
  -- setConsoleAccess. ::text because the label is new in this transaction.
  IF auth.uid() IS NOT NULL
     AND NOT public.is_super_admin(auth.uid())
     AND ((TG_OP = 'INSERT' AND NEW.role::text IN ('admin', 'super_admin'))
          OR (TG_OP = 'UPDATE'
              AND NEW.role IS DISTINCT FROM OLD.role
              AND (OLD.role::text IN ('admin', 'super_admin')
                   OR NEW.role::text IN ('admin', 'super_admin')))) THEN
    RAISE EXCEPTION 'Only a super admin may make or unmake an admin';
  END IF;

  -- An admin editing a row from the player app, on the browser key.
  -- auth.uid() IS NOT NULL first, so this branch can never be the one that
  -- decides an anonymous request.
  IF auth.uid() IS NOT NULL AND is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A self-created row may only ever be an ordinary, unapproved member.
    IF COALESCE(NEW.is_exec, FALSE)
       OR COALESCE(NEW.is_trainer, FALSE)
       OR COALESCE(NEW.fee_exempt, FALSE)
       OR COALESCE(NEW.is_banned, FALSE)
       OR NEW.role IS DISTINCT FROM 'player'
       OR NEW.status IS DISTINCT FROM 'pending_approval'
       -- Added: a self-created row claiming an office is the same escalation as
       -- editing one in, and get_executives() would publish it.
       OR NEW.exec_title IS NOT NULL
       -- REPLACES 00086's portfolio line, for the same reason it existed: a
       -- self-created row cannot be an exec at all (is_exec is refused above),
       -- so permissions on one are meaningless, but they must not be a way to
       -- pre-stage values that come into force the moment an admin grants
       -- is_exec. cardinality(), not IS NOT NULL: see the note above.
       OR NEW.permission_role IS NOT NULL
       OR cardinality(COALESCE(NEW.permission_grants, '{}')) > 0
       OR cardinality(COALESCE(NEW.permission_revokes, '{}')) > 0
       -- Added by 00092: signing up is not the club letting you in, so a signup
       -- that arrives already numbered is claiming a membership nobody granted.
       OR NEW.member_code IS NOT NULL
       -- Added by 00132. Written only by ensure_player_for_user and cleared
       -- only by an admin resolving it; a row that arrives carrying one is
       -- inventing a claim decision nobody made.
       OR NEW.privilege_claim_review IS NOT NULL
       -- Added by 00164, for the line above's reason. Written only by
       -- merge_players; a signup carrying one is claiming to be the survivor of
       -- a merge that never happened, which would put a review badge on the
       -- roster pointing at nothing.
       OR NEW.elo_review IS NOT NULL
       -- 00093, restored alongside the UPDATE arm: pre-staging in its purest
       -- form, a label that grants nothing today and is filled in by the next
       -- edit to that baseline.
       OR NEW.permission_baseline_id IS NOT NULL
       OR COALESCE(NEW.is_guest, FALSE)
       OR NEW.guest_member_requested_by IS NOT NULL
       OR NEW.guest_member_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'Not authorized to create a privileged player row';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     -- Published to anonymous visitors by get_executives(), so an unguarded
     -- write is a public claim to an office the member does not hold, not a
     -- cosmetic field on their own profile.
     OR NEW.exec_title   IS DISTINCT FROM OLD.exec_title
     -- ADDED BY 00225, and it is the line above's reason read the other way
     -- round. exec_title is guarded because a member must not put THEMSELVES
     -- on the public page; this is guarded because a member must not take
     -- themselves OFF it. Who the club presents as its officers is the club's
     -- call in both directions, and an unguarded UPDATE here would let the one
     -- person with a motive to disappear do it without an exec ever seeing.
     OR NEW.exec_hidden  IS DISTINCT FROM OLD.exec_hidden
     -- THE 00087 REPLACEMENT for 00086's portfolio line. All three, because
     -- omitting any one of them leaves a complete escalation path: the role
     -- alone chooses the base, a grant alone adds to it, and clearing a revoke
     -- alone hands back whatever the club took away.
     OR NEW.permission_role IS DISTINCT FROM OLD.permission_role
     OR NEW.permission_grants IS DISTINCT FROM OLD.permission_grants
     OR NEW.permission_revokes IS DISTINCT FROM OLD.permission_revokes
     -- Added by 00092. Assigned once by assign_member_code() and permanent;
     -- there is no legitimate self-edit, including clearing it.
     OR NEW.member_code IS DISTINCT FROM OLD.member_code
     -- Added by 00132. Setting it is meaningless and clearing it erases an
     -- admin's only durable prompt to review a privilege the member did not
     -- get. See the section header.
     OR NEW.privilege_claim_review IS DISTINCT FROM OLD.privilege_claim_review
     -- Added by 00164. THE POINT OF THIS MIGRATION: the member this flag is
     -- about is the one person with a motive to clear it, and an unqualified
     -- UPDATE reached it without needing SELECT on the table.
     OR NEW.elo_review IS DISTINCT FROM OLD.elo_review
     -- 00093's fourth, RESTORED: this file dropped it. It is a promise of
     -- access rather than access itself, and clearing it makes baseline
     -- propagation skip the member, so a capability the club revoked stays
     -- revoked for everyone except them.
     OR NEW.permission_baseline_id IS DISTINCT FROM OLD.permission_baseline_id
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer
     -- is_guest (00292) keeps a record off the dues lists and silent, so a member
     -- may not set it. The one change allowed is the flag clearing in the same
     -- update that claims the record at first sign-in.
     OR (NEW.is_guest IS DISTINCT FROM OLD.is_guest
         AND NOT (OLD.is_guest AND NOT NEW.is_guest
                  AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL))
     -- The ask to make a guest a member: the console's, never a member's. The
     -- claim trigger above clears it, which is the same update as the flag.
     OR ((NEW.guest_member_requested_by IS DISTINCT FROM OLD.guest_member_requested_by
          OR NEW.guest_member_requested_at IS DISTINCT FROM OLD.guest_member_requested_at)
         AND NOT (OLD.is_guest AND NOT NEW.is_guest
                  AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

-- ===========================================================================
-- reset_console_passkey_grace: 00262's body, the admin tier
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.reset_console_passkey_grace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.user_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE'
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR (
       (OLD.role::text IN ('admin', 'super_admin') OR COALESCE(OLD.is_exec, false) OR COALESCE(OLD.is_trainer, false))
       AND NOT (NEW.role::text IN ('admin', 'super_admin') OR COALESCE(NEW.is_exec, false) OR COALESCE(NEW.is_trainer, false))
     ) THEN
    DELETE FROM public.console_passkey_grace WHERE user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$function$;

-- ===========================================================================
-- trigger_check_noshow_threshold: 00004's body, the admin tier
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.trigger_check_noshow_threshold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_threshold INTEGER;
  v_suspend_threshold INTEGER;
BEGIN
  IF NEW.no_shows > OLD.no_shows THEN
    -- Get thresholds from platform_settings
    SELECT COALESCE((value->>'no_show_auto_flag_threshold')::INTEGER, 3)
    INTO v_threshold FROM platform_settings WHERE key = 'walkover_rules';

    SELECT COALESCE((value->>'no_show_auto_suspend_threshold')::INTEGER, 5)
    INTO v_suspend_threshold FROM platform_settings WHERE key = 'walkover_rules';

    -- Auto-flag
    IF NEW.no_shows >= v_threshold THEN
      UPDATE reliability_metrics SET walkover_flag = TRUE WHERE id = NEW.id;

      -- Create admin notification
      INSERT INTO notifications (player_id, type, title, body, metadata)
      SELECT p.id, 'admin_alert',
        'Player flagged for repeated no-shows',
        format('%s has %s no-shows', pl.full_name, NEW.no_shows),
        jsonb_build_object('flagged_player_id', NEW.player_id, 'no_shows', NEW.no_shows)
      FROM players p
      CROSS JOIN players pl
      WHERE p.role::text IN ('admin', 'super_admin') AND pl.id = NEW.player_id;
    END IF;

    -- Auto-suspend check
    IF NEW.no_shows >= v_suspend_threshold THEN
      UPDATE players SET status = 'suspended' WHERE id = NEW.player_id;

      INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
      VALUES (NULL, 'auto_suspend', 'player', NEW.player_id, NULL, jsonb_build_object('no_shows', NEW.no_shows),
        format('Auto-suspended: %s no-shows exceeded threshold of %s', NEW.no_shows, v_suspend_threshold));
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ===========================================================================
-- reject_registration_import_entry: 00291's body, alerting the admin tier
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.reject_registration_import_entry(p_entry_id uuid, p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_peek    registration_import_entries%ROWTYPE;
  v_entry   registration_import_entries%ROWTYPE;
  v_creator uuid;
  v_title   text;
BEGIN
  -- The event row first, as every sign-up and withdrawal takes it.
  SELECT * INTO v_peek FROM registration_import_entries WHERE id = p_entry_id;
  IF NOT FOUND OR v_peek.entrant_id IS DISTINCT FROM p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_peek.club_event_id IS NOT NULL THEN
    PERFORM 1 FROM club_events ce WHERE ce.id = v_peek.club_event_id FOR NO KEY UPDATE;
  END IF;

  SELECT * INTO v_entry FROM registration_import_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND OR v_entry.entrant_id IS DISTINCT FROM p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF NOT (v_entry.status = 'awaiting_member'
          OR (v_entry.status = 'entered' AND v_entry.club_event_id IS NOT NULL)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_waiting', 'status', v_entry.status);
  END IF;

  -- 00291: a club event form signs the member up at once, so "Not me" takes
  -- the sign-up back; the withdrawal trigger removes the unpaid fee.
  IF v_entry.status = 'entered' THEN
    DELETE FROM club_event_signups s
     WHERE s.event_id = v_entry.club_event_id AND s.player_id = p_player_id;
  END IF;

  UPDATE registration_import_entries
     SET status = 'refused', reason = 'not_me', updated_at = now()
   WHERE id = p_entry_id;

  SELECT f.created_by,
         COALESCE(t.name, ce.title, 'a form')
    INTO v_creator, v_title
    FROM registration_imports i
    JOIN registration_import_forms f ON f.id = i.binding_id
    LEFT JOIN tournaments t ON t.id = f.tournament_id
    LEFT JOIN club_events ce ON ce.id = f.club_event_id
   WHERE i.id = v_entry.import_id;

  INSERT INTO notifications (player_id, type, title, body, metadata)
  SELECT p.id, 'admin_alert', 'A form entry was not theirs',
         format('A member says a response to the form for %s used their email but was not them. Check the imported entries.', v_title),
         jsonb_build_object('kind', 'registration_import_rejected', 'entry_id', p_entry_id)
    FROM players p
   WHERE (v_creator IS NOT NULL AND p.id = v_creator)
      OR (v_creator IS NULL AND p.role::text IN ('admin', 'super_admin'));

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (p_player_id, 'registration_import_rejected', 'registration_import_entry', p_entry_id,
          jsonb_build_object('import_id', v_entry.import_id, 'was', v_entry.status),
          'A member said a form response was not theirs');

  RETURN jsonb_build_object('ok', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.reject_registration_import_entry(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_registration_import_entry(uuid, uuid) TO service_role;

-- ===========================================================================
-- club_change_from_platform_settings: 00318's body, console_pages drafts nothing
-- ===========================================================================

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
  -- A kill switch and a console page switch are console-only, never member
  -- news: no draft. (console_pages is 00321's.)
  IF NEW.key IN ('release_flags', 'console_pages') THEN
    RETURN NULL;
  END IF;

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
REVOKE ALL ON FUNCTION public.club_change_from_platform_settings() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- purgeable_inactive_players: 00064's view, a super admin is never purgeable
-- ===========================================================================

CREATE OR REPLACE VIEW purgeable_inactive_players AS
SELECT
  p.id,
  p.user_id,
  p.inactive_since,
  -- Returned so the job can log WHY without recomputing the cutoff.
  (SELECT GREATEST(COALESCE((value ->> 'purge_after_days')::INT, 365), 30)
     FROM platform_settings WHERE key = 'inactivity_rules') AS purge_after_days
FROM players p
WHERE p.active_flag = FALSE
  AND p.inactive_since IS NOT NULL
  AND p.inactive_since < NOW() - (
        -- Threshold from settings, never a literal, so the job and the
        -- notice email cannot disagree about the retention period.
        -- COALESCE covers a settings row that predates 00063.
        (SELECT COALESCE((value ->> 'purge_after_days')::INT, 365)
           FROM platform_settings WHERE key = 'inactivity_rules')
      ) * INTERVAL '1 day'
  AND p.role::text NOT IN ('admin', 'super_admin')
  AND p.is_exec = FALSE
  AND p.is_banned = FALSE
  AND p.deletion_requested_at IS NULL
  AND p.status NOT IN ('suspended', 'pending_approval')
  AND (p.email IS NULL OR p.email NOT LIKE 'deleted+%@deleted.invalid');

-- ===========================================================================
-- Verify
-- ===========================================================================

DO $verify$
DECLARE
  v_bad text[] := '{}';
  v_sig text;
  v_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'user_role' AND e.enumlabel = 'super_admin'
  ) THEN
    v_bad := array_append(v_bad, 'user_role has no super_admin');
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.is_super_admin(uuid)',
    'public.is_admin(uuid)',
    'public.is_admin_or_coach(uuid)',
    'public.admin_access_level(uuid)',
    'public.admins_with_passkeys(uuid, uuid)',
    'public.guard_last_admin_passkey_delete()',
    'public.guard_last_admin_role()',
    'public.guard_player_privileged_columns()',
    'public.reset_console_passkey_grace()',
    'public.trigger_check_noshow_threshold()',
    'public.reject_registration_import_entry(uuid, uuid)'
  ] LOOP
    IF position('super_admin' IN pg_get_functiondef(v_sig::regprocedure)) = 0 THEN
      v_bad := array_append(v_bad, v_sig || ' does not know super_admin');
    END IF;
  END LOOP;

  v_def := pg_get_functiondef('public.guard_player_privileged_columns()'::regprocedure);
  IF position('is_super_admin(auth.uid())' IN v_def) = 0
     OR position('is_super_admin(auth.uid())' IN v_def) > position('is_admin(auth.uid()) THEN' IN v_def) THEN
    v_bad := array_append(v_bad, 'guard_player_privileged_columns does not ask for a super admin before the admin return');
  END IF;

  IF position('console_pages' IN pg_get_functiondef('public.admin_console_access(uuid)'::regprocedure)) = 0 THEN
    v_bad := array_append(v_bad, 'admin_console_access does not return console_pages');
  END IF;
  IF position('console_pages' IN pg_get_functiondef('public.club_change_from_platform_settings()'::regprocedure)) = 0 THEN
    v_bad := array_append(v_bad, 'club_change_from_platform_settings still drafts a console page switch');
  END IF;
  IF position('super_admin' IN pg_get_viewdef('public.purgeable_inactive_players'::regclass)) = 0 THEN
    v_bad := array_append(v_bad, 'purgeable_inactive_players can purge a super admin');
  END IF;

  -- Grants: RLS evaluates is_admin and is_admin_or_coach signed in, and anon
  -- may not ask (00208, 00230); the console calls the level and access
  -- functions signed in.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.is_super_admin(uuid)', 'public.is_admin(uuid)', 'public.is_admin_or_coach(uuid)',
    'public.admin_access_level(uuid)', 'public.admin_console_access(uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      v_bad := array_append(v_bad, v_sig || ' is executable by anon or not by authenticated');
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY[
    'public.admins_with_passkeys(uuid, uuid)', 'public.reject_registration_import_entry(uuid, uuid)',
    'public.club_change_from_platform_settings()'
  ] LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      v_bad := array_append(v_bad, v_sig || ' is executable by anon or authenticated');
    END IF;
  END LOOP;

  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION '00321 verify failed: %', array_to_string(v_bad, '; ');
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
