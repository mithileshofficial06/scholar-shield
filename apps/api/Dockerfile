# The Express API and the pipeline worker.
#
# One image, two commands: `node dist/server.js` serves HTTP and
# `node dist/pipeline/main.js` drains the queue. They share every line of the
# rule engine, so building them separately would mean two images that must not
# drift and no mechanism preventing it.
#
# The build context is the REPOSITORY ROOT, not apps/api. This is an npm
# workspace whose dependencies hoist to the root node_modules and which imports
# @scholarshield/shared from a sibling directory; a context of apps/api cannot
# see either.

# ---------------------------------------------------------------- build stage
FROM node:20-slim AS build

WORKDIR /repo

# Manifests first, so a change to source code does not invalidate the npm
# install layer. `npm ci` needs every workspace's package.json to resolve the
# lockfile, which is why these are copied individually.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# The web workspace is not built here, but npm ci installs the whole tree; its
# dependencies are dropped again by the runtime stage below.
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

# @scholarshield/shared has no build: it is consumed as TypeScript source and
# every import of it from apps/api is `import type`, so it compiles away to
# nothing. There is no shared dist to copy into the runtime stage, and no
# runtime dependency on the package at all.
RUN npm run build --workspace apps/api

# -------------------------------------------------------------- runtime stage
FROM node:20-slim AS runtime

ENV NODE_ENV=production

WORKDIR /repo

COPY package.json package-lock.json ./
# The workspace link for @scholarshield/shared must resolve for `npm ci`,
# even though nothing imports it at runtime.
COPY packages/shared packages/shared
COPY apps/api/package.json apps/api/

# Production dependencies only: tsx, vitest and the type packages have no
# business in a running container.
RUN npm ci --omit=dev --workspace apps/api --include-workspace-root \
 && npm cache clean --force

COPY --from=build /repo/apps/api/dist apps/api/dist

# Migrations are copied because the api container is what applies them on
# deploy; scripts/ is not, because seeding and metrics are developer tools and
# a production image should not carry a script that truncates anything.
COPY db/migrations db/migrations

# The rule configs are data the engine reads at runtime, not code it compiles:
# household/config.ts resolves them relative to the repo root and every
# risk_flags row is stamped with the version it was scored under. EVERY version
# ships, not just the active one, because a historical score is only
# reproducible against the file that produced it -- which is the whole point of
# never editing a published config in place.
COPY config config

RUN useradd --system --uid 10002 api && chown -R api:api /repo
USER api

ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
