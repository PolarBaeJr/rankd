# Discord bot: bringing it up

What a human has to do to get the bot running. Everything here is a step that
**cannot** be done from a code change — a Discord Developer Portal setting, a
credential, or a SQL statement that only the DB owner runs.

> ⚠️ **This repository is public.** `<placeholders>` stand for real values that
> live in the club password manager and [CREDENTIALS.md](CREDENTIALS.md).

Do staging first, all the way through. Prod is the same list with prod values.

---

## Mental model

The bot is **three** moving parts, and they authenticate to each other in two
different directions. Getting this backwards is the most common way to waste an
hour:

```
Discord  --(signed with DISCORD_PUBLIC_KEY)-->  bot  --(Bearer DISCORD_SERVICE_SECRET)-->  player app
```

- **Discord → bot**: Discord signs every interaction with your application's
  public key. The bot verifies it. This is why `DISCORD_PUBLIC_KEY` must match
  the application you set the interactions URL on.
- **Bot → app**: the bot calls `/api/discord/*` with a bearer token. That token
  is `DISCORD_SERVICE_SECRET`, and it must be **byte-identical in two places**
  (see step 4). This is the step people get wrong.

The bot holds no session cookie and never signs in as a user.

---

## 1. A second Discord application, for staging

Staging needs **its own** application. Not a second bot user on the same
application — a separate application, because the interactions URL is a
property of the application and staging and prod cannot share one.

In the Discord Developer Portal:

1. **New Application** → name it something obviously non-production.
2. **Bot** tab → **Reset Token**, copy it. This is `DISCORD_BOT_TOKEN`.
3. **General Information** → copy **Application ID** (`DISCORD_APPLICATION_ID`)
   and **Public Key** (`DISCORD_PUBLIC_KEY`).
4. Invite it to your test server with the `bot` and `applications.commands`
   scopes and the **Manage Roles** and **Manage Events** permissions.

   Manage Events is what lets the bot create the scheduled event a tournament
   produces when it goes active (00169). It is easy to leave off, and the
   symptom is not an error anybody sees -- the Events tab simply stays empty --
   so the bot checks for the bit before it tries and logs
   `missing MANAGE_EVENTS` with the fix. A server invited before that migration
   can be repaired without re-inviting: **Server Settings -> Roles -> (the bot's
   role) -> Manage Events**.

## 2. Migrations

Do these before `/setup` — it writes to tables that have to exist first. Run, in
order, and **only** these:

| Migration | What it adds |
|---|---|
| `00165_discord_links.sql` | the link table and its tombstones |
| `00166_discord_nightly_sync.sql` | the pg_cron schedule, plus two `cron_config` rows |
| `00167_discord_runtime_config.sql` | guilds, roles, settings |
| `00168_discord_self_roles.sql` | the self-serve ping roles and the session-ping schedule |
| `00169_discord_tournament_events.sql` | the tournament -> Discord scheduled event mapping, and its schedule |
| `00170_discord_announcement_posts.sql` | the announcement -> Discord message mapping, and its schedule |
| `00245_club_events_go_to_the_discord_events_tab.sql` | the club event -> Discord scheduled event mapping (needs 00244 first); no schedule of its own, it rides 00169's |

> ### ⚠️ Pause the prod → staging snapshot before running these on staging
>
> The snapshot does `DROP SCHEMA public CASCADE` at 04:00 and then restores
> prod's `public` schema on top. Every table this bot keeps state in lives in
> `public`: `discord_guilds`, `discord_guild_roles`, `discord_settings`,
> `cron_config`, and — since 00168, 00169 and 00170 — `discord_self_roles`,
> `discord_session_pings`, `discord_tournament_events` and
> `discord_announcement_posts`.
>
> The last three make the consequence more than "lose the config". They are
> IDEMPOTENCY records: `discord_session_pings` is the only thing stopping a
> session being pinged again, `discord_tournament_events` is the only thing
> stopping a second Discord event being created for a tournament that already
> has one, and `discord_announcement_posts` is the only thing stopping a club
> announcement being posted into the channel twice. Inheriting prod's copies of
> those means staging believes prod's work was its own.
>
> Since 00245, `discord_club_events` is a fourth idempotency record of the same
> kind: the only thing stopping a second Discord event being created for a club
> event that already has one.
>
> The announcement relay has a second guard of its own — it relays nothing
> published more than 72 hours ago — so a staging database that comes up with
> its mapping table wiped does not replay a week of prod's notices into the test
> server. That guard is a floor, not a substitute for pausing the snapshot.
>
> So the damage is not just that staging's rows are erased — **staging inherits
> production's**. It would come up holding prod's guild id, prod's role ids,
> prod's `discord_bot_url` and prod's secret, i.e. the staging bot pointed at
> the production Discord server.
>
> What partly saves you is that staging's bot is a separate Discord application
> and is not a member of the prod server, so its calls 403. That is luck, not a
> safeguard. pg_cron's schedule lives in the `cron` schema and survives the drop
> regardless, so the wiped staging keeps running the sweep on time.
>
> Until the snapshot script learns to preserve these tables, staging cannot both
> refresh from prod and hold its own bot config. Pick one deliberately.

