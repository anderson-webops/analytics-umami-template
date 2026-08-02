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

  test('uses the hardened system service instead of a production container', () => {
    const packageJson = JSON.parse(read('package.json'));
    const databaseCheckSource = read('scripts/check-db.js');
    const startupSource = read('scripts/start-production.js');
    const systemdUnit = read('deploy/systemd/umami@.service');

    expect(packageJson.scripts['build:production']).toContain('postbuild');
    expect(packageJson.scripts['start:production']).toBe('node scripts/start-production.js');
    expect(packageJson.scripts['build-docker']).toBeUndefined();
    expect(packageJson.scripts['start-docker']).toBeUndefined();
    expect(startupSource).toMatch(
      /'scripts\/check-env\.js'[\s\S]+'scripts\/check-db\.js'[\s\S]+'scripts\/update-tracker\.js'/,
    );
    expect(databaseCheckSource).toMatch(
      /checkDatabaseVersion,\s+applyMigration,\s+checkSchemaCompatibility,\s+checkSecurityState,/,
    );
    expect(systemdUnit).toContain('ExecStart=/usr/bin/node scripts/start-production.js');
    expect(systemdUnit).toContain('NoNewPrivileges=true');
    expect(systemdUnit).toContain('ProtectSystem=strict');
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
});
