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
- standalone packaging removes accidentally traced `.env*` files, copies public/static runtime assets, bundles startup validation without development dependencies, and hashes the exact deployable tree
- explicit minimal `GET`/`HEAD /healthz` and `GET`/`HEAD /readyz` probes are available for monitoring; guarded `GET /_dbinfo` remains separate from monitoring
- pre-promotion validation checks secrets, supported PostgreSQL, migrations, password hashes, roles, ownership, memberships, shares, and relational integrity; runtime startup repeats only bounded migration, schema, administrator, role, and team-owner checks
- Umami 3.4 API keys, generated API contracts, annotations, saved analytics definitions, and the optional MCP endpoint are integrated while preserving the fork's stricter session and authorization controls
- local hook and line-ending handling are normalized for repeatable commits

## Important Paths

- `src/` - Umami application source, including the production proxy middleware
- `scripts/repair-standalone.js` - fixes standalone runtime alias resolution after build
- `scripts/check-env.js` - rejects unsafe or ambiguous production configuration
- `scripts/check-db.js` - applies migrations and performs the full pre-promotion security/data audit; `--verify-only` performs bounded runtime checks
- `scripts/start-production.js` - checks configuration/database state and starts the loopback-only standalone server
- `scripts/runtime-artifact.mjs` - creates and verifies the independent hashed runtime manifest and staged copies
- `deploy/runtime-artifact.json` - reviewed entrypoint, dependency, native binding, asset, and writable-state contract
- `scripts/change-password.js` - rotates a user's password without exposing it as a command-line argument
- `deploy/systemd/umami@.service` - hardened direct Node service template
- `deploy/nginx/analytics.locations.conf` - same-origin reverse-proxy example
- `env.development.sample` - local development environment template with no pinned public origin
- `env.sample` - production environment template
- `DEPLOYMENT.md` - non-container deployment and rollback procedure
- `HEALTHCHECKS.md` - monitor endpoints and expected status codes

## Common Commands

```bash
pnpm install --frozen-lockfile
cp env.development.sample .env
pnpm dev
pnpm build:production
pnpm runtime:verify
pnpm test:runtime-artifact
pnpm start:production
```

## Production Deployment

Use PostgreSQL 15 or newer, Node 24.18.1, pnpm 11.18.0, the supplied systemd
unit, and Nginx. Each release is built from an exact commit in its own directory
and promoted by changing the `current` symlink. Both source and packaged
production launchers and the legacy `start` aliases use the same guarded path,
which sets production mode before configuration and database checks even when
the calling shell does not. The service defaults to
`127.0.0.1:3000`; production validation rejects a public bind address.

See [DEPLOYMENT.md](DEPLOYMENT.md) for installation, migration, verification,
rollback, and IPv4/IPv6-preservation requirements.
The exact artifact and clean-runtime acceptance rules are documented in
[docs/runtime-artifact-contract.md](docs/runtime-artifact-contract.md).

## Operational Notes

- PostgreSQL 15 or newer is required. Redis and ClickHouse are optional, but readiness reports them when configured.
- Public-share analytics requests have bounded date/filter complexity and a per-share, 60-second query budget. Overly complex requests return 400, exhausted budgets return 429, and a configured but unavailable Redis budget store returns 503. Read-only PostgreSQL and ClickHouse queries also have execution and resource limits, including both phases of paged reports.
- Production requires `APP_SECRET`, `PUBLIC_URL`, and `CLIENT_IP_HEADER`. The configured IP header must be overwritten by a trusted edge or reverse proxy; arbitrary forwarding headers are not trusted.
- Known CDN location headers are used only when `TRUST_LOCATION_HEADERS=1`. Client-supplied IP, user-agent, browser, OS, and device fields are used only in the cloud collector architecture with `CLOUD_MODE=1`, `TRUST_CLIENT_INFO_PAYLOAD=1`, and a matching `CLIENT_INFO_TRUST_KEY` supplied through the `x-umami-client-info-key` request header.
- Public database, Redis, ClickHouse, and Kafka hosts must use encrypted connections. `LOG_QUERY`, `DEBUG`, `ENABLE_TEST_CONSOLE`, and `SKIP_DB_CHECK` are rejected in production.
- Set `TWO_FACTOR_ENCRYPTION_KEY` to a 64-character hexadecimal value to enable two-factor authentication. Generate one with `openssl rand -hex 32`. Two-factor authentication remains unavailable and cannot be required until this key is configured.
- When 2FA is required for an unenrolled user, a fresh password login grants only a 15-minute setup session. It exposes no team memberships. Existing sessions cannot enroll a factor after the requirement changes. Confirming setup issues a new verified session; older unverified or prior-enrollment sessions stop working once 2FA is enabled. Concurrent or stale setup attempts cannot reset an enabled factor. API keys remain unavailable for users who have not enrolled in required 2FA.
- Disabling an optional factor or resetting one as an administrator rotates the user's session generation in the same database transaction as factor removal. Earlier browser, bearer, Redis-backed, and password-only sessions then fail authentication, including sessions issued before factor enrollment. Self-service disable returns a replacement session; if session storage is unavailable afterward, sign in again. An administrator's reset requires the user to sign in again. This additive migration requires database-aware, pre-traffic recovery with all writers quiesced; do not activate alongside an old runtime that does not enforce session generations or roll back to it after public writes resume.
- Cloud mode uses its configured SSO flow; the local password-login API is unavailable there.
- Set `DISABLE_LOGIN=1` to stop new self-hosted password logins, including direct API requests and completion of pending password-login 2FA or enrollment challenges. This does not revoke existing sessions, block 2FA enrollment by an already authenticated full session, or disable cloud SSO. Use session revocation separately when existing access must end.
- Password changes and optional 2FA disable share an atomic PostgreSQL-backed limit of five password checks per account per 15 minutes. The budget uses the existing settings table, so it adds no migration to a retained runtime's ledger; credential checks stop safely if the budget is unavailable. Administrators must use the current-password flow for their own account; the operator password-rotation command remains available for recovery.
- MCP remains disabled by default. Set `MCP_ENABLED=1` only for an intentional deployment, then authenticate it with a user-bound API key created under Settings. MCP tools are read-only and retain that user's website/team permissions; enabling MCP does not weaken the normal browser-session boundary.
- API keys can read authorized team and analytics data, but cannot manage team membership, ownership, website transfers, or public shares. Team invitation codes and existing public-share slugs are not returned to API keys; website `shareId` appears as `null` for those callers. Rotate any invitation code disclosed to an API key before this restriction is deployed.
- The legacy website `shareId` update rotates a sole active website share in one transaction, preserving its name and section restrictions while revoking the previous slug and tokens. A website with multiple active shares rejects this singular operation; manage those links through the explicit shares list and per-share API instead. Setting `shareId` to `null` revokes all website shares. A `null` readback may mean no share or multiple shares, so consult the explicit shares list when managing links.
- Relational session deletion locks the actor, website, and applicable team authorization rows, then rechecks website-delete permission in the same serializable transaction as the deletion. Revocation that wins the lock first denies the stale request; deletion that wins first completes before the revocation.
- The direct production runtime refuses to start while the seeded administrator
  still has the known password, including after that password is rehashed.
  Rotate it before public promotion:

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
  `--update-admin-password` only for an intentional rotation of a non-default password.
  Provisioning always replaces the known seeded password when `UMAMI_ADMIN_PASSWORD`
  is supplied, and refuses to reuse it without a replacement.
- Fork repos should sync from this template first, then carry only site-specific branding and deployment differences.
