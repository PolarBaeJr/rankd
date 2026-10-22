# syntax=docker/dockerfile:1
# ---- Stage 1: Install dependencies ----
FROM node:24.22.1-bookworm-slim AS deps
WORKDIR /app

# .npmrc carries engine-strict=true, so this `npm ci` fails loudly if the base
# image above ever drifts from the `engines.node` range rather than building an
# image against a Node the app was never type-checked on.
COPY package.json package-lock.json turbo.json tsconfig.base.json .npmrc ./
COPY apps/player/package.json apps/player/
COPY apps/admin/package.json apps/admin/
COPY apps/bot/package.json apps/bot/
# Not built here (it has its own apps/data-api/Dockerfile), but npm ci checks
# every workspace in the lockfile against its manifest.
COPY apps/data-api/package.json apps/data-api/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/

RUN npm ci

# ---- Stage 2: Build both apps ----
FROM deps AS builder
WORKDIR /app

COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_PLAYER_URL
# The console's public base URL, path prefix included:
# https://example.com/admin. Self-referential redirects are built from it,
# and its ORIGIN (path dropped) is what the WebAuthn check compares against.
ARG NEXT_PUBLIC_ADMIN_URL
# Where the admin console is mounted — "/admin". Next bakes basePath into the
# build, so this cannot be a runtime setting; see apps/admin/next.config.js.
# Empty builds a root-mounted console (localhost, or a fallback subdomain).
# Consumed by the admin image only; harmless on the player build.
ARG NEXT_PUBLIC_BASE_PATH
# Passkey scope — see apps/admin/src/lib/passkey/config.ts. Must be the parent
# domain so one credential covers the apex and any subdomain, and survives the
# console moving between them.
ARG NEXT_PUBLIC_PASSKEY_RP_ID
# Auth cookie scope — see AUTH_COOKIE_DOMAIN in packages/shared. Set to
# ".example.com" so one sign-in covers the player app and the admin
# console; leave EMPTY for a host-only cookie (the original behaviour, and the
# right answer on localhost). Build-time only: the browser writes this cookie
# too, so the value must be inlined into the client bundle — putting it in the
# runtime .env alone has no effect.
ARG NEXT_PUBLIC_AUTH_COOKIE_DOMAIN
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
# Build-only: let @sentry/nextjs upload source maps for readable stack traces.
# withSentryConfig reads SENTRY_ORG/SENTRY_PROJECT (next.config.js) and picks up
# SENTRY_AUTH_TOKEN from the env. Empty => upload is skipped, build still passes.
# These live only in this (unpublished) builder stage, not the runner images.
ARG SENTRY_ORG
ARG SENTRY_PROJECT

# The token is a BuildKit secret, not an ARG: an ARG value is recorded in the
# builder's history and in the build cache, a secret mount is neither. It is
# exposed as an env var for this one RUN only. Absent (the staging build passes
# none) leaves it unset, which skips the upload exactly as an empty ARG did.
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    npx turbo run build --filter=player --filter=admin --filter=bot --concurrency=1

# ---- Stage 3: Player runner ----
FROM node:24.22.1-bookworm-slim AS runner-player
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nextjs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nextjs /app/apps/player/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/player/.next/static ./apps/player/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/player/public ./apps/player/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/player/server.js"]

# ---- Stage 4: Admin runner ----
FROM node:24.22.1-bookworm-slim AS runner-admin
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nextjs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nextjs /app/apps/admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/admin/.next/static ./apps/admin/.next/static
# public/ is NOT part of Next's standalone output — it has to be copied by hand,
# exactly as the player runner above does. Without this line the console's four
# public files (manifest.json and the three icons) 404 in every container build,
# which is invisible in dev because `next dev` serves public/ straight off disk.
# The console is built with basePath=/admin, so Next serves these at
# /admin/manifest.json etc.; the destination path stays basePath-free because it
# is a filesystem location, resolved relative to apps/admin/server.js.
COPY --from=builder --chown=nextjs:nextjs /app/apps/admin/public ./apps/admin/public

USER nextjs
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]

# ---- Stage 5: Discord bot runner ----
# An HTTP interactions endpoint, not a gateway bot: Discord POSTs signed requests
# here, so the process is stateless and replicas are safe. A gateway bot holds a
# WebSocket and would need sharding before a second replica could exist at all.
#
# No node_modules is copied because the bot has NO runtime dependencies - it is
# node:http plus node:crypto. If a dependency is ever added, this stage must start
# copying the production tree, and forgetting to is a crash on boot rather than a
# silent failure, which is the failure mode to prefer.
FROM node:24.22.1-bookworm-slim AS runner-bot
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002

RUN addgroup --system --gid 1001 bot && \
    adduser --system --uid 1001 bot

# dist is ESM. Node's syntax detection would infer that on its own, but it is a
# heuristic; carrying the package.json states "type": "module" outright so the
# module system does not depend on how the emitted code happens to look.
COPY --from=builder --chown=bot:bot /app/apps/bot/package.json ./package.json
COPY --from=builder --chown=bot:bot /app/apps/bot/dist ./dist

USER bot
EXPOSE 3002
CMD ["node", "dist/index.js"]
