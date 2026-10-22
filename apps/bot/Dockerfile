# The Discord bot image. Build context is the REPO ROOT (the lockfile and the
# workspace manifests live there), so:
#   docker build -f apps/bot/Dockerfile --target runner-bot .
# CI does exactly that; images are built only in CI, never on a host.
#
# Its own file, like the data API's: the root Dockerfile's builder installs the
# whole workspace and runs the Next.js builds, and the bot needs neither. It is
# one tsc run over a package with no runtime dependencies.

# ---- Stage 1: install the bot's dev dependencies ----
FROM node:24.22.1-bookworm-slim AS deps-bot
WORKDIR /app

# npm ci validates the whole lockfile against every workspace manifest, so all
# of them are copied even though only the bot's tree is installed. Keep this
# list in step with the root Dockerfile's deps stage.
COPY package.json package-lock.json .npmrc ./
COPY apps/player/package.json apps/player/
COPY apps/admin/package.json apps/admin/
COPY apps/bot/package.json apps/bot/
COPY apps/data-api/package.json apps/data-api/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/

RUN npm ci --workspace=bot --ignore-scripts

# ---- Stage 2: compile ----
FROM deps-bot AS builder-bot
WORKDIR /app
COPY apps/bot/tsconfig.json apps/bot/
COPY apps/bot/src apps/bot/src
RUN npm run build --workspace=bot

# ---- Stage 3: runtime ----
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
COPY --from=builder-bot --chown=bot:bot /app/apps/bot/package.json ./package.json
COPY --from=builder-bot --chown=bot:bot /app/apps/bot/dist ./dist

USER bot
EXPOSE 3002
CMD ["node", "dist/index.js"]
