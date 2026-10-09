# syntax=docker/dockerfile:1.7
# Worker image: outbox processor and scheduled jobs. Build from the repository root:
#   docker build -f docker/worker.Dockerfile -t cds-worker .
# Node 24 LTS; pin the exact patch release when promoting (docs/dependencies.md).

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
# Optional build secret "npm_ca": an extra CA bundle for TLS-intercepting proxies. Absent = ignored.
RUN --mount=type=secret,id=npm_ca,required=false --mount=type=cache,id=pnpm,target=/pnpm/store \
    sh -c 'if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; corepack enable && pnpm install --frozen-lockfile'

FROM deps AS worker
ENV NODE_ENV=production
COPY . .
RUN useradd --system --uid 1001 cds
USER cds
CMD ["apps/worker/node_modules/.bin/tsx", "apps/worker/src/index.ts"]
