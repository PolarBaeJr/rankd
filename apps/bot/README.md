# `bot` — the Discord bot

A small, dependency-free Node service that connects the club's Discord server to
the app: slash commands members can use without opening the site, role grants
that follow their account status, and announcements pushed out of the console.

It is **not** a Next.js app and has no UI. It is a plain `node:http` server plus
a WebSocket gateway connection, written against Discord's REST API directly.
`package.json` has no runtime dependencies at all, only TypeScript for the
build.

The original design is in
[`docs/design/discord-bot.md`](../../docs/design/discord-bot.md), kept as a
record of intent rather than a description of the code.

---

## Run it

```sh
npm run build -w bot      # tsc to dist/
npm run start -w bot      # node dist/index.js, listens on $PORT (default 3002)
npm run test -w bot       # vitest, 41 test files
npm run register -w bot   # push the slash-command definitions to Discord
```

`npm run dev -w bot` is just build-then-start; there is no watch mode.

### Environment

Names only. Values are secrets and never belong in the repo; `.env.example` at
the root documents each one.

| Variable | For |
|----------|-----|
| `DISCORD_BOT_TOKEN` | REST + gateway auth |
| `DISCORD_APPLICATION_ID` | command registration |
| `DISCORD_PUBLIC_KEY` | verifying inbound interaction signatures |
| `DISCORD_GUILDS` | which guilds the bot manages |
| `DISCORD_AUDIT_CHANNEL_ID` | where audit entries are posted |
| `DISCORD_DEV_GUILD_ID` | *optional*: register commands to one guild instantly |
| `REGISTER_COMMANDS_ON_BOOT` | *optional*: `true` lets this bot register its own commands at startup |
| `DISCORD_SERVICE_SECRET` | shared secret for the service endpoints below |
| `APP_API_URL` | where the bot calls the player app's `/api/discord/*` |
| `APP_PUBLIC_URL` | origin used in links the bot posts |
| `STORAGE_IMAGE_HOST` | *optional*: an extra host allowed for image attachments, when storage is not served from `APP_PUBLIC_URL`'s host |
| `PORT` | HTTP port (default 3002) |

> `APP_API_URL` should be the player app's **public origin**; the comment on it
> in `.env.example` explains why an internal name is fragile. Going the other
> way, the player app reaches the bot through its own `DISCORD_BOT_URL` and
> `DISCORD_SERVICE_SECRET`. If either is unset in the player app, linking appears
> to work and grants no roles, and the only place that is visible is the
> **player** log (`apps/player/src/app/link/[token]/actions.ts`).

## Layout

```
src/
  index.ts          HTTP server: the Discord interactions endpoint + service routes.
  verify.ts         Ed25519 signature check on inbound interactions.
  commands.ts       Slash-command definitions and dispatch.
  register.ts       One-shot script that PUTs those definitions to Discord.
  gateway.ts        WebSocket connection (presence, events).
  discord-api.ts    Thin REST client.
  roles.ts          Pure role-diff logic — no fetch, no token, no clock.
  setup.ts          Pure: decides what /setup adopts vs. creates.
  sync.ts           Applies a role diff to a guild; sweeps every guild.
  api.ts            Calls back into the player app's /api/discord/* surface.
  register-commands.ts  Optional compare-and-register at startup.
  scheduled-event-sync.ts  The Events tab loop shared by tournament-events and club-events.
  server-log.ts     The per-server log: who did what, deleted and edited messages.
  scam-guard.ts     Auto mod, tuned per server under /config.
  trap-notice.ts    The trap channel's pinned warning card and its count.
  moderation.ts     /softban: a ban that deletes recent messages, then an unban.
  purge-memory.ts   Who ran /purge where, so the server log can name them.
  ...               announcements, session-pings, session-board,
                    tournament-events, club-events, match-results, feedback,
                    handles, audit, config, settings, outbox, reconcile,
                    member-sync, server-roles, service-auth, socials, multipart.
  __tests__/        Vitest. The pure modules above are why this is testable.
```

## Commands

Members: `/leaderboard` `/profile` `/sessions` `/tournaments` `/schedule`
`/challenge` `/signup` `/receipt` `/bug` `/feedback` `/link` `/unlink`
`/discord` `/socials`

