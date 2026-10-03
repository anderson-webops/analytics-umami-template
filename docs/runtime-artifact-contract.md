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

## Source and host compatibility

The versioned `deployment` object in `deploy/runtime-artifact.json` declares
the application identity, required host-adapter capabilities, GET/HEAD health
and readiness behavior, the guarded forward-migration entrypoint, and the
retained-runtime rollback gate. Each downstream fork must replace the template
`applicationId` with its exact repository name. Tagged release CI checks that
identity before dependency installation and verifies it again in the built
manifest.
It is copied into the runtime manifest and checked against the trusted source
contract, whose SHA-256 is already bound to that manifest. The runtime artifact
verifier rejects a weakened or altered declaration. The object contains no
listener port, service user, proxy route, environment value, or database address;
those remain host policy.

Before building or migrating a candidate, the privileged host adapter should
independently fetch its canonical source identity and parse this contract as
data. It should compare the declared capabilities with its own supported set,
runtime platform and retained release. A missing capability is a **host adapter
update required** state, not an application failure or a reason to skip checks.
The adapter must not execute candidate-supplied preflight code as root or trust
an unverified manifest from builder-writable staging. Existing deployed releases
must retain their own version-specific probe and rollback policies.

The capability names have narrow meanings:

- `artifact-only-promotion-v1`: promote the verified, unchanged release payload;
  never rebuild source in the privileged activation path.
- `verified-source-and-payload-v1`: independently bind canonical Git commit,
  trusted contract digest, artifact inventory and final staged bytes.
- `guarded-forward-migrations-v1`: verify historical ledgers before mutation,
  rehearse pending forward migrations on a restored copy, then use the guarded
  source migration entrypoint without editing applied migration history.
- `retained-artifact-rollback-v1`: keep the exact prior artifact and its host
  configuration, and restore those bytes without a network fetch or rebuild.
- `database-aware-recovery-v1`: when the retained runtime cannot start against
  the candidate's migrated database, require a protected, independently verified
  pre-migration backup and a rehearsed database restore before restoring the
  retained artifact. This is a host capability, not an application backup.
- `version-aware-readiness-v1`: apply the candidate's health and readiness rules
  to the candidate, and the retained release's own rules during recovery.
- `coordinated-listener-transition-v1`: rehearse a changed loopback listener,
  then switch service, protected environment, proxy, and monitor as one guarded
  transition with restoration of the prior configuration on failure.
- `classroom-2fa-privacy-acceptance-v1`: prove mandatory classroom 2FA and
  privacy constraints against the candidate before activation.

These are requirements, not claims of current host support. A host adapter
should advertise its implemented capabilities under root-controlled policy and
refuse a candidate before building when any requirement is absent. Report that
case as `host_update_required`; report transient registry transport as
`retry_scheduled`, identity/artifact/migration failures as `release_rejected`,
and a failed activation restored from retained bytes as `rolled_back`. Keep the
failing stage in the record and distinguish each from an unhealthy serving site.

The default `rehearse-retained-runtime-against-migrated-copy` policy requires
the exact retained runtime to pass startup against a migrated database copy.
If it cannot, a downstream may instead declare
`protected-pre-traffic-database-restore-v1` together with
`database-aware-recovery-v1`. The host must then prove a complete restore of
the exact pre-migration database and old artifact/configuration after an
injected candidate activation failure, before any public write is admitted.
All application writers, including other instances sharing the data, must be
quiesced from the backup through acceptance. The host must verify the backup,
unchanged historical ledger, ownership/routing, and restored old-runtime
readiness. If it cannot prove write quiescence or exact restore, activation
stops. Once public writes resume on the new schema, restoring the old database
would discard them: automatic rollback to the old runtime is forbidden then.
Keep the candidate serving while investigating or ship a compatible forward
repair; do not silently restore a stale database. The source contract never
grants the host permission to mutate production or clears a migration hold.

This source declaration does not attest that any production host has adopted
these capabilities. CI's isolated exact-artifact acceptance remains required;
upgrade from a retained production release, deliberately failed promotion, and
rollback require separate host-controlled rehearsal against that release and a
restored database copy. A release is not activation approval merely because its
source and artifact checks pass. Temporary registry/network failures should be
reported as retryable by the host; invalid identity, migration history, payload,
or host compatibility must remain blocked with a specific stage and reason.

## Build and verify

Build from the exact release commit under Node 24.18.1 and pnpm 11.18.0:

```sh
pnpm install --frozen-lockfile
pnpm build:production
node scripts/runtime-artifact.mjs verify .next/standalone \
  --release --expected-commit FULL_40_CHARACTER_COMMIT \
  --expected-application EXPECTED_REPOSITORY_NAME
```

Verify the exact staged tree again after any host copier:

```sh
node scripts/runtime-artifact.mjs copy .next/standalone STAGED_RUNTIME \
  --release --expected-commit FULL_40_CHARACTER_COMMIT \
  --expected-application EXPECTED_REPOSITORY_NAME
node scripts/runtime-artifact.mjs verify STAGED_RUNTIME \
  --release --expected-commit FULL_40_CHARACTER_COMMIT \
  --expected-application EXPECTED_REPOSITORY_NAME
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
first verifies the repository contract and every existing database-ledger row,
then owns Prisma migration execution, and finally requires the complete migrated
ledger and schema to match the release. No pending migration is allowed to run
after historical drift is detected. All supported migration commands use this
gate. If `DIRECT_DATABASE_URL` is configured, the gate also proves it resolves
to the same PostgreSQL cluster, database, and schema as `DATABASE_URL` before
mutation. The artifact bundles `check-env.js` and
`check-db.js`; runtime startup passes `--verify-only`, verifies every included
migration name and checksum plus required schema, active-administrator, role,
and team-owner invariants, then starts `server.js`. Runtime checks have bounded
execution time and do not repeat password hashing or historical analytics-table
relationship scans on each restart. Those full checks remain mandatory in the
pre-promotion source step. The Prisma CLI and development dependency tree are
not runtime requirements.

Published migration bytes and exact checksum matching remain immutable. The
packaged `prisma/migration-ledger-contract.json` and forward-only repair
migrations documented in `docs/migration-history-compatibility.md` preserve
successful production ledgers while keeping fresh database creation valid.
Required security constraints and unique indexes are verified independently
after migration.

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
  With the default policy, application rollback never reverses a database
  migration. The opt-in database-aware policy requires a protected host restore
  only during a verified write-quiesced, pre-traffic failure window; it does not
  permit restoring a stale backup after production writes resume.
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
