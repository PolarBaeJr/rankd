-- ============================================================
-- 00286_club_changes.sql: officer edits become draft lines, and
-- post_club_changes posts them.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00286 applied:
--
--   docker exec -i supabase_db_cli psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/00286_club_changes.sql
--
-- An app write is simulated by setting request.jwt.claims, which is what
-- the API sets on every request and what a migration never sets.
--
-- WHAT IT PROVES
-- --------------
-- A. Two edits to one field (32 to 28 to 24) leave one line, from 32 to 24.
-- B. Editing it back to 32 deletes the line.
-- C. A write with no claims records nothing, even on a row whose updated_by
--    is already filled in (the 00261 shape), and an app write that does not
--    move updated_at records nothing either.
-- D. A first save of a row that did not exist records lines whose from value
--    is NULL.
-- E. A role created then deleted leaves nothing; reordering a role's
--    capabilities leaves nothing; renaming one leaves one line.
-- F. Manual lines can repeat.
-- G. post_club_changes posts the lines, deletes the drafts, writes exactly
--    one audit row, and refuses a stale revision and a missing id.
-- H. Every settings write above succeeded with the trigger in place.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name) VALUES
 ('eeeeeeee-0286-4000-8000-000000000001', 'club-changes-harness@example.invalid', 'ChangesAdmin');

DELETE FROM club_change_drafts;

DO $$
DECLARE
  admin_   CONSTANT uuid := 'eeeeeeee-0286-4000-8000-000000000001';
  role_    CONSTANT uuid := 'eeeeeeee-0286-4000-8000-0000000000b1';
  v_draft  club_change_drafts%ROWTYPE;
  v_count  int;
  v_entry  uuid;
  v_manual uuid[];
  v_ok     boolean;
