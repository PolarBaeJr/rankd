-- 00167 — Guild/role mapping and the audit channel, moved into the database.
--
-- WHY THESE TWO AND NOT THE REST
--
-- The bot's other settings — public key, bot token, application id, service
-- secret — are properties of the DEPLOYMENT. They change when you rotate a
-- credential, which is already a deploy, so env is the right home for them and
-- they stay there.
--
-- These two are properties of the SERVER, and they change while the code stands
-- still: somebody creates a role, renames the audit channel, or the club adds a
-- second Discord server. Behind env each of those needs a compose recreate on
-- (redacted in export)
-- dashboard auto-updater recreates containers by cloning the previous one's env
-- rather than re-reading env_file — is the exact class of edit that has silently
-- failed to reach production before.
--
-- ---- WHY A RELATIONAL SHAPE AND NOT ONE JSON BLOB ----
--
-- DISCORD_GUILDS was a JSON object, and parseGuildRegistry validates it at boot:
-- an unknown role name throws rather than being skipped, because a silently
-- skipped role is a member quietly missing @Internal forever. Moving that JSON
-- into a text column would move the validation to whenever the bot next
-- restarts, which is precisely the restart this migration exists to avoid.
--
-- A CHECK constraint on role_name enforces the same rule at write time instead.
-- A typo is rejected by the INSERT, at the keyboard of whoever made it, rather
-- than at 03:50 the following morning by a sweep nobody is watching.

-- ---- 1. THE GUILDS --------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.discord_guilds (
  guild_id    text PRIMARY KEY,
  -- Purely a note to the reader. Discord guild ids are opaque 18-19 digit
  -- snowflakes and this table will eventually be read by somebody trying to
  -- work out which server "1174...820" is.
  label       text,
  -- Lets a server be parked without deleting its role mapping. Deleting the row
  -- cascades the roles away, so re-enabling would mean re-entering all nine ids
  -- off Discord's UI by hand.
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- 2. THE ROLE MAP ------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.discord_guild_roles (
  guild_id   text NOT NULL REFERENCES public.discord_guilds(guild_id) ON DELETE CASCADE,
  -- MUST match MANAGED_ROLES in apps/bot/src/roles.ts exactly. If a role is
  -- ever added there, add it here in the same migration - the two lists
  -- disagreeing is a role the bot understands but the database refuses to
  -- store, which presents as a role that simply never applies.
  role_name  text NOT NULL CHECK (role_name IN (
               'linked', 'session_staff', 'vp', 'executives',
               'competitive', 'recreation', 'internal', 'alumni', 'external')),
  role_id    text NOT NULL CHECK (role_id ~ '^[0-9]{5,25}$'),
  PRIMARY KEY (guild_id, role_name)
);

-- ---- 3. EVERYTHING ELSE ---------------------------------------------------

CREATE TABLE IF NOT EXISTS public.discord_settings (
  key    text PRIMARY KEY,
  value  text
);

COMMENT ON TABLE public.discord_settings IS
  'Runtime bot settings. Known keys: audit_channel_id.';

-- ---- 4. LOCK ALL THREE ----------------------------------------------------
--
-- Same posture as 00165. Nothing here is secret - a role id is visible to every
-- member of the server - but the bot reads these through the app's service-role
-- client like everything else, and a table anon can read is a table anon can be
-- confused into reading somewhere it should not.

ALTER TABLE public.discord_guilds      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_guild_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_settings    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_guilds FROM PUBLIC;
REVOKE ALL ON public.discord_guilds FROM anon, authenticated;
GRANT ALL  ON public.discord_guilds TO service_role;

REVOKE ALL ON public.discord_guild_roles FROM PUBLIC;
REVOKE ALL ON public.discord_guild_roles FROM anon, authenticated;
GRANT ALL  ON public.discord_guild_roles TO service_role;

REVOKE ALL ON public.discord_settings FROM PUBLIC;
REVOKE ALL ON public.discord_settings FROM anon, authenticated;
GRANT ALL  ON public.discord_settings TO service_role;

-- PostgREST caches the schema. Without this the new tables read as "relation
-- does not exist" through the API while psql sees them perfectly - and a failed
-- PostgREST read arrives as an EMPTY LIST, not an error, so the bot would report
-- "no guilds registered" and sweep nothing.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- OWNER-RUN, AFTER THE MIGRATION
--
-- Fill these in from Discord (Developer Mode on, right-click -> Copy ID). The
-- bot picks up changes on its next operation; there is no restart.
--
--   INSERT INTO discord_guilds (guild_id, label)
--   VALUES ('<guild id>', 'Club Ladder - staging test server')
--   ON CONFLICT (guild_id) DO UPDATE SET label = EXCLUDED.label;
--
--   INSERT INTO discord_guild_roles (guild_id, role_name, role_id) VALUES
--     ('<guild id>', 'linked',       '<role id>'),
--     ('<guild id>', 'session_staff','<role id>'),
--     ('<guild id>', 'vp',           '<role id>'),
--     ('<guild id>', 'executives',   '<role id>'),
--     ('<guild id>', 'competitive',  '<role id>'),
--     ('<guild id>', 'recreation',   '<role id>'),
--     ('<guild id>', 'internal',     '<role id>'),
--     ('<guild id>', 'alumni',       '<role id>'),
--     ('<guild id>', 'external',     '<role id>')
--   ON CONFLICT (guild_id, role_name) DO UPDATE SET role_id = EXCLUDED.role_id;
--
--   INSERT INTO discord_settings (key, value)
--   VALUES ('audit_channel_id', '<channel id>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- You do not have to enter all nine. A role the bot never sees is simply never
-- applied - which is the supported way to run without, say, an @Alumni role.
--
-- To check what the bot will actually see:
--
--   SELECT g.guild_id, g.label, g.enabled,
--          jsonb_object_agg(r.role_name, r.role_id) FILTER (WHERE r.role_name IS NOT NULL) AS roles
--     FROM discord_guilds g
--     LEFT JOIN discord_guild_roles r ON r.guild_id = g.guild_id
--    GROUP BY g.guild_id, g.label, g.enabled;
-- ============================================================================
