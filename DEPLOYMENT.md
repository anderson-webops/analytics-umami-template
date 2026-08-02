# Direct Production Deployment

This repository deploys directly on Linux with Node, systemd, Nginx, and
PostgreSQL. Production containers and container registries are not part of the
supported topology.

## Host prerequisites

- Node 24.18.1 and pnpm 11.18.0
- PostgreSQL 15 or newer, installed as an operating-system service or provided
  by a managed private database
- Nginx terminating HTTPS for both existing IPv4 and IPv6 listeners
- a locked service account named `umami` with no interactive shell
- release directories under `/srv/umami/<instance>/releases/`
- a root-owned environment file at `/etc/umami/<instance>.env`, mode `0600`

Do not remove or disable any existing A or AAAA record when deploying or
troubleshooting. The application remains loopback-only; Nginx continues to
serve both address families.

## Build and promote an exact release

1. Create a new release directory named with the full 40-character commit and
   check out that exact commit there.
2. Verify Node and pnpm match `package.json`, then run
   `pnpm install --frozen-lockfile`.
3. Load the protected instance environment and run `pnpm run audit:all`,
   `pnpm run audit:prod`, `pnpm run validate`, and
   `pnpm run build:production`.
4. With `NODE_ENV=production`, run `node scripts/check-env.js` and
   `node scripts/check-db.js`. This applies pending migrations and fails closed
   on invalid role, ownership, share, or relational state.
5. Point `/srv/umami/<instance>/current` at the new release atomically.
6. Install `deploy/systemd/umami@.service` as
   `/etc/systemd/system/umami@.service`, reload systemd, and restart
   `umami@<instance>.service`.
7. Include `deploy/nginx/analytics.locations.conf` in the HTTPS server block,
   adjusting its loopback port when the instance does not use 3000. Validate
   and reload Nginx without changing its IPv4 or IPv6 listeners.

The checkout, build, migration, symlink update, and service restart must all
refer to the same full commit. Never promote an artifact whose commit cannot be
proven.

## Verification

- `GET /healthz` returns 200 without redirecting.
- `GET /readyz` returns 200 and reports every configured required dependency as
  ready.
- Login, logout, team ownership, membership promotion/demotion, website access,
  and administrative routes behave as covered by the repository tests.
- The tracker script and `/api/send` accept cross-origin collection while
  authenticated application routes remain same-origin.
- External checks succeed over both the existing A and AAAA paths.

## Rollback

Point `current` back to the preceding validated release and restart the systemd
instance. Database migrations must be reviewed before rollback; never run an
ad-hoc destructive schema rollback. Preserve the failed release directory and
logs until the incident is understood.
