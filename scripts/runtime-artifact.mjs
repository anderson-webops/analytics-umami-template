/* eslint-disable no-console */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultContractPath = path.join(repositoryRoot, 'deploy', 'runtime-artifact.json');
const forbiddenNames = new Set(['.env', '.htpasswd', 'credentials.json', 'id_ed25519', 'id_rsa']);
const forbiddenSuffixes = new Set(['.db', '.key', '.p12', '.pem', '.pfx', '.sqlite', '.sqlite3']);
export const ARTIFACT_LIMITS = Object.freeze({
  depth: 32,
  entries: 200_000,
  fileBytes: 512 * 1024 * 1024,
  manifestBytes: 64 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024 * 1024,
});

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function readBoundedFile(filePath, maxBytes) {
  const file = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

  try {
    const metadata = await file.stat();

    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maxBytes) {
      throw new Error(`Artifact metadata file exceeds its reviewed limit: ${filePath}`);
    }

    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesReadTotal = 0;

    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        break;
      }

      bytesReadTotal += bytesRead;

      if (bytesReadTotal > maxBytes) {
        throw new Error(`Artifact metadata file exceeds its reviewed limit: ${filePath}`);
      }

      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    if ((await file.stat()).size !== bytesReadTotal) {
      throw new Error(`Artifact metadata file changed while reading: ${filePath}`);
    }

    return Buffer.concat(chunks, bytesReadTotal);
  } finally {
    await file.close();
  }
}

async function digestFile(filePath, expectedMetadata, root) {
  const file = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

  try {
    const metadata = await file.stat();

    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size !== expectedMetadata.size ||
      metadata.dev !== expectedMetadata.dev ||
      metadata.ino !== expectedMetadata.ino ||
      !isWithin(root, await fs.realpath(filePath))
    ) {
      throw new Error(`Artifact file changed before hashing: ${filePath}`);
    }

    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesHashed = 0;

    while (bytesHashed < expectedMetadata.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, expectedMetadata.size - bytesHashed),
        null,
      );

      if (bytesRead === 0) {
        throw new Error(`Artifact file changed while hashing: ${filePath}`);
      }

      hash.update(buffer.subarray(0, bytesRead));
      bytesHashed += bytesRead;
    }

    const finalMetadata = await fs.lstat(filePath);

    if (
      (await file.stat()).size !== expectedMetadata.size ||
      finalMetadata.dev !== metadata.dev ||
      finalMetadata.ino !== metadata.ino ||
      !isWithin(root, await fs.realpath(filePath))
    ) {
      throw new Error(`Artifact file changed while hashing: ${filePath}`);
    }

    return hash.digest('hex');
  } finally {
    await file.close();
  }
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

function validateDeploymentContract(deployment) {
  if (deployment === undefined) return;

  const capabilities = deployment?.requiredAdapterCapabilities;
  const probes = deployment?.probes;
  const database = deployment?.database;
  const hostControlled = deployment?.hostControlled;
  const rollback = database?.rollback;
  const databaseAwareRecovery = rollback === 'protected-pre-traffic-database-restore-v1';
  const requiredCapabilities = [
    'artifact-only-promotion-v1',
    'verified-source-and-payload-v1',
    'guarded-forward-migrations-v1',
    'retained-artifact-rollback-v1',
    'version-aware-readiness-v1',
  ];
  const knownCapabilities = new Set([
    ...requiredCapabilities,
    'coordinated-listener-transition-v1',
    'classroom-2fa-privacy-acceptance-v1',
    'database-aware-recovery-v1',
  ]);
  const knownHostControls = new Set([
    'service-user',
    'listener',
    'reverse-proxy',
    'protected-environment',
    'database',
  ]);
  const exactArray = (values, known) =>
    Array.isArray(values) &&
    values.length === known.size &&
    new Set(values).size === known.size &&
    values.every(value => known.has(value));
  const exactFields = (actual, expected) =>
    actual !== null &&
    typeof actual === 'object' &&
    !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual[key], value));

  if (
    !exactFields(deployment, {
      schemaVersion: 1,
      applicationId: deployment?.applicationId,
      requiredAdapterCapabilities: capabilities,
      probes,
      database,
      hostControlled,
    }) ||
    typeof deployment.applicationId !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{2,100}$/.test(deployment.applicationId) ||
    !Array.isArray(capabilities) ||
    new Set(capabilities).size !== capabilities.length ||
    !capabilities.every(value => knownCapabilities.has(value)) ||
    !requiredCapabilities.every(value => capabilities.includes(value)) ||
    capabilities.includes('database-aware-recovery-v1') !== databaseAwareRecovery ||
    ![
      'rehearse-retained-runtime-against-migrated-copy',
      'protected-pre-traffic-database-restore-v1',
    ].includes(rollback) ||
    !exactArray(hostControlled, knownHostControls) ||
    !exactFields(probes, {
      health: { path: '/healthz', methods: ['GET', 'HEAD'], success: 200 },
      readiness: { path: '/readyz', methods: ['GET', 'HEAD'], success: 200, failure: 503 },
    }) ||
    !exactFields(database, {
      prePromotionGate: 'scripts/check-db.js',
      migrationMode: 'forward-only',
      rollback,
    })
  ) {
    throw new Error('Unsupported or incomplete deployment compatibility contract.');
  }
}

