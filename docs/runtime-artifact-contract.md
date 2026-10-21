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

Schema version 2 binds the 30-day heatmap retention files and
`bounded-heatmap-retention-v1` capability. Historical version 2 releases may
also declare the complete replay-retention files and capability together.
Schema version 3 requires both complete retention file sets and both host
capabilities; removing the replay files and capability together fails source
validation. Legacy schema version 1 contracts remain valid only without these
retention files or capabilities. Host adapters must verify the canonical
release contract, reject a candidate's schema-version downgrade, and reject
an unsupported version before migration. Retained releases are verified against
their own version-specific contracts and policies.

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
- `packaged-migration-tool-v1`: use only the independently inventoried Prisma
  CLI and Linux ARM64 schema engine from the accepted runtime artifact for
  migration checks and forward application. Do not install packages, execute
  checkout scripts, or fetch a different migration tool on the host.
- `retained-artifact-rollback-v1`: keep the exact prior artifact and its host
  configuration, and restore those bytes without a network fetch or rebuild.
- `database-aware-recovery-v1`: when the retained runtime cannot start against
  the candidate's migrated database, require a protected, independently verified
  pre-migration backup and a rehearsed database restore before restoring the
  retained artifact. This is a host capability, not an application backup.
- `legacy-clickhouse-erasure-review-v1`: before activation, inventory every
  previously configured ClickHouse database and retained historical table.
  Review and rehearse protected cleanup or retirement of old and interrupted
  migration objects, including the unscoped join table and dependent views.
  Verify source reset/deletion behavior and exact retained-runtime recovery.
  If ClickHouse is now disabled, set the protected
  `CLICKHOUSE_HISTORY_ATTESTED_CLEAN=true` environment value only after proving
  no retained ClickHouse data can survive an acknowledged deletion. An absent
  current ClickHouse URL is not evidence of a clean history.
- `version-aware-readiness-v1`: apply the candidate's health and readiness rules
  to the candidate, and the retained release's own rules during recovery.
- `coordinated-listener-transition-v1`: rehearse a changed loopback listener,
  then switch service, protected environment, proxy, and monitor as one guarded
  transition with restoration of the prior configuration on failure.
- `classroom-2fa-privacy-acceptance-v1`: prove mandatory classroom 2FA and
  privacy constraints against the candidate before activation.
- `bounded-heatmap-retention-v1`: before activation, verify a monitored periodic
  PostgreSQL cleanup job runs the immutable, bounded pruner through a direct,
  non-transaction-pooled connection to the checked database and schema. If
  ClickHouse or Kafka is configured, verify the exact conditional TTL, producer
  and consumer marker and acceptance-time mapping, topic retention, delayed
  message behavior, and absence of incompatible writers. Monitor incomplete
  cleanup runs and remaining backlog. Rehearse old-data preservation and
  failed-activation recovery.
  Column presence or report filtering alone does not satisfy this capability.
- `bounded-replay-retention-v1`: before activation, verify the immutable,
  bounded PostgreSQL replay-payload and saved-bookmark pruner is scheduled and
  monitored against the checked database and schema. If ClickHouse or Kafka is
  configured, verify the conditional replay TTL, marker and trusted acceptance
  time through the exact producer and consumer, and bounded topic retention.
  Preserve historical unmarked rows and bookmarks, test delayed messages, and
  rehearse protected migration and retained-runtime recovery. Read filtering
  or schema presence alone does not satisfy this capability.
- `authenticated-advanced-collection-v1`: before activation, verify the
  separately scoped backend collection-key configuration, site-owned proof and
  consent integration, exact permit route, default denial of unverified revenue,
  and strict replay masking. Rehearse anonymous pageviews, denied advanced
  browser submissions, batch isolation, key revocation, permit expiry, and
  retained-runtime rollback. A public website ID or allowed origin is not proof.
- `owner-bound-collection-keys-v1`: require the forward-only website-generation
  and durable deletion-tombstone migration. Verify that key provisioning binds
  the current website owner and generation, and that transfer, domain change,
  reset, deletion, and same-ID recreation revoke old keys and permits across
  both database-backed and external-write paths. Preserve the tombstone through
  backup and recovery; source configuration alone is not a revocation proof.
- `session-property-trust-tier-v1`: require the forward-only PostgreSQL and
  ClickHouse migration files in the verified artifact. Test historical tier-0
  preservation, tier-1 backend-authorized writes, derived-report exclusion of
  unverified rows, and exact PostgreSQL and ClickHouse query behavior. If Kafka
  is configured, verify the independent consumer preserves `trust_tier` for
  delayed and retried messages. Rehearse protected database recovery with the
  exact retained runtime before changing production. A source producer test or
  column-presence probe alone does not establish host support.
