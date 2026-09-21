import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  copyRuntimeArtifact,
  createRuntimeManifest,
  getSourceIdentity,
  verifyRuntimeArtifact,
} from './runtime-artifact.mjs';

const temporaryDirectories = [];
const source = { commit: 'a'.repeat(40), dirty: false };

async function createFixture() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'umami-runtime-artifact-'));
  const root = path.join(fixture, 'runtime');
  const contractPath = path.join(fixture, 'contract.json');
  const contract = {
    version: 1,
    manifest: 'runtime-manifest.json',
    entrypoints: ['server.js'],
    requiredFiles: ['package.json', 'pnpm-lock.yaml', 'server.js'],
    requiredDirectories: ['.next/cache'],
    requiredPatterns: [{ pattern: 'node_modules/*/package.json', minimum: 1 }],
    allowedRoots: ['.next', 'node_modules'],
    allowedFiles: ['package.json', 'pnpm-lock.yaml', 'server.js'],
    forbiddenStateTrees: ['.next/cache', 'uploads'],
    runtime: { os: 'linux', arch: 'arm64', libc: 'glibc', node: '24.18.1' },
  };

  temporaryDirectories.push(fixture);
  await fs.mkdir(path.join(root, '.next', 'cache'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'next'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"1.0.0"}\n');
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fs.writeFile(path.join(root, 'server.js'), 'console.log("ok");\n');
  await fs.writeFile(path.join(root, 'node_modules', 'next', 'package.json'), '{}\n');
  await fs.writeFile(contractPath, JSON.stringify(contract));

  return { root, contractPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true })),
  );
});

test('creates and verifies an exact hashed runtime inventory', async () => {
  const { root, contractPath } = await createFixture();
  const manifest = await createRuntimeManifest(root, { contractPath, source });

  assert.deepEqual(
    {
      commit: manifest.source.commit,
      dirty: manifest.source.dirty,
      version: manifest.source.version,
    },
    { commit: source.commit, dirty: false, version: '1.0.0' },
  );
  const verified = await verifyRuntimeArtifact(root, { contractPath });
  assert.equal(verified.source.commit, source.commit);
});

test('rejects a changed file even when the manifest itself is untouched', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });
  await fs.appendFile(path.join(root, 'server.js'), 'console.log("tampered");\n');

  await assert.rejects(verifyRuntimeArtifact(root, { contractPath }), /inventory or file hashes/);
});

test('rejects missing required modules and forbidden writable state', async () => {
  const { root, contractPath } = await createFixture();
  await fs.rm(path.join(root, 'server.js'));

  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /missing required file: server\.js/,
  );

  await fs.writeFile(path.join(root, 'server.js'), 'console.log("ok");\n');
  await fs.writeFile(path.join(root, '.next', 'cache', 'state.bin'), 'state');

  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /private or writable state/,
  );
});

test('rejects symlinks that escape the artifact root', async () => {
  const { root, contractPath } = await createFixture();
  await fs.symlink('../../outside', path.join(root, 'node_modules', 'escape'));

  await assert.rejects(
    createRuntimeManifest(root, { contractPath, source }),
    /escapes the artifact root/,
  );
});

test('refuses broad or overlapping copy destinations', async () => {
  const { root, contractPath } = await createFixture();
  await createRuntimeManifest(root, { contractPath, source });

  await assert.rejects(
    copyRuntimeArtifact(root, path.parse(root).root, { contractPath }),
    /too broad or overlaps protected source/,
  );
  await assert.rejects(
    copyRuntimeArtifact(root, path.join(root, 'nested', 'runtime'), { contractPath }),
    /too broad or overlaps protected source/,
  );
});

test('marks an otherwise clean checkout dirty when it contains an untracked source file', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'umami-runtime-source-'));
  temporaryDirectories.push(repository);
  await fs.writeFile(path.join(repository, 'tracked.txt'), 'tracked\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repository });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Runtime Test',
      '-c',
      'user.email=runtime-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: repository },
  );

  assert.equal(getSourceIdentity(repository).dirty, false);
  await fs.writeFile(path.join(repository, 'untracked.js'), 'console.log("untracked");\n');
  assert.equal(getSourceIdentity(repository).dirty, true);
});
