import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HASHED_ALIAS_SUFFIX = /-[0-9a-f]{16}$/;

async function exists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findStandaloneAppDir(rootDir) {
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    if (entries.some(entry => entry.isFile() && entry.name === 'server.js')) {
      return currentDir;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(path.join(currentDir, entry.name));
      }
    }
  }

  return null;
}

async function collectStandaloneAliases(nextNodeModulesDir) {
  const aliases = [];
  const topLevelEntries = await fs.readdir(nextNodeModulesDir, { withFileTypes: true });

  for (const entry of topLevelEntries) {
    const entryPath = path.join(nextNodeModulesDir, entry.name);

    if (entry.isSymbolicLink() && HASHED_ALIAS_SUFFIX.test(entry.name)) {
      aliases.push(entry.name);
      continue;
    }

    if (!entry.isDirectory() || !entry.name.startsWith('@')) {
      continue;
    }

    const scopedEntries = await fs.readdir(entryPath, { withFileTypes: true });

    for (const scopedEntry of scopedEntries) {
      if (scopedEntry.isSymbolicLink() && HASHED_ALIAS_SUFFIX.test(scopedEntry.name)) {
        aliases.push(path.join(entry.name, scopedEntry.name));
      }
    }
  }

  return aliases;
}

async function ensureAlias(appDir, relativeAliasPath) {
  const nextAliasPath = path.join(appDir, '.next', 'node_modules', relativeAliasPath);
  const standaloneAliasPath = path.join(appDir, 'node_modules', relativeAliasPath);

  if (!(await exists(nextAliasPath)) || (await exists(standaloneAliasPath))) {
    return false;
  }

  const targetPath = await fs.realpath(nextAliasPath);
  const relativeTargetPath = path.relative(path.dirname(standaloneAliasPath), targetPath);

  await fs.mkdir(path.dirname(standaloneAliasPath), { recursive: true });
  await fs.symlink(relativeTargetPath, standaloneAliasPath);

  return true;
}

export async function repairStandaloneRuntime() {
  const standaloneRootDir = path.join(process.cwd(), '.next', 'standalone');

  if (!(await exists(standaloneRootDir))) {
    return { appDir: null, aliases: [] };
  }

  const standaloneAppDir = await findStandaloneAppDir(standaloneRootDir);

  if (!standaloneAppDir) {
    return { appDir: null, aliases: [] };
  }

  const nextNodeModulesDir = path.join(standaloneAppDir, '.next', 'node_modules');

  if (!(await exists(nextNodeModulesDir))) {
    return { appDir: standaloneAppDir, aliases: [] };
  }

  const aliases = await collectStandaloneAliases(nextNodeModulesDir);
  const createdAliases = [];

  for (const alias of aliases) {
    if (await ensureAlias(standaloneAppDir, alias)) {
      createdAliases.push(alias);
    }
  }

  if (createdAliases.length > 0) {
    console.log(
      `[repair-standalone] created ${createdAliases.length} alias symlink(s) in ${path.relative(process.cwd(), standaloneAppDir)}`,
    );
  }

  return { appDir: standaloneAppDir, aliases: createdAliases };
}

const currentScriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentScriptPath)) {
  repairStandaloneRuntime().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
