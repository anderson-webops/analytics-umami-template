import fs from 'node:fs/promises';
import path from 'node:path';

export async function copyReplayCssBindings(appDir, rootDir = process.cwd()) {
  const packageRoot = await fs.realpath(path.join(rootDir, 'node_modules/lightningcss'));
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
    await fs.rm(runtimeBinding, { force: true, recursive: true });
    await fs.mkdir(path.dirname(runtimeBinding), { recursive: true });
    await fs.cp(sourcePath, runtimeBinding, { force: true, recursive: true });

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
