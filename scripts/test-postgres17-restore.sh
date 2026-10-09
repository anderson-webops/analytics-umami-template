#!/usr/bin/env bash
set -euo pipefail
# Test-only: no production sockets, credentials, providers, or existing databases.
readonly pg_bin="${PG17_BINDIR:?Set PG17_BINDIR to the PostgreSQL 17 bin directory}"
"$pg_bin/postgres" --version | grep -Eq 'PostgreSQL\) 17\.'
mkdir -p .ai-work/runs
fixture="$(mktemp -d "$PWD/.ai-work/runs/postgres17.XXXXXX")"
cleanup() {
  "$pg_bin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf -- "$fixture"
}
trap cleanup EXIT
runtime=0
if [[ "${1:-}" == --runtime ]]; then runtime=1; shift; fi
build=0
if [[ "${1:-}" == --build ]]; then build=1; shift; fi
port="$(node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()});')"
"$pg_bin/initdb" -D "$fixture/data" -A trust -U restore_test --no-locale >"$fixture/init.log"
"$pg_bin/pg_ctl" -D "$fixture/data" -l "$fixture/postgres.log" \
  -o "-h 127.0.0.1 -p $port -c unix_socket_directories='' -c shared_buffers=32MB -c max_connections=30" start >/dev/null
export PATH="$pg_bin:$PATH"
export DATABASE_URL="postgresql://restore_test:synthetic-restore-password-000000@127.0.0.1:$port/postgres"
export DATABASE_REPLICA_URL= DIRECT_DATABASE_URL= REDIS_URL= CLICKHOUSE_URL= KAFKA_URL=
export LOGIN_RATE_LIMIT_ACCOUNT_FAILURES=10 LOGIN_RATE_LIMIT_WINDOW_SECONDS=900
if [[ "${1:-}" == --login-admission ]]; then
  "$pg_bin/psql" -h 127.0.0.1 -p "$port" -U restore_test -d postgres \
    -v ON_ERROR_STOP=1 -c 'CREATE TABLE "app_setting" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)' \
    >/dev/null
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm exec tsx scripts/test-login-account-admission.ts
  exit 0
fi
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node scripts/test-postgres-restore.mjs "$@"
pnpm run db:migrate
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-heatmap-budget.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-recorder-budget-retention.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-collection-budget.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm exec tsx scripts/test-two-factor-admission.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm exec tsx scripts/test-password-verification-admission.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm exec tsx scripts/test-login-account-admission.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 \
  APP_SECRET=synthetic-session-generation-secret-0000000000000000 \
  REDIS_URL= CLOUD_MODE= node --conditions=react-server --import tsx scripts/test-session-generation.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 \
  REDIS_URL= CLOUD_MODE= node --conditions=react-server --import tsx scripts/test-admin-mfa-policy-race.ts
if [[ "$build" == 1 ]]; then
  UMAMI_USERNAME=admin UMAMI_PASSWORD=synthetic-build-admin-password-0000000000 \
    pnpm run change-password
  DOTENV_CONFIG_PATH=/dev/null NODE_ENV=production DATABASE_TYPE=postgresql \
    APP_SECRET=synthetic-session-generation-secret-0000000000000000 \
    PUBLIC_URL=https://analytics.example.com CLIENT_IP_HEADER=x-real-ip \
    NEXT_TELEMETRY_DISABLED=1 DISABLE_TELEMETRY=1 MCP_ENABLED=0 \
    REDIS_URL= CLOUD_MODE= pnpm run build
  node scripts/runtime-artifact.mjs verify .next/standalone
fi
if [[ "$runtime" == 1 ]]; then
  # The caller runs this unchanged workspace inside its private network unit.
  # No installed pnpm workspace is copied to a different path.
  UMAMI_USERNAME=admin UMAMI_PASSWORD=restore-runtime-admin-000000000000 pnpm run change-password
  RUNTIME_ACCEPTANCE_DATABASE_URL="$DATABASE_URL" \
    node scripts/test-runtime-artifact.mjs --release --require-isolation \
    --expected-commit "$(git rev-parse HEAD)"
fi
