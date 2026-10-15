#!/usr/bin/env bash
set -euo pipefail

phase="${1:?Expected build or accept phase}"
source_root=/work/source
pg_bin=/usr/lib/postgresql/17/bin
pg_data=/work/postgres-data
pg_socket=/work/postgres-socket
export PG17_BINDIR="$pg_bin"
export HOME=/work/home
export TMPDIR=/work/tmp
export NODE_OPTIONS=--max-old-space-size=2304
export DATABASE_URL='postgresql://umami:mac-release-test-password-0000000000000000@127.0.0.1:5432/umami?schema=public'
export RUNTIME_ACCEPTANCE_DATABASE_URL="$DATABASE_URL"
export APP_SECRET='synthetic-artifact-acceptance-only-000000000000'
export UMAMI_BIND_ADDRESS=127.0.0.1
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0="$source_root"

cd "$source_root"
test "$(uname -m)" = aarch64
test "$(node --version)" = v24.18.1
test "$(npm --version)" = 12.0.2
test "$(pnpm --version)" = 11.18.0
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
test "$(git cat-file -t "refs/tags/$RELEASE_TAG")" = tag
test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$RELEASE_COMMIT"
test -z "$(git status --porcelain)"
test "$(node -p 'require("./package.json").version')" = "${RELEASE_TAG#v}"

as_builder() {
  if [[ "$(id -u)" = 0 ]]; then
    setpriv --reuid 501 --regid 20 --clear-groups -- "$@"
  else
    "$@"
  fi
}

stop_database() {
  if [[ -f "$pg_data/postmaster.pid" ]]; then
    as_builder "$pg_bin/pg_ctl" -D "$pg_data" -m fast stop >/dev/null || true
  fi
}

start_database() {
  mkdir -p "$pg_data" "$pg_socket"
  if [[ "$(id -u)" = 0 ]]; then
    chown 501:20 "$pg_data" "$pg_socket"
  fi
  if [[ ! -s "$pg_data/PG_VERSION" ]]; then
    as_builder "$pg_bin/initdb" -D "$pg_data" -U umami -A trust --no-instructions >/dev/null
  fi
  as_builder "$pg_bin/pg_ctl" -D "$pg_data" \
    -o "-h 127.0.0.1 -p 5432 -k $pg_socket" -w start >/dev/null
  trap stop_database EXIT
  if ! "$pg_bin/psql" -h 127.0.0.1 -p 5432 -U umami -d postgres -Atqc \
    "SELECT 1 FROM pg_database WHERE datname = 'umami'" | grep -qx 1; then
    as_builder "$pg_bin/createdb" -h 127.0.0.1 -p 5432 -U umami umami
  fi
}

verify_package_signatures() {
  local attempt output
  output="$TMPDIR/package-signatures.log"
  for attempt in 1 2 3; do
    if pnpm audit signatures >"$output" 2>&1; then
      cat "$output"
      return 0
    fi
    cat "$output" >&2
    if ! grep -Eq 'The operation was aborted due to timeout|ERR_PNPM_FETCH|ETIMEDOUT|ECONNRESET|EAI_AGAIN' "$output"; then
      return 1
    fi
    if [[ "$attempt" -lt 3 ]]; then
      sleep "$((attempt * 5))"
    fi
  done
  return 1
}

if [[ "$phase" = build ]]; then
  test "$(id -u)" = 501
  pnpm install --frozen-lockfile --prefer-offline --config.store-dir=/pnpm-store
  verify_package_signatures
  pnpm run audit:all
  pnpm run audit:prod
  start_database
  pnpm run build:db
  pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm run test:migration-bridge
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm run test:migration-attempts
  UMAMI_USERNAME=admin UMAMI_PASSWORD=synthetic-admin-only-000000000000 \
    pnpm run change-password
  pnpm run test:postgres17-restore
  env -u CLASSROOM_MODE -u CLIENT_IP_HEADER -u DISABLE_TELEMETRY \
    -u MCP_ENABLED -u NEXT_TELEMETRY_DISABLED -u PRIVATE_MODE -u PUBLIC_URL \
    DATABASE_URL=postgresql://user:pass@localhost:5432/dummy SKIP_DB_CHECK=1 \
    bash -c '
      set -euo pipefail
    ANALYTICS_RELEASE_SINGLE_WORKER=1 pnpm run validate
      pnpm run openapi:generate
      pnpm run openapi:check --explicit
      pnpm run check:api:client
      pnpm run build:packages
      pnpm run test:packages
    '
  pnpm run build:production
  pnpm run check:native-bindings
  node scripts/runtime-artifact.mjs verify .next/standalone --release \
    --expected-commit "$RELEASE_COMMIT" --expected-application "${RELEASE_REPOSITORY#*/}"
  test -z "$(git status --porcelain)"
elif [[ "$phase" = accept ]]; then
  test "$(id -u)" = 0
  export TMPDIR=/tmp
  test -f .next/standalone/runtime-manifest.json
  start_database
  as_builder pnpm run db:migrate
  as_builder env NODE_ENV=production pnpm run check:env
  as_builder env NODE_ENV=production pnpm run check:db
  mkdir -m 0755 /opt/anderson-sealed
  node scripts/runtime-artifact.mjs copy .next/standalone /opt/anderson-sealed/runtime \
    --release --expected-commit "$RELEASE_COMMIT" \
    --expected-application "${RELEASE_REPOSITORY#*/}"
  node scripts/runtime-artifact.mjs seal /opt/anderson-sealed/runtime \
    --release --expected-commit "$RELEASE_COMMIT" \
    --expected-application "${RELEASE_REPOSITORY#*/}"
  node scripts/runtime-artifact.mjs verify /opt/anderson-sealed/runtime \
    --release --expected-commit "$RELEASE_COMMIT" \
    --expected-application "${RELEASE_REPOSITORY#*/}"
  node scripts/test-runtime-artifact.mjs --release --require-isolation \
    --expected-commit "$RELEASE_COMMIT" \
    --source-runtime /opt/anderson-sealed/runtime
  node --input-type=module -e '
    import fs from "node:fs";
    const receipt = {
      commit: process.env.RELEASE_COMMIT,
      tag: process.env.RELEASE_TAG,
      checks: {
        tests: true,
        dependency_audit: true,
        package_signatures: true,
        native_bindings: true,
      },
    };
    fs.writeFileSync("/work/acceptance-receipt.json", `${JSON.stringify(receipt)}\n`, {
      flag: "wx", mode: 0o600,
    });
  '
  node scripts/mac-artifact-transport.mjs prepare \
    --runtime /opt/anderson-sealed/runtime \
    --config "$RELEASE_CONFIG" \
    --receipt /work/acceptance-receipt.json \
    --output "$RELEASE_OUTPUT" \
    --builder-id "$RELEASE_BUILDER_ID" \
    --tag "$RELEASE_TAG"
  test -z "$(git status --porcelain)"
else
  printf 'Unknown builder phase: %s\n' "$phase" >&2
  exit 64
fi
