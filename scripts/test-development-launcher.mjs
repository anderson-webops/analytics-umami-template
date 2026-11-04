import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const packagePath = require.resolve('dotenv/package.json');
const dotenv = JSON.parse(await readFile(packagePath, 'utf8'));
const preload = import.meta.resolve('dotenv/config');

test('development preloads dotenv without an independently detached CLI process', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const next = JSON.parse(await readFile(require.resolve('next/package.json'), 'utf8'));
  assert.match(dotenv.version, /^18\./);
  assert.equal(manifest.devDependencies['dotenv-cli'], undefined);
  assert.equal(next.bin.next.replace(/^\.\//, ''), 'dist/bin/next');
  assert.match(
    manifest.scripts.dev,
    /node --import dotenv\/config node_modules\/next\/dist\/bin\/next dev --turbo --hostname 127\.0\.0\.1$/,
  );
});

test('dotenv preloading preserves literal arguments and existing environment precedence', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'analytics-development-launcher-'));
  const environmentFile = path.join(fixture, '.env');
  try {
    await writeFile(environmentFile, 'DOTENV_LAUNCHER_FIXTURE="file marker with spaces"\n');
    for (const existing of [undefined, 'existing marker']) {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          preload,
          '--input-type=module',
          '-e',
          'console.log(JSON.stringify({value:process.env.DOTENV_LAUNCHER_FIXTURE,args:process.argv.slice(1)}))',
          '--',
          '--literal-flag',
          'two words',
        ],
        {
          cwd: fixture,
          env: {
            PATH: process.env.PATH,
            DOTENV_CONFIG_PATH: environmentFile,
            DOTENV_CONFIG_QUIET: 'true',
            ...(existing ? { DOTENV_LAUNCHER_FIXTURE: existing } : {}),
          },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        value: existing ?? 'file marker with spaces',
        args: ['--literal-flag', 'two words'],
      });
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('dotenv preloading preserves a failed command status', () => {
  const result = spawnSync(process.execPath, ['--import', preload, '-e', 'process.exit(17)'], {
    env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 17);
});

test('preloaded development commands terminate and close their output pipes', async () => {
  const child = spawn(
    process.execPath,
    ['--import', preload, '-e', 'console.log("ready");setInterval(()=>{},1000)'],
    {
      env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', DOTENV_CONFIG_QUIET: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [data] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5_000) });
    assert.equal(data.toString().trim(), 'ready');
    child.kill('SIGTERM');
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, 'SIGTERM');
  } finally {
    clearTimeout(deadline);
    child.kill('SIGKILL');
    await closed;
  }
});
