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
  -o "-h 127.0.0.1 -p $port -c unix_socket_directories='' -c shared_buffers=32MB -c max_connections=30 -c TimeZone=America/New_York" start >/dev/null
export PATH="$pg_bin:$PATH"
export DATABASE_URL="postgresql://restore_test:synthetic-restore-password-000000@127.0.0.1:$port/postgres"
export DATABASE_REPLICA_URL= DIRECT_DATABASE_URL= REDIS_URL= CLICKHOUSE_URL= KAFKA_URL=
export KAFKA_BROKER=''
export LOGIN_RATE_LIMIT_ACCOUNT_FAILURES=10 LOGIN_RATE_LIMIT_WINDOW_SECONDS=900
run_collector_values() {
  POSTGRES_EVENT_SERIES_TEST_URL="$DATABASE_URL" pnpm exec vitest run \
    src/queries/sql/getValues.postgres.test.ts --maxWorkers=1
}
run_funnel_event_types() {
  "$pg_bin/createdb" -h 127.0.0.1 -p "$port" -U restore_test umami_funnel_test
  local funnel_url="postgresql://restore_test:synthetic-restore-password-000000@127.0.0.1:$port/umami_funnel_test"
  DATABASE_URL="$funnel_url" POSTGRES_FUNNEL_TEST_URL="$funnel_url" DOTENV_CONFIG_PATH=/dev/null \
    pnpm exec vitest run src/queries/sql/funnels/getFunnel.postgres.test.ts --maxWorkers=1
}
run_two_factor_state_races() {
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 \
    APP_SECRET=synthetic-factor-race-secret-000000000000000000 \
    TWO_FACTOR_ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" \
    PUBLIC_URL=https://analytics.example.com \
    DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-two-factor-state-races.ts
}
run_login_recovery() {
  "$pg_bin/createdb" -h 127.0.0.1 -p "$port" -U restore_test umami_login_recovery_test
  local recovery_url="postgresql://restore_test:synthetic-restore-password-000000@127.0.0.1:$port/umami_login_recovery_test"
  DATABASE_URL="$recovery_url" DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node scripts/check-db.js --migrate-only
  DATABASE_URL="$recovery_url" APP_SECRET=synthetic-login-recovery-secret-0000000000000000 \
    ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-login-recovery-postgres.ts
}
if [[ "${1:-}" == --two-factor-state-races ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  run_two_factor_state_races
  exit 0
fi
if [[ "${1:-}" == --two-factor-redis-races ]]; then
  : "${REDIS_TEST_URL:?A disposable loopback Redis URL is required}"
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 \
    APP_SECRET=synthetic-factor-race-secret-000000000000000000 \
    TWO_FACTOR_ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" \
    PUBLIC_URL=https://analytics.example.com \
    DOTENV_CONFIG_PATH=/dev/null REDIS_URL="$REDIS_TEST_URL" CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-two-factor-redis-races.ts
  exit 0
fi
if [[ "${1:-}" == --team-join-role ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-team-join-role.ts
  exit 0
fi
if [[ "${1:-}" == --team-join-mfa-race ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 \
    APP_SECRET=synthetic-team-join-mfa-secret-0000000000000000 \
    DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-team-join-mfa-race.ts
  exit 0
fi
if [[ "${1:-}" == --role-revocation ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-role-revocation-race.ts
  exit 0
fi
if [[ "${1:-}" == --replay-retention ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-replay-retention.ts
  exit 0
fi
if [[ "${1:-}" == --recorder-budget-retention ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-recorder-budget-retention.ts
  exit 0
fi
if [[ "${1:-}" == --replay-fragment-transaction ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-replay-fragment-transaction.ts
  exit 0
fi
if [[ "${1:-}" == --login-admission ]]; then
  "$pg_bin/psql" -h 127.0.0.1 -p "$port" -U restore_test -d postgres \
    -v ON_ERROR_STOP=1 -c 'CREATE TABLE "app_setting" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)' \
    >/dev/null
  APP_SECRET=synthetic-login-admission-secret-0000000000000000 \
    ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-login-account-admission.ts
  exit 0
fi
if [[ "${1:-}" == --login-recovery ]]; then
  DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' node scripts/check-db.js --migrate-only
  APP_SECRET=synthetic-login-recovery-secret-0000000000000000 \
    ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --conditions=react-server --import tsx scripts/test-login-recovery-postgres.ts
  exit 0
fi
if [[ "${1:-}" == --session-data-bulk ]]; then
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-session-data-bulk.ts
  exit 0
fi
if [[ "${1:-}" == --collection-budget ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null \
    CLICKHOUSE_HISTORY_ATTESTED_CLEAN=true KAFKA_HISTORY_ATTESTED_CLEAN=true \
    node --import tsx scripts/test-collection-budget.ts
  exit 0
fi
if [[ "${1:-}" == --collection-generation-lifecycle ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null CLOUD_MODE='' \
    CLICKHOUSE_HISTORY_ATTESTED_CLEAN=true KAFKA_HISTORY_ATTESTED_CLEAN=true \
    node --import tsx scripts/test-collection-generation-lifecycle.ts
  exit 0
fi
if [[ "${1:-}" == --revenue-sessions ]]; then
  "$pg_bin/createdb" -h 127.0.0.1 -p "$port" -U restore_test umami_revenue_test
  export DATABASE_URL="postgresql://restore_test:synthetic-restore-password-000000@127.0.0.1:$port/umami_revenue_test"
  POSTGRES_REVENUE_TEST_URL="$DATABASE_URL" DOTENV_CONFIG_PATH=/dev/null \
    pnpm exec vitest run src/queries/sql/revenue/getRevenueSessions.postgres.test.ts --maxWorkers=1
  exit 0
fi
if [[ "${1:-}" == --funnel-event-types ]]; then
  run_funnel_event_types
  exit 0
fi
if [[ "${1:-}" == --attested-revenue-ledger ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  "$pg_bin/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f scripts/test-attested-revenue-ledger.sql
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
    node --import tsx scripts/test-attested-revenue-intake.ts
  exit 0
fi
if [[ "${1:-}" == --collector-values ]]; then
  run_collector_values
  exit 0
fi
if [[ "${1:-}" == --collection-rate-limit ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null \
    node --import tsx scripts/test-collection-rate-limit.ts
  exit 0
fi
if [[ "${1:-}" == --session-link-admission ]]; then
  DOTENV_CONFIG_PATH=/dev/null pnpm run db:migrate
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null \
    node --import tsx scripts/test-session-link-admission.ts
  exit 0
fi
if [[ "${1:-}" == --session-link-cross-store ]]; then
  if [[ -z "${CLICKHOUSE_TEST_URL:-}" ]]; then
    echo 'CLICKHOUSE_TEST_URL is required for cross-store testing.' >&2
    exit 1
  fi
  export CLICKHOUSE_URL="$CLICKHOUSE_TEST_URL"
  "$pg_bin/psql" -h 127.0.0.1 -p "$port" -U restore_test -d postgres \
    -v ON_ERROR_STOP=1 -f prisma/migrations/21_add_session_link/migration.sql >/dev/null
  "$pg_bin/psql" -h 127.0.0.1 -p "$port" -U restore_test -d postgres \
    -v ON_ERROR_STOP=1 -f prisma/migrations/38_add_session_link_trust_tier/migration.sql >/dev/null
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null \
    node --import tsx scripts/test-session-link-cross-store.ts
  exit 0
fi
run_collector_values
run_funnel_event_types
run_login_recovery
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node scripts/test-postgres-restore.mjs "$@"
pnpm run db:migrate
"$pg_bin/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f scripts/test-attested-revenue-ledger.sql
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
  node --import tsx scripts/test-attested-revenue-intake.ts
run_two_factor_state_races
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
  node --conditions=react-server --import tsx scripts/test-team-join-role.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 \
  APP_SECRET=synthetic-team-join-mfa-secret-0000000000000000 \
  DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
  node --conditions=react-server --import tsx scripts/test-team-join-mfa-race.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
  node --conditions=react-server --import tsx scripts/test-role-revocation-race.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-session-data-bulk.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null \
  node --import tsx scripts/test-session-link-admission.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-heatmap-budget.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-replay-retention.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-recorder-budget-retention.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null REDIS_URL='' CLOUD_MODE='' \
  node --conditions=react-server --import tsx scripts/test-replay-fragment-transaction.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm run test:collection-rate-limit
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 \
  CLICKHOUSE_HISTORY_ATTESTED_CLEAN=true KAFKA_HISTORY_ATTESTED_CLEAN=true \
  node --import tsx scripts/test-collection-budget.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 DOTENV_CONFIG_PATH=/dev/null CLOUD_MODE='' \
  CLICKHOUSE_HISTORY_ATTESTED_CLEAN=true KAFKA_HISTORY_ATTESTED_CLEAN=true \
  node --import tsx scripts/test-collection-generation-lifecycle.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm exec tsx scripts/test-two-factor-admission.ts
ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 pnpm exec tsx scripts/test-password-verification-admission.ts
APP_SECRET=synthetic-login-admission-secret-0000000000000000 \
  ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts/test-login-account-admission.ts
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
