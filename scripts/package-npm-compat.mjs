import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'build-toolchain/compat');
const inputs = JSON.parse(await readFile(path.join(source, 'UPSTREAM.json'), 'utf8'));
const check = process.argv[2] === '--check';
const intake = process.argv[2] === '--intake' ? path.resolve(process.argv[3]) : null;
assert.ok(
  process.argv.length === 2 ||
    (check && process.argv.length === 3) ||
    (intake && process.argv.length === 4),
);
assert.ok(process.env.npm_execpath, 'Run through the qualified npm executable');
assert.equal(inputs.schemaVersion, 1);

async function normalizeModes(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeModes(filename);
    } else {
      assert.ok(entry.isFile(), 'Tool library archives contain only regular files and directories');
      await chmod(filename, 0o644);
    }
  }
}

const scratchRoot = path.join(root, '.ai-work/runs');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(path.join(scratchRoot, 'npm-compat-package-'));
try {
  for (const input of inputs.packages) {
    assert.match(input.name, /^[a-z-]+$/);
    assert.match(input.version, /^\d+\.\d+\.\d+$/);
    const upstreamName = `${input.name}-${input.version}.tgz`;
    const upstreamPath = path.join(source, 'upstream', upstreamName);
    const upstream = await readFile(intake ? path.join(intake, upstreamName) : upstreamPath);
    const integrity = `sha512-${createHash('sha512').update(upstream).digest('base64')}`;
    assert.equal(
      integrity,
      input.integrity,
      `${upstreamName} must match the reviewed official registry archive`,
    );
    const temporaryArchive = path.join(scratch, upstreamName);
    await writeFile(temporaryArchive, upstream);
    const listing = spawnSync('tar', ['-tf', temporaryArchive], { encoding: 'utf8' });
    assert.equal(listing.status, 0);
    assert.ok(
      listing.stdout
        .trim()
        .split('\n')
        .every(filename => filename.startsWith('package/') && !filename.split('/').includes('..')),
    );
    const entries = spawnSync('tar', ['-tvf', temporaryArchive], { encoding: 'utf8' });
    assert.equal(entries.status, 0);
    assert.ok(
      entries.stdout
        .trim()
        .split('\n')
        .every(line => line.startsWith('-') || line.startsWith('d')),
    );
    const directory = path.join(scratch, input.name);
    await mkdir(directory);
    const extraction = spawnSync('tar', ['-xf', temporaryArchive, '-C', directory]);
    assert.equal(extraction.status, 0);
    const payload = path.join(directory, 'package');
    const original = await readFile(path.join(payload, 'package.json'));
    const metadata = JSON.parse(original);
    assert.equal(metadata.name, input.name);
    assert.equal(metadata.version, input.version);
    assert.equal(metadata.type, 'module');
    assert.deepEqual(metadata.exports, input.exports);
    assert.equal(metadata.license, input.license);
    assert.ok((await readFile(path.join(payload, input.licenseFile))).length > 0);
    const originalModule = await readFile(path.join(payload, input.module));
    metadata.version = `${input.version}-webops.1`;
    metadata.private = true;
    metadata.main = './compat.cjs';
    metadata.types = './compat.d.cts';
    const conditions = metadata.exports['.'] || metadata.exports;
    const importCondition = conditions.import || conditions;
    metadata.exports = {
      ...Object.fromEntries(
        Object.entries(metadata.exports).filter(([key]) => key.startsWith('./')),
      ),
      '.': {
        import: importCondition,
        require: { types: './compat.d.cts', default: './compat.cjs' },
      },
    };
    metadata.dependencies = {
      ...metadata.dependencies,
      ...input.dependencies,
    };
    delete metadata.scripts;
    delete metadata.devDependencies;
    delete metadata.files;
    await writeFile(path.join(payload, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(path.join(payload, 'UPSTREAM-PACKAGE.json'), original);
    await writeFile(path.join(payload, 'UPSTREAM.json'), `${JSON.stringify(input, null, 2)}\n`);
    await copyFile(path.join(source, input.name, 'compat.cjs'), path.join(payload, 'compat.cjs'));
    await copyFile(
      path.join(source, input.name, 'compat.d.cts'),
      path.join(payload, 'compat.d.cts'),
    );
    await normalizeModes(payload);
    assert.deepEqual(await readFile(path.join(payload, input.module)), originalModule);
    const pack = spawnSync(
      process.execPath,
      [
        process.env.npm_execpath,
        'pack',
        payload,
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        directory,
      ],
      {
        encoding: 'utf8',
        cwd: root,
        maxBuffer: 256 * 1024,
      },
    );
    assert.equal(pack.status, 0, pack.stderr);
    const report = JSON.parse(pack.stdout)[input.name];
    const archiveName = `${input.name}-${metadata.version}.tgz`;
    assert.equal(report.filename, archiveName);
    const archive = await readFile(path.join(directory, archiveName));
    const target = path.join(root, 'build-toolchain/vendor', archiveName);
    if (check) {
      const reviewed = await readFile(target);
      assert.ok(
        gunzipSync(reviewed, { maxOutputLength: 4 * 1024 * 1024 }).equals(
          gunzipSync(archive, { maxOutputLength: 4 * 1024 * 1024 }),
        ),
        `${archiveName} must reproduce from the original library and reviewed bridge`,
      );
      const archiveIntegrity = `sha512-${createHash('sha512').update(reviewed).digest('base64')}`;
      const upstreamLock = JSON.parse(
        await readFile(path.join(source, 'package-lock.json'), 'utf8'),
      );
      assert.equal(upstreamLock.packages[`node_modules/${input.name}`]?.integrity, input.integrity);
      assert.equal(upstreamLock.packages[`node_modules/${input.name}`]?.version, input.version);
      for (const lockfile of ['build-toolchain/package-lock.json']) {
        const lock = JSON.parse(await readFile(path.join(root, lockfile), 'utf8'));
        assert.equal(
          lock.packages[`node_modules/${input.name}`]?.integrity,
          archiveIntegrity,
          `${input.name} must match the immutable tool lock`,
        );
      }
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, archive);
      if (intake) {
        await mkdir(path.dirname(upstreamPath), { recursive: true });
        await writeFile(upstreamPath, upstream);
      }
    }
  }
} finally {
  await rm(scratch, { recursive: true });
}

console.log(
  check
    ? 'Tool compatibility archives reproduce from unchanged modern libraries and the independent lock.'
    : 'Tool compatibility archives generated from verified modern library inputs.',
);
