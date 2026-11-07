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

## Zen motion and primitives

The exact `@umami/react-zen@0.255.0>@react-spring/web` selection uses React
Spring 10.1.2. Its published parent still names 9.7.5, whose declared peers
exclude React 19. [React Spring 10](https://github.com/pmndrs/react-spring/releases/tag/v10.0.0)
supports React 19 directly, so the five older React peer overrides are removed.
The complete animation family stays on 10.1.2. Zen consumes `animated` and
`useTransition` for its theme control and notifications.

Base UI 1.9.0 is selected through Zen's existing supported `^1.8.0` range,
without an additional override. The root workspace lock also refreshes compatible
transitive packages through the existing declared ranges and supply-chain policy.
Independent build-tool locks and the selected Node/npm/pnpm pins remain separate.

Component regressions check parent-local resolution, native React 19 peers,
the animation family, both module formats and server-rendered controls. Keep
real-browser theme/notification lifecycles, accessible primitive interactions,
strict peers, complete audits and project checks in the upgrade acceptance.
Review the version-bound selection when updating Zen.

## Zen icons

The exact `@umami/react-zen@0.255.0>lucide-react` selection uses Lucide 1.70.0,
matching the application's direct dependency. Zen's published dependency still
names 0.555.0. Its sixteen consumed icon names remain available on the current
major; the removed brand icons are neither consumed nor publicly re-exported.

`test:component-dependencies` checks both published module formats, every Lucide
namespace use, the unchanged 316 public exports and declarations, all consumed
SVGs, accessibility, wrapper sizes, browser refs and click handling. Negative
cases reject dynamic namespace access, namespace escape and public re-export.
The selection is limited to the reviewed parent version. Review or remove it
when updating Zen; keep strict peer, audit, complete source and build checks.

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
