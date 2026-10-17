import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolchainFingerprint } from './toolchain-fingerprint.mjs';

const image = {
  Id: `sha256:${'a'.repeat(64)}`,
  Os: 'linux',
  Architecture: 'arm64',
  RootFS: { Layers: [`sha256:${'b'.repeat(64)}`] },
  Config: {
    Env: ['NODE_VERSION=24.18.1'],
    User: '',
    WorkingDir: '',
    Entrypoint: null,
    Cmd: ['node'],
  },
};

test('attestation identity changes do not discard a matching toolchain cache', () => {
  const other = structuredClone(image);
  other.Id = `sha256:${'c'.repeat(64)}`;
  other.Created = 'different build time';
  assert.equal(toolchainFingerprint([image]), toolchainFingerprint([other]));
});

test('toolchain filesystem and runtime configuration changes invalidate the cache', () => {
  const other = structuredClone(image);
  other.RootFS.Layers[0] = `sha256:${'d'.repeat(64)}`;
  assert.notEqual(toolchainFingerprint([image]), toolchainFingerprint([other]));
  other.RootFS.Layers = image.RootFS.Layers;
  other.Config.Env = ['NODE_VERSION=25.0.0'];
  assert.notEqual(toolchainFingerprint([image]), toolchainFingerprint([other]));
});

test('rejects incomplete or wrong-platform image inventories', () => {
  assert.throws(() => toolchainFingerprint([]), /inventory is incomplete/);
  assert.throws(
    () => toolchainFingerprint([{ ...image, Architecture: 'amd64' }]),
    /inventory is incomplete/,
  );
  assert.throws(
    () => toolchainFingerprint([{ ...image, RootFS: { Layers: [] } }]),
    /inventory is incomplete/,
  );
});
