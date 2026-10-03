# Restore-compatible release acceptance

The schema gate accepts exactly the historical PostgreSQL array-level casts and
the equivalent PostgreSQL 17 dump/restore per-element casts for the two named
role constraints. Both forms retain the exact table, constraint name/type,
validation status and allowed roles. Other authorization and index invariants
are unchanged. Historical migrations and their checksums must not be edited.

Run `PG17_BINDIR=/path/to/postgresql/17/bin pnpm test:postgres17-restore` after
generating the Prisma client. Pass `--classroom` for the Avasan overlay. This
creates and removes a dedicated loopback-only PostgreSQL 17 cluster. The test
uses real pg_dump/pg_restore, historical successful and rolled-back ledger rows,
pending forward migrations, repeat migration, bundled startup, and negative
authorization constraints. All data is synthetic. It does not establish live
authentication, production reverse-split recovery or production activation.
CI installs PostgreSQL 17 through the [official PostgreSQL Apt repository](https://www.postgresql.org/download/linux/ubuntu/).

## Finalizer invariants

1. Independently fetch the canonical repository and verify the requested commit
   and annotated tag under root-controlled policy. Use
   `scripts/materialize-canonical-source.sh` on that trusted Git repository to
   create a detached, complete checkout. Do not substitute an archive, copy
   staging metadata, or override a dirty source result. Git metadata contains no
   credentials and has no alternates into the private verification repository.
2. Before production pruning, use `package-runtime-workspaces.mjs capture` to
   record built distributions and the reachable production graph. After pruning,
   `package` places declared workspace files and dependency links inside
   node_modules. Remove only captured non-production dangling hoists and the
   exact dev-only `braces@3.0.4-webops.1` link to tracked `vendor/braces` after
   rechecking its path, version, and file hashes. Unknown external links and
   production dependencies still fail closed. Only unchanged, Git-untracked
   workspace distribution/dependency outputs are removed from the source tree.
   Unexpected links or changes fail.
3. Stop the builder and exclude every writer before sealing. Verify the compiled
   manifest against the trusted contract and expected commit. The shared
   `sealRuntimeArtifact` transition preserves all hashes, sizes, link targets and
   source metadata; it changes only directories/executable files to 0555 and
   other files to 0444. It independently verifies the resulting inventory before
   writing the final manifest and then verifies again. Never run manifest creation
   to bless a changed payload. Prepared-marker updates must first verify the
   original marker and may reflect only that verified manifest transition.
4. Synthetic acceptance must run in a separate private network with no host
   PostgreSQL socket. Keep the checkout at its original absolute path so pnpm's
   installed layout remains valid. The nested runtime sandbox may relocate only
   the already self-contained artifact. On hosts requiring it, relax
   RestrictSUIDSGID/namespace restrictions only on this disposable acceptance unit,
   never on the production application service. Use synthetic credentials and
   disable all real providers.
5. Run immutable verification outside the application's cache bind-mount
   namespace. Inside the service, only its explicitly declared external disposable
   cache is writable. Its contents are not immutable code.
6. Run a frozen reviewed copy of the wrapper/helper set throughout finalization.
   Never replace an executing Bash file. Retain failed build evidence root-private;
   a failed build cannot be sealed or promoted.

## Separate production gates

After source validation, operators still need fresh protected backups, restored
production-copy rehearsals, mandatory classroom 2FA/privacy/login/logout checks,
and exact old-runtime rollback after injected failed activation. Personal
Analytics additionally needs reversible four-instance splitting, with demonstrated
annotation/api_key ownership and routing. Do not infer these from synthetic
fixtures or update the reverse-schema contract without that evidence.

Avasan's retained v5.0.0 uses 127.0.0.1:3000; new guarded releases require
127.0.0.1:3111. Validate the prospective nonsecret configuration before changing
the serving environment. Switch runtime, environment and proxy as one protected
transition, and restore their exact prior versions together on failure. Never
weaken candidate checks to accept the old listener or impose new-only gates on
the retained old release. Preserve existing Nginx, DNS, credentials and data until
the reviewed host transition passes. Source publication is not activation.
