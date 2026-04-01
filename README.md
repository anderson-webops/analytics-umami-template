# Analytics Umami Template

Customized Umami base for the self-hosted analytics sites under `analytics.*`.

## What This Repo Is For

- shared source of truth for the analytics forks in this workspace
- site-independent Umami customization and maintenance
- Docker/standalone build source used by the deployed analytics services

## Important Customizations

- `team-owner` users see team-owned websites in both the personal Websites view and the team view
- standalone builds repair hashed Prisma and `pg` aliases before deploy so `/api/config` and `/api/auth/verify` stay resolvable at runtime
- explicit `GET /healthz`, `GET /readyz`, and guarded `GET /_dbinfo` endpoints are available for monitoring
- local hook and line-ending handling are normalized for repeatable commits

## Important Paths

- `src/` - Umami application source
- `scripts/repair-standalone.js` - fixes standalone runtime alias resolution after build
- `scripts/postbuild.js` - postbuild entry point used by the app and Docker build
- `public/` - shared static assets; fork repos replace branding here
- `env.sample` - local environment template
- `HEALTHCHECKS.md` - monitor endpoints and expected status codes

## Common Commands

```bash
pnpm install --frozen-lockfile
cp env.sample .env
pnpm dev
pnpm build
pnpm build-docker
pnpm start
```

## Operational Notes

- PostgreSQL is the primary required dependency. Redis and ClickHouse are optional, but readiness will report them when configured.
- Use `pnpm build-docker` when validating the deploy artifact path. The Dockerfile relies on the standalone repair step.
- Fork repos should sync from this template first, then carry only site-specific branding and deployment differences.
