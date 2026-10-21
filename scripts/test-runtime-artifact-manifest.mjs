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
const heatmapRetentionPaths = [
  'db/clickhouse/migrations/15_expire_new_heatmap_events.sql',
  'prisma/migrations/33_expire_new_heatmap_events/migration.sql',
  'runtime-scripts/prune-expired-heatmap-events.mjs',
];
const replayRetentionPaths = [
  'db/clickhouse/migrations/16_expire_new_session_replays.sql',
  'prisma/migrations/35_expire_new_session_replays/migration.sql',
  'runtime-scripts/prune-expired-session-replays.mjs',
];
const sessionTrustPaths = [
  'db/clickhouse/migrations/17_add_session_data_trust_tier.sql',
  'prisma/migrations/36_add_session_data_trust_tier/migration.sql',
];
const linkTrustPath = 'prisma/migrations/38_add_session_link_trust_tier/migration.sql';
const ownerBindingPath = 'prisma/migrations/39_bind_collection_keys_to_website_owner/migration.sql';
const eventTrustPaths = [
  'db/clickhouse/migrations/19_add_event_collection_trust_tier.sql',
  'db/clickhouse/migrations/20_add_verified_event_data_pivot.sql',
  'prisma/migrations/37_add_event_collection_trust_tier/migration.sql',
];
const revenueDisablePath =
  'db/clickhouse/migrations/18_disable_unverified_revenue_materialization.sql';
const attestedRevenuePath = 'prisma/migrations/40_add_attested_revenue_movement/migration.sql';

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

test('CI builds the production artifact on its declared architecture', async () => {
  const contract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  const workflow = await fs.readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.equal(contract.runtime.arch, 'arm64');
  assert.match(
    workflow,
    /^ {2}validate:\n {4}name: Source validation\n {4}runs-on: ubuntu-24\.04-arm$/m,
  );
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
    deployment: {
      ...templateContract.deployment,
      schemaVersion: 1,
      database: {
        ...templateContract.deployment.database,
        prePromotionGate: 'scripts/check-db.js',
      },
      requiredAdapterCapabilities: templateContract.deployment.requiredAdapterCapabilities.filter(
        capability =>
          capability !== 'bounded-heatmap-retention-v1' &&
          capability !== 'bounded-replay-retention-v1' &&
          capability !== 'packaged-migration-tool-v1' &&
          capability !== 'authenticated-advanced-collection-v1' &&
          capability !== 'owner-bound-collection-keys-v1' &&
          capability !== 'session-property-trust-tier-v1' &&
          capability !== 'identity-link-trust-tier-v1' &&
          capability !== 'event-claim-trust-tier-v1' &&
          capability !== 'unverified-revenue-materialization-disabled-v1' &&
          capability !== 'attested-revenue-ledger-v1',
      ),
    },
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

async function addHeatmapRetentionFixture(root, contractPath) {
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.schemaVersion = 2;
  contract.deployment.requiredAdapterCapabilities.push('bounded-heatmap-retention-v1');
  for (const file of heatmapRetentionPaths) {
    const allowedRoot = file.split('/')[0];
    if (!contract.allowedRoots.includes(allowedRoot)) {
      contract.allowedRoots.push(allowedRoot);
    }
    contract.requiredFiles.push(file);
    const fullPath = path.join(root, file);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, 'synthetic retention file\n');
  }
  await fs.writeFile(contractPath, JSON.stringify(contract));
}

async function addReplayRetentionFixture(root, contractPath) {
  await addHeatmapRetentionFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.schemaVersion = 3;
  contract.deployment.requiredAdapterCapabilities.push('bounded-replay-retention-v1');
  for (const file of replayRetentionPaths) {
    const allowedRoot = file.split('/')[0];
    if (!contract.allowedRoots.includes(allowedRoot)) {
      contract.allowedRoots.push(allowedRoot);
    }
    contract.requiredFiles.push(file);
    const fullPath = path.join(root, file);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, 'synthetic replay retention file\n');
  }
  await fs.writeFile(contractPath, JSON.stringify(contract));
}

