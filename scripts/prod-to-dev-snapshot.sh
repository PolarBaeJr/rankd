#!/usr/bin/env bash
# prod-to-dev-snapshot.sh
#
# Online dump of prod Supabase Postgres into the dev Supabase Postgres,
# no prod downtime. pg_dump uses MVCC; concurrent writes during the
# snapshot are tolerated.
#
# Runs entirely through `docker exec`, so the Pi host doesn't need
# postgresql-client installed.
#
# Scope:
#   - public schema (full drop and recreate)  — all app data
#   - auth.users + auth.identities            — keeps player.user_id FKs valid
# Skipped: prod auth sessions / refresh_tokens / etc. The keep-list admins'
# own staging sessions and passkeys are carried across (KEEP THE STAGING
# ADMINS SIGNED IN, below); everyone else's go with the truncate.
#
# Two things are deliberately NOT faithful copies of prod afterwards, because a
# faithful copy is the wrong answer for both:
#   - Discord config is staging's own, never prod's (see the capture/scrub pair
#     below) — inheriting prod's would aim the staging bot at the real guild.
#   - $STAGING_ADMIN_EMAILS are re-granted admin on staging, because prod roles
#     leave the owner unable to use the staging admin console at all.
#   - THE MEMBERS ARE SCRUBBED. Names, emails, phones, bios, officer notes,
#     audit diffs and every bearer token are replaced or deleted at the end of
#     the run, because staging is on the public internet and is where untested
#     code gets deployed on purpose. Ids, ratings, matches and row counts are
#     kept, so it stays a realistic rehearsal. See "SCRUB THE MEMBERS" below.
#
# Idempotent. Safe to re-run. Existing dev DB rows in those scopes are wiped,
# and so is anything in dev's public schema that prod does not have — see
# "the drop is explicit" below.
#
# Usage:
#   ./prod-to-dev-snapshot.sh
#
# Cron (4am daily), and READ THE PATH:
#   0 4 * * * /home/polarbaejr/ssd/Deploy/badminton-staging/scripts/prod-to-dev-snapshot.sh \
#     >> /home/polarbaejr/ssd/Deploy/badminton-snapshots/cron.log 2>&1
#
# ---------------------------------------------------------------------------
# THERE ARE TWO CHECKOUTS ON THE PI AND THE CRON USES THE ONE YOU DO NOT EXPECT.
#
# ~/ssd/Deploy/badminton            stale. Last commit `b96dc74b`, months behind
#                                   production, on branch fixup/security-and-cleanup,
#                                   with a dirty docker-compose.yml and an
#                                   untracked backup/ directory. Its copy of this
#                                   script is the July version with the dead
#                                   container names. NOTHING RUNS IT.
# ~/ssd/Deploy/badminton-staging    LIVE. Branch deploy/docker-staging, clean.
#                                   This is what the crontab calls, and it is the
#                                   only copy that matters.
#
# Editing this file in the repo changes nothing on the Pi by itself: that is a
# plain checkout and nothing auto-updates it, unlike the player and admin
# images. A change here reaches production behaviour only after this branch is
# merged to deploy/docker-staging AND someone runs `git pull` in
# ~/ssd/Deploy/badminton-staging. Verified 2026-09-22 by reading both.
#
# HISTORY, because the header used to say the opposite. This script did fail
# every night from 7 July 2026 on container names that do not exist
# (`supabase_db_badminton` / `..._dev`). That was fixed and merged to
# deploy/docker-staging, and it has been running successfully since: the live
# copy is dated 27 August and cron.log's last entry is a clean completion. The
# earlier "IT HAS NOT RUN SINCE 7 JULY" banner here was describing the stale
# checkout above, which still has the broken names, and it was wrong about the
# one that runs. It is now copying real production members nightly, which is
# exactly why the scrub at the bottom of this file exists.
#
# So read (1)-(3) below as "what would have happened, measured on throwaway
# clusters", NOT as "what has been happening nightly". In particular the blanket GRANT in
# (2) has not been re-opening `anon`'s access every night for the last six weeks,
# because it has not been reached. Whatever staging drift 00157 cleans up
# predates 7 July.
# ---------------------------------------------------------------------------
# THREE THINGS THIS SCRIPT USED TO GET WRONG, and TWO GUARDS THE FIXES NEEDED.
# All of it was reproduced on a pair of throwaway Postgres 16 clusters before
# being changed here, because every one of these fails SILENTLY on a database
# nobody watches.
#
# 1. THE DROP IS EXPLICIT NOW, because pg_dump's was not safe.
#    `pg_dump --schema=public --clean` emits a bare `DROP SCHEMA IF EXISTS
#    "public";` with no CASCADE. That succeeds only while dev's public schema
#    holds NOTHING that prod does not also have — and dev is the database where
#    migrations are rehearsed, so it is routinely ahead of prod. Staging carries
#    00123's `recompute_player_stats` today; prod does not. With one such object
#    present the DROP fails, and under `-v ON_ERROR_STOP=1` the ENTIRE restore
#    aborts at that line, after auth.users has already been truncated. Measured:
#    psql exits 3 and not a single prod table lands.
#    So the drop is now ours, with CASCADE, before anything else is touched, and
#    the dump is taken WITHOUT `--clean` so there is only one drop in play.
#    Its cascade NOTICEs are logged: they are the list of things dev had and
#    prod does not, which is worth seeing in the morning.
#
#    READ THIS BEFORE RE-ENABLING THE CRON. That list is not debris — on this
#    project it is usually THE MIGRATION YOU ARE CURRENTLY TESTING. A snapshot
#    resets staging to prod, so a migration applied to staging at 22:00 is gone
#    by 04:01. That was always the intent of the tool and it is what `--clean`
#    did too, on any night when it worked at all; what changed is that it now
#    reliably succeeds, so the effect is no longer masked by the abort in (1).
#    While you are rehearsing a migration on staging, either pause this cron or
#    expect to re-apply. The cascade NOTICEs in the log tell you exactly what
#    you will need to put back.
#
# 2. THE PRIVILEGES ARE MIRRORED, not blanket-granted.
#    `--no-acl` restores objects with no privileges at all, so something has to
#    put them back or the staging app gets "permission denied for schema
#    public" on every read. This script used to do that with
#    `GRANT ALL ON ALL TABLES/FUNCTIONS ... TO anon, authenticated,
#    service_role` plus a matching ALTER DEFAULT PRIVILEGES. That handed the
#    browser key EVERYTHING, every night:
#      - `purgeable_inactive_players`, the members-queued-for-deletion view, is
#        security_invoker=false so RLS never applies to it. 00064:109 revokes it
#        by name; the blanket line gave it straight back. That is the staging
#        drift 00157 cleans up.
#      - every SECURITY DEFINER function 00126 took away from `anon`, returned.
#        And the ALTER DEFAULT PRIVILEGES line meant functions created by LATER
#        migrations were born anon-executable.
#    scripts/sql/mirror-public-acls.sql now reads prod's catalogue and emits
#    prod's OWN grants. Ablated: the blanket version diverges from prod on 9 of
#    60 privilege checks, all of them `purgeable_inactive_players` or the
#    anon-revoked function; the mirror diverges on 0 of 60.
#
# 3. THE REALTIME PUBLICATION IS PUT BACK.
#    Publication MEMBERSHIP is not in a `--schema=public` dump (grep it: zero
#    hits) and it dies with the tables. `supabase_realtime` therefore came back
#    still existing and completely empty, which is not an error anywhere — it is
#    every live badge and the whole door page quietly never updating again on
#    staging. scripts/sql/mirror-public-publications.sql re-adds prod's
#    membership. REPLICA IDENTITY needs no help; pg_dump does carry that.
#
# 4. THE CASCADE IN (1) IS ITSELF A NEW RISK, so it is gated.
#    The old drop could not cascade; ours can, and CASCADE reaches OUT of the
#    schema. A trigger on auth.users calling a public.handle_new_user(), an
#    extension installed into public, a foreign key from another schema into
#    public.players, a view elsewhere selecting from public, a column typed as a
#    public enum — CASCADE takes every one of them, and `--schema=public`
#    restores none of them. Signup would then write no player row, for ever,
#    with nothing in any log: the exact failure class the rest of this header is
#    about. Grepping the migrations says this repo has no such dependent, but the
#    migrations are not the whole database — Supabase's init ran first, the owner
#    has run SQL by hand, and `CREATE EXTENSION IF NOT EXISTS` is a silent no-op
#    that reveals nothing about where the extension actually landed. So the
#    question is put to the live database every night instead:
#    scripts/sql/check-public-dependents.sql lists anything outside public that
#    depends on it, and any output is fatal BEFORE the drop. Ablated: a planted
#    auth.users trigger names itself and stops the run with dev untouched; the
#    same query returns zero rows once it is removed.
#
# 5. AN EMPTY PRIVILEGE MIRROR IS REFUSED.
#    The generator in (2) returning zero rows still exits 0, which would wipe
#    dev, restore it, apply a file of pure comments, and leave staging with no
#    grants — empty pages rather than an error, since a failed PostgREST read
#    arrives as an empty list. A floor of 20 statements is checked before the
#    drop. Ablated: a generator stubbed to return nothing refuses the run and
#    leaves dev's 64 grants in place. The publication generator gets the same
#    treatment, except that its floor has to be a COMPARISON against prod rather
#    than a threshold: zero blocks is the correct answer for a `FOR ALL TABLES`
#    publication, so a fixed minimum would block such a database every night.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# THE NAMES WERE WRONG, AND THAT IS WHY NOTHING HAS RUN SINCE 7 JULY 2026.
# `supabase_db_badminton` / `..._dev` do not exist on the Pi and have not for
# weeks: the stacks are compose projects `supabase` and `supabase-staging`
# (/mnt/ssd/Deploy/supabase-prod and /mnt/ssd/Deploy/supabase-staging), whose db
# services are plain `supabase-db` and `supabase-staging-db`. Verified from
# `com.docker.compose.project.working_dir`, not from the names alone — the names
# are suggestive, the label is proof. cron.log is 4,493 lines of
# "FATAL: container supabase_db_badminton is not running", one per night, and the
# newest real dump is public-20260707T110001Z.sql.gz.
#
# Overridable, because the next rename should be a one-line env change and not
# another six weeks of silence.
PROD_CONTAINER="${PROD_CONTAINER:-supabase-db}"
DEV_CONTAINER="${DEV_CONTAINER:-supabase-staging-db}"
OUT_DIR="${HOME}/ssd/Deploy/badminton-snapshots"
TS=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$OUT_DIR"

PUBLIC_DUMP="$OUT_DIR/public-$TS.sql.gz"
AUTH_DUMP="$OUT_DIR/auth-$TS.sql.gz"
ACL_SQL="$OUT_DIR/acls-$TS.sql"

