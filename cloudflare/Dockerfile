# syntax=docker/dockerfile:1
# Build from the repository root, for linux/amd64.
# Mirrors frontend/Dockerfile's dependency and sibling-package layout.
FROM node:22-slim AS frontend
WORKDIR /web/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY packages/contracts /web/packages/contracts
COPY packages/ui /web/packages/ui
COPY packages/client /web/packages/client
ENV SENTRY_DISABLED=true NEXT_PUBLIC_SENTRY_DISABLED=true NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Mirrors backend/Dockerfile, including native document tools and migration CLI.
FROM node:22-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice util-linux postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package*.json backend/.npmrc ./
RUN npm ci
COPY backend/ ./
COPY packages/contracts /packages/contracts
COPY docker/db-init/adopt-ledger.sh ./docker/db-init/adopt-ledger.sh
RUN npm run build
COPY --from=frontend /web /web
COPY cloudflare/start.mjs cloudflare/runtime.mjs /opt/mikegc/
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps SENTRY_DISABLED=true
EXPOSE 3000
CMD ["node", "/opt/mikegc/start.mjs"]
