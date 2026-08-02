/* eslint-disable no-console */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { repairStandaloneRuntime } from './repair-standalone.js';

const repositoryRoot = process.cwd();
const { appDir } = await repairStandaloneRuntime();

if (!appDir) {
  console.error('The standalone runtime is missing. Run pnpm build:production first.');
  process.exit(1);
}

const startupScripts = [
  { path: 'scripts/check-env.js', cwd: repositoryRoot },
  { path: 'scripts/check-db.js', cwd: repositoryRoot },
  { path: 'scripts/update-tracker.js', cwd: appDir },
];

for (const startupScript of startupScripts) {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, startupScript.path)], {
    cwd: startupScript.cwd,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error('A required production startup check could not run.');
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const server = spawn(process.execPath, [path.join(appDir, 'server.js')], {
  cwd: appDir,
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
