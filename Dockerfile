# Keep every stage on the exact Node 24 LTS multi-architecture image.
FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS deps
ARG PNPM_VERSION="11.18.0"
WORKDIR /app
RUN apk add --no-cache libc6-compat \
    && corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS production-deps
ARG PNPM_VERSION="11.18.0"
WORKDIR /app
RUN apk add --no-cache libc6-compat \
    && corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY docker/proxy.ts ./src

ARG BASE_PATH

ENV BASE_PATH=$BASE_PATH
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/dummy"
ENV DISABLE_TELEMETRY=1
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build-docker

FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS runner
WORKDIR /app

ARG NODE_OPTIONS

ENV HOME=/tmp
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV NODE_OPTIONS=$NODE_OPTIONS
ENV NPM_CONFIG_CACHE=/tmp/npm
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/geo ./geo
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder \
    /app/scripts/change-password.js \
    /app/scripts/check-db.js \
    /app/scripts/check-env.js \
    /app/scripts/update-tracker.js \
    ./scripts/
COPY --from=builder /app/generated ./generated
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/package.json ./package.json
COPY --from=production-deps /app/node_modules ./node_modules

# The service runs without root and may only mutate the generated tracker and
# framework cache. Application code and dependencies remain root-owned.
RUN mkdir -p .next/cache /tmp/npm \
    && chown nextjs:nodejs public/script.js .next/cache /tmp/npm

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["npm", "run", "start-docker"]
