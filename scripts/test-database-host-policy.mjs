import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPrivateDatabaseHost } from './database-host-policy.mjs';
import { assertDatabaseTransport, DatabaseTransportError } from './database-transport.mjs';

test('recognizes only explicit local database aliases', () => {
  for (const hostname of ['localhost', 'db', 'postgres', 'host.docker.internal', 'DB']) {
    assert.equal(isPrivateDatabaseHost(hostname), true, hostname);
  }
});

test('does not exempt arbitrary single-label or public hostnames from TLS', () => {
  for (const hostname of [
    'db-host',
    'database',
    'metadata',
    'db.example.com',
    '8.8.8.8',
    '[::ffff:8.8.8.8]',
  ]) {
    assert.equal(isPrivateDatabaseHost(hostname), false, hostname);
  }
});

test('recognizes loopback and private IP literals', () => {
  for (const hostname of [
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.4',
    '[::1]',
    'fd00::1',
    '[::ffff:127.0.0.1]',
  ]) {
    assert.equal(isPrivateDatabaseHost(hostname), true, hostname);
  }
});

test('production environment validation requires TLS for an arbitrary single-label database host', () => {
  const validationScript = fileURLToPath(new URL('./check-env.js', import.meta.url));
  const baseEnvironment = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    DOTENV_CONFIG_PATH: '/dev/null',
    NODE_ENV: 'production',
    APP_SECRET: 'synthetic-app-secret-11111111111111111',
    PUBLIC_URL: 'https://analytics.example',
    CLIENT_IP_HEADER: 'X-Forwarded-For',
  };

  for (const [hostname, suffix, expectedStatus] of [
    ['database', '', 1],
    ['database', '?sslmode=require', 1],
    ['database', '?sslmode=verify-full', 0],
    ['localhost', '', 0],
  ]) {
    const result = spawnSync(process.execPath, [validationScript], {
      env: {
        ...baseEnvironment,
        DATABASE_URL: `postgresql://synthetic:synthetic-password-0000000000000000@${hostname}:5432/synthetic${suffix}`,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, expectedStatus, `${hostname}${suffix}: ${result.stderr}`);
    if (expectedStatus !== 0) {
      assert.match(
        result.stderr,
        /DATABASE_URL targets a non-private host and must use sslmode=verify-full/,
      );
    }
  }
});

test('production validates service transport for dotless and public IPv6 hosts', () => {
  const validationScript = fileURLToPath(new URL('./check-env.js', import.meta.url));
  const baseEnvironment = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    DOTENV_CONFIG_PATH: '/dev/null',
    NODE_ENV: 'production',
    APP_SECRET: 'synthetic-app-secret-11111111111111111',
    PUBLIC_URL: 'https://analytics.example',
    CLIENT_IP_HEADER: 'X-Forwarded-For',
    DATABASE_URL:
      'postgresql://synthetic:synthetic-password-0000000000000000@localhost:5432/synthetic',
  };

  for (const { name, settings, expectedStatus, error } of [
    { name: 'secure Redis', settings: { REDIS_URL: 'rediss://database:6379' }, expectedStatus: 0 },
    {
      name: 'insecure Redis',
      settings: { REDIS_URL: 'redis://database:6379' },
      expectedStatus: 1,
      error: /REDIS_URL must use an encrypted protocol/,
    },
    {
      name: 'insecure public IPv6 ClickHouse',
      settings: { CLICKHOUSE_URL: 'http://[2606:4700:4700::1111]:8123' },
      expectedStatus: 1,
      error: /CLICKHOUSE_URL must use an encrypted protocol/,
    },
    {
      name: 'private IPv6 ClickHouse',
      settings: { CLICKHOUSE_URL: 'http://[fd00::1]:8123' },
      expectedStatus: 0,
    },
    {
      name: 'secure Kafka',
      settings: { KAFKA_URL: 'kafkas://broker', KAFKA_BROKER: 'database:9092' },
      expectedStatus: 0,
    },
    {
      name: 'secure public IPv6 Kafka',
      settings: { KAFKA_URL: 'kafkas://broker', KAFKA_BROKER: '[2606:4700:4700::1111]:9092' },
      expectedStatus: 0,
    },
    {
      name: 'insecure Kafka',
      settings: { KAFKA_URL: 'kafka://broker', KAFKA_BROKER: 'database:9092' },
      expectedStatus: 1,
      error: /KAFKA_SSL must be enabled when a Kafka broker is outside a private network/,
    },
    {
      name: 'insecure public IPv6 Kafka',
      settings: { KAFKA_URL: 'kafka://broker', KAFKA_BROKER: '[2606:4700:4700::1111]:9092' },
      expectedStatus: 1,
      error: /KAFKA_SSL must be enabled when a Kafka broker is outside a private network/,
    },
    {
      name: 'private IPv6 Kafka',
      settings: { KAFKA_URL: 'kafka://broker', KAFKA_BROKER: '[fd00::1]:9092' },
      expectedStatus: 0,
    },
    {
      name: 'Kafka broker with a path',
      settings: { KAFKA_URL: 'kafkas://broker', KAFKA_BROKER: 'database:9092/other' },
      expectedStatus: 1,
      error: /KAFKA_BROKER must be a comma-separated list of host:port entries/,
    },
    {
      name: 'Kafka broker with a trailing slash',
      settings: { KAFKA_URL: 'kafkas://broker', KAFKA_BROKER: 'database:9092/' },
      expectedStatus: 1,
      error: /KAFKA_BROKER must be a comma-separated list of host:port entries/,
    },
    {
      name: 'Kafka broker with a query',
      settings: { KAFKA_URL: 'kafkas://broker', KAFKA_BROKER: 'database:9092?host=localhost' },
      expectedStatus: 1,
      error: /KAFKA_BROKER must be a comma-separated list of host:port entries/,
    },
  ]) {
    const result = spawnSync(process.execPath, [validationScript], {
      env: { ...baseEnvironment, ...settings },
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, expectedStatus, `${name}: ${result.stderr}`);
    if (error) {
      assert.match(result.stderr, error, name);
    }
    assert.doesNotMatch(result.stderr, /ReferenceError|must be a valid absolute/);
  }
});

test('rejects query overrides and ambiguous TLS settings before connecting', () => {
  const base = 'postgresql://synthetic:synthetic-password@database:5432/synthetic';

  for (const suffix of [
    '?sslmode=verify-full&sslmode=disable',
    '?sslmode=verify-full&ssl=no-verify',
    '?sslmode=require&uselibpqcompat=true',
    '?sslmode=verify-full&host=localhost',
    '?sslmode=verify-full&hostaddr=127.0.0.1',
    '?sslmode=verify-full&port=5433',
  ]) {
    assert.throws(
      () =>
        assertDatabaseTransport('DATABASE_URL', `${base}${suffix}`, {
          requireVerifiedTlsForPublicHost: true,
        }),
      DatabaseTransportError,
      suffix,
    );
  }

  assert.throws(
    () =>
      assertDatabaseTransport(
        'DATABASE_URL',
        `${base.replace('database', 'localhost')}?host=database`,
      ),
    DatabaseTransportError,
  );
  assert.doesNotThrow(() =>
    assertDatabaseTransport('DATABASE_URL', `${base}?sslmode=verify-full`, {
      requireVerifiedTlsForPublicHost: true,
    }),
  );
  assert.doesNotThrow(() =>
    assertDatabaseTransport('DATABASE_URL', base.replace('database', 'localhost'), {
      requireVerifiedTlsForPublicHost: true,
    }),
  );
});

test('production environment validation rejects insecure direct and replica URLs', () => {
  const validationScript = fileURLToPath(new URL('./check-env.js', import.meta.url));
  const safeUrl =
    'postgresql://synthetic:synthetic-password-0000000000000000@localhost:5432/synthetic';
  const unsafeUrl =
    'postgresql://synthetic:synthetic-password-0000000000000000@database:5432/synthetic?sslmode=verify-full&sslmode=disable';

  for (const name of ['DIRECT_DATABASE_URL', 'DATABASE_REPLICA_URL']) {
    const result = spawnSync(process.execPath, [validationScript], {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        DOTENV_CONFIG_PATH: '/dev/null',
        NODE_ENV: 'production',
        APP_SECRET: 'synthetic-app-secret-11111111111111111',
        PUBLIC_URL: 'https://analytics.example',
        CLIENT_IP_HEADER: 'X-Forwarded-For',
        DATABASE_URL: safeUrl,
        [name]: unsafeUrl,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(`${name} must not override or repeat PostgreSQL connection settings`),
    );
  }
});

test('guarded migration and startup paths reject unsafe database transport before connection', () => {
  const validationScript = fileURLToPath(new URL('./check-db.js', import.meta.url));
  const safeUrl =
    'postgresql://synthetic:synthetic-password-0000000000000000@localhost:5432/synthetic';
  const publicUrl =
    'postgresql://synthetic:synthetic-password-0000000000000000@database:5432/synthetic';

  for (const [name, url, expectedMessage, extraEnvironment] of [
    [
      'DATABASE_URL',
      `${publicUrl}?sslmode=verify-full&sslmode=disable`,
      /DATABASE_URL must not override or repeat PostgreSQL connection settings/,
      {},
    ],
    [
      'DATABASE_URL',
      `${publicUrl}?sslmode=require`,
      /DATABASE_URL targets a non-private host and must use sslmode=verify-full/,
      {},
    ],
    [
      'DATABASE_URL',
      `${publicUrl}?sslmode=verify-full`,
      /DATABASE_URL targets a non-private host and must use sslmode=verify-full/,
      { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    ],
    [
      'DIRECT_DATABASE_URL',
      `${publicUrl}?sslmode=verify-full&host=localhost`,
      /DIRECT_DATABASE_URL must not override or repeat PostgreSQL connection settings/,
      {},
    ],
  ]) {
    for (const mode of ['--migrate-only', '--verify-only']) {
      const result = spawnSync(process.execPath, [validationScript, mode], {
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          DOTENV_CONFIG_PATH: '/dev/null',
          NODE_ENV: 'production',
          DATABASE_URL: name === 'DATABASE_URL' ? url : safeUrl,
          ...(name === 'DIRECT_DATABASE_URL' ? { DIRECT_DATABASE_URL: url } : {}),
          ...extraEnvironment,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });

      const output = `${result.stdout}${result.stderr}`;

      assert.equal(result.status, 1, `${name} ${mode}: ${output}`);
      assert.match(output, expectedMessage);
      assert.doesNotMatch(result.stdout, /Database connection successful|Database is up to date/);
    }
  }
});
