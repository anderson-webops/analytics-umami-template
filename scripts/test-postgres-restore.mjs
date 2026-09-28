import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { Client } from 'pg';

// CREATEDB permission is needed only on this disposable, loopback test server.
assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.ok(['postgres:', 'postgresql:'].includes(address.protocol));
address.search = '';
const root = path.resolve(import.meta.dirname, '..');
const classroom = process.argv.includes('--classroom');
const runs = path.join(root, '.ai-work/runs');
await fs.mkdir(runs, { recursive: true });
const fixture = await fs.mkdtemp(path.join(runs, 'postgres-restore-'));
const names = ['before', 'restored'].map(
  name => `restore_${name}_${crypto.randomBytes(6).toString('hex')}`,
);
const urls = names.map(name => {
  const url = new URL(address);
  url.pathname = `/${name}`;
  return url.toString();
});
const admin = new Client({ connectionString: address.toString() });
let active;
const created = [];
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CI: process.env.CI,
  PNPM_HOME: process.env.PNPM_HOME,
  NODE_ENV: 'production',
  DOTENV_CONFIG_PATH: '/dev/null',
  DATABASE_TYPE: 'postgresql',
  APP_SECRET: 'synthetic-restore-secret-0000000000000000000',
  PUBLIC_URL: 'https://analytics.example.com',
  CLIENT_IP_HEADER: 'x-real-ip',
  NEXT_TELEMETRY_DISABLED: '1',
  DISABLE_TELEMETRY: '1',
  MCP_ENABLED: '0',
  CLASSROOM_MODE: classroom ? '1' : '0',
  ...(classroom
    ? {
        PORT: '3111',
        CLASSROOM_ANALYTICS_SHARED_SECRET: 'synthetic-classroom-service-key-000000000000',
        CLASSROOM_ANALYTICS_SOURCE_URL: 'http://127.0.0.2:3008/classroom-analytics/summary',
        TWO_FACTOR_ENCRYPTION_KEY: 'a'.repeat(64),
        PRIVATE_MODE: '1',
        DISABLE_PUBLIC_SHARES: '1',
        DISABLE_UPDATES: '1',
        ENABLE_UPDATE_CHECKS: '0',
      }
    : {}),
};
function run(command, args, cwd = root, extra = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2 ** 22,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}
function ok(result) {
  assert.equal(result.status, 0, result.output);
}
function migrate() {
  return run('pnpm', ['run', 'db:migrate']);
}
function startup() {
  return run(process.execPath, ['runtime-scripts/start-production.mjs'], fixture);
}
async function ledger() {
  return (await active.query('SELECT * FROM _prisma_migrations ORDER BY id')).rows;
}
async function roles() {
  return (
    await active.query(
      "SELECT conname, pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN ('user_role_check', 'team_user_role_check') ORDER BY conname",
    )
  ).rows;
}
try {
  await admin.connect();
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 170000 && version < 180000, 'This regression requires PostgreSQL 17.');
  for (const tool of ['pg_dump', 'pg_restore'])
    assert.match(run(tool, ['--version']).output, /PostgreSQL\) 17\./);
  for (const name of names) {
    await admin.query(`CREATE DATABASE "${name}"`);
    created.push(name);
  }
  env.DATABASE_URL = urls[0];
  ok(migrate());
  active = new Client({ connectionString: urls[0] });
  await active.connect();
  const original = await roles();
  assert.ok(original.every(row => row.definition.endsWith(']::text[]))')));

  // Reconstruct only a synthetic legacy state, never modify a real ledger.
  const pending = (await ledger()).filter(row =>
    /add_annotation|add_api_key|remove_redundant_board|prepare_session_data_index_rebuild|finalize_session_data_index_rebuild/.test(
      row.migration_name,
    ),
  );
  await active.query('DROP TABLE annotation, api_key');
  await active.query('CREATE UNIQUE INDEX board_board_id_key ON board(board_id)');
  await active.query('DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])', [
    pending.map(row => row.migration_name),
  ]);
  await active.query(
    "INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, rolled_back_at, applied_steps_count) VALUES ($1, $2, '16_boards', now(), now(), 0)",
    [crypto.randomUUID(), 'b'.repeat(64)],
  );
  const history = await ledger();
  const users = (await active.query('SELECT * FROM "user" ORDER BY user_id')).rows;
  const dump = path.join(fixture, 'synthetic.dump');
  ok(run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump, urls[0]]));
  ok(run('pg_restore', ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', urls[1], dump]));
  await active.end();
  active = new Client({ connectionString: urls[1] });
  await active.connect();
  const restored = await roles();
  assert.ok(restored.every(row => row.definition.includes('::character varying::text')));
  assert.notDeepEqual(
    restored,
    original,
    'Dump/restore did not reproduce the cast-placement change.',
  );
  env.DATABASE_URL = urls[1];
  ok(migrate());
  for (const row of history)
    assert.deepEqual(
      (await ledger()).find(item => item.id === row.id),
      row,
    );
  assert.deepEqual((await active.query('SELECT * FROM "user" ORDER BY user_id')).rows, users);
  const migrated = await ledger();
  ok(migrate());
  assert.deepEqual(await ledger(), migrated);
  for (const table of ['annotation', 'api_key'])
    assert.equal((await active.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);

  await fs.mkdir(path.join(fixture, 'runtime-scripts'));
  await fs.cp(path.join(root, 'prisma'), path.join(fixture, 'prisma'), { recursive: true });
  for (const name of ['check-env', 'check-db'])
    await build({
      entryPoints: [path.join(root, `scripts/${name}.js`)],
      outfile: path.join(fixture, `runtime-scripts/${name}.mjs`),
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
  await fs.copyFile(
    path.join(root, 'scripts/start-runtime.mjs'),
    path.join(fixture, 'runtime-scripts/start-production.mjs'),
  );
  await fs.writeFile(path.join(fixture, 'package.json'), '{"type":"module"}\n');
  await fs.writeFile(
    path.join(fixture, 'server.js'),
    "console.log('RESTORED_STARTUP_ACCEPTED');\n",
  );
  ok(startup());
  const specifications = [
    ['user', 'user_role_check', ['admin', 'user', 'view-only']],
    [
      'team_user',
      'team_user_role_check',
      ['team-owner', 'team-manager', 'team-member', 'team-view-only'],
    ],
  ];
  let rejected = 0;
  for (const [table, name, allowed] of specifications) {
    const expression = values => `CHECK (role IN (${values.map(value => `'${value}'`).join(',')}))`;
    const restore = restored.find(row => row.conname === name).definition;
    const mutations = [
      `ALTER TABLE "${table}" ADD CONSTRAINT ${name} ${expression([...allowed, 'unexpected'])}`,
      `ALTER TABLE "${table}" ADD CONSTRAINT ${name} ${expression(allowed.slice(0, -1))}`,
      `ALTER TABLE "${table}" ADD CONSTRAINT ${name} ${expression(allowed)} NOT VALID`,
      `CREATE TABLE wrong_table (role varchar(50), CONSTRAINT ${name} ${expression(allowed)})`,
      `ALTER TABLE "${table}" ADD CONSTRAINT ${name} CHECK (role IS NOT NULL)`,
      `ALTER TABLE "${table}" ADD CONSTRAINT ${name} CHECK (role IN ('${allowed.join("','")}') OR role = 'unexpected')`,
      'SELECT 1',
    ];
    for (const sql of mutations) {
      await active.query(`ALTER TABLE "${table}" DROP CONSTRAINT ${name}`);
      await active.query(sql);
      for (const execute of [migrate, startup]) {
        const result = execute();
        assert.notEqual(result.status, 0, result.output);
        assert.match(result.output, /Database schema is incomplete/);
        assert.ok(!result.output.includes('RESTORED_STARTUP_ACCEPTED'));
        rejected += 1;
      }
      await active.query('DROP TABLE IF EXISTS wrong_table');
      await active.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS ${name}`);
      await active.query(`ALTER TABLE "${table}" ADD CONSTRAINT ${name} ${restore}`);
    }
    // Both approved forms pass the same startup gate after negative cases.
    await active.query(`ALTER TABLE "${table}" DROP CONSTRAINT ${name}`);
    await active.query(`ALTER TABLE "${table}" ADD CONSTRAINT ${name} ${expression(allowed)}`);
    ok(startup());
  }
  assert.deepEqual(await ledger(), migrated);
  console.log(
    `PostgreSQL 17 dump/restore, existing ledger, idempotency and bundled startup passed; ${rejected} weakened/missing/wrong-table constraint gates rejected (${classroom ? 'classroom' : 'standard'}).`,
  );
} finally {
  await active?.end();
  for (const name of created.reverse()) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  await fs.rm(fixture, { recursive: true, force: true });
}
