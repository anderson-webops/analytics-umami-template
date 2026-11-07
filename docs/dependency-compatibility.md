# Dependency compatibility

## Development launcher

Development preloads Dotenv 18 through Node's `--import dotenv/config` and runs
Next's declared CLI entrypoint directly. This preserves environment-file loading
without Dotenv's separately detached subprocess surviving browser-test teardown.
The competing `dotenv-cli` dependency is removed. Launcher regressions exercise
literal arguments, existing-value precedence, failure propagation and process
termination. Production startup retains its independent environment and
immutable-runtime validation.

## TypeScript

Application, tracker and maintained workspace type checks use TypeScript 7.0.2
through `scripts/typecheck.mjs`. Its regression includes a valid compilation and
a real type error that must fail.

The separate `typescript` 6.0.3 dependency supplies the JavaScript compiler API
used by source analysis, OpenAPI generation, Rollup, tsup and declaration
bundlers. Next.js resolves the same compatible compiler installation during its
build checks. The native TypeScript 7 checks remain unchanged.

The exact `openapi-typescript@7.13.0>typescript:peer` override backports the
`^5.x || ^6.x` range from upstream proposal
[2774](https://github.com/openapi-ts/openapi-typescript/pull/2774), reviewed at
`6a805ba5293b8f9ce390a3546d82ad9ec5996743`. Its published peer declaration still
names TypeScript 5; this locally qualified compatibility backport leaves all
other peer checks active. Remove it when a verified successor declares support.

Compiler-entrypoint tests verify consumer-local resolution, positive and negative
diagnostics for both compilers, tracker warning rejection, OpenAPI AST/printing
with nullable and union responses, and built workspace declarations through
their public exports. Full peer, generation/parity, declaration, build, audit and
project checks remain required. The proposal's separate helper-library changes
do not apply because that library is absent from this dependency graph.

## Avatars

DiceBear's collection, Lorelei style and initials packages remain on their
published 9.4.3 line. The Lorelei package requires `@dicebear/core` 9, while the
separately published core 10.7.0 has no matching published collection or Lorelei
release. Keep the supported matching family until a compatible style release or
an independently validated adapter is available.

## Maps

`react-simple-maps` 5 supports React 19 without the former React peer overrides.
Its `d3-zoom` 3 dependency accepts drag and transition versions 2 through 3.
Scoped selections of drag 3 and transition 3 keep that supported dependency graph
consistent with selection 3; no peer requirement is relaxed.
