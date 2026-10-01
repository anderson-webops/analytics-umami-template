import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { Client } from 'pg';

// Only synthetic rows in a newly created random schema. Never modify an existing ledger.
assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = new URL(process.env.DATABASE_URL);
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
const root = path.resolve(import.meta.dirname, '..');
const runs = path.join(root, '.ai-work', 'runs');
await fs.mkdir(runs, { recursive: true });
const fixture = await fs.mkdtemp(path.join(runs, 'ledger-attempt-paths-'));
const runtimeScripts = path.join(fixture, 'runtime-scripts');
const schema = `attempt_rehearsal_${crypto.randomBytes(8).toString('hex')}`;
const rehearsalUrl = new URL(databaseUrl);
rehearsalUrl.searchParams.set('schema', schema);
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  // Keep pnpm's CI-dependent installation layout consistent with the frozen install.
  // Dropping CI makes pnpm try to reinstall the already validated dependencies.
  CI: process.env.CI,
  PNPM_HOME: process.env.PNPM_HOME,
  NODE_ENV: 'production',
  DATABASE_URL: rehearsalUrl.toString(),
  DATABASE_TYPE: 'postgresql',
  DOTENV_CONFIG_PATH: '/dev/null',
  APP_SECRET: 'synthetic-ledger-attempt-secret-00000000000000',
  PUBLIC_URL: 'https://analytics.example.com',
  CLIENT_IP_HEADER: 'x-real-ip',
  NEXT_TELEMETRY_DISABLED: '1',
  DISABLE_TELEMETRY: '1',
  // Avasan uses its production privacy gate with synthetic values and no provider calls.
  CLASSROOM_MODE: process.argv.includes('--classroom') ? '1' : '0',
  MCP_ENABLED: '0',
};
if (env.CLASSROOM_MODE === '1') {
  Object.assign(env, {
    CLASSROOM_ANALYTICS_SHARED_SECRET: 'synthetic-classroom-service-key-000000000000',
    CLASSROOM_ANALYTICS_SOURCE_URL: 'http://127.0.0.2:3008/classroom-analytics/summary',
    TWO_FACTOR_ENCRYPTION_KEY: 'a'.repeat(64),
    PRIVATE_MODE: '1',
    DISABLE_PUBLIC_SHARES: '1',
    DISABLE_UPDATES: '1',
    ENABLE_UPDATE_CHECKS: '0',
  });
}
const client = new Client({ connectionString: databaseUrl.toString() });
let schemaCreated = false;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function migrate() {
  // Exercise the package command, not a parallel implementation of its SQL.
  return run('pnpm', ['run', 'db:migrate']);
}

function startup() {
  // This is the actual immutable-runtime startup supervisor and bundled DB gate.
  // The final app child is a harmless sentinel; release acceptance separately runs Next.
  return run(process.execPath, [path.join(runtimeScripts, 'start-production.mjs')], fixture);
}

async function snapshot() {
  return (await client.query('SELECT * FROM _prisma_migrations ORDER BY id')).rows;
}

