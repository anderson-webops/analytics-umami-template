import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createUstarHeader } from './mac-artifact-transport.mjs';
import { shortenPnpmSymlinks } from './portable-pnpm-links.mjs';
import { copyReplayCssBindings } from './standalone-css-bindings.mjs';

async function cssBindingFixture(run) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-css-bindings-')),
  );
  try {
    const modules = path.join(root, 'node_modules');
    const dependencies = path.join(modules, '.pnpm/lightningcss@1.33.0/node_modules');
    const source = path.join(dependencies, 'lightningcss');
    const app = path.join(root, 'runtime');
    const tracedDependencies = path.join(
      app,
      'node_modules/.pnpm/lightningcss@1.33.0/node_modules',
    );
    const traced = path.join(tracedDependencies, 'lightningcss');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(traced, { recursive: true });
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '1.33.0' }));
    await fs.symlink(path.relative(modules, source), path.join(modules, 'lightningcss'));
    await fs.symlink(
      path.relative(path.join(app, 'node_modules'), traced),
      path.join(app, 'node_modules/lightningcss'),
    );
    const names = new Set(['lightningcss-linux-arm64-gnu']);
    if (process.platform === 'darwin') names.add(`lightningcss-darwin-${process.arch}`);
    for (const name of names) {
      const directory = path.join(dependencies, name);
      await fs.mkdir(directory);
      await fs.writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ name, version: '1.33.0' }),
      );
      await fs.writeFile(
        path.join(directory, `${name.replace('lightningcss-', 'lightningcss.')}.node`),
        name,
      );
    }
    await run({ root, app, dependencies, tracedDependencies, names });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('standalone CSS bindings preserve locked bytes and resolving links on repeated preparation', async () => {
  await cssBindingFixture(async ({ root, app, dependencies, tracedDependencies, names }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await copyReplayCssBindings(app, root);
      for (const name of names) {
        const relative = `${name.replace('lightningcss-', 'lightningcss.')}.node`;
        assert.deepEqual(
          await fs.readFile(path.join(tracedDependencies, name, relative)),
          await fs.readFile(path.join(dependencies, name, relative)),
        );
        assert.equal(
          await fs.realpath(path.join(tracedDependencies, name)),
          path.join(app, 'node_modules', name),
        );
      }
    }
  });
});

test('standalone CSS preparation rejects a mismatched locked native version', async () => {
  await cssBindingFixture(async ({ root, app, dependencies }) => {
    await fs.writeFile(
      path.join(dependencies, 'lightningcss-linux-arm64-gnu/package.json'),
      JSON.stringify({ name: 'lightningcss-linux-arm64-gnu', version: '1.32.0' }),
    );
    await assert.rejects(
      copyReplayCssBindings(app, root),
      /locked .* native binding is unavailable/,
    );
  });
});

test('standalone CSS preparation rejects an absent native file', async () => {
  await cssBindingFixture(async ({ root, app, dependencies }) => {
    await fs.unlink(
      path.join(dependencies, 'lightningcss-linux-arm64-gnu/lightningcss.linux-arm64-gnu.node'),
    );
    await assert.rejects(copyReplayCssBindings(app, root), { code: 'ENOENT' });
  });
});

test('standalone CSS preparation rejects a traced package outside its runtime', async () => {
  await cssBindingFixture(async ({ root, app }) => {
    const traced = path.join(app, 'node_modules/lightningcss');
    await fs.unlink(traced);
    await fs.symlink(path.join(root, 'node_modules/lightningcss'), traced);
    await assert.rejects(copyReplayCssBindings(app, root), /escapes the standalone runtime/);
  });
});

test('migration-tool deployment pins portable pnpm paths and copies package files', async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, 'postbuild.js'), 'utf8');
  assert.match(source, /--config\.virtual-store-dir-max-length=60/);
  assert.match(source, /--config\.package-import-method=copy/);
});

test('migration-tool artifact checks match the exact maintained Prisma pin', async () => {
  const root = path.join(import.meta.dirname, '..');
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'deploy/migration-tool/package.json'), 'utf8'),
  );
  const version = manifest.dependencies.prisma;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const source = await fs.readFile(path.join(root, 'scripts/postbuild.js'), 'utf8');
  assert.ok(source.includes(`migrationTool.version !== '${version}'`));
  assert.ok(
    source.includes(
      `node_modules/.pnpm/@prisma+engines@${version}/node_modules/@prisma/engines/schema-engine-linux-arm64-openssl-3.0.x`,
    ),
  );
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
