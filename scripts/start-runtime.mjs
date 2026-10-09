/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptsDirectory, '..');
const productionEnvironment = { ...process.env, NODE_ENV: 'production' };
delete productionEnvironment.DOTENV_CONFIG_OVERRIDE;
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
      env: productionEnvironment,
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

const runtimeEnvironment = {
  ...productionEnvironment,
  HOSTNAME: process.env.UMAMI_BIND_ADDRESS?.trim() || '127.0.0.1',
  PORT: process.env.PORT?.trim() || '3000',
};
delete runtimeEnvironment.DIRECT_DATABASE_URL;
delete runtimeEnvironment.DOTENV_CONFIG_PATH;
process.chdir(runtimeRoot);
process.execve(
  process.execPath,
  [process.execPath, path.join(runtimeRoot, 'server.js')],
  runtimeEnvironment,
);
