import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repairStandaloneRuntime } from '../../../scripts/repair-standalone.js';
import fixtureAdmin from './fixture-admin.json' with { type: 'json' };

const root = path.resolve(import.meta.dirname, '../../..');
const fixtureIdentity = 'Requires the disposable API fixture environment.';

export function verifyFixtureEnvironment(environment) {
  assert.equal(environment.UMAMI_TEST_LOCAL_COMPOSE, '1', fixtureIdentity);
  assert.equal(environment.DATABASE_URL, 'postgresql://umami:umami@db:5432/umami', fixtureIdentity);
  assert.equal(
    environment.APP_SECRET,
    'umami-disposable-api-test-secret-00000000000000',
    fixtureIdentity,
  );
  assert.ok(!environment.NODE_ENV || environment.NODE_ENV === 'development', fixtureIdentity);
  assert.equal(environment.KAFKA_HISTORY_ATTESTED_CLEAN, 'true', fixtureIdentity);
  assert.equal(environment.CLICKHOUSE_HISTORY_ATTESTED_CLEAN, 'true', fixtureIdentity);
  for (const name of [
    'DIRECT_DATABASE_URL',
    'SKIP_DB_CHECK',
    'SKIP_DB_MIGRATION',
    'REDIS_URL',
    'KAFKA_URL',
    'KAFKA_BROKER',
    'KAFKA_BROKERS',
    'CLOUD_MODE',
    'CLOUD_URL',
  ]) {
    assert.ok(!environment[name], fixtureIdentity);
  }
  assert.ok(
    !environment.CLICKHOUSE_URL ||
      environment.CLICKHOUSE_URL === 'http://umami:umami@clickhouse:8123/umami',
    fixtureIdentity,
  );
}

async function runFixture() {
  assert.equal(process.argv.length, 2, fixtureIdentity);
  verifyFixtureEnvironment(process.env);
  const environment = {
    ...process.env,
    NODE_ENV: 'development',
    DOTENV_CONFIG_PATH: '/dev/null',
  };
  for (const [args, variables] of [
    [['scripts/check-env.js'], {}],
    [['scripts/check-db.js', '--migrate-only'], {}],
    [
      ['scripts/change-password.js'],
      { UMAMI_USERNAME: fixtureAdmin.username, UMAMI_PASSWORD: fixtureAdmin.password },
    ],
    [['scripts/check-db.js', '--verify-only'], {}],
  ]) {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env: { ...environment, ...variables },
      stdio: 'inherit',
      timeout: 120_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Disposable API fixture startup checks failed.');
  }
  process.chdir(root);
  const { appDir } = await repairStandaloneRuntime();
  assert.ok(appDir, 'The compiled disposable API fixture is missing.');
  process.chdir(appDir);
  process.execve(process.execPath, [process.execPath, path.join(appDir, 'server.js')], {
    ...environment,
    NODE_ENV: 'production',
    HOSTNAME: '0.0.0.0',
    PORT: '3000',
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runFixture();
}