async function addSessionTrustFixture(root, contractPath) {
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities.push('session-property-trust-tier-v1');
  for (const file of sessionTrustPaths) {
    const allowedRoot = file.split('/')[0];
    if (!contract.allowedRoots.includes(allowedRoot)) {
      contract.allowedRoots.push(allowedRoot);
    }
    contract.requiredFiles.push(file);
    const fullPath = path.join(root, file);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, 'synthetic trust-tier migration\n');
  }
  await fs.writeFile(contractPath, JSON.stringify(contract));
}

async function addLinkTrustFixture(root, contractPath) {
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities.push('identity-link-trust-tier-v1');
  contract.allowedRoots.push('prisma');
  contract.requiredFiles.push(linkTrustPath);
  const fullPath = path.join(root, linkTrustPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, 'synthetic link trust-tier migration\n');
  await fs.writeFile(contractPath, JSON.stringify(contract));
}

async function addOwnerBindingFixture(root, contractPath) {
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities.push('owner-bound-collection-keys-v1');
  contract.allowedRoots.push('prisma');
  contract.requiredFiles.push(ownerBindingPath);
  const fullPath = path.join(root, ownerBindingPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, 'synthetic owner-binding migration\n');
  await fs.writeFile(contractPath, JSON.stringify(contract));
}

async function addEventTrustFixture(root, contractPath) {
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities.push('event-claim-trust-tier-v1');
  for (const file of eventTrustPaths) {
    const allowedRoot = file.split('/')[0];
    if (!contract.allowedRoots.includes(allowedRoot)) {
      contract.allowedRoots.push(allowedRoot);
    }
    contract.requiredFiles.push(file);
    const fullPath = path.join(root, file);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, 'synthetic event trust-tier migration\n');
  }
  await fs.writeFile(contractPath, JSON.stringify(contract));
}

async function addRevenueDisableFixture(root, contractPath) {
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.allowedRoots.push('db');
  contract.requiredFiles.push(revenueDisablePath);
  contract.deployment.requiredAdapterCapabilities.push(
    'unverified-revenue-materialization-disabled-v1',
  );
  const fullPath = path.join(root, revenueDisablePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, 'synthetic revenue-disable migration\n');
  await fs.writeFile(contractPath, JSON.stringify(contract));
}

async function addAttestedRevenueFixture(root, contractPath) {
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.allowedRoots.push('prisma');
  contract.requiredFiles.push(attestedRevenuePath);
  contract.deployment.requiredAdapterCapabilities.push('attested-revenue-ledger-v1');
  const fullPath = path.join(root, attestedRevenuePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, 'synthetic attested revenue migration\n');
  await fs.writeFile(contractPath, JSON.stringify(contract));
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
  assert.ok(
    contract.deployment.requiredAdapterCapabilities.includes('legacy-clickhouse-erasure-review-v1'),
  );
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

test('heatmap retention files require complete packaging and host capability', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(heatmapRetentionPaths.every(file => trustedContract.requiredFiles.includes(file)));
  assert.equal(trustedContract.deployment.schemaVersion, 4);
  assert.ok(
    trustedContract.deployment.requiredAdapterCapabilities.includes('bounded-heatmap-retention-v1'),
  );

  const { root, contractPath } = await createFixture();
  await addHeatmapRetentionFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'bounded-heatmap-retention-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles = contract.requiredFiles.filter(
    file => !heatmapRetentionPaths.includes(file),
  );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push('bounded-heatmap-retention-v1');
  contract.requiredFiles.push(...heatmapRetentionPaths.slice(0, -1));
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(heatmapRetentionPaths.at(-1));
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });
});

test('replay retention files require complete packaging and host capability', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(replayRetentionPaths.every(file => trustedContract.requiredFiles.includes(file)));
  assert.equal(trustedContract.deployment.schemaVersion, 4);
  assert.ok(
    trustedContract.deployment.requiredAdapterCapabilities.includes('bounded-replay-retention-v1'),
  );

  const { root, contractPath } = await createFixture();
  await addReplayRetentionFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'bounded-replay-retention-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles = contract.requiredFiles.filter(
    file => !replayRetentionPaths.includes(file),
  );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(...replayRetentionPaths);
  contract.deployment.requiredAdapterCapabilities.push('bounded-replay-retention-v1');
  contract.requiredFiles = contract.requiredFiles.filter(
    file => file !== replayRetentionPaths.at(-1),
  );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(replayRetentionPaths.at(-1));
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });

  contract.deployment.schemaVersion = 2;
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });

  contract.deployment.schemaVersion = 1;
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'bounded-heatmap-retention-v1',
    );
  contract.requiredFiles = contract.requiredFiles.filter(
    file => !heatmapRetentionPaths.includes(file),
  );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );
});

