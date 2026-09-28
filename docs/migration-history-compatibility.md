# Migration history repair and rollout

This source repair preserves successful Prisma migration ledgers. It does not authorize production
activation. Operators must not rewrite checksums, mark migrations as applied, reset a database, use
force flags, or replace a newer database with an older source tree.

## Source facts

Three published migration files had been edited after successful deployments. This release restores
their original bytes and SHA-256 values:

| Migration | Restored source and successful ledger SHA-256 | Superseded edited SHA-256 |
| --- | --- | --- |
| `16_boards` | `52df2b4723b1c9e1c2dc66ffb191df56742a23e48a5cd7bc12947fbbc7b420fb` | `5cef1484333ad14bcbbc3e1b2262601d3274a072d9656fb422530d112f98b447` |
| `21_harden_auth_invariants` | `af596c3f844becd9f8382f6aec03d6541612f348aa4921ba8a35cc1d5fc6655b` | `e669afc3a59050a260a786d061a65ba42c33fed2bdaf94d486292017a48352a0` |
| `23_update_session_data` | `5fc778b82bb34c3c04d78061e66d7036c3c51d0c506f5279f3c1cfc99f24f694` | `197a061867454962d30711d1f61abe92679bb862088a3feb5a552fb7d66dfad9` |

The current SQL effects are retained through new forward migrations:

1. `22_prepare_session_data_index_rebuild` validates and temporarily renames the exact expected
   session-data unique index before the immutable migration 23 runs.
2. `25_finalize_session_data_index_rebuild` removes duplicate rows deterministically, ensures the
   canonical unique index exists, validates it, and removes only the reviewed temporary index.
3. `27_remove_redundant_board_primary_key_index` validates and removes the redundant unique index
   introduced by the immutable migration 16. The primary-key index remains.

Each bridge fails closed on an unexpected table, column order, uniqueness, predicate, expression, or
validity state. Future schema changes must use new forward migrations. Never edit these published
migrations again.

`prisma/migration-ledger-contract.json` pins the successful historical checksums for this repository.
The source validator, migration rehearsal, database preflight, and packaged runtime all consume that
contract. A downstream database may legitimately have a different successful checksum when that fork
published different historical bytes before joining this template. In that case, preserve the
downstream's exact applied bytes and override its contract in a separate site-specific commit. Never
replace an applied downstream migration merely to make it byte-identical to this template, and never
rewrite the database ledger to match incoming source. Retain desired schema effects through a new
forward migration instead.

The finalizer runs inside an explicit PostgreSQL transaction. If index creation, validation, or
cleanup fails after duplicate selection begins, the row changes and index changes roll back together.
The regression suite forces that late failure and verifies that both original duplicate rows remain.

## Required preflight and rehearsal

For the Avasan overlay, run `pnpm run test:migration-attempts --classroom` to
exercise its production privacy configuration with synthetic values. This test
does not call the classroom summary provider or enable accounts or collection.

### Multiple attempts for the same migration

The migration gate validates every attempt grouped by migration name, without
depending on SQL row order. Exactly one completed attempt with the source
checksum is accepted alongside any number of explicitly rolled-back attempts.
Rolled-back attempts keep their original checksums and metadata; they do not
count as successful applications. A rollback-only or absent migration can be
applied by `db:migrate`, but cannot satisfy startup readiness.

Unfinished attempts, contradictory finished/rolled-back states, unknown
migrations in any state, successful checksum drift, and multiple successful
attempts are rejected. This applies to both the migration gate and the bundled
`--verify-only` startup gate. Diagnostics contain fixed bounded classifications
without database-provided names, checksums, logs, or connection information.
No ledger row is repaired, deleted, selected away, or overwritten by validation.

`pnpm run test:migration-history` checks all 3,914 subset/order/phase combinations
of success, rollback, pending, unknown, checksum-drift and contradictory states,
plus duplicate-success and multiple-rollback cases.
`ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm run test:migration-attempts` requires an
explicit loopback PostgreSQL test URL and creates only a fresh random schema.
It executes the real `db:migrate` command and production startup supervisor with
freshly bundled checks, verifies that invalid histories cannot reach the app,
and compares all historical ledger columns before and after every invocation.
It also proves a rollback-only pending migration can be retried without changing
the retained attempts. Full runtime acceptance separately exercises the real app.

The new startup gate rejects migrations absent from its own release. An older
runtime's compatibility with a newer schema must still be rehearsed against that
exact retained runtime. This source change does not revise a reverse-schema
contract, certify annotation/API-key ownership when splitting instances, or
authorize production migration. Avasan's existing `127.0.0.1:3111` listener and
the reviewed host finalizer transition remain operator gates; do not substitute
port 3000, alter a serving listener, or relax an installed template check.

1. Record the exact active release, retained rollback application, candidate commit, migration names,
   completion states, rollback states, and checksums without printing credentials or database names.
2. Run `pnpm run check:migration-history`, then stop if a successful checksum differs from the exact
   repository contract, an attempt is unresolved, successful history is ambiguous, an unknown
   migration is present, the database changed after the backup, or an index has an unexpected
   definition. Retain explicitly rolled-back attempts alongside their matching successful retry.
3. Take a protected logical backup and prove it can be restored into an isolated rehearsal database.
4. Against only that restored copy, run the exact candidate's locked install, `pnpm run db:migrate`,
   `pnpm run check:db`, and `ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm run test:migration-bridge`.
5. Verify the temporary bridge index is absent, the canonical session-data index is valid and unique,
   the redundant board index is absent, all source checksums match the successful ledger, and the
   retained application remains schema-compatible.
6. Exercise the exact copied runtime, health/readiness, authentication, analytics reads, and graceful
   shutdown with synthetic providers before a separately approved maintenance window.

Application rollback does not reverse a database migration. Preserve the database, tenant, service,
listener, proxy, certificate, secret, and writable-state boundaries for each analytics instance.

The migration bridge regression suite also builds a disposable schema, snapshots its historical
ledger rows, removes only the three new bridge entries to model an already-upgraded production
ledger, and reruns Prisma deployment. It requires all three late-added migrations to apply without
changing any historical ledger row, then verifies the exact restored checksums and final indexes.
It separately replaces the successful `16_boards` ledger checksum with the exact superseded
`5cef148...` variant while a forward migration is pending, runs the real source preflight, and proves
the pending migration and its schema effect remain absent.
Every supported migration command routes through that preflight. When `DIRECT_DATABASE_URL` is set,
the gate proves that it identifies the same PostgreSQL cluster, database, and schema as `DATABASE_URL`
before Prisma can mutate anything. Distinct network endpoints are allowed only when that identity
matches; a different database or schema fails closed.
