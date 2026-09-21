# Direct Production Deployment

This repository deploys directly on Linux with Node, systemd, Nginx, and
PostgreSQL. Production containers and container registries are not part of the
supported topology.

## Host prerequisites

- Node 24.18.1 installed at `/opt/node-24.18.1/bin/node` and pnpm 11.18.0 for builds
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
4. Verify the manifest before any copy with
   `node scripts/runtime-artifact.mjs verify .next/standalone --release --expected-commit FULL_COMMIT`.
   If an adapter copies the runtime, run the same verification against the exact
   staged destination. Rehashing an incomplete tree does not satisfy the
   independent required-path contract.
5. With `NODE_ENV=production`, run `node scripts/check-env.js` and
   `node scripts/check-db.js` from the source release. This is the only step
   that executes Prisma migrations. It then verifies every migration checksum
   and fails closed on invalid role, ownership, share, or relational state.
6. Point `/srv/umami/<instance>/current` at the new release atomically.
7. Install `deploy/systemd/umami@.service` as
   `/etc/systemd/system/umami@.service`, reload systemd, and restart
   `umami@<instance>.service`. Runtime startup uses the self-contained artifact
   checks in verify-only mode; it never needs the Prisma CLI or development
   dependencies and cannot mutate the tracker bundle. The runtime database
   check is bounded to release migrations, required schema, an active
   administrator, supported roles, and one active owner per active team. The
   full password-hash and historical relationship audit remains in step 5 so
   service restarts do not scan the analytics fact tables.
8. Include `deploy/nginx/analytics.locations.conf` in the HTTPS server block,
   adjusting its loopback port when the instance does not use 3000. Validate
   and reload Nginx without changing its IPv4 or IPv6 listeners.

The checkout, build, migration, symlink update, and service restart must all
refer to the same full commit. Never promote an artifact whose commit cannot be
proven.

The systemd unit applies a measured 384 MB V8 heap cap, 512 MB memory-pressure
threshold, and 768 MB hard memory ceiling. The source benchmark used the exact
standalone runtime on ARM64 macOS: approximately 171 MB RSS at startup and
312 MB after 1,100 liveness/readiness requests. Treat production cgroup metrics
as the authority; raise a limit only after a representative workload shows the
application needs it, and never remove limits from every instance as a shortcut.

`.next/cache` is disposable and release-scoped. Start a new release with an
empty cache, never copy it from the active release, and never package its
contents. PostgreSQL, optional Redis/ClickHouse state, protected environment
files, and logs remain outside every release.

## Verification

- `GET /healthz` returns 200 without redirecting.
- `GET /readyz` returns 200 and reports every configured required dependency as
  ready.
- Login, logout, team ownership, membership promotion/demotion, website access,
  and administrative routes behave as covered by the repository tests.
- The tracker script and `/api/send` accept cross-origin collection while
  authenticated application routes remain same-origin.
- External checks succeed over both the existing A and AAAA paths.
- The exact copied artifact passes `node scripts/test-runtime-artifact.mjs` on
  the host architecture. A publishable Linux ARM64 artifact additionally needs
  Bubblewrap isolation and a synthetic PostgreSQL fixture as described in the
  runtime artifact contract.

## Rollback

Point `current` back to the preceding validated release and restart the systemd
instance. Database migrations must be reviewed before rollback; never run an
ad-hoc destructive schema rollback. Preserve the failed release directory and
logs until the incident is understood.
