-- ============================================================
-- 00303 EACH SERVER TUNES ITS OWN AUTO MOD
--
-- 00302 gave every Discord server an on/off switch for the scam guard, now
-- called auto mod where people see it. Everything else was fixed in the bot:
-- one rule (three channels within two minutes) and one answer (a soft ban at
-- once). A server's admins know their own server better, so it all moves onto
-- its row. `scam_guard` stays the master switch, under its 00302 name.
--
-- THE RULES, each switched on or off:
--   automod_spray                the same post in automod_spray_channels
--                                channels (2 to 10) within
--                                automod_spray_window_minutes (1 to 10). The
--                                window is capped because the bot holds every
--                                account's recent posts in memory that long.
--   automod_flag_suspects        a lone post that reads like a giveaway gets a
--                                log entry. Never acted on.
--   automod_words                the server's own words. A post with one in it
--                                gets automod_words_action:
--                                  delete  deleted and logged (the default)
--                                  punish  deleted, and the author gets
--                                          automod_action
--                                  flag    logged only
--   automod_trap_channel_ids     channels nobody should post in. Any post there
--                                is caught, which is how a bot spraying every
--                                channel is stopped on its first message.
--   automod_trap_action          what a post in a trap channel gets, from the
--                                same four answers below. Its own setting,
--                                defaulting to a soft ban: nobody posts there
--                                by mistake once the bot's pinned warning is up.
--
-- THE ANSWER, automod_action, for a spray, a trap, or a punished word:
--   timeout_then_softban  a timeout the first time, a soft ban if the same
--                         account is caught again within a day. The default:
--                         a hacked account usually belongs to a real member,
--                         and a timeout stops it without kicking them.
--   timeout               only ever a timeout.
--   softban               a soft ban at once (what 00302 did).
--   flag                  a log entry, nothing else.
-- automod_timeout_minutes is the timeout's length (1 to 10080, a week).
--
-- EXISTING ROWS take the defaults, which changes the club's server from an
-- immediate soft ban to a timeout first. That is the owner's ask.
--
-- Nothing here is personal: switches, numbers, channel ids, and words a
-- server chose to block.
-- ============================================================

BEGIN;

ALTER TABLE public.discord_server_settings
  ADD COLUMN IF NOT EXISTS automod_action text NOT NULL DEFAULT 'timeout_then_softban'
    CHECK (automod_action IN ('timeout_then_softban', 'timeout', 'softban', 'flag')),
  ADD COLUMN IF NOT EXISTS automod_timeout_minutes integer NOT NULL DEFAULT 60
    CHECK (automod_timeout_minutes BETWEEN 1 AND 10080),
  ADD COLUMN IF NOT EXISTS automod_spray boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS automod_spray_channels integer NOT NULL DEFAULT 3
    CHECK (automod_spray_channels BETWEEN 2 AND 10),
  ADD COLUMN IF NOT EXISTS automod_spray_window_minutes integer NOT NULL DEFAULT 2
    CHECK (automod_spray_window_minutes BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS automod_flag_suspects boolean NOT NULL DEFAULT true,
  -- Bounded here as well as in the app, so the row the bot reads every
  -- minute for every server stays small.
  ADD COLUMN IF NOT EXISTS automod_words text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(automod_words) <= 100 AND length(array_to_string(automod_words, '')) <= 3000),
  ADD COLUMN IF NOT EXISTS automod_words_action text NOT NULL DEFAULT 'delete'
    CHECK (automod_words_action IN ('delete', 'punish', 'flag')),
  ADD COLUMN IF NOT EXISTS automod_trap_channel_ids text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(automod_trap_channel_ids) <= 10),
  ADD COLUMN IF NOT EXISTS automod_trap_action text NOT NULL DEFAULT 'softban'
    CHECK (automod_trap_action IN ('timeout_then_softban', 'timeout', 'softban', 'flag'));

DO $verify$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'discord_server_settings'
         AND column_name LIKE 'automod\_%') <> 10 THEN
    RAISE EXCEPTION '00303: the auto mod columns are missing';
  END IF;
  IF has_table_privilege('anon', 'public.discord_server_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.discord_server_settings', 'SELECT') THEN
    RAISE EXCEPTION '00303: discord_server_settings is readable by clients';
  END IF;
  RAISE NOTICE '00303 verified: % server row(s), each tunes its own auto mod.',
    (SELECT count(*) FROM public.discord_server_settings);
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
