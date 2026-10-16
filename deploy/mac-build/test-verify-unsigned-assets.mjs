import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyUnsignedAssets } from './verify-unsigned-assets.mjs';

const site = 'analytics.avasan.org';
const tag = 'v5.0.51';
const archive = `${site}-${tag}-linux-arm64-runtime.tar.gz`;
const names = [
  archive,
  'acceptance-receipt.json',
  'anderson-runtime-manifest.json',
  'public-build-configuration.json',
];

function withAssets(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unsigned-assets-'));
  try {
    for (const name of names) fs.writeFileSync(path.join(directory, name), 'synthetic');
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('accepts only the exact bounded unsigned asset set', () => {
  withAssets(directory => {
    assert.doesNotThrow(() => verifyUnsignedAssets(directory, site, tag));
    fs.writeFileSync(path.join(directory, 'unexpected.txt'), 'synthetic');
    assert.throws(() => verifyUnsignedAssets(directory, site, tag), /exact file set/);
    fs.rmSync(path.join(directory, 'unexpected.txt'));
    fs.rmSync(path.join(directory, archive));
    assert.throws(() => verifyUnsignedAssets(directory, site, tag), /exact file set/);
  });
});

test('rejects links, empty assets, and writable modes', () => {
  withAssets(directory => {
    fs.rmSync(path.join(directory, archive));
    fs.symlinkSync('acceptance-receipt.json', path.join(directory, archive));
    assert.throws(() => verifyUnsignedAssets(directory, site, tag), /unsafe type/);
    fs.rmSync(path.join(directory, archive));
    fs.linkSync(path.join(directory, 'acceptance-receipt.json'), path.join(directory, archive));
    assert.throws(() => verifyUnsignedAssets(directory, site, tag), /unsafe type/);
    fs.rmSync(path.join(directory, archive));
    fs.writeFileSync(path.join(directory, archive), '');
    assert.throws(() => verifyUnsignedAssets(directory, site, tag), /unsafe type/);
    fs.writeFileSync(path.join(directory, archive), 'synthetic');
    fs.chmodSync(path.join(directory, archive), 0o666);
    assert.throws(() => verifyUnsignedAssets(directory, site, tag), /unsafe type/);
  });
});

test('rejects oversized assets without reading them', () => {
  withAssets(directory => {
    fs.truncateSync(path.join(directory, archive), 1_100_000 * 1024);
    assert.throws(() => verifyUnsignedAssets(directory, site, tag), /size bound/);
  });
});