# Staging's OWN Discord config, captured before the drop and put back after.
#
# NOT kept in $OUT_DIR with the other artefacts, and not retained: it contains
# cron_config.discord_service_secret in plaintext. 0600, and removed on every
# exit path including failure.
DISCORD_SQL="$(mktemp)"
DISCORD_RAW="$(mktemp)"
chmod 600 "$DISCORD_SQL" "$DISCORD_RAW"
# THE MEMBERS ARE EXPOSED BETWEEN THE RESTORE AND THE SCRUB, and that window is
# roughly 130 lines of ordinary failure surface: a replay, a privilege mirror, a
# Discord round trip. Every one of them fails OPEN. On 2026-09-22 the migration
# replay died on a check constraint and staging served prod's real names, emails
# and phone numbers on a public host for six hours, with the reason sitting in a
# cron log nobody reads.
#
# So the window is now fail-CLOSED. If the script exits non-zero while
# MEMBERS_EXPOSED=1, the identifiers go, even though that leaves staging
# unusable until the next run. An unusable staging is a morning of annoyance; an
# exposed one is a privacy incident, and the whole point of this script is that
# the second is never the cheaper outcome. The wipe is deliberately blunt rather
# than a second copy of the scrub: a fallback that duplicates the logic it is
# protecting can fail the same way the thing it replaces just did.
MEMBERS_EXPOSED=0

# TELL SOMEBODY. This ran broken for a night and was found by accident, because
# a failure at 04:00 goes to cron.log and cron.log is not a person. Set
# SNAPSHOT_ALERT_WEBHOOK in the crontab's environment to a Discord webhook URL
# and failures arrive somewhere with a human attached.
#
# Deliberately failure-only. A nightly "it worked" message is read for a week
# and then filtered, and a filtered channel is the same as no channel.
#
# The URL is a credential: it is never echoed, never written to the log, and
# never passed as an argument, where `ps` would show it to every user on the
# box. It reaches curl through `--config -` on stdin instead. Note that curl has
# no --url-from-env on 8.14, which is what the Pi runs; that option was tried
# first and silently does nothing.
#
# The alert can never fail the run, hence the `|| true`. This exists to report a
# problem, not to become one, and a webhook that 500s at 04:00 must not be what
# stops staging from being scrubbed.
# The webhook may also live in a FILE, which is the preferred way and the
# default. A crontab line is world-readable on most boxes, appears in `ps` while
# cron expands it, and has to be typed into a terminal to be installed, which
# puts the URL into shell history and into whatever transcript is watching. A
# 0600 file is typed into an editor and stays there.
#
# The env var still wins if set, so nothing that already exports it changes.
SNAPSHOT_ALERT_WEBHOOK_FILE="${SNAPSHOT_ALERT_WEBHOOK_FILE:-$HOME/.config/badminton/snapshot-alert-webhook}"
if [ -z "${SNAPSHOT_ALERT_WEBHOOK:-}" ] && [ -r "$SNAPSHOT_ALERT_WEBHOOK_FILE" ]; then
  # Only the first line, and trimmed: an editor appends a newline and a pasted
  # URL often brings a trailing space, neither of which belongs in a URL.
  SNAPSHOT_ALERT_WEBHOOK="$(head -n1 "$SNAPSHOT_ALERT_WEBHOOK_FILE" | tr -d '[:space:]')"
fi

alert() {
  [ -n "${SNAPSHOT_ALERT_WEBHOOK:-}" ] || return 0
  printf 'url = "%s"\n' "$SNAPSHOT_ALERT_WEBHOOK" \
    | curl -fsS --max-time 15 -X POST -H 'Content-Type: application/json' \
        --data "$(jq -nc --arg c "$1" '{content: $c}')" \
        --config - >/dev/null 2>&1 || true
}

on_exit() {
  local rc=$?
  rm -f "$DISCORD_SQL" "$DISCORD_RAW"
  if [ "$rc" -ne 0 ] && [ "$MEMBERS_EXPOSED" = "1" ]; then
    echo "" >&2
    echo "FATAL: the run failed with real member data already restored to" >&2
    echo "       staging and NOT yet scrubbed. Wiping the member tables now." >&2
    echo "       Staging will be empty until the next successful snapshot." >&2
    if docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -q -c \
      "TRUNCATE public.players CASCADE; TRUNCATE auth.identities CASCADE; TRUNCATE auth.users CASCADE;"
    then
      echo "       wiped." >&2
      alert "Staging snapshot FAILED (exit $rc) with members restored and unscrubbed. The member tables were wiped, so staging is empty but holds no real data. Check cron.log."
    else
      echo "       WIPE FAILED. Treat staging as holding real member data." >&2
      alert "Staging snapshot FAILED (exit $rc) with members restored and unscrubbed, AND THE WIPE ALSO FAILED. Treat badminton.polardev.org as serving real member data right now. Check cron.log."
    fi
  elif [ "$rc" -ne 0 ]; then
    alert "Staging snapshot FAILED (exit $rc). No member data was exposed: the failure was outside the restore-to-scrub window. Check cron.log."
  fi
  exit "$rc"
}
trap on_exit EXIT

# Said out loud every run, because "alerting is configured" is exactly the kind
# of belief that is never checked until the night it matters.
if [ -n "${SNAPSHOT_ALERT_WEBHOOK:-}" ]; then
  echo "[$(date -u +%FT%TZ)] failure alerts: ON"
else
  echo "[$(date -u +%FT%TZ)] failure alerts: OFF. Put a Discord webhook URL in" >&2
  echo "    $SNAPSHOT_ALERT_WEBHOOK_FILE (chmod 600), or export SNAPSHOT_ALERT_WEBHOOK." >&2
fi

PUB_SQL="$OUT_DIR/publications-$TS.sql"

# Verify both containers are up
for c in "$PROD_CONTAINER" "$DEV_CONTAINER"; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    echo "FATAL: container $c is not running" >&2
    exit 1
  fi
done

# Both generators are on disk next to this script. Check before touching a
# database, not after: a missing file discovered at step 7 means dev has been
# wiped and left with no privileges, which reads as empty pages rather than an
# error.
for f in mirror-public-acls.sql mirror-public-publications.sql check-public-dependents.sql; do
  if [ ! -r "$SCRIPT_DIR/sql/$f" ]; then
    echo "FATAL: $SCRIPT_DIR/sql/$f is missing. Pull the repo checkout on this host." >&2
    exit 1
  fi
done

echo "[$(date -u +%FT%TZ)] dumping prod public schema..."
docker exec "$PROD_CONTAINER" pg_dump -U postgres -d postgres \
  --schema=public \
  --quote-all-identifiers --no-owner --no-acl \
  | gzip > "$PUBLIC_DUMP"

echo "[$(date -u +%FT%TZ)] dumping prod auth users/identities..."
docker exec "$PROD_CONTAINER" pg_dump -U postgres -d postgres \
  --table=auth.users --table=auth.identities \
  --data-only --column-inserts \
  --no-owner --no-acl \
  | gzip > "$AUTH_DUMP"

# Read-only against prod, and done BEFORE dev is touched so that a failure here
# costs nothing. Both are kept beside the dumps: they are the record of what
# prod's privileges were on the night, which is the only thing that makes a
# later "why can staging read that" answerable.
echo "[$(date -u +%FT%TZ)] reading prod privileges and publication membership..."
docker exec -i "$PROD_CONTAINER" psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 \
  < "$SCRIPT_DIR/sql/mirror-public-acls.sql" > "$ACL_SQL"
docker exec -i "$PROD_CONTAINER" psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 \
  < "$SCRIPT_DIR/sql/mirror-public-publications.sql" > "$PUB_SQL"

# A generator that returns nothing still exits 0. That would drop dev, restore
# it, apply a file of pure comments, and leave staging with no grants at all —
# which surfaces as empty pages, not as an error, because a failed PostgREST read
# arrives as an empty list. So put a floor under it BEFORE anything is dropped.
# The two-table fixture this was developed against generated 39 statements; prod
# generates hundreds. Twenty is far below any real answer and far above zero.
acl_stmts=$(grep -c ';' "$ACL_SQL" 2>/dev/null || true)
if [ "${acl_stmts:-0}" -lt 20 ]; then
  echo "FATAL: the privilege mirror produced only ${acl_stmts:-0} statements." >&2
  echo "       Refusing to wipe dev — it would come back with no grants and look" >&2
  echo "       empty rather than broken. $ACL_SQL is kept for inspection." >&2
  exit 1
fi

