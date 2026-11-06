import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  cacheIdentity,
  finishToolchainCache,
  selectToolchainCache,
  verifyReusableToolchain,
} from './build-toolchain-cache.mjs';
import { sha256, toolchainMetadata, toolchainSource } from './build-toolchain-state.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const argumentsList = process.argv.slice(2);
const separator = argumentsList.indexOf('--');
const options = separator < 0 ? argumentsList : argumentsList.slice(0, separator);
const command = separator < 0 ? [] : argumentsList.slice(separator + 1);
assert.ok(
  options.every(option => ['--install', '--print-bin'].includes(option)),
  'Unsupported bootstrap option',
);
assert.ok(
  !options.includes('--install') || command.length > 0,
  '--install requires an application command',
);
assert.ok(
  !options.includes('--print-bin') || command.length === 0,
  '--print-bin cannot be combined with an application command',
);
assert.ok(
  !process.getuid || process.getuid() !== 0,
  'Prepare build tools as an unprivileged account',
);
assert.equal(
  process.version,
  `v${toolchainMetadata.node}`,
  'Select the pinned Node before bootstrap',
);
assert.equal(
  sha256(readFileSync(path.join(toolchainSource, 'package-lock.json'))),
  toolchainMetadata.lockSha256,
);
assert.equal(
  sha256(readFileSync(path.join(toolchainSource, toolchainMetadata.archive))),
  toolchainMetadata.archiveSha256,
);

function run(executable, args, cwd, env, quiet = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: quiet ? ['ignore', 2, 2] : 'inherit',
    });
    let forcedTermination;
    let interruption;
    const timeout = quiet
      ? setTimeout(() => {
          interruption = 'timeout';
          child.kill('SIGTERM');
          forcedTermination = setTimeout(() => child.kill('SIGKILL'), 5000);
        }, 300_000)
      : undefined;
    const forward = signal => {
      interruption = signal;
      child.kill(signal);
    };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const finish = () => {
      clearTimeout(timeout);
      clearTimeout(forcedTermination);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => {
      finish();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      finish();
      if (code === 0 && !interruption) resolve();
      else
        reject(
          new Error(
            `Build toolchain command failed (${interruption || signal || code}): ${executable}`,
          ),
        );
    });
  });
}

const seedCli = realpathSync(
  path.join(
    path.dirname(process.execPath),
    process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm',
  ),
);
const seedEnvironment = { ...process.env };
delete seedEnvironment.NODE_OPTIONS;
delete seedEnvironment.NODE_PATH;
const base =
  process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache
    ? path.join(process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache, '_site-toolchains')
    : path.join(repositoryRoot, '.ai-work/runs/build-toolchains');
mkdirSync(base, { recursive: true, mode: 0o700 });
const identity = cacheIdentity();
const selection = await selectToolchainCache(realpathSync(base), identity);
const { prefix } = selection;
let cacheAccepted = selection.reused;
try {
  if (!selection.reused) {
    mkdirSync(path.join(prefix, 'vendor'));
    for (const name of [
      'package.json',
      'package-lock.json',
      '.npmrc',
      'UPSTREAM.json',
      'PAYLOAD.json',
      toolchainMetadata.archive,
    ])
      copyFileSync(
        path.join(toolchainSource, name),
        path.join(prefix, name),
        constants.COPYFILE_EXCL,
      );
    await run(
      process.execPath,
      [
        seedCli,
        'ci',
        '--prefix',
        prefix,
        '--workspaces=false',
        '--include=dev',
        '--include=optional',
        '--ignore-scripts',
        '--no-fund',
        '--no-audit',
      ],
      repositoryRoot,
      seedEnvironment,
    );
  }
  const bin = path.join(prefix, 'bin');
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  if (!selection.reused) {
    mkdirSync(bin);
    copyFileSync(
      process.execPath,
      path.join(bin, nodeName),
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    chmodSync(path.join(bin, nodeName), 0o755);
    if (identity.node.libraries.length > 0) {
      mkdirSync(path.join(prefix, 'lib'), { mode: 0o700 });
      for (const library of identity.node.libraries) {
        const source = path.resolve(path.dirname(process.execPath), '../lib', library.name);
        copyFileSync(
          source,
          path.join(prefix, 'lib', library.name),
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
      }
    }
    if (process.platform === 'win32') {
      for (const [name, filename] of [
        ['npm', 'npm-cli.js'],
        ['npx', 'npx-cli.js'],
      ])
        writeFileSync(
          path.join(bin, `${name}.cmd`),
          `@"%~dp0node.exe" "%~dp0..\\node_modules\\npm\\bin\\${filename}" %*\r\n`,
          { flag: 'wx' },
        );
    } else {
      symlinkSync('../node_modules/npm/bin/npm-cli.js', path.join(bin, 'npm'));
      symlinkSync('../node_modules/npm/bin/npx-cli.js', path.join(bin, 'npx'));
    }
  }
  const npmCli = path.join(prefix, 'node_modules/npm/bin/npm-cli.js');
  verifyReusableToolchain(prefix, identity.node);
  const environment = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    npm_execpath: npmCli,
    npm_node_execpath: path.join(bin, nodeName),
  };
  const auditEnvironment = { ...environment };
  delete auditEnvironment.NODE_OPTIONS;
  delete auditEnvironment.NODE_PATH;
  await run(
    path.join(bin, nodeName),
    ['-e', `require('node:assert/strict').equal(process.version, 'v${toolchainMetadata.node}')`],
    prefix,
    auditEnvironment,
  );
  for (const args of [
    ['ls', '--all', '--json'],
    ['audit', '--audit-level=low'],
    ['audit', '--omit=dev', '--audit-level=low'],
    ['audit', 'signatures'],
  ]) {
    await run(
      path.join(bin, nodeName),
      [npmCli, '--prefix', prefix, '--workspaces=false', ...args],
      prefix,
      auditEnvironment,
    );
  }
  const accepted = verifyReusableToolchain(prefix, identity.node);
  assert.deepEqual(cacheIdentity(), identity, 'Bootstrap source changed during qualification');
  if (!selection.reused) {
    writeFileSync(path.join(prefix, 'acceptance.json'), `${JSON.stringify(accepted)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    finishToolchainCache(selection, identity, true);
    cacheAccepted = true;
  }
  process.stderr.write(
    `Build-toolchain cache ${selection.reused ? 'reused' : 'created'}; integrity and current audits passed: ${prefix}\n`,
  );
  if (command.length === 0) {
    process.stdout.write(`${bin}\n`);
  } else {
    if (options.includes('--install')) {
      await run(
        path.join(bin, nodeName),
        [npmCli, 'ci', '--include=dev', '--include=optional', '--strict-allow-scripts'],
        repositoryRoot,
        environment,
        false,
      );
    }
    const executable =
      command[0] === 'npm' || command[0] === 'npx' ? path.join(bin, nodeName) : command[0];
    const args =
      command[0] === 'npm' || command[0] === 'npx'
        ? [
            path.join(
              prefix,
              `node_modules/npm/bin/${command[0] === 'npm' ? 'npm' : 'npx'}-cli.js`,
            ),
            ...command.slice(1),
          ]
        : command.slice(1);
    await run(executable, args, repositoryRoot, environment, false);
  }
} catch (error) {
  if (!cacheAccepted) finishToolchainCache(selection, identity, false);
  process.stderr.write(`Retained build-toolchain and command evidence at ${prefix}\n`);
  throw error;
}
