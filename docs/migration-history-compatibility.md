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

## Required preflight and rehearsal

1. Record the exact active release, retained rollback application, candidate commit, migration names,
   completion states, rollback states, and checksums without printing credentials or database names.
2. Stop if any historical checksum differs from the restored values above, any migration is incomplete
   or rolled back, the database changed after the backup, or an index has an unexpected definition.
3. Take a protected logical backup and prove it can be restored into an isolated rehearsal database.
4. Against only that restored copy, run the exact candidate's locked install, Prisma migration deploy,
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