# The same floor for the publication generator, and it cannot be a threshold.
# An empty PUB_SQL is DEFECT 3 itself — supabase_realtime comes back existing and
# holding nothing, every live badge and the whole door page quietly stop
# updating, and nothing errors anywhere. But zero blocks is also the CORRECT
# answer when prod's publication is FOR ALL TABLES, which the generator rightly
# skips (a member list is not something to re-add table by table). A fixed
# minimum would either miss the failure or block every night on such a database.
# So ask prod how many pairs there should be and compare.
pub_expected=$(docker exec -i "$PROD_CONTAINER" psql -U postgres -d postgres -qAt \
  -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_publication p
     JOIN pg_publication_rel r ON r.prpubid = p.oid
     JOIN pg_class c ON c.oid = r.prrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE NOT p.puballtables;")
pub_got=$(grep -c 'END \$do\$;' "$PUB_SQL" 2>/dev/null || true)
if [ "${pub_expected:-0}" -gt 0 ] && [ "${pub_got:-0}" -lt "${pub_expected}" ]; then
  echo "FATAL: prod publishes ${pub_expected} public table(s), but the generator emitted" >&2
  echo "       only ${pub_got:-0} statement(s). Refusing to wipe dev — realtime would come" >&2
  echo "       back subscribed to nothing, which is silent everywhere. $PUB_SQL kept." >&2
  exit 1
fi

# WHAT CASCADE WOULD TAKE WITH IT. Asked of the database we are about to drop,
# because the answer is not in this repo: Supabase's own init ran before any of
# our migrations, `CREATE EXTENSION IF NOT EXISTS` is a silent no-op that reveals
# nothing about where the extension landed, and the owner has run SQL by hand.
# Anything this prints lives outside public, dies with the CASCADE, and is NOT in
# a `--schema=public` dump — so it would be gone for good. Empty output is the
# expected answer and the only one we proceed on.
echo "[$(date -u +%FT%TZ)] checking for cross-schema dependents on public..."
dependents=$(docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -qAt \
  -v ON_ERROR_STOP=1 < "$SCRIPT_DIR/sql/check-public-dependents.sql")
if [ -n "$dependents" ]; then
  echo "FATAL: dropping public would also destroy these, and the dump restores none" >&2
  echo "       of them (pg_dump --schema=public does not carry them):" >&2
  echo "$dependents" | sed 's/^/         - /' >&2
  echo "       Nothing has been changed. Move each one out of public's blast radius" >&2
  echo "       (or add it to a post-restore step) before letting this run again." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# CAPTURE STAGING'S OWN DISCORD CONFIG.
#
# These four tables live in public, so the drop below takes them — and then
# prod's dump puts PROD'S rows back in their place. That is the part that makes
# this worth code rather than a warning: staging would come up holding prod's
# guild id, prod's role ids, prod's discord_bot_url and prod's service secret,
# i.e. the staging bot aimed at the production Discord server, with the
# credentials to act on it.
#
# What saves it today is only that staging's bot is a separate Discord
# application and is not a member of the prod guild, so its calls 403. That is
# luck, not a safeguard, and it stops being true the moment somebody reuses a
# token.
#
# So: capture staging's own rows here, and after the restore delete whatever
# prod's dump left and put these back. Note the asymmetry that matters —
# "staging had no config" must end as "staging has no config", NEVER as
# "staging inherits prod's". The delete below is therefore unconditional; this
# capture only decides what goes back afterwards.
# psql is asked for -q, and the result is then FILTERED to INSERT lines anyway.
# Both, because -q alone was not enough and the failure was silent for a night:
# without it psql writes the command tag of every statement to stdout, so
# `CREATE TEMP TABLE` and the `DO` block put the literal words "CREATE TABLE"
# and "DO" at the top of the captured file. Replaying that is
# `ERROR: syntax error at or near "DO"` -- psql had already read "CREATE TABLE"
# and "DO" as one unterminated statement -- which under ON_ERROR_STOP + set -e
# killed the whole script AFTER the scrub had deleted prod's rows. Staging woke
# up with no Discord config at all, and the NOTIFY and the retention sweep at
# the end never ran either. The grep is the actual guarantee: it does not depend
# on which psql outputs are considered "informational" by which version.
echo "[$(date -u +%FT%TZ)] capturing staging's own Discord config..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -Atq -v ON_ERROR_STOP=1 > "$DISCORD_RAW" <<'SQL'
-- Dynamic SQL, and it has to be. A plain `SELECT ... FROM public.discord_guilds
-- WHERE to_regclass(...) IS NOT NULL` does NOT survive the table being absent:
-- Postgres resolves every relation at parse time, long before any WHERE is
-- evaluated, so the guard never runs and the whole script dies on a staging
-- database that predates 00167. EXECUTE defers the parse until the IF has
-- already decided the table is there.
CREATE TEMP TABLE _captured (ord int, stmt text);

DO $do$
BEGIN
  IF to_regclass('public.discord_guilds') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO _captured
      SELECT 1, format(
        'INSERT INTO public.discord_guilds (guild_id, label, enabled) VALUES (%L, %L, %L) '
        'ON CONFLICT (guild_id) DO UPDATE SET label = EXCLUDED.label, enabled = EXCLUDED.enabled;',
        guild_id, label, enabled)
      FROM public.discord_guilds
    $q$;
  END IF;

  IF to_regclass('public.discord_guild_roles') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO _captured
      SELECT 4, format(
        'INSERT INTO public.discord_guild_roles (guild_id, role_name, role_id) VALUES (%L, %L, %L) '
        'ON CONFLICT (guild_id, role_name) DO UPDATE SET role_id = EXCLUDED.role_id;',
        guild_id, role_name, role_id)
      FROM public.discord_guild_roles
    $q$;
  END IF;

  IF to_regclass('public.discord_settings') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO _captured
      SELECT 2, format(
        'INSERT INTO public.discord_settings (key, value) VALUES (%L, %L) '
        'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;', key, value)
      FROM public.discord_settings
    $q$;
  END IF;

  IF to_regclass('public.cron_config') IS NOT NULL THEN
    -- Named explicitly, not LIKE 'discord%': `_` is a LIKE wildcard, and this
    -- table holds unrelated secrets that are none of this script's business.
    EXECUTE $q$
      INSERT INTO _captured
      SELECT 3, format(
        'INSERT INTO public.cron_config (key, value) VALUES (%L, %L) '
        'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;', key, value)
      FROM public.cron_config
      WHERE key IN ('discord_bot_url', 'discord_service_secret')
    $q$;
  END IF;

  -- player_discord_links belongs here for the SAME reason as the tables above,
  -- and was the remaining hole: the scrub did not clear it, so once prod has
  -- links, staging inherits PROD MEMBERS' Discord accounts. A /sync on staging
  -- would then try to grant roles to real people's Discord ids. It is not
  -- guild-scoped -- the row is (player_id -> discord_user_id) -- so nothing in
  -- the data marks it as belonging to another server.
  --
  -- The WHERE EXISTS is not optional. player_id is a FK onto players, and by
  -- the time this is replayed players holds PROD's rows; a staging link for
  -- somebody prod has since deleted would abort the restore. Player ids are
  -- stable across a snapshot (staging's players ARE prod's), so a live member's
  -- link survives the night; a deleted member's is silently dropped, which is
  -- the correct outcome rather than a nightly failure.
  IF to_regclass('public.player_discord_links') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO _captured
      SELECT 5, format(
        'INSERT INTO public.player_discord_links (player_id, discord_user_id, linked_at, last_synced_at) '
        'SELECT %L::uuid, %L, %L::timestamptz, %L::timestamptz '
        'WHERE EXISTS (SELECT 1 FROM public.players WHERE id = %L::uuid) '
        'ON CONFLICT (player_id) DO UPDATE SET discord_user_id = EXCLUDED.discord_user_id;',
        player_id, discord_user_id, linked_at, last_synced_at, player_id)
      FROM public.player_discord_links
    $q$;
  END IF;
END
$do$;

-- Ordered so a parent row is inserted before anything that references it:
-- guilds(1) before guild_roles(4), and players are already restored by the
-- time links(5) run. An explicit rank, not the previous `ORDER BY stmt LIKE
-- '...guild_roles%'` boolean, which only ever encoded ONE of these pairs and
-- silently had no room for a third table.
SELECT stmt FROM _captured ORDER BY ord, stmt;
SQL

# Only generated statements reach the replay file. `|| true` because grep exits
# 1 on no match, and "staging has no Discord config" is a legitimate state that
# must not fail the run -- the scrub below is unconditional precisely so that
# an empty capture still ends as "staging has none" rather than "staging keeps
# prod's". Note this cannot mask a psql failure: psql wrote $DISCORD_RAW under
# set -e on its own line, so a failed capture has already stopped the script.
grep '^INSERT INTO public\.' "$DISCORD_RAW" > "$DISCORD_SQL" || true

# REPLAY IT ONCE, HERE, AND ROLL IT BACK -- while staging is still intact.
#
# This is the guard the previous version was missing, and it is the same shape
# as the privilege and publication floors above: the failure it catches is one
# that otherwise lands AFTER the point of no return. The scrub deletes prod's
# Discord rows and the replay puts staging's back; if the replay is malformed,
# ON_ERROR_STOP + set -e abort the run in between, and staging is left with
# nothing -- which is silent, because an empty discord_guilds reads to the bot
# as "not configured yet" rather than as an error.
#
# The tables still hold staging's own rows at this point, so every ON CONFLICT
# path is exercised for real. ROLLBACK means nothing is kept.
if [ -s "$DISCORD_SQL" ]; then
  echo "[$(date -u +%FT%TZ)] test-replaying captured Discord config (rolled back)..."
  if ! { echo 'BEGIN;'; cat "$DISCORD_SQL"; echo 'ROLLBACK;'; } \
       | docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres \
           -v ON_ERROR_STOP=1 -q; then
    echo "FATAL: staging's captured Discord config does not replay cleanly." >&2
    echo "       Refusing to drop staging -- the scrub would delete prod's rows" >&2
    echo "       and this would then fail to put staging's back, leaving the bot" >&2
    echo "       unconfigured with nothing in any log but this one." >&2
    exit 1
  fi
fi

# KEEP THE STAGING ADMINS SIGNED IN (owner request, 2026-09-27).
#
# The TRUNCATE auth.users CASCADE below takes auth.sessions and
# auth.refresh_tokens with it, and the scrub deletes every passkey, so every
# refresh used to sign the keep-list admins out of staging and take their
# passkeys away. A refresh token here can only ever mint a token for STAGING
# (prod's JWT secret is different), and a passkey enrolled here is scoped to the
# staging hostname, so keeping them exposes nothing of prod's.
#
# Only the keep-list admins' own rows are set aside, in a holding schema the
# drop and the truncate cannot reach, and put back once the scrub has verified.
# Members' sessions still go with the truncate. The holding schema is dropped at
# the start of every run, so a failed run costs one sign-in at worst.
STAGING_ADMIN_EMAILS="${STAGING_ADMIN_EMAILS:-wkc10@sfu.ca,sfubadminton@gmail.com}"

echo "[$(date -u +%FT%TZ)] setting aside the staging admins' sessions and passkeys..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
    -v emails="$STAGING_ADMIN_EMAILS" <<'SQL'
BEGIN;
\o /dev/null
SELECT set_config('keep.emails', :'emails', true);
\o
DROP SCHEMA IF EXISTS staging_keep CASCADE;
CREATE SCHEMA staging_keep;
REVOKE ALL ON SCHEMA staging_keep FROM PUBLIC;
DO $keep$
DECLARE
  keep text[] := ARRAY(
    SELECT btrim(e) FROM unnest(string_to_array(current_setting('keep.emails'), ',')) e
     WHERE btrim(e) <> '');
BEGIN
  CREATE TABLE staging_keep.users AS
    SELECT id FROM auth.users WHERE email = ANY(keep);
  CREATE TABLE staging_keep.sessions AS
    SELECT s.* FROM auth.sessions s WHERE s.user_id IN (SELECT id FROM staging_keep.users);
  CREATE TABLE staging_keep.refresh_tokens AS
    SELECT r.* FROM auth.refresh_tokens r WHERE r.session_id IN (SELECT id FROM staging_keep.sessions);
  CREATE TABLE staging_keep.mfa_amr_claims AS
    SELECT m.* FROM auth.mfa_amr_claims m WHERE m.session_id IN (SELECT id FROM staging_keep.sessions);
  IF to_regclass('public.passkey_credentials') IS NOT NULL THEN
    CREATE TABLE staging_keep.passkey_credentials AS
      SELECT c.* FROM public.passkey_credentials c
        JOIN public.players p ON p.id = c.player_id
       WHERE p.user_id IN (SELECT id FROM staging_keep.users);
  END IF;
  RAISE NOTICE 'kept for % admin account(s): % session(s), % passkey(s)',
    (SELECT count(*) FROM staging_keep.users),
    (SELECT count(*) FROM staging_keep.sessions),
    CASE WHEN to_regclass('staging_keep.passkey_credentials') IS NULL THEN 0
         ELSE (SELECT count(*) FROM staging_keep.passkey_credentials) END;
END
$keep$;
COMMIT;
SQL

# CASCADE, and ours rather than pg_dump's. The NOTICEs list what dev had that
# prod does not — normally the migrations being rehearsed on staging.
echo "[$(date -u +%FT%TZ)] dropping dev public schema (cascade notices follow)..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
SQL

echo "[$(date -u +%FT%TZ)] truncating dev auth users and identities..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE auth.identities CASCADE;
TRUNCATE auth.users CASCADE;
SQL

# Armed BEFORE the restore, not after: if the restore itself dies partway it has
# already written real rows, so "it failed" and "nothing landed" are not the
# same statement. Disarmed only once the scrub's floor checks have passed.
MEMBERS_EXPOSED=1

echo "[$(date -u +%FT%TZ)] restoring auth users into dev..."
gunzip -c "$AUTH_DUMP" | docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q

# The dump carries its own `CREATE SCHEMA "public"`, which is why the drop above
# does not recreate it.
echo "[$(date -u +%FT%TZ)] restoring public schema into dev..."
gunzip -c "$PUBLIC_DUMP" | docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q

echo "[$(date -u +%FT%TZ)] mirroring prod privileges onto dev..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$ACL_SQL"

echo "[$(date -u +%FT%TZ)] restoring realtime publication membership..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$PUB_SQL"

# ---------------------------------------------------------------------------
# REPLAY MIGRATIONS PROD DOES NOT HAVE YET.
#
# The restore above put PROD's public schema on dev, so every staging-only
# migration just vanished along with the tables it created. schema_migrations
# came from that same dump, so it now reports prod's version and those files
# correctly show as pending again.
#
# This used to be a manual morning chore. It stopped being optional when the
# Discord tables arrived: the capture/restore below moves ROWS, and rows need
# tables. With 00165-00167 applied to staging and absent from prod, a refresh
# would drop the tables, restore nothing in their place, and then fail trying
# to insert captured config into tables that no longer exist -- taking the bot
# down every night until prod catches up.
#
# Applied directly rather than through db-migrate.sh, which deliberately only
# PRINTS the psql command for a human to run. That is the right default for a
# database somebody is touching by hand, and the wrong one for the unattended
# job that just dropped the schema itself.
#
# Only ever runs against DEV_CONTAINER. Nothing here can reach prod.
echo "[$(date -u +%FT%TZ)] replaying migrations prod does not have..."
MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations"
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "FATAL: no migrations directory at $MIGRATIONS_DIR" >&2
  exit 1
fi

replayed=0
for f in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  version="${base%%_*}"

  already="$(docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -At \
    -c "SELECT 1 FROM public.schema_migrations WHERE version = '$version' LIMIT 1;" 2>/dev/null || true)"
  [ "$already" = "1" ] && continue

  echo "  applying $base"
  # Same rule db-migrate.sh uses: a file that wraps itself must not be wrapped
  # again, or the outer BEGIN collides with its own COMMIT. Decided by a
  # top-level COMMIT, never a BEGIN.
  if grep -qE '^COMMIT;' "$f"; then
    single=""
  else
    single="--single-transaction"
  fi

  if ! docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres \
        -v ON_ERROR_STOP=1 -q $single < "$f"; then
    echo "FATAL: $base failed to apply; staging is half-migrated" >&2
    exit 1
  fi

  # Recorded only after psql actually succeeded -- db-migrate.sh's rule that a
  # migration nobody watched succeed is never marked applied.
  # 'runner', NOT 'snapshot'. schema_migrations_applied_by_known permits exactly
  # backfill, runner and manual, and that constraint arrives here inside prod's
  # own dump, so staging cannot widen it locally: prod would have to change
  # first. This line said 'snapshot' from the day it was written and had never
  # once executed, because until 00241 there was no migration staging held that
  # prod did not. The first time it ran it aborted the whole snapshot under
  # ON_ERROR_STOP=1, at the replay step, which sits ABOVE the member scrub, and
  # left staging holding real names, emails and phone numbers on a public host
  # for six hours. Any failure in this window has that consequence.
  checksum="$(shasum -a 256 "$f" | awk '{print $1}')"
  docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO public.schema_migrations (version, name, checksum, applied_by, verified)
     VALUES ('$version', '$base', '$checksum', 'runner', true)
     ON CONFLICT (version) DO NOTHING;"
  replayed=$((replayed + 1))
done
echo "[$(date -u +%FT%TZ)] replayed $replayed migration(s)."

# ---------------------------------------------------------------------------
# SCRUB PROD'S DISCORD CONFIG, THEN PUT STAGING'S BACK.
#
# The delete is UNCONDITIONAL and runs whether or not anything was captured.
# That is the whole safety property: if staging had no Discord config, it must
# end with none, rather than silently adopting prod's guild, prod's bot URL and
# prod's secret. Inheriting is the failure; having nothing is fine.
#
# Child table first — discord_guild_roles has a foreign key onto discord_guilds.
echo "[$(date -u +%FT%TZ)] scrubbing prod Discord config out of staging..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
DO $do$
BEGIN
  IF to_regclass('public.discord_guild_roles') IS NOT NULL THEN
    DELETE FROM public.discord_guild_roles;
  END IF;
  IF to_regclass('public.discord_guilds') IS NOT NULL THEN
    DELETE FROM public.discord_guilds;
  END IF;
  IF to_regclass('public.discord_settings') IS NOT NULL THEN
    DELETE FROM public.discord_settings;
  END IF;
  IF to_regclass('public.cron_config') IS NOT NULL THEN
    DELETE FROM public.cron_config
     WHERE key IN ('discord_bot_url', 'discord_service_secret');
  END IF;
  -- Prod's member->Discord mappings are as much "prod's Discord setup" as the
  -- guild row is, and they are not guild-scoped, so nothing downstream can tell
  -- they came from another server. Cleared unconditionally, same as the rest.
  IF to_regclass('public.player_discord_links') IS NOT NULL THEN
    DELETE FROM public.player_discord_links;
  END IF;
  -- The console's queued messages (00222). NOT MERELY A LEAK OF PROD'S TEXT,
  -- though it is that too: a row prod queued and had not yet posted arrives
  -- UNSENT and UNCLAIMED, and the staging bot drains this table on the same
  -- tick prod's does. An announcement the club wrote for its members would be
  -- posted into the test server by a bot nobody asked to say it.
  IF to_regclass('public.discord_outbox') IS NOT NULL THEN
    DELETE FROM public.discord_outbox;
  END IF;
  -- Prod's announcement -> Discord message mappings. Guild-scoped, so staging's
  -- bot would not act on them, but they are prod message ids and they belong to
  -- prod's setup exactly like the rows above. Cleared for the same reason: the
  -- rule here is that staging inherits NONE of prod's Discord state, and a
  -- table exempted because it looks harmless today is how the last hole opened.
  IF to_regclass('public.discord_announcement_posts') IS NOT NULL THEN
    DELETE FROM public.discord_announcement_posts;
  END IF;
END
$do$;
SQL

if [ -s "$DISCORD_SQL" ]; then
  echo "[$(date -u +%FT%TZ)] restoring staging's own Discord config..."
  docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$DISCORD_SQL"
else
  echo "[$(date -u +%FT%TZ)] staging had no Discord config to restore (left empty, not inherited)."
fi

# ---------------------------------------------------------------------------
# REFUSE PROD'S DISCORD CONFIG EVEN WHEN IT CAME BACK AS "STAGING'S OWN".
#
# The capture above keeps whatever staging holds, and it cannot tell staging's
# values from prod's. Once prod's rows got onto staging (the 2026-09-22 window
# is the likely entry), every night faithfully captured and restored them:
# found 2026-09-23 with staging's pg_cron driving the PROD bot at
# bot.sfubadminton.com, staging bound to the club's real guild, and prod's
# service secret sitting in staging's cron_config. So the restored rows are now
# checked against prod's LIVE values, and any that match are deleted.
#
# Compared by md5 fingerprint, computed inside each database, so no secret ever
# passes through this shell, a log, or a variable. The values reach staging's
# psql as set_config, not :'var', because psql does not expand variables inside
# a dollar-quoted DO body (see the staging admin grant below).
#
# A deleted bot url or secret leaves the jobs' WHERE EXISTS guard false, so the
# staging jobs simply stop firing until the owner sets staging's own values.
# That is the intended failure: silent to members, loud in this log.
echo "[$(date -u +%FT%TZ)] refusing any Discord config that matches prod's..."
PROD_DISCORD_FP=$(docker exec -i "$PROD_CONTAINER" psql -U postgres -d postgres -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT concat_ws('|',
  (SELECT coalesce(string_agg(md5(guild_id), ','), '') FROM public.discord_guilds),
  (SELECT coalesce(string_agg(md5(value), ','), '') FROM public.cron_config
     WHERE key IN ('discord_bot_url', 'discord_service_secret')),
  (SELECT coalesce(string_agg(md5(player_id::text || ':' || discord_user_id), ','), '')
     FROM public.player_discord_links));
SQL
)
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -qAt -v ON_ERROR_STOP=1 \
  -v fp="$PROD_DISCORD_FP" <<'SQL'
SELECT set_config('snap.prod_discord_fp', :'fp', false) AS _ \gset
DO $refuse$
DECLARE
  parts  text[] := string_to_array(current_setting('snap.prod_discord_fp'), '|');
  guilds text[] := string_to_array(coalesce(parts[1], ''), ',');
  cron   text[] := string_to_array(coalesce(parts[2], ''), ',');
  links  text[] := string_to_array(coalesce(parts[3], ''), ',');
  n      int;
BEGIN
  IF to_regclass('public.discord_guild_roles') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.discord_guild_roles WHERE md5(guild_id) = ANY ($1)' USING guilds;
  END IF;
  IF to_regclass('public.discord_guilds') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.discord_guilds WHERE md5(guild_id) = ANY ($1)' USING guilds;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'staging held % of PROD''s Discord guild(s); removed', n; END IF;
  END IF;
  IF to_regclass('public.cron_config') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.cron_config
              WHERE key IN (''discord_bot_url'', ''discord_service_secret'')
                AND md5(value) = ANY ($1)' USING cron;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'staging held % of PROD''s bot url/secret; removed, staging Discord jobs are off until staging''s own are set', n; END IF;
  END IF;
  IF to_regclass('public.player_discord_links') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.player_discord_links
              WHERE md5(player_id::text || '':'' || discord_user_id) = ANY ($1)' USING links;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'staging held % of PROD''s member Discord links; removed', n; END IF;
  END IF;
END
$refuse$;
SQL

# ---------------------------------------------------------------------------
# RE-GRANT THE STAGING-ONLY ADMIN.
#
# The restore above put PROD's players table on staging, so staging roles ARE
# prod roles -- and the owner is `player` + is_exec on prod, not admin. is_exec
# on its own holds ZERO writes (EXEC_BASELINE in apps/admin/src/lib/permissions.ts
# is eight section pages and four reads), so the admin console renders in full
# and every Edit control is simply absent. That reads as "the app is broken",
# not as "you are not an admin here", and it has already cost one debugging
# session chasing a permissions bug that did not exist.
#
# Admin on staging grants nothing that matters -- staging is a disposable copy
# of prod that is overwritten again tomorrow morning.
#
# PROD IS NOT REACHABLE FROM HERE. This runs against DEV_CONTAINER, like every
# other write in this script; PROD_CONTAINER is only ever read from.
#
# The privileged-column trigger allows this: guard_player_privileged_columns()
# opens with `IF auth.uid() IS NULL OR is_admin(auth.uid())`, and a psql session
# has no JWT subject, so auth.uid() is NULL. It is one of the few places where
# going in through psql genuinely behaves differently from going in through the
# app, and here that is the point.
#
# active_flag too: admin_access_level() returns NULL for an inactive row no
# matter the role, so a prod-side "Inactive" (set on this account 2026-09-16)
# rendered staging's console as "Admin Access Required" despite the grant.
# inactive_since is cleared with it so the purge clock never sees the row.
#
# Comma-separated and overridable, so the next person who needs an account on
# staging edits an env var and not this file.
STAGING_ADMIN_EMAILS="${STAGING_ADMIN_EMAILS:-wkc10@sfu.ca,sfubadminton@gmail.com}"

if [ -n "$STAGING_ADMIN_EMAILS" ]; then
  echo "[$(date -u +%FT%TZ)] re-granting staging admin: $STAGING_ADMIN_EMAILS"
  grant_result=$(docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres \
      -Atq -v ON_ERROR_STOP=1 -v emails="$STAGING_ADMIN_EMAILS" <<'SQL'
BEGIN;
-- CREATE THE ACCOUNT WHEN PROD NO LONGER HAS IT. Once the owner account is
-- deleted on prod, the restore brings over only a deleted+...@deleted.invalid
-- tombstone, and the grant below would match nothing. So a listed address with
-- no players row gets one here, linked to a staging-only login: the existing
-- auth user for that address if one survived, otherwise a new confirmed one
-- that the email-code sign-in finds by address. The token columns are '' and
-- not NULL because GoTrue fails to scan a NULL into them.
--
-- :'emails' is not expanded inside a $do$ body, hence set_config
-- (see reference: psql dollar quoting). \gset swallows the row so nothing
-- extra lands in grant_result.
SELECT set_config('grant.emails', :'emails', true) AS _ \gset
CREATE TEMP TABLE created_now (email text) ON COMMIT DROP;
DO $create$
DECLARE
  e   text;
  uid uuid;
BEGIN
  FOR e IN
    SELECT btrim(x) FROM unnest(string_to_array(current_setting('grant.emails'), ',')) x
     WHERE btrim(x) <> ''
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.players WHERE email = e);
    SELECT id INTO uid FROM auth.users WHERE lower(email) = lower(e);
    IF uid IS NULL THEN
      uid := gen_random_uuid();
      INSERT INTO auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                              confirmation_token, recovery_token, email_change_token_new,
                              email_change, email_change_token_current, phone_change,
                              phone_change_token, reauthentication_token)
      VALUES ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e, now(),
              '{"provider":"email","providers":["email"]}', '{}', now(), now(),
              '', '', '', '', '', '', '', '');
      INSERT INTO auth.identities (provider_id, user_id, identity_data, provider,
                                   last_sign_in_at, created_at, updated_at)
      VALUES (uid::text, uid,
              jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true),
              'email', now(), now(), now());
    END IF;
    INSERT INTO public.players (email, first_name, last_name, user_id, onboarding_completed, status)
    VALUES (e, 'Staging', 'Admin', uid, TRUE, 'recreational');
    INSERT INTO created_now VALUES (e);
  END LOOP;
