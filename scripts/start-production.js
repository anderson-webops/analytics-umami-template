/* eslint-disable no-console */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repairStandaloneRuntime } from './repair-standalone.js';

const repositoryRoot = process.cwd();
const productionEnvironment = { ...process.env, NODE_ENV: 'production' };
delete productionEnvironment.DOTENV_CONFIG_OVERRIDE;
if (productionEnvironment.DIRECT_DATABASE_URL) {
  console.error('DIRECT_DATABASE_URL is reserved for the pre-promotion database gate.');
  process.exit(1);
}
const { appDir } = await repairStandaloneRuntime();

if (!appDir) {
  console.error('The standalone runtime is missing. Run pnpm build:production first.');
  process.exit(1);
}

const startupScripts = [
  { path: 'scripts/check-env.js', cwd: repositoryRoot },
  { path: 'scripts/check-db.js', cwd: repositoryRoot, args: ['--verify-only'] },
];

for (const startupScript of startupScripts) {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, startupScript.path), ...(startupScript.args ?? [])],
    {
      cwd: startupScript.cwd,
      env: productionEnvironment,
      stdio: 'inherit',
    },
  );

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

const runtimeEnvironment = {
  ...productionEnvironment,
  HOSTNAME: process.env.UMAMI_BIND_ADDRESS?.trim() || '127.0.0.1',
  PORT: process.env.PORT?.trim() || '3000',
};
delete runtimeEnvironment.DIRECT_DATABASE_URL;
delete runtimeEnvironment.DOTENV_CONFIG_PATH;
process.chdir(appDir);
process.execve(
  process.execPath,
  [process.execPath, path.join(appDir, 'server.js')],
  runtimeEnvironment,
);
