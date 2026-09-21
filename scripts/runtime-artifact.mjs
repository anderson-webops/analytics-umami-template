/* eslint-disable no-console */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultContractPath = path.join(repositoryRoot, 'deploy', 'runtime-artifact.json');
const forbiddenNames = new Set(['.env', '.htpasswd', 'credentials.json', 'id_ed25519', 'id_rsa']);
const forbiddenSuffixes = new Set(['.db', '.key', '.p12', '.pem', '.pfx', '.sqlite', '.sqlite3']);

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function digestFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

function normalizeRelative(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error(`Unsafe artifact path: ${relativePath}`);
  }

  const normalized = path.posix.normalize(relativePath);

  if (normalized !== relativePath || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe artifact path: ${relativePath}`);
  }

  return normalized;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function matchesAllowedPath(relativePath, contract) {
  if (contract.allowedFiles.includes(relativePath)) {
    return true;
  }

  return contract.allowedRoots.some(
    root => relativePath === root || relativePath.startsWith(`${root}/`),
  );
}

function isForbidden(relativePath, contract) {
  const parts = relativePath.toLowerCase().split('/');
  const baseName = parts.at(-1);
  const extension = path.posix.extname(baseName);

  if (
    forbiddenNames.has(baseName) ||
    baseName.startsWith('.env.') ||
    forbiddenSuffixes.has(extension)
  ) {
    return true;
  }

  return contract.forbiddenStateTrees.some(
    tree => relativePath !== tree && relativePath.startsWith(`${tree}/`),
  );
}

function globRegex(pattern) {
  let expression = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }

  return new RegExp(`${expression}$`);
}

async function readContract(contractPath = defaultContractPath) {
  const contents = await fs.readFile(contractPath);
  const contract = JSON.parse(contents.toString());

  if (
    contract.version !== 1 ||
    !Array.isArray(contract.allowedFiles) ||
    !Array.isArray(contract.allowedRoots) ||
    !Array.isArray(contract.requiredFiles)
  ) {
    throw new Error('Unsupported or incomplete runtime artifact contract.');
  }

  for (const key of [
    'allowedFiles',
    'allowedRoots',
    'entrypoints',
    'forbiddenStateTrees',
    'requiredDirectories',
    'requiredFiles',
  ]) {
    contract[key] = (contract[key] ?? []).map(normalizeRelative);
  }

  for (const requirement of contract.requiredPatterns ?? []) {
    normalizeRelative(requirement.pattern);

    if (!Number.isSafeInteger(requirement.minimum) || requirement.minimum < 1) {
      throw new Error(`Invalid minimum for required pattern ${requirement.pattern}.`);
    }
  }

  return { contract, contractDigest: sha256(contents) };
}

async function collectEntries(root, contract, manifestName) {
  const entries = {};

  async function walk(directory) {
    const children = await fs.readdir(directory, { withFileTypes: true });

    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, child.name);
      const relativePath = normalizeRelative(
        path.relative(root, fullPath).split(path.sep).join('/'),
      );

      if (relativePath === manifestName) {
        continue;
      }

      if (!matchesAllowedPath(relativePath, contract)) {
        throw new Error(`Artifact contains a path outside the reviewed contract: ${relativePath}`);
      }

      if (isForbidden(relativePath, contract)) {
        throw new Error(`Artifact contains private or writable state: ${relativePath}`);
      }

      const metadata = await fs.lstat(fullPath);
      const mode = metadata.mode & 0o777;

      if (!metadata.isSymbolicLink() && mode & 0o022) {
        throw new Error(`Artifact path is group- or world-writable: ${relativePath}`);
      }

      if (metadata.isDirectory()) {
        entries[relativePath] = { type: 'directory', mode: mode.toString(8).padStart(4, '0') };
        await walk(fullPath);
        continue;
      }

      if (metadata.isSymbolicLink()) {
        const target = await fs.readlink(fullPath);

        if (path.isAbsolute(target)) {
          throw new Error(`Artifact symlink has an absolute target: ${relativePath}`);
        }

        const resolvedTarget = path.resolve(path.dirname(fullPath), target);

        if (!isWithin(root, resolvedTarget)) {
          throw new Error(`Artifact symlink escapes the artifact root: ${relativePath}`);
        }

        const realTarget = await fs.realpath(fullPath);

        if (!isWithin(root, realTarget)) {
          throw new Error(`Artifact symlink resolves outside the artifact root: ${relativePath}`);
        }

        await fs.stat(fullPath);
        entries[relativePath] = { type: 'symlink', target };
        continue;
      }

      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(`Artifact contains an unsupported filesystem object: ${relativePath}`);
      }

      entries[relativePath] = {
        type: 'file',
        mode: mode.toString(8).padStart(4, '0'),
        size: metadata.size,
        sha256: await digestFile(fullPath),
      };
    }
  }

  await walk(root);

  return entries;
}

function verifyContractCoverage(entries, contract) {
  for (const requiredPath of contract.requiredFiles) {
    if (!entries[requiredPath] || entries[requiredPath].type === 'directory') {
      throw new Error(`Artifact is missing required file: ${requiredPath}`);
    }
  }

  for (const requiredPath of contract.requiredDirectories) {
    if (entries[requiredPath]?.type !== 'directory') {
      throw new Error(`Artifact is missing required directory: ${requiredPath}`);
    }
  }

  const entryPaths = Object.keys(entries);

  for (const requirement of contract.requiredPatterns ?? []) {
    const matcher = globRegex(requirement.pattern);
    const matches = entryPaths.filter(entry => matcher.test(entry));

    if (matches.length < requirement.minimum) {
      throw new Error(
        `Artifact pattern ${requirement.pattern} matched ${matches.length}; expected at least ${requirement.minimum}.`,
      );
    }
  }
}

function gitValue(args, root = repositoryRoot) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function getSourceIdentity(root = repositoryRoot) {
  const commit =
    (root === repositoryRoot ? process.env.SOURCE_COMMIT?.trim() : undefined) ||
    gitValue(['rev-parse', 'HEAD'], root);

  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Runtime artifact source commit must be a full lowercase SHA-1.');
  }

  const dirty = gitValue(['status', '--porcelain'], root).length > 0;

  return { commit, dirty };
}

function runtimeIdentity() {
  const header = process.report?.getReport?.().header ?? {};

  return {
    node: process.versions.node,
    os: process.platform,
    arch: process.arch,
    libc: header.glibcVersionRuntime ? 'glibc' : process.platform === 'linux' ? 'unknown' : null,
  };
}

export async function createRuntimeManifest(
  root,
  { contractPath = defaultContractPath, source = getSourceIdentity() } = {},
) {
  root = await fs.realpath(path.resolve(root));
  const { contract, contractDigest } = await readContract(contractPath);
  const manifestPath = path.join(root, contract.manifest);

  await fs.rm(manifestPath, { force: true });

  const entries = await collectEntries(root, contract, contract.manifest);
  verifyContractCoverage(entries, contract);

  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = {
    format: 1,
    artifact: 'umami-direct-runtime',
    createdAt: new Date().toISOString(),
    source: {
      commit: source.commit,
      dirty: source.dirty,
      version: packageJson.version,
      lockfileSha256: entries['pnpm-lock.yaml'].sha256,
    },
    runtime: runtimeIdentity(),
    contractSha256: contractDigest,
    entries,
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });

  return manifest;
}

export async function verifyRuntimeArtifact(
  root,
  { contractPath = defaultContractPath, expectedCommit, release = false } = {},
) {
  root = await fs.realpath(path.resolve(root));
  const { contract, contractDigest } = await readContract(contractPath);
  const manifestPath = path.join(root, contract.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  if (manifest.format !== 1 || manifest.artifact !== 'umami-direct-runtime') {
    throw new Error('Unsupported runtime artifact manifest.');
  }

  if (manifest.contractSha256 !== contractDigest) {
    throw new Error('Runtime artifact contract digest does not match the trusted source contract.');
  }

  if (expectedCommit && manifest.source?.commit !== expectedCommit) {
    throw new Error('Runtime artifact source commit does not match the trusted release commit.');
  }

  if (manifest.source?.lockfileSha256 !== manifest.entries?.['pnpm-lock.yaml']?.sha256) {
    throw new Error('Runtime artifact lockfile identity is inconsistent.');
  }

  if (release) {
    if (manifest.source?.dirty) {
      throw new Error('A release artifact cannot originate from a dirty checkout.');
    }

    for (const key of ['node', 'os', 'arch', 'libc']) {
      if (manifest.runtime?.[key] !== contract.runtime[key]) {
        throw new Error(
          `Release runtime ${key} is ${manifest.runtime?.[key]}; expected ${contract.runtime[key]}.`,
        );
      }
    }
  }

  const entries = await collectEntries(root, contract, contract.manifest);
  verifyContractCoverage(entries, contract);

  if (JSON.stringify(entries) !== JSON.stringify(manifest.entries)) {
    throw new Error('Runtime artifact inventory or file hashes do not match the manifest.');
  }

  return manifest;
}

export async function copyRuntimeArtifact(source, destination, options = {}) {
  source = path.resolve(source);
  destination = path.resolve(destination);

  const destinationParts = path
    .relative(path.parse(destination).root, destination)
    .split(path.sep)
    .filter(Boolean);
  const forbiddenDestinations = new Set([
    path.parse(destination).root,
    os.homedir(),
    repositoryRoot,
    process.cwd(),
    source,
  ]);

  if (
    destinationParts.length < 3 ||
    forbiddenDestinations.has(destination) ||
    isWithin(source, destination) ||
    isWithin(destination, source) ||
    isWithin(destination, repositoryRoot)
  ) {
    throw new Error('Runtime artifact copy destination is too broad or overlaps protected source.');
  }

  await verifyRuntimeArtifact(source, options);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });

  return verifyRuntimeArtifact(destination, options);
}

async function main() {
  const [command, root, ...args] = process.argv.slice(2);
  const release = args.includes('--release');
  const expectedIndex = args.indexOf('--expected-commit');
  const expectedCommit = expectedIndex >= 0 ? args[expectedIndex + 1] : undefined;

  if (command === 'create' && root) {
    const manifest = await createRuntimeManifest(root);
    console.log(
      `Created runtime manifest for ${Object.keys(manifest.entries).length} paths at ${root}.`,
    );
    return;
  }

  if (command === 'verify' && root) {
    const manifest = await verifyRuntimeArtifact(root, { release, expectedCommit });
    console.log(
      `Verified runtime artifact ${manifest.source.version} at ${manifest.source.commit}.`,
    );
    return;
  }

  if (command === 'copy' && root && args[0]) {
    const destination = args[0];
    const remainingArgs = args.slice(1);
    const copyRelease = remainingArgs.includes('--release');
    const copyExpectedIndex = remainingArgs.indexOf('--expected-commit');
    const copyExpectedCommit =
      copyExpectedIndex >= 0 ? remainingArgs[copyExpectedIndex + 1] : undefined;

    await copyRuntimeArtifact(root, destination, {
      release: copyRelease,
      expectedCommit: copyExpectedCommit,
    });
    console.log(`Copied and reverified runtime artifact at ${destination}.`);
    return;
  }

  throw new Error(
    'Usage: runtime-artifact.mjs create ROOT | verify ROOT [--release] [--expected-commit SHA] | copy SOURCE DEST [--release] [--expected-commit SHA]',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
