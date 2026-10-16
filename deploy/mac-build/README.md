# Mac-hosted Linux ARM64 builds

This is a build-only pilot. Production remains container-free and the protected
server-side system alone may install or activate a release. The server's Mac
artifact intake is disabled until its operator separately reviews and enables
the exact builder key, site scope, runtime contract, and artifact-only adapter.

Before every Colima, Docker, Homebrew, or signing command in this workflow, open
Bash and run:

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
This version uses the Docker Buildx plugin from the Storage-backed Docker
configuration for the fixed-toolchain BuildKit cache mount. Verify
`docker --context colima buildx version` before a release; do not fall back to
the legacy Docker builder, which cannot interpret the cache mount.
Use an 8 GiB Colima VM for the 7 GiB build-container limit. Next.js can run
compilation and TypeScript workers concurrently; the smaller 5 GiB limit has
terminated a valid build during type checking. Keep production limits unchanged.

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
tests and packages the sealed read-only runtime, so its sandbox reads the exact
permissions delivered in the archive. Only the completed unsigned assets cross
back to the Mac, which signs exact manifest bytes and verifies the result using
its public key. The disposable container volume is removed, while a repository-scoped
pnpm store remains in a persistent Storage-backed VM volume and nonsecret run
evidence stays on Storage. Installs use frozen lockfiles and verify package
signatures and full/production audits regardless of cache hits.
The builder scopes pnpm's virtual-store directory-name limit to 60 bytes, so
verified standalone dependencies fit the server's portable USTAR transport
without changing normal development installs or the committed lockfile.
Only the build phase mounts the pnpm store and a separate Next compiler cache.
The store scope binds the repository and exact Linux toolchain image. The
compiler scope also binds the tracked lockfile, workspace/package settings,
patches, build scripts, runtime contract, and public build configuration.
Source-only edits can reuse compatible compiler work, but a different site,
dependency graph, toolchain, or public flag cannot. The offline checkout and
isolated acceptance phases cannot write either cache. Only checkout mounts the
per-run exchange directory, read-only and unprivileged. Privileged,
network-disabled acceptance sees only its disposable Docker volume. A separate
read-only inventory phase limits and checks the four unsigned asset files; a
stopped copy container then exports them before Mac-side signing. Acceptance
invokes already-installed executables directly and never silently reinstalls
packages.
The stopped copy container is removed with its inherited anonymous PostgreSQL
volume, while the selected pnpm and compiler cache volumes remain intact.
The root application's version string does not invalidate the dependency store,
but it does invalidate the compiler cache because `next.config.ts` embeds that
version in the build. The versioned runtime is rebuilt from the exact tag and
still passes the complete audits, tests, native checks, and copied-runtime
acceptance. This builder is
for reviewed clean release tags, not untrusted pull requests.

Docker BuildKit retains only fixed toolchain npm downloads in its own cache.
It does not cache a complete signed output or place macOS modules in the Linux
runtime. Each site keeps its own lockfile and can deliver a passing security
update independently. Start shared corrections in the owned template, then
merge into compatible forks without combining their users, databases, or
public configuration.

`bash deploy/mac-build/cache-maintenance.sh` reports only labeled builder
cache volumes. It proposes removal after 30 idle days or 512 MiB for a compiler
cache, and 90 idle days or 2 GiB for a pnpm store. Review the report, then use
`--volume NAME --apply` for deliberate targeted garbage collection; active containers and
signed assets are never selected. An evicted cache costs time, not correctness.
The release and maintenance commands share a fail-fast Mac-side lock so a cache
cannot be removed during a build and two 7 GiB builds cannot run at once.
Per-phase wall time, result, and bounded output bytes are saved beside each
run log as `.metrics.json` on Storage, not in the fixed six-asset release bundle.
Each successful container phase also reports its cgroup peak memory and network
receive bytes; the build reports both cache sizes. Network receive includes
protocol and non-package traffic, so do not label it exact package downloads.
Compare measured cold and warm builds of the same code/configuration before
claiming a speedup. Archive and expanded runtime sizes come from the verified
transport manifest. Do not treat store growth as network traffic.
The release builder runs the complete Vitest suite with one worker and a
20-second per-test limit so parallel cold imports and browser interactions do
not contend for the bounded VM's CPU and disk. Ordinary local and CI test
settings are unchanged.
The Mac supervisor caps each retained phase log at 8 MiB and stops the phase
if it exceeds that cap. It also gives image construction 30 minutes, the build
phase two hours, and isolated acceptance one hour. Release-phase containers
have a 1,024-PID limit and cannot swap beyond their 7 GiB memory cap. A timeout,
output overflow, or failed command leaves no signed release and removes its
active container.
The transport writer rejects compressed output before the 1 GiB archive bound
is crossed and removes a partial failed archive; it never signs truncated data.
Linux ARM64 postbuild excludes traced dependency packages whose declared
OS, CPU, or libc is incompatible with the server, plus aliases to those
packages, before hashing the runtime. The lockfile still retains optional
packages needed for other development platforms.

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
probe did succeed with `--privileged` inside the dedicated Colima VM with Docker
networking disabled and no host directories mounted. The release acceptance
phase now likewise has no host bind mount. Privilege remains inside the isolated
VM to support nested Bubblewrap; this is not proof against a VM escape and still
requires a reviewed release gate.
The existing non-release copied-runtime acceptance also passed for
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

## Protected server-operator handoff

The persistent pnpm, compiler, and toolchain caches exist only in the Mac's
Storage-backed Linux builder. They are never release assets or production
runtime dependencies. This source change does not request a new server cache,
container runtime, credential, port, database migration, or service limit.
Existing signed release assets and tags must remain unchanged.

Before considering a new efficiency-pilot release, obtain its exact clean
annotated tag and commit, six immutable signed assets, existing `jacob-m3`
public-key identity, reviewed public configuration and runtime-contract
digests, full acceptance receipts, and measured cold/warm build evidence for
the same source and configuration. The independent no-cache build must pass
the same tests and copied-runtime acceptance. Include archive and unpacked
sizes plus synthetic staging runtime-memory measurements; a cache hit alone
does not demonstrate a memory or size improvement. Keep raw phase logs and
metrics outside the six-asset transport bundle, and do not infer successful
CI or production activation from a local result.

For an accepted pilot, retain the current signed runtime and exact recovery
configuration. Independently verify the Git tag, source, signature, every
asset and payload hash, public configuration, platform/native bindings,
artifact contract, migrations and retained-runtime recovery before any
promotion. Use only the reviewed artifact-only adapter, with no production
compilation fallback. Rehearse missing or altered assets, failed readiness,
and actual rollback against the retained runtime and policy. Enable one
approved site scope first, observe its service and memory behavior, and only
then consider other isolated sites. A pending source candidate or an unsigned
benchmark is not permission to change the server's existing review hold.
