import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { verifyMigrationLedgerContract } from './migration-ledger-contract.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const runsRoot = path.join(repositoryRoot, '.ai-work', 'runs');

async function withFixture(callback) {
  await fs.mkdir(runsRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(runsRoot, 'migration-ledger-contract-'));

  try {
    await callback(root);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
}

async function writeFixture(root, migrationName = '16_boards', contents = 'SELECT 1;\n') {
  const migrationDirectory = path.join(root, 'prisma', 'migrations', migrationName);
  await fs.mkdir(migrationDirectory, { recursive: true });
  await fs.writeFile(path.join(migrationDirectory, 'migration.sql'), contents);
  await fs.writeFile(
    path.join(root, 'prisma', 'migration-ledger-contract.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: 'fixture',
        migrations: {
          [migrationName]: crypto.createHash('sha256').update(contents).digest('hex'),
        },
      },
      null,
      2,
    )}\n`,
  );
}

test('accepts exact repository-specific historical migration bytes', async () => {
  await withFixture(async root => {
    await writeFixture(root);
    const result = await verifyMigrationLedgerContract(root);

    assert.equal(result.repository, 'fixture');
    assert.equal(result.checksums.size, 1);
  });
});

test('rejects a historical migration changed after the contract was recorded', async () => {
  await withFixture(async root => {
    await writeFixture(root);
    await fs.writeFile(path.join(root, 'prisma/migrations/16_boards/migration.sql'), 'SELECT 2;\n');

    await assert.rejects(
      verifyMigrationLedgerContract(root),
      /does not match this repository's successful ledger contract/,
    );
  });
});

test('rejects migration names that could escape the migrations directory', async () => {
  await withFixture(async root => {
    await writeFixture(root);
    const contractPath = path.join(root, 'prisma/migration-ledger-contract.json');
    const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
    contract.migrations['../outside'] = '0'.repeat(64);
    await fs.writeFile(contractPath, `${JSON.stringify(contract)}\n`);

    await assert.rejects(verifyMigrationLedgerContract(root), /contains an invalid entry/);
  });
});

test('rejects linked migration files', async () => {
  await withFixture(async root => {
    await writeFixture(root);
    const migrationPath = path.join(root, 'prisma/migrations/16_boards/migration.sql');
    const linkedPath = path.join(root, 'linked.sql');
    await fs.writeFile(linkedPath, 'SELECT 1;\n');
    await fs.unlink(migrationPath);
    await fs.symlink(linkedPath, migrationPath);

    await assert.rejects(verifyMigrationLedgerContract(root), /regular file/);
  });
});
