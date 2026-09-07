# Waresport Sales Hub — production image.
#
# Multi-stage so the runtime carries the built app and nothing else: no source,
# no dev dependencies, no package manager. Runs as an unprivileged user on a
# read-only-friendly layout, which is what most container platforms expect.

# ---------------------------------------------------------------------------
# 1. Dependencies (cached on package-lock.json alone)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build must not touch a database or read real secrets. These placeholders
# satisfy env validation during `next build` and never reach the image: the
# runtime reads the real values from the platform's environment.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN DATABASE_URL="postgres://build:build@127.0.0.1:5432/build" \
    APP_DATABASE_URL="postgres://build_app:build@127.0.0.1:5432/build" \
    AUTH_SECRET="build-time-placeholder-not-used-at-runtime-000" \
    APP_URL="https://build.invalid" \
    npm run build

# ---------------------------------------------------------------------------
# 3. Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Uploaded resource documents live outside the web root and are only served
# through an authorization-checked route. Mount a volume here to keep them
# across deploys; without one they are ephemeral, like any container filesystem.
ENV STORAGE_DIR=/data/storage

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs \
 && mkdir -p /data/storage \
 && chown -R nextjs:nodejs /data

# `output: 'standalone'` emits a server bundle with only the modules it uses.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Migrations run as a release step (`node scripts/migrate.mjs`), not at boot:
# two instances starting at once must not race each other through the schema.
# The runner is plain ESM and uses `postgres`, which the standalone bundle
# already carries, so the image needs no TypeScript loader and no dev deps.
COPY --from=builder --chown=nextjs:nodejs /app/db ./db
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.mjs ./scripts/migrate.mjs

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
