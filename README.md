# Analytics Umami Template

Customized Umami base for the self-hosted analytics sites under `analytics.*`.

## What This Repo Is For

- shared source of truth for the analytics forks in this workspace
- site-independent Umami customization and maintenance
- Docker/standalone build source used by the deployed analytics services

## Important Customizations

- `team-owner` users see team-owned websites in both the personal Websites view and the team view
- standalone builds repair hashed Prisma and `pg` aliases before deploy so `/api/config` and `/api/auth/verify` stay resolvable at runtime
- standalone packaging removes any accidentally traced `.env*` files before an artifact is shipped
- explicit `GET /healthz`, `GET /readyz`, and guarded `GET /_dbinfo` endpoints are available for monitoring
- production startup validates secrets, trusted proxy configuration, supported PostgreSQL, database migrations, active administrators, roles, ownership, memberships, shares, and relational integrity
- local hook and line-ending handling are normalized for repeatable commits

## Important Paths

- `src/` - Umami application source
- `scripts/repair-standalone.js` - fixes standalone runtime alias resolution after build
- `scripts/check-env.js` - rejects unsafe or ambiguous production configuration
- `scripts/check-db.js` - applies migrations and verifies security/data invariants
- `scripts/change-password.js` - rotates a user's password without exposing it as a command-line argument
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

## Container Deployment

The Compose stack builds the checked-out hardened source instead of pulling a
mutable upstream application tag. It binds Umami to loopback, pins PostgreSQL
by digest, and keeps the database on an internal network.

```bash
install -m 0600 env.sample .env
# Fill in every required value in .env.
docker compose config
docker compose build --pull
docker compose up -d
```

Do not publish the resolved `docker compose config` output because it contains
environment values. Put a trusted TLS reverse proxy in front of
`127.0.0.1:3000`; `UMAMI_PORT` can select another loopback port. See
`podman/README.md` for the rootless Podman equivalent.

## Operational Notes

- PostgreSQL 15 or newer is required. Redis and ClickHouse are optional, but readiness will report them when configured.
- Production requires `APP_SECRET`, `PUBLIC_URL`, and `CLIENT_IP_HEADER`. The configured IP header must be overwritten by a trusted edge or reverse proxy; arbitrary forwarding headers are not trusted in production.
- Known CDN location headers are used only when `TRUST_LOCATION_HEADERS=1`. Client-supplied IP, user-agent, browser, OS, and device fields are used only in the cloud collector architecture with `CLOUD_MODE=1`, `TRUST_CLIENT_INFO_PAYLOAD=1`, and a matching `CLIENT_INFO_TRUST_KEY` supplied through the `x-umami-client-info-key` request header.
- Public database, Redis, ClickHouse, and Kafka hosts must use encrypted connections. `LOG_QUERY`, `DEBUG`, `ENABLE_TEST_CONSOLE`, and `SKIP_DB_CHECK` are rejected in production.
- After the initial migration, rotate the seeded password before starting the service:

  ```bash
  read -s UMAMI_PASSWORD
  export UMAMI_PASSWORD
  UMAMI_USERNAME=admin pnpm change-password
  unset UMAMI_PASSWORD
  ```

  Supply the password through a protected environment or secret manager and remove it from the environment immediately afterward.
- Fresh sites can be provisioned atomically after migration without placing the
  administrator password in process arguments:

  ```bash
  read -s UMAMI_ADMIN_PASSWORD
  export UMAMI_ADMIN_PASSWORD
  export UMAMI_WEBSITE_NAME="Example Analytics"
  export UMAMI_WEBSITE_DOMAIN="analytics.example.com"
  pnpm exec tsx scripts/provision-site.ts
  unset UMAMI_ADMIN_PASSWORD
  ```

  Existing non-admin users are never promoted implicitly. Use
  `--promote-existing-admin` only after verifying the intended account, and use
  `--update-admin-password` only for an intentional rotation.
- Use `pnpm build-docker` when validating the deploy artifact path. The Dockerfile relies on the standalone repair step.
- Fork repos should sync from this template first, then carry only site-specific branding and deployment differences.
