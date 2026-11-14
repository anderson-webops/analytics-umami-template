# Build-only package managers

The application uses pnpm12.18.0 on Node26.13.1. Build-time npm12.2.2 has
an independent locked graph here; the pnpm distribution has its independent
lock under `deploy/mac-build/pnpm-toolchain/`. Both graphs are excluded from
the application workspace and included in its full and production audit gates.

The pnpm graph approves only the reviewed `pnpm@12.18.0` installer under npm's
strict script policy. This replaces its shell-only placeholder with the native
binary for reliable direct subprocess execution on macOS and Linux.

The npm packaging derives from the reviewed `vitesse-nuxt-template` source
`5d27a700fca7e36eb8a7f2f728ddd028cbd57000`. `UPSTREAM.json` binds the official
archive and417 original CLI, documentation and license files. The reproducible
npm archive changes packaging declarations only. The independent lock selects
reviewed modern library majors, including Glob14, Minimatch11 and Minipass7.
Three compatibility archives retain the modern libraries' implementation,
exports, types and licenses while adding reviewed callable CommonJS bridges.
Original registry archives and their integrity records remain under `compat/`.
Its minimum Node26.13.0 records the original input qualification; application,
CI and toolchain execution require the selected Node26.13.1 runtime.

Compatibility inputs retain their exact reviewed bytes for reproducible archive
generation and shared payload verification. Their scoped Biome override preserves
formatting and type-import ordering; lint and required archive, integrity and
regression checks remain enabled. The package graphs retain separate lockfiles
and audit coverage.

`pnpm run check:toolchain-package` verifies the original upstream bytes.
`pnpm run test:build-toolchain` covers qualification, all13 modern-library
contracts, TypeScript declarations, compatibility-archive reproduction,
tampering, concurrent creation, failed/interrupted outcomes and the three-profile
cache cap. Every cache reuse verifies the full3035-file payload and performs
fresh full, production and registry signature audits, including the original
compatibility-input graph. Unavailable audits remain failures.
The paired Node executable and any required macOS libnode copy are content-bound;
substituted executables, libraries, command links and extra code fail closed.

Local caches belong under the repository's ignored `.ai-work/` area or the
explicit Storage-backed `NPM_CONFIG_CACHE`. CI uses disposable runner storage.
The Linux builder admits only named toolchain inputs, verifies both installed
graphs and replaces the bootstrap npm before accepting its pinned commands.
Build tools remain separate from the deployed application's runtime inventory.
