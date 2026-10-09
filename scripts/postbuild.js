import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { rollup } from 'rollup';
import trackerConfig from '../rollup.tracker.config.js';
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

async function copyReplayCssBindings(appDir) {
  const packageRoot = await fs.realpath(path.resolve('node_modules/lightningcss'));
  const dependencyRoot = path.dirname(packageRoot);
  const { version } = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const bindings = new Set(['lightningcss-linux-arm64-gnu']);

  if (process.platform === 'darwin') {
    bindings.add(`lightningcss-darwin-${process.arch}`);
  }

  for (const name of bindings) {
    const sourcePath = await fs.realpath(path.join(dependencyRoot, name));
    const metadata = JSON.parse(await fs.readFile(path.join(sourcePath, 'package.json'), 'utf8'));
    const nativeFile = `${name.replace('lightningcss-', 'lightningcss.')}.node`;

    if (
      metadata.name !== name ||
      metadata.version !== version ||
      !(await fs.stat(path.join(sourcePath, nativeFile))).isFile()
    ) {
      throw new Error(`The locked ${name} native binding is unavailable.`);
    }

    await copyRuntimePath(sourcePath, path.join(appDir, 'node_modules', name));
  }
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
  if (!process.env.COLLECT_API_ENDPOINT) {
    return;
  }

  const bundle = await rollup(trackerConfig);

  try {
    const { output } = await bundle.generate(trackerConfig.output);

    if (output.length !== 1 || output[0].type !== 'chunk') {
      throw new Error('The tracker build must produce exactly one browser script.');
    }

    await fs.writeFile(path.join(appDir, 'public', 'script.js'), output[0].code);
  } finally {
    await bundle.close();
  }
}

async function run() {
  const { appDir } = await repairStandaloneRuntime();

  if (!appDir) {
    throw new Error('The standalone production runtime was not generated.');
  }

  await copyReplayCssBindings(appDir);

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
