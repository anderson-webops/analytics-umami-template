import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

function runSeed(databaseUrl: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-data.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DOTENV_CONFIG_PATH: '/dev/null',
      NODE_ENV: 'development',
      VERCEL: '',
      NETLIFY: '',
      RAILWAY_ENVIRONMENT: '',
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test.each([
  ['postgresql://u:seed-secret@', 'seed-secret'],
  ['postgresql://u:line-break@\n', 'line-break'],
])('malformed seed database URL never reaches diagnostics', (databaseUrl, secret) => {
  const result = runSeed(databaseUrl);
  const output = `${result.stdout}\n${result.stderr}`;

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(output).toContain('DATABASE_URL is not a valid URL');
  expect(output).toContain('Expected format: postgresql://user:password@host:port/database');
  expect(output).not.toContain(secret);
  expect(output).not.toContain('Received:');
});

test('missing seed database URL retains its configuration diagnostic', () => {
  const result = runSeed('');

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    'DATABASE_URL environment variable is not set.',
  );
});
