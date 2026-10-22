# The data API image. Build context is the REPO ROOT (the lockfile and the
# workspace manifests live there), so:
#   docker build -f apps/data-api/Dockerfile --target runner-data-api .
# CI does exactly that; images are built only in CI, never on a host.
#
# Its own file rather than a stage of the root Dockerfile because nothing here
# needs the Next.js builder: the root builder installs and builds every app,
# and this service is one tsc run over a package with no runtime dependencies.

# ---- Stage 1: install the workspace's dev dependencies ----
FROM node:24.22.1-bookworm-slim AS deps-data-api
WORKDIR /app

# npm ci validates the whole lockfile against every workspace manifest, so all
# of them are copied even though only data-api's tree is installed. Keep this
# list in step with the root Dockerfile's deps stage.
COPY package.json package-lock.json .npmrc ./
COPY apps/player/package.json apps/player/
COPY apps/admin/package.json apps/admin/
COPY apps/bot/package.json apps/bot/
COPY apps/data-api/package.json apps/data-api/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/

RUN npm ci --workspace=data-api --ignore-scripts

# ---- Stage 2: compile ----
FROM deps-data-api AS builder-data-api
WORKDIR /app
COPY apps/data-api/tsconfig.json apps/data-api/
COPY apps/data-api/src apps/data-api/src
RUN npm run build --workspace=data-api

# ---- Stage 3: runtime ----
# No node_modules is copied because the service has NO runtime dependencies:
# node:http, node:crypto and the global fetch. If one is ever added, this stage
# must start copying the production tree, and forgetting to is a crash on boot.
FROM node:24.22.1-bookworm-slim AS runner-data-api
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN addgroup --system --gid 1001 dataapi && \
    adduser --system --uid 1001 dataapi

# package.json carries "type": "module" and the version /health reports.
COPY --from=builder-data-api --chown=dataapi:dataapi /app/apps/data-api/package.json ./package.json
COPY --from=builder-data-api --chown=dataapi:dataapi /app/apps/data-api/dist ./dist

USER dataapi
EXPOSE 8080
# The slim image has no curl or wget; node's global fetch does the probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
