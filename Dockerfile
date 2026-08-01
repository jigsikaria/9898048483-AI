# syntax=docker/dockerfile:1
# Multi-stage build for the AdapterOS Universal AI Gateway.
# Slim runtime (~90MB): production dependencies + Bun. Bun executes TS directly,
# so the compiled dist is only needed for type validation and Node runtimes.

FROM oven/bun:1 AS base
WORKDIR /app

# Stage 1: install all deps (for typecheck + emit)
FROM base AS deps
COPY package.json package-lock.json* ./
RUN bun install --frozen-lockfile

# Stage 2: validate types and emit dist (used only as a build gate)
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run typecheck && bun run build

# Stage 3: production runtime (dev deps stripped)
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN bun install --frozen-lockfile --production && bun pm cache rm

COPY src ./src

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

USER bun
ENTRYPOINT ["bun", "run", "src/index.ts"]
