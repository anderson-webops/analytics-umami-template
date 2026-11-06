# Disposable API fixture

`pnpm test:api` builds this source-based integration fixture with the pinned
Node 26, patched npm and native pnpm toolchains. The application runs as the
unprivileged `node` user, publishes only through the Compose loopback mapping,
and applies migrations only to the exact synthetic `db` service. PostgreSQL
uses the same pinned PostgreSQL 17 image as the ARM64 acceptance builder.
Startup provisions the shared synthetic administrator through the maintained
password command and repeats database verification. Default-password rejection
and the normal authentication controls remain active.

History-clean attestations apply only to this newly initialized synthetic stack.
It has no Kafka provider, external historical stores or restored production data.
Startup rejects other database targets and configured Kafka providers. Kept
stacks retain only the history created by this fixture.

The fixture compiles the application once and runs the standalone server with
a bounded 4-GiB heap within the 8-GiB test VM. The full endpoint matrix does not
accumulate development compiler state or depend on automatic development-server
restarts. Production runtime and builder memory limits are unchanged.

The full suite keeps its serial execution, zero retries, authenticated query
budget and enforced endpoint coverage. Historical revenue is inserted through
the real disposable Compose database services. The ClickHouse profile retains
the existing schema-compatible 25.8 fixture pending its separate schema upgrade.

`UMAMI_TEST_PORT`, `UMAMI_TEST_IMAGE` and `COMPOSE_PROJECT_NAME` select the local
fixture. `--keep`, `--up-only` and `--no-build` retain their documented meanings.
Each fresh database uses tmpfs; normal teardown discards only this test stack.
The build context excludes existing dependencies, private environment files,
Git metadata and AI working areas.

This integration fixture does not qualify a production runtime archive.
Production remains direct Node/systemd with separate exact-artifact, migration,
startup, backup and recovery acceptance.