END
$create$;

WITH t AS (
  SELECT btrim(e) AS email
    FROM unnest(string_to_array(:'emails', ',')) AS e
   WHERE btrim(e) <> ''
), upd AS (
  UPDATE public.players p
     SET role = 'admin', is_exec = TRUE, active_flag = TRUE, inactive_since = NULL
    FROM t
   WHERE p.email = t.email
  RETURNING p.email
)
-- Reported per requested address rather than as a count, because the failure
-- worth seeing is "that email is not in prod at all" (a typo, or an account
-- that was never created), and a count of 0 does not say which one.
SELECT CASE WHEN u.email IS NULL THEN 'MISSING '
            WHEN t.email IN (SELECT email FROM created_now) THEN 'created '
            ELSE 'granted ' END || t.email
  FROM t LEFT JOIN upd u ON u.email = t.email
 ORDER BY 1;
COMMIT;
SQL
  )
  echo "$grant_result" | sed 's/^/  /'
  # Not fatal: a stale address in the list is not a reason to fail a refresh
  # that has otherwise completely succeeded. But it must be visible, because the
  # symptom on the other end is a console with no buttons.
  if echo "$grant_result" | grep -q '^MISSING '; then
    echo "WARNING: the above address(es) are not in prod's players table, so" >&2
    echo "         nothing was granted for them. Staging will render the admin" >&2
    echo "         console for that account but show no Edit controls at all." >&2
  fi
