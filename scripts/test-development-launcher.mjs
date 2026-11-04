import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const launcher = path.resolve(path.dirname(packagePath), dotenv.bin.dotenv);

test('development uses the maintained dotenv CLI without competing executables', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(dotenv.version, /^18\./);
  assert.equal(manifest.devDependencies['dotenv-cli'], undefined);
  assert.match(
    manifest.scripts.dev,
    /dotenv run --quiet -- next dev --turbo --hostname 127\.0\.0\.1$/,
  );
});

test('dotenv forwards arguments literally and preserves existing environment precedence', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'analytics-development-launcher-'));
  const environmentFile = path.join(fixture, '.env');
  try {
    await writeFile(environmentFile, 'DOTENV_LAUNCHER_FIXTURE="file marker with spaces"\n');
    for (const existing of [undefined, 'existing marker']) {
      const result = spawnSync(
        process.execPath,
        [
          launcher,
          'run',
          '--quiet',
          '--file',
          environmentFile,
          '--',
          process.execPath,
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

test('dotenv preserves a failed child command status', () => {
  const result = spawnSync(
    process.execPath,
    [
      launcher,
      'run',
      '--quiet',
      '--file',
      '/dev/null',
      '--',
      process.execPath,
      '-e',
      'process.exit(17)',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 17);
});
