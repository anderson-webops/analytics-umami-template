import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_LIMITS,
  copyRuntimeArtifact,
  createRuntimeManifest,
  getSourceIdentity,
  sealRuntimeArtifact,
  verifyRuntimeArtifact,
} from './runtime-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];
const source = { commit: 'a'.repeat(40), dirty: false };

test('generated API client version matches the application release', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const generated = await fs.readFile(
    new URL('../packages/api-client/src/generated/operations.ts', import.meta.url),
    'utf8',
  );
  const generatedVersion = generated.match(/^export const API_VERSION = '([^']+)';$/m)?.[1];

  assert.equal(generatedVersion, packageJson.version);
});

async function createFixture() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'umami-runtime-artifact-'));
  const root = path.join(fixture, 'runtime');
  const contractPath = path.join(fixture, 'contract.json');
  const templateContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  const contract = {
    version: 1,
    manifest: 'runtime-manifest.json',
    entrypoints: ['server.js'],
    requiredFiles: ['package.json', 'pnpm-lock.yaml', 'server.js'],
    requiredDirectories: ['.next/cache'],
    requiredPatterns: [{ pattern: 'node_modules/*/package.json', minimum: 1 }],
    allowedRoots: ['.next', 'node_modules'],
    allowedFiles: ['package.json', 'pnpm-lock.yaml', 'server.js'],
    forbiddenStateTrees: ['.next/cache', 'uploads'],
    runtime: { os: 'linux', arch: 'arm64', libc: 'glibc', node: '24.18.1' },
    deployment: templateContract.deployment,
  };

  temporaryDirectories.push(fixture);
  await fs.mkdir(path.join(root, '.next', 'cache'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'next'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"1.0.0"}\n');
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fs.writeFile(path.join(root, 'server.js'), 'console.log("ok");\n');
  await fs.writeFile(path.join(root, 'node_modules', 'next', 'package.json'), '{}\n');
  await fs.writeFile(contractPath, JSON.stringify(contract));

  return { root, contractPath };
}

afterEach(async () => {
  async function writable(directory) {
    const stat = await fs.lstat(directory);
    if (stat.isDirectory()) {
      await fs.chmod(directory, 0o700);
      for (const child of await fs.readdir(directory)) await writable(path.join(directory, child));
    }
  }
  for (const directory of temporaryDirectories) await writable(directory);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true })),
  );
});

test('sealing preserves verified hashes, identity and links while declaring only immutable modes', async () => {
  const { root, contractPath } = await createFixture();
  await fs.chmod(path.join(root, 'server.js'), 0o750);
  const before = await createRuntimeManifest(root, { contractPath, source });
  const after = await sealRuntimeArtifact(root, { contractPath, expectedCommit: source.commit });
  assert.deepEqual(after.source, before.source);
  assert.equal(after.createdAt, before.createdAt);
  for (const [name, original] of Object.entries(before.entries)) {
    const { mode: _originalMode, ...originalPayload } = original;
    const { mode: _finalMode, ...finalPayload } = after.entries[name];
    assert.deepEqual(finalPayload, originalPayload);
  }
  assert.equal(after.entries['server.js'].mode, '0555');
  assert.equal(after.entries['package.json'].mode, '0444');
  assert.equal((await fs.stat(path.join(root, 'runtime-manifest.json'))).mode & 0o777, 0o444);
  await verifyRuntimeArtifact(root, { contractPath });
});

test('sealing never blesses a changed payload or an unexpected source identity', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  await assert.rejects(
    sealRuntimeArtifact(root, { contractPath, expectedCommit: 'b'.repeat(40) }),
    /source commit/,
  );
  await fs.appendFile(path.join(root, 'server.js'), 'changed');
  await assert.rejects(sealRuntimeArtifact(root, { contractPath }), /inventory or file hashes/);
});

