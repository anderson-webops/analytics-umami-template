import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pruneForeignRuntimePackages } from './prune-foreign-runtime-packages.mjs';

const platform = { os: 'linux', cpu: 'arm64', libc: 'glibc' };

test('prunes only incompatible traced packages and their aliases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-platform-'));
  try {
    const modules = path.join(root, 'node_modules');
    const foreign = path.join(modules, '.pnpm', 'foreign', 'node_modules', 'foreign');
    const musl = path.join(modules, '.pnpm', 'musl', 'node_modules', 'musl');
    const native = path.join(modules, '.pnpm', 'native', 'node_modules', 'native');
    await fs.mkdir(foreign, { recursive: true });
    await fs.mkdir(musl, { recursive: true });
    await fs.mkdir(native, { recursive: true });
    await fs.writeFile(
      path.join(foreign, 'package.json'),
      JSON.stringify({
        name: 'foreign',
        os: ['linux'],
        cpu: ['x64'],
        libc: ['glibc'],
      }),
    );
    await fs.writeFile(path.join(foreign, 'foreign.node'), 'foreign binary');
    await fs.writeFile(
      path.join(musl, 'package.json'),
      JSON.stringify({ name: 'musl', os: ['linux'], cpu: ['arm64'], libc: ['musl'] }),
    );
    await fs.writeFile(path.join(musl, 'musl.node'), 'foreign libc binary');
    await fs.writeFile(
      path.join(native, 'package.json'),
      JSON.stringify({
        name: 'native',
        os: ['linux'],
        cpu: ['arm64'],
        libc: ['glibc'],
      }),
    );
    await fs.writeFile(path.join(native, 'native.node'), 'native binary');
    await fs.symlink(path.relative(modules, foreign), path.join(modules, 'foreign'));
    await fs.symlink(path.relative(modules, musl), path.join(modules, 'musl'));
    await fs.symlink(path.relative(modules, native), path.join(modules, 'native'));

    const result = await pruneForeignRuntimePackages(root, platform);
    assert.equal(result.packages.length, 2);
    assert.equal(result.links.length, 2);
    await assert.rejects(fs.lstat(foreign), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(modules, 'foreign')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(musl), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(modules, 'musl')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(native, 'native.node'), 'utf8'), 'native binary');
    assert.equal(await fs.realpath(path.join(modules, 'native')), await fs.realpath(native));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects an escaping link without removing any package', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-platform-'));
  try {
    const modules = path.join(root, 'node_modules');
    const foreign = path.join(modules, 'foreign');
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(
      path.join(foreign, 'package.json'),
      JSON.stringify({
        name: 'foreign',
        os: ['darwin'],
        cpu: ['arm64'],
      }),
    );
    await fs.symlink(os.tmpdir(), path.join(modules, 'escape'));
    await assert.rejects(pruneForeignRuntimePackages(root, platform), /escapes the artifact/);
    assert.equal((await fs.stat(foreign)).isDirectory(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
