import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { satisfies } from 'semver';

const rootRequire = createRequire(import.meta.url);

test('the DOM test environment retains its supported HTTP client range', () => {
  const domRequire = createRequire(rootRequire.resolve('jsdom'));
  const manifest = rootRequire('jsdom/package.json');
  const client = domRequire('undici/package.json');
  assert.ok(satisfies(client.version, manifest.dependencies.undici));
});

test('build consumers resolve the guarded deepmerge fork', () => {
  for (const consumer of [
    '@rollup/plugin-node-resolve',
    '@svgr/plugin-prettier',
    '@svgr/plugin-svgo',
  ]) {
    const consumerRequire = createRequire(rootRequire.resolve(consumer));
    const merge = consumerRequire('deepmerge');
    const manifest = consumerRequire('deepmerge/package.json');
    assert.equal(manifest.version, '4.3.1-webops.1');
    assert.deepEqual(
      merge({ nested: { first: 1 }, array: [1] }, { nested: { second: 2 }, array: [2] }),
      {
        nested: { first: 1, second: 2 },
        array: [1, 2],
      },
    );
    assert.deepEqual(merge.all([{ first: 1 }, { second: 2 }]), { first: 1, second: 2 });
    const unsafe = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"nested":{"prototype":{"polluted":true}}}',
    );
    assert.deepEqual(merge({}, unsafe), { nested: {} });
    assert.deepEqual(merge(unsafe, { safe: true }), { nested: {}, safe: true });
    assert.equal({}.polluted, undefined);
    const symbol = Symbol('property');
    assert.deepEqual(merge({ [symbol]: 1 }, { safe: true }), { [symbol]: 1, safe: true });
    const date = new Date(0);
    assert.equal(merge({}, { date }).date, date);
    assert.deepEqual(merge({ nested: { first: 1 } }, { nested: { second: 2 } }, { clone: false }), {
      nested: { first: 1, second: 2 },
    });
  }
});

test('Redocly resolves a patched matcher with its callable API', () => {
  const openapiRequire = createRequire(rootRequire.resolve('openapi-typescript'));
  const redoclyRequire = createRequire(openapiRequire.resolve('@redocly/openapi-core'));
  const minimatch = redoclyRequire('minimatch');
  const manifest = redoclyRequire('minimatch/package.json');
  assert.equal(manifest.version, '11.0.4-webops.1');
  const matcherRequire = createRequire(redoclyRequire.resolve('minimatch'));
  assert.equal(matcherRequire('minimatch-modern/package.json').version, '11.0.4');
  assert.equal(minimatch('example.com/one', 'example.com/**'), true);
  assert.equal(minimatch('other.com/one', 'example.com/**'), false);
  assert.equal(minimatch('one.json', '*.{json,yaml}'), true);
  assert.equal(typeof minimatch.Minimatch, 'function');
});

test('the locked graph excludes vulnerable upstream build tools', async () => {
  const lock = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.match(lock, /^ {2}deepmerge@file:vendor\/deepmerge:$/m);
  assert.match(lock, /^ {2}minimatch@file:vendor\/minimatch-call-compat:$/m);
  assert.doesNotMatch(lock, /^ {2}deepmerge@4\.3\.1:$/m);
  assert.doesNotMatch(lock, /^ {2}minimatch@5\./m);
  assert.doesNotMatch(lock, /^ {2}'@svgr\/cli@/m);
});
