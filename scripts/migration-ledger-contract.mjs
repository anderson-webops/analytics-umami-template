import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CONTRACT_PATH = path.join('prisma', 'migration-ledger-contract.json');
const SAFE_MIGRATION_NAME = /^[0-9][A-Za-z0-9_]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

async function requirePlainFile(absolutePath, label) {
  const metadata = await fs.lstat(absolutePath);

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link or special path.`);
  }

  return fs.readFile(absolutePath);
}

export async function verifyMigrationLedgerContract(repositoryRoot = process.cwd()) {
  const root = await fs.realpath(repositoryRoot);
  const contractBytes = await requirePlainFile(
    path.join(root, CONTRACT_PATH),
    'Migration ledger contract',
  );
  let contract;

  try {
    contract = JSON.parse(contractBytes.toString('utf8'));
  } catch {
    throw new Error('Migration ledger contract must contain valid JSON.');
  }

  if (
    contract?.schemaVersion !== 1 ||
    typeof contract.repository !== 'string' ||
    !contract.repository.trim() ||
    !contract.migrations ||
    typeof contract.migrations !== 'object' ||
    Array.isArray(contract.migrations)
  ) {
    throw new Error('Migration ledger contract has an unsupported structure.');
  }

  const entries = Object.entries(contract.migrations);

  if (entries.length === 0) {
    throw new Error('Migration ledger contract must pin at least one historical migration.');
  }

  const checksums = new Map();

  for (const [migrationName, expectedChecksum] of entries) {
    if (!SAFE_MIGRATION_NAME.test(migrationName) || !SHA256.test(expectedChecksum)) {
      throw new Error(`Migration ledger contract contains an invalid entry: ${migrationName}.`);
    }

    const migrationDirectory = path.join(root, 'prisma', 'migrations', migrationName);
    const directoryMetadata = await fs.lstat(migrationDirectory);

    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error(`Migration directory must be a real directory: ${migrationName}.`);
    }

    const migrationBytes = await requirePlainFile(
      path.join(migrationDirectory, 'migration.sql'),
      `Migration ${migrationName}`,
    );
    const actualChecksum = crypto.createHash('sha256').update(migrationBytes).digest('hex');

    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Migration ${migrationName} does not match this repository's successful ledger contract.`,
      );
    }

    checksums.set(migrationName, expectedChecksum);
  }

  return {
    repository: contract.repository,
    checksums,
  };
}

async function main() {
  const result = await verifyMigrationLedgerContract();

  process.stdout.write(
    `Verified ${result.checksums.size} immutable migration checksums for ${result.repository}.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
