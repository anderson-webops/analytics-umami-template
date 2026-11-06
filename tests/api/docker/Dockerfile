FROM node@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9

LABEL org.anderson.webops.purpose="disposable-api-tests"
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node build-toolchain/ build-toolchain/
COPY --chown=node:node scripts/build-toolchain-state.mjs scripts/build-toolchain-cache.mjs scripts/
COPY --chown=node:node deploy/mac-build/pnpm-toolchain/ deploy/mac-build/pnpm-toolchain/
COPY --chown=node:node deploy/mac-build/verify-toolchain.mjs deploy/mac-build/verify-toolchain.mjs

RUN npm ci --prefix /app/build-toolchain --workspaces=false --ignore-scripts --no-fund --no-audit \
    && rm -rf /usr/local/lib/node_modules/npm \
    && ln -sfn /app/build-toolchain/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sfn /app/build-toolchain/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm ci --prefix /app/deploy/mac-build/pnpm-toolchain --workspaces=false --strict-allow-scripts --no-fund --no-audit \
    && ln -sfn /app/deploy/mac-build/pnpm-toolchain/node_modules/pnpm/pnpm /usr/local/bin/pnpm \
    && ln -sfn /app/deploy/mac-build/pnpm-toolchain/node_modules/pnpm/pnpx /usr/local/bin/pnpx \
    && node /app/deploy/mac-build/verify-toolchain.mjs \
    && chown -R node:node /app

USER node
ENV NPM_CONFIG_CACHE=/home/node/.npm \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=2304

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages/ packages/
COPY --chown=node:node vendor/ vendor/
RUN pnpm install --frozen-lockfile --config.store-dir=/home/node/pnpm-store --config.package-import-method=hardlink

COPY --chown=node:node . .
RUN pnpm run audit:all \
    && pnpm run audit:prod \
    && export DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/dummy \
    && pnpm run build:db \
    && pnpm run build:packages \
    && pnpm run build:tracker \
    && pnpm run build:recorder \
    && SKIP_BUILD_GEO=1 pnpm run build:geo \
    && pnpm run build:openapi \
    && pnpm run build:app \
    && node --input-type=module -e 'import fs from "node:fs/promises"; import path from "node:path"; import { repairStandaloneRuntime } from "./scripts/repair-standalone.js"; const { appDir } = await repairStandaloneRuntime(); if (!appDir) throw new Error("Compiled API fixture is missing."); for (const relative of ["public", ".next/static"]) await fs.cp(relative, path.join(appDir, relative), { recursive: true });'

ENV NODE_OPTIONS=--max-old-space-size=4096
CMD ["node", "tests/api/docker/start.mjs"]
