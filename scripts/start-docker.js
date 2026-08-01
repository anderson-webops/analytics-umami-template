/* eslint-disable no-console */
import { spawn, spawnSync } from 'node:child_process';

const startupScripts = ['scripts/check-env.js', 'scripts/check-db.js', 'scripts/update-tracker.js'];

for (const script of startupScripts) {
  const result = spawnSync(process.execPath, [script], {
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

const server = spawn(process.execPath, ['server.js'], {
  env: process.env,
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
