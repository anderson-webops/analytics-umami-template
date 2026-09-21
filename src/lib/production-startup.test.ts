import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

describe('direct production startup', () => {
  test('refuses to skip migrations in production', () => {
    const result = spawnSync(process.execPath, ['scripts/check-env.js'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        NODE_ENV: 'production',
        APP_SECRET: 'a'.repeat(32),
        DATABASE_URL: `postgresql://umami:${'b'.repeat(32)}@localhost:5432/umami`,
        PUBLIC_URL: 'https://analytics.example.com',
        CLIENT_IP_HEADER: 'x-real-ip',
        SKIP_DB_MIGRATION: 'true',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SKIP_DB_MIGRATION is not permitted in production.');
  });

  test('refuses a public production listener', () => {
    const result = spawnSync(process.execPath, ['scripts/check-env.js'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        NODE_ENV: 'production',
        APP_SECRET: 'a'.repeat(32),
        DATABASE_URL: `postgresql://umami:${'b'.repeat(32)}@localhost:5432/umami`,
        PUBLIC_URL: 'https://analytics.example.com',
        CLIENT_IP_HEADER: 'x-real-ip',
        UMAMI_BIND_ADDRESS: '0.0.0.0',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UMAMI_BIND_ADDRESS must be a loopback address in production.');
  });

  test.each([
    [
      'KAFKA_SSL_ALLOW_UNAUTHORIZED',
      'true',
      'KAFKA_SSL_ALLOW_UNAUTHORIZED must not be enabled in production.',
    ],
    [
      'NODE_TLS_REJECT_UNAUTHORIZED',
      '0',
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is not permitted in production.',
    ],
  ])('refuses the insecure production TLS override %s', (name, value, message) => {
    const result = spawnSync(process.execPath, ['scripts/check-env.js'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        NODE_ENV: 'production',
        APP_SECRET: 'a'.repeat(32),
        DATABASE_URL: `postgresql://umami:${'b'.repeat(32)}@localhost:5432/umami`,
        PUBLIC_URL: 'https://analytics.example.com',
        CLIENT_IP_HEADER: 'x-real-ip',
        [name]: value,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  test('uses the hardened system service instead of a production container', () => {
    const packageJson = JSON.parse(read('package.json'));
    const databaseCheckSource = read('scripts/check-db.js');
    const startupSource = read('scripts/start-production.js');
    const systemdUnit = read('deploy/systemd/umami@.service');

    expect(packageJson.scripts['build:production']).toContain('postbuild');
    expect(packageJson.scripts['start:production']).toBe('node scripts/start-production.js');
    expect(packageJson.scripts['build-docker']).toBeUndefined();
    expect(packageJson.scripts['start-docker']).toBeUndefined();
    expect(startupSource).toMatch(/'scripts\/check-env\.js'[\s\S]+'scripts\/check-db\.js'/);
    expect(startupSource).not.toContain("'scripts/update-tracker.js'");
    expect(databaseCheckSource).toMatch(
      /checkDatabaseVersion,\s+applyMigration,\s+checkMigrationState,\s+checkSchemaCompatibility,\s+verifyOnly \? checkRuntimeSecurityState : checkSecurityState,/,
    );
    expect(databaseCheckSource).toContain('async function checkRuntimeSecurityState()');
    expect(databaseCheckSource).toContain('async function checkSecurityState()');
    expect(databaseCheckSource).toContain('HAVING COUNT(u.user_id) <> 1');
    expect(read('scripts/start-runtime.mjs')).toContain('timeout: 120_000');
    expect(systemdUnit).toContain(
      'ExecStart=/opt/node-24.18.1/bin/node .next/standalone/runtime-scripts/start-production.mjs',
    );
    expect(systemdUnit).toContain('Environment=NODE_OPTIONS=--max-old-space-size=384');
    expect(systemdUnit).toContain('MemoryHigh=512M');
    expect(systemdUnit).toContain('MemoryMax=768M');
    expect(systemdUnit).toContain('TasksMax=128');
    expect(systemdUnit).toContain('NoNewPrivileges=true');
    expect(systemdUnit).toContain('ProtectSystem=strict');
    expect(systemdUnit).not.toContain('.next/standalone/public\n');
    expect(read('deploy/runtime-artifact.json')).toContain('runtime-scripts/start-production.mjs');
    expect(read('scripts/postbuild.js')).toContain('createRuntimeManifest');
    expect(fs.existsSync(path.join(repositoryRoot, 'Dockerfile'))).toBe(false);
    expect(fs.existsSync(path.join(repositoryRoot, 'docker-compose.yml'))).toBe(false);
    expect(fs.existsSync(path.join(repositoryRoot, 'scripts/start-docker.js'))).toBe(false);

    for (const requiredSchemaElement of [
      'recorder_enabled',
      'replay_config',
      'session_replay',
      'session_replay_saved',
      'heatmap_event',
    ]) {
      expect(databaseCheckSource).toContain(requiredSchemaElement);
    }
  });

  test('keeps the overlapping session-data migrations safe in either upgrade order', () => {
    const hardeningMigration = read('prisma/migrations/21_harden_auth_invariants/migration.sql');
    const upstreamSessionMigration = read('prisma/migrations/23_update_session_data/migration.sql');
    const idempotentIndex =
      'CREATE UNIQUE INDEX IF NOT EXISTS "session_data_session_id_data_key_key"';

    expect(hardeningMigration).toContain(idempotentIndex);
    expect(upstreamSessionMigration).toContain(idempotentIndex);
  });
});
