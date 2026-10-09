# syntax=docker/dockerfile:1.7
# Web image: Next.js standalone server. Build from the repository root:
#   docker build -f docker/web.Dockerfile -t cds-web .
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

FROM deps AS build
COPY . .
RUN pnpm --filter @cds/web build

FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 1001 cds
COPY --from=build --chown=cds /app/apps/web/.next/standalone ./
COPY --from=build --chown=cds /app/apps/web/.next/static ./apps/web/.next/static
USER cds
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
