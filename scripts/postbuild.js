import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { rollup } from 'rollup';
import trackerConfig from '../rollup.tracker.config.js';
import { getGeoSource, verifyGeoDatabase } from './geo-build.mjs';
import { shortenPnpmSymlinks } from './portable-pnpm-links.mjs';
import { pruneForeignRuntimePackages } from './prune-foreign-runtime-packages.mjs';
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
  const runtimeNodeModules = path.join(appDir, 'node_modules');
  const runtimeDependencyRoot = path.dirname(
    await fs.realpath(path.join(runtimeNodeModules, 'lightningcss')),
  );
  if (
    runtimeDependencyRoot !== runtimeNodeModules &&
    !runtimeDependencyRoot.startsWith(`${runtimeNodeModules}${path.sep}`)
  ) {
    throw new Error('The traced lightningcss package escapes the standalone runtime.');
  }
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

    const runtimeBinding = path.join(runtimeNodeModules, name);
    await copyRuntimePath(sourcePath, runtimeBinding);

    const tracedBinding = path.join(runtimeDependencyRoot, name);
    if (tracedBinding !== runtimeBinding) {
      try {
        await fs.lstat(tracedBinding);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await fs.symlink(path.relative(runtimeDependencyRoot, runtimeBinding), tracedBinding);
      }
    }
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

  for (const relativePath of ['public', 'prisma', 'generated', '.next/static']) {
    await copyRuntimePath(path.resolve(relativePath), path.join(appDir, relativePath));
  }
  await copyRuntimePath(
    path.resolve('db/clickhouse/migrations/15_expire_new_heatmap_events.sql'),
    path.join(appDir, 'db/clickhouse/migrations/15_expire_new_heatmap_events.sql'),
  );
  await copyRuntimePath(
    path.resolve('db/clickhouse/migrations/16_expire_new_session_replays.sql'),
    path.join(appDir, 'db/clickhouse/migrations/16_expire_new_session_replays.sql'),
  );
  await copyRuntimePath(
    path.resolve('db/clickhouse/migrations/17_add_session_data_trust_tier.sql'),
    path.join(appDir, 'db/clickhouse/migrations/17_add_session_data_trust_tier.sql'),
  );
  await copyRuntimePath(
    path.resolve('db/clickhouse/migrations/18_disable_unverified_revenue_materialization.sql'),
    path.join(appDir, 'db/clickhouse/migrations/18_disable_unverified_revenue_materialization.sql'),
  );
  await copyRuntimePath(
    path.resolve('db/clickhouse/migrations/19_add_event_collection_trust_tier.sql'),
    path.join(appDir, 'db/clickhouse/migrations/19_add_event_collection_trust_tier.sql'),
  );
  await copyRuntimePath(
    path.resolve('db/clickhouse/migrations/20_add_verified_event_data_pivot.sql'),
    path.join(appDir, 'db/clickhouse/migrations/20_add_verified_event_data_pivot.sql'),
  );

  await fs.rm(path.join(appDir, 'geo'), { force: true, recursive: true });
  await copyRuntimePath(
    path.resolve('geo/GeoLite2-City.mmdb'),
    path.join(appDir, 'geo/GeoLite2-City.mmdb'),
  );
  await verifyGeoDatabase(path.join(appDir, 'geo/GeoLite2-City.mmdb'), getGeoSource());

  for (const fileName of [
    '.node-version',
    '.nvmrc',
    'package.json',
    'pnpm-lock.yaml',
    'prisma.config.ts',
  ]) {
    await copyRuntimePath(path.resolve(fileName), path.join(appDir, fileName));
  }

  const migrationToolDirectory = path.join(appDir, 'migration-tool');
  await fs.rm(migrationToolDirectory, { recursive: true, force: true });
  execFileSync(
    'pnpm',
    [
      '--config.package-import-method=copy',
      '--filter',
      '@anderson/analytics-migration-tool',
      'deploy',
      '--prod',
      migrationToolDirectory,
      '--config.inject-workspace-packages=true',
      '--config.virtual-store-dir-max-length=60',
    ],
    { stdio: 'inherit' },
  );
  console.log(
    `Shortened ${await shortenPnpmSymlinks(path.join(migrationToolDirectory, 'node_modules'))} pinned migration-tool links for portable transport.`,
  );
  const migrationTool = JSON.parse(
    await fs.readFile(path.join(migrationToolDirectory, 'node_modules/prisma/package.json')),
  );
  if (migrationTool.version !== '7.10.0') {
    throw new Error('The packaged Prisma migration tool does not match the locked version.');
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    const enginePath = path.join(
      migrationToolDirectory,
      'node_modules/.pnpm/@prisma+engines@7.10.0/node_modules/@prisma/engines/schema-engine-linux-arm64-openssl-3.0.x',
    );
    const engine = await fs.open(enginePath, 'r');
    try {
      const header = Buffer.alloc(20);
      await engine.read(header, 0, header.length, 0);
      if (
        !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        header[4] !== 2 ||
        header[5] !== 1 ||
        header.readUInt16LE(18) !== 183
      ) {
        throw new Error('The packaged Prisma schema engine is not Linux ARM64 ELF.');
      }
    } finally {
      await engine.close();
    }
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
  await copyRuntimePath(
    path.resolve('scripts/prune-expired-heatmap-events.mjs'),
    path.join(runtimeScriptsDirectory, 'prune-expired-heatmap-events.mjs'),
  );
  await copyRuntimePath(
    path.resolve('scripts/prune-expired-session-replays.mjs'),
    path.join(runtimeScriptsDirectory, 'prune-expired-session-replays.mjs'),
  );

  await fs.rm(path.join(appDir, '.next', 'cache'), { recursive: true, force: true });
  await fs.mkdir(path.join(appDir, '.next', 'cache'), { recursive: true, mode: 0o750 });
  await configureTracker(appDir);

  if (
    process.platform === 'linux' &&
    process.arch === 'arm64' &&
    process.report.getReport().header.glibcVersionRuntime
  ) {
    const pruned = await pruneForeignRuntimePackages(appDir, {
      os: 'linux',
      cpu: 'arm64',
      libc: 'glibc',
    });
    console.log(
      `Excluded ${pruned.packages.length} foreign-platform runtime packages and ${pruned.links.length} aliases.`,
    );
  }

  const manifest = await createRuntimeManifest(appDir);

  console.log(
    `Prepared and hashed ${Object.keys(manifest.entries).length} runtime paths at ${path.relative(process.cwd(), appDir)}.`,
  );
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