fi

# ---------------------------------------------------------------------------
# SCRUB THE MEMBERS.
#
# Everything above this point has faithfully copied production's membership onto
# staging: real names, real email addresses, real phone numbers, officer notes
# written about members, fee records. That is what `pg_dump public` plus
# auth.users gives you, and for two months nobody noticed because the script was
# failing before it got here.
#
# WHY THIS EXISTS AT ALL. Staging is not a locked room. It is reachable on the
# public internet at badminton.polardev.org, it is deliberately NOT gated on the
# test suite (docs/STAGING.md: staging is where you go to find out whether
# something works, and refusing to deploy a red commit there removes the one
# place it is safe to look at one), and it is the target of every rehearsal. A
# copy of the real membership sitting behind untested code is a risk that buys
# nothing: the original staging seed was fourteen synthetic accounts and it
# covered every state the console has a control for.
#
# So the copy stays, because realistic row counts and real relationships are the
# whole point of a rehearsal, and the PEOPLE are replaced.
#
# WHAT IS PRESERVED, deliberately:
#   - every id, foreign key, rating, match, score, date and count
#   - member_code, role, is_exec, active_flag, membership_type, fee status
#   - the deleted+...@deleted.invalid sentinel on already-purged members, so
#     staging keeps a real example of an anonymised account
#   - $STAGING_ADMIN_EMAILS, untouched, because sign-in on staging is an email
#     code and scrubbing the owner's address locks the owner out of staging
#     entirely. Those are the owner's own addresses, not a member's.
#
# STABLE ACROSS REFRESHES. Every replacement is derived from the row's own id,
# so a member is the same "Jordan Nguyen" tomorrow morning as today. A random
# name per run would make a bug report written against staging unreadable by the
# next day.
#
# Set SCRUB_MEMBER_DATA=0 to skip, for the rare case of reproducing a bug that
# genuinely depends on the real values. It is off-by-default in the other
# direction on purpose: skipping has to be a decision someone typed.
SCRUB_MEMBER_DATA="${SCRUB_MEMBER_DATA:-1}"

if [ "$SCRUB_MEMBER_DATA" != "1" ]; then
  echo "WARNING: SCRUB_MEMBER_DATA=$SCRUB_MEMBER_DATA -- staging now holds REAL" >&2
  echo "         member names, emails and phone numbers. Re-run the snapshot" >&2
  echo "         without that variable as soon as you are done." >&2
else
  echo "[$(date -u +%FT%TZ)] scrubbing member personal data out of staging..."
  docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres \
      -q -v ON_ERROR_STOP=1 -v emails="$STAGING_ADMIN_EMAILS" <<'SQL'
BEGIN;

-- The keep-list reaches the DO block through a transaction-local setting.
-- psql expands :'emails' out here but NOT inside a $do$ block, where it would
-- be passed through literally and die on `syntax error at or near ":"`.
\o /dev/null
SELECT set_config('scrub.keep_emails', :'emails', true);
\o

DO $scrub$
DECLARE
  -- Ordinary names on purpose. Placeholders like "Test User 41" make every
  -- screen look like a fixture and hide the layout bugs that only show up on a
  -- name of a realistic length, which is one of the things staging is for.
  fns text[] := ARRAY['Alex','Jordan','Sam','Riley','Morgan','Casey','Jamie',
                      'Avery','Quinn','Rowan','Harper','Emerson','Parker',
                      'Reese','Skyler','Devon','Marlow','Shay'];
  lns text[] := ARRAY['Chen','Patel','Nguyen','Kim','Garcia','Okafor','Silva',
                      'Haddad','Lindqvist','Moreau','Tanaka','Rossi','Novak',
                      'Ferreira','Osei','Dubois','Ivanov','Mensah'];
  keep text[] := ARRAY(
    SELECT btrim(e) FROM unnest(string_to_array(current_setting('scrub.keep_emails'), ',')) e
     WHERE btrim(e) <> ''
  );
  n integer;
  -- How many email identities hold a user id in provider_id rather than an
  -- address. The scrub must not change this number: see the assertion below.
  n_uuid_pids integer;
