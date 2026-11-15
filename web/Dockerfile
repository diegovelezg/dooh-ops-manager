# web — Dockerfile prod (multi-stage, ligero).
#
# Reglas:
# - SIN toolchain (python3/make/g++): `npm ci --ignore-scripts`. El único
#   addon nativo (better-sqlite3) llega vía @google/adk→mikro-orm/sqlite y
#   este repo no usa SQLite (sesiones/DB = SurrealDB). Sin apt en build.
# - Runtime = standalone trazado + tsx. Sin node_modules prod completo.
# - `.next/cache` montado como cache BuildKit: Turbopack recompila incremental.
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false \
    NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# Solo tsx (+esbuild): lo único que el worker no-op necesita fuera del standalone.
FROM base AS tsx
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install --prefix /tsx --no-save --ignore-scripts "tsx@$(node -p "require('./package.json').dependencies.tsx")"

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=cache,target=/app/.next/cache npm run build

# Runtime: procps (Crawlee spawnea `ps`; sin él prospect muere con
# `spawn ps ENOENT`) + usuario no-root. Sin toolchain.
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Worker (issue #24): misma imagen, `tsx worker.ts` (hoy no-op: solo lib/log).
# Next/React/adk/crawlee/surrealdb ya vienen trazados en el standalone.
COPY --from=builder /app/tsconfig.json /app/worker.ts ./
COPY --from=builder /app/lib/log.ts ./lib/log.ts
COPY --from=tsx /tsx/node_modules ./node_modules
COPY --chown=nextjs:nodejs entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh \
  && mkdir -p /app/.data/crawlee && chown -R nextjs:nodejs /app/.data
USER nextjs
EXPOSE 3000
# PID1 real (node o tsx), recibe SIGTERM directo.
ENTRYPOINT ["/app/entrypoint.sh"]
