FROM node@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS node-toolchain

FROM postgres@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826

COPY --from=node-toolchain /usr/local/ /usr/local/

COPY build-toolchain/ /opt/analytics-builder-profile/build-toolchain/
COPY scripts/build-toolchain-state.mjs scripts/build-toolchain-cache.mjs /opt/analytics-builder-profile/scripts/
COPY deploy/mac-build/pnpm-toolchain/ /opt/analytics-builder-profile/deploy/mac-build/pnpm-toolchain/
COPY deploy/mac-build/verify-toolchain.mjs /opt/analytics-builder-profile/deploy/mac-build/verify-toolchain.mjs

RUN --mount=type=cache,id=anderson-analytics-arm64-toolchain-npm12,target=/root/.npm,sharing=locked \
    apt-get update \
    && apt-get install --no-install-recommends -y \
      ca-certificates=20250419~deb12u2 \
      git=1:2.39.5-0+deb12u3 \
      build-essential=12.9 \
      python3=3.11.2-1+b1 \
      bubblewrap=0.8.0-2+deb12u1 \
      libatomic1=12.2.0-14+deb12u1 \
    && rm -rf /var/lib/apt/lists/* \
    && test -s /etc/ssl/certs/ca-certificates.crt \
    && npm ci --prefix /opt/analytics-builder-profile/build-toolchain --workspaces=false --ignore-scripts --no-fund --no-audit \
    && rm -rf /usr/local/lib/node_modules/npm \
    && ln -sfn /opt/analytics-builder-profile/build-toolchain/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sfn /opt/analytics-builder-profile/build-toolchain/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm ci --prefix /opt/analytics-builder-profile/deploy/mac-build/pnpm-toolchain --workspaces=false --strict-allow-scripts --no-fund --no-audit \
    && ln -sfn /opt/analytics-builder-profile/deploy/mac-build/pnpm-toolchain/node_modules/pnpm/pnpm /usr/local/bin/pnpm \
    && ln -sfn /opt/analytics-builder-profile/deploy/mac-build/pnpm-toolchain/node_modules/pnpm/pnpx /usr/local/bin/pnpx \
    && test "$(node --version)" = 'v26.13.0' \
    && test "$(npm --version)" = '12.2.2' \
    && test "$(pnpm --version)" = '12.18.0' \
    && node /opt/analytics-builder-profile/deploy/mac-build/verify-toolchain.mjs \
    && /usr/lib/postgresql/17/bin/postgres --version | grep -q 'PostgreSQL) 17.' \
    && bwrap --version

RUN useradd --uid 501 --gid 20 --no-create-home --shell /bin/bash artifact-builder

ENV PG17_BINDIR=/usr/lib/postgresql/17/bin
