import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { repairStandaloneRuntime } from './repair-standalone.js';
import { createRuntimeManifest } from './runtime-artifact.mjs';

async function copyRuntimePath(sourcePath, destinationPath) {
  try {
    await fs.access(sourcePath);
  } catch {
    return;
  }

  await fs.rm(destinationPath, { force: true, recursive: true });
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.cp(sourcePath, destinationPath, { force: true, recursive: true });
}

async function bundleRuntimeScript(entryPoint, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await build({
    entryPoints: [entryPoint],
    outfile: outputPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'bundle',
    banner: {
      js: "import { createRequire as __umamiCreateRequire } from 'node:module'; const require = __umamiCreateRequire(import.meta.url);",
    },
    logLevel: 'silent',
  });
  await fs.chmod(outputPath, 0o640);
}

async function configureTracker(appDir) {
  const endpoint = process.env.COLLECT_API_ENDPOINT?.trim();

  if (!endpoint) {
    return;
  }

  if (
    endpoint === '/' ||
    !/^\/[A-Za-z0-9._~!$&'()+,;=@%/-]+$/.test(endpoint) ||
    endpoint.split('/').includes('..') ||
    endpoint.includes('//')
  ) {
    throw new Error('COLLECT_API_ENDPOINT must be a safe non-root application path.');
  }

  const trackerPath = path.join(appDir, 'public', 'script.js');
  const tracker = await fs.readFile(trackerPath, 'utf8');
  const configured = tracker.replaceAll('/api/send', endpoint);

  if (configured === tracker) {
    throw new Error('The built tracker did not contain its expected collection endpoint.');
  }

  await fs.writeFile(trackerPath, configured);
}

async function run() {
  const { appDir } = await repairStandaloneRuntime();

  if (!appDir) {
    throw new Error('The standalone production runtime was not generated.');
  }

  for (const relativePath of ['public', 'geo', 'prisma', 'generated', '.next/static']) {
    await copyRuntimePath(path.resolve(relativePath), path.join(appDir, relativePath));
  }

  for (const fileName of [
    '.node-version',
    '.nvmrc',
    'package.json',
    'pnpm-lock.yaml',
    'prisma.config.ts',
  ]) {
    await copyRuntimePath(path.resolve(fileName), path.join(appDir, fileName));
  }

  const runtimeScriptsDirectory = path.join(appDir, 'runtime-scripts');

  await fs.rm(runtimeScriptsDirectory, { recursive: true, force: true });
  await bundleRuntimeScript(
    path.resolve('scripts/check-env.js'),
    path.join(runtimeScriptsDirectory, 'check-env.mjs'),
  );
  await bundleRuntimeScript(
    path.resolve('scripts/check-db.js'),
    path.join(runtimeScriptsDirectory, 'check-db.mjs'),
  );
  await bundleRuntimeScript(
    path.resolve('scripts/artifact-smoke.mjs'),
    path.join(runtimeScriptsDirectory, 'artifact-smoke.mjs'),
  );
  await copyRuntimePath(
    path.resolve('scripts/start-runtime.mjs'),
    path.join(runtimeScriptsDirectory, 'start-production.mjs'),
  );

  await fs.rm(path.join(appDir, '.next', 'cache'), { recursive: true, force: true });
  await fs.mkdir(path.join(appDir, '.next', 'cache'), { recursive: true, mode: 0o750 });
  await configureTracker(appDir);

  const manifest = await createRuntimeManifest(appDir);

  console.log(
    `Prepared and hashed ${Object.keys(manifest.entries).length} runtime paths at ${path.relative(process.cwd(), appDir)}.`,
  );
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