Officers, from the console's own permissions: `/session` `/event` `/tourney`
`/sessionpost` `/announce` `/say` `/forcelink` `/forceunlink` `/forceupdate`
`/rolepicker` `/guidepost`

In any server, by Discord permission: `/setup` `/config` (Manage Server), `/purge` (Manage Messages), `/softban` (Ban Members)

The definitions, including which are exec-only, are `COMMAND_DEFINITIONS` in
`src/commands.ts`.

## Service endpoints

All except `/health` require `Authorization` matching `DISCORD_SERVICE_SECRET`.

| Route | Driven by |
|-------|-----------|
| `GET /health` | health checks |
| `POST /sync` | nightly `pg_cron` — full role reconciliation sweep |
| `POST /sync-member` | the app, immediately on link/unlink |
| `POST /session-pings` | `pg_cron`, alongside the app's reminder job |
| `POST /tournament-events` | `pg_cron`, every 15 minutes: tournaments and club events |
| `POST /announcements` | `pg_cron` |
| `POST /match-results` | `pg_cron` |
| `POST /feedback` | `pg_cron` |

**Nothing here is on a `setInterval`, deliberately.** A timer inside the process
would become one sweep *per process*, all writing the same roles. One HTTP
request reaches exactly one process however many are running.

The bot does currently have to run as a **single instance**, for a different
reason: `/bug` with a screenshot is two interactions (the command opens a modal,
the submit arrives as a separate request), bridged by a nonce in an in-memory
`Map` in `src/commands.ts`. With more than one process the submit can land on
one that does not hold the picture, and the screenshot is dropped. Making that
bridge durable would lift the restriction; nothing else in the bot holds
cross-request state.

`/health` reports `ok: true` even when the gateway is disconnected: interactions
do not travel over the gateway, so a blip there must not mark a healthy
interactions endpoint as down. The gateway state is in the body instead.

## Things that will catch you

**Slash commands register globally and take up to an hour to appear.** That hour
is indistinguishable from a registration that failed, and it has cost this
project time twice. Set `DISCORD_DEV_GUILD_ID` and the same set registers to
that one guild *immediately* — a separate list from the global one, so a test
server shows both copies until the global set catches up.

**`autocomplete: true` is part of the stored definition.** Deploying the handler
alone changes nothing; Discord will not send an autocomplete interaction for an
option it hasn't been told is one. Re-run `register`.

**`REGISTER_COMMANDS_ON_BOOT=true` makes startup do that for you.** The bot
compares the registered set with `COMMAND_DEFINITIONS` on startup and PUTs only
when they differ. Off unless the
value is exactly `true`, because registration is *global*: two stacks sharing
one Discord application would take turns publishing each other's command set.
See `src/register-commands.ts` for the whole argument. It never fails a boot,
so the log is the only place it reports anything.

**The interaction signature covers the raw body.** Parse-and-re-serialise
reorders keys and drops whitespace, which invalidates every signature — and the
failure looks exactly like a wrong public key.

**`/setup` matches existing roles by name, and skips anything at or above the
bot's own position.** A role the bot can't reach is reported as `above_bot`;
drag the bot higher in the role list and re-run — adoption is idempotent. Role
permission masks arrive as *decimal strings* because they're 64 bits wide:
parse with `BigInt`, never `Number`.

**`/setup` is gated by Discord's `MANAGE_GUILD`, not by the club's own
`EXEC_ONLY` gate** — deliberately, because it *is* the bootstrap: it is what
creates the `@Executives` role the `EXEC_ONLY` commands are later granted to, so
gating it on that role would leave a fresh server with no way in. Discord
enforces `default_member_permissions` server-side, so the command isn't even
visible to anyone else, and it independently refuses to let a bot create or
assign a role above its own position.

**Nothing in `sync.ts` throws on a predictable failure.** A 403 modifying a
member whose top role outranks the bot is normal, not an incident; a sweep that
aborted on the first one would leave everyone after them unrepaired. Failures
are counted and reported, and the sweep continues.

**Never let a multi-call `catch` assert a cause.** A wrong Discord API path once
produced a 400 that the handler blamed on a missing Manage Roles permission the
bot already had.

**`@me` is not valid on `/guilds/{id}/members/{user_id}`** — it returns a 400
`NUMBER_TYPE_COERCE`.

**Repair a member with `POST /sync`, not by re-linking.**
