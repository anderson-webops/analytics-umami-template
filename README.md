# Analytics Umami Template

Customized Umami base for the self-hosted analytics sites under `analytics.*`.

## What This Repo Is For

- shared source of truth for the analytics forks in this workspace
- site-independent Umami customization and maintenance
- direct Node 24 production builds for systemd-managed analytics services

Production deployment intentionally does not use Docker, Compose, Podman, or a
container registry. PostgreSQL runs as an operating-system service or managed
database, while the application listens only on loopback behind Nginx.

## Important Customizations

- `team-owner` users see team-owned websites in both the personal Websites view and the team view
- standalone builds repair hashed Prisma and `pg` aliases before deploy so `/api/config` and `/api/auth/verify` stay resolvable at runtime
- standalone packaging removes accidentally traced `.env*` files and copies public/static runtime assets into the deployable tree
- explicit minimal `GET`/`HEAD /healthz` and `GET`/`HEAD /readyz` probes are available for monitoring; guarded `GET /_dbinfo` remains separate from monitoring
- production startup validates secrets, loopback binding, trusted proxy configuration, supported PostgreSQL, database migrations, active administrators, roles, ownership, memberships, shares, and relational integrity
- local hook and line-ending handling are normalized for repeatable commits

## Important Paths

- `src/` - Umami application source, including the production proxy middleware
- `scripts/repair-standalone.js` - fixes standalone runtime alias resolution after build
- `scripts/check-env.js` - rejects unsafe or ambiguous production configuration
- `scripts/check-db.js` - applies migrations and verifies security/data invariants
- `scripts/start-production.js` - checks configuration/database state and starts the loopback-only standalone server
- `scripts/change-password.js` - rotates a user's password without exposing it as a command-line argument
- `deploy/systemd/umami@.service` - hardened direct Node service template
- `deploy/nginx/analytics.locations.conf` - same-origin reverse-proxy example
- `env.sample` - production environment template
- `DEPLOYMENT.md` - non-container deployment and rollback procedure
- `HEALTHCHECKS.md` - monitor endpoints and expected status codes

## Common Commands

```bash
pnpm install --frozen-lockfile
cp env.sample .env
pnpm dev
pnpm build:production
pnpm start:production
```

## Production Deployment

Use PostgreSQL 15 or newer, Node 24.18.1, pnpm 11.18.0, the supplied systemd
unit, and Nginx. Each release is built from an exact commit in its own directory
and promoted by changing the `current` symlink. The service defaults to
`127.0.0.1:3000`; production validation rejects a public bind address.

See [DEPLOYMENT.md](DEPLOYMENT.md) for installation, migration, verification,
rollback, and IPv4/IPv6-preservation requirements.

## Operational Notes

- PostgreSQL 15 or newer is required. Redis and ClickHouse are optional, but readiness reports them when configured.
- Production requires `APP_SECRET`, `PUBLIC_URL`, and `CLIENT_IP_HEADER`. The configured IP header must be overwritten by a trusted edge or reverse proxy; arbitrary forwarding headers are not trusted.
- Known CDN location headers are used only when `TRUST_LOCATION_HEADERS=1`. Client-supplied IP, user-agent, browser, OS, and device fields are used only in the cloud collector architecture with `CLOUD_MODE=1`, `TRUST_CLIENT_INFO_PAYLOAD=1`, and a matching `CLIENT_INFO_TRUST_KEY` supplied through the `x-umami-client-info-key` request header.
- Public database, Redis, ClickHouse, and Kafka hosts must use encrypted connections. `LOG_QUERY`, `DEBUG`, `ENABLE_TEST_CONSOLE`, and `SKIP_DB_CHECK` are rejected in production.
- Set `TWO_FACTOR_ENCRYPTION_KEY` to a 64-character hexadecimal value to enable two-factor authentication. Generate one with `openssl rand -hex 32`. Two-factor authentication remains unavailable and cannot be required until this key is configured.
- Rotate the seeded administrator password before public promotion:

  ```bash
  read -s UMAMI_PASSWORD
  export UMAMI_PASSWORD
  UMAMI_USERNAME=admin pnpm change-password
  unset UMAMI_PASSWORD
  ```

- Fresh sites can be provisioned atomically after migration without placing the administrator password in process arguments:

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
- Fork repos should sync from this template first, then carry only site-specific branding and deployment differences.