BEGIN
  -- ---- setup: 32, written the way a migration writes ---------------------
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE platform_settings
     SET value = value || jsonb_build_object('singles_k_established', 32),
         updated_by = admin_, updated_at = clock_timestamp()
   WHERE key = 'rating_defaults';
  IF (SELECT count(*) FROM club_change_drafts) <> 0 THEN
    RAISE EXCEPTION 'C1: a write with no claims recorded a line';
  END IF;

  -- ---- A ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  UPDATE platform_settings
     SET value = value || jsonb_build_object('singles_k_established', 28),
         updated_by = admin_, updated_at = clock_timestamp()
   WHERE key = 'rating_defaults';
  UPDATE platform_settings
     SET value = value || jsonb_build_object('singles_k_established', 24),
         updated_by = admin_, updated_at = clock_timestamp()
   WHERE key = 'rating_defaults';
  SELECT * INTO v_draft FROM club_change_drafts;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF (SELECT count(*) FROM club_change_drafts) <> 1
     OR v_draft.source <> 'setting' OR v_draft.subject <> 'rating_defaults'
     OR v_draft.field <> 'singles_k_established'
     OR v_draft.from_value <> '32'::jsonb OR v_draft.to_value <> '24'::jsonb
     OR v_draft.revision <> 2 OR v_draft.first_actor_id <> admin_ THEN
    RAISE EXCEPTION 'A: expected one line from 32 to 24 at revision 2, got %', row_to_json(v_draft);
  END IF;

  -- ---- B ------------------------------------------------------------------
  UPDATE platform_settings
     SET value = value || jsonb_build_object('singles_k_established', 32.0),
         updated_by = admin_, updated_at = clock_timestamp()
   WHERE key = 'rating_defaults';
  IF (SELECT count(*) FROM club_change_drafts) <> 0 THEN
    RAISE EXCEPTION 'B: an edit back to 32 left a line';
  END IF;

  -- ---- C ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE platform_settings
     SET value = value || jsonb_build_object('singles_k_established', 40),
         updated_at = clock_timestamp()
   WHERE key = 'rating_defaults';
  IF (SELECT count(*) FROM club_change_drafts) <> 0 THEN
    RAISE EXCEPTION 'C2: a migration-shaped update on an officer-saved row recorded a line';
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  UPDATE platform_settings
     SET value = value || jsonb_build_object('singles_k_established', 44)
   WHERE key = 'rating_defaults';
  IF (SELECT count(*) FROM club_change_drafts) <> 0 THEN
    RAISE EXCEPTION 'C3: an app write that did not move updated_at recorded a line';
  END IF;

  -- ---- D ------------------------------------------------------------------
  DELETE FROM platform_settings WHERE key = 'features';
  INSERT INTO platform_settings (key, value, updated_by, updated_at)
  VALUES ('features', '{"sessions_enabled": true, "challenges_enabled": false}', admin_, clock_timestamp());
  IF (SELECT count(*) FROM club_change_drafts WHERE subject = 'features') <> 2
     OR EXISTS (SELECT 1 FROM club_change_drafts WHERE subject = 'features' AND from_value IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM club_change_drafts
                     WHERE subject = 'features' AND field = 'challenges_enabled' AND to_value = 'false'::jsonb) THEN
    RAISE EXCEPTION 'D: a first save did not record two lines from NULL';
  END IF;
  DELETE FROM club_change_drafts;

  -- ---- E ------------------------------------------------------------------
  INSERT INTO permission_baselines (id, name, capabilities, created_by, updated_by)
  VALUES (role_, 'Harness role', ARRAY['matches.page', 'challenges.page'], admin_, admin_);
  IF (SELECT count(*) FROM club_change_drafts WHERE source = 'baseline') <> 1 THEN
    RAISE EXCEPTION 'E1: creating a role did not record a line';
  END IF;
  DELETE FROM permission_baselines WHERE id = role_;
  IF (SELECT count(*) FROM club_change_drafts) <> 0 THEN
    RAISE EXCEPTION 'E2: a role created then deleted left a line';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO permission_baselines (id, name, capabilities, created_by, updated_by)
  VALUES (role_, 'Harness role', ARRAY['matches.page', 'challenges.page'], admin_, admin_);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  UPDATE permission_baselines
     SET capabilities = ARRAY['challenges.page', 'matches.page', 'matches.page'],
         updated_by = admin_, updated_at = clock_timestamp()
   WHERE id = role_;
  IF (SELECT count(*) FROM club_change_drafts) <> 0 THEN
    RAISE EXCEPTION 'E3: reordering capabilities recorded a line';
  END IF;
  UPDATE permission_baselines
     SET name = 'Harness role two', updated_by = admin_, updated_at = clock_timestamp()
   WHERE id = role_;
  IF (SELECT count(*) FROM club_change_drafts WHERE source = 'baseline' AND subject = role_::text) <> 1
     OR (SELECT to_value->>'name' FROM club_change_drafts WHERE subject = role_::text) <> 'Harness role two'
     OR (SELECT from_value->>'name' FROM club_change_drafts WHERE subject = role_::text) <> 'Harness role' THEN
    RAISE EXCEPTION 'E4: renaming a role did not record one line from the old name to the new';
  END IF;

  -- ---- F ------------------------------------------------------------------
  INSERT INTO club_change_drafts (source, text_override, first_actor_id, last_actor_id)
  VALUES ('manual', 'Courts 3 and 4 are now doubles only.', admin_, admin_),
         ('manual', 'Courts 3 and 4 are now doubles only.', admin_, admin_);
  SELECT array_agg(id ORDER BY id) INTO v_manual FROM club_change_drafts WHERE source = 'manual';
  IF cardinality(v_manual) <> 2 THEN
    RAISE EXCEPTION 'F: two identical manual lines did not both stay';
  END IF;

  -- ---- G ------------------------------------------------------------------
  -- A stale revision is refused and nothing moves.
  v_ok := false;
  BEGIN
    PERFORM post_club_changes(admin_, ARRAY[v_manual[1]], ARRAY[99], ARRAY['A line'],
                              ARRAY[]::uuid[], ARRAY[]::int[], NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLERRM LIKE 'stale_changed:%';
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'G1: a stale revision was not refused as stale_changed'; END IF;

  v_ok := false;
  BEGIN
    PERFORM post_club_changes(admin_, ARRAY[gen_random_uuid()], ARRAY[1], ARRAY['A line'],
                              ARRAY[]::uuid[], ARRAY[]::int[], NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLERRM LIKE 'stale_missing:%';
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'G2: a missing id was not refused as stale_missing'; END IF;

  v_ok := false;
  BEGIN
    PERFORM post_club_changes(admin_, ARRAY[v_manual[1]], ARRAY[1], ARRAY['   '],
                              ARRAY[]::uuid[], ARRAY[]::int[], NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLERRM LIKE 'bad_lines:%';
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'G3: an empty line was not refused as bad_lines'; END IF;

  v_entry := post_club_changes(
    admin_,
    ARRAY[v_manual[1], (SELECT id FROM club_change_drafts WHERE source = 'baseline')],
    ARRAY[1, (SELECT revision FROM club_change_drafts WHERE source = 'baseline')],
    ARRAY['Courts 3 and 4 are now doubles only.', 'Officer role Harness role renamed to Harness role two'],
    ARRAY[v_manual[2]], ARRAY[1],
    'October changes', NULL);
  IF (SELECT jsonb_array_length(lines) FROM club_change_entries WHERE id = v_entry) <> 2
     OR (SELECT title FROM club_change_entries WHERE id = v_entry) <> 'October changes'
     OR (SELECT posted_by FROM club_change_entries WHERE id = v_entry) <> admin_ THEN
    RAISE EXCEPTION 'G4: the entry was not written as posted';
  END IF;
  IF (SELECT count(*) FROM club_change_drafts) <> 0 THEN
    RAISE EXCEPTION 'G5: the posted and discarded drafts were not deleted';
  END IF;
  IF (SELECT count(*) FROM audit_logs
       WHERE action_type = 'club_changes_posted' AND target_id = v_entry AND actor_id = admin_) <> 1 THEN
    RAISE EXCEPTION 'G6: posting did not write exactly one audit row';
  END IF;

  RAISE NOTICE '00286 harness: coalescing, the edit back, the app-write guard, first saves, roles, manual lines and posting all behave.';
END $$;

ROLLBACK;
