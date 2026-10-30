-- ============================================================
-- 00302 EACH DISCORD SERVER KEEPS ITS OWN SETTINGS
--
-- The bot runs in any server (a15e945d), but everything it could be told was
-- the club's: discord_settings has key as its whole primary key, so a second
-- server had nowhere to put "post my server log here". Some settings are about
-- one server and nobody else's, so they move to a row per server:
--
--   1. discord_server_settings: one row per Discord server, keyed by its id.
--      The server log channel, and whether the scam guard acts there. No FK
--      onto discord_guilds, because that table is the CLUB'S servers and this
--      one is for any server the bot is in.
--
--      The scam guard defaults OFF. Banning people in somebody else's server
--      is theirs to switch on. The club's servers are seeded ON below, which
--      is what prod does today.
--
--   2. The club's current server log channel is copied into each club
--      server's row, so nothing goes quiet. The discord_settings key is LEFT
--      IN PLACE, because the bot running when this is applied still reads it.
--      The new bot reads only the row. Apply this, then deploy, with no
--      /config server_log change in between. Delete the key once it is live.
--
--   3. discord_self_roles drops its FK onto discord_guilds, so /rolepicker
--      works in any server. Nothing else reads the table across servers: the
--      session ping fallback filters by guild and reads only rows with a
--      `track`, which /rolepicker cannot set.
--
-- WHO MAY WRITE A ROW is the bot's and the app route's business (Manage
-- Server in that server, plus the club check in a club server). The table
-- itself is service role only, like every other discord_* table.
--
-- Nothing here is personal: server, channel and role ids, and a flag.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.discord_server_settings (
  guild_id              text PRIMARY KEY CHECK (guild_id ~ '^[0-9]{17,20}$'),
  server_log_channel_id text CHECK (server_log_channel_id IS NULL OR server_log_channel_id ~ '^[0-9]{17,20}$'),
  scam_guard            boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.discord_server_settings IS
  'Settings that belong to one Discord server, for any server the bot is in (00302). The club''s own settings stay in discord_settings.';

ALTER TABLE public.discord_server_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discord_server_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.discord_server_settings TO service_role;

-- The club's servers, as they behave today: the guard on, and the club's log
-- channel carried over. A channel id that would fail the CHECK is left out
-- rather than aborting the migration.
INSERT INTO public.discord_server_settings (guild_id, server_log_channel_id, scam_guard)
SELECT g.guild_id,
       (SELECT s.value FROM public.discord_settings s
         WHERE s.key = 'server_log_channel_id' AND s.value ~ '^[0-9]{17,20}$'),
       true
  FROM public.discord_guilds g
 WHERE g.enabled
   AND g.guild_id ~ '^[0-9]{17,20}$'
ON CONFLICT (guild_id) DO NOTHING;

ALTER TABLE public.discord_self_roles
  DROP CONSTRAINT IF EXISTS discord_self_roles_guild_id_fkey;

DO $verify$
BEGIN
  IF has_table_privilege('anon', 'public.discord_server_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.discord_server_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.discord_server_settings', 'INSERT') THEN
    RAISE EXCEPTION '00302: discord_server_settings is readable or writable by clients';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.discord_self_roles'::regclass AND contype = 'f'
                AND confrelid = 'public.discord_guilds'::regclass) THEN
    RAISE EXCEPTION '00302: discord_self_roles still references discord_guilds';
  END IF;
  RAISE NOTICE '00302 verified: % server row(s), each Discord server keeps its own settings.',
    (SELECT count(*) FROM public.discord_server_settings);
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
