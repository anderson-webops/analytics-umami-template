import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createUstarHeader } from './mac-artifact-transport.mjs';
import { shortenPnpmSymlinks } from './portable-pnpm-links.mjs';

test('migration-tool deployment pins portable pnpm package-directory lengths', async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, 'postbuild.js'), 'utf8');
  assert.match(source, /--config\.virtual-store-dir-max-length=60/);
});

test('shortens pinned pnpm links without changing resolved packages', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-pnpm-links-'));
  try {
    const modules = path.join(temporary, 'node_modules');
    const store = path.join(modules, '.pnpm');
    const packageFolder = `@prisma+engines-version@${'a'.repeat(34)}`;
    const packagePath = path.join(
      store,
      packageFolder,
      'node_modules',
      '@prisma',
      'engines-version',
    );
    const dependencyPath = path.join(store, 'prisma@7.10.0', 'node_modules', '@prisma');
    const hoistPath = path.join(store, 'node_modules', '@prisma');
    await fs.mkdir(packagePath, { recursive: true });
    await fs.mkdir(dependencyPath, { recursive: true });
    await fs.mkdir(hoistPath, { recursive: true });
    const dependencyLink = path.join(dependencyPath, 'engines-version');
    const hoistLink = path.join(hoistPath, 'engines-version');
    await fs.symlink(path.relative(dependencyPath, packagePath), dependencyLink);
    await fs.symlink(path.relative(hoistPath, packagePath), hoistLink);
    const originalTarget = await fs.realpath(dependencyLink);
    assert.ok(Buffer.byteLength(await fs.readlink(dependencyLink)) > 100);
    assert.equal(await shortenPnpmSymlinks(modules), 2);
    for (const link of [dependencyLink, hoistLink]) {
      const target = await fs.readlink(link);
      assert.ok(Buffer.byteLength(target) <= 100);
      assert.equal(await fs.realpath(link), originalTarget);
      assert.equal(
        createUstarHeader({
          path: `runtime/${path.relative(temporary, link)}`,
          type: 'symlink',
          mode: 0o777,
          target,
        }).length,
        512,
      );
    }
    assert.equal(await shortenPnpmSymlinks(modules), 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('rejects an overlong link outside the pinned virtual store', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-pnpm-escape-'));
  try {
    const modules = path.join(temporary, 'node_modules');
    const dependencyPath = path.join(modules, '.pnpm', 'prisma@7.10.0', 'node_modules');
    const external = path.join(temporary, 'external', 'node_modules', 'a'.repeat(101));
    await fs.mkdir(dependencyPath, { recursive: true });
    await fs.mkdir(external, { recursive: true });
    const link = path.join(dependencyPath, 'prisma');
    await fs.symlink(path.relative(dependencyPath, external), link);
    await assert.rejects(shortenPnpmSymlinks(modules), /leaves its virtual store/);
    assert.equal(await fs.realpath(link), await fs.realpath(external));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
