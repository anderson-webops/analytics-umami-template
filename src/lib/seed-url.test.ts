import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

function runSeed(databaseUrl: string, args: string[] = ['--allow-disposable-seed']) {
  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DOTENV_CONFIG_PATH: '/dev/null',
    NODE_ENV: 'development' as const,
    VERCEL: '',
    VERCEL_ENV: '',
    NETLIFY: '',
    RAILWAY_ENVIRONMENT: '',
  };
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-data.ts', ...args], {
    cwd: process.cwd(),
    env: environment,
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

test('seed requires explicit consent even with production markers absent', () => {
  const result = runSeed('postgresql://u:secret@127.0.0.1:5432/demo', []);
  const output = `${result.stdout}\n${result.stderr}`;

  expect(result.status).toBe(1);
  expect(output).toContain('--allow-disposable-seed');
  expect(output).not.toContain('secret');
});

test('seed refuses non-loopback targets without connecting', () => {
  const result = runSeed('postgresql://u:secret@db.example.com:5432/demo');
  const output = `${result.stdout}\n${result.stderr}`;

  expect(result.status).toBe(1);
  expect(output).toContain('loopback PostgreSQL');
  expect(output).not.toContain('secret');
});

test('seed rejects URL options that could redirect a loopback connection', () => {
  const result = runSeed('postgresql://u:secret@127.0.0.1:5432/demo?host=db.example.com');

  expect(result.status).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain('loopback PostgreSQL');
});

test('clear requires its own acknowledgement before connecting', () => {
  const result = runSeed('postgresql://u:secret@127.0.0.1:5432/demo', [
    '--allow-disposable-seed',
    '--clear',
  ]);

  expect(result.status).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain('--confirm-clear');
});

test.each(['0', '91', '1junk', '1e9'])('seed rejects invalid day count %s', days => {
  const result = runSeed('postgresql://u:secret@127.0.0.1:5432/demo', [
    '--allow-disposable-seed',
    '--days',
    days,
  ]);

  expect(result.status).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    '--days must be an integer between 1 and 90',
  );
});