## 3. Roles in the test server

**Run `/setup club:True` in the server. That is the whole step.**

`club:True` connects a new server to the club, and needs a club exec account.
Once a server is connected, plain `/setup` reruns the club setup there. In a
server that is not the club's, plain `/setup` sets up only that server (its log
channel, the scam guard, a permission check) and never touches the club's
records, so any server admin can run it.

> `/setup` is a slash command, so it only exists after step 7
> (`npm run register -w bot`) and after the bot is running and reachable. If you
> are working through this in order, come back here once step 7 is done. The
> bot needs no config to serve `/setup` — that is the point of it.

It lists the guild's roles, adopts any that already match by name, creates the
rest with **no permissions**, and writes the ids to the database itself. No
copying snowflakes out of Discord's UI into SQL.

Requires **Manage Server** to run — Discord enforces that server-side, so the
command is not even visible to anyone else. That gate is the point: whoever runs
it decides which Discord role the bot hands to everyone the app says qualifies,
so it is restricted to the people who could already edit those roles by hand.

It is idempotent. Matching is on the normalised name, so "Session Staff",
"session-staff" and "session_staff" are one role, not three, and a club that
already made its own keeps its own name. Re-run it any time — after creating a
role by hand, after renaming one, or to pick up a role you skipped.

It never deletes or renames anything, and it never guesses: two roles sharing a
name are reported, not resolved, because picking one decides who gets what.

**Then drag the bot's own role above every role it manages.** `/setup` tells you
this every time it runs, because it is the single most common way this bot looks
like it is working while changing nothing: Discord refuses, with a 403, any
attempt to modify a member whose highest role sits above the bot's. The bot
colours that 403 amber rather than red, so a nightly sweep hitting it does not
read as an incident.

> Roles `/setup` creates carry **zero permissions**. Discord's API copies
> `@everyone`'s permissions onto a new role when the field is omitted, so on a
> server where `@everyone` can manage messages this would otherwise mint nine
> roles carrying that power. A created role is a label until a human grants it
> something.

## 4. The shared secret, in both places

`DISCORD_SERVICE_SECRET` must be identical in:

1. `.env.staging` on the server — this is what the **bot** sends.
2. The dashboard secrets file for the **player** service — this is what the app
   compares against.

The app's check fails closed: if the secret is unset there, every bot call is
rejected. A mismatch and a missing value look exactly the same from outside
(both 401), so set them from one source:

```sh
# on the server. Copies the existing line; never prints the value.
SRC=<staging-deploy-dir>/.env.staging
DST=/etc/proxy-manager/secrets/badminton-staging-player.env
sudo grep -q '^DISCORD_SERVICE_SECRET=' "$DST" \
  || grep -m1 '^DISCORD_SERVICE_SECRET=' "$SRC" | sudo tee -a "$DST" >/dev/null

# verify by key name only
sudo cut -d= -f1 "$DST" | grep DISCORD
```

Then make the player service pick it up:

```
replace_service(service="badminton-staging-player",
                image="ghcr.io/<owner>/badminton-player-staging:latest",
                env={"DISCORD_SERVICE_SECRET": "ref:DISCORD_SERVICE_SECRET"})
```

`ref:NAME` is a **dashboard-API feature only**. Docker Compose does not resolve
it — anything compose creates (including the bot) reads `${VAR}` from
`.env.staging` instead. Putting `ref:` in a compose file yields the literal
string `ref:NAME` as the value, silently.

