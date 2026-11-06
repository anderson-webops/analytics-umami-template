import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const toolchainSource = fileURLToPath(new URL('../build-toolchain/', import.meta.url));
export const toolchainMetadata = JSON.parse(
  readFileSync(path.join(toolchainSource, 'UPSTREAM.json'), 'utf8'),
);
const toolchainManifest = JSON.parse(
  readFileSync(path.join(toolchainSource, 'package.json'), 'utf8'),
);

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function selectedNpmCli() {
  if (process.env.npm_execpath) return realpathSync(process.env.npm_execpath);
  const directory = path.dirname(process.execPath);
  if (process.platform === 'win32')
    return realpathSync(path.join(directory, '../node_modules/npm/bin/npm-cli.js'));
  return realpathSync(path.join(directory, 'npm'));
}

function regularFileBytes(filename, message) {
  let descriptor;
  try {
    descriptor = openSync(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === 'ELOOP') assert.fail(message);
    throw error;
  }
  try {
    assert.ok(fstatSync(descriptor).isFile(), message);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function stableVersionAtLeast(version, minimum, sameMajor = false) {
  if (typeof version !== 'string' || version.length > 256) return false;
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u.exec(
      version.trim(),
    );
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger) || (sameMajor && parts[0] !== minimum[0])) return false;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

function dependencyManifestBytes(require, name, prefix, lock) {
  for (const directory of require.resolve.paths(name) || []) {
    const relative = path.relative(prefix, directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      continue;
    try {
      const packageDirectory = realpathSync(path.join(directory, name));
      const location = path.relative(prefix, packageDirectory).split(path.sep).join('/');
      assert.ok(
        Object.hasOwn(lock.packages, location),
        `Selected ${name} must belong to its independent lock`,
      );
      const bytes = regularFileBytes(
        path.join(packageDirectory, 'package.json'),
        `Toolchain dependency manifest must be regular: ${name}`,
      );
      return { bytes, location };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
  }
  throw Object.assign(new Error(`Missing locked build-toolchain dependency: ${name}`), {
    code: 'MODULE_NOT_FOUND',
  });
}

export function verifyBuildToolchain(cli = selectedNpmCli()) {
  assert.equal(
    process.version,
    `v${toolchainMetadata.node}`,
    'Select the pinned Node before preparing the build toolchain',
  );
  const safeOpenFlags =
    Number.isInteger(constants.O_NOFOLLOW) &&
    constants.O_NOFOLLOW > 0 &&
    Number.isInteger(constants.O_NONBLOCK) &&
    constants.O_NONBLOCK > 0;
  assert.ok(
    safeOpenFlags,
    'Build toolchain verification requires no-follow and nonblocking file opens on this platform',
  );
  const npmRoot = path.resolve(path.dirname(realpathSync(cli)), '..');
  const prefix = path.resolve(npmRoot, '../..');
  const verifiedFiles = new Map();
  for (const name of [
    'package.json',
    'package-lock.json',
    '.npmrc',
    'UPSTREAM.json',
    toolchainMetadata.archive,
  ]) {
    const installed = path.join(prefix, name);
    const bytes = regularFileBytes(installed, `Toolchain input must be a regular file: ${name}`);
    assert.ok(
      bytes.equals(readFileSync(path.join(toolchainSource, name))),
      `Toolchain input differs: ${name}`,
    );
    verifiedFiles.set(installed, bytes);
  }
  assert.equal(
    sha256(verifiedFiles.get(path.join(prefix, 'package-lock.json'))),
    toolchainMetadata.lockSha256,
  );
  assert.equal(
    sha256(verifiedFiles.get(path.join(prefix, toolchainMetadata.archive))),
    toolchainMetadata.archiveSha256,
  );
  for (const entry of toolchainMetadata.files) {
    const relative = entry.path.slice('package/'.length);
    assert.ok(entry.path.startsWith('package/') && !relative.split('/').includes('..'));
    const filename = path.join(npmRoot, relative);
    const bytes = regularFileBytes(filename, `npm CLI file must be regular: ${relative}`);
    assert.equal(sha256(bytes), entry.sha256, `npm CLI file differs: ${relative}`);
    verifiedFiles.set(filename, bytes);
  }
  const require = createRequire(path.join(npmRoot, 'package.json'));
  const lock = JSON.parse(
    verifiedFiles.get(path.join(prefix, 'package-lock.json')).toString('utf8'),
  );
  const versions = {};
  for (const name of ['npm', 'glob', 'minimatch', 'undici']) {
    const { bytes, location } =
      name === 'npm'
        ? {
            bytes: verifiedFiles.get(path.join(npmRoot, 'package.json')),
            location: path.relative(prefix, npmRoot).split(path.sep).join('/'),
          }
        : dependencyManifestBytes(require, name, prefix, lock);
    const actual = JSON.parse(bytes.toString('utf8')).version;
    assert.equal(
      actual,
      lock.packages[location]?.version,
      `Selected ${name} must match its independent lock`,
    );
    versions[name] = actual;
  }
  assert.equal(versions.npm, toolchainMetadata.npm);
  assert.equal(versions.glob, toolchainManifest.overrides.glob);
  assert.equal(versions.minimatch, toolchainManifest.overrides.minimatch);
  assert.ok(stableVersionAtLeast(versions.glob, [14, 0, 2]));
  assert.ok(stableVersionAtLeast(versions.minimatch, [11, 0, 1]));
  assert.ok(
    [
      [6, 29, 1],
      [7, 30, 1],
      [8, 12, 2],
    ].some(minimum => stableVersionAtLeast(versions.undici, minimum, true)),
  );
  return {
    profile: toolchainMetadata.profile,
    lockSha256: toolchainMetadata.lockSha256,
    node: process.versions.node,
    versions,
  };
}
