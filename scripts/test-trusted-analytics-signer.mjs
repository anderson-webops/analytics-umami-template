import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { validatePublicConfiguration } from './mac-artifact-transport.mjs';
import {
  copyApprovedAsset,
  signManifestBytes,
  validateAnalyticsApproval,
  validateAnalyticsManifest,
  validateSignerEnvironment,
} from './trusted-analytics-signer.mjs';

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture(site = 'analytics.np-servicerequest.org') {
  const repository =
    site === 'analytics.example.com'
      ? 'anderson-webops/analytics-umami-template'
      : `anderson-webops/${site}`;
  const commit = 'a'.repeat(40);
  const tag = 'v4.2.185';
  const contractBytes = Buffer.from('{"version":1}\n');
  const approval = {
    schemaVersion: 1,
    site,
    repository,
    builderId: 'jacob-m3',
    commit,
    tree: 'b'.repeat(40),
    tag,
    sourceSha256: '1'.repeat(64),
    contractSha256: digest(contractBytes),
    acceptanceSha256: '2'.repeat(64),
    productionActivationAuthorized: false,
    assets: Object.fromEntries(
      [
        `${site}-${tag}-linux-arm64-runtime.tar.gz`,
        'anderson-runtime-manifest.json',
        'public-build-configuration.json',
        'acceptance-receipt.json',
      ].map(name => [name, { size: 12, sha256: '3'.repeat(64) }]),
    ),
  };
  const source = {
    repository,
    commit,
    tree: approval.tree,
    mainCommit: commit,
    tag,
    tagCommit: commit,
    tagType: 'tag',
    tagObject: 'c'.repeat(40),
    worktreeClean: true,
    packageVersion: tag.slice(1),
  };
  const acceptance = {
    commit,
    tag,
    target: 'linux-arm64-glibc',
    productionActivated: false,
    freshVmDestroyed: true,
    hostExchangeRestricted: true,
    isolatedUnpackedAcceptance: true,
    inventoryVerified: true,
    requiredModulesVerified: true,
    missingModuleRejected: true,
    postgresRestoreVerified: true,
    sourceChecksPassed: true,
    registrySignaturesVerified: true,
    noProviderEffects: true,
  };
  const configurationBytes = validatePublicConfiguration(
    {
      schema_version: 1,
      site,
      repository,
      environment: {
        PUBLIC_URL: `https://${site}`,
        CLIENT_IP_HEADER: 'x-real-ip',
        DISABLE_TELEMETRY: '1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
    site,
    repository,
  );
  const receipt = {
    commit,
    tag,
    checks: {
      dependency_audit: true,
      native_bindings: true,
      package_signatures: true,
      tests: true,
    },
  };
  const archiveName = `${site}-${tag}-linux-arm64-runtime.tar.gz`;
  const manifest = {
    schema_version: 1,
    site,
    repository,
    builder_id: 'jacob-m3',
    commit,
    version: tag.slice(1),
    tag,
    source_clean: true,
    runtime: {
      os: 'linux',
      architecture: 'arm64',
      libc: 'glibc',
      node: '24.18.1',
      npm: '12.0.2',
      package_manager: 'pnpm@11.18.0',
    },
    configuration_sha256: digest(configurationBytes),
    runtime_contract_sha256: digest(contractBytes),
    checks: receipt.checks,
    archive: { name: archiveName, ...approval.assets[archiveName] },
    files: [],
  };
  return { approval, source, acceptance, contractBytes, configurationBytes, receipt, manifest };
}

for (const site of [
  'analytics.example.com',
  'analytics.np-servicerequest.org',
  'analytics.mariettaviolinwithcarla.com',
  'analytics.retrozetrocomics.com',
  'analytics.jacobdanderson.net',
]) {
  test(`accepts only the reviewed source/acceptance identity for ${site}`, () => {
    const state = fixture(site);
    validateAnalyticsApproval(state.approval, state.source, state.acceptance, state.contractBytes);
    validateAnalyticsManifest(
      state.manifest,
      state.approval,
      state.receipt,
      state.configurationBytes,
      state.contractBytes,
    );
  });
}

for (const field of [
  'mainCommit',
  'tagCommit',
  'tree',
  'repository',
  'tagObject',
  'packageVersion',
  'worktreeClean',
]) {
  test(`rejects changed source ${field}`, () => {
    const state = fixture();
    state.source[field] = field === 'worktreeClean' ? false : 'changed';
    assert.throws(() =>
      validateAnalyticsApproval(
        state.approval,
        state.source,
        state.acceptance,
        state.contractBytes,
      ),
    );
  });
}

for (const field of [
  'freshVmDestroyed',
  'hostExchangeRestricted',
  'isolatedUnpackedAcceptance',
  'inventoryVerified',
  'requiredModulesVerified',
  'missingModuleRejected',
  'postgresRestoreVerified',
  'sourceChecksPassed',
  'registrySignaturesVerified',
  'noProviderEffects',
]) {
  test(`rejects missing independent ${field} acceptance`, () => {
    const state = fixture();
    state.acceptance[field] = false;
    assert.throws(() =>
      validateAnalyticsApproval(
        state.approval,
        state.source,
        state.acceptance,
        state.contractBytes,
      ),
    );
  });
}

test('rejects another application, an expanded asset set, oversized input and changed contract bytes', () => {
  const state = fixture('analytics.avasan.org');
  assert.throws(() =>
    validateAnalyticsApproval(state.approval, state.source, state.acceptance, state.contractBytes),
  );
  const valid = fixture();
  assert.throws(() =>
    validateAnalyticsApproval(valid.approval, valid.source, valid.acceptance, Buffer.from('{}')),
  );
  valid.approval.assets.extra = { size: 1, sha256: 'a'.repeat(64) };
  assert.throws(() =>
    validateAnalyticsApproval(valid.approval, valid.source, valid.acceptance, valid.contractBytes),
  );
  delete valid.approval.assets.extra;
  Object.values(valid.approval.assets)[0].size = 1024 * 1024 * 1024 + 1;
  assert.throws(() =>
    validateAnalyticsApproval(valid.approval, valid.source, valid.acceptance, valid.contractBytes),
  );
});

test('approval never authorizes production activation', () => {
  const state = fixture();
  state.approval.productionActivationAuthorized = true;
  assert.throws(() =>
    validateAnalyticsApproval(state.approval, state.source, state.acceptance, state.contractBytes),
  );
});

for (const field of ['dependency_audit', 'native_bindings', 'package_signatures', 'tests']) {
  test(`rejects a weakened ${field} release check`, () => {
    const state = fixture();
    state.manifest.checks[field] = false;
    assert.throws(() =>
      validateAnalyticsManifest(
        state.manifest,
        state.approval,
        state.receipt,
        state.configurationBytes,
        state.contractBytes,
      ),
    );
  });
}

test('rejects changed runtime, configuration, receipt and unknown envelope fields', () => {
  for (const mutate of [
    state => {
      state.manifest.runtime.node = '24.22.1';
    },
    state => {
      state.manifest.runtime.architecture = 'x64';
    },
    state => {
      state.manifest.configuration_sha256 = '9'.repeat(64);
    },
    state => {
      state.receipt.commit = '9'.repeat(40);
    },
    state => {
      state.manifest.source_clean = false;
    },
    state => {
      state.manifest.extra = true;
    },
  ]) {
    const state = fixture();
    mutate(state);
    assert.throws(() =>
      validateAnalyticsManifest(
        state.manifest,
        state.approval,
        state.receipt,
        state.configurationBytes,
        state.contractBytes,
      ),
    );
  }
});

test('copies only the approved single-link regular bytes without replacing an existing destination', async () => {
  const runs = path.resolve(import.meta.dirname, '../.ai-work/runs');
  await fs.mkdir(runs, { recursive: true });
  const directory = await fs.mkdtemp(path.join(runs, 'trusted-signer-test-'));
  try {
    const source = path.join(directory, 'source');
    const destination = path.join(directory, 'destination');
    const bytes = Buffer.from('synthetic-artifact');
    await fs.writeFile(source, bytes, { mode: 0o600 });
    const expected = { size: bytes.length, sha256: digest(bytes) };
    await copyApprovedAsset(source, destination, expected);
    assert.deepEqual(await fs.readFile(destination), bytes);
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    await assert.rejects(copyApprovedAsset(source, destination, expected));
    await assert.rejects(
      copyApprovedAsset(source, path.join(directory, 'wrong-hash'), {
        ...expected,
        sha256: 'f'.repeat(64),
      }),
    );
    const link = path.join(directory, 'link');
    await fs.symlink(source, link);
    await assert.rejects(copyApprovedAsset(link, path.join(directory, 'linked-copy'), expected));
    const hardlink = path.join(directory, 'hardlink');
    await fs.link(source, hardlink);
    await assert.rejects(
      copyApprovedAsset(source, path.join(directory, 'hardlinked-copy'), expected),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the detached Ed25519 signature binds exact bytes and clears only synthetic private input', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateBytes = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const fingerprint = digest(publicKey.export({ type: 'spki', format: 'der' }));
  const manifest = Buffer.from('{"synthetic":true}\n');

  const signature = signManifestBytes(manifest, privateBytes, publicKey, fingerprint);

  assert.equal(signature.length, 64);
  assert.ok(crypto.verify(null, manifest, publicKey, signature));
  assert.equal(crypto.verify(null, Buffer.from('{"synthetic":true}'), publicKey, signature), false);
  assert.ok(privateBytes.every(value => value === 0));
});

test('a rejected key identity is also cleared without producing a signature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateBytes = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }));

  assert.throws(() => signManifestBytes(Buffer.from('synthetic'), privateBytes, publicKey));

  assert.ok(privateBytes.every(value => value === 0));
});

test('accepts the owner-bound macOS encoding field injected into a fresh environment', () => {
  validateSignerEnvironment(
    { HOME: '/Users/synthetic', PATH: '/usr/bin:/bin', __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' },
    501,
  );
});

for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) {
  test(`rejects loader or credential environment ${name}`, () => {
    assert.throws(() => validateSignerEnvironment({ [name]: 'synthetic' }, 501));
  });
}

for (const encoding of ['0x1F6:0x0:0x0', 'invalid', '0x1F5:0x0:0x0 extra']) {
  test(`rejects invalid macOS encoding identity ${encoding}`, () => {
    assert.throws(() => validateSignerEnvironment({ __CF_USER_TEXT_ENCODING: encoding }, 501));
  });
}

test('a checkout copy cannot become a signing entrypoint', () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, 'trusted-analytics-signer.mjs'), 'check'],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Trusted analytics installation check failed/);
});