test('canonical materialization supplies genuine clean Git metadata with independent objects', async () => {
  const { root } = await createFixture();
  const fixture = path.dirname(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Synthetic Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const bare = path.join(fixture, 'canonical.git');
  execFileSync('git', ['clone', '--quiet', '--bare', '--no-hardlinks', root, bare]);
  const checkout = path.join(fixture, 'checkout');
  await fs.mkdir(checkout);
  execFileSync('bash', ['scripts/materialize-canonical-source.sh', bare, revision, checkout]);
  assert.deepEqual(getSourceIdentity(checkout), { commit: revision, dirty: false });
  await fs.rm(bare, { recursive: true });
  assert.deepEqual(getSourceIdentity(checkout), { commit: revision, dirty: false });
  await assert.rejects(fs.stat(path.join(checkout, '.git/objects/info/alternates')), {
    code: 'ENOENT',
  });
});

test('creates and verifies an exact hashed runtime inventory', async () => {
  const { root, contractPath } = await createFixture();
  const manifest = await createRuntimeManifest(root, { contractPath, source });

  assert.deepEqual(
    {
      commit: manifest.source.commit,
      dirty: manifest.source.dirty,
      version: manifest.source.version,
    },
    { commit: source.commit, dirty: false, version: '1.0.0' },
  );
  const verified = await verifyRuntimeArtifact(root, { contractPath });
  const expectedApplicationId = JSON.parse(await fs.readFile(contractPath, 'utf8')).deployment
    .applicationId;
  assert.equal(verified.source.commit, source.commit);
  assert.equal(verified.deployment.schemaVersion, 1);
  assert.equal(verified.deployment.applicationId, expectedApplicationId);
  await assert.rejects(
    verifyRuntimeArtifact(root, {
      contractPath,
      expectedApplicationId: `${expectedApplicationId}-other`,
    }),
    /application identity/,
  );
  assert.deepEqual(verified.deployment.probes.readiness, {
    path: '/readyz',
    methods: ['GET', 'HEAD'],
    success: 200,
    failure: 503,
  });
});

test('streams multi-chunk files without changing their recorded hashes', async () => {
  const { root, contractPath } = await createFixture();
  const contents = Buffer.alloc(256 * 1024 + 7, 0x5a);
  await fs.writeFile(path.join(root, 'server.js'), contents);

  const manifest = await createRuntimeManifest(root, { contractPath, source });

  assert.equal(
    manifest.entries['server.js'].sha256,
    createHash('sha256').update(contents).digest('hex'),
  );
  await verifyRuntimeArtifact(root, { contractPath });
});

test('rejects oversized sparse files before hashing them', async () => {
  const { root, contractPath } = await createFixture();
  const oversized = path.join(root, 'node_modules', 'next', 'oversized.bin');
  await fs.writeFile(oversized, '');
  await fs.truncate(oversized, ARTIFACT_LIMITS.fileBytes + 1);

  await assert.rejects(createRuntimeManifest(root, { contractPath, source }), /reviewed limit/);
});

test('rejects oversized and linked manifests before parsing them', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  const manifestPath = path.join(root, 'runtime-manifest.json');
  await fs.truncate(manifestPath, ARTIFACT_LIMITS.manifestBytes + 1);
  await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), /reviewed limit/);

  await fs.rm(manifestPath);
  await fs.symlink(path.join(root, 'package.json'), manifestPath);
  await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), { code: 'ELOOP' });
});

test('rejects deeply nested artifact paths', async () => {
  const { root, contractPath } = await createFixture();
  let directory = path.join(root, 'node_modules', 'next');

  for (let depth = 0; depth <= ARTIFACT_LIMITS.depth; depth += 1) {
    directory = path.join(directory, 'nested');
    await fs.mkdir(directory);
  }

  await assert.rejects(createRuntimeManifest(root, { contractPath, source }), /directory depth/);
});

test('rejects weakened deployment requirements in either the contract or manifest', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  const manifestPath = path.join(root, 'runtime-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.deployment.requiredAdapterCapabilities.pop();
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), /deployment requirements/);

  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.probes.readiness.failure = 200;
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );
});

test('accepts reviewed site-specific adapter gates but rejects unknown capabilities', async () => {
  const { root, contractPath } = await createFixture();
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities.push('coordinated-listener-transition-v1');
  await fs.writeFile(contractPath, JSON.stringify(contract));
  const manifest = await createRuntimeManifest(root, { contractPath, source });
  assert.ok(
    manifest.deployment.requiredAdapterCapabilities.includes('coordinated-listener-transition-v1'),
  );
  await verifyRuntimeArtifact(root, { contractPath });

  contract.deployment.requiredAdapterCapabilities.push('disable-authentication-v1');
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );
});

test('database-aware recovery requires its exact host capability and policy', async () => {
  const { root, contractPath } = await createFixture();
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.database.rollback = 'protected-pre-traffic-database-restore-v1';
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'database-aware-recovery-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push('database-aware-recovery-v1');
  await fs.writeFile(contractPath, JSON.stringify(contract));
  const manifest = await createRuntimeManifest(root, { contractPath, source });
  assert.equal(manifest.deployment.database.rollback, 'protected-pre-traffic-database-restore-v1');
  await verifyRuntimeArtifact(root, { contractPath });

  contract.deployment.database.rollback = 'rehearse-retained-runtime-against-migrated-copy';
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.database.rollback = 'restore-arbitrary-backup';
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );
});

