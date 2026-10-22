# SFU Badminton Club App

A members' web app for running a university badminton club. Members use it to
play on a live Elo ladder, check in to sessions and enter tournaments. The
club's executives run the club from a private admin console. It is installable
on a phone as a PWA, and a Discord bot connects it to the club's Discord server.

It was built for, and is run by, the SFU Badminton Club. The code is published
so other clubs can read it, learn from it or adapt it. The current release is the
`version` field in the root `package.json`, which the app also shows under
Settings, About.

New here and not an engineer? The plain-language overview is in
[docs/project/](docs/project/README.md).

---

## What it does

### For members (`apps/player`)

- **Elo ladder.** Separate singles and doubles ratings on a public
  leaderboard. Members challenge each other, play and report the result. The
  opponent confirms or disputes it, and confirmed results update ratings.
  Disputes and walkovers go to the execs.
- **Sessions and attendance.** Members browse upcoming club sessions and check
  in, including by scanning a QR code at the door. Session reminders arrive by
  email and web push.
- **Tournaments.** Registration, entry caps and entry fees, event-day check-in,
  and live draws. Formats are single elimination, round robin, and pools into a
  bracket. External (non-member) teams can be entered. Each tournament is the
  organiser's to configure: staged formats, courts, its own points table,
  registration and check-in windows, a waitlist, and category change requests
  that need an approver.
- **Club events.** Socials, workshops, clinics and the other events that are
  not tournaments, also posted to the Discord server's Events tab.
- **Seasons and fees.** Members see their membership standing and fee status
  for the current season, and their record from past seasons. Seasons roll
  over on their own. Members pay their membership fee and upload the receipt;
  the app reads the receipt with on-device OCR to tell an e-transfer from a
  recreation-centre purchase.
- **Stats and feed.** Rating history, win/loss record and streaks, a club feed,
  announcements and in-app notifications.
- **Account.** Sign-in by email code, password, Google or passkey. Members can
  subscribe to their own iCal feed, download everything the club holds about them, and
  delete their account themselves.
- **Onboarding and legal.** New sign-ups wait for exec approval. Members must
  accept the club's current waiver, privacy policy, terms of use and code of
  conduct before they can check in, challenge or register.
- **Guests.** A non-member can sign a guest waiver from a link, without an
  account.
- **Guided tour.** A first-run tour walks a new member through the app.
- **Public pages.** A landing page, the leaderboard and the exec roster are
  visible without an account.

### For executives (`apps/admin`)

A private console mounted under `/admin`. It covers members and accounts,
seasons and fees, club finances (other income, expenses and their receipts),
sessions and attendance, matches, challenges, disputes and walkovers, ratings,
the tournament desk (events, seeding, brackets, scheduling, results and court
check-in), announcements, the legal documents members accept, platform
settings, permissions and the audit log.

Access has four levels: none, executive, varsity trainer and admin. On top of
those, individual capabilities can be granted to or revoked from each officer.
Once an officer has enrolled a passkey, every console page requires it, after a
short grace period that lets a newly promoted officer in to enrol one. Officers
get their own guided tour of the console.

### On Discord (`apps/bot`)

A small dependency-free Node service. It provides slash commands for the
leaderboard, profiles, sessions, tournaments, the club's socials, feedback and
bug reports. It keeps
members' Discord roles in step with their club status once they link their
account, and posts announcements, session pings, tournament events and match
results from the app.

### Scheduled jobs

Reminders, digests, expiry sweeps and data-retention jobs run on a schedule.
Some are `pg_cron` jobs inside Postgres that call the admin app's
`/api/cron/*` routes or the bot's service routes. Others are Supabase edge
functions in `supabase/functions/`, called by an external scheduler. Both kinds
authenticate with a shared secret.

---

## Repository layout

An npm-workspaces and Turborepo monorepo:

```
apps/
  player/        Next.js 15 app: the members' app and the public pages
  admin/         Next.js 15 app: the exec console, served under /admin
  bot/           Discord bot: plain Node, no framework, no runtime dependencies
  data-api/      Read-only HTTP API for outside consumers, keyed per consumer
packages/
  shared/        Elo engine, database types, Zod validators, email and push
                 senders, and the club's rule modules
  ui/            Shared React component library (33 components)
  config/        Shared configuration (placeholder: nothing imports it yet)
supabase/
  migrations/    The database schema, RLS policies, functions and triggers
  functions/     Deno edge functions for the scheduled maintenance jobs
  tests/         Transactional SQL tests (BEGIN ... ROLLBACK)
  One Time Scripts/   One-off data repairs, kept as a record
scripts/         Maintainer tooling: the database type generator
docs/            Documentation (see below)
```

Each part has its own README with the details:

