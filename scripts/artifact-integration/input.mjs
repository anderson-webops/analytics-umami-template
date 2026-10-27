import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyEmbeddedRuntime, verifyTransportArchive } from '../mac-artifact-transport.mjs';

export const profiles = {
  'analytics.np-servicerequest.org': {
    commit: '02cc8de641948c3a04bf9cbab5e06b6a5f63d619',
    archive: '655c8a6ba7beaeb87107bb4f2745b565b968a708f5233b5cb4d8a47d26ec7748',
    manifest: '48d49bfa59a9f18346d71c78320c61fc47cbefcfded2fd90884263eb648aab3e',
    contract: '019f21f0d5987f8af3760773cd506512db181ac767b07ae04eac6cdbb19e6333',
  },
  'analytics.mariettaviolinwithcarla.com': {
    commit: '889b062462551ad51c3ff005863db42f899e3d6b',
    archive: '6e3dcd7ee1e0528a20bfb3b278e01db0d6c22d3746ba24f5d0e177070df647f7',
    manifest: 'ee174d00494f23c5b89ea6476c3a89ba5a8362be55ef109345ebaff008b5aaf8',
    contract: 'e0c040538be37101eb6f01bfcb038fc2d6513bf74756a580a0f120f113db2d43',
  },
  'analytics.retrozetrocomics.com': {
    commit: '2abffad5d99d79b8f8d414f53f2e3e4288ea572c',
    archive: '9e6392cec0a488a7b1ac3c2fa5f5986bc3b13d875c615a0cb4c4c8d05e19bf5f',
    manifest: 'cecf7e667691fa47c25ae41d9018cb54d5f8846f6895d9e2234e5997cef9d01a',
    contract: '53c8a5b74d32bcb1cb4c66fed150e7a1c2a96c02d74d6afc26b9185c53fab035',
  },
};

export const builderSpkiSha256 = '9312fb21bf79162b8bf481d22190fe8e7352be8d80ceae99ad435faa1249f316';

const requiredFiles = [
  'server.js',
  'node_modules/pg',
  '.next/server/app/api/send/route.js',
  '.next/server/app/api/revenue/movements/route.js',
  '.next/server/app/api/collection-permit/route.js',
  'runtime-scripts/check-db.mjs',
  'runtime-scripts/prune-expired-session-replays.mjs',
  'runtime-scripts/prune-expired-heatmap-events.mjs',
  'migration-tool/prisma.config.ts',
  'migration-tool/node_modules/prisma',
];

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function boundedBytes(filename, maximum) {
  const metadata = await fs.lstat(filename);
  assert(metadata.isFile() && metadata.nlink === 1 && metadata.size <= maximum);
  return fs.readFile(filename);
}

export async function verifyBundle(assets, publicKeyPath, site) {
  const profile = profiles[site];
  assert(profile, 'Unsupported exact-artifact integration profile');
  const manifestBytes = await boundedBytes(
    path.join(assets, 'anderson-runtime-manifest.json'),
    8e6,
  );
  assert.equal(digest(manifestBytes), profile.manifest, 'Unaccepted manifest');
  const signature = await boundedBytes(path.join(assets, 'anderson-runtime-manifest.sig'), 64);
  const key = createPublicKey(await boundedBytes(publicKeyPath, 4096));
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.equal(digest(key.export({ type: 'spki', format: 'der' })), builderSpkiSha256);
  assert.equal(signature.length, 64);
  assert(verify(null, manifestBytes, key, signature), 'Invalid signed manifest');
  const transport = JSON.parse(manifestBytes);
  assert.equal(transport.schema_version, 1);
  assert.equal(transport.site, site);
  assert.equal(transport.repository, `anderson-webops/${site}`);
  assert.equal(transport.commit, profile.commit);
  assert.equal(transport.tag, 'v4.2.188');
  assert.equal(transport.version, '4.2.188');
  assert.equal(transport.source_clean, true);
  assert.equal(transport.builder_id, 'jacob-m3');
  assert.equal(transport.runtime_contract_sha256, profile.contract);
  assert.equal(transport.archive.name, `${site}-v4.2.188-linux-arm64-runtime.tar.gz`);
  assert.equal(transport.archive.sha256, profile.archive);
  assert.deepEqual(transport.checks, {
    tests: true,
    dependency_audit: true,
    package_signatures: true,
    native_bindings: true,
  });
  const configuration = await boundedBytes(
    path.join(assets, 'public-build-configuration.json'),
    65536,
  );
  assert.equal(digest(configuration), transport.configuration_sha256);
  const receipt = JSON.parse(
    await boundedBytes(path.join(assets, 'acceptance-receipt.json'), 65536),
  );
  assert.deepEqual(receipt, { commit: profile.commit, tag: 'v4.2.188', checks: transport.checks });
  const checksums = (await boundedBytes(path.join(assets, 'SHA256SUMS'), 8192)).toString();
  const checksumRecords = checksums
    .trim()
    .split('\n')
    .map(line => {
      const match = /^([0-9a-f]{64}) {2}([a-zA-Z0-9._-]+)$/.exec(line);
      assert(match, 'Invalid checksum record');
      return [match[2], match[1]];
    });
  const expectedNames = [
    transport.archive.name,
    'anderson-runtime-manifest.json',
    'anderson-runtime-manifest.sig',
    'public-build-configuration.json',
    'acceptance-receipt.json',
  ];
  assert.deepEqual(checksumRecords.map(([name]) => name).sort(), expectedNames.sort());
  for (const [name, checksum] of checksumRecords) {
    assert.equal(await fileDigest(path.join(assets, name)), checksum, 'Asset checksum mismatch');
  }
  const archivePath = path.join(assets, transport.archive.name);
  assert.equal((await fs.stat(archivePath)).size, transport.archive.size);
  const embedded = await verifyTransportArchive(archivePath, transport.files);
  verifyEmbeddedRuntime(transport, embedded, { requiredFiles });
  return transport;
}

export async function verifyTree(runtime, transport) {
  assert.equal(await fs.realpath(runtime), runtime, 'Runtime root must not traverse symlinks');
  const expected = new Map(transport.files.map(record => [record.path.slice(8), record]));
  let entries = 0;
  async function walk(directory, prefix = '') {
    for (const name of await fs.readdir(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const filename = path.join(directory, name);
      const record = expected.get(relative);
      assert(record, 'Unexpected runtime entry');
      const metadata = await fs.lstat(filename);
      const type = metadata.isFile()
        ? 'file'
        : metadata.isDirectory()
          ? 'directory'
          : metadata.isSymbolicLink()
            ? 'symlink'
            : 'unsupported';
      assert.equal(type, record.type, 'Runtime entry type differs');
      if (type !== 'symlink') assert.equal(metadata.mode & 0o7777, record.mode);
      if (type === 'file') {
        assert.equal(metadata.nlink, 1);
        assert.equal(metadata.size, record.size);
        assert.equal(await fileDigest(filename), record.sha256, 'Runtime bytes differ');
      } else if (type === 'directory') {
        await walk(filename, relative);
      } else {
        assert.equal(await fs.readlink(filename), record.target);
        const resolved = await fs.realpath(filename);
        assert(resolved.startsWith(`${runtime}/`), 'Runtime link escapes artifact');
      }
      entries += 1;
    }
  }
  await walk(runtime);
  assert.equal(entries, expected.size, 'Incomplete runtime inventory');
  return entries;
}