test('session trust-tier migrations require complete packaging and host capability', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(sessionTrustPaths.every(file => trustedContract.requiredFiles.includes(file)));
  assert.ok(
    trustedContract.deployment.requiredAdapterCapabilities.includes(
      'session-property-trust-tier-v1',
    ),
  );

  const { root, contractPath } = await createFixture();
  await addSessionTrustFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'session-property-trust-tier-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push('session-property-trust-tier-v1');
  contract.requiredFiles = contract.requiredFiles.filter(file => file !== sessionTrustPaths[1]);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(sessionTrustPaths[1]);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });
});

test('identity-link trust migration requires complete packaging and host capability', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes(linkTrustPath));
  assert.ok(
    trustedContract.deployment.requiredAdapterCapabilities.includes('identity-link-trust-tier-v1'),
  );

  const { root, contractPath } = await createFixture();
  await addLinkTrustFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'identity-link-trust-tier-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push('identity-link-trust-tier-v1');
  contract.requiredFiles = contract.requiredFiles.filter(file => file !== linkTrustPath);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(linkTrustPath);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });
});

test('owner-bound collection keys require complete packaging and host capability', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes(ownerBindingPath));
  assert.ok(
    trustedContract.deployment.requiredAdapterCapabilities.includes(
      'owner-bound-collection-keys-v1',
    ),
  );

  const { root, contractPath } = await createFixture();
  await addOwnerBindingFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'owner-bound-collection-keys-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push('owner-bound-collection-keys-v1');
  contract.requiredFiles = contract.requiredFiles.filter(file => file !== ownerBindingPath);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(ownerBindingPath);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });
});

test('event trust-tier migrations require complete packaging and host capability', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(eventTrustPaths.every(file => trustedContract.requiredFiles.includes(file)));
  assert.ok(
    trustedContract.deployment.requiredAdapterCapabilities.includes('event-claim-trust-tier-v1'),
  );

  const { root, contractPath } = await createFixture();
  await addEventTrustFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'event-claim-trust-tier-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push('event-claim-trust-tier-v1');
  contract.requiredFiles = contract.requiredFiles.filter(file => file !== eventTrustPaths[1]);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(eventTrustPaths[1]);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });
});

test('revenue materialization disablement requires packaging and host capability', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes(revenueDisablePath));
  assert.ok(
    trustedContract.deployment.requiredAdapterCapabilities.includes(
      'unverified-revenue-materialization-disabled-v1',
    ),
  );

  const { root, contractPath } = await createFixture();
  await addRevenueDisableFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'unverified-revenue-materialization-disabled-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push(
    'unverified-revenue-materialization-disabled-v1',
  );
  contract.requiredFiles = contract.requiredFiles.filter(file => file !== revenueDisablePath);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(revenueDisablePath);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });
});

test('attested revenue ledger requires packaging and host capability', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes(attestedRevenuePath));
  assert.ok(
    trustedContract.deployment.requiredAdapterCapabilities.includes('attested-revenue-ledger-v1'),
  );

  const { root, contractPath } = await createFixture();
  await addAttestedRevenueFixture(root, contractPath);
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.requiredAdapterCapabilities =
    contract.deployment.requiredAdapterCapabilities.filter(
      capability => capability !== 'attested-revenue-ledger-v1',
    );
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push('attested-revenue-ledger-v1');
  contract.requiredFiles = contract.requiredFiles.filter(file => file !== attestedRevenuePath);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.requiredFiles.push(attestedRevenuePath);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await createRuntimeManifest(root, { contractPath, source });
  await verifyRuntimeArtifact(root, { contractPath });
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