BEGIN
  -- A stable, non-negative index from a uuid. hashtext() returns a signed int4
  -- and abs() throws on INT_MIN, so shift into positive range instead.
  --
  -- TWO SETS, and the difference matters. `_scrub_targets` is every member who
  -- is not on the keep-list, INCLUDING the already-purged ones. `_scrub_names`
  -- is the subset that still has a real name to replace.
  --
  -- A purged member's players row already reads deleted+...@deleted.invalid and
  -- must keep reading that, because it is the one genuine example of an
  -- anonymised account on staging. But their auth.users row still holds the
  -- REAL address: that is precisely the asymmetry docs/ops/privacy-breach.md
  -- calls out, and it is why the auth half below keys off _scrub_targets and
  -- not off _scrub_names. Getting that wrong leaves the deleted members as the
  -- only people on staging whose real email survived, which would be the exact
  -- opposite of the intent.
  CREATE TEMP TABLE _scrub_targets ON COMMIT DROP AS
  SELECT p.id,
         p.user_id,
         (p.email LIKE 'deleted+%@deleted.invalid') AS purged,
         CASE WHEN p.email LIKE 'deleted+%@deleted.invalid'
              THEN p.email
              ELSE 'member.' || substr(md5(p.id::text), 1, 10) || '@staging.invalid'
         END AS new_email
    FROM public.players p
   WHERE NOT (p.email = ANY(keep));

  CREATE TEMP TABLE _scrub_names ON COMMIT DROP AS
  SELECT t.id,
         fns[1 + ((hashtext(t.id::text)::bigint + 2147483648) % array_length(fns,1))] AS fn,
         lns[1 + ((hashtext(t.id::text || 'l')::bigint + 2147483648) % array_length(lns,1))] AS ln,
         substr(md5(t.id::text), 1, 10) AS tag
    FROM _scrub_targets t
   WHERE NOT t.purged;

  SELECT count(*) INTO n FROM _scrub_names;
  RAISE NOTICE 'scrubbing % member records (% already purged, % kept as staging admins)',
    n, (SELECT count(*) FROM _scrub_targets WHERE purged), coalesce(array_length(keep,1), 0);

  --
  -- full_name IS NOT ASSIGNED HERE, and must not be. It is a generated column
  -- (00023_split_player_name.sql):
  --   GENERATED ALWAYS AS (btrim(first_name || COALESCE(' ' || NULLIF(btrim(last_name),''),''))) STORED
  -- so setting first_name and last_name rewrites it for free, and naming it in
  -- the SET list fails the whole statement with "column full_name can only be
  -- updated to DEFAULT". Caught by running this against the real staging schema;
  -- a local fixture with full_name as a plain column passes happily and proves
  -- nothing.
  UPDATE public.players p
     SET first_name   = s.fn,
         last_name    = s.ln,
         display_name = CASE WHEN p.display_name IS NULL THEN NULL
                             ELSE s.fn || ' ' || left(s.ln, 1) || '.' END,
         handle       = CASE WHEN p.handle IS NULL THEN NULL
                             ELSE lower(s.fn) || s.tag END,
         email        = 'member.' || s.tag || '@staging.invalid',
         -- 555 is the reserved-for-fiction exchange, so a scrubbed number can
         -- never dial a real person if one is ever pasted somewhere.
         phone        = CASE WHEN p.phone IS NULL THEN NULL
                             ELSE '+1555' || lpad(((hashtext(p.id::text)::bigint + 2147483648) % 10000000)::text, 7, '0') END,
         avatar_url   = NULL,
         bio          = CASE WHEN p.bio     IS NULL THEN NULL ELSE 'Bio text removed for staging.' END,
         exec_bio     = CASE WHEN p.exec_bio IS NULL THEN NULL ELSE 'Exec bio removed for staging.' END,
         -- Kept as a non-empty string rather than nulled: a suspended member
         -- with no reason renders differently from one with a reason, and that
         -- difference is a screen worth testing.
         ban_reason   = CASE WHEN p.ban_reason IS NULL THEN NULL ELSE 'Reason removed for staging.' END
    FROM _scrub_names s
   WHERE p.id = s.id;

  -- auth.users is the half that a public-schema-only scrub misses, and it is
  -- the half that still holds the real address after a member is anonymised.
  -- raw_user_meta_data carries name, email and picture from the Google sign-in.
  UPDATE auth.users u
     SET email              = t.new_email,
         phone              = NULL,
         raw_user_meta_data = jsonb_build_object('full_name', p.full_name,
                                                 'email',     t.new_email,
                                                 'scrubbed',  true)
    FROM _scrub_targets t
    JOIN public.players p ON p.id = t.id
   WHERE u.id = t.user_id;

  -- AUTH USERS WITH NO PLAYERS ROW. Someone who authenticated and never
  -- finished onboarding has an auth.users row and nothing in public.players, so
  -- every join above misses them and their real address stays. They are easy to
  -- forget precisely because they are invisible in the app.
  UPDATE auth.users u
     SET email              = 'orphan.' || substr(md5(u.id::text), 1, 10) || '@staging.invalid',
         phone              = NULL,
         raw_user_meta_data = jsonb_build_object('scrubbed', true)
   WHERE u.email IS NOT NULL
     AND NOT (u.email = ANY(keep))
     AND NOT EXISTS (SELECT 1 FROM public.players p WHERE p.user_id = u.id);

  -- A pending email change holds a second real address, in its own column, and
  -- survives everything above. Guarded on the column existing so a GoTrue
  -- schema change cannot turn the nightly refresh into a hard failure.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'auth' AND table_name = 'users'
                AND column_name = 'email_change') THEN
    EXECUTE $q$UPDATE auth.users SET email_change = '' WHERE coalesce(email_change, '') <> ''$q$;
  END IF;

  -- identity_data holds the provider's own copy of the email and name, and for
  -- Google, provider_id IS the account's permanent subject identifier. Google
  -- sign-in is off on staging (its redirect URI is registered against the
  -- production domain), so these rows cannot be used here for anything. Delete
  -- rather than rewrite: rewriting provider_id risks the (provider,provider_id)
  -- unique constraint, and nothing on staging needs them.
  DELETE FROM auth.identities i
   WHERE i.provider <> 'email'
     AND NOT EXISTS (
       SELECT 1 FROM auth.users u WHERE u.id = i.user_id AND u.email = ANY(keep));

  -- provider_id is rewritten ONLY when it actually holds an address, and the
  -- condition is the whole point of this statement.
  --
  -- What provider_id means for the `email` provider depends on the GoTrue
  -- version. Older builds store the address there, which makes it a second
  -- copy of the real email sitting in the next column along from identity_data.
  -- The build running here stores the user's UUID instead: measured on staging,
  -- 29 email identities, the untouched one holding provider_id = user_id.
  --
  -- An unconditional rewrite is therefore not belt and braces, it is damage: it
  -- replaces the id GoTrue resolves a login by with an email address, and the
  -- identity lookup for those accounts stops matching. It did exactly that to
  -- 28 rows before this condition existed. Testing for '%@%' handles both
  -- builds without having to know which one is deployed. The replacement stays
  -- unique because the scrubbed addresses are derived from unique ids.
  SELECT count(*) INTO n_uuid_pids FROM auth.identities
   WHERE provider = 'email' AND provider_id = user_id::text;

  UPDATE auth.identities i
     SET identity_data = jsonb_build_object('sub', i.user_id::text, 'email', u.email),
         provider_id   = CASE WHEN i.provider = 'email' AND i.provider_id LIKE '%@%'
                              THEN u.email ELSE i.provider_id END
    FROM auth.users u
   WHERE u.id = i.user_id AND NOT (u.email = ANY(keep));

  -- The floor guard at the end of this script cannot catch the corruption the
  -- condition above prevents: once provider_id has been overwritten with a
  -- scrubbed address it looks exactly like a legitimately scrubbed legacy
  -- value, and every leak check passes. So assert it here, where the before
  -- count is still known. Dropping the '%@%' test trips this instead of
  -- quietly breaking sign-in for every member on staging.
  IF (SELECT count(*) FROM auth.identities
       WHERE provider = 'email' AND provider_id = user_id::text) <> n_uuid_pids THEN
    RAISE EXCEPTION 'scrub rewrote auth.identities.provider_id on rows holding a user id (% before, % after). That column is what GoTrue resolves a login by; it is not an address on this build.',
      n_uuid_pids, (SELECT count(*) FROM auth.identities
                     WHERE provider = 'email' AND provider_id = user_id::text);
  END IF;

  -- BEARER TOKENS. Each of these is "knowing the string is being the member".
  -- A calendar feed token read out of a staging dump works against PRODUCTION
  -- if the same row exists there, which it does, because staging is a copy.
  -- There is nothing to anonymise here, only to remove.
  IF to_regclass('public.calendar_feed_tokens')     IS NOT NULL THEN DELETE FROM public.calendar_feed_tokens; END IF;
  IF to_regclass('public.session_checkin_tokens')   IS NOT NULL THEN DELETE FROM public.session_checkin_tokens; END IF;
  IF to_regclass('public.tournament_checkin_tokens') IS NOT NULL THEN DELETE FROM public.tournament_checkin_tokens; END IF;
  IF to_regclass('public.discord_link_tokens')      IS NOT NULL THEN DELETE FROM public.discord_link_tokens; END IF;

  -- GUEST WAIVER SIGNINGS (00254): non-members' names and emails, each with a
  -- bearer proof token. Nothing to anonymise that would be worth testing
  -- against, so the rows go. No trigger guards this table and the superuser
  -- ignores its grants, so a plain DELETE is enough. Guarded because the table
  -- exists only once production has 00254.
  IF to_regclass('public.guest_waiver_signings') IS NOT NULL THEN DELETE FROM public.guest_waiver_signings; END IF;

  -- THE GOOGLE FORM READER (00287 onward). Two separate leaks, both closed here.
  --
  -- 1. The BINDINGS. A copied registration_import_forms row is prod's live Form
  --    id, active, and staging holds the same reader key, so staging's 5-minute
  --    poll read the REAL Form and imported real respondents (caught by the
  --    owner 2026-10-21). Each form_id becomes a placeholder no Google Form can
  --    have, and every binding is switched off. drive_file_id on receipts goes
  --    the same way, or staging could download a real e-transfer screenshot.
  -- 2. What prod ALREADY imported: respondents' names and emails on the
  --    imports, entries, guest sign-ups and waiver invites, and the raw result.
  IF to_regclass('public.registration_import_forms') IS NOT NULL THEN
    UPDATE public.registration_import_forms
       SET form_id = 'staging-scrubbed-' || substr(md5(id::text), 1, 12),
           active = FALSE, poll_error = NULL;
  END IF;
  IF to_regclass('public.registration_import_receipts') IS NOT NULL THEN
    UPDATE public.registration_import_receipts
       SET drive_file_id = 'staging-scrubbed-' || substr(md5(id::text), 1, 12);
  END IF;
  IF to_regclass('public.registration_imports') IS NOT NULL THEN
    UPDATE public.registration_imports
       SET submitter_name  = CASE WHEN submitter_name  IS NULL THEN NULL ELSE 'Form Respondent' END,
           submitter_email = CASE WHEN submitter_email IS NULL THEN NULL
                                  ELSE 'respondent.' || substr(md5(id::text), 1, 10) || '@staging.invalid' END,
           result = CASE jsonb_typeof(result) WHEN 'array' THEN '[]'::jsonb WHEN 'object' THEN '{}'::jsonb ELSE result END;
  END IF;
  IF to_regclass('public.registration_import_entries') IS NOT NULL THEN
    UPDATE public.registration_import_entries
       SET external_name  = CASE WHEN external_name  IS NULL THEN NULL ELSE 'Form Guest' END,
           external_email = CASE WHEN external_email IS NULL THEN NULL
                                 ELSE 'guest.' || substr(md5(id::text), 1, 10) || '@staging.invalid' END,
           partner_name   = CASE WHEN partner_name   IS NULL THEN NULL ELSE 'Form Partner' END,
           partner_email  = CASE WHEN partner_email  IS NULL THEN NULL
                                 ELSE 'partner.' || substr(md5(id::text), 1, 10) || '@staging.invalid' END,
           confirm_email_error = NULL;
  END IF;
  IF to_regclass('public.club_event_external_signups') IS NOT NULL THEN
    UPDATE public.club_event_external_signups
       SET full_name = 'Form Guest',
           email = CASE WHEN email IS NULL THEN NULL
                        ELSE 'guest.' || substr(md5(id::text), 1, 10) || '@staging.invalid' END;
  END IF;
  IF to_regclass('public.guest_waiver_invites') IS NOT NULL THEN
    UPDATE public.guest_waiver_invites
       SET email = 'invite.' || substr(md5(id::text), 1, 10) || '@staging.invalid', last_error = NULL;
  END IF;
  -- THE FORMS THE CONSOLE MADE (00296). A copied row names a real Form on the
  -- club account, and staging holds a form maker of its own, so its sync job
  -- would rewrite, close or reopen the real Form. Each row loses its Form id
  -- and links and is marked failed, so staging never acts on one.
  IF to_regclass('public.managed_registration_forms') IS NOT NULL THEN
    UPDATE public.managed_registration_forms
       SET form_id = NULL, responder_url = NULL, edit_url = NULL,
           state = 'failed', last_error = 'staging_copy', claimed_at = NULL;
  END IF;
  -- The preferred partner a Form answer named (00299): another person, by the
  -- name typed, on the sign-ups of members and guests. Guarded on the column,
  -- since a source without 00299 lacks it.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'club_event_signups'
                AND column_name = 'preferred_partner') THEN
    UPDATE public.club_event_signups SET preferred_partner = 'Form Partner'
     WHERE preferred_partner IS NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'club_event_external_signups'
                AND column_name = 'preferred_partner') THEN
    UPDATE public.club_event_external_signups SET preferred_partner = 'Form Partner'
     WHERE preferred_partner IS NOT NULL;
  END IF;

  -- RECEIPTS STILL QUEUED for the server's own read (00297). Staging has prod's
  -- rows but not its fee-proofs objects, so a staging check could only fail
  -- them; closed here so nothing on staging reaches for them. Guarded on the
  -- column, which exists only once production has 00297.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'fee_submissions' AND column_name = 'ocr_state') THEN
    UPDATE public.fee_submissions SET ocr_state = 'done' WHERE ocr_state = 'pending';
  END IF;

  -- RECEIPTS STILL QUEUED for the server's own read (00297). Staging has prod's
  -- rows but not its fee-proofs objects, so a staging check could only fail
  -- them; closed here so nothing on staging reaches for them. Guarded on the
  -- column, which exists only once production has 00297.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'fee_submissions' AND column_name = 'ocr_state') THEN
    UPDATE public.fee_submissions SET ocr_state = 'done' WHERE ocr_state = 'pending';
  END IF;

  -- Device records. Passkeys are scoped to the hostname they were enrolled on,
  -- so production's cannot work on staging regardless; push endpoints are
  -- per-device URLs that would aim staging's notifications at real phones.
  --
  -- This delete has to stand a guard down first. trg_guard_last_admin_passkey
  -- (00050) refuses to remove the last passkey belonging to an admin, because
  -- on production that is the row whose loss makes the console unreachable.
  -- Staging is the case that guard was not written for: these rows arrived in
  -- the dump, WebAuthn scopes a credential to the hostname it was enrolled on
  -- so not one of them can authenticate here, and the owner re-enrols after
  -- every refresh regardless. The guard is BEFORE DELETE FOR EACH ROW with no
  -- current_user escape hatch, so running as postgres does not help: superuser
  -- bypasses RLS and grants, never triggers. That is the whole class of bug,
  -- not one trigger.
  --
  -- Disabled by name rather than with session_replication_role, which would
  -- also stop foreign keys and could leave dangling references behind. Both
  -- ALTERs are inside this transaction, so an abort puts the guard back with
  -- everything else, and the floor guard below re-checks that it is on.
  IF to_regclass('public.passkey_credentials') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'trg_guard_last_admin_passkey'
                  AND tgrelid = 'public.passkey_credentials'::regclass) THEN
      ALTER TABLE public.passkey_credentials DISABLE TRIGGER trg_guard_last_admin_passkey;
      DELETE FROM public.passkey_credentials;
      ALTER TABLE public.passkey_credentials ENABLE TRIGGER trg_guard_last_admin_passkey;
    ELSE
      DELETE FROM public.passkey_credentials;
    END IF;
  END IF;
  IF to_regclass('public.push_subscriptions')  IS NOT NULL THEN DELETE FROM public.push_subscriptions; END IF;

  -- Resend's bounce and complaint records. Pure address data, no test value.
  IF to_regclass('public.email_suppressions') IS NOT NULL THEN DELETE FROM public.email_suppressions; END IF;

  -- FREE TEXT WRITTEN ABOUT MEMBERS. The six note tables are where the five
  -- columns dropped from `players` went, and they are the most sensitive text
  -- in the database: an officer's private assessment of a person. Rows are kept
  -- so the "has notes" state still renders; only the text goes.
  IF to_regclass('public.match_admin_notes')           IS NOT NULL THEN UPDATE public.match_admin_notes           SET note = 'Note removed for staging.'; END IF;
  IF to_regclass('public.tournament_match_notes')      IS NOT NULL THEN UPDATE public.tournament_match_notes      SET note = 'Note removed for staging.'; END IF;
  IF to_regclass('public.tournament_pair_notes')       IS NOT NULL THEN UPDATE public.tournament_pair_notes       SET note = 'Note removed for staging.'; END IF;
  IF to_regclass('public.tournament_participant_notes') IS NOT NULL THEN UPDATE public.tournament_participant_notes SET note = 'Note removed for staging.'; END IF;
  IF to_regclass('public.varsity_notes')               IS NOT NULL THEN UPDATE public.varsity_notes               SET note = 'Note removed for staging.'; END IF;
  IF to_regclass('public.walkover_admin_notes')        IS NOT NULL THEN UPDATE public.walkover_admin_notes        SET note = 'Note removed for staging.'; END IF;

  IF to_regclass('public.disputes')        IS NOT NULL THEN UPDATE public.disputes        SET resolution_note = CASE WHEN resolution_note IS NULL THEN NULL ELSE 'Resolution note removed for staging.' END; END IF;
  IF to_regclass('public.challenges')      IS NOT NULL THEN UPDATE public.challenges      SET note  = CASE WHEN note  IS NULL THEN NULL ELSE 'Note removed for staging.'  END; END IF;
  IF to_regclass('public.sessions')        IS NOT NULL THEN UPDATE public.sessions        SET notes = CASE WHEN notes IS NULL THEN NULL ELSE 'Notes removed for staging.' END; END IF;
  IF to_regclass('public.feedback_reports') IS NOT NULL THEN UPDATE public.feedback_reports SET body = 'Feedback body removed for staging.'; END IF;

  -- manual_name names a person who has no account at all, so it is the one
  -- identifier in the fee ledger that the players scrub above cannot reach.
  IF to_regclass('public.club_fees') IS NOT NULL THEN
    UPDATE public.club_fees
       SET manual_name = CASE WHEN manual_name IS NULL THEN NULL ELSE 'Unnamed Payer' END,
           ban_reason  = CASE WHEN ban_reason  IS NULL THEN NULL ELSE 'Reason removed for staging.' END;
    -- 00252's manual_email is a non-member's address waiting for a signup. It is
    -- rewritten, not nulled: since 00284 a fee with no player must carry a name
    -- AND an email (club_fees_shape_check), so a NULL here failed the whole
    -- scrub the first time prod held a guest's event fee (2026-10-21). The
    -- 'payer.' prefix keeps it apart from the 'member.' addresses players get,
    -- so no staging player is ever handed the fee. The column only exists once
    -- 00252 is applied.
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'club_fees' AND column_name = 'manual_email') THEN
      EXECUTE $q$UPDATE public.club_fees
                    SET manual_email = 'payer.' || substr(md5(id::text), 1, 10) || '@staging.invalid'
                  WHERE manual_email IS NOT NULL$q$;
    END IF;
  END IF;

  -- External teams (00269) are two people with no account, named only here and in
  -- pair_name. Guarded on the column, since a source without 00269 lacks it.
  -- The two names must differ (tournament_pairs_member_or_external).
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tournament_pairs' AND column_name = 'external1_name') THEN
    UPDATE public.tournament_pairs
       SET external1_name = 'External ' || left(id::text, 8) || ' A',
           external2_name = 'External ' || left(id::text, 8) || ' B',
           pair_name   = 'External ' || left(id::text, 8) || ' A / External ' || left(id::text, 8) || ' B'
     WHERE external1_name IS NOT NULL;
  END IF;

  -- The audit log's old_value/new_value hold whole field-level diffs, which is
  -- exactly where a pre-scrub name or email survives a scrub of its own table.
  -- Rows and action types stay so the audit screen still has something to sort,
  -- filter and paginate.
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    UPDATE public.audit_logs
       SET reason    = CASE WHEN reason IS NULL THEN NULL ELSE 'Reason removed for staging.' END,
           old_value = CASE WHEN old_value IS NULL THEN NULL ELSE '{"scrubbed": true}'::jsonb END,
           new_value = CASE WHEN new_value IS NULL THEN NULL ELSE '{"scrubbed": true}'::jsonb END;
  END IF;
  IF to_regclass('public.tournament_audit_log') IS NOT NULL THEN
    UPDATE public.tournament_audit_log
       SET details = CASE WHEN details IS NULL THEN NULL ELSE '{"scrubbed": true}'::jsonb END;
  END IF;

  -- Notification bodies name people ("X challenged you"), and after the scrub
  -- those names would disagree with the roster anyway.
  IF to_regclass('public.notifications') IS NOT NULL THEN
    UPDATE public.notifications SET body = 'Body removed for staging.';
  END IF;

  -- Browser fingerprints captured at signature time.
  IF to_regclass('public.waiver_acceptances')       IS NOT NULL THEN UPDATE public.waiver_acceptances       SET user_agent = 'scrubbed' WHERE user_agent IS NOT NULL; END IF;
  IF to_regclass('public.event_waiver_acceptances') IS NOT NULL THEN UPDATE public.event_waiver_acceptances SET user_agent = 'scrubbed' WHERE user_agent IS NOT NULL; END IF;

  -- KNOWN RESIDUAL, left on purpose: public.announcements.body. Announcements
  -- are exec-authored broadcasts already shown to the whole membership, and
  -- blanking them removes a real rendering surface. They CAN name a member, so
  -- this is an accepted trade rather than an oversight. Revisit if announcement
  -- text ever starts carrying anything private.
