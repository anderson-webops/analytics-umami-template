import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('production database startup', () => {
  test('refuses to skip migrations in production', () => {
    const result = spawnSync(process.execPath, ['scripts/check-env.js'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        NODE_ENV: 'production',
        APP_SECRET: 'a'.repeat(32),
        DATABASE_URL: `postgresql://umami:${'b'.repeat(32)}@db:5432/umami`,
        PUBLIC_URL: 'https://analytics.example.com',
        CLIENT_IP_HEADER: 'x-forwarded-for',
        SKIP_DB_MIGRATION: 'true',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SKIP_DB_MIGRATION is not permitted in production.');
  });

  test('runs migrations and schema compatibility checks before security-state checks', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );
    const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
    const databaseCheckSource = fs.readFileSync(
      path.join(repositoryRoot, 'scripts/check-db.js'),
      'utf8',
    );
    const startupSource = fs.readFileSync(
      path.join(repositoryRoot, 'scripts/start-docker.js'),
      'utf8',
    );

    expect(packageJson.scripts['start-docker']).toBe('node scripts/start-docker.js');
    expect(startupSource).toMatch(
      /'scripts\/check-env\.js',\s+'scripts\/check-db\.js',\s+'scripts\/update-tracker\.js'/,
    );
    expect(databaseCheckSource).toMatch(
      /checkDatabaseVersion,\s+applyMigration,\s+checkSchemaCompatibility,\s+checkSecurityState,/,
    );
    expect(dockerfile).toContain('CMD ["node", "scripts/start-docker.js"]');
    expect(dockerfile).toContain('/usr/local/lib/node_modules/npm');
    expect(dockerfile).not.toContain('CMD ["npm"');

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
