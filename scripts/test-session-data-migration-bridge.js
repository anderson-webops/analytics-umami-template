import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { verifyMigrationLedgerContract } from './migration-ledger-contract.mjs';

if (process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST !== '1') {
  throw new Error('Set ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 for the isolated migration test.');
}

const databaseUrl = new URL(process.env.DATABASE_URL || '');

if (
  !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname)
) {
  throw new Error('The migration bridge test requires an explicit loopback PostgreSQL database.');
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const migrationLedgerContract = await verifyMigrationLedgerContract(repositoryRoot);
const historicalMigrationNames = [...migrationLedgerContract.checksums.keys()].sort();
const prepareMigration = fs.readFileSync(
  path.join(
    repositoryRoot,
    'prisma/migrations/22_prepare_session_data_index_rebuild/migration.sql',
  ),
  'utf8',
);
const upstreamMigration = fs.readFileSync(
  path.join(repositoryRoot, 'prisma/migrations/23_update_session_data/migration.sql'),
  'utf8',
);
const finalizeMigration = fs.readFileSync(
  path.join(
    repositoryRoot,
    'prisma/migrations/25_finalize_session_data_index_rebuild/migration.sql',
  ),
  'utf8',
);
const boardFinalizer = fs.readFileSync(
  path.join(
    repositoryRoot,
    'prisma/migrations/27_remove_redundant_board_primary_key_index/migration.sql',
  ),
  'utf8',
);
const canonicalIndex = 'session_data_session_id_data_key_key';
const legacyIndex = 'session_data_session_id_data_key_key_pre_v4_2_4';
const client = new Client({ connectionString: databaseUrl.toString() });

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function readIndex(indexName) {
  const result = await client.query(
    `SELECT
       i.indisunique AS unique,
       i.indisvalid AS valid,
       i.indisready AS ready,
       pg_get_indexdef(i.indexrelid, 1, true) AS first_column,
       pg_get_indexdef(i.indexrelid, 2, true) AS second_column
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = $1`,
    [indexName],
  );

  return result.rows[0] || null;
}

async function withIsolatedSchema(name, callback) {
  const schema = `analytics_migration_bridge_${name}_${crypto.randomBytes(4).toString('hex')}`;
  const quotedSchema = quoteIdentifier(schema);

  await client.query(`CREATE SCHEMA ${quotedSchema}`);

  try {
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await callback();
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
  }
}

async function runSessionScenario(name, setup, expectedRows) {
  await withIsolatedSchema(name, async () => {
    await client.query(`
      CREATE TABLE session_data (
        session_data_id uuid PRIMARY KEY,
        session_id uuid NOT NULL,
        data_key varchar(500) NOT NULL,
        created_at timestamptz
      )
    `);
    await setup();
    await client.query(prepareMigration);
    await client.query(upstreamMigration);
    await client.query(finalizeMigration);

    const canonical = await readIndex(canonicalIndex);
    assert.deepEqual(canonical, {
      unique: true,
      valid: true,
      ready: true,
      first_column: 'session_id',
      second_column: 'data_key',
    });
    assert.equal(await readIndex(legacyIndex), null);

    const rowCount = await client.query('SELECT COUNT(*)::int AS count FROM session_data');
    assert.equal(rowCount.rows[0].count, expectedRows);
    const duplicates = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT 1
        FROM session_data
        GROUP BY session_id, data_key
        HAVING COUNT(*) > 1
      ) duplicate_groups
    `);
    assert.equal(duplicates.rows[0].count, 0);
  });
}

async function runRejectedSessionScenario(name, setup, expectedError) {
  await withIsolatedSchema(name, async () => {
    await client.query(`
      CREATE TABLE session_data (
        session_data_id uuid PRIMARY KEY,
        session_id uuid NOT NULL,
        data_key varchar(500) NOT NULL,
        created_at timestamptz
      )
    `);
    await setup();
    await assert.rejects(client.query(prepareMigration), expectedError);
  });
}

async function runBoardScenario(name, setup, expectedError) {
  await withIsolatedSchema(name, async () => {
    await client.query('CREATE TABLE board (board_id uuid PRIMARY KEY, slug text NOT NULL)');
    await setup();

    if (expectedError) {
      await assert.rejects(client.query(boardFinalizer), expectedError);
      return;
    }

    await client.query(boardFinalizer);
    assert.equal(await readIndex('board_board_id_key'), null);
    assert.notEqual(await readIndex('board_pkey'), null);
  });
}

async function runFinalizeRollbackScenario() {
  await withIsolatedSchema('finalize_rollback', async () => {
    await client.query(`
      CREATE TABLE session_data (
        session_data_id uuid PRIMARY KEY,
        session_id uuid NOT NULL,
        data_key varchar(500) NOT NULL,
        created_at timestamptz
      )
    `);
    await client.query(`
      INSERT INTO session_data (session_data_id, session_id, data_key, created_at)
      VALUES
        ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000051', 'site', '2026-09-20T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000051', 'site', '2026-09-21T00:00:00Z')
    `);
    await client.query(
      `CREATE UNIQUE INDEX ${quoteIdentifier(legacyIndex)} ON session_data(session_data_id)`,
    );

    await assert.rejects(
      client.query(finalizeMigration),
      /retained session-data index is not safe/,
    );
    await client.query('ROLLBACK');

    const rows = await client.query(
      'SELECT session_data_id::text FROM session_data ORDER BY session_data_id',
    );
    assert.deepEqual(
      rows.rows.map(({ session_data_id }) => session_data_id),
      ['00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000042'],
    );
    assert.equal(await readIndex(canonicalIndex), null);
    assert.notEqual(await readIndex(legacyIndex), null);
  });
}

function runPrismaMigrate(connectionString, schemaPath) {
  const args = ['exec', 'prisma', 'migrate', 'deploy'];

  if (schemaPath) {
    args.push('--schema', schemaPath);
  }

  const result = spawnSync('pnpm', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
    },
  });

  assert.equal(
    result.status,
    0,
    `Prisma migration rehearsal failed.\n${result.stdout || ''}${result.stderr || ''}`,
  );
}

function runDatabaseCheck(
  connectionString,
  { directConnectionString = connectionString, args = [] } = {},
) {
  return spawnSync(process.execPath, ['scripts/check-db.js', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      DIRECT_DATABASE_URL: directConnectionString,
    },
  });
}

async function runMigrationTargetIdentityScenario() {
  const primarySchema = `analytics_migration_primary_${crypto.randomBytes(4).toString('hex')}`;
  const directSchema = `analytics_migration_direct_${crypto.randomBytes(4).toString('hex')}`;
  const primaryUrl = new URL(databaseUrl);
  const equivalentUrl = new URL(databaseUrl);
  const differentUrl = new URL(databaseUrl);

  primaryUrl.searchParams.set('schema', primarySchema);
  equivalentUrl.hostname = databaseUrl.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  equivalentUrl.searchParams.set('schema', primarySchema);
  differentUrl.searchParams.set('schema', directSchema);

  await client.query(`CREATE SCHEMA ${quoteIdentifier(primarySchema)}`);
  await client.query(`CREATE SCHEMA ${quoteIdentifier(directSchema)}`);

  try {
    runPrismaMigrate(primaryUrl.toString());

    const equivalentResult = runDatabaseCheck(primaryUrl.toString(), {
      directConnectionString: equivalentUrl.toString(),
      args: ['--migrate-only'],
    });
    assert.equal(
      equivalentResult.status,
      0,
      `Equivalent database endpoints were rejected.\n${equivalentResult.stdout || ''}${equivalentResult.stderr || ''}`,
    );

    const mismatchedResult = runDatabaseCheck(primaryUrl.toString(), {
      directConnectionString: differentUrl.toString(),
      args: ['--migrate-only'],
    });
    const mismatchedOutput = `${mismatchedResult.stdout || ''}\n${mismatchedResult.stderr || ''}`;
    assert.notEqual(mismatchedResult.status, 0, 'A different migration schema was accepted.');
    assert.match(mismatchedOutput, /same PostgreSQL cluster, database, and schema as DATABASE_URL/);

    const migrationTable = await client.query(
      `SELECT to_regclass(format('%I.%I', $1::text, '_prisma_migrations'::text)) AS relation`,
      [directSchema],
    );
    assert.equal(migrationTable.rows[0].relation, null);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA ${quoteIdentifier(primarySchema)} CASCADE`);
    await client.query(`DROP SCHEMA ${quoteIdentifier(directSchema)} CASCADE`);
  }
}

