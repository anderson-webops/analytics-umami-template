FROM node@sha256:9b02ede55039f443ad57453a741813c6cd105873f0f66fee95d25529e1ba0533 AS node-toolchain

FROM postgres@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826

COPY --from=node-toolchain /usr/local/ /usr/local/

RUN --mount=type=cache,id=anderson-analytics-arm64-toolchain-npm12,target=/root/.npm,sharing=locked \
    apt-get update \
    && apt-get install --no-install-recommends -y \
      git=1:2.39.5-0+deb12u3 \
      build-essential=12.9 \
      python3=3.11.2-1+b1 \
      bubblewrap=0.8.0-2+deb12u1 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts npm@12.0.2 pnpm@11.18.0 \
    && test "$(node --version)" = 'v24.18.1' \
    && test "$(npm --version)" = '12.0.2' \
    && test "$(pnpm --version)" = '11.18.0' \
    && /usr/lib/postgresql/17/bin/postgres --version | grep -q 'PostgreSQL) 17.' \
    && bwrap --version

RUN useradd --uid 501 --gid 20 --no-create-home --shell /bin/bash artifact-builder

ENV PG17_BINDIR=/usr/lib/postgresql/17/bin
