import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getCollectApiEndpoint, getCollectApiHost } from './collect-build-config.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function runModule(source, variables) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: repositoryRoot,
    env: { ...process.env, ...variables },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('accepts an empty host or a canonical HTTPS origin', () => {
  assert.equal(getCollectApiHost(''), '');
  assert.equal(
    getCollectApiHost('https://collector.example:8443/'),
    'https://collector.example:8443',
  );
  assert.equal(getCollectApiEndpoint(''), '/api/send');
  assert.equal(getCollectApiEndpoint('/collect/custom'), '/collect/custom');
  assert.equal(
    getCollectApiHost('https://collector.example/umami/'),
    'https://collector.example/umami',
  );
  assert.equal(getCollectApiHost('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(getCollectApiHost('/analytics/'), '/analytics');
  assert.equal(getCollectApiHost('/'), '/');
});

test('rejects unsafe collector URLs', () => {
  for (const value of [
    "';globalThis.__INJECTED__=1;//",
    'https://collector.example?query',
    'https://collector.example#fragment',
    'https://user:password@collector.example',
    'http://collector.example',
    'https://collector.example/a/../b',
    '/analytics/../admin',
    '//collector.example',
    'https://collector.example\n',
    'https:\\collector.example',
  ]) {
    assert.throws(() => getCollectApiHost(value), /COLLECT_API_HOST/);
  }
});

test('endpoint text matching the old replacement key remains inert', () => {
  const endpoint = '/1,globalThis.__PROBE__=1,process.env.COLLECT_API_ENDPOINT-';
  const probe = `
    import { rollup } from 'rollup';
    const config = (await import('./rollup.tracker.config.js')).default;
    const bundle = await rollup({ ...config, plugins: config.plugins.slice(0, -1) });
    const { output } = await bundle.generate({ format: 'iife' });
    const literal = '$' + '{' + JSON.stringify(process.env.COLLECT_API_ENDPOINT) + '}';
    console.log(output[0].code.includes(literal));
    await bundle.close();
  `;
  const result = runModule(probe, { COLLECT_API_ENDPOINT: endpoint });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'true');
});

test('rejects unsafe collection endpoint paths before bundling', () => {
  for (const value of [
    '/',
    'api/send',
    '//collector.example/send',
    '/api/../send',
    '/api/send?query',
    '/api/$' + '{globalThis.__INJECTED__=1}',
    '/api/`injected`',
    '/api/send\n',
  ]) {
    assert.throws(() => getCollectApiEndpoint(value), /COLLECT_API_ENDPOINT/);
  }
});

test('both browser bundles contain serialized build values rather than source statements', () => {
  const probe = `
    import { rollup } from 'rollup';
    for (const name of ['tracker', 'recorder']) {
      const config = (await import('./rollup.' + name + '.config.js')).default;
      const bundle = await rollup({ ...config, plugins: config.plugins.slice(0, -1) });
      const { output } = await bundle.generate({ format: 'iife' });
      const code = output[0].code;
      console.log(JSON.stringify({
        name,
        hostLiteral: code.includes(JSON.stringify("https://collector.example:8443/it's")),
        endpointLiteral: code.includes(JSON.stringify("/collect/it's")),
        unresolvedMarker: code.includes("process.env['COLLECT_API_HOST']") || code.includes("process.env['COLLECT_API_ENDPOINT']"),
      }));
      await bundle.close();
    }
    process.exit(0);
  `;
  const result = runModule(probe, {
    COLLECT_API_HOST: "https://collector.example:8443/it's",
    COLLECT_API_ENDPOINT: "/collect/it's",
  });

  assert.equal(result.status, 0, result.stderr);
  const bundles = result.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

  assert.deepEqual(
    bundles.map(bundle => bundle.name),
    ['tracker', 'recorder'],
  );
  assert.ok(bundles.every(bundle => bundle.hostLiteral && !bundle.unresolvedMarker));
  assert.equal(bundles[0].endpointLiteral, true);
});

test('direct browser builds reject hostile host syntax before output', () => {
  for (const name of ['tracker', 'recorder']) {
    const result = runModule(`import './rollup.${name}.config.js';`, {
      COLLECT_API_HOST: "';globalThis.__INJECTED__=1;//",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COLLECT_API_HOST/);
  }
});

test('production build rejects hostile values before database or browser work', () => {
  const result = spawnSync('pnpm', ['run', 'build:production'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      COLLECT_API_HOST: "';globalThis.__INJECTED__=1;//",
    },
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /COLLECT_API_HOST/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /prisma generate/);
});
