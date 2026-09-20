# The Next.js front end.
#
# Build context is the REPOSITORY ROOT for the same reason as the API image:
# workspace hoisting and the shared package.
#
# NEXT_PUBLIC_API_URL is a BUILD argument, not just a runtime variable. Next
# inlines NEXT_PUBLIC_* into the client bundle at build time, so setting it only
# in the compose environment leaves the browser calling whatever was baked in.

FROM node:20-slim AS build

WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# @scholarshield/shared has no build step: it is consumed as TypeScript
# source, which Next compiles along with the app.
RUN npm run build --workspace apps/web

FROM node:20-slim AS runtime

ENV NODE_ENV=production
WORKDIR /repo

# The standalone output already contains the server and exactly the modules it
# traced, so there is no npm install in this stage at all.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# No public/ directory in this app; add a COPY for it here if one is ever added.

RUN useradd --system --uid 10003 web && chown -R web:web /repo
USER web

ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
