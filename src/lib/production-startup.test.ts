import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

describe('direct production startup', () => {
  test('keeps local development origin-free and production configuration separate', () => {
    const developmentEnvironment = read('env.development.sample');
    const productionEnvironment = read('env.sample');

    expect(developmentEnvironment.match(/^PUBLIC_URL=.*$/gm)).toEqual(['PUBLIC_URL=']);
    expect(developmentEnvironment).toContain('FORCE_SSL=0');
    expect(developmentEnvironment).toContain('MCP_ENABLED=0');
    expect(productionEnvironment).toContain('FORCE_SSL=1');
    expect(read('README.md')).toContain('cp env.development.sample .env');
  });

  test.each(['true', ' 1 '])(
    'rejects MCP value %j when it does not match the exact runtime enablement contract',
    value => {
      const result = spawnSync(process.execPath, ['scripts/check-env.js'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          NODE_ENV: 'development',
          APP_SECRET: 'a'.repeat(32),
          DATABASE_URL: `postgresql://umami:${'b'.repeat(32)}@localhost:5432/umami`,
          MCP_ENABLED: value,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('MCP_ENABLED must be 0 or 1.');
    },
  );

  test('binds the development server explicitly to loopback', () => {
    const packageJson = JSON.parse(read('package.json'));

    expect(packageJson.scripts.dev).toContain('next dev --turbo --hostname 127.0.0.1');
  });

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
    expect(databaseCheckSource).toContain('index_definition.indrelid = to_regclass');
    expect(databaseCheckSource).toContain('index_definition.indisvalid');
    expect(databaseCheckSource).toContain('index_definition.indpred');
    expect(databaseCheckSource).toContain('constraint_definition.conrelid = to_regclass');
    expect(databaseCheckSource).toContain('constraint_definition.convalidated');
    expect(databaseCheckSource).toContain('pg_get_constraintdef');
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

  test('keeps published migrations immutable and bridges their historical fixes', () => {
    const boardMigration = read('prisma/migrations/16_boards/migration.sql');
    const hardeningMigration = read('prisma/migrations/21_harden_auth_invariants/migration.sql');
    const upstreamSessionMigration = read('prisma/migrations/23_update_session_data/migration.sql');
    const prepareMigration = read(
      'prisma/migrations/22_prepare_session_data_index_rebuild/migration.sql',
    );
    const finalizeMigration = read(
      'prisma/migrations/25_finalize_session_data_index_rebuild/migration.sql',
    );
    const boardFinalizer = read(
      'prisma/migrations/27_remove_redundant_board_primary_key_index/migration.sql',
    );
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');

    expect(digest(boardMigration)).toBe(
      '52df2b4723b1c9e1c2dc66ffb191df56742a23e48a5cd7bc12947fbbc7b420fb',
    );
    expect(digest(hardeningMigration)).toBe(
      'af596c3f844becd9f8382f6aec03d6541612f348aa4921ba8a35cc1d5fc6655b',
    );
    expect(digest(upstreamSessionMigration)).toBe(
      '5fc778b82bb34c3c04d78061e66d7036c3c51d0c506f5279f3c1cfc99f24f694',
    );
    expect(prepareMigration).toContain('ALTER INDEX %I.%I RENAME TO %I');
    expect(finalizeMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "session_data_session_id_data_key_key"',
    );
    expect(finalizeMigration).toMatch(/^BEGIN;/);
    expect(finalizeMigration).toMatch(/COMMIT;\s*$/);
    expect(finalizeMigration).toContain('DROP INDEX %I.%I');
    expect(boardFinalizer).toContain("pg_get_indexdef(indexrelid, 1, true) = 'board_id'");
    expect(boardFinalizer).toContain('DROP INDEX %I.%I');
  });
});