## 4b. Tell the bot where the app is

`APP_API_URL` has **no default**, deliberately. Set it in `.env`.

The obvious value — `http://player:3000` — does not work and used to be the
default. Player and admin are onboarded through the proxy dashboard rather than
started by compose, so they run under generated names and nothing resolves
`player`. The symptom is `TypeError: fetch failed` on every app call, which
reads as a network fault rather than a config mistake.

**Use the public origin, in both environments.** The in-cluster container name
is faster and stays off the internet, and it is a trap: the dashboard rotates
the container name on every replace, not only when scaling — observed going
`…-1000` → `…-1` → `…-2` across three routine replaces in one evening. Each
rotation breaks the URL and surfaces as `TypeError: fetch failed`, which reads
as a network fault rather than a stale name.

`APP_PUBLIC_URL` must be the public origin regardless — it builds the link a
member taps on a phone.

## 4c. Tell the app where the bot is

The reverse direction, and it is easy to miss because **the value looks
configured when it is not**. `DISCORD_BOT_URL` appears in the `player` service
of both compose files, but the player app is onboarded through the dashboard,
so that `environment:` block never reaches it. Compose is not where this gets
set on a deployed host.

Set it on the player service through the dashboard, re-passing the secret,
because a replace without `env` **drops** it:

```
replace_service(<player-service>, <image>, env={
  "DISCORD_BOT_URL": "https://<bot-subdomain>",
  "DISCORD_SERVICE_SECRET": "ref:DISCORD_SERVICE_SECRET",
})
```

Then confirm it is actually there — the container name changes on every
replace, so resolve it first:

```
C=$(ssh <host> 'docker ps --format "{{.Names}}" | grep <player> | head -1')
ssh <host> "docker exec $C printenv DISCORD_BOT_URL"
```

**Why this one fails quietly.** The `/link` page asks the bot to apply roles the
moment an account connects, and treats a failed sync as non-fatal on purpose —
the link is already made, so it says *"your roles will appear shortly"* rather
than failing. With `DISCORD_BOT_URL` unset the sync is never attempted, that
message is shown forever, and the only evidence is one line in the **player's**
log, not the bot's:

```
[discord] cannot sync: DISCORD_BOT_URL or DISCORD_SERVICE_SECRET unset
```

Nothing appears in the bot's log, because the bot is never contacted. If a
member reports "connected but no roles", read the player log first.

To apply roles for members who linked while it was broken, sweep everyone
rather than asking them to re-link. Run it from inside the bot container so the
secret stays in its own environment:

```
ssh <host> 'docker exec <bot> node -e "
const s=process.env.DISCORD_SERVICE_SECRET;
fetch(\"http://127.0.0.1:3002/sync\",{method:\"POST\",
  headers:{authorization:\`Bearer \${s}\`,\"content-type\":\"application/json\"},
  body:JSON.stringify({trigger:\"manual\"})})
 .then(r=>r.text().then(t=>console.log(r.status,t)))"'
```

## 5. DNS

**The prod bot is `bot.sfubadminton.com`, not `discord.`.** The `discord.`
subdomain is a redirect to the server invite, and pointing the bot's own
hostname at it would be far worse than a 404 in one specific place: `pg_net`
follows redirects. The nightly `POST /sync` would land on Discord's invite
page, receive a **200**, and look healthy forever while never syncing a member.

Two consequences when setting prod up:

- `cron_config.discord_bot_url` must be `https://bot.sfubadminton.com`. **The
  OWNER STEP comment in `00166_discord_nightly_sync.sql` still says
  `discord.sfubadminton.com`** -- it is not edited because that migration is
  already applied and `db-migrate.sh` checksums files, so changing it would
  report DRIFTED. Take the hostname from here, not from that comment.
- Verify the sync by reading `net._http_response.content`, never the status.
  A 200 from a redirect target proves nothing.


Point `<bot-subdomain>` at the server. Do this in the Cloudflare UI; the
dashboard's DNS token is currently returning 403 (code 9109).

## 6. Start it

```sh
cd <staging-deploy-dir>
git pull
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d bot
curl -s https://<bot-subdomain>/health
```

