# Exact-artifact integration fixtures

`scripts/test-artifact-integration.mjs` tests the unchanged NP, Marietta and
RetroZetro `v4.2.188` bundles. The fixture profiles independently pin each
commit, signed manifest, runtime archive and native contract. Signature checking
uses the established Ed25519 builder public-key fingerprint. No signing key is
needed. Input verification checks all six assets, the complete archive/native
inventory and required compiled entrypoints before candidate code executes.

The two modes have distinct receipts:

- `verify` performs read-only bundle verification on any supported workstation.
  Its `input-verification-only` result is not runtime acceptance.
- `run` additionally exercises the exact unpacked runtime in an offline Linux
  ARM64 fixture. Only a successful full run emits `synthetic-integration-passed`.

The runner accepts absolute `--assets`, `--public-key`, `--receipt` and `--site`
arguments. `run` additionally requires `--runtime`, `--work` and `--pg-bin`.
Receipts use exclusive creation; existing evidence remains intact.

## Isolation contract

Run with Node 24.18.1, a fresh private loopback-only network and PID namespace,
the harness as PID 1 under a non-root identity,
zero effective capabilities, no-new-privileges, and read-only root, fixture,
assets and runtime mounts. Supply only a supported PostgreSQL tool directory and
an empty writable private work directory. Mount the fixture modules plus their
two verifier dependencies, `scripts/mac-artifact-transport.mjs` and
`scripts/runtime-artifact.mjs`, rather than an application checkout. Keep host
homes, credentials, service environments, container sockets and development
dependencies outside the fixture. The harness checks these invariants before
initializing a fresh PostgreSQL cluster under its private scratch directory.

The harness constructs its own synthetic environment, accounts, keys and data.
It runs the packaged migration gate, starts the packaged server and production
dependencies, then verifies unchanged signed inventory after shutdown. The
original accepted assets are read-only inputs. No rebuild, repackaging or
production database connection is part of this workflow.

## Coverage and limits

These are implemented assertions, not an acceptance claim for a bundle. Full
runtime evidence requires its own successful `run` receipt.

- Valid anonymous and backend-authorized collection, denied scopes, cross-site
  keys, stale timestamps, nonce replay and event/session/identity trust tiers.
- Attested revenue creation, idempotence, conflicts, financial browser-claim
  rejection, owner/generation revocation and durable deletion tombstones.
- Independent missing-Kafka and missing-ClickHouse history holds preserve the
  synthetic rows before deletion. Positive deletion uses attestations scoped
  only to the harness's newly initialized, offline synthetic cluster. Production
  history still needs its independent host/owner review.
- Production-mode CAPTCHA handling and real password/MFA enrollment before
  authenticated event reporting and tenant-isolation checks.
- One-batch replay/bookmark/heatmap cleanup over a 401-row expired backlog,
  retry and idempotence, with exact future/unmarked row preservation and
  retained replay-budget ownership.

CAPTCHA uses an external fixture-only preload that intercepts only the exact
siteverify transport. It supplies single-use success, invalid action/host,
invalid token and unavailable-provider responses. Application authentication,
SQL, authorization and signed runtime code remain real and unchanged. This is
synthetic provider integration, not Cloudflare connectivity or TLS acceptance.
Revenue assertions distinguish attested movement storage from legacy revenue
reporting; they do not claim complete financial-report acceptance.

Receipts contain stage names, counts, immutable identities and isolation scope,
not passwords, cookies, MFA secrets, recovery codes or provider credentials.
Temporary synthetic databases are stopped and removed after the run. Cleanup
failure retains private scratch and fails acceptance. A passing fixture does
not establish historical storage truth, real-owner possession, protected host
policy acceptance, production activation or external public acceptance.

Run the deterministic harness regressions with
`node --test scripts/artifact-integration/contract.test.mjs`. These regressions
are separate from running the three accepted Linux ARM64 artifacts.
