import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  captureWorkspacePackaging,
  packageRuntimeWorkspaces,
} from './package-runtime-workspaces.mjs';

async function fixture(run) {
  const runs = path.resolve('.ai-work/runs');
  await fs.mkdir(runs, { recursive: true });
  const root = await fs.mkdtemp(path.join(runs, 'workspace-packaging-'));
  async function file(relative, contents) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  async function link(relative, target) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.symlink(target, path.join(root, relative));
  }
  try {
    execFileSync('git', ['init', '-q', root]);
    await file('package.json', {
      dependencies: { '@test/api': 'workspace:*', '@test/mcp': 'workspace:*' },
    });
    await file('packages/api/package.json', { name: '@test/api', files: ['dist', 'README.md'] });
    await file('packages/mcp/package.json', {
      name: '@test/mcp',
      files: ['dist', 'bin'],
      dependencies: { '@test/api': 'workspace:*', dep: '1' },
    });
    await file('packages/api/dist/index.js', 'export const answer = 42;');
    await file('packages/api/README.md', 'synthetic');
    await file('packages/mcp/dist/index.js', 'synthetic');
    await file('packages/mcp/bin/run.js', 'synthetic');
    await file('node_modules/.pnpm/dep/node_modules/dep/package.json', { name: 'dep' });
    await file('node_modules/.pnpm/dev/node_modules/dev/package.json', { name: 'dev' });
    await link('node_modules/@test/api', '../../packages/api');
    await link('node_modules/@test/mcp', '../../packages/mcp');
    await link('packages/mcp/node_modules/dep', '../../../node_modules/.pnpm/dep/node_modules/dep');
    await link('node_modules/.pnpm/node_modules/dev', '../dev/node_modules/dev');
    await run({ root, file, link });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test('packs both workspace distributions and production dependencies internally, removing only captured stale dev hoists', async () => {
  await fixture(async ({ root }) => {
    const captured = await captureWorkspacePackaging(root);
    await fs.rm(path.join(root, 'node_modules/.pnpm/dev'), { recursive: true });
    await packageRuntimeWorkspaces(root, captured);
    assert.equal(
      await fs.readFile(path.join(root, 'node_modules/@test/api/dist/index.js'), 'utf8'),
      'export const answer = 42;',
    );
    assert.ok(
      (await fs.realpath(path.join(root, 'node_modules/@test/mcp/node_modules/dep'))).startsWith(
        path.join(root, 'node_modules/'),
      ),
    );
    assert.ok(
      (
        await fs.realpath(path.join(root, 'node_modules/@test/mcp/node_modules/@test/api'))
      ).startsWith(path.join(root, 'node_modules/')),
    );
    await assert.rejects(fs.stat(path.join(root, 'packages/api/dist')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'packages/api/README.md'), 'utf8'), 'synthetic');
  });
});
test('removes a captured dev-only braces hoist without changing its vendored source', async () => {
  await fixture(async ({ root, file, link }) => {
    await file('vendor/braces/package.json', { name: 'braces', version: '3.0.4-webops.1' });
    await file('vendor/braces/index.js', 'module.exports = "braces";');
    await link(
      'vendor/braces/node_modules/dep',
      '../../../node_modules/.pnpm/dep/node_modules/dep',
    );
    await link('node_modules/.pnpm/node_modules/braces', '../../../vendor/braces');

    const captured = await captureWorkspacePackaging(root);
    await packageRuntimeWorkspaces(root, captured);

    await assert.rejects(fs.lstat(path.join(root, 'node_modules/.pnpm/node_modules/braces')), {
      code: 'ENOENT',
    });
    assert.equal(
      await fs.readFile(path.join(root, 'vendor/braces/index.js'), 'utf8'),
      'module.exports = "braces";',
    );
  });
});
test('rejects a changed vendored hoist or an undeclared external link', async () => {
  for (const mutation of ['bytes', 'target', 'extra']) {
    await fixture(async ({ root, file, link }) => {
      await file('vendor/braces/package.json', { name: 'braces', version: '3.0.4-webops.1' });
      await file('vendor/braces/index.js', 'original');
      await link('node_modules/.pnpm/node_modules/braces', '../../../vendor/braces');

      const captured = await captureWorkspacePackaging(root);
      if (mutation === 'bytes') await file('vendor/braces/index.js', 'changed');
      if (mutation === 'target') {
        await file('vendor/other/package.json', { name: 'braces', version: '3.0.4-webops.1' });
        await fs.unlink(path.join(root, 'node_modules/.pnpm/node_modules/braces'));
        await link('node_modules/.pnpm/node_modules/braces', '../../../vendor/other');
      }
      if (mutation === 'extra') {
        await link('node_modules/.pnpm/node_modules/other', '../../../vendor/braces');
      }

      await assert.rejects(packageRuntimeWorkspaces(root, captured));
      if (mutation !== 'extra') {
        assert.ok(await fs.lstat(path.join(root, 'node_modules/.pnpm/node_modules/braces')));
      }
    });
  }
});
test('does not discard a vendored package in the production dependency graph', async () => {
  await fixture(async ({ root, file, link }) => {
    await file('package.json', {
      dependencies: {
        '@test/api': 'workspace:*',
        '@test/mcp': 'workspace:*',
        braces: 'file:vendor/braces',
      },
    });
    await file('vendor/braces/package.json', { name: 'braces', version: '3.0.4-webops.1' });
    await link('node_modules/braces', '../vendor/braces');
    await link('node_modules/.pnpm/node_modules/braces', '../../../vendor/braces');

    const captured = await captureWorkspacePackaging(root);

    assert.equal(captured.vendoredHoists['.pnpm/node_modules/braces'], undefined);
    await assert.rejects(packageRuntimeWorkspaces(root, captured));
    assert.ok(await fs.lstat(path.join(root, 'node_modules/.pnpm/node_modules/braces')));
  });
});
test('rejects an unreviewed version of the vendored braces hoist', async () => {
  await fixture(async ({ root, file, link }) => {
    await file('vendor/braces/package.json', { name: 'braces', version: '3.0.5' });
    await link('node_modules/.pnpm/node_modules/braces', '../../../vendor/braces');

    await assert.rejects(captureWorkspacePackaging(root));
  });
});
test('rejects changed build bytes, tracked distribution files, missing production links and new dangling links', async () => {
  for (const mutation of ['bytes', 'tracked', 'production', 'untracked-link'])
    await fixture(async ({ root, file, link }) => {
      const captured = await captureWorkspacePackaging(root);
      if (mutation === 'bytes') await file('packages/api/dist/index.js', 'changed');
      if (mutation === 'tracked') execFileSync('git', ['add', 'packages/api/dist'], { cwd: root });
      if (mutation === 'production')
        await fs.rm(path.join(root, 'node_modules/.pnpm/dep'), { recursive: true });
      if (mutation === 'untracked-link')
        await link('node_modules/.pnpm/node_modules/unknown', '../unknown');
      await assert.rejects(packageRuntimeWorkspaces(root, captured));
      assert.ok(await fs.stat(path.join(root, 'packages/api/dist/index.js')));
    });
});