- `identity-link-trust-tier-v1`: require the forward-only PostgreSQL
  `session_link.trust_tier` migration in the verified artifact. Historical
  links remain tier 0; only a backend-authorized identify request may create
  or upgrade a tier-1 link. Verify that session detail and activity traverse
  only tier-1 PostgreSQL links in both storage modes, while legacy ClickHouse
  links remain usable only for bounded admission accounting. Rehearse the
  exact retained runtime against a migrated copy and its database-aware
  recovery before activation. Neither a legacy link nor its producer topic
  establishes verified identity.
- `event-claim-trust-tier-v1`: require the forward-only PostgreSQL and
  ClickHouse event-column migrations in the verified artifact. Historical
  event and event-property rows remain tier 0; only backend-authorized custom
  events may be written as tier 1. Verify the independent Kafka consumer
  preserves both event and property tiers before activation. This producer
  marker alone does not make legacy aggregates or direct reads authoritative;
  prove tier-aware reporting and retained-runtime database recovery separately.
- `unverified-revenue-materialization-disabled-v1`: require the ClickHouse
  migration in the verified artifact. Before removing the legacy view, verify
  its retained definition and quiesce ingestion. The migration preserves the
  revenue table and historical rows but stops deriving new revenue from
  flattened browser event data. Test repeat migration, historical-row
  preservation, denied advanced claims, and old-runtime recovery on a protected
  copy. This does not classify legacy rows as verified or authorize direct
  writes from an independently maintained consumer.
- `attested-revenue-ledger-v1`: require the forward-only PostgreSQL movement
  migration and its immutable, website-scoped capture constraints. Keep intake
  disabled until the site backend verifies orders, provisions a revenue-scoped
  key, supplies stable movement IDs, and passes duplicate, conflict, deletion,
  and failed-activation recovery tests. Backend attestation is not settlement
  proof, and this ledger does not make historical revenue reports authoritative.

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

The copy destination's parent must already exist under protected ownership and
permissions. The copier resolves both the supplied and canonical parent paths
and the identity of an existing destination, rejects untrusted symlinks and
replaceable ancestors, and requires a trusted destination directory if one is
present. Even a private leaf is unsafe beneath a group/world-writable non-sticky
mountpoint. A privileged copier
must use root-owned staging ancestors, not a build-user-writable tree.
It copies to a private sibling first and verifies that tree before removing only
the explicit destination and renaming the verified copy into place. It then
rechecks membership and every hash. A failed preflight or staging verification
leaves an existing destination intact. Do not point it at a live release, state directory,
workspace root, or broad path; the protected host handles promotion and rollback.

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
and team-owner invariants. The launcher then replaces itself with `server.js`,
retaining its PID and runtime working directory while excluding
`DIRECT_DATABASE_URL` and the dotenv config path from the server environment.
The source launcher refuses `DIRECT_DATABASE_URL` altogether; migrations use
the separate pre-promotion database command, never a start alias.
Runtime checks have bounded execution time and do not repeat password hashing
or historical analytics-table
relationship scans on each restart. Those full checks remain mandatory in the
pre-promotion source step. The Prisma CLI and development dependency tree are
not runtime requirements.

Published migration bytes and exact checksum matching remain immutable. The
packaged `prisma/migration-ledger-contract.json` and forward-only repair
migrations documented in `docs/migration-history-compatibility.md` preserve
successful production ledgers while keeping fresh database creation valid.
Required security constraints and unique indexes are verified independently
after migration.

## External tracker script approval

The bundled `public/script.js` remains the default tracker. If protected runtime
configuration selects `TRACKER_SCRIPT_URL`, or enables `CLOUD_MODE` in production,
the operator must independently approve the exact remote JavaScript bytes and set
their lowercase SHA-256 as `TRACKER_SCRIPT_SHA256` before startup. The source
environment gate rejects missing or malformed approval; the runtime route also
fails closed. The proxy sends both `/script.js` and configured aliases to the
local verifier, not directly to the remote host. That verifier fetches only the
configured HTTPS URL without incoming request credentials, rejects redirects and
oversized responses, and serves only bytes matching the approved digest. A
verified response may be cached in the service process. A changed or unavailable
remote script returns 503 until the operator reviews and approves a new digest;
there is no unpinned fallback. The direct cloud-host script named in cloud-mode
tracking snippets is a separate trust path and is not validated by this route.

`TRACKER_SCRIPT_SHA256` is nonsecret but host-controlled. Review this change to
the bundled `check-env.js` checksum, the runtime contract, the selected site's
external-script use, its signed public build configuration and digest, and its
protected environment before activation. Keep the
previous release and configuration for rollback. Do not set the new digest from
an unreviewed live fetch, relax startup or artifact checks, or treat a source
release as authorization to change protected configuration.

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
