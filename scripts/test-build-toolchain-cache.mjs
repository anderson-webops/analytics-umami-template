import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  cacheIdentity,
  digestRegularFile,
  finishToolchainCache,
  inspectToolchainPayload,
  maximumCachedProfiles,
  nodeIdentity,
  selectToolchainCache,
  verifyReusableToolchain,
} from './build-toolchain-cache.mjs';
import { selectedNpmCli, toolchainSource } from './build-toolchain-state.mjs';

const root = path.resolve(import.meta.dirname, '..');
const scratch = path.join(root, '.ai-work/runs/toolchain-cache-fixtures');
mkdirSync(scratch, { recursive: true });
const profile = path.resolve(path.dirname(selectedNpmCli()), '../../..');

function fixture() {
  return mkdtempSync(path.join(scratch, 'case-'));
}

test('the complete payload matches a source-pinned digest rather than a mutable cache receipt', () => {
  const expected = JSON.parse(readFileSync(path.join(toolchainSource, 'PAYLOAD.json'), 'utf8'));
  assert.deepEqual(inspectToolchainPayload(profile), expected);
  assert.ok(expected.files > 3000);
  assert.equal(verifyReusableToolchain(profile, nodeIdentity()).node, process.versions.node);
});

test('unreviewed dependency bytes, extra code, missing code, command links and Node substitutions fail closed', () => {
  const directory = fixture();
  try {
    for (const name of ['node_modules', 'vendor', 'bin'])
      cpSync(path.join(profile, name), path.join(directory, name), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
    if (existsSync(path.join(profile, 'lib')))
      cpSync(path.join(profile, 'lib'), path.join(directory, 'lib'), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    for (const name of ['package.json', 'package-lock.json', '.npmrc', 'UPSTREAM.json'])
      copyFileSync(path.join(profile, name), path.join(directory, name));
    const expectedNode = nodeIdentity();
    verifyReusableToolchain(directory, expectedNode);
    const shadowLibrary = path.join(directory, 'bin', 'libnode.shadow.dylib');
    writeFileSync(shadowLibrary, 'unreviewed runtime lookup');
    assert.throws(
      () => verifyReusableToolchain(directory, expectedNode),
      /Unexpected paired command/u,
    );
    rmSync(shadowLibrary);
    if (expectedNode.libraries.length > 0) {
      const library = path.join(directory, 'lib', expectedNode.libraries[0].name);
      const original = readFileSync(library);
      rmSync(library);
      writeFileSync(library, 'unreviewed shared runtime');
      assert.throws(() => verifyReusableToolchain(directory, expectedNode), /Cached Node differs/u);
      writeFileSync(library, original);
      verifyReusableToolchain(directory, expectedNode);
    }
    const victim = path.join(directory, 'node_modules/undici/index.js');
    const bytes = readFileSync(victim);
    writeFileSync(victim, 'throw new Error("unreviewed dependency implementation")\n');
    writeFileSync(
      path.join(directory, 'acceptance.json'),
      JSON.stringify({ treeSha256: inspectToolchainPayload(directory).treeSha256 }),
    );
    assert.throws(
      () => verifyReusableToolchain(directory, expectedNode),
      /Complete toolchain payload differs/u,
    );
    writeFileSync(victim, bytes);
    const extra = path.join(directory, 'node_modules/undici/unreviewed.js');
    writeFileSync(extra, 'unreviewed extra module');
    assert.throws(
      () => verifyReusableToolchain(directory, expectedNode),
      /Complete toolchain payload differs/u,
    );
    rmSync(extra);
    rmSync(victim);
    assert.throws(
      () => verifyReusableToolchain(directory, expectedNode),
      /Complete toolchain payload differs/u,
    );
    writeFileSync(victim, bytes);
    const command = path.join(directory, 'bin/npx');
    rmSync(command);
    symlinkSync('../node_modules/npm/bin/npm-cli.js', command);
    assert.throws(() => verifyReusableToolchain(directory, expectedNode));
    rmSync(command);
    symlinkSync('../node_modules/npm/bin/npx-cli.js', command);
    const substitute = path.join(directory, 'other-node');
    copyFileSync(process.execPath, substitute);
    rmSync(path.join(directory, 'bin/node'));
    symlinkSync(substitute, path.join(directory, 'bin/node'));
    assert.throws(() => verifyReusableToolchain(directory, expectedNode), /Cached Node differs/u);
    rmSync(path.join(directory, 'bin/node'));
    writeFileSync(path.join(directory, 'bin/node'), 'unreviewed executable');
    assert.throws(() => verifyReusableToolchain(directory, expectedNode), /Cached Node differs/u);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('cache identity is bound to the actual Node bytes as well as source, independent lock and platform', () => {
  const directory = fixture();
  try {
    const node = path.join(directory, 'node');
    writeFileSync(node, 'distinct controlled fixture');
    const first = cacheIdentity(node);
    writeFileSync(node, 'changed controlled fixture');
    const second = cacheIdentity(node);
    assert.notEqual(first.key, second.key);
    assert.deepEqual(first, {
      key: first.key,
      node: { ...first.node, executable: false },
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('concurrent selectors wait for the existing complete outcome rather than allocate duplicate profiles', async () => {
  const directory = fixture();
  try {
    const identity = {
      key: 'a'.repeat(64),
    };
    const cold = await selectToolchainCache(directory, identity);
    const pending = selectToolchainCache(directory, identity, { waitMilliseconds: 1000 });
    const ready = setTimeout(finishToolchainCache, 150, cold, identity, true);
    const warm = await pending;
    clearTimeout(ready);
    assert.equal(warm.reused, true);
    assert.equal(warm.prefix, cold.prefix);
    assert.deepEqual(
      readdirSync(path.join(directory, 'reuse-v1')).filter(name => name.startsWith('slot-')),
      ['slot-0'],
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('retention has a fixed profile cap and preserves every ready, failed and unfinished profile', async () => {
  const directory = fixture();
  try {
    const retained = [];
    for (let index = 0; index < maximumCachedProfiles; index += 1) {
      const identity = {
        key: String(index).repeat(64),
      };
      const selection = await selectToolchainCache(directory, identity);
      writeFileSync(path.join(selection.prefix, 'retained-evidence'), identity.key);
      if (index < 2) finishToolchainCache(selection, identity, index === 0);
      retained.push({
        prefix: selection.prefix,
        identity,
        state: lstatSync(selection.prefix),
      });
    }
    await assert.rejects(
      selectToolchainCache(directory, {
        key: 'f'.repeat(64),
      }),
      /3 retained profiles/u,
    );
    for (const entry of retained) {
      assert.equal(lstatSync(entry.prefix).ino, entry.state.ino);
      assert.equal(
        readFileSync(path.join(entry.prefix, 'retained-evidence'), 'utf8'),
        entry.identity.key,
      );
    }
    await assert.rejects(
      selectToolchainCache(directory, retained[1].identity, { waitMilliseconds: 100 }),
      /Previous bootstrap failed/u,
    );
    await assert.rejects(
      selectToolchainCache(directory, retained[2].identity, { waitMilliseconds: 100 }),
      /Timed out waiting/u,
    );
    assert.equal(
      readdirSync(path.join(directory, 'reuse-v1')).filter(name => name.startsWith('slot-')).length,
      maximumCachedProfiles,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('an interrupted creator is retained and cannot be treated as an accepted cache', async () => {
  const directory = fixture();
  try {
    const identity = {
      key: 'c'.repeat(64),
    };
    const child = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { selectToolchainCache } from ${JSON.stringify(new URL('./build-toolchain-cache.mjs', import.meta.url).href)};
const result = await selectToolchainCache(process.argv[1], {key:process.argv[2]});
process.stdout.write(JSON.stringify(result));`,
        directory,
        identity.key,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const selection = JSON.parse(child);
    await assert.rejects(
      selectToolchainCache(directory, identity, { waitMilliseconds: 1000 }),
      /Interrupted bootstrap retained/u,
    );
    assert.ok(lstatSync(selection.prefix).isDirectory());
    assert.equal(readdirSync(selection.prefix).length, 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('cache records and payload FIFOs or symlinks are rejected without blocking or following external state', async () => {
  const directory = fixture();
  try {
    const fifo = path.join(directory, 'fifo');
    execFileSync('mkfifo', [fifo]);
    assert.throws(() => digestRegularFile(fifo), /bounded regular file/u);
    const identity = {
      key: 'd'.repeat(64),
    };
    const selection = await selectToolchainCache(directory, identity);
    const ready = path.join(selection.keyDirectory, 'ready.json');
    symlinkSync(fifo, ready);
    await assert.rejects(selectToolchainCache(directory, identity, { waitMilliseconds: 1000 }), {
      code: 'ELOOP',
    });
    rmSync(ready);
    execFileSync('mkfifo', [ready]);
    await assert.rejects(
      selectToolchainCache(directory, identity, { waitMilliseconds: 1000 }),
      /bounded regular file/u,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