test('packaged migration gate requires its own schema, capability, and inventory', async () => {
  const trusted = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.equal(trusted.deployment.schemaVersion, 4);
  assert.equal(trusted.deployment.database.prePromotionGate, 'runtime-scripts/check-db.mjs');
  assert.ok(trusted.deployment.requiredAdapterCapabilities.includes('packaged-migration-tool-v1'));

  const { root, contractPath } = await createFixture();
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.deployment.schemaVersion = 4;
  contract.deployment.requiredAdapterCapabilities.push('packaged-migration-tool-v1');
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.database.prePromotionGate = 'runtime-scripts/check-db.mjs';
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /Incomplete packaged migration tool contract/,
  );
});

test('rejects a changed file even when the manifest itself is untouched', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  await fs.appendFile(path.join(root, 'server.js'), 'console.log("tampered");\n');

  await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), /inventory or file hashes/);
});

test('requires the pinned migration tool independently of the server entrypoint', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  const required = [
    'migration-tool/node_modules/prisma',
    'migration-tool/pnpm-lock.yaml',
    'migration-tool/prisma.config.ts',
  ];
  assert.ok(required.every(file => trustedContract.requiredFiles.includes(file)));
  assert.ok(
    trustedContract.requiredPatterns.some(requirement =>
      requirement.pattern.includes('schema-engine-linux-arm64-openssl-3.0.x'),
    ),
  );
  const prismaEntry =
    'migration-tool/node_modules/.pnpm/prisma@*/node_modules/prisma/build/index.js';
  assert.ok(
    trustedContract.requiredPatterns.some(requirement => requirement.pattern === prismaEntry),
  );

  const { root, contractPath } = await createFixture();
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.allowedRoots.push('migration-tool');
  contract.requiredPatterns.push({ pattern: prismaEntry, minimum: 1 });
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /Artifact pattern migration-tool\/node_modules\/\.pnpm\/prisma@\*\/node_modules\/prisma\/build\/index\.js matched 0/,
  );
});

test('requires the traced Linux replay CSS binding independently of the manifest inventory', async () => {
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  const tracedBinding =
    'node_modules/.pnpm/lightningcss@*/node_modules/lightningcss-linux-arm64-gnu';
  assert.deepEqual(
    trustedContract.requiredPatterns.find(requirement => requirement.pattern === tracedBinding),
    { pattern: tracedBinding, minimum: 1 },
  );

  const { root, contractPath } = await createFixture();
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.requiredPatterns.push({ pattern: tracedBinding, minimum: 1 });
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /Artifact pattern node_modules\/\.pnpm\/lightningcss@\*\/node_modules\/lightningcss-linux-arm64-gnu matched 0/,
  );
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

test('binds advanced-collection capability to the permit route and verifies its bytes', async () => {
  const route = '.next/server/app/api/collection-permit/route.js';
  const capability = 'authenticated-advanced-collection-v1';
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes(route));
  assert.ok(trustedContract.deployment.requiredAdapterCapabilities.includes(capability));

  const { root, contractPath } = await createFixture();
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.requiredFiles.push(route);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /deployment compatibility contract/,
  );

  contract.deployment.requiredAdapterCapabilities.push(capability);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await fs.mkdir(path.join(root, '.next/server/app/api/collection-permit'), { recursive: true });
  await fs.writeFile(path.join(root, route), 'export const route = "synthetic";\n');
  await createRuntimeManifest(root, { contractPath, source });
  await fs.rm(path.join(root, route));
  await assert.rejects(
    verifyRuntimeArtifact(root, { contractPath }),
    error => error instanceof Error && error.message.includes(`missing required file: ${route}`),
  );
});

test('attested revenue intake route is present in the unpacked runtime', async () => {
  const route = '.next/server/app/api/revenue/movements/route.js';
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes(route));

  const { root, contractPath } = await createFixture();
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.requiredFiles.push(route);
  await fs.writeFile(contractPath, JSON.stringify(contract));
  await fs.mkdir(path.dirname(path.join(root, route)), { recursive: true });
  await fs.writeFile(path.join(root, route), 'export const route = "synthetic";\n');
  await createRuntimeManifest(root, { contractPath, source });
  await fs.rm(path.join(root, route));
  await assert.rejects(
    verifyRuntimeArtifact(root, { contractPath }),
    error => error instanceof Error && error.message.includes(`missing required file: ${route}`),
  );
});

