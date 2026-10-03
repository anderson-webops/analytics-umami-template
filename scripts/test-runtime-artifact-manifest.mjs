import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  copyRuntimeArtifact,
  createRuntimeManifest,
  getSourceIdentity,
  sealRuntimeArtifact,
  verifyRuntimeArtifact,
} from './runtime-artifact.mjs';

const temporaryDirectories = [];
const source = { commit: 'a'.repeat(40), dirty: false };

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