The bot is **not** behind the proxy's auth gate, and that is deliberate — auth
is opt-in per host via the `proxy.auth` label, and the bot's service simply
omits it. Discord must be able to reach it unauthenticated; the signature check
is the gate.

## 7. Tell Discord where it is, and register the commands

1. Developer Portal → **General Information** → **Interactions Endpoint URL** →
   `https://<bot-subdomain>/interactions`. Discord sends a signed PING and
   refuses to save unless it gets a valid response — so the bot must already be
   running, with the matching `DISCORD_PUBLIC_KEY`.
2. `npm run register -w bot`

## 7b. The channels the club has to name

Seven features post into a channel, and none of them guesses one: a relay that
picked a channel by itself would be a relay putting club business somewhere
nobody chose. Each is a `discord_settings` row, so each is off until it is set:

| Key | What it drives | Set in |
|---|---|---|
| `audit_channel_id` | link/unlink and sweep embeds | `/setup audit_channel:` |
| `session_ping_channel_id` | the before-each-session ping | SQL (00168) |
| `session_board_channel_id` | the self-updating upcoming-sessions board | `/config channels session_board:` |
| `announcement_channel_id` | the announcement relay (00170) | SQL |
| `match_results_channel_id` | the match result relay (00171) | SQL |
| `feedback_channel_id` | `/bug` and `/feedback` (00173) | SQL |
| `event_feedback_channel_id` | tournament survey comments (00173) | SQL |

The server log is not in this table: since 00302 each server sets its own, with
`/config server_log channel:`. Auto mod (the scam guard in the code) is set the
same way with `/config automod`: on or off, what a caught account gets (timeout
then soft-ban, timeout, soft-ban, or flag only), the spray rule's channels and
minutes, the server's own words, trap channels, and whether lone giveaway posts
are flagged (00303). `/config automod` with no options shows the setup. Both
live in `discord_server_settings`, one row per server. In a club server the
caller also needs the club check `/config` uses.

Auto mod needs **Moderate Members** to time out and **Manage Messages** to
delete, besides Ban Members for the soft-ban. `/setup` lists any that are
missing.

**The server log also needs `DISCORD_SERVER_LOG`** on the bot, a comma list of
scopes, each costing a gateway intent:

| Scope | Logs | Intent | Portal toggle |
|---|---|---|---|
| `moderation` | Discord's audit log: bans, kicks, timeouts, role/channel/invite changes, moderator deletes | GUILD_MODERATION | none; the bot role needs **View Audit Log** |
| `members` | joins (with account age) and leaves | GUILD_MEMBERS | **Server Members Intent** |
| `messages` | deleted and edited messages, by author and channel | GUILD_MESSAGES | none |
| `content` | adds the TEXT of deleted and edited messages | MESSAGE_CONTENT | **Message Content Intent** |

A privileged scope without its portal toggle gets close code 4014; the bot then
reconnects with no intents, stays online, and logs that the server log is off.
Deleted-message text comes from an in-memory cache, so a message older than
the running container shows as not cached. The channel is a log of members'
words: make it exec-only.

**THE LAST TWO MUST BE EXEC-ONLY CHANNELS, AND THEY ARE SEPARATE ON PURPOSE.**
A bug report names its reporter. A tournament survey comment names its author
and was written under a promise, printed on the form, that only the exec team
sees it. Setting one key does not set the other precisely so that promise is
never inherited from a decision somebody made about bug reports. Pointing both
at the same private channel is the expected configuration; check the channel's
permissions before setting either.

