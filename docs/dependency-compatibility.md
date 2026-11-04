# Dependency compatibility

## Development launcher

Dotenv 18 provides its own `dotenv run` executable. Development uses its explicit
`run --quiet --` command boundary, and the competing `dotenv-cli` dependency is
removed. The launcher regression exercises literal arguments, environment-file
loading, existing-value precedence and child failure propagation. Production
startup retains its independent environment and immutable-runtime validation.

## TypeScript

Application, tracker and maintained workspace type checks use TypeScript 7.0.2
through `scripts/typecheck.mjs`. Its regression includes a valid compilation and
a real type error that must fail.

The separate `typescript` 5.9.3 dependency supplies the JavaScript compiler API
used by source analysis, OpenAPI generation, Next's build integration and
declaration bundlers. TypeScript 7's main export does not provide
`createSourceFile`, `createProgram` or `transpileModule`, and
`openapi-typescript` 7.13.0 explicitly requires a TypeScript 5 peer. Retaining
that API implementation does not replace the native TypeScript 7 source checks.
Migrate those consumers when they support the new stable API; retain strict peer
verification rather than overriding an incompatible requirement.

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
