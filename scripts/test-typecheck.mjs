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
const launcher = path.join(root, 'scripts/typecheck.mjs');

test('tracker bundling emits JavaScript without invalid compiler options', async () => {
  const fixture = await mkdtemp(path.join(root, 'public', '.tracker-typescript-'));
  const output = path.join(fixture, 'script.js');

  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/rollup/dist/bin/rollup'),
        '--config',
        path.join(root, 'rollup.tracker.config.js'),
        '--file',
        output,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: path.join(fixture, '.env'),
          COLLECT_API_HOST: '',
          COLLECT_API_ENDPOINT: '/api/send',
        },
        timeout: 20_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /\bTS\d+:/);
    const script = await readFile(output, 'utf8');
    assert.match(script, /\bumami\b/);
    assert.match(script, /\/api\/send/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('native TypeScript 7 checks valid code and rejects a real type error', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'analytics-native-typescript-'));
  const source = path.join(fixture, 'fixture.ts');

  try {
    const version = spawnSync(process.execPath, [launcher, '--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^Version 7\./);

    const args = [launcher, '--ignoreConfig', '--noEmit', '--skipLibCheck', source];
    await writeFile(source, 'export const numeric: number = 42;\n');
    const valid = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);

    await writeFile(source, 'export const numeric: number = "not a number";\n');
    const invalid = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout + invalid.stderr, /TS2322/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('compiler-API consumers retain their supported JavaScript compiler', () => {
  const compiler = require('typescript');
  const openapi = require('openapi-typescript/package.json');
  assert.match(compiler.version, /^5\.9\./);
  assert.equal(typeof compiler.createSourceFile, 'function');
  assert.equal(typeof compiler.createProgram, 'function');
  assert.equal(typeof compiler.transpileModule, 'function');
  assert.equal(openapi.peerDependencies.typescript, '^5.x');
});

test('root and maintained workspace checks use the native compiler launcher', async () => {
  for (const relative of [
    'package.json',
    'packages/api-client/package.json',
    'packages/mcp/package.json',
  ]) {
    const manifest = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
    assert.match(
      manifest.scripts.typecheck,
      /^node (?:\.\.\/\.\.\/)?scripts\/typecheck\.mjs --noEmit$/,
    );
  }
});