async function readContract(contractPath = defaultContractPath) {
  const contents = await readBoundedFile(contractPath, 1024 * 1024);
  const contract = JSON.parse(contents.toString());

  if (
    contract.version !== 1 ||
    !Array.isArray(contract.allowedFiles) ||
    !Array.isArray(contract.allowedRoots) ||
    !Array.isArray(contract.requiredFiles)
  ) {
    throw new Error('Unsupported or incomplete runtime artifact contract.');
  }

  validateDeploymentContract(contract.deployment);

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
  let entryCount = 0;
  let totalBytes = 0;

  async function walk(directory, depth) {
    if (depth > ARTIFACT_LIMITS.depth) {
      throw new Error('Artifact directory depth exceeds the reviewed limit.');
    }

    const directoryMetadata = await fs.lstat(directory);

    if (!directoryMetadata.isDirectory() || !isWithin(root, await fs.realpath(directory))) {
      throw new Error(`Artifact directory changed while traversing: ${directory}`);
    }

    const children = [];

    for await (const child of await fs.opendir(directory)) {
      if (directory === root && child.name === manifestName) {
        continue;
      }

      children.push(child);

      if (children.length > ARTIFACT_LIMITS.entries - entryCount) {
        throw new Error('Artifact entry count exceeds the reviewed limit.');
      }
    }

    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, child.name);
      const relativePath = normalizeRelative(
        path.relative(root, fullPath).split(path.sep).join('/'),
      );

      if (relativePath === manifestName) {
        continue;
      }

      entryCount += 1;

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
        await walk(fullPath, depth + 1);
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

      if (
        !Number.isSafeInteger(metadata.size) ||
        metadata.size > ARTIFACT_LIMITS.fileBytes ||
        totalBytes + metadata.size > ARTIFACT_LIMITS.totalBytes
      ) {
        throw new Error(`Artifact file or total size exceeds the reviewed limit: ${relativePath}`);
      }

      totalBytes += metadata.size;

      entries[relativePath] = {
        type: 'file',
        mode: mode.toString(8).padStart(4, '0'),
        size: metadata.size,
        sha256: await digestFile(fullPath, metadata, root),
      };
    }

    const finalDirectoryMetadata = await fs.lstat(directory);

    if (
      finalDirectoryMetadata.dev !== directoryMetadata.dev ||
      finalDirectoryMetadata.ino !== directoryMetadata.ino ||
      !isWithin(root, await fs.realpath(directory))
    ) {
      throw new Error(`Artifact directory changed while traversing: ${directory}`);
    }
  }

  await walk(root, 0);

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
  const commit = gitValue(['rev-parse', 'HEAD'], root);
  const suppliedCommit = root === repositoryRoot ? process.env.SOURCE_COMMIT?.trim() : undefined;

  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Runtime artifact source commit must be a full lowercase SHA-1.');
  }

  if (suppliedCommit && suppliedCommit !== commit) {
    throw new Error('Runtime artifact source commit does not match the Git checkout.');
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

  const packageJson = JSON.parse(
    (await readBoundedFile(path.join(root, 'package.json'), 1024 * 1024)).toString(),
  );
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
    ...(contract.deployment ? { deployment: contract.deployment } : {}),
    contractSha256: contractDigest,
    entries,
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });

  return manifest;
}