function assertDatabaseCheckRejects(connectionString) {
  const result = runDatabaseCheck(connectionString);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  assert.notEqual(result.status, 0, 'Database validation accepted a tampered schema.');
  assert.match(output, /Database schema is incomplete after migration/);
}

async function runPreMigrationLedgerGuardScenario() {
  const schema = `analytics_migration_preflight_${crypto.randomBytes(4).toString('hex')}`;
  const quotedSchema = quoteIdentifier(schema);
  const rehearsalUrl = new URL(databaseUrl);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-migration-preflight-'));
  const fixturePrisma = path.join(fixtureRoot, 'prisma');

  rehearsalUrl.searchParams.set('schema', schema);
  fs.cpSync(path.join(repositoryRoot, 'prisma'), fixturePrisma, { recursive: true });
  fs.rmSync(path.join(fixturePrisma, 'migrations/27_remove_redundant_board_primary_key_index'), {
    force: true,
    recursive: true,
  });
  await client.query(`CREATE SCHEMA ${quotedSchema}`);

  try {
    runPrismaMigrate(rehearsalUrl.toString(), path.join(fixturePrisma, 'schema.prisma'));
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await client.query(
      `UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = '16_boards'`,
      ['0'.repeat(64)],
    );
    assert.notEqual(await readIndex('board_board_id_key'), null);
    await client.query('SET search_path TO public');

    const result = runDatabaseCheck(rehearsalUrl.toString());
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;

    assert.notEqual(result.status, 0, 'Database validation accepted mismatched applied history.');
    assert.match(output, /does not match this release/);

    await client.query(`SET search_path TO ${quotedSchema}, public`);
    const pendingMigration = await client.query(
      `SELECT 1 FROM _prisma_migrations WHERE migration_name = $1`,
      ['27_remove_redundant_board_primary_key_index'],
    );
    assert.equal(pendingMigration.rowCount, 0);
    assert.notEqual(await readIndex('board_board_id_key'), null);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

async function runHistoricalLedgerReplayScenario() {
  const schema = `analytics_migration_ledger_${crypto.randomBytes(4).toString('hex')}`;
  const quotedSchema = quoteIdentifier(schema);
  const rehearsalUrl = new URL(databaseUrl);
  rehearsalUrl.searchParams.set('schema', schema);
  const bridgeMigrations = [
    '22_prepare_session_data_index_rebuild',
    '25_finalize_session_data_index_rebuild',
    '27_remove_redundant_board_primary_key_index',
  ];

  await client.query(`CREATE SCHEMA ${quotedSchema}`);

  try {
    runPrismaMigrate(rehearsalUrl.toString());
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await client.query(
      `
      CREATE TABLE _audit_ledger_before AS
      SELECT *
      FROM _prisma_migrations
      WHERE migration_name <> ALL($1::text[])
    `,
      [bridgeMigrations],
    );
    await client.query('DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])', [
      bridgeMigrations,
    ]);
    await client.query('CREATE UNIQUE INDEX board_board_id_key ON board(board_id)');
    await client.query('SET search_path TO public');

    runPrismaMigrate(rehearsalUrl.toString());
    await client.query(`SET search_path TO ${quotedSchema}, public`);

    const ledgerDifferences = await client.query(
      `
      SELECT COUNT(*)::int AS count
      FROM (
        (SELECT * FROM _audit_ledger_before EXCEPT SELECT * FROM _prisma_migrations)
        UNION ALL
        (
          SELECT *
          FROM _prisma_migrations
          WHERE migration_name <> ALL($1::text[])
          EXCEPT SELECT * FROM _audit_ledger_before
        )
      ) differences
    `,
      [bridgeMigrations],
    );
    assert.equal(ledgerDifferences.rows[0].count, 0);

    const restoredChecksums = await client.query(
      `
      SELECT migration_name, checksum
      FROM _prisma_migrations
      WHERE migration_name = ANY($1::text[])
      ORDER BY migration_name
    `,
      [historicalMigrationNames],
    );
    assert.deepEqual(
      restoredChecksums.rows,
      historicalMigrationNames.map(migrationName => ({
        migration_name: migrationName,
        checksum: migrationLedgerContract.checksums.get(migrationName),
      })),
    );

    const appliedBridges = await client.query(
      `
      SELECT migration_name
      FROM _prisma_migrations
      WHERE migration_name = ANY($1::text[])
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL
      ORDER BY migration_name
    `,
      [bridgeMigrations],
    );
    assert.deepEqual(
      appliedBridges.rows.map(({ migration_name }) => migration_name),
      bridgeMigrations,
    );

    assert.deepEqual(await readIndex(canonicalIndex), {
      unique: true,
      valid: true,
      ready: true,
      first_column: 'session_id',
      second_column: 'data_key',
    });
    assert.equal(await readIndex(legacyIndex), null);
    assert.equal(await readIndex('board_board_id_key'), null);
    assert.notEqual(await readIndex('board_pkey'), null);

    await client.query(`DROP INDEX ${quoteIdentifier(canonicalIndex)}`);
    await client.query(
      `CREATE UNIQUE INDEX ${quoteIdentifier(canonicalIndex)} ON session_data(data_key, session_id)`,
    );
    assertDatabaseCheckRejects(rehearsalUrl.toString());
    await client.query(`DROP INDEX ${quoteIdentifier(canonicalIndex)}`);
    await client.query(
      `CREATE UNIQUE INDEX ${quoteIdentifier(canonicalIndex)} ON session_data(session_id, data_key)`,
    );

    await client.query('ALTER TABLE "user" DROP CONSTRAINT user_role_check');
    await client.query('ALTER TABLE "user" ADD CONSTRAINT user_role_check CHECK (true)');
    assertDatabaseCheckRejects(rehearsalUrl.toString());
    await client.query('ALTER TABLE "user" DROP CONSTRAINT user_role_check');
    await client.query(`
      ALTER TABLE "user"
      ADD CONSTRAINT user_role_check
      CHECK ("role" IN ('admin', 'user', 'view-only'))
    `);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
  }
}

try {
  await client.connect();

  const rows = [
    ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'site'],
    ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012', 'site'],
  ];

  await runSessionScenario(
    'canonical',
    async () => {
      for (const [id, sessionId, key] of rows) {
        await client.query(
          'INSERT INTO session_data (session_data_id, session_id, data_key) VALUES ($1, $2, $3)',
          [id, sessionId, key],
        );
      }
      await client.query(
        `CREATE UNIQUE INDEX ${quoteIdentifier(canonicalIndex)} ON session_data(session_id, data_key)`,
      );
    },
    2,
  );

  await runSessionScenario(
    'recovery',
    async () => {
      for (const [id, sessionId, key] of rows) {
        await client.query(
          'INSERT INTO session_data (session_data_id, session_id, data_key) VALUES ($1, $2, $3)',
          [id, sessionId, key],
        );
      }
      await client.query(
        `CREATE UNIQUE INDEX ${quoteIdentifier(canonicalIndex)} ON session_data(session_id, data_key)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX ${quoteIdentifier(legacyIndex)} ON session_data(session_id, data_key)`,
      );
    },
    2,
  );

  await runSessionScenario(
    'duplicates',
    () =>
      client.query(`
        INSERT INTO session_data (session_data_id, session_id, data_key, created_at)
        VALUES
          ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000031', 'site', '2026-09-20T00:00:00Z'),
          ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000031', 'site', '2026-09-21T00:00:00Z'),
          ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000032', 'site', '2026-09-21T00:00:00Z')
      `),
    2,
  );

  await runRejectedSessionScenario(
    'wrong_columns',
    () =>
      client.query(
        `CREATE UNIQUE INDEX ${quoteIdentifier(canonicalIndex)} ON session_data(data_key, session_id)`,
      ),
    /does not match the reviewed unique index/,
  );

  await runBoardScenario('board_expected', () =>
    client.query('CREATE UNIQUE INDEX board_board_id_key ON board(board_id)'),
  );
  await runBoardScenario('board_absent', async () => {});
  await runBoardScenario(
    'board_wrong_column',
    () => client.query('CREATE UNIQUE INDEX board_board_id_key ON board(slug)'),
    /does not match the reviewed redundant index/,
  );
  await runFinalizeRollbackScenario();

  await runMigrationTargetIdentityScenario();
  await runPreMigrationLedgerGuardScenario();
  await runHistoricalLedgerReplayScenario();

  console.log(
    'Verified the migration repair across eight isolated SQL scenarios, one target-identity guard, one pre-migration ledger guard, and one production-shaped ledger replay.',
  );
} finally {
  await client.end();
}
