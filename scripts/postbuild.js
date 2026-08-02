import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repairStandaloneRuntime } from './repair-standalone.js';

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

async function run() {
  const { appDir } = await repairStandaloneRuntime();

  if (!appDir) {
    throw new Error('The standalone production runtime was not generated.');
  }

  for (const relativePath of ['public', 'geo', 'prisma', 'generated', '.next/static']) {
    await copyRuntimePath(path.resolve(relativePath), path.join(appDir, relativePath));
  }

  for (const fileName of ['package.json', 'prisma.config.ts']) {
    await copyRuntimePath(path.resolve(fileName), path.join(appDir, fileName));
  }

  console.log(`Prepared direct production runtime at ${path.relative(process.cwd(), appDir)}.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