async function insert(row) {
  await client.query(
    `INSERT INTO _prisma_migrations
    (id, migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count, logs)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.id,
      row.migration_name,
      row.checksum,
      row.started_at,
      row.finished_at,
      row.rolled_back_at,
      row.applied_steps_count,
      row.logs,
    ],
  );
}

function* permutations(rows) {
  if (rows.length === 0) yield [];
  for (let i = 0; i < rows.length; i += 1) {
    for (const rest of permutations(rows.filter((_, j) => i !== j))) yield [rows[i], ...rest];
  }
}

try {
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await client.query(`SET search_path TO "${schema}"`);
  const fresh = migrate();
  assert.equal(fresh.status, 0, fresh.output);

  await fs.mkdir(runtimeScripts);
  await fs.cp(path.join(root, 'prisma'), path.join(fixture, 'prisma'), { recursive: true });
  for (const name of ['check-env', 'check-db']) {
    await build({
      entryPoints: [path.join(root, 'scripts', `${name}.js`)],
      outfile: path.join(runtimeScripts, `${name}.mjs`),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      packages: 'bundle',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: 'silent',
    });
  }
  await fs.copyFile(
    path.join(root, 'scripts/start-runtime.mjs'),
    path.join(runtimeScripts, 'start-production.mjs'),
  );
  await fs.writeFile(path.join(fixture, 'server.js'), "console.log('SYNTHETIC_SERVER_STARTED');\n");
  await fs.writeFile(path.join(fixture, 'package.json'), '{"type":"module"}\n');

  const baseline = await snapshot();
  const success = baseline.find(row => row.migration_name === '16_boards');
  assert.ok(success);
  const rollback = {
    ...success,
    id: crypto.randomUUID(),
    checksum: 'b'.repeat(64),
    finished_at: null,
    rolled_back_at: new Date(),
    applied_steps_count: 0,
    logs: 'synthetic-resolved-attempt',
  };
  const pending = { ...rollback, id: crypto.randomUUID(), rolled_back_at: null };
  const drift = { ...success, id: crypto.randomUUID(), checksum: 'c'.repeat(64) };
  const unknown = {
    ...success,
    id: crypto.randomUUID(),
    migration_name: 'unknown_synthetic_migration',
  };
  const contradictory = { ...success, id: crypto.randomUUID(), rolled_back_at: new Date() };
  const cases = [
    [[success, rollback], true],
    [[success, rollback, { ...rollback, id: crypto.randomUUID() }], true],
    [[success, pending], false],
    [[success, drift], false],
    [[success, { ...success, id: crypto.randomUUID() }], false],
    [[success, unknown], false],
    [[success, { ...unknown, finished_at: null, rolled_back_at: new Date() }], false],
    [[success, contradictory], false],
  ];
  let executions = 0;
  for (const [attempts, accepted] of cases) {
    for (const rows of permutations(attempts)) {
      await client.query('TRUNCATE _prisma_migrations');
      for (const row of baseline.filter(row => row.id !== success.id)) await insert(row);
      for (const row of rows) await insert(row);
      const before = await snapshot();
      for (const execute of [migrate, startup]) {
        const result = execute();
        assert.equal(result.status === 0, accepted, result.output);
        if (execute === startup)
          assert.equal(result.output.includes('SYNTHETIC_SERVER_STARTED'), accepted);
        if (!accepted) {
          assert.match(
            result.output,
            /Database migration history|successful database migration checksum/,
          );
          assert.ok(!result.output.includes('unknown_synthetic_migration'));
          assert.ok(!result.output.includes('synthetic-resolved-attempt'));
        }
        assert.deepEqual(await snapshot(), before, 'Existing ledger rows changed.');
        executions += 1;
      }
    }
  }

  const finalizer = baseline.find(
    row => row.migration_name === '25_finalize_session_data_index_rebuild',
  );
  assert.ok(finalizer);
  await client.query('TRUNCATE _prisma_migrations');
  for (const row of baseline) {
    await insert(
      row.id === finalizer.id
        ? {
            ...row,
            checksum: 'f0cc6caeef1b1b586513b1f52f1a5d5dd71d2f6d5f03279bcfb751690044f282',
          }
        : row,
    );
  }
  const publishedBefore = await snapshot();
  for (const execute of [migrate, startup]) {
    const result = execute();
    assert.equal(result.status, 0, result.output);
    if (execute === startup) assert.ok(result.output.includes('SYNTHETIC_SERVER_STARTED'));
    assert.deepEqual(await snapshot(), publishedBefore, 'Published migration history changed.');
    executions += 1;
  }
  await client.query(`UPDATE _prisma_migrations SET checksum = $1 WHERE id = $2`, [
    'c'.repeat(64),
    finalizer.id,
  ]);
  const driftedBefore = await snapshot();
  for (const execute of [migrate, startup]) {
    const result = execute();
    assert.notEqual(result.status, 0, 'An unrecognized finalizer checksum was accepted.');
    assert.match(result.output, /successful database migration checksum does not match/);
    assert.deepEqual(await snapshot(), driftedBefore, 'Drifted migration history changed.');
    executions += 1;
  }

  // A missing successful application blocks startup, while db:migrate may retry a resolved failure.
  await client.query('TRUNCATE _prisma_migrations');
  const finalMigration = baseline.find(row =>
    row.migration_name.endsWith('_remove_redundant_board_primary_key_index'),
  );
  assert.ok(finalMigration);
  for (const row of baseline.filter(row => row.id !== finalMigration.id)) await insert(row);
  const finalRollback = {
    ...finalMigration,
    id: crypto.randomUUID(),
    finished_at: null,
    rolled_back_at: new Date(),
    applied_steps_count: 0,
  };
  await insert(finalRollback);
  const pendingBefore = await snapshot();
  const denied = startup();
  assert.notEqual(denied.status, 0);
  assert.match(denied.output, /no successful application/);
  assert.deepEqual(await snapshot(), pendingBefore);
  const retry = migrate();
  assert.equal(retry.status, 0, retry.output);
  const after = await snapshot();
  for (const row of pendingBefore)
    assert.deepEqual(
      after.find(item => item.id === row.id),
      row,
    );
  assert.equal(after.length, pendingBefore.length + 1);
  const started = startup();
  assert.equal(started.status, 0, started.output);
  assert.ok(started.output.includes('SYNTHETIC_SERVER_STARTED'));
  console.log(
    `Passed ${executions} guarded migration/startup order cases plus fresh migration and resolved-failure retry; historical rows preserved.`,
  );
} finally {
  if (schemaCreated) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  await client.end();
  await fs.rm(fixture, { recursive: true, force: true });
}
