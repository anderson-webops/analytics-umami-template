import fs from 'node:fs/promises';
import path from 'node:path';

function inside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function supports(value, target) {
  if (value === undefined) return true;
  const restrictions = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(restrictions) || restrictions.some(item => typeof item !== 'string')) {
    throw new Error('A traced package has invalid platform restrictions.');
  }
  if (restrictions.includes(`!${target}`)) return false;
  const permitted = restrictions.filter(item => !item.startsWith('!'));
  return permitted.length === 0 || permitted.includes(target);
}

export async function pruneForeignRuntimePackages(runtimeRoot, platform) {
  const root = await fs.realpath(runtimeRoot);
  const removed = [];
  const links = [];

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const relative = path.relative(root, directory).split(path.sep);
    if (
      relative.includes('node_modules') &&
      entries.some(entry => entry.name === 'package.json' && entry.isFile())
    ) {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (
        !supports(manifest.os, platform.os) ||
        !supports(manifest.cpu, platform.cpu) ||
        !supports(manifest.libc, platform.libc)
      ) {
        removed.push(directory);
        return;
      }
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isSymbolicLink()) links.push(fullPath);
    }
  }

  await visit(root);
  const removeLinks = [];
  for (const link of links) {
    const target = await fs.realpath(link);
    if (!inside(root, target)) {
      throw new Error('A traced runtime link escapes the artifact.');
    }
    if (removed.some(directory => inside(directory, target))) removeLinks.push(link);
  }
  for (const link of removeLinks) await fs.rm(link);
  for (const directory of removed) await fs.rm(directory, { recursive: true });

  return {
    packages: removed.map(directory => path.relative(root, directory)),
    links: removeLinks.map(link => path.relative(root, link)),
  };
}
