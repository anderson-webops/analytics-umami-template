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
  test.each(['source', 'artifact', 'dotenv'])(
    '%s launcher enforces production gates even when launched from development',
    launcherKind => {
      const runsDirectory = path.join(repositoryRoot, '.ai-work', 'runs');
      fs.mkdirSync(runsDirectory, { recursive: true });
      const fixtureRoot = fs.mkdtempSync(path.join(runsDirectory, 'production-launcher-'));

      try {
        fs.writeFileSync(path.join(fixtureRoot, 'package.json'), '{"type":"module"}\n');
        fs.writeFileSync(
          path.join(fixtureRoot, '.env'),
          'NODE_ENV=development\nTEST_ENV_LOADED=ok\n',
        );
        const scriptDirectory =
          launcherKind === 'artifact'
            ? path.join(fixtureRoot, 'runtime-scripts')
            : path.join(fixtureRoot, 'scripts');
        fs.mkdirSync(scriptDirectory, { recursive: true });
        const launcherPath = path.join(
          scriptDirectory,
          launcherKind === 'artifact'
            ? 'start-production.mjs'
            : launcherKind === 'dotenv'
              ? 'start-env.js'
              : 'start-production.js',
        );
        fs.copyFileSync(
          path.join(
            repositoryRoot,
            launcherKind === 'artifact'
              ? 'scripts/start-runtime.mjs'
              : 'scripts/start-production.js',
          ),
          path.join(
            scriptDirectory,
            launcherKind === 'artifact' ? 'start-production.mjs' : 'start-production.js',
          ),
        );

        if (launcherKind !== 'artifact') {
          fs.copyFileSync(
            path.join(repositoryRoot, 'scripts/repair-standalone.js'),
            path.join(scriptDirectory, 'repair-standalone.js'),
          );
        }

        if (launcherKind === 'dotenv') {
          fs.copyFileSync(path.join(repositoryRoot, 'scripts/start-env.js'), launcherPath);
          const modulesDirectory = path.join(fixtureRoot, 'node_modules');
          fs.mkdirSync(modulesDirectory);
          fs.symlinkSync(
            fs.realpathSync(path.join(repositoryRoot, 'node_modules', 'dotenv')),
            path.join(modulesDirectory, 'dotenv'),
            'dir',
          );
        }

        const checkSource =
          "if (process.env.DOTENV_CONFIG_OVERRIDE) { console.error('Dotenv override reached startup gate.'); process.exit(72); }\n" +
          "if (process.env.NODE_ENV === 'production' && process.env.UMAMI_BIND_ADDRESS === '0.0.0.0') { console.error('Public listener rejected.'); process.exit(71); }\n";
        const checkExtension = launcherKind === 'artifact' ? 'mjs' : 'js';
        fs.writeFileSync(path.join(scriptDirectory, `check-env.${checkExtension}`), checkSource);
        fs.writeFileSync(
          path.join(scriptDirectory, `check-db.${checkExtension}`),
          "if (!process.argv.includes('--verify-only')) { console.error('Startup database gate must be verify-only.'); process.exit(73); }\n",
        );

        const appRoot =
          launcherKind === 'artifact' ? fixtureRoot : path.join(fixtureRoot, '.next', 'standalone');
        fs.mkdirSync(appRoot, { recursive: true });
        fs.writeFileSync(
          path.join(appRoot, 'server.js'),
          'console.log("server mode: " + process.env.NODE_ENV + "; loaded: " + process.env.TEST_ENV_LOADED);\n',
        );

        for (const nodeEnvironment of ['development', undefined] as const) {
          for (const dotenvOverride of [undefined, 'true'] as const) {
            for (const [bindAddress, expectedStatus] of [
              ['0.0.0.0', 71],
              ['127.0.0.1', 0],
            ] as const) {
              const environment = {
                ...process.env,
                NODE_ENV: nodeEnvironment,
                DOTENV_CONFIG_OVERRIDE: dotenvOverride,
                DOTENV_CONFIG_PATH: path.join(fixtureRoot, '.env'),
                UMAMI_BIND_ADDRESS: bindAddress,
              };
              const result = spawnSync(process.execPath, [launcherPath], {
                cwd: fixtureRoot,
                encoding: 'utf8',
                env: environment,
                timeout: 5_000,
              });

              expect(result.error).toBeUndefined();
              expect(result.status, result.stderr).toBe(expectedStatus);
              if (expectedStatus === 0) {
                expect(result.stdout).toContain('server mode: production');
                if (launcherKind === 'dotenv') {
                  expect(result.stdout).toContain('loaded: ok');
                }
              } else {
                expect(result.stderr).toContain('Public listener rejected.');
                expect(result.stdout).not.toContain('server mode:');
              }
            }
          }
        }
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

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

  test('the database gate independently refuses to skip checks in production', () => {
    const result = spawnSync(process.execPath, ['scripts/check-db.js'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        NODE_ENV: 'production',
        SKIP_DB_CHECK: 'true',
      },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'SKIP_DB_CHECK is not permitted in production.',
    );
  });

  test.each(['db:migrate', 'update-db'])(
    '%s refuses to skip database validation when called outside production mode',
    command => {
      const result = spawnSync('pnpm', ['run', command], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'development',
          SKIP_DB_CHECK: '1',
          DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:65534/synthetic',
        },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'SKIP_DB_CHECK is not permitted for migration or verification.',
      );
      expect(result.stdout).not.toContain('Skipping database check.');
    },
  );

  test.each(['check:db', 'check-db'])(
    '%s refuses to report a skipped migration-capable database check as success',
    command => {
      const result = spawnSync('pnpm', ['run', command], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'development',
          SKIP_DB_CHECK: '1',
          DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:65534/synthetic',
        },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'SKIP_DB_CHECK is not permitted for migration or verification.',
      );
      expect(result.stdout).not.toContain('Skipping database check.');
    },
  );

  test('migration-capable aliases cannot opt into the build-only skip', () => {
    const result = spawnSync('pnpm', ['run', 'check:db', '--build-check'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        SKIP_DB_CHECK: '1',
        DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:65534/synthetic',
      },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Unsupported database check mode.');
    expect(result.stdout).not.toContain('Skipping database check for development build.');
  });

  test('the migration gate refuses to skip migration even outside production mode', () => {
    const result = spawnSync(process.execPath, ['scripts/check-db.js', '--migrate-only'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        SKIP_DB_CHECK: '0',
        SKIP_DB_MIGRATION: '1',
        DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:65534/synthetic',
      },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'SKIP_DB_MIGRATION is not permitted for migration or verification.',
    );
  });

  test.each(['SKIP_DB_CHECK', 'SKIP_DB_MIGRATION'])(
    'the verify-only gate refuses %s even outside production mode',
    flag => {
      const result = spawnSync(process.execPath, ['scripts/check-db.js', '--verify-only'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'development',
          SKIP_DB_CHECK: '0',
          SKIP_DB_MIGRATION: '0',
          [flag]: '1',
          DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:65534/synthetic',
        },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `${flag} is not permitted for migration or verification.`,
      );
    },
  );

  test('the non-migrating development build check supports an explicit database skip', () => {
    const result = spawnSync('pnpm', ['run', 'check:db:build'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        SKIP_DB_CHECK: '1',
        DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:65534/synthetic',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping database check for development build.');
    expect(JSON.parse(read('package.json')).scripts.build).toContain('check:db:build');
    expect(read('scripts/check-build-db.js')).toContain("'--verify-only'");
  });

  test('the build check rejects migration options and production skip flags', () => {
    const syntheticDatabaseUrl = 'postgresql://synthetic:synthetic@127.0.0.1:65534/synthetic';
    const migrationOption = spawnSync('pnpm', ['run', 'check:db:build', '--migrate-only'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        SKIP_DB_CHECK: '1',
        DATABASE_URL: syntheticDatabaseUrl,
      },
    });
    const productionSkip = spawnSync('pnpm', ['run', 'check:db:build'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SKIP_DB_CHECK: '1',
        DATABASE_URL: syntheticDatabaseUrl,
      },
    });

    expect(migrationOption.status).toBe(1);
    expect(`${migrationOption.stdout}${migrationOption.stderr}`).toContain(
      'The development build database check accepts no arguments.',
    );
    expect(productionSkip.status).toBe(1);
    expect(`${productionSkip.stdout}${productionSkip.stderr}`).toContain(
      'SKIP_DB_CHECK is not permitted in production.',
    );
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
    expect(packageJson.scripts.start).toBe(packageJson.scripts['start:production']);
    expect(packageJson.scripts['start:server']).toBe(packageJson.scripts['start:production']);
    expect(packageJson.scripts.prestart).toBeUndefined();
    expect(read('scripts/start-env.js')).toContain("await import('./start-production.js')");
    expect(packageJson.scripts['db:migrate']).toBe('node scripts/check-db.js --migrate-only');
    expect(packageJson.scripts['build-docker']).toBeUndefined();
    expect(packageJson.scripts['start-docker']).toBeUndefined();
    expect(startupSource).toMatch(/'scripts\/check-env\.js'[\s\S]+'scripts\/check-db\.js'/);
    expect(startupSource).not.toContain("'scripts/update-tracker.js'");
    expect(databaseCheckSource).toMatch(
      /checkDatabaseVersion,\s+checkMigrationTargetIdentity,\s+checkMigrationSource,\s+checkExistingMigrationState,\s+applyMigration,\s+checkMigrationState,\s+checkSchemaCompatibility,/,
    );
    expect(databaseCheckSource).toContain('pg_control_system()');
    expect(databaseCheckSource).toContain('...(migrationOnly ? [] :');
    expect(databaseCheckSource).toContain("from './applied-migrations.mjs'");
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
