/* eslint-disable no-console */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptsDirectory, '..');
const startupChecks = [
  { file: 'check-env.mjs', args: [], timeout: 10_000 },
  { file: 'check-db.mjs', args: ['--verify-only'], timeout: 120_000 },
];

for (const check of startupChecks) {
  const result = spawnSync(
    process.execPath,
    [path.join(scriptsDirectory, check.file), ...check.args],
    {
      cwd: runtimeRoot,
      env: process.env,
      stdio: 'inherit',
      timeout: check.timeout,
    },
  );

  if (result.error) {
    console.error(
      result.error.code === 'ETIMEDOUT'
        ? 'A required production startup check exceeded its bounded execution time.'
        : 'A required production startup check could not run.',
    );
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const server = spawn(process.execPath, [path.join(runtimeRoot, 'server.js')], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    HOSTNAME: process.env.UMAMI_BIND_ADDRESS?.trim() || '127.0.0.1',
    PORT: process.env.PORT?.trim() || '3000',
  },
  stdio: 'inherit',
});
let shutdownSignal;

function forwardSignal(signal) {
  shutdownSignal = signal;
  server.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => forwardSignal(signal));
}

server.once('error', () => {
  console.error('The production server could not start.');
  process.exit(1);
});

server.once('exit', code => {
  process.exit(shutdownSignal ? 0 : (code ?? 1));
});