```sql
INSERT INTO discord_settings (key, value)
VALUES ('announcement_channel_id', '<channel id>')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Right-click the channel -> **Copy Channel ID** (Developer Mode on). The bot
needs View Channel and Send Messages there. It edits and deletes only its own
messages, which needs no further permission — so unlike the scheduled events
there is nothing to grant.

**Only announcements addressed to everyone are relayed.** A competitive-only or
eligible-only notice is skipped and logged as `narrow_audience`, because that
rule is matched against a value on the reading member and no Discord channel
carries one. That is the design, not a gap; see 00170's header.

**Deleting an announcement in the console takes its Discord copy down too**, and
that is why neither mapping table has a foreign key to the row it maps. The
console's delete is a hard `DELETE`; an `ON DELETE CASCADE` would remove the
mapping first, and the mapping is the only thing that knows which Discord
message or event belongs to the row — the copy would stay up with nothing left
to find it by. So the mapping outlives the record on purpose, and the next tick
sees an id that no longer resolves and retracts it. Same for a deleted
tournament and its scheduled event.

**A sync that answers 503 `announcements_unverified` or `tournaments_unverified`
is refusing to retract, not failing.** It means every mapped row looked deleted
*and* the underlying table read back empty — and in this stack a broken read
returns an empty list rather than an error, so "they were all deleted" and "I
cannot see the table" are the same answer. Since the second one would empty the
channel or the Events tab in a single tick, the route declines to guess. When
you see it, check the service role's `SELECT` grant (read `pg_class.relacl`, not
`information_schema`) and reload the PostgREST cache with
`NOTIFY pgrst, 'reload schema'`. It clears itself as soon as one row is
readable.

### The upcoming-sessions board

**One message, pointed at a channel once, that keeps itself current.** An exec
runs `/config channels session_board:#sessions` and never touches it again. The
schedule is re-rendered on the existing five minute announcements tick and the
message is edited IN PLACE, so the board stays where the club pinned it instead
of a new copy arriving every evening. There is no migration and no new cron
entry: the state lives in two `discord_settings` rows, `session_board_channel_id`
and `session_board_state`, and the tick is the third job inside
`POST /announcements`.

**It has no reasoning file of its own, so the reasoning is here.**

**Nothing is sent unless the render changed.** Every tick hashes the whole REST
body it would send, components included, and stores the first 32 hex characters
in `session_board_state`. An identical hash means no Discord call and no
database write at all, which is the branch that runs 287 times a day. The
consequence is worth knowing before you read the log: `unchanged` is the healthy
outcome and `edited` on tick after tick is a bug, because it means something
clock derived crept into the render. Covering the components is the part that is
load-bearing rather than tidy: when the schedule shrinks from 28 sessions to 8
the board has to LOSE its pager, and an edit that sent only the embed would leave
live buttons on a one-page board.

**A member's click never moves the post.** Every button and the location select
on the board carry `sesboard:p:` ids, and a `p` id can only ever be answered with
a fresh private message to the person who clicked. Their own copy carries
`sesboard:e:` ids, which edit that copy and nothing else. So the whole club can
browse the same board at once, each on their own page and their own location
filter, and the public message is untouched by all of it. This is why the click
path and the tick share no state: the board records no page, no filter and no
copy ids, and the state route refuses any field it does not know.

**`/sessionpost` still exists and is still a one-off snapshot.** The two embeds
are told apart by one static footer clause on the board saying that it updates
itself. Without that clause a snapshot from last month sits in the channel
looking exactly as authoritative as the live board.

**Recovering it.** Deleting the board by hand is respected for exactly one tick:
the PATCH answers 404, the bot forgets the message id, KEEPS its repost
counters, and the next tick posts a fresh one. Three reposts in 24 hours is the
ceiling. A channel that deletes messages on a timer is the case that cap exists
for, and when it binds the bot logs an error and goes quiet rather than posting a
new schedule every five minutes forever. If a tick dies between marking a post
and recording its id, the state is left `pending` with no message id and every
later tick refuses to post, loudly, rather than risk a second board. The way out
needs no SQL: `/config clear`, pick **Session board**, which drops the whole row
and resets the counters. Setting the channel again posts a new board on the next
tick. The emergency equivalent, if that is ever unavailable, is

```sql
DELETE FROM public.discord_settings WHERE key = 'session_board_state';
```

**Clearing the channel setting takes the board down.** That is the off switch,
not a way to pause it, and it is the one path that deletes the message and the
state row together. Repointing the setting at a different channel does the same
to the old copy: a board is a singleton, so unlike a relayed announcement the
previous one is not left behind as a historical artifact.

**An empty schedule is never POSTED, but a live board is edited to empty.** A
public "no sessions are open" reads as the club announcing it has cancelled
everything, which is why `/sessionpost` refuses it too. Leaving the last render
up is worse than saying so, though: those rows are absolute timestamps that
quietly become a list of nights that already happened.

