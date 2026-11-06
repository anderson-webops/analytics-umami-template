import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  sha256,
  toolchainMetadata,
  toolchainSource,
  verifyBuildToolchain,
} from './build-toolchain-state.mjs';

export const maximumCachedProfiles = 3;

function readCacheRecord(filename) {
  const descriptor = openSync(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const state = fstatSync(descriptor);
    assert.ok(
      state.isFile() && state.size <= 16 * 1024,
      `Cache record must be a bounded regular file: ${filename}`,
    );
    return JSON.parse(readFileSync(descriptor, 'utf8'));
  } finally {
    closeSync(descriptor);
  }
}

function privateDirectory(directory) {
  const state = lstatSync(directory);
  assert.ok(
    state.isDirectory() && !state.isSymbolicLink(),
    `Cache directory must be real: ${directory}`,
  );
  assert.equal(
    state.uid,
    process.getuid(),
    `Cache directory must belong to this account: ${directory}`,
  );
  assert.equal(state.mode & 0o077, 0, `Cache directory must be private: ${directory}`);
}

export function digestRegularFile(filename, maximumBytes = 256 * 1024 * 1024) {
  const descriptor = openSync(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    assert.ok(
      before.isFile() && before.size <= maximumBytes,
      `Expected a bounded regular file: ${filename}`,
    );
    assert.equal(
      before.mode & 0o022,
      0,
      `Toolchain file must not be writable by other accounts: ${filename}`,
    );
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      assert.ok(bytes <= maximumBytes, `Toolchain file grew beyond its bound: ${filename}`);
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    assert.equal(bytes, before.size, `Toolchain file changed while reading: ${filename}`);
    assert.equal(
      after.mtimeMs,
      before.mtimeMs,
      `Toolchain file changed while reading: ${filename}`,
    );
    assert.equal(
      after.ctimeMs,
      before.ctimeMs,
      `Toolchain file changed while reading: ${filename}`,
    );
    return {
      sha256: hash.digest('hex'),
      bytes,
      executable: (before.mode & 0o111) !== 0,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function inspectToolchainPayload(prefix) {
  const root = path.join(prefix, 'node_modules');
  const entries = [];
  let bytes = 0;
  let files = 0;
  function visit(directory) {
    const state = lstatSync(directory);
    assert.ok(
      state.isDirectory() && !state.isSymbolicLink(),
      `Toolchain directory must be real: ${directory}`,
    );
    assert.equal(
      state.mode & 0o022,
      0,
      `Toolchain directory must not be writable by other accounts: ${directory}`,
    );
    for (const name of readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      const relative = path.relative(root, filename).split(path.sep).join('/');
      const metadata = lstatSync(filename);
      assert.ok(entries.length < 20_000, 'Toolchain payload contains too many entries');
      if (metadata.isDirectory()) {
        entries.push([relative, 'directory']);
        visit(filename);
      } else if (metadata.isSymbolicLink()) {
        const target = readlinkSync(filename);
        assert.ok(
          relative.startsWith('.bin/') && path.dirname(relative) === '.bin',
          'Only toolchain command links are allowed',
        );
        const resolved = realpathSync(filename);
        assert.ok(
          resolved.startsWith(`${root}${path.sep}`),
          'Toolchain command link escapes its profile',
        );
        entries.push([relative, 'link', target]);
      } else {
        const digest = digestRegularFile(filename, 16 * 1024 * 1024);
        bytes += digest.bytes;
        files += 1;
        assert.ok(bytes <= 128 * 1024 * 1024, 'Toolchain payload exceeds its byte bound');
        entries.push([relative, 'file', digest.sha256, digest.executable]);
      }
    }
  }
  visit(root);
  return {
    schemaVersion: 1,
    lockSha256: toolchainMetadata.lockSha256,
    treeSha256: sha256(JSON.stringify(entries)),
    files,
    bytes,
  };
}

export function nodeIdentity(nodeExecutable = process.execPath) {
  const filename = realpathSync(nodeExecutable);
  const libraries = [];
  if (process.platform === 'darwin') {
    const name = `libnode.${process.versions.modules}.dylib`;
    const library = path.resolve(path.dirname(filename), '../lib', name);
    if (existsSync(library)) libraries.push({ name, ...digestRegularFile(realpathSync(library)) });
  }
  return { ...digestRegularFile(filename), libraries };
}

export function cacheIdentity(nodeExecutable = process.execPath) {
  const node = nodeIdentity(nodeExecutable);
  const inputs = [
    'package.json',
    'package-lock.json',
    '.npmrc',
    'UPSTREAM.json',
    'PAYLOAD.json',
    toolchainMetadata.archive,
  ].map(name => [name, sha256(readFileSync(path.join(toolchainSource, name)))]);
  const code = [
    'build-toolchain.mjs',
    'build-toolchain-state.mjs',
    'build-toolchain-cache.mjs',
  ].map(name => [name, sha256(readFileSync(path.join(import.meta.dirname, name)))]);
  return {
    key: sha256(
      JSON.stringify({
        inputs,
        code,
        node,
        platform: process.platform,
        architecture: process.arch,
      }),
    ),
    node,
  };
}

export function verifyReusableToolchain(prefix, expectedNode) {
  privateDirectory(prefix);
  const bin = path.join(prefix, 'bin');
  const binState = lstatSync(bin);
  assert.ok(
    binState.isDirectory() && !binState.isSymbolicLink(),
    'Toolchain command directory must be real',
  );
  assert.equal(
    binState.mode & 0o022,
    0,
    'Toolchain command directory must not be writable by other accounts',
  );
  const node = path.join(bin, 'node');
  assert.deepEqual(readdirSync(bin).sort(), ['node', 'npm', 'npx'], 'Unexpected paired command');
  assert.ok(lstatSync(node).isFile(), 'Cached Node differs from the selected executable');
  assert.ok(!lstatSync(node).isSymbolicLink(), 'Cached Node differs from the selected executable');
  const libraries = path.join(prefix, 'lib');
  if (expectedNode.libraries.length > 0) {
    privateDirectory(libraries);
    assert.deepEqual(
      readdirSync(libraries).sort(),
      expectedNode.libraries.map(library => library.name).sort(),
    );
    for (const library of expectedNode.libraries) {
      assert.ok(
        lstatSync(path.join(libraries, library.name)).isFile(),
        'Shared Node library must be regular',
      );
      assert.ok(
        !lstatSync(path.join(libraries, library.name)).isSymbolicLink(),
        'Shared Node library must be regular',
      );
    }
  } else {
    assert.equal(existsSync(libraries), false, 'Unexpected paired Node libraries');
  }
  assert.deepEqual(
    nodeIdentity(node),
    expectedNode,
    'Cached Node differs from the selected executable',
  );
  for (const name of ['npm', 'npx']) {
    assert.ok(
      lstatSync(path.join(bin, name)).isSymbolicLink(),
      `Cached ${name} must be the paired command link`,
    );
    assert.equal(readlinkSync(path.join(bin, name)), `../node_modules/npm/bin/${name}-cli.js`);
  }
  const receipt = verifyBuildToolchain(path.join(prefix, 'node_modules/npm/bin/npm-cli.js'));
  const expected = JSON.parse(readFileSync(path.join(toolchainSource, 'PAYLOAD.json'), 'utf8'));
  assert.deepEqual(
    inspectToolchainPayload(prefix),
    expected,
    'Complete toolchain payload differs from the reviewed locked installation',
  );
  return { ...receipt, payloadTreeSha256: expected.treeSha256 };
}

function createKeyDirectory(keyDirectory) {
  try {
    mkdirSync(keyDirectory, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

function claimSlot(root, keyDirectory) {
  for (let index = 0; index < maximumCachedProfiles; index += 1) {
    const prefix = path.join(root, `slot-${index}`);
    try {
      mkdirSync(prefix, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    writeFileSync(
      path.join(keyDirectory, 'location.json'),
      `${JSON.stringify({ slot: index })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return { prefix, keyDirectory, reused: false };
  }
  throw new Error(
    `Toolchain cache has ${maximumCachedProfiles} retained profiles; inspect and retire an inactive profile before retrying: ${root}`,
  );
}

function optionalRecord(filename) {
  try {
    return readCacheRecord(filename);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}

function readySelection(root, keyDirectory, identity) {
  assert.equal(
    optionalRecord(path.join(keyDirectory, 'failed.json')),
    undefined,
    `Previous bootstrap failed; inspect retained evidence: ${keyDirectory}`,
  );
  const record = optionalRecord(path.join(keyDirectory, 'ready.json'));
  if (record === undefined) return undefined;
  assert.equal(record.key, identity.key);
  assert.ok(
    Number.isInteger(record.slot) && record.slot >= 0 && record.slot < maximumCachedProfiles,
  );
  const prefix = path.join(root, `slot-${record.slot}`);
  privateDirectory(prefix);
  return { prefix, keyDirectory, reused: true };
}

function assertCreatorAlive(keyDirectory, identity) {
  const owner = optionalRecord(path.join(keyDirectory, 'owner.json'));
  if (owner === undefined) return;
  assert.ok(
    Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.key === identity.key,
    'Invalid bootstrap owner',
  );
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH')
      throw new Error(`Interrupted bootstrap retained for inspection: ${keyDirectory}`);
    throw error;
  }
}

async function waitForCache(root, keyDirectory, identity, waitMilliseconds) {
  const deadline = Date.now() + waitMilliseconds;
  while (Date.now() < deadline) {
    const selection = readySelection(root, keyDirectory, identity);
    if (selection) return selection;
    assertCreatorAlive(keyDirectory, identity);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for the existing bootstrap; inspect its outcome before retrying: ${keyDirectory}`,
  );
}

export async function selectToolchainCache(base, identity, { waitMilliseconds = 300_000 } = {}) {
  assert.ok(
    typeof process.getuid === 'function',
    'Reusable toolchain cache requires POSIX ownership checks',
  );
  assert.match(identity.key, /^[a-f\d]{64}$/u, 'Invalid toolchain cache identity');
  const root = path.join(base, 'reuse-v1');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  privateDirectory(root);
  const keyDirectory = path.join(root, identity.key);
  const creator = createKeyDirectory(keyDirectory);
  privateDirectory(keyDirectory);
  if (!creator) return waitForCache(root, keyDirectory, identity, waitMilliseconds);
  const owner = {
    key: identity.key,
    pid: process.pid,
    startedUTC: new Date().toISOString(),
  };
  writeFileSync(path.join(keyDirectory, 'owner.json'), `${JSON.stringify(owner)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return claimSlot(root, keyDirectory);
}

export function finishToolchainCache(selection, identity, accepted) {
  assert.equal(selection.reused, false);
  const slot = Number(path.basename(selection.prefix).slice('slot-'.length));
  assert.ok(Number.isInteger(slot) && slot >= 0 && slot < maximumCachedProfiles);
  const record = {
    key: identity.key,
    slot,
    finishedUTC: new Date().toISOString(),
  };
  writeFileSync(
    path.join(selection.keyDirectory, accepted ? 'ready.json' : 'failed.json'),
    `${JSON.stringify(record)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
