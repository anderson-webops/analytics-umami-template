import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCacheKeys } from '../deploy/mac-build/cache-key.mjs';

const repository = 'anderson-webops/analytics.avasan.org';
const imageId = `sha256:${'a'.repeat(64)}`;

test('cache keys accept the actual checked-out release inputs', () => {
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const configPath = path.join(sourceRoot, 'deploy/mac-build/public-template.json');
  const keys = buildCacheKeys(
    sourceRoot,
    configPath,
    'anderson-webops/analytics-umami-template',
    imageId,
  );
  for (const key of Object.values(keys)) assert.match(key, /^[0-9a-f]{64}$/);
});

test('cache scopes reuse source edits but invalidate material build inputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'analytics-cache-key-'));
  try {
    const files = {
      'deploy/mac-build/Dockerfile': 'FROM pinned-image\n',
      'deploy/mac-build/container-phase.sh': 'echo build\n',
      'deploy/runtime-artifact.json': '{}\n',
      'next.config.ts': 'export default {};\n',
      'package.json': '{"name":"test","version":"4.2.166"}\n',
      'packages/api-client/package.json': '{"name":"api-client"}\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'pnpm-workspace.yaml': 'packages: []\n',
      'src/page.ts': 'export const page = 1;\n',
      'vendor/braces/index.js': 'module.exports = {};\n',
    };
    for (const [file, value] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), value);
    }
    await fs.link(
      path.join(root, 'vendor/braces/index.js'),
      path.join(root, 'vendor/braces/LICENSE'),
    );
    const configPath = path.join(root, 'public-config.json');
    await fs.writeFile(configPath, '{"site":"analytics.avasan.org"}\n');
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', ['-C', root, 'add', ...Object.keys(files), 'vendor/braces/LICENSE']);
    const initial = buildCacheKeys(root, configPath, repository, imageId);
    await fs.writeFile(path.join(root, 'src/page.ts'), 'export const page = 2;\n');
    assert.deepEqual(buildCacheKeys(root, configPath, repository, imageId), initial);
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"test","version":"4.2.167"}\n');
    const changedVersion = buildCacheKeys(root, configPath, repository, imageId);
    assert.equal(changedVersion.store, initial.store);
    assert.equal(changedVersion.dependency, initial.dependency);
    assert.notEqual(changedVersion.compiler, initial.compiler);

    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n');
    const changedLock = buildCacheKeys(root, configPath, repository, imageId);
    assert.equal(changedLock.store, initial.store);
    assert.notEqual(changedLock.dependency, initial.dependency);
    assert.notEqual(changedLock.compiler, initial.compiler);

    await fs.writeFile(configPath, '{"site":"analytics.avasan.org","mode":"private"}\n');
    const changedConfig = buildCacheKeys(root, configPath, repository, imageId);
    assert.equal(changedConfig.dependency, changedLock.dependency);
    assert.notEqual(changedConfig.compiler, changedLock.compiler);

    await fs.writeFile(path.join(root, 'deploy/runtime-artifact.json'), '{"version":2}\n');
    assert.notEqual(
      buildCacheKeys(root, configPath, repository, imageId).compiler,
      changedConfig.compiler,
    );
    await fs.writeFile(path.join(root, 'vendor/braces/index.js'), 'module.exports = null;\n');
    assert.notEqual(
      buildCacheKeys(root, configPath, repository, imageId).dependency,
      changedConfig.dependency,
    );
    assert.notEqual(
      buildCacheKeys(root, configPath, 'anderson-webops/analytics.dvanderson.net', imageId).store,
      initial.store,
    );
    assert.notEqual(
      buildCacheKeys(root, configPath, repository, `sha256:${'b'.repeat(64)}`).store,
      initial.store,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cache keys reject untracked or unsafe material inputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'analytics-cache-key-reject-'));
  try {
    await fs.mkdir(path.join(root, 'deploy/mac-build'), { recursive: true });
    await fs.mkdir(path.join(root, 'deploy'), { recursive: true });
    for (const file of [
      'deploy/mac-build/Dockerfile',
      'deploy/runtime-artifact.json',
      'package.json',
      'pnpm-workspace.yaml',
    ]) {
      await fs.writeFile(path.join(root, file), file === 'package.json' ? '{}\n' : 'synthetic\n');
    }
    const configPath = path.join(root, 'public-config.json');
    await fs.writeFile(configPath, '{}\n');
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', [
      '-C',
      root,
      'add',
      'deploy/mac-build/Dockerfile',
      'deploy/runtime-artifact.json',
      'package.json',
      'pnpm-workspace.yaml',
    ]);
    assert.throws(
      () => buildCacheKeys(root, configPath, repository, imageId),
      /Missing tracked build cache input: pnpm-lock.yaml/,
    );
    await fs.symlink('package.json', path.join(root, 'pnpm-lock.yaml'));
    execFileSync('git', ['-C', root, 'add', 'pnpm-lock.yaml']);
    assert.throws(
      () => buildCacheKeys(root, configPath, repository, imageId),
      /not a bounded regular file: pnpm-lock.yaml/,
    );
    assert.throws(
      () => buildCacheKeys(root, configPath, 'other/repository', imageId),
      /Invalid cache repository scope/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
