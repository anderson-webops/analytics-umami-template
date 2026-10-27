# Mac-built Linux ARM64 artifacts

Build, acceptance, signing and publication are separate trust boundaries.
Production activation remains a protected host operation.

## Reviewed local tools

The legacy checkout-controlled `release.sh` and `publish.sh` entrypoints fail
closed. Build through a separately reviewed, owner-only installation of
`build-unsigned.sh` under
`~/Library/Application Support/AndersonArtifactBuilder/analytics-builder-v1/`.
Its hash inventory includes the launcher and its source-independent helpers.
Its installation metadata pins the fixed Node 24.18.1/npm 12.0.2/pnpm 11.18.0/
PostgreSQL 17 Linux ARM64 toolchain archive.

Invoke the installed tool from a fresh environment containing only `HOME`,
`USER`, `LOGNAME`, `PATH` and `LANG`:

```sh
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 \
  /bin/bash "$HOME/Library/Application Support/AndersonArtifactBuilder/analytics-builder-v1/build-unsigned.sh" \
  build /absolute/clean/source v4.x.y /absolute/public-config.json /absolute/new-run-directory
```

The source must be clean, match its annotated tag and local origin/main, and
have aligned package/tag versions. The public configuration identifies exactly
one application and repository. The reviewed builder scope currently covers the
template example host, Personal, NP, Marietta and RetroZetro analytics.

## Disposable build and acceptance

The builder holds the shared build/GC lock and preserves the existing local
builder configuration. Each release uses a new four-CPU, eight-GiB ARM64 VM
with no host-directory mounts, SSH agent or forwarded ports. Source and public
configuration enter through a Git bundle and Docker stdin. Containers receive
only explicit release identifiers and synthetic database credentials.

The unprivileged build has a seven-GiB memory limit, 1,024-PID limit and bounded
output/time. It verifies frozen dependencies, registry signatures, full and
production audits, source tests, migration/restore regressions, production
compilation and native bindings. Fresh per-VM dependency volumes demonstrate a
cache-free build; existing useful caches remain intact.

Network-disabled artifact acceptance uses nested Bubblewrap inside that fresh
VM. Its privileged container has no host share, Docker socket, signing key or
GitHub authority. Acceptance exercises the exact sealed runtime, packaged
migration tool, required modules and missing-module rejection. Only the four
bounded unsigned transport assets leave the VM. The VM and its volumes are
destroyed before a successful builder receipt is returned, then the previously
running default local builder is restored.

Raw phase logs, metrics, source bundle and builder state stay in the local run
directory. They are not release assets. A failed phase or unverified cleanup
leaves signing blocked.

## Independent signing and publication

The separately installed `scripts/trusted-analytics-signer.mjs` verifies an
owner-only approval binding the exact main commit/tree, annotated tag, clean
source, contract and independently reviewed acceptance. It copies bounded
unsigned assets to private intake and verifies inventory, contained links,
native bindings, modes and configuration before using the existing enrolled
Ed25519 key. Candidate code never receives that key or a publishing credential.

The immutable transport contains exactly:

- `<site>-<tag>-linux-arm64-runtime.tar.gz`
- `anderson-runtime-manifest.json`
- `anderson-runtime-manifest.sig`
- `public-build-configuration.json`
- `acceptance-receipt.json`
- `SHA256SUMS`

Publish those retained signed bytes using trusted GitHub tooling outside the
checkout and disposable VM. Compare downloaded assets with the approved
originals before publishing the release. Existing tags, releases and assets
retain their identities. Source publication, exact-artifact acceptance and
protected activation have independent completion criteria.

## Storage and measurements

VM state, images, dependencies, temporary files and artifacts stay on Storage;
the existing signing key stays on its encrypted Mac volume. The builder
refuses an unavailable mount or a workspace alias pointing elsewhere.

`cache-maintenance.sh` remains a separately reviewed, exact-volume maintenance
tool under the same lock. This disposable release route does not prune
existing caches. Report cold/warm measurements only for comparable runs;
cgroup peak memory, network receive bytes, phase durations and archive sizes
are evidence, not inferred performance claims.
