# Mac-hosted Linux ARM64 builds

This is a build-only pilot. Production remains container-free and the protected
server-side system alone may install or activate a release. The server's Mac
artifact intake is disabled until its operator separately reviews and enables
the exact builder key, site scope, runtime contract, and artifact-only adapter.

Before every Colima, Docker, Homebrew, or signing command in this workflow, run:

```sh
source deploy/mac-build/storage-env.sh
colima status
docker --context colima info --format '{{.OSType}} {{.Architecture}}'
```

The launcher refuses an absent Storage volume or a Sites alias that no longer
points to it. Its Colima VM disk and image store, Lima state, Docker configuration,
Homebrew download cache, temporary files, and build exchange are all under
`/Volumes/Storage/General Storage`. Colima must mount **only**
`/Volumes/Storage/General Storage/Builder/exchange` into the Linux VM. Do not
mount the entire Sites tree or Builder tree. The Storage volume is unencrypted,
so the small private signing key lives instead in the Mac's FileVault-protected
`~/Library/Application Support/AndersonArtifactBuilder` directory, outside the
VM, source, and exchange. The signer checks volume encryption, owner, and modes.
Never place the key in a container, repository, build log, or release asset.
The large VM, images, caches, dependencies, and artifacts remain on Storage.

Run `bash deploy/mac-build/key-setup.sh` once. This refuses to replace an existing
key and prints only the public-key path. Give the public PEM and a reviewed
builder ID plus exact site scopes to the protected server operator separately.
The private key must never be sent to the server or GitHub.

From a clean checkout at an **annotated, not-yet-reused** semantic tag, build and
sign with one command:

```sh
bash deploy/mac-build/release.sh vX.Y.Z deploy/mac-build/public-template.json \
  jacob-m3 "$ANDERSON_BUILDER_SIGNING_DIR/private-key.pem"
```

Use the fork's reviewed public configuration file for a real site. Add
`--publish` only when authenticated GitHub CLI publication is available. The
build uses a Git bundle of the exact tag, never Mac `node_modules`; a pinned
Linux ARM64 image and a synthetic local PostgreSQL 17 instance run all locked
installation, signature, audit, application, migration, native-binding, build,
copy, isolation, and missing-module checks. A second network-disabled container
packages the sealed checked runtime. Only the completed unsigned assets cross
back to the Mac, which signs exact manifest bytes and verifies the result using
its public key. The disposable container volume is removed, while the shared
pnpm store and nonsecret run evidence stay on Storage.

If publication is deferred, run
`bash deploy/mac-build/publish.sh vX.Y.Z /absolute/path/to/assets` after the
GitHub CLI is authorized. Publication first verifies the signed bytes and
source tag, then pushes the tag, creates a draft GitHub release, checks every
uploaded asset's size and digest, and only then publishes it. An existing
release is never overwritten. A draft left after an asset or CI failure is not
deployment-ready. Source publication does not prove server activation.

The pinned toolchain image in `Dockerfile` is Linux ARM64 glibc with Node
24.18.1, npm 12.0.2, pnpm 11.18.0, and PostgreSQL 17. It is a prerequisite, not an approved
release by itself. Build from a clean annotated tag with frozen dependencies;
run the source tests, full and production audits, signature checks, PostgreSQL
restore regressions, and copied-runtime acceptance before transport packaging.
Do not sign a self-reported check receipt without independently running those
gates. Publish only the exact tested archive, transport manifest, detached
signature, checksums, and required per-application evidence. No real production
secrets or databases belong in the builder.

The existing release acceptance uses Bubblewrap. A disposable container with
default Docker permissions cannot create its nested namespaces. A diagnostic
probe did succeed with `--privileged` inside the dedicated Colima VM while
Docker networking was disabled and no host directories were mounted into that
container. The existing non-release copied-runtime acceptance also passed for
the already-built template v4.2.132 artifact with a read-only exchange mount,
disabled networking, bounded container resources, a disposable filesystem, and
the missing-module regression. This is not a clean tagged release build, a
PostgreSQL-ready release acceptance, or proof of the final signing workflow. If
that route is used for release validation, keep the VM limited to the exchange
mount, keep signing material outside the VM, and run every release gate and
failure case before signing a receipt.
Do not substitute an unsandboxed smoke test. Do not enable server intake merely
because the Mac has published a signed asset. The host operator still owns
public-key registration, scope approval, independent source/asset checks,
artifact-only promotion, database compatibility, rollback rehearsal, and the
pilot activation.