> **The nightly snapshot points staging's board at prod's message.** The 04:00
> prod to staging refresh copies `discord_settings` (see the warning at the top
> of section 2), so staging can come up holding prod's board channel and prod's
> message id. Staging's bot is a separate Discord application and is not in the
> prod server, so its PATCH answers 403, which lands in `failed` and is noise, or
> 404, which lands in `gone`. The 404 case is why the counters survive a missing
> message. A refused post does not spend the repost budget, though, because
> nothing was created: staging retries once per tick and logs an error every time
> until `session_board_channel_id` is re-set. That is noise, not a loop that
> posts anything. Re-set
> `session_board_channel_id` on staging after a refresh, and pause the snapshot
> if you need staging to hold its own bot config for longer than a day.

**Re-register the commands or none of this is reachable.** The channel is set
through `/config`, whose options are part of the registered command, so
`npm run register -w bot` is required and a deploy does not do it. Until it
propagates the board does nothing, with clean logs.

### Match results (00171)

**What goes out: who played, the score, who won. No Elo.** Not an oversight —
the score is a fact about a game other members watched happen, while a rating
delta is a judgment about a person, and the club already ships an opt-out that
exists precisely so that judgment is not on display. The route does not select
`rating_delta` or `post_rating` at all, so there is no column for a later edit
to leak. Members read their own numbers from `/my-stats`, which answers
ephemerally, to the person they are about.

**Only `rated_challenge` and `admin_entered` results are relayed.** Casual
matches are excluded on purpose: a club night of doubles rotations would turn
the channel into a firehose. Tournament results are not relayed either, and not
because of a setting — tournament results live in `tournament_matches` and never
become `matches` rows, so there is nothing to relay. Pending, disputed, voided
and walkover results never go out; a walkover in particular names who forfeited.

**A match with any participant who has `hide_from_leaderboard` set is held back
whole**, not posted with that name removed — in a two-player match, redacting
one name identifies the opt-out by elimination.

**That check runs once, when the match is first considered. It is a filter, not
a takedown.** The flag lives on `players`, so setting it does not touch
`matches.updated_at` and cannot pull an already-posted result back for
reconsideration. A member who opts out today does *not* have last month's posts
removed. The remedy is to delete those messages in Discord by hand, which is
permanent here — the relay only ever posts a match that has no mapping row.

**To take the whole relay down**, delete the messages in Discord first and then
`DELETE FROM discord_match_posts;` — in that order. Clearing
`match_results_channel_id` alone stops new posts but leaves the old ones up,
because retraction needs a channel to delete from.

**Unlike the other two relays, this one has no refuse-to-act guard**, and that
is deliberate: it reads a 72-hour window keyed on `updated_at`, every retraction
(void, dispute, convert-to-casual) is an `UPDATE` that bumps that column, and no
confirmed match is ever hard-deleted. So absence from the window means
"unchanged", never "deleted", and a silently failed read makes the route do
*nothing* rather than wipe the channel. The failure direction is already safe.
The cost is that a broken read here is **silent** — if the channel goes quiet,
check the `SELECT` grant via `pg_class.relacl`, reload the PostgREST cache, and
read the bot log, which names every skipped match and why.

**Deleting the bot's message or event in Discord by hand is respected.** It is
not re-posted, and an edit that arrives afterwards is recorded rather than
retried — otherwise the sync would PATCH a dead id every few minutes forever.
Those show up in a run result as `stale`.

**One tick carries 150 matches, ordered by `updated_at`.** That ordering is the
load-bearing part: the rows with something due are the ones changed most
recently, so truncation can only defer the matches that changed *least* recently
— which by definition need nothing. If the bot logs `filled its 150-row window`
on tick after tick, the club's volume has outgrown the window and it should be
raised; a single capped tick after a busy night is normal and self-corrects.

### Bug reports and feedback (00172, 00173)

**`/bug` and `/feedback` open a form, not a text box.** The command answers with
a Discord modal carrying two inputs — a short **title** and a paragraph
**details** box — and the report is filed when that is submitted, not when the
command is run. Pressing Escape files nothing.

**A screenshot is picked on the command, not in the modal**, as
`/bug screenshot:<file>`. That is a Discord limitation and not a preference: a
modal accepts text inputs and nothing else. The two are separate interactions,
so the bot holds the picked file in memory against a nonce in the modal's
`custom_id` until the submit arrives. Losing that — a restart, a second replica
— costs the picture and never the report, and the confirmation says so.