test('rejects a changed file even when the manifest itself is untouched', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  await fs.appendFile(path.join(root, 'server.js'), 'console.log("tampered");\n');

  await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), /inventory or file hashes/);
});

test('rejects missing required modules and forbidden writable state', async () => {
  const { root, contractPath } = await createFixture();
  await fs.rm(path.join(root, 'server.js'));

  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /missing required file: server\.js/,
  );

  await fs.writeFile(path.join(root, 'server.js'), 'console.log("ok");\n');
  await fs.writeFile(path.join(root, '.next', 'cache', 'state.bin'), 'state');

  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /private or writable state/,
  );
});

test('requires the recorder bundle in the production artifact', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes('public/recorder.js'));

  const { root, contractPath } = await createFixture();
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.allowedRoots.push('public');
  contract.requiredFiles.push('public/recorder.js');
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await fs.mkdir(path.join(root, 'public'));
  await fs.writeFile(path.join(root, 'public', 'recorder.js'), 'console.log("recorder");\n');
  await createRuntimeManifest(root, { contractPath, source });

  await fs.rm(path.join(root, 'public', 'recorder.js'));
  await assert.rejects(
    verifyRuntimeArtifact(root, { contractPath }),
    /missing required file: public\/recorder\.js/,
  );
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /missing required file: public\/recorder\.js/,
  );
});

for (const migrationPath of [
  'prisma/migrations/30_revoke_sessions_on_factor_reset/migration.sql',
  'prisma/migrations/31_bound_event_ingestion/migration.sql',
  'prisma/migrations/32_expire_replay_visit_budgets/migration.sql',
]) {
  test(`requires ${migrationPath} in every runtime artifact`, async () => {
    const trustedContract = JSON.parse(
      await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
    );
    assert.ok(trustedContract.requiredFiles.includes(migrationPath));

    const { root, contractPath } = await createFixture();
    const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
    contract.allowedRoots.push('prisma');
    contract.requiredFiles.push(migrationPath);
    await fs.writeFile(contractPath, JSON.stringify(contract));
    const fullPath = path.join(root, migrationPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, 'synthetic migration\n');
    await createRuntimeManifest(root, { contractPath, source });

    await fs.rm(fullPath);
    const missingMigration = error =>
      error instanceof Error && error.message.includes(`missing required file: ${migrationPath}`);
    await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), missingMigration);
    await assert.rejects(createRuntimeManifest(root, { contractPath, source }), missingMigration);
  });
}

test('rejects symlinks that escape the artifact root', async () => {
  const { root, contractPath } = await createFixture();
  await fs.symlink('../../outside', path.join(root, 'node_modules', 'escape'));

  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /escapes the artifact root/,
  );
});

test('refuses broad or overlapping copy destinations', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });

  await assert.rejects(
    copyRuntimeArtifact(root, path.parse(root).root, { contractPath }),
    /too broad or overlaps protected source/,
  );
  await assert.rejects(
    copyRuntimeArtifact(root, path.join(root, 'nested', 'runtime'), { contractPath }),
    /too broad or overlaps protected source/,
  );
});

test('marks an otherwise clean checkout dirty when it contains an untracked source file', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'umami-runtime-source-'));
  temporaryDirectories.push(repository);
  await fs.writeFile(path.join(repository, 'tracked.txt'), 'tracked\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repository });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Runtime Test',
      '-c',
      'user.email=runtime-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: repository },
  );

  assert.equal(getSourceIdentity(repository).dirty, false);
  await fs.writeFile(path.join(repository, 'untracked.js'), 'console.log("untracked");\n');
  assert.equal(getSourceIdentity(repository).dirty, true);
});

test('environment commit cannot replace the checkout identity', () => {
  const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  const originalCommit = process.env.SOURCE_COMMIT;

  try {
    process.env.SOURCE_COMMIT = actualCommit;
    assert.equal(getSourceIdentity().commit, actualCommit);

    process.env.SOURCE_COMMIT = actualCommit === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40);
    assert.throws(() => getSourceIdentity(), /does not match the Git checkout/);
  } finally {
    if (originalCommit === undefined) {
      delete process.env.SOURCE_COMMIT;
    } else {
      process.env.SOURCE_COMMIT = originalCommit;
    }
  }
});
