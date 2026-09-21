/* eslint-disable no-console */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyRuntimeArtifact, verifyRuntimeArtifact } from './runtime-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRuntime = path.join(repositoryRoot, '.next', 'standalone');
const args = process.argv.slice(2);
const release = args.includes('--release');
const requireIsolation = args.includes('--require-isolation');
const expectedIndex = args.indexOf('--expected-commit');
const expectedCommit = expectedIndex >= 0 ? args[expectedIndex + 1] : undefined;

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error =>
        error || !port ? reject(error ?? new Error('No port')) : resolve(port),
      );
    });
  });
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      if (stdout.length < 65_536) stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 65_536) stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function syntheticEnvironment(port) {
  const databaseUrl =
    process.env.RUNTIME_ACCEPTANCE_DATABASE_URL ||
    'postgresql://umami:synthetic-password-0000000000000000@127.0.0.1:65534/umami?schema=public';

  return {
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    APP_SECRET: 'artifact-acceptance-secret-000000000000',
    PUBLIC_URL: 'https://analytics.example.com',
    CLIENT_IP_HEADER: 'x-real-ip',
    DISABLE_TELEMETRY: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    UMAMI_BIND_ADDRESS: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    RUNTIME_ACCEPTANCE_EXPECT_READY: release ? '1' : '0',
    RUNTIME_ACCEPTANCE_USE_STARTUP: release ? '1' : '0',
  };
}

async function runPortableSmoke(runtime, port) {
  return run(process.execPath, [path.join(runtime, 'runtime-scripts', 'artifact-smoke.mjs')], {
    cwd: runtime,
    env: { ...process.env, ...syntheticEnvironment(port) },
  });
}

async function runIsolatedSmoke(runtime, cache, port) {
  const useSudo = process.env.RUNTIME_ACCEPTANCE_BWRAP_SUDO === '1';
  const bwrapCommand = useSudo ? '/usr/bin/sudo' : 'bwrap';
  const bwrapPrefix = useSudo ? ['--non-interactive', '/usr/bin/bwrap'] : [];
  const probe = spawnSync(bwrapCommand, [...bwrapPrefix, '--version'], {
    encoding: 'utf8',
  });

  if (probe.status !== 0) {
    throw new Error('Bubblewrap is required for isolated release artifact acceptance.');
  }

  if (useSudo && (typeof process.getuid !== 'function' || typeof process.getgid !== 'function')) {
    throw new Error('Privileged Bubblewrap setup requires a POSIX runner identity.');
  }

  const nodeRoot = path.dirname(path.dirname(await fs.realpath(process.execPath)));
  const nodePath = '/runtime-node/bin/node';
  const bwrapArgs = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    ...(useSudo
      ? ['--uid', String(process.getuid()), '--gid', String(process.getgid()), '--cap-drop', 'ALL']
      : []),
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--unshare-cgroup-try',
    '--clearenv',
    '--ro-bind',
    runtime,
    '/app',
    '--bind',
    cache,
    '/app/.next/cache',
    '--ro-bind',
    nodeRoot,
    '/runtime-node',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--ro-bind-try',
    '/etc/ssl/certs',
    '/etc/ssl/certs',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--chdir',
    '/app',
  ];

  for (const [name, value] of Object.entries({
    ...syntheticEnvironment(port),
    PATH: '/runtime-node/bin:/usr/bin:/bin',
    HOME: '/tmp',
  })) {
    bwrapArgs.push('--setenv', name, value);
  }

  bwrapArgs.push(nodePath, '/app/runtime-scripts/artifact-smoke.mjs');

  return run(bwrapCommand, [...bwrapPrefix, ...bwrapArgs], {
    cwd: repositoryRoot,
    env: useSudo ? { PATH: '/usr/bin:/bin' } : {},
  });
}

async function clearRuntimeCache(runtime) {
  const cache = path.join(runtime, '.next', 'cache');

  await fs.rm(cache, { recursive: true, force: true });
  await fs.mkdir(cache, { recursive: true, mode: 0o750 });
}

async function expectMissingModuleFailure(runtime) {
  const nextModule = path.join(runtime, 'node_modules', 'next');
  const hiddenModule = path.join(runtime, 'node_modules', '.runtime-next-missing');

  await fs.rename(nextModule, hiddenModule);

  try {
    await verifyRuntimeArtifact(runtime, { release: false }).then(
      () => {
        throw new Error('Verifier accepted an artifact with its Next runtime removed.');
      },
      () => undefined,
    );

    const result = spawnSync(process.execPath, ['server.js'], {
      cwd: runtime,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ...syntheticEnvironment(await availablePort()) },
    });
    const failure = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;

    if (
      result.status === 0 ||
      !/(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (module|package))/i.test(failure)
    ) {
      throw new Error('The real runtime did not fail with a missing-module error as expected.');
    }
  } finally {
    await fs.rename(hiddenModule, nextModule);
  }
}

async function expectStartupDependencyFailure(runtime) {
  const port = await availablePort();
  const result = spawnSync(
    process.execPath,
    [path.join('runtime-scripts', 'start-production.mjs')],
    {
      cwd: runtime,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        ...syntheticEnvironment(port),
        DATABASE_URL:
          'postgresql://umami:synthetic-password-0000000000000000@127.0.0.1:65534/umami?schema=public&connect_timeout=2',
        RUNTIME_ACCEPTANCE_EXPECT_READY: '0',
        RUNTIME_ACCEPTANCE_USE_STARTUP: '1',
      },
    },
  );
  const failure = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;

  if (result.status === 0 || !/Unable to connect to the database/i.test(failure)) {
    throw new Error(
      'The production entrypoint did not fail closed when PostgreSQL was unavailable.',
    );
  }
}

if (
  release &&
  (!requireIsolation || !expectedCommit || !process.env.RUNTIME_ACCEPTANCE_DATABASE_URL)
) {
  throw new Error(
    'Release acceptance requires --require-isolation, --expected-commit, and RUNTIME_ACCEPTANCE_DATABASE_URL.',
  );
}

// Keep the copied runtime outside every source-checkout ancestor. This prevents
// Node's parent-directory module resolution from masking an omitted dependency.
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'umami-runtime-artifact-'));
const copiedRuntime = path.join(temporaryRoot, 'runtime');
const isolatedCache = path.join(temporaryRoot, 'cache');

try {
  await copyRuntimeArtifact(sourceRuntime, copiedRuntime, { release, expectedCommit });
  await fs.mkdir(isolatedCache, { mode: 0o750 });
  await expectStartupDependencyFailure(copiedRuntime);

  const port = await availablePort();
  const smoke = requireIsolation
    ? await runIsolatedSmoke(copiedRuntime, isolatedCache, port)
    : await runPortableSmoke(copiedRuntime, port);

  if (smoke.code !== 0) {
    throw new Error(
      `Artifact smoke test failed with ${smoke.signal ?? smoke.code}.\n${smoke.stderr}${smoke.stdout}`,
    );
  }

  await expectMissingModuleFailure(copiedRuntime);
  await clearRuntimeCache(copiedRuntime);
  await verifyRuntimeArtifact(copiedRuntime, { release, expectedCommit });
  console.log('Exact copied runtime, missing-module regression, and final hashes passed.');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
