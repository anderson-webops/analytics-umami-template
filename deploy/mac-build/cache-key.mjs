import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredFiles = [
  'deploy/mac-build/Dockerfile',
  'deploy/runtime-artifact.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function dependencyInput(file) {
  return (
    file === '.npmrc' ||
    file === '.node-version' ||
    file === '.nvmrc' ||
    file === 'package.json' ||
    file === 'pnpm-lock.yaml' ||
    file === 'pnpm-workspace.yaml' ||
    file === 'deploy/mac-build/Dockerfile' ||
    /^packages\/[^/]+\/package\.json$/.test(file) ||
    /^(patches|vendor)\//.test(file)
  );
}

function compilerInput(file) {
  return (
    dependencyInput(file) ||
    file === 'deploy/runtime-artifact.json' ||
    /^deploy\/mac-build\/[^/]+\.(?:sh|mjs|json)$/.test(file) ||
    file === 'prisma/schema.prisma' ||
    file === 'prisma.config.ts' ||
    file === 'scripts/postbuild.js' ||
    /^scripts\/(?:build-|generate-|postbuild\.)[^/]+$/.test(file) ||
    /^(next|postcss|rollup|tailwind|tsup|vite)\.[^/]*config\.[^/]+$/.test(file) ||
    /^(?:packages\/[^/]+\/)?tsconfig[^/]*\.json$/.test(file)
  );
}

function fileDigest(root, file, includeVersion) {
  const target = path.join(root, file);
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024) {
    throw new Error(`Build cache input is not a bounded regular file: ${file}`);
  }
  const contents = readFileSync(target);
  if (file === 'package.json' && !includeVersion) {
    const manifest = JSON.parse(contents.toString('utf8'));
    delete manifest.version;
    return hash(manifest);
  }
  return createHash('sha256').update(contents).digest('hex');
}

export function buildCacheKeys(root, configPath, repository, imageId) {
  if (!/^anderson-webops\/[a-z0-9][a-z0-9.-]+$/.test(repository)) {
    throw new Error('Invalid cache repository scope.');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error('Invalid pinned Linux image identity.');
  }
  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  for (const required of requiredFiles) {
    if (!tracked.includes(required)) {
      throw new Error(`Missing tracked build cache input: ${required}`);
    }
  }
  const dependencyFiles = tracked.filter(dependencyInput).sort();
  const compilerFiles = tracked.filter(compilerInput).sort();
  const dependencyDigest = hash(dependencyFiles.map(file => [file, fileDigest(root, file, false)]));
  const compilerDigest = hash(compilerFiles.map(file => [file, fileDigest(root, file, true)]));
  const config = lstatSync(configPath);
  if (!config.isFile() || config.nlink !== 1 || config.size > 8 * 1024 * 1024) {
    throw new Error('Public build configuration is not a bounded regular file.');
  }
  const configurationDigest = createHash('sha256').update(readFileSync(configPath)).digest('hex');
  const store = hash(['pnpm-store-v1', repository, imageId]);
  const dependency = hash(['dependency-v1', store, dependencyDigest]);
  const compiler = hash(['next-compiler-v1', dependency, compilerDigest, configurationDigest]);
  return { store, dependency, compiler };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, configPath, repository, imageId] = process.argv.slice(2);
  if (!root || !configPath || !repository || !imageId) {
    process.stderr.write('Expected SOURCE_ROOT PUBLIC_CONFIG REPOSITORY IMAGE_ID.\n');
    process.exitCode = 64;
  } else {
    const keys = buildCacheKeys(root, configPath, repository, imageId);
    process.stdout.write(`anderson-pnpm-${keys.store} anderson-next-${keys.compiler}\n`);
  }
}