**The reply is still ephemeral.** What changed in 00173 is where the report goes
afterwards: the relay posts it into `feedback_channel_id` within ten minutes, so
the execs read it in a private channel rather than in a psql session. The
reporter's own channel still sees nothing.

**`/feedback about:` picks the kind**: general feedback (the default), a
tournament, or something else. `/bug` always files `bug`. Four kinds, one table.

**Website feedback is relayed too, to a DIFFERENT channel.** The post-tournament
survey (`event_feedback`, 00001 — the 1-5 rating and comment on a tournament
page) goes to `event_feedback_channel_id`. Only responses **with a comment** are
relayed; a bare rating is a number for the stats page. Because that form is
editable, a revised comment edits its own Discord message and an emptied comment
deletes it — that is the only retraction a member has.

**These are still two different things.** `event_feedback` is the structured
survey, tied to a tournament by FK, one per player per event. The
`tournament_feedback` *kind* in `feedback_reports` is the free-text remark
somebody types the evening of an event, with no rating and no event attached.

**There is still no admin page.** The Discord channel is now the primary reader;
psql remains the fallback:

```sql
SELECT created_at, kind, title, body, player_id, discord_user_id
  FROM feedback_reports
 WHERE status = 'open'
 ORDER BY created_at DESC;
```

and to close one out:

```sql
UPDATE feedback_reports SET status = 'resolved', updated_at = now() WHERE id = '<id>';
```

`status` is one of `open`, `triaged`, `resolved`, `wont_fix`. Marking one
resolved does **not** touch the Discord message: the relay windows reports on
`created_at`, so triage state never re-posts.

**A report older than 72 hours is never relayed.** The row is in the table and
psql finds it, but the channel will not learn about it. That is the same
lookback the other relays use, and it is why a failed post is never recorded as
done — an unposted report retries every tick until it ages out.

**An unlinked member can still file.** `player_id` is null and the reply says so
— they are the people most likely to have hit an onboarding bug, and turning
them away would silence exactly that report. `discord_user_id` is kept either
way, so the relay can render an inert `<@id>` mention and an exec can click
through even when there is no club account behind it.

**The rate limit is eight reports per hour per Discord user**, not per IP: every
request to that route arrives from the one bot process, so an IP key would put
the whole club in a single bucket. It is in-memory and per-process, so two
player replicas means an effective sixteen. That is fine — it is anti-spam, not
an auth gate.

**Taking a single report down** is a manual delete in Discord. The mapping row
survives, and the relay only ever posts what has no mapping, so it is never
re-posted. Hand deletion is permanent here by design.

---

## 8. Check it worked

- `/setup` reports the roles it created or adopted.
- `/link` in the test server returns a button.
- The audit channel gets an embed for the link.
- A manual sweep posts exactly **one** embed, not one per member. (Discord rate
  limits a channel at roughly 5 messages per 5 seconds; per-member posting
  would throttle and drop entries.)

---

## When it looks broken

**Every bot call returns 401.** The secret does not match, or is missing on the
app side. Step 4. Check the key is present in the player container's env by
name — `docker exec <container> printenv | cut -d= -f1 | grep DISCORD` — never
by value.

**The bot reports invalid JSON from the app.** It is being redirected to the
sign-in page. `fetch` follows redirects, so the bot never sees the 307 — it gets
the login HTML under a 200 and dies parsing it. `/api/discord/` must be in
`isPublicPath` (`apps/player/src/lib/public-paths.ts`); there is a test for it.

**The sweep succeeds and changes nothing.** Either the guild registry is empty
(step 3) or the bot's role is too low (step 2). The audit embed distinguishes
these: an empty registry reports zero members considered, a role-position
problem reports amber 403s.

**Staging serves old code after a green build.** Staging containers do not
auto-update: their image is recorded as a bare `sha256:` id rather than a repo
reference, so the update check errors and is skipped, forever and silently. Use
`replace_service` explicitly. Also check `list_routes` — a service can end up
with **two** backends (a label-discovered container and one from the onboarded
record) round-robining between old and new code, which makes every probe look
intermittent.
