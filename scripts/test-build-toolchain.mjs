import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  selectedNpmCli,
  stableVersionAtLeast,
  toolchainMetadata,
  toolchainSource,
  verifyBuildToolchain,
} from './build-toolchain-state.mjs';

const npmCli = selectedNpmCli();
const npmRoot = path.resolve(path.dirname(npmCli), '..');
const profile = path.resolve(npmRoot, '../..');
const consumer = createRequire(path.join(npmRoot, 'package.json'));
const { glob } = consumer('glob');
const { Minimatch, minimatch } = consumer('minimatch');
const root = path.resolve(import.meta.dirname, '..');
const scratch = path.join(root, '.ai-work/runs/toolchain-fixtures');
mkdirSync(scratch, { recursive: true });

test('the stock Node npm seed is compatible only with bootstrap, not application qualification', () => {
  const seedManifest = JSON.parse(readFileSync(path.join(toolchainSource, 'package.json'), 'utf8'));
  const applicationManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const semver = consumer('semver');
  assert.equal(semver.satisfies('11.20.0', seedManifest.engines.npm), true);
  assert.equal(semver.satisfies('11.20.0', applicationManifest.engines.npm), false);
  assert.equal(semver.satisfies(toolchainMetadata.npm, applicationManifest.engines.npm), true);
});

