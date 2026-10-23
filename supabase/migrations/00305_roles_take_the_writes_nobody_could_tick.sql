-- The club's roles take the writes that were never tickable.
--
-- Until 2026-10-23 the permission editor could only offer a hand-kept list,
-- and nobody added the club events writes (00244), challenges, walkovers,
-- disputes, tournament fees or most money writes to it. The editor now offers
-- everything outside the admin areas, and the owner asked for the roles to be
-- filled in for him rather than ticked one by one.
--
-- EACH WRITE FOLLOWS A WRITE THE ROLE ALREADY HOLDS, not a role name, so a
-- renamed role still matches and running this twice adds nothing:
--
--   holds sessions.create.write          gets the six club events writes
--   holds sessions.attendance.write      gets club event check-in
--   holds matches.create.write           gets challenges, walkovers, disputes
--   holds tournaments.manage.create.write gets the five tournament fee writes
--   is the built-in Finance role         gets the club money writes
--
-- Admin-only stays admin-only: merging or removing players, legal text and
-- posting club changes are left for the owner to hand out by person.
--
-- PEOPLE ON A ROLE HOLD A COPY of it (00093), so each holder gets the same
-- additions, skipping anything they were deliberately revoked. Every changed
-- role leaves a permission_baseline_updated audit row, as a console edit does.

BEGIN;

CREATE TEMP TABLE role_additions (anchor text, capability text) ON COMMIT DROP;
INSERT INTO role_additions VALUES
  ('sessions.create.write', 'events.manage.create.write'),
  ('sessions.create.write', 'events.manage.update.write'),
  ('sessions.create.write', 'events.manage.cancel.write'),
  ('sessions.create.write', 'events.manage.delete.write'),
  ('sessions.create.write', 'events.signups.checkin.write'),
  ('sessions.create.write', 'events.signups.remove.write'),
  ('sessions.attendance.write', 'events.signups.checkin.write'),
  ('matches.create.write', 'challenges.create.write'),
  ('matches.create.write', 'challenges.expire.write'),
  ('matches.create.write', 'walkovers.confirm.write'),
  ('matches.create.write', 'walkovers.reject.write'),
  ('matches.create.write', 'disputes.resolve.write'),
  ('tournaments.manage.create.write', 'tournaments.fees.tier.create.write'),
  ('tournaments.manage.create.write', 'tournaments.fees.tier.update.write'),
  ('tournaments.manage.create.write', 'tournaments.fees.tier.delete.write'),
  ('tournaments.manage.create.write', 'tournaments.fees.markpaid.write'),
  ('tournaments.manage.create.write', 'tournaments.fees.markunpaid.write'),
  ('finance', 'fees.expenses.update.write'),
  ('finance', 'fees.expenses.reimburse.write'),
  ('finance', 'fees.expenses.remove.write'),
  ('finance', 'fees.otherincome.add.write'),
  ('finance', 'fees.otherincome.remove.write'),
  ('finance', 'fees.clubfees.markpaid.write'),
  ('finance', 'fees.clubfees.markunpaid.write'),
  ('finance', 'fees.clubfees.waive.write'),
  ('finance', 'fees.clubfees.addmanual.write'),
  ('finance', 'fees.clubfees.removemanual.write'),
  ('finance', 'fees.reinstatements.write'),
  ('finance', 'fees.playerflags.write');

CREATE TEMP TABLE role_changes ON COMMIT DROP AS
SELECT b.id, b.name, b.capabilities AS before,
       array(SELECT DISTINCT a.capability FROM role_additions a
             WHERE (a.anchor = ANY (b.capabilities) OR a.anchor = b.builtin_role)
               AND NOT a.capability = ANY (b.capabilities)
             ORDER BY 1) AS added
FROM permission_baselines b;
DELETE FROM role_changes WHERE cardinality(added) = 0;

UPDATE permission_baselines b
SET capabilities = b.capabilities || c.added, updated_at = now()
FROM role_changes c WHERE c.id = b.id;

UPDATE players p
SET permission_grants = p.permission_grants || array(
      SELECT x FROM unnest(c.added) x
      WHERE NOT x = ANY (p.permission_grants) AND NOT x = ANY (coalesce(p.permission_revokes, '{}')))
FROM role_changes c
WHERE p.permission_baseline_id = c.id;

INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
SELECT NULL, 'permission_baseline_updated', 'permission_baseline', c.id,
       jsonb_build_object('name', c.name, 'capabilities', to_jsonb(c.before)),
       jsonb_build_object('name', c.name, 'capabilities', to_jsonb(c.before || c.added),
                          'added', to_jsonb(c.added),
                          'holders', (SELECT count(*) FROM players p WHERE p.permission_baseline_id = c.id)),
       'Migration 00305: roles take the writes the editor could not offer before 2026-10-23'
FROM role_changes c;

SELECT name, cardinality(added) AS added FROM role_changes ORDER BY name;

COMMIT;
