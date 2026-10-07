/* eslint-disable no-console */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isEnabled = value => ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');

if (process.argv.length !== 2) {
  console.error('The development build database check accepts no arguments.');
  process.exit(1);
}

if (isEnabled(process.env.SKIP_DB_MIGRATION)) {
  console.error('SKIP_DB_MIGRATION is not permitted for migration or verification.');
  process.exit(1);
}

if (isEnabled(process.env.SKIP_DB_CHECK)) {
  if (process.env.NODE_ENV === 'production') {
    console.error('SKIP_DB_CHECK is not permitted in production.');
    process.exit(1);
  }

  console.log('Skipping database check for development build.');
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('./check-db.js', import.meta.url)), '--verify-only'],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error('The development build database check could not run.');
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
