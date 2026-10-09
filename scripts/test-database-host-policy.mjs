import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPrivateDatabaseHost } from './database-host-policy.mjs';

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
    ['database', '?sslmode=require', 0],
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
      assert.match(result.stderr, /DATABASE_URL targets a non-private host and must require TLS/);
    }
  }
});