END
$scrub$;

COMMIT;
SQL

  # ---------------------------------------------------------------------------
  # THE FLOOR GUARD, in the same spirit as the three above: assert the outcome
  # against the database rather than trusting that the statements ran. A scrub
  # that silently matched zero rows looks identical to one that worked, and the
  # failure is invisible until someone reads a real address off staging.
  echo "[$(date -u +%FT%TZ)] verifying the scrub..."
  leak=$(docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres \
      -Atq -v ON_ERROR_STOP=1 -v emails="$STAGING_ADMIN_EMAILS" <<'SQL'
WITH keep AS (
  SELECT btrim(e) AS email FROM unnest(string_to_array(:'emails', ',')) e WHERE btrim(e) <> ''
)
SELECT 'players.email         ' || count(*) FROM public.players p
 WHERE p.email NOT LIKE '%@staging.invalid'
   AND p.email NOT LIKE 'deleted+%@deleted.invalid'
   AND p.email NOT IN (SELECT email FROM keep)
UNION ALL
SELECT 'auth.users.email      ' || count(*) FROM auth.users u
 WHERE u.email IS NOT NULL
   AND u.email NOT LIKE '%@staging.invalid'
   AND u.email NOT LIKE 'deleted+%@deleted.invalid'
   AND u.email NOT IN (SELECT email FROM keep)
UNION ALL
SELECT 'players.phone         ' || count(*) FROM public.players p
 WHERE p.phone IS NOT NULL AND p.phone NOT LIKE '+1555%'
   AND p.email NOT IN (SELECT email FROM keep)
UNION ALL
SELECT 'non-email identities  ' || count(*) FROM auth.identities i
  JOIN public.players p ON p.user_id = i.user_id
 WHERE i.provider <> 'email' AND p.email NOT IN (SELECT email FROM keep)
UNION ALL
-- Only address-shaped values are asserted about. On this GoTrue, provider_id
-- for the email provider is the user's UUID, and demanding that it look like a
-- scrubbed address failed the run over a row that was correct: the keep-list
-- admin's, deliberately skipped by the scrub. A UUID carries no address to
-- leak, so it has nothing to prove here; one containing '@' does.
SELECT 'identity provider_id  ' || count(*) FROM auth.identities i
 WHERE i.provider = 'email'
   AND i.provider_id LIKE '%@%'
   AND i.provider_id NOT LIKE '%@staging.invalid'
   AND i.provider_id NOT LIKE 'deleted+%@deleted.invalid'
   AND i.provider_id NOT IN (SELECT email FROM keep)
UNION ALL
SELECT 'identity_data emails  ' || count(*) FROM auth.identities i
 WHERE i.identity_data->>'email' IS NOT NULL
   AND i.identity_data->>'email' NOT LIKE '%@staging.invalid'
   AND i.identity_data->>'email' NOT LIKE 'deleted+%@deleted.invalid'
   AND i.identity_data->>'email' NOT IN (SELECT email FROM keep)
UNION ALL
-- Not a leak check: the scrub switches trg_guard_last_admin_passkey off to
-- delete the passkeys, and a guard left switched off would silently remove a
-- production safety net from the environment that exists to rehearse it.
-- Joined by name rather than cast through regclass so a missing table counts
-- zero instead of making this guard itself the hard failure.
SELECT 'passkey guard disabled ' || count(*) FROM pg_trigger t
  JOIN pg_class c     ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'passkey_credentials'
   AND t.tgname = 'trg_guard_last_admin_passkey' AND t.tgenabled = 'D'
UNION ALL
-- Counted through query_to_xml because a plain reference to a table that does
-- not exist fails the whole query at parse time, and the table exists only once
-- production has 00254. The CASE keeps the count from running without it.
SELECT 'guest waiver signings  ' || CASE
         WHEN to_regclass('public.guest_waiver_signings') IS NULL THEN 0
         ELSE (xpath('/row/n/text()', query_to_xml(
                'SELECT count(*) AS n FROM public.guest_waiver_signings', false, true, '')))[1]::text::int
       END
UNION ALL
-- The Form reader, the same way. A binding still naming a real Form is the
-- worse of the two: the staging poll would import live respondents again.
SELECT 'live Form bindings     ' || CASE
         WHEN to_regclass('public.registration_import_forms') IS NULL THEN 0
         ELSE (xpath('/row/n/text()', query_to_xml(
                $q$SELECT count(*) AS n FROM public.registration_import_forms
                    WHERE form_id NOT LIKE 'staging-scrubbed-%' OR active$q$, false, true, '')))[1]::text::int
       END
UNION ALL
SELECT 'Form respondent emails ' || (
         SELECT coalesce(sum(n), 0)::int FROM (VALUES
           ('registration_imports', 'submitter_email'),
           ('registration_import_entries', 'external_email'),
           ('registration_import_entries', 'partner_email'),
           ('club_event_external_signups', 'email'),
           ('guest_waiver_invites', 'email')) AS c(tbl, col),
         LATERAL (SELECT CASE WHEN to_regclass('public.' || c.tbl) IS NULL THEN 0
                    ELSE (xpath('/row/n/text()', query_to_xml(format(
                      'SELECT count(*) AS n FROM public.%I WHERE %I IS NOT NULL AND %I NOT LIKE %L',
                      c.tbl, c.col, c.col, '%@staging.invalid'), false, true, '')))[1]::text::int
                  END AS n) AS counted)
UNION ALL
-- The preferred partner notes from the Form (00299), the same way, guarded on the
-- column so a source without 00299 counts zero.
SELECT 'Form partner notes     ' || (
         SELECT coalesce(sum(n), 0)::int FROM (VALUES
           ('club_event_signups', 'preferred_partner'),
           ('club_event_external_signups', 'preferred_partner')) AS c(tbl, col),
         LATERAL (SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                                                WHERE table_schema = 'public' AND table_name = c.tbl
                                                  AND column_name = c.col) THEN 0
                    ELSE (xpath('/row/n/text()', query_to_xml(format(
                      'SELECT count(*) AS n FROM public.%I WHERE %I IS NOT NULL AND %I <> %L',
                      c.tbl, c.col, c.col, 'Form Partner'), false, true, '')))[1]::text::int
                  END AS n) AS counted);