| Part | |
|------|--|
| [`apps/player`](apps/player/README.md) | the members' app |
| [`apps/admin`](apps/admin/README.md) | the exec console. Read its authorization section before touching a write path. |
| [`apps/bot`](apps/bot/README.md) | the Discord bot |
| [`apps/data-api`](apps/data-api/README.md) | the Data API; [`API.md`](apps/data-api/API.md) is its contract |
| [`packages/shared`](packages/shared/README.md) | Elo engine, DB types, validators, senders |
| [`packages/ui`](packages/ui/README.md) | the component library |
| [`packages/config`](packages/config/README.md) | shared config (currently unused) |
| [`supabase`](supabase/README.md) | schema, migrations, edge functions, SQL tests |
| [`supabase/One Time Scripts`](<supabase/One Time Scripts/README.md>) | one-off data repairs |
| [`scripts`](scripts/README.md) | maintainer tooling |
| [`docs`](docs/README.md) | all documentation, indexed |

## Tech stack

TypeScript, Next.js 15 (App Router), React 19, Tailwind CSS 3, Supabase
(Postgres, Auth, PostgREST, Realtime, Storage) with row-level security, `pg_cron`
and `pg_net` for scheduled work, Zod, SimpleWebAuthn for passkeys, Resend for
email, Web Push, Sentry and PostHog (both optional), Vitest and Turborepo.

More detail: [docs/project/06-tech-stack.md](docs/project/06-tech-stack.md).

> **React is pinned at the workspace root.** `packages/ui` declares react and
> react-dom as *peer* dependencies, and the root `package.json` `overrides`
> force a single copy. Two copies of React in one tree produce error #31 at
> runtime. Adding react to a package's `dependencies` brings that back.

## Running it locally

**Prerequisites:** Node 24 (`engines.node` is `>=24.0.0 <25`, and `.npmrc` sets
`engine-strict`, so `npm install` refuses any other major; `.nvmrc` pins 24),
and the npm that ships with it (`packageManager` declares npm 11).

### 1. A database

The apps need a Supabase instance: a Supabase Cloud project, or a local stack
run with the [Supabase CLI](https://supabase.com/docs/guides/local-development).
This repository does not ship a `supabase/config.toml`, so for a local stack run
`supabase init` and `supabase start` in an empty directory **outside** this
repository; `supabase start` prints the database URL and the API keys.

To build the schema, apply every file in this repository's
`supabase/migrations/` in filename order with `psql` against that database. Some files open their own `BEGIN`/`COMMIT` and
some do not; see [supabase/README.md](supabase/README.md) before applying them.
The migrations enable `pgcrypto`, `uuid-ossp`, `pg_cron` and `pg_net`, so the
instance must allow those extensions.

The generated database types in `packages/shared` are committed, so you only
need to regenerate them after changing the schema; see
[scripts/README.md](scripts/README.md). The root `npm run gen:types` script
reads a named profile from `scripts/gen-db-types.profiles.json`, which is not
in the repository: copy `scripts/gen-db-types.profiles.example.json` to it and
point it at your own database.

### 2. Install and configure

```sh
npm install

cp .env.example apps/player/.env.local
cp .env.example apps/admin/.env.local
```

Then edit both files:

- Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` from your Supabase instance.
- The URL, base-path and passkey values in the example are already set for
  local development: the player on `http://localhost:3000`, the console
  root-mounted on `http://localhost:3001`, passkeys scoped to `localhost`.
- Everything under "Optional" can stay empty. The apps still run, but the
  features that need those variables (email, push, Sentry, PostHog, passkeys,
  the Discord integration) do not work without them. The comments in
  `.env.example` say what each one does.

### 3. Run

```sh
npm run dev:player   # http://localhost:3000
npm run dev:admin    # http://localhost:3001 (console at /dashboard)
```

`npm run dev` starts every workspace that has a `dev` script, the bot
included. The bot is no use without a Discord application and its credentials;
see [apps/bot/README.md](apps/bot/README.md).

### 4. Test

```sh
npm run test         # every workspace's Vitest suite; needs no database
npm run type-check   # not implied by build or test
npm run lint
```

The transactional SQL tests in `supabase/tests/` run against a database with
`psql`; see [supabase/README.md](supabase/README.md).

## Common scripts

Run from the repository root:

| Command | Does |
|---------|------|
| `npm run dev` | Run every app (Turborepo) |
| `npm run dev:player` / `npm run dev:admin` | Run one app |
| `npm run build` | Build everything |
| `npm run lint` | Lint |
| `npm run type-check` | TypeScript check. Not implied by `build` or `test`, so run it before pushing. |
| `npm run test` | Run every workspace's Vitest suite |

## Documentation

| Area | Where |
|------|-------|
| **All documentation, indexed** | [docs/README.md](docs/README.md) |
| **Project overview** (non-technical) | [docs/project/](docs/project/README.md) |
| **Admin/exec user guide** | [docs/guides/admin-guide.md](docs/guides/admin-guide.md) |
| **Member FAQ** | [docs/guides/player-faq.md](docs/guides/player-faq.md) |
| **Design documents** | [docs/design/](docs/design/) |

## Container images

The root `Dockerfile` builds the player and admin images (targets
`runner-player` and `runner-admin`; pass `--build-arg BUILD_APP=player` or
`admin` to compile only that app); `apps/bot/Dockerfile` builds the bot and
`apps/data-api/Dockerfile` the Data API. The `NEXT_PUBLIC_*` values are build arguments, because
Next.js bakes them into the client bundle. This repository does not include
deployment configuration.
