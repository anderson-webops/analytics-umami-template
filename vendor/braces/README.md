# Guarded braces fork

This local package is based on upstream `braces@3.0.3` (MIT; see `LICENSE`). It exists because upstream has not published a patched release for [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

The fork limits structural nesting in the parser and checks directly supplied ASTs before the recursive compile, expand, and stringify walkers. The root pnpm override makes transitive `micromatch` consumers use this fork. `scripts/test-braces-compat.mjs` checks the installed resolution, reported exhaustion patterns, direct AST entry points, and ordinary expansion behavior.

Explicit brace expansion is limited to 10,000 aggregate results per call, including calls with multiple input patterns. Compile mode is unaffected. Callers that need a larger result set should avoid materializing it through this parser.

Replace this fork only after upstream publishes a verified fix and the same compatibility and audit checks pass against it.
