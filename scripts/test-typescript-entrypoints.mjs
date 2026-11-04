import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const entrypoints = {
  'openapi:generate': 'scripts/generate-openapi.ts',
  'openapi:contracts': 'scripts/generate-openapi-contracts.ts',
  'openapi:check': 'scripts/check-openapi.ts',
  'generate:api:client': 'scripts/generate-api-client.ts',
  'check:api:client': 'scripts/generate-api-client.ts --check',
  'test:collection-rate-limit': 'scripts/test-collection-rate-limit.ts',
  'test:api': 'scripts/test-api.ts',
  'test:api:clickhouse': 'scripts/test-api.ts --clickhouse',
  'test:api:up': 'scripts/test-api.ts --up-only',
  'test:api:down': 'scripts/test-api.ts --down',
  'test:api:coverage': 'scripts/test-api.ts --coverage-report',
  'db:seed': 'scripts/seed-data.ts',
};

test('noninteractive TypeScript commands use the installed loader without CLI IPC', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json')));
  for (const [name, entrypoint] of Object.entries(entrypoints)) {
    assert.equal(manifest.scripts[name], `node --import tsx ${entrypoint}`, name);
  }
});

test('multiprocess database checks also retain the direct-loader boundary', async () => {
  const collection = await fs.readFile(
    path.join(repositoryRoot, 'scripts/test-collection-rate-limit.ts'),
    'utf8',
  );
  assert.match(
    collection,
    /spawn\(\s*process\.execPath,\s*\['--import', 'tsx', 'scripts\/test-collection-rate-limit\.ts'\]/,
  );
  const restore = await fs.readFile(
    path.join(repositoryRoot, 'scripts/test-postgres-restore.mjs'),
    'utf8',
  );
  assert.match(
    restore,
    /run\(\s*process\.execPath,\s*\['--import', 'tsx', 'scripts\/provision-site\.ts'\]/,
  );
  const shell = await fs.readFile(
    path.join(repositoryRoot, 'scripts/test-postgres17-restore.sh'),
    'utf8',
  );
  assert.doesNotMatch(shell, /pnpm exec tsx/);
  assert.match(
    shell,
    /ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts\/test-two-factor-admission\.ts/,
  );
  assert.match(
    shell,
    /ALLOW_DESTRUCTIVE_MIGRATION_TEST=1 node --import tsx scripts\/test-password-verification-admission\.ts/,
  );
});

async function withFixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typescript-entry-'));
  const temporary = path.join(root, 'long-temporary-directory-'.repeat(7));
  await fs.mkdir(temporary);
  const configuration = path.join(root, 'tsconfig.json');
  await fs.writeFile(
    configuration,
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        target: 'ESNext',
        baseUrl: root,
        paths: { '@fixture/*': ['./*'] },
      },
    }),
  );
  const execute = (entrypoint, argumentsList = []) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entrypoint, ...argumentsList], {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: temporary,
        TSX_TSCONFIG_PATH: configuration,
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  try {
    await callback(root, execute);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('loader preserves TypeScript, aliases and literal arguments with a long temporary path', async () => {
  await withFixture(async (root, execute) => {
    const entrypoint = path.join(root, 'entry.ts');
    await fs.writeFile(path.join(root, 'value.ts'), 'export const answer: number = 42;\n');
    await fs.writeFile(
      entrypoint,
      "import { answer } from '@fixture/value';\nconst result: { answer: number } = { answer };\nconsole.log(JSON.stringify({ result, arguments: process.argv.slice(2) }));\n",
    );
    const result = execute(entrypoint, ['space separated', '--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      result: { answer: 42 },
      arguments: ['space separated', '--check'],
    });
  });
});

test('loader preserves a missing entrypoint failure', async () => {
  await withFixture(async (root, execute) => {
    const result = execute(path.join(root, 'missing.ts'));
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
  });
});

test('loader preserves application failures instead of reporting success', async () => {
  await withFixture(async (root, execute) => {
    const entrypoint = path.join(root, 'failure.ts');
    await fs.writeFile(entrypoint, "throw new Error('synthetic-entrypoint-failure');\n");
    const result = execute(entrypoint);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /synthetic-entrypoint-failure/);
  });
});
