import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const maxUstarLinkBytes = 100;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function shortenPnpmSymlinks(modulesDirectory) {
  const modulesRoot = await fs.realpath(modulesDirectory);
  const virtualStore = path.join(modulesRoot, '.pnpm');
  if (!(await fs.lstat(virtualStore)).isDirectory()) {
    throw new Error('The migration tool virtual store must be a real directory.');
  }
  const longLinks = [];

  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        if (Buffer.byteLength(target) > maxUstarLinkBytes) longLinks.push(absolute);
      }
    }
  }

  await visit(modulesRoot);
  if (longLinks.length === 0) return 0;

  const aliases = path.join(virtualStore, '.anderson-ustar-links');
  await fs.mkdir(aliases, { mode: 0o755 });
  await fs.chmod(aliases, 0o755);
  for (const link of longLinks) {
    const resolved = await fs.realpath(link);
    if (!isWithin(virtualStore, resolved)) {
      throw new Error('A long migration-tool link leaves its virtual store.');
    }
    const relative = path.relative(virtualStore, resolved);
    const [packageFolder, ...remainder] = relative.split(path.sep);
    if (
      !packageFolder ||
      packageFolder === 'node_modules' ||
      packageFolder === '.anderson-ustar-links' ||
      remainder[0] !== 'node_modules' ||
      !(await fs.lstat(path.join(virtualStore, packageFolder))).isDirectory()
    ) {
      throw new Error('A long migration-tool link has no pinned package target.');
    }
    const aliasName = crypto.createHash('sha256').update(packageFolder).digest('hex').slice(0, 16);
    const alias = path.join(aliases, aliasName);
    const aliasTarget = path.relative(aliases, path.join(virtualStore, packageFolder));
    if (Buffer.byteLength(aliasTarget) > maxUstarLinkBytes) {
      throw new Error('A migration-tool package name exceeds portable USTAR limits.');
    }
    try {
      await fs.symlink(aliasTarget, alias);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if ((await fs.realpath(alias)) !== path.join(virtualStore, packageFolder)) {
      throw new Error('A migration-tool package alias points to a different package.');
    }
    const shortenedTarget = path.relative(path.dirname(link), path.join(alias, ...remainder));
    if (Buffer.byteLength(shortenedTarget) > maxUstarLinkBytes) {
      throw new Error('A migration-tool dependency link cannot fit in portable USTAR.');
    }
    await fs.rm(link);
    await fs.symlink(shortenedTarget, link);
    if ((await fs.realpath(link)) !== resolved) {
      throw new Error('A shortened migration-tool link changed its package target.');
    }
  }
  return longLinks.length;
}
