# Build-only package managers

The application uses pnpm12.18.0 on Node26.13.0. Build-time npm12.2.2 has
an independent locked graph here; the pnpm distribution has its independent
lock under `deploy/mac-build/pnpm-toolchain/`. Both graphs are excluded from
the application workspace and included in its full and production audit gates.

The pnpm graph approves only the reviewed `pnpm@12.18.0` installer under npm's
strict script policy. This replaces its shell-only placeholder with the native
binary for reliable direct subprocess execution on macOS and Linux.

The npm packaging derives from the reviewed `vitesse-nuxt-template` source
`202d096db86401d555985e638b83660df55b5da3`. `UPSTREAM.json` binds the official
archive and417 original CLI, documentation and license files. The reproducible
archive changes packaging declarations only, replacing vulnerable bundled
dependencies with the independently locked Glob14/Minimatch11 graph. Real
cancellation, pattern-bound, offline packing and locked-installation regressions
exercise the selected CLI and its actual dependencies.

`pnpm run check:toolchain-package` verifies the original upstream bytes.
`pnpm run test:build-toolchain` covers qualification, compatibility, tampering,
concurrent creation, failed/interrupted outcomes and the three-profile cache cap.
Every cache reuse verifies the full3020-file payload and performs fresh full,
production and registry signature audits. Unavailable audits remain failures.
The paired Node executable and any required macOS libnode copy are content-bound;
substituted executables, libraries, command links and extra code fail closed.

Local caches belong under the repository's ignored `.ai-work/` area or the
explicit Storage-backed `NPM_CONFIG_CACHE`. CI uses disposable runner storage.
The Linux builder admits only named toolchain inputs, verifies both installed
graphs and replaces the bootstrap npm before accepting its pinned commands.
Build tools remain separate from the deployed application's runtime inventory.
