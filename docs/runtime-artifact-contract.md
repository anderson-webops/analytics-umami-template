# Direct runtime artifact contract

`deploy/runtime-artifact.json` is the independent required-path contract for the
compiled analytics service. It covers both service entrypoints, the Next server
tree, generated Prisma client, all migrations, production dependency links,
Linux ARM64 Sharp/libvips bindings, geodata, tracker/OpenAPI/static assets, the
source lockfile, and self-contained startup checks.

`pnpm build:production` writes `runtime-manifest.json` inside
`.next/standalone`. The manifest records the full source commit, application
version, source cleanliness, Node/OS/architecture/libc identity, trusted contract
digest, lockfile digest, type/mode, size, and SHA-256 for every artifact path.
Symlinks must be relative, remain inside the artifact, and resolve successfully.
Private configuration, credentials, databases, logs, uploads, queues, and cache
contents are rejected.

## Build and verify

Build from the exact release commit under Node 24.18.1 and pnpm 11.18.0:

```sh
pnpm install --frozen-lockfile
pnpm build:production
node scripts/runtime-artifact.mjs verify .next/standalone \
  --release --expected-commit FULL_40_CHARACTER_COMMIT
```

Verify the exact staged tree again after any host copier:

```sh
node scripts/runtime-artifact.mjs copy .next/standalone STAGED_RUNTIME \
  --release --expected-commit FULL_40_CHARACTER_COMMIT
node scripts/runtime-artifact.mjs verify STAGED_RUNTIME \
  --release --expected-commit FULL_40_CHARACTER_COMMIT
```

The copy command removes only its explicit destination, copies the complete
tree, then rechecks membership and every hash. Do not point it at a live release,
state directory, workspace root, or broad path.

## Exact clean-runtime acceptance

`pnpm test:runtime-artifact` performs a portable developer check from a copied
temporary directory outside every source-checkout ancestor. It verifies GET/HEAD
liveness, dependency-failure readiness, no-store/no-cookie/no-redirect response
contracts, bounded SIGTERM shutdown, hashes after copying, and a negative case
where the real server must fail after its Next runtime is removed. This portable
check is useful locally but is not a publishable Linux gate.

The release workflow runs natively on `ubuntu-24.04-arm`, migrates a synthetic
PostgreSQL 16 database, rotates its seeded test administrator password, and then
runs:

```sh
node scripts/test-runtime-artifact.mjs \
  --release --require-isolation --expected-commit "$GITHUB_SHA"
```

Bubblewrap exposes only a read-only artifact, Node/system libraries, a disposable
cache, private temporary storage, and the synthetic database listener. The source
checkout and development dependencies are not mounted. Bubblewrap is a build
acceptance tool, not a production container or deployment dependency. Failure to
obtain isolation fails the release gate; there is no fallback release approval.

## Migration and startup boundary

The deployment step runs source `scripts/check-db.js` before promotion. That step
owns Prisma migration execution. The artifact bundles `check-env.js` and
`check-db.js`; runtime startup passes `--verify-only`, verifies every included
migration name and checksum plus required schema, active-administrator, role,
and team-owner invariants, then starts `server.js`. Runtime checks have bounded
execution time and do not repeat password hashing or historical analytics-table
relationship scans on each restart. Those full checks remain mandatory in the
pre-promotion source step. The Prisma CLI and development dependency tree are
not runtime requirements.

Published migration bytes and exact checksum matching remain immutable. The
forward-only repair migrations documented in
`docs/migration-history-compatibility.md` preserve successful production
ledgers while keeping fresh database creation valid. Required security
constraints and unique indexes are verified independently after migration.

Tracker endpoint customization occurs before the manifest is written. Runtime
startup does not rewrite `public/script.js`, so the service needs no writable
public-assets exception.

## Writable state and rollback

- `.next/cache` is empty in every artifact and writable only within that release.
  Never promote cache contents or copy them between releases. A rollback may use
  only the retained release's disposable cache or an empty replacement.
- PostgreSQL, optional Redis/ClickHouse data, and protected environment files are
  external state. Back them up separately and keep them out of artifacts.
- Review migrations against the exact retained application before activation.
  Application rollback never reverses a database migration.
- Temporary files use systemd `PrivateTmp`; logs remain in the system journal.
- Preserve each instance's existing service user, loopback port, Nginx policy,
  certificate, IPv4/IPv6 listeners, database, and environment file. This contract
  does not authorize combining analytics instances or changing infrastructure.

## Resource envelope

The hardened unit uses `--max-old-space-size=384`, `MemoryHigh=512M`,
`MemoryMax=768M`, `TasksMax=128`, and `LimitNOFILE=8192`. The initial exact-runtime
measurement was about 171 MB RSS at startup and 312 MB after 1,100 probe requests
on ARM64 macOS. Production cgroup data should refine these per-instance limits;
do not apply a larger blanket heap merely because one workload is exceptional.