export async function verifyRuntimeArtifact(
  root,
  {
    contractPath = defaultContractPath,
    expectedCommit,
    expectedApplicationId,
    release = false,
  } = {},
) {
  root = await fs.realpath(path.resolve(root));
  const { contract, contractDigest } = await readContract(contractPath);
  const manifestPath = path.join(root, contract.manifest);
  const manifest = JSON.parse(
    (await readBoundedFile(manifestPath, ARTIFACT_LIMITS.manifestBytes)).toString(),
  );

  if (manifest.format !== 1 || manifest.artifact !== 'umami-direct-runtime') {
    throw new Error('Unsupported runtime artifact manifest.');
  }

  if (manifest.contractSha256 !== contractDigest) {
    throw new Error('Runtime artifact contract digest does not match the trusted source contract.');
  }

  if (!isDeepStrictEqual(manifest.deployment, contract.deployment)) {
    throw new Error(
      'Runtime artifact deployment requirements do not match the trusted source contract.',
    );
  }

  if (
    expectedApplicationId !== undefined &&
    manifest.deployment?.applicationId !== expectedApplicationId
  ) {
    throw new Error('Runtime artifact application identity does not match the expected site.');
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

// Called only with the builder stopped and the tree inaccessible to writers.
// Hashes and source identity always come from the already verified manifest.
export async function sealRuntimeArtifact(root, options = {}) {
  root = await fs.realpath(path.resolve(root));
  const before = await verifyRuntimeArtifact(root, options);
  const { contract } = await readContract(options.contractPath ?? defaultContractPath);
  const expected = structuredClone(before);
  for (const entry of Object.values(expected.entries)) {
    if (entry.type !== 'symlink') {
      const executable = entry.type === 'directory' || Number.parseInt(entry.mode, 8) & 0o111;
      entry.mode = executable ? '0555' : '0444';
    }
  }
  // Children first: remove write access from their containing directories last.
  for (const [relative, entry] of Object.entries(expected.entries).reverse()) {
    if (entry.type !== 'symlink')
      await fs.chmod(path.join(root, relative), Number.parseInt(entry.mode, 8));
  }
  const actual = await collectEntries(root, contract, contract.manifest);
  if (JSON.stringify(actual) !== JSON.stringify(expected.entries)) {
    throw new Error('Immutable permission transition changed the verified runtime payload.');
  }
  const manifestPath = path.join(root, contract.manifest);
  const temporary = `${manifestPath}.sealing-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(expected, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o444,
  });
  await fs.rename(temporary, manifestPath);
  await fs.chmod(manifestPath, 0o444);
  await fs.chmod(root, 0o555);
  return verifyRuntimeArtifact(root, options);
}

async function main() {
  const [command, root, ...args] = process.argv.slice(2);
  const release = args.includes('--release');
  const expectedIndex = args.indexOf('--expected-commit');
  const expectedCommit = expectedIndex >= 0 ? args[expectedIndex + 1] : undefined;
  const applicationIndex = args.indexOf('--expected-application');
  const expectedApplicationId = applicationIndex >= 0 ? args[applicationIndex + 1] : undefined;

  if (applicationIndex >= 0 && !expectedApplicationId) {
    throw new Error('--expected-application requires a nonempty application ID.');
  }

  if (command === 'create' && root) {
    const manifest = await createRuntimeManifest(root);
    console.log(
      `Created runtime manifest for ${Object.keys(manifest.entries).length} paths at ${root}.`,
    );
    return;
  }

  if ((command === 'verify' || command === 'seal') && root) {
    const contractIndex = args.indexOf('--contract');
    const contractPath = contractIndex >= 0 ? args[contractIndex + 1] : undefined;
    if (command === 'seal') {
      await sealRuntimeArtifact(root, {
        release,
        expectedCommit,
        expectedApplicationId,
        contractPath,
      });
    }
    const manifest = await verifyRuntimeArtifact(root, {
      release,
      expectedCommit,
      expectedApplicationId,
      contractPath,
    });
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
    const copyApplicationIndex = remainingArgs.indexOf('--expected-application');
    const copyExpectedApplicationId =
      copyApplicationIndex >= 0 ? remainingArgs[copyApplicationIndex + 1] : undefined;

    if (copyApplicationIndex >= 0 && !copyExpectedApplicationId) {
      throw new Error('--expected-application requires a nonempty application ID.');
    }

    await copyRuntimeArtifact(root, destination, {
      release: copyRelease,
      expectedCommit: copyExpectedCommit,
      expectedApplicationId: copyExpectedApplicationId,
    });
    console.log(`Copied and reverified runtime artifact at ${destination}.`);
    return;
  }

  throw new Error(
    'Usage: runtime-artifact.mjs create ROOT | verify ROOT [--release] [--expected-commit SHA] [--expected-application ID] | copy SOURCE DEST [--release] [--expected-commit SHA] [--expected-application ID]',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