test('requires the bounded heatmap cleanup command in every runtime artifact', async () => {
  const requiredPath = 'runtime-scripts/prune-expired-heatmap-events.mjs';
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes(requiredPath));

  const { root, contractPath } = await createFixture();
  await addHeatmapRetentionFixture(root, contractPath);
  const fullPath = path.join(root, requiredPath);
  await createRuntimeManifest(root, { contractPath, source });

  await fs.rm(fullPath);
  const missingCommand = error =>
    error instanceof Error && error.message.includes(`missing required file: ${requiredPath}`);
  await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), missingCommand);
  await assert.rejects(createRuntimeManifest(root, { contractPath, source }), missingCommand);
});

test('requires the bounded replay cleanup command in every runtime artifact', async () => {
  const requiredPath = 'runtime-scripts/prune-expired-session-replays.mjs';
  const trustedContract = JSON.parse(
    await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
  );
  assert.ok(trustedContract.requiredFiles.includes(requiredPath));

  const { root, contractPath } = await createFixture();
  await addReplayRetentionFixture(root, contractPath);
  await createRuntimeManifest(root, { contractPath, source });
  await fs.rm(path.join(root, requiredPath));

  const missingCommand = error =>
    error instanceof Error && error.message.includes(`missing required file: ${requiredPath}`);
  await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), missingCommand);
  await assert.rejects(createRuntimeManifest(root, { contractPath, source }), missingCommand);
});

for (const migrationPath of [
  'db/clickhouse/migrations/15_expire_new_heatmap_events.sql',
  'db/clickhouse/migrations/16_expire_new_session_replays.sql',
  'db/clickhouse/migrations/17_add_session_data_trust_tier.sql',
  'db/clickhouse/migrations/18_disable_unverified_revenue_materialization.sql',
  'db/clickhouse/migrations/19_add_event_collection_trust_tier.sql',
  'db/clickhouse/migrations/20_add_verified_event_data_pivot.sql',
  'prisma/migrations/30_revoke_sessions_on_factor_reset/migration.sql',
  'prisma/migrations/31_bound_event_ingestion/migration.sql',
  'prisma/migrations/32_expire_replay_visit_budgets/migration.sql',
  'prisma/migrations/33_expire_new_heatmap_events/migration.sql',
  'prisma/migrations/35_expire_new_session_replays/migration.sql',
  'prisma/migrations/36_add_session_data_trust_tier/migration.sql',
  'prisma/migrations/37_add_event_collection_trust_tier/migration.sql',
  'prisma/migrations/38_add_session_link_trust_tier/migration.sql',
  'prisma/migrations/39_bind_collection_keys_to_website_owner/migration.sql',
  'prisma/migrations/40_add_attested_revenue_movement/migration.sql',
]) {
  test(`requires ${migrationPath} in every runtime artifact`, async () => {
    const trustedContract = JSON.parse(
      await fs.readFile(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
    );
    assert.ok(trustedContract.requiredFiles.includes(migrationPath));

    const { root, contractPath } = await createFixture();
    if (heatmapRetentionPaths.includes(migrationPath)) {
      await addHeatmapRetentionFixture(root, contractPath);
    } else if (replayRetentionPaths.includes(migrationPath)) {
      await addReplayRetentionFixture(root, contractPath);
    } else if (sessionTrustPaths.includes(migrationPath)) {
      await addSessionTrustFixture(root, contractPath);
    } else if (migrationPath === linkTrustPath) {
      await addLinkTrustFixture(root, contractPath);
    } else if (migrationPath === ownerBindingPath) {
      await addOwnerBindingFixture(root, contractPath);
    } else if (migrationPath === attestedRevenuePath) {
      await addAttestedRevenueFixture(root, contractPath);
    } else if (eventTrustPaths.includes(migrationPath)) {
      await addEventTrustFixture(root, contractPath);
    } else if (migrationPath === revenueDisablePath) {
      await addRevenueDisableFixture(root, contractPath);
    } else {
      const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
      contract.allowedRoots.push(migrationPath.split('/')[0]);
      contract.requiredFiles.push(migrationPath);
      await fs.writeFile(contractPath, JSON.stringify(contract));
    }
    const fullPath = path.join(root, migrationPath);
    if (
      !heatmapRetentionPaths.includes(migrationPath) &&
      !replayRetentionPaths.includes(migrationPath) &&
      migrationPath !== revenueDisablePath
    ) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, 'synthetic migration\n');
    }
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

test('copy refuses a case-folded alias of the source directory', async context => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  const alias = path.join(path.dirname(root), 'RUNTIME');
  const sourceMetadata = await fs.stat(root);
  const aliasMetadata = await fs.stat(alias).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });

  if (
    !aliasMetadata ||
    aliasMetadata.dev !== sourceMetadata.dev ||
    aliasMetadata.ino !== sourceMetadata.ino
  ) {
    return context.skip('The fixture filesystem is case-sensitive.');
  }

  await assert.rejects(
    copyRuntimeArtifact(root, alias, { contractPath }),
    /too broad or overlaps protected source/,
  );
  await verifyRuntimeArtifact(root, { contractPath });
});

