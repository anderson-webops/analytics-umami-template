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
    await file('.gitignore', 'node_modules\n');
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
    await fs.unlink(path.join(root, 'vendor/braces/node_modules/dep'));
    await packageRuntimeWorkspaces(root, captured);

    await assert.rejects(fs.lstat(path.join(root, 'node_modules/.pnpm/node_modules/braces')), {
      code: 'ENOENT',
    });
    assert.equal(
      await fs.readFile(path.join(root, 'vendor/braces/index.js'), 'utf8'),
      'module.exports = "braces";',
    );
    await assert.rejects(fs.lstat(path.join(root, 'vendor/braces/node_modules')), {
      code: 'ENOENT',
    });
  });
});
test('refuses to clean vendored dependency output that is linked, nonempty, tracked or not ignored', async () => {
  for (const mutation of ['link', 'nonempty', 'tracked', 'not-ignored']) {
    await fixture(async ({ root, file, link }) => {
      await file('vendor/braces/package.json', { name: 'braces', version: '3.0.4-webops.1' });
      await file('vendor/braces/index.js', 'original');
      await link('node_modules/.pnpm/node_modules/braces', '../../../vendor/braces');
      const captured = await captureWorkspacePackaging(root);

      if (mutation === 'link') {
        await file('linked-output/keep', 'original');
        await link('vendor/braces/node_modules', '../../linked-output');
      } else if (mutation === 'nonempty') {
        await file('vendor/braces/node_modules/keep', 'original');
      } else if (mutation === 'tracked') {
        await file('vendor/braces/node_modules/keep', 'original');
        execFileSync('git', ['add', '-f', 'vendor/braces/node_modules/keep'], { cwd: root });
      } else {
        await fs.mkdir(path.join(root, 'vendor/braces/node_modules'));
        await file('.gitignore', 'other-output\n');
      }

      await assert.rejects(packageRuntimeWorkspaces(root, captured));
      assert.ok(await fs.lstat(path.join(root, 'vendor/braces/node_modules')));
      assert.equal(
        await fs.readFile(path.join(root, 'vendor/braces/index.js'), 'utf8'),
        'original',
      );
    });
  }
});
test('refuses a vendored dependency directory reached through a parent link', async () => {
  await fixture(async ({ root, file, link }) => {
    const captured = await captureWorkspacePackaging(root);
    await file('external-braces/package.json', { name: 'braces', version: '3.0.4-webops.1' });
    await fs.mkdir(path.join(root, 'external-braces/node_modules'));
    await link('vendor/braces', '../external-braces');

    await assert.rejects(packageRuntimeWorkspaces(root, captured));
    assert.ok(await fs.lstat(path.join(root, 'external-braces/node_modules')));
  });
});
test('real install, prune and packaging preserve the exact tracked source inventory', async () => {
  const runs = path.resolve('.ai-work/runs');
  await fs.mkdir(runs, { recursive: true });
  const root = await fs.mkdtemp(path.join(runs, 'workspace-pnpm-'));
  const store = `${root}-store`;
  const write = async (relative, contents) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  const pnpm = args =>
    execFileSync('pnpm', [...args, `--config.store-dir=${store}`], {
      cwd: root,
      env: { ...process.env, CI: 'true' },
      stdio: 'pipe',
    });

  try {
    execFileSync('git', ['init', '-q', root]);
    await write('.gitignore', 'node_modules\n');
    await write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    await write('package.json', {
      name: 'workspace-packaging-fixture',
      version: '1.0.0',
      private: true,
      packageManager: 'pnpm@11.18.0',
      dependencies: { '@test/api': 'workspace:*', '@test/mcp': 'workspace:*' },
    });
    await write('packages/api/package.json', {
      name: '@test/api',
      version: '1.0.0',
      files: ['dist'],
    });
    await write('packages/mcp/package.json', {
      name: '@test/mcp',
      version: '1.0.0',
      files: ['dist'],
      dependencies: { '@test/api': 'workspace:*' },
    });
    await write('vendor/braces/package.json', { name: 'braces', version: '3.0.4-webops.1' });
    await write('vendor/braces/index.js', 'module.exports = "braces";');
    pnpm(['install', '--offline', '--ignore-scripts']);
    execFileSync(
      'git',
      [
        'add',
        '.gitignore',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'packages',
        'vendor',
      ],
      { cwd: root },
    );
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'canonical source',
      ],
      { cwd: root },
    );

    await write('packages/api/dist/index.js', 'export const answer = 42;');
    await write('packages/mcp/dist/index.js', 'export const answer = 43;');
    await fs.mkdir(path.join(root, 'vendor/braces/node_modules'));
    const captured = await captureWorkspacePackaging(root);
    pnpm(['prune', '--prod', '--ignore-scripts']);
    await packageRuntimeWorkspaces(root, captured);

    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
      .toString()
      .split('\0')
      .filter(Boolean);
    const expected = new Set(tracked);
    for (const file of tracked) {
      const parts = file.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        expected.add(parts.slice(0, index).join('/'));
      }
      const actualHash = execFileSync('git', ['hash-object', file], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      const sourceHash = execFileSync('git', ['rev-parse', `HEAD:${file}`], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      assert.equal(actualHash, sourceHash, `Source blob changed: ${file}`);
    }
    const actual = [];
    const visit = async (directory = root) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (directory === root && ['.git', 'node_modules'].includes(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        actual.push(path.relative(root, absolute));
        if (entry.isDirectory()) await visit(absolute);
      }
    };
    await visit();
    assert.deepEqual(actual.sort(), [...expected].sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(store, { recursive: true, force: true });
  }
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