test('the active npm, npx and Node sibling commands retain the reviewed independent profile', () => {
  assert.equal(verifyBuildToolchain().profile, toolchainMetadata.profile);
  for (const executable of ['npm', 'npx'])
    assert.equal(
      execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
      toolchainMetadata.npm,
    );
  const sibling = path.join(
    path.dirname(process.execPath),
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
  );
  assert.equal(
    execFileSync(sibling, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
    toolchainMetadata.npm,
  );
});

test('changed locks, substituted CLI bytes and symlinked CLI files cannot qualify by version alone', () => {
  const directory = mkdtempSync(path.join(scratch, 'tamper-'));
  try {
    const copiedNpm = path.join(directory, 'node_modules/npm');
    mkdirSync(path.dirname(copiedNpm));
    const victimPath = 'package/bin/node-gyp-bin/node-gyp';
    const victimIndex = toolchainMetadata.files.findIndex(entry => entry.path === victimPath);
    assert.ok(victimIndex >= 0);
    for (const entry of [
      ...toolchainMetadata.files.slice(0, victimIndex + 1),
      { path: 'package/bin/npm-cli.js' },
    ]) {
      const relative = entry.path.slice('package/'.length);
      const destination = path.join(copiedNpm, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(npmRoot, relative), destination);
    }
    mkdirSync(path.join(directory, 'vendor'));
    for (const name of [
      'package.json',
      'package-lock.json',
      '.npmrc',
      'UPSTREAM.json',
      toolchainMetadata.archive,
    ])
      copyFileSync(path.join(profile, name), path.join(directory, name));
    const copiedCli = path.join(copiedNpm, 'bin/npm-cli.js');
    const rejectInputWithBoundedHeap = () => {
      const output = execFileSync(
        process.execPath,
        [
          '--max-old-space-size=128',
          '--input-type=module',
          '-e',
          `import assert from 'node:assert/strict';
import { verifyBuildToolchain } from ${JSON.stringify(new URL('./build-toolchain-state.mjs', import.meta.url).href)};
assert.throws(() => verifyBuildToolchain(process.argv[1]), /Toolchain input differs/u);
process.stdout.write('bounded input rejection');`,
          copiedCli,
        ],
        { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 },
      );
      assert.equal(output, 'bounded input rejection');
    };
    writeFileSync(path.join(directory, 'package-lock.json'), '{}');
    rejectInputWithBoundedHeap();
    assert.throws(() => verifyBuildToolchain(copiedCli), /input differs/u);
    copyFileSync(
      path.join(toolchainSource, 'package-lock.json'),
      path.join(directory, 'package-lock.json'),
    );
    const archive = path.join(directory, toolchainMetadata.archive);
    const alteredArchive = Buffer.from(readFileSync(archive));
    alteredArchive[0] ^= 1;
    writeFileSync(archive, alteredArchive);
    rejectInputWithBoundedHeap();
    copyFileSync(path.join(toolchainSource, toolchainMetadata.archive), archive);
    const victim = path.join(copiedNpm, victimPath.slice('package/'.length));
    const original = readFileSync(victim);
    writeFileSync(victim, 'process.exit(0)\n');
    assert.throws(() => verifyBuildToolchain(copiedCli), /CLI file differs/u);
    writeFileSync(victim, original);
    const retained = path.join(directory, 'retained-cli.js');
    copyFileSync(victim, retained);
    rmSync(victim);
    symlinkSync(retained, victim);
    assert.throws(() => verifyBuildToolchain(copiedCli), /must be regular/u);
    assert.ok(readFileSync(retained).length > 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('stable version bounds retain the existing semver minimums without loading profile code', () => {
  const semver = consumer('semver');
  const versions = [
    '6.29.0',
    '6.29.1',
    '6.30.0',
    '7.0.0',
    '7.30.0',
    '7.30.1',
    '8.12.1',
    '8.12.2',
    '8.12.4',
    '8.13.0',
    '9.0.0',
    '11.0.0',
    '11.0.1',
    '11.0.5',
    '14.0.1',
    '14.0.2',
    '14.0.3',
    '14.0.4',
    '15.0.0',
    '8.12.2+build.001',
    'v8.12.2',
    'V8.12.2',
    ' 8.12.2 ',
    '8.12.02',
    '8.12.2-rc.1',
    '8.12.2-0',
    '8.12.2+',
    '8.12.2+build.',
    '9007199254740992.0.0',
    '1'.repeat(257),
    '',
  ];
  for (const version of versions) {
    assert.equal(
      stableVersionAtLeast(version, [14, 0, 2]),
      semver.satisfies(version, '>=14.0.2'),
      version,
    );
    assert.equal(
      stableVersionAtLeast(version, [11, 0, 1]),
      semver.satisfies(version, '>=11.0.1'),
      version,
    );
    const undici = [
      [6, 29, 1],
      [7, 30, 1],
      [8, 12, 2],
    ].some(minimum => stableVersionAtLeast(version, minimum, true));
    assert.equal(undici, semver.satisfies(version, '^6.29.1 || ^7.30.1 || ^8.12.2'), version);
  }
});

test('descriptor-bound verification preserves checked bytes across file substitutions', {
  timeout: 120_000,
}, async context => {
  for (const mode of [
    'profile-symlink',
    'cli-symlink',
    'late-lock',
    'late-npm-manifest',
    'post-open-swap',
    'directory',
    'fifo',
    'missing',
    'read-error',
    'missing-capabilities',
    'cold-dependency-fifo',
  ]) {
    await context.test(mode, () => {
      const directory = mkdtempSync(path.join(scratch, 'descriptor-'));
      try {
        cpSync(path.join(profile, 'node_modules'), path.join(directory, 'node_modules'), {
          recursive: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
        });
        mkdirSync(path.join(directory, 'vendor'));
        for (const name of [
          'package.json',
          'package-lock.json',
          '.npmrc',
          'UPSTREAM.json',
          toolchainMetadata.archive,
        ])
          copyFileSync(path.join(profile, name), path.join(directory, name));
        const output = execFileSync(
          process.execPath,
          [
            ...(mode === 'missing-capabilities' ? ['--experimental-test-module-mocks'] : []),
            '--input-type=module',
            '-e',
            `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import filesystem from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';
const mode = process.argv[1];
const prefix = process.argv[2];
const cli = path.join(prefix, 'node_modules/npm/bin/npm-cli.js');
const metadata = JSON.parse(filesystem.readFileSync(path.join(prefix, 'UPSTREAM.json'), 'utf8'));
const require = createRequire(cli);
const undiciManifest = mode === 'cold-dependency-fifo'
  ? path.join(prefix, ${JSON.stringify(path.relative(profile, consumer.resolve('undici/package.json')))})
  : require.resolve('undici/package.json');
const lockPath = path.join(prefix, 'package-lock.json');
const npmManifest = path.join(prefix, 'node_modules/npm/package.json');
const originalUndici = JSON.parse(filesystem.readFileSync(undiciManifest, 'utf8')).version;
const victim = path.join(prefix, mode === 'cli-symlink'
  ? 'node_modules/npm/LICENSE'
  : mode === 'cold-dependency-fifo'
    ? path.relative(prefix, undiciManifest)
  : mode === 'post-open-swap'
    ? metadata.archive
    : 'package.json');
const original = {
  lstatSync: filesystem.lstatSync,
  openSync: filesystem.openSync,
  readFileSync: filesystem.readFileSync,
  fstatSync: filesystem.fstatSync,
  closeSync: filesystem.closeSync,
};
let substituted = false;
let victimDescriptor;
let victimCloses = 0;
function substitute() {
  if (substituted) return;
  const retained = path.join(prefix, 'retained-input');
  filesystem.renameSync(victim, retained);
  filesystem.symlinkSync(retained, victim);
  substituted = true;
}
if (mode.endsWith('-symlink')) {
  filesystem.lstatSync = (filename, ...args) => {
    const state = original.lstatSync(filename, ...args);
    if (filename === victim) substitute();
    return state;
  };
}
filesystem.openSync = (filename, ...args) => {
  if (filename === victim && mode.endsWith('-symlink')) substitute();
  const descriptor = original.openSync(filename, ...args);
  if (filename === victim) victimDescriptor = descriptor;
  return descriptor;
};
filesystem.closeSync = (descriptor, ...args) => {
  if (descriptor === victimDescriptor) victimCloses += 1;
  return original.closeSync(descriptor, ...args);
};
filesystem.readFileSync = (filename, ...args) => {
  if (mode === 'read-error' && filename === victimDescriptor && typeof filename === 'number')
    throw Object.assign(new Error('fixture read failure'), { code: 'EIO' });
  const bytes = original.readFileSync(filename, ...args);
  if (mode === 'late-lock' && filename === lockPath && args[0] === 'utf8') {
    const lock = JSON.parse(bytes);
    const location = path.relative(prefix, path.dirname(undiciManifest)).split(path.sep).join('/');
    lock.packages[location].version = '8.12.999';
    return JSON.stringify(lock);
  }
  if (mode === 'late-lock' && filename === undiciManifest && args[0] === 'utf8')
    return JSON.stringify({ ...JSON.parse(bytes), version: '8.12.999' });
  if (mode === 'late-npm-manifest' && filename === npmManifest && args[0] === 'utf8')
    return JSON.stringify({ ...JSON.parse(bytes), version: '12.2.999' });
  return bytes;
};
filesystem.fstatSync = (descriptor, ...args) => {
  const state = original.fstatSync(descriptor, ...args);
  if (mode === 'post-open-swap' && descriptor === victimDescriptor && !substituted) {
    filesystem.renameSync(victim, path.join(prefix, 'retained-input'));
    filesystem.writeFileSync(victim, 'unreviewed replacement bytes');
    substituted = true;
  }
  return state;
};
if (mode === 'directory' || mode === 'fifo' || mode === 'missing' || mode === 'cold-dependency-fifo') {
  filesystem.rmSync(victim);
  if (mode === 'directory') filesystem.mkdirSync(victim);
  if (mode === 'fifo' || mode === 'cold-dependency-fifo') execFileSync('mkfifo', [victim]);
}
syncBuiltinESMExports();
if (mode === 'missing-capabilities') {
  const mocked = { ...filesystem, constants: { ...filesystem.constants, O_NOFOLLOW: undefined } };
  mock.module('node:fs', { exports: { ...mocked, default: mocked } });
}
const { verifyBuildToolchain } = await import(${JSON.stringify(new URL('./build-toolchain-state.mjs', import.meta.url).href)});
if (mode.endsWith('-symlink') || mode === 'directory' || mode === 'fifo' || mode === 'cold-dependency-fifo') {
  assert.throws(() => verifyBuildToolchain(cli), /must be (?:a )?regular/u);
  if (mode.endsWith('-symlink')) assert.equal(substituted, true);
  else assert.equal(victimCloses, 1);
} else if (mode === 'missing') {
  assert.throws(() => verifyBuildToolchain(cli), { code: 'ENOENT' });
} else if (mode === 'read-error') {
  assert.throws(() => verifyBuildToolchain(cli), { code: 'EIO' });
  assert.equal(victimCloses, 1);
} else if (mode === 'missing-capabilities') {
  assert.throws(() => verifyBuildToolchain(cli), /requires no-follow and nonblocking/u);
} else {
  const result = verifyBuildToolchain(cli);
  assert.equal(result.lockSha256, metadata.lockSha256);
  assert.equal(result.versions.npm, metadata.npm);
  assert.equal(result.versions.undici, originalUndici);
  if (mode === 'post-open-swap') assert.equal(substituted, true);
}
process.stdout.write('descriptor fixture accepted');`,
            mode,
            directory,
          ],
          { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 },
        );
        assert.equal(output, 'descriptor fixture accepted');
      } finally {
        rmSync(directory, { recursive: true });
      }
    });
  }
});

test('a clean source-only bootstrap installs the application through its isolated npm without leaking seed flags', {
  timeout: 300_000,
}, context => {
  const directory = mkdtempSync(path.join(scratch, 'bootstrap-'));
  try {
    cpSync(toolchainSource, path.join(directory, 'build-toolchain'), {
      recursive: true,
      filter: filename => !filename.split(path.sep).includes('node_modules'),
    });
    mkdirSync(path.join(directory, 'scripts'));
    for (const name of [
      'build-toolchain.mjs',
      'build-toolchain-state.mjs',
      'build-toolchain-cache.mjs',
    ])
      cpSync(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
    const manifest = {
      name: 'webops-bootstrap-fixture',
      version: '1.0.0',
      private: true,
      scripts: { install: 'node observe-install.cjs' },
    };
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
    writeFileSync(
      path.join(directory, 'package-lock.json'),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        packages: {
          '': { name: manifest.name, version: manifest.version, hasInstallScript: true },
        },
      }),
    );
    writeFileSync(
      path.join(directory, 'observe-install.cjs'),
      'require("node:fs").writeFileSync("observed.json", JSON.stringify({cli:process.env.npm_execpath, cwd:process.cwd(), ignored:process.env.npm_config_ignore_scripts}))\n',
    );
    context.diagnostic('Preparing, auditing and installing the independent cold profile');
    const output = execFileSync(
      process.execPath,
      [
        path.join(directory, 'scripts/build-toolchain.mjs'),
        '--install',
        '--',
        'node',
        '-p',
        'JSON.stringify({cwd:process.cwd(),node:process.execPath})',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: path.join(directory, 'cache'),
        },
      },
    );
    context.diagnostic(
      'Cold profile and application commands completed; verifying source and executable identity',
    );
    const selected = JSON.parse(output.trim().split('\n').at(-1));
    const observedProfile = path.resolve(path.dirname(selected.node), '..');
    const managedRoot = realpathSync(path.join(directory, 'cache/_site-toolchains/reuse-v1'));
    assert.equal(path.dirname(observedProfile), managedRoot);
    assert.match(path.basename(observedProfile), /^slot-[0-2]$/u);
    assert.notEqual(observedProfile, profile);
    assert.equal(selected.cwd, directory);
    const observed = JSON.parse(readFileSync(path.join(directory, 'observed.json'), 'utf8'));
    assert.equal(observed.cwd, directory);
    assert.notEqual(observed.ignored, 'true');
    assert.equal(verifyBuildToolchain(observed.cli).profile, toolchainMetadata.profile);
    assert.ok(observed.cli.startsWith(`${observedProfile}${path.sep}`));
    const warm = execFileSync(
      process.execPath,
      [path.join(directory, 'scripts/build-toolchain.mjs'), '--print-bin'],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: path.join(directory, 'cache'),
        },
      },
    ).trim();
    assert.equal(
      warm,
      path.dirname(selected.node),
      'A warm bootstrap must return the identical qualified executable directory',
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('Glob cancellation bounds traversal while retaining ordinary file matching', {
  timeout: 10_000,
}, async context => {
  const directory = mkdtempSync(path.join(scratch, 'glob-'));
  try {
    for (let branch = 0; branch < 4; branch += 1) {
      for (let leaf = 0; leaf < 4; leaf += 1) {
        const parent = path.join(directory, String(branch), String(leaf));
        mkdirSync(parent, { recursive: true });
        writeFileSync(path.join(parent, 'fixture.txt'), 'bounded local fixture');
      }
    }
    const filesystem = await import('node:fs');
    const controller = new AbortController();
    const reason = new Error('bounded cancellation fixture');
    let reads = 0;
    const measuredFs = {
      readdir(directoryPath, options, callback) {
        reads += 1;
        filesystem.readdir(directoryPath, options, (error, entries) => {
          if (!controller.signal.aborted) controller.abort(reason);
          callback(error, entries);
        });
      },
    };
    context.diagnostic('Checking cancellation before ordinary traversal');
    await assert.rejects(
      glob('**/*', { cwd: directory, fs: measuredFs, signal: controller.signal }),
      reason,
    );
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(reads, 1);
    assert.equal((await glob('**/*.txt', { cwd: directory })).length, 16);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('Minimatch bounds globstar-parent amplification and preserves ordinary matching', () => {
  const options = { optimizationLevel: 2, braceExpandMax: 4 };
  assert.throws(() => new Minimatch(`root/${'**/../alpha/beta/'.repeat(6)}file.txt`, options), {
    name: 'RangeError',
    message: "optimizationLevel 2: too many patterns from '**/..'",
  });
  const matcher = new Minimatch(`root/${'**/../alpha/beta/'.repeat(2)}file.txt`, options);
  assert.equal(matcher.globParts.length, 4);
  for (const filename of ['alpha/beta/file.txt', 'root/nested/alpha/beta/file.txt'])
    assert.equal(minimatch(filename, 'root/**/../alpha/beta/file.txt', options), true);
  assert.equal(
    minimatch('root/nested/other/file.txt', 'root/**/../alpha/beta/file.txt', options),
    false,
  );
  assert.equal(minimatch('safe/item.txt', 'safe/*.txt'), true);
  assert.equal(minimatch('outside/item.txt', 'safe/*.txt'), false);
});

test('the real CLI preserves offline packing, locked installation and paired executable delivery', {
  timeout: 60_000,
}, () => {
  const directory = mkdtempSync(path.join(scratch, 'cli-'));
  const packageRoot = path.join(directory, 'package');
  const application = path.join(directory, 'consumer');
  const archiveRoot = path.join(directory, 'archives');
  const environment = {
    ...process.env,
    NPM_CONFIG_CACHE: path.join(directory, 'cache'),
    NPM_CONFIG_PREFIX: path.join(directory, 'empty-global-prefix'),
    npm_config_cache: path.join(directory, 'cache'),
    npm_config_prefix: path.join(directory, 'empty-global-prefix'),
  };
  const run = (args, cwd) =>
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: environment,
    });
  try {
    for (const destination of [packageRoot, application, archiveRoot]) mkdirSync(destination);
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'webops-toolchain-fixture',
        version: '1.0.0',
        bin: { 'webops-toolchain-fixture': 'cli.cjs' },
        files: ['cli.cjs'],
      }),
    );
    writeFileSync(
      path.join(packageRoot, 'cli.cjs'),
      `#!/usr/bin/env node
if (process.argv.includes('--identify')) {
  process.stdout.write(JSON.stringify({ cli: process.env.npm_execpath, node: process.execPath, version: process.version }))
} else {
  process.stdout.write('controlled local npm executable\\n')
}
`,
    );
    writeFileSync(path.join(packageRoot, 'excluded.txt'), 'not part of the package');
    const packed = Object.values(
      JSON.parse(
        run(
          [
            'pack',
            '.',
            '--ignore-scripts',
            '--offline',
            '--json',
            '--pack-destination',
            archiveRoot,
          ],
          packageRoot,
        ),
      ),
    )[0];
    assert.ok(packed.files.some(entry => entry.path === 'cli.cjs'));
    assert.ok(!packed.files.some(entry => entry.path === 'excluded.txt'));
    writeFileSync(
      path.join(application, 'package.json'),
      JSON.stringify({ name: 'webops-consumer-fixture', version: '1.0.0', private: true }),
    );
    run(
      [
        'install',
        path.join(archiveRoot, packed.filename),
        '--ignore-scripts',
        '--offline',
        '--no-fund',
        '--no-audit',
      ],
      application,
    );
    run(['ci', '--ignore-scripts', '--offline', '--no-fund', '--no-audit'], application);
    assert.equal(
      run(['exec', '--offline', '--', 'webops-toolchain-fixture'], application).trim(),
      'controlled local npm executable',
    );
    const commandResults = [
      run(['exec', '--offline', '--', 'webops-toolchain-fixture', '--identify'], application),
      execFileSync('npx', ['--offline', 'webops-toolchain-fixture', '--identify'], {
        cwd: application,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: environment,
      }),
    ];
    for (const output of commandResults) {
      const identity = JSON.parse(output);
      assert.equal(identity.version, process.version);
      assert.equal(realpathSync(identity.node), realpathSync(process.execPath));
      assert.equal(verifyBuildToolchain(identity.cli).lockSha256, toolchainMetadata.lockSha256);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