test('copy refuses a symlinked destination ancestor without deleting its target', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  const fixture = path.dirname(root);
  const outside = path.join(fixture, 'unrelated', 'runtime');
  const staging = path.join(fixture, 'staging');
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(staging);
  await fs.writeFile(path.join(outside, 'preserve.txt'), 'unrelated contents\n');
  await fs.symlink(path.dirname(outside), path.join(staging, 'alias'));

  await assert.rejects(
    copyRuntimeArtifact(root, path.join(staging, 'alias', 'runtime'), { contractPath }),
    /trusted|symlink|ancestor/i,
  );
  assert.equal(
    await fs.readFile(path.join(outside, 'preserve.txt'), 'utf8'),
    'unrelated contents\n',
  );
});

test('copy refuses a group-writable destination parent before removing the old tree', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  const staging = path.join(path.dirname(root), 'staging');
  const destination = path.join(staging, 'runtime');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'preserve.txt'), 'old contents\n');
  await fs.chmod(staging, 0o777);

  await assert.rejects(
    copyRuntimeArtifact(root, destination, { contractPath }),
    /trusted|writable|ancestor/i,
  );
  assert.equal(await fs.readFile(path.join(destination, 'preserve.txt'), 'utf8'), 'old contents\n');
});

test('copy refuses a replaceable ancestor above an otherwise protected parent', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  const staging = path.join(path.dirname(root), 'staging');
  const destination = path.join(staging, 'protected', 'runtime');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'preserve.txt'), 'old contents\n');
  await fs.chmod(staging, 0o777);

  await assert.rejects(
    copyRuntimeArtifact(root, destination, { contractPath }),
    /writable destination ancestor/i,
  );
  assert.equal(await fs.readFile(path.join(destination, 'preserve.txt'), 'utf8'), 'old contents\n');
});

test('copy refuses a symlink at the destination itself', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  const fixture = path.dirname(root);
  const staging = path.join(fixture, 'staging');
  const outside = path.join(fixture, 'unrelated');
  await fs.mkdir(staging);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'preserve.txt'), 'unrelated contents\n');
  await fs.symlink(outside, path.join(staging, 'runtime'));

  await assert.rejects(
    copyRuntimeArtifact(root, path.join(staging, 'runtime'), { contractPath }),
    /destination is not a trusted directory/i,
  );
  assert.equal(
    await fs.readFile(path.join(outside, 'preserve.txt'), 'utf8'),
    'unrelated contents\n',
  );
});

test('copy replaces an old tree beneath a protected parent and rechecks its manifest', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  const staging = path.join(path.dirname(root), 'staging');
  const destination = path.join(staging, 'runtime');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'obsolete.txt'), 'old contents\n');

  const manifest = await copyRuntimeArtifact(root, destination, { contractPath });

  assert.equal(manifest.source.commit, source.commit);
  await assert.rejects(fs.access(path.join(destination, 'obsolete.txt')), { code: 'ENOENT' });
  await verifyRuntimeArtifact(destination, { contractPath });
  assert.deepEqual(await fs.readdir(staging), ['runtime']);
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