SQL
  )
  echo "$leak" | sed 's/^/  remaining /'
  if echo "$leak" | awk '{ if ($NF + 0 > 0) exit 1 }'; then
    echo "  scrub verified: no real member identifiers remain outside the keep-list."
    # Disarmed HERE and nowhere earlier. Not when the scrub returns, which only
    # says it ran: these floor checks are what say it worked.
    MEMBERS_EXPOSED=0
  else
    echo "FATAL: the scrub did not remove everything it claims to." >&2
    echo "       Staging is holding real member data right now. Treat it as" >&2
    echo "       production until this is fixed, and do not hand anyone access." >&2
    exit 1
  fi
fi

# PUT THE STAGING ADMINS' SESSIONS AND PASSKEYS BACK (set aside above).
#
# After the scrub, so its blanket passkey DELETE cannot remove these, and only
# once its floor guard has passed. Columns are the intersection of the saved and
# live tables, because the public schema was just rebuilt from prod plus
# replayed migrations. A row whose account or player no longer exists is
# skipped rather than failing the run: that admin signs in once.
if [ "$MEMBERS_EXPOSED" = "0" ]; then
  echo "[$(date -u +%FT%TZ)] restoring the staging admins' sessions and passkeys..."
  docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $restore$
DECLARE
  pair record;
  cols text;
  n integer;
BEGIN
  IF to_regnamespace('staging_keep') IS NULL THEN
    RAISE NOTICE 'nothing set aside to restore';
    RETURN;
  END IF;
  FOR pair IN
    SELECT * FROM (VALUES
      (1, 'sessions',            'auth.sessions',              'user_id IN (SELECT id FROM auth.users)'),
      (2, 'refresh_tokens',      'auth.refresh_tokens',        'session_id IN (SELECT id FROM auth.sessions)'),
      (3, 'mfa_amr_claims',      'auth.mfa_amr_claims',        'session_id IN (SELECT id FROM auth.sessions)'),
      (4, 'passkey_credentials', 'public.passkey_credentials', 'player_id IN (SELECT id FROM public.players)')
    ) v(ord, saved, live, still_valid)
    ORDER BY ord
  LOOP
    IF to_regclass('staging_keep.' || pair.saved) IS NULL OR to_regclass(pair.live) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
      FROM pg_attribute a
     WHERE a.attrelid = pair.live::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attgenerated = ''
       AND EXISTS (SELECT 1 FROM pg_attribute b
                    WHERE b.attrelid = ('staging_keep.' || pair.saved)::regclass
                      AND b.attname = a.attname AND NOT b.attisdropped);
    EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM staging_keep.%I WHERE %s ON CONFLICT DO NOTHING',
                   pair.live, cols, cols, pair.saved, pair.still_valid);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'restored % row(s) into %', n, pair.live;
  END LOOP;
  DROP SCHEMA staging_keep CASCADE;
END
$restore$;
COMMIT;
SQL
fi

# PostgREST caches the schema, and the app reads these tables through it. A
# restore that does not say so leaves the bot reading a stale cache.
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -q -c "NOTIFY pgrst, 'reload schema';"

# Retain 14 days of snapshots and of the privilege scripts that went with them
find "$OUT_DIR" -maxdepth 1 -name '*.sql.gz' -mtime +14 -delete 2>/dev/null || true
find "$OUT_DIR" -maxdepth 1 -name 'acls-*.sql' -mtime +14 -delete 2>/dev/null || true
find "$OUT_DIR" -maxdepth 1 -name 'publications-*.sql' -mtime +14 -delete 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] snapshot $TS complete."
echo "  public: $(ls -lh "$PUBLIC_DUMP" 2>/dev/null | awk '{print $5}')"
echo "  auth:   $(ls -lh "$AUTH_DUMP"   2>/dev/null | awk '{print $5}')"
echo "  acl statements:         $(grep -c ';' "$ACL_SQL" 2>/dev/null || true)"
echo "  publication statements: $(grep -c 'END \$do\$;' "$PUB_SQL" 2>/dev/null || true)"
