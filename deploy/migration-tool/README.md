# Packaged database migration gate

Deployment schema 4 requires `packaged-migration-tool-v1`. Its pre-promotion gate is
`runtime-scripts/check-db.mjs`, inside the verified signed runtime, not
`scripts/check-db.js` from a source checkout. The runtime archive contains a
separate `migration-tool/` tree with the locked Prisma CLI, its Linux ARM64
schema engine, production dependencies, and configuration. The application
service does not invoke this tool during normal startup. `--migrate-only` runs
the guarded preflight and forward migrations; `--verify-only` checks startup
compatibility without applying migrations.

The existing six signed release assets remain the transport envelope. There is
no independently downloadable companion and no change to an already published
archive. The runtime manifest inventories and hashes every packaged tool file
and link. The host adapter must reject this schema and capability until it has
been reviewed to verify and run the gate from its protected copy of the exact
archive, with the reviewed public configuration and database target. It must
not fetch packages, borrow tools from a prior checkout, or run candidate source
scripts as root. This contract changes the runtime digest and requires a new
immutable release; it does not itself authorize a host or database transition.

Before any database-changing activation, rehearse the exact retained schema,
historical ledger, repeat migration, rejected/unfinished ledger, interrupted
migration, and failed activation against protected copies. Keep the retained
application, database backup, and host policy paired for recovery. A pointer
rollback alone is not sufficient when the old runtime rejects new migration
rows. Site-specific ownership and reverse-split checks remain separate host
acceptance requirements.
