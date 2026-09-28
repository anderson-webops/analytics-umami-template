import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async file => {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
async function links(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink())
        result[path.relative(root, absolute)] = await fs.readlink(absolute);
    }
  }
  await visit(root);
  return result;
}
async function payload(root, allowLinks = false) {
  const inventory = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink() && allowLinks) {
        inventory[path.relative(root, absolute)] = `link:${await fs.readlink(absolute)}`;
        continue;
      }
      assert.ok(!entry.isSymbolicLink(), 'Workspace distributions must contain real files.');
      if (entry.isDirectory()) await visit(absolute);
      else {
        assert.ok(entry.isFile(), 'Unsupported workspace distribution entry.');
        inventory[path.relative(root, absolute)] = crypto
          .createHash('sha256')
          .update(await fs.readFile(absolute))
          .digest('hex');
      }
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(inventory).sort());
}
async function resolveDependency(directory, name) {
  for (let current = directory; ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', name);
    if (await exists(candidate)) return fs.realpath(candidate);
    if (path.dirname(current) === current)
      throw new Error(`Missing production dependency: ${name}`);
  }
}
export async function captureWorkspacePackaging(root) {
  root = await fs.realpath(root);
  const modules = path.join(root, 'node_modules');
  const rootPackage = await json(path.join(root, 'package.json'));
  const workspaces = [];
  for (const [name, version] of Object.entries(rootPackage.dependencies ?? {})) {
    if (!version.startsWith('workspace:')) continue;
    const source = await fs.realpath(path.join(modules, name));
    const relative = path.relative(root, source);
    assert.match(relative, /^packages\/[a-z0-9-]+$/);
    const manifest = await json(path.join(source, 'package.json'));
    assert.equal(manifest.name, name);
    assert.ok(manifest.files?.includes('dist'), 'Workspace must declare its built distribution.');
    const files = ['package.json', ...manifest.files];
    for (const file of files) assert.match(file, /^(?:package\.json|dist|bin|README\.md)$/);
    const dependencies = {};
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      dependencies[dependency] = path.relative(root, await resolveDependency(source, dependency));
      assert.ok(inside(root, path.resolve(root, dependencies[dependency])));
    }
    workspaces.push({
      name,
      source: relative,
      files,
      dependencies,
      distribution: await payload(path.join(source, 'dist')),
      installedLinks: (await exists(path.join(source, 'node_modules')))
        ? await payload(path.join(source, 'node_modules'), true)
        : null,
    });
  }
  // A dangling hoisted link may be removed only if it was valid before pruning
  // and did not belong to the reachable production graph.
  const production = new Set();
  async function visit(directory) {
    directory = await fs.realpath(directory);
    if (production.has(directory)) return;
    assert.ok(inside(root, directory), 'Production dependency leaves the checkout.');
    production.add(directory);
    const manifest = await json(path.join(directory, 'package.json'));
    const dependencies = {
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
      ...manifest.dependencies,
    };
    for (const name of Object.keys(dependencies)) {
      let resolved;
      try {
        resolved = await resolveDependency(directory, name);
      } catch (error) {
        if (
          manifest.optionalDependencies?.[name] ||
          manifest.peerDependenciesMeta?.[name]?.optional
        )
          continue;
        throw error;
      }
      await visit(resolved);
    }
  }
  await visit(root);
  const disposableHoists = {};
  for (const [relative, target] of Object.entries(await links(modules))) {
    const absolute = path.join(modules, relative);
    const resolved = await fs.realpath(absolute); // Pre-existing broken links are an error.
    if (
      relative.startsWith('.pnpm/node_modules/') &&
      inside(modules, resolved) &&
      !production.has(resolved)
    )
      disposableHoists[relative] = target;
  }
  return { version: 1, workspaces, disposableHoists };
}
export async function packageRuntimeWorkspaces(root, captured) {
  root = await fs.realpath(root);
  assert.equal(captured.version, 1);
  const modules = path.join(root, 'node_modules');
  const destinations = new Map(
    captured.workspaces.map(workspace => [
      workspace.source,
      path.join(modules, '.runtime-workspaces', path.basename(workspace.source)),
    ]),
  );
  for (const workspace of captured.workspaces) {
    assert.match(workspace.source, /^packages\/[a-z0-9-]+$/);
    const source = path.join(root, workspace.source);
    const destination = destinations.get(workspace.source);
    assert.deepEqual(
      await payload(path.join(source, 'dist')),
      workspace.distribution,
      'Workspace distribution changed after capture.',
    );
    await fs.mkdir(destination, { recursive: true });
    for (const file of workspace.files) {
      assert.match(file, /^(?:package\.json|dist|bin|README\.md)$/);
      await fs.cp(path.join(source, file), path.join(destination, file), {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
    }
    assert.deepEqual(await payload(path.join(destination, 'dist')), workspace.distribution);
    for (const [name, relative] of Object.entries(workspace.dependencies)) {
      assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
      const target = destinations.get(relative) ?? path.resolve(root, relative);
      assert.ok(inside(modules, target), 'Workspace dependency must remain inside node_modules.');
      const link = path.join(destination, 'node_modules', name);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(path.relative(path.dirname(link), target), link);
    }
  }
  for (const [relative, target] of Object.entries(await links(modules))) {
    const link = path.join(modules, relative);
    const resolved = path.resolve(path.dirname(link), target);
    const workspace = destinations.get(path.relative(root, resolved));
    if (workspace) {
      await fs.unlink(link);
      await fs.symlink(path.relative(path.dirname(link), workspace), link);
    } else if (!(await exists(link))) {
      assert.equal(
        captured.disposableHoists[relative],
        target,
        'Unverified dangling dependency link.',
      );
      assert.ok(relative.startsWith('.pnpm/node_modules/'));
      await fs.unlink(link);
    }
  }
  // Keep the strict dependency-subtree boundary, including transitive links.
  for (const [relative, target] of Object.entries(await links(modules))) {
    assert.ok(!path.isAbsolute(target));
    assert.ok(inside(modules, path.resolve(path.dirname(path.join(modules, relative)), target)));
    assert.ok(
      inside(modules, await fs.realpath(path.join(modules, relative))),
      'Dependency link escapes node_modules.',
    );
  }
  for (const workspace of captured.workspaces) {
    const distribution = `${workspace.source}/dist`;
    assert.equal(
      execFileSync('git', ['ls-files', '--', distribution], { cwd: root, encoding: 'utf8' }),
      '',
      'Tracked workspace output cannot be removed.',
    );
    assert.deepEqual(await payload(path.join(root, distribution)), workspace.distribution);
    await fs.rm(path.join(root, distribution), { recursive: true });
    if (workspace.installedLinks) {
      const installed = `${workspace.source}/node_modules`;
      assert.equal(
        execFileSync('git', ['ls-files', '--', installed], { cwd: root, encoding: 'utf8' }),
        '',
        'Tracked workspace dependencies cannot be removed.',
      );
      for (const [name, digest] of Object.entries(
        await payload(path.join(root, installed), true),
      )) {
        assert.equal(
          digest,
          workspace.installedLinks[name],
          'Workspace dependency output changed after capture.',
        );
      }
      await fs.rm(path.join(root, installed), { recursive: true });
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, snapshot] = process.argv.slice(2);
  assert.ok(snapshot && ['capture', 'package'].includes(operation));
  if (operation === 'capture')
    await fs.writeFile(snapshot, JSON.stringify(await captureWorkspacePackaging(process.cwd())), {
      flag: 'wx',
      mode: 0o600,
    });
  else await packageRuntimeWorkspaces(process.cwd(), await json(snapshot));
}
