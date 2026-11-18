import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { nodeIdentity, verifyReusableToolchain } from './build-toolchain-cache.mjs';
import { selectedNpmCli, verifyBuildToolchain } from './build-toolchain-state.mjs';

verifyBuildToolchain();
const root = path.resolve(import.meta.dirname, '..');
const npmCli = selectedNpmCli();
const npmRoot = path.resolve(path.dirname(npmCli), '..');
const prefix = path.resolve(npmRoot, '../..');
const require = createRequire(path.join(npmRoot, 'package.json'));
const applicationRequire = createRequire(import.meta.url);
const compilers = [
  applicationRequire.resolve('typescript/bin/tsc'),
  path.join(root, 'scripts/typecheck.mjs'),
];
const expectedVersions = {
  '@npmcli/query': '6.0.0',
  'balanced-match': '5.0.0',
  chalk: '6.0.1',
  'content-type': '3.1.1',
  diff: '9.0.0',
  'env-paths': '4.0.0-webops.1',
  minipass: '7.1.3',
  'minipass-flush': '2.0.1-webops.1',
  'minipass-pipeline': '3.0.1-webops.1',
  proggy: '5.0.0',
  'spdx-expression-parse': '5.0.0',
  'supports-color': '11.0.0',
  yallist: '5.0.0',
};

async function fixture(context) {
  const base = path.join(root, '.ai-work/runs');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'npm-tool-majors-'));
  context.after(() => rm(directory, { recursive: true }));
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'tool-compat-fixture',
      version: '1.0.0',
      private: true,
      license: 'MIT OR Apache-2.0',
    }),
  );
  await writeFile(path.join(directory, 'empty.npmrc'), '');
  await writeFile(path.join(directory, 'empty-global.npmrc'), '');
  return directory;
}

function runNpm(directory, argumentsList) {
  const environment = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: path.join(directory, 'empty.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'empty-global.npmrc'),
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1',
    NPM_CONFIG_CACHE: path.join(directory, 'cache'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const result = spawnSync(process.execPath, [npmCli, ...argumentsList], {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('the actual npm graph resolves all thirteen reviewed major versions without obsolete nested copies', async () => {
  const lock = JSON.parse(await readFile(path.join(prefix, 'package-lock.json'), 'utf8'));
  for (const [name, expected] of Object.entries(expectedVersions)) {
    const paths = Object.entries(lock.packages).filter(([filename]) =>
      filename.endsWith(`node_modules/${name}`),
    );
    assert.ok(paths.length > 0, name);
    assert.ok(
      paths.every(([, metadata]) => metadata.version === expected),
      name,
    );
    const metadata = JSON.parse(
      await readFile(path.join(prefix, 'node_modules', name, 'package.json'), 'utf8'),
    );
    assert.equal(metadata.version, expected);
  }
});

test('node-gyp executes the modern callable path helper and retains its actual cache directory behavior', async context => {
  const directory = await fixture(context);
  const nodeGypRequire = createRequire(require.resolve('node-gyp'));
  const paths = nodeGypRequire('env-paths');
  assert.equal(typeof paths, 'function');
  const value = paths('node-gyp', { suffix: '' });
  assert.equal(path.basename(value.cache), 'node-gyp');
  assert.ok(Object.values(value).every(filename => path.isAbsolute(filename)));
  assert.throws(() => paths('../unapproved'), /name|filename|valid/i);
  const result = spawnSync(
    process.execPath,
    [nodeGypRequire.resolve('../bin/node-gyp.js'), '--help'],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: directory },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node-gyp|Usage/);
  const modern = await import(
    pathToFileURL(nodeGypRequire.resolve('env-paths').replace(/compat\.cjs$/, 'index.js')).href
  );
  assert.equal(paths.default, modern.default);
});

test('modern flush preserves callback, promise, function shorthand and subclass completion', async () => {
  const Flush = require('minipass-flush');
  const modern = require(path.join(prefix, 'node_modules/minipass-flush/dist/commonjs/index.js'));
  assert.equal(Flush.Flush, modern.Flush);
  for (const kind of ['callback', 'promise', 'function', 'subclass']) {
    let completed = 0;
    const callback = done => {
      setImmediate(() => {
        completed += 1;
        done();
      });
    };
    class OwnedFlush extends Flush {
      flush(done) {
        callback(done);
      }
    }
    const stream =
      kind === 'function'
        ? new Flush(callback)
        : kind === 'subclass'
          ? new OwnedFlush()
          : new Flush({
              flush:
                kind === 'promise'
                  ? async () => {
                      completed += 1;
                    }
                  : callback,
            });
    assert.ok(stream instanceof modern.Flush);
    const result = stream.concat();
    stream.end(Buffer.from('payload'));
    assert.deepEqual(await result, Buffer.from('payload'));
    assert.equal(completed, 1);
  }
});

test('flush failures propagate through callback and promise consumers', async () => {
  const Flush = require('minipass-flush');
  for (const flush of [
    done => {
      done(new Error('controlled flush failure'));
    },
    async () => {
      throw new Error('controlled flush failure');
    },
  ]) {
    const stream = new Flush({ flush });
    const result = stream.promise();
    stream.resume();
    stream.end('payload');
    await assert.rejects(result, /controlled flush failure/);
  }
});

test('pipeline preserves stream-first, explicit options, delayed linking and error propagation', async () => {
  const Pipeline = require('minipass-pipeline');
  const modern = require(
    path.join(prefix, 'node_modules/minipass-pipeline/dist/commonjs/index.js'),
  );
  assert.equal(Pipeline.Pipeline, modern.Pipeline);
  for (const kind of ['stream-first', 'options', 'delayed']) {
    const input = Readable.from([Buffer.from('first'), Buffer.from('-second')]);
    const transform = new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
    });
    const pipeline =
      kind === 'stream-first'
        ? new Pipeline(input, transform)
        : kind === 'options'
          ? new Pipeline({}, input, transform)
          : new Pipeline();
    if (kind === 'delayed') pipeline.push(input, transform);
    assert.ok(pipeline instanceof modern.Pipeline);
    assert.deepEqual(await pipeline.concat(), Buffer.from('first-second'));
  }
  const input = new Readable({
    read() {
      this.destroy(new Error('controlled pipeline failure'));
    },
  });
  const pipeline = new Pipeline(
    input,
    new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
    }),
  );
  await assert.rejects(pipeline.concat(), /controlled pipeline failure/);
});

test('cacache runs real content, index, streaming reads and integrity rejection through modern streams', async context => {
  const directory = await fixture(context);
  const cache = path.join(directory, 'content-cache');
  const cacache = require('cacache');
  const body = Buffer.from('retained cache payload ☃');
  await cacache.put(cache, 'fixture-key', body);
  assert.deepEqual((await cacache.get(cache, 'fixture-key')).data, body);
  const chunks = [];
  for await (const chunk of cacache.get.stream(cache, 'fixture-key')) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), body);
  const output = cacache.put.stream(cache, 'stream-key');
  const completed = once(output, 'finish');
  output.end(body);
  await completed;
  assert.deepEqual((await cacache.get(cache, 'stream-key')).data, body);
  await assert.rejects(cacache.get(cache, 'missing-key'), { code: 'ENOENT' });
  const entry = await cacache.get.info(cache, 'fixture-key');
  await writeFile(entry.path, Buffer.from('tampered fixture bytes'));
  await assert.rejects(cacache.get(cache, 'fixture-key'), /integrity|EINTEGRITY|checksum/i);
});

test('make-fetch-happen preserves real cache completion and offline retained response behavior', async context => {
  const directory = await fixture(context);
  const fetch = require('make-fetch-happen');
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'public, max-age=3600',
      'content-type': 'application/json',
    });
    response.end('{"retained":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  const options = {
    cachePath: path.join(directory, 'fetch-cache'),
    retry: { retries: 0 },
  };
  assert.equal(await (await fetch(url, options)).text(), '{"retained":true}');
  await new Promise(resolve => server.close(resolve));
  assert.equal(
    await (await fetch(url, { ...options, cache: 'only-if-cached' })).text(),
    '{"retained":true}',
  );
});

test('negotiator consumes modern media parameters and preserves quality-ranked matching', () => {
  const Negotiator = require('negotiator');
  const negotiatorRequire = createRequire(require.resolve('negotiator'));
  const modern = negotiatorRequire('content-type');
  assert.equal(modern.parse('application/json; charset=utf-8').parameters.charset, 'utf-8');
  const negotiator = new Negotiator({
    headers: {
      accept: 'text/plain;q=0.2, application/json;q=0.9',
      'accept-language': 'es;q=0.5, en;q=0.9',
    },
  });
  assert.equal(negotiator.mediaType(['text/plain', 'application/json']), 'application/json');
  assert.equal(negotiator.language(['es', 'en']), 'en');
});

test('Arborist query and proggy trackers execute through actual parent APIs and the npm CLI', async context => {
  const directory = await fixture(context);
  const Arborist = require('@npmcli/arborist');
  const arborist = new Arborist({ path: directory });
  arborist.addTracker('root');
  arborist.addTracker('root', 'child');
  arborist.finishTracker('root', 'child');
  arborist.finishTracker('root');
  const result = JSON.parse(runNpm(directory, ['query', ':root', '--json']));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'tool-compat-fixture');
  const dependency = path.join(directory, 'node_modules/fixture-dependency');
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(dependency, 'package.json'),
    JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }),
  );
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'tool-compat-fixture',
      version: '1.0.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }),
  );
  for (const selector of ['[name=fixture-dependency]', ':root > .prod']) {
    const selected = JSON.parse(runNpm(directory, ['query', selector, '--json']));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].name, 'fixture-dependency');
  }
});

test('npm patch generation and Arborist diff parsing preserve exact changed bytes', async context => {
  const directory = await fixture(context);
  const original = path.join(directory, 'original');
  const edited = path.join(directory, 'edited');
  await mkdir(original);
  await mkdir(edited);
  await writeFile(path.join(original, 'file.txt'), 'before\n');
  await writeFile(path.join(edited, 'file.txt'), 'after\n');
  const { diffDirs } = require(path.join(npmRoot, 'lib/utils/patch-diff.js'));
  const result = await diffDirs(original, edited);
  const arboristRequire = createRequire(require.resolve('@npmcli/arborist'));
  const diff = arboristRequire('diff');
  assert.equal(diff.parsePatch(result.diff).length, 1);
  assert.equal(diff.applyPatch('before\n', result.diff), 'after\n');
  assert.equal(result.packageJsonChanged, false);
  await writeFile(
    path.join(original, 'package.json'),
    JSON.stringify({ name: 'diff-fixture', version: '1.0.0' }),
  );
  await writeFile(
    path.join(edited, 'package.json'),
    JSON.stringify({ name: 'diff-fixture', version: '1.1.0' }),
  );
  const output = runNpm(directory, ['diff', `--diff=file:${original}`, `--diff=file:${edited}`]);
  assert.match(output, /-before/);
  assert.match(output, /\+after/);
});

test('license validation, CycloneDX output, colors and brace matching preserve actual npm contracts', async context => {
  const directory = await fixture(context);
  const validLicense = require(
    path.join(prefix, 'node_modules/@npmcli/package-json/lib/license.js'),
  );
  assert.equal(validLicense('MIT OR Apache-2.0'), true);
  assert.equal(validLicense('LicenseRef-Unknown'), false);
  assert.equal(validLicense('invalid license text'), false);
  const result = JSON.parse(runNpm(directory, ['sbom', '--sbom-format=cyclonedx']));
  assert.equal(result.bomFormat, 'CycloneDX');
  const { Chalk } = await import(pathToFileURL(require.resolve('chalk')).href);
  assert.equal(new Chalk({ level: 1 }).green('fixture'), '\u001B[32mfixture\u001B[39m');
  const { createSupportsColor } = await import(
    pathToFileURL(require.resolve('supports-color')).href
  );
  const support = createSupportsColor(process.stdout);
  assert.ok(
    support === false ||
      (Number.isInteger(support.level) && support.level >= 0 && support.level <= 3),
  );
  const { expand } = require('brace-expansion');
  assert.deepEqual(expand('entry-{a,b}-{1..2}'), [
    'entry-a-1',
    'entry-a-2',
    'entry-b-1',
    'entry-b-2',
  ]);
});

test('new local tool archives and installed bridge bytes reject corruption before reuse', async context => {
  const directory = await fixture(context);
  const candidate = path.join(directory, 'candidate');
  await cp(prefix, candidate, { recursive: true, verbatimSymlinks: true });
  const expectedNode = nodeIdentity();
  verifyReusableToolchain(candidate, expectedNode);
  for (const archive of [
    'env-paths-4.0.0-webops.1.tgz',
    'minipass-flush-2.0.1-webops.1.tgz',
    'minipass-pipeline-3.0.1-webops.1.tgz',
    'picomatch-4.0.7-webops.1.tgz',
  ]) {
    const filename = path.join(candidate, 'vendor', archive);
    const original = await readFile(filename);
    await writeFile(filename, Buffer.concat([original, Buffer.from('unapproved bytes')]));
    assert.throws(
      () => verifyReusableToolchain(candidate, expectedNode),
      /archive differs|input differs/,
    );
    await writeFile(filename, original);
  }
  const filename = path.join(candidate, 'node_modules/env-paths/compat.cjs');
  const original = await readFile(filename);
  await writeFile(filename, `${original}\\nthrow new Error('unapproved code');\\n`);
  assert.throws(
    () => verifyReusableToolchain(candidate, expectedNode),
    /Complete toolchain payload differs/,
  );
  await writeFile(filename, original);
  verifyReusableToolchain(candidate, expectedNode);
});

for (const [index, compiler] of compilers.entries()) {
  test(`TypeScript ${
    index === 0 ? 6 : 7
  } validates original modern modules and callable tool bridges strictly`, {
    timeout: 120_000,
  }, async context => {
    const directory = await fixture(context);
    await symlink(path.join(prefix, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    const valid = path.join(directory, 'valid.cts');
    const modern = path.join(directory, 'valid.mts');
    await writeFile(
      valid,
      `import { Readable } from 'node:stream';\nimport paths = require('env-paths');\nimport Flush = require('minipass-flush');\nimport Pipeline = require('minipass-pipeline');\nconst cache: string = paths('fixture').cache;\nconst stream = new Flush<Buffer>(done => done());\nconst chained = new Pipeline<Buffer>(Readable.from([Buffer.from(cache)]), stream);\nconst named = new Pipeline.Pipeline<Buffer>({}, Readable.from([]));\n`,
    );
    await writeFile(
      modern,
      `import paths from 'env-paths';\nimport { Flush } from 'minipass-flush';\nimport { Pipeline } from 'minipass-pipeline';\nconst cache: string = paths('fixture').cache;\nconst stream = new Flush<Buffer>({ flush(done) { done(); } });\nconst chained = new Pipeline<Buffer>({}, stream);\n`,
    );
    const configuration = path.join(directory, 'tsconfig.json');
    const compile = async files => {
      await writeFile(
        configuration,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            skipLibCheck: false,
            noEmit: true,
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2023',
            types: ['node'],
            typeRoots: [path.join(root, 'node_modules/@types')],
          },
          files,
        }),
      );
      return spawnSync(process.execPath, [compiler, '--project', configuration], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    };
    const checked = await compile([valid, modern]);
    assert.equal(checked.status, 0, checked.stdout || checked.stderr);
    for (const invalid of [
      "import paths = require('env-paths'); paths(42);",
      "import Flush = require('minipass-flush'); new Flush(42);",
      "import Pipeline = require('minipass-pipeline'); new Pipeline(42);",
    ]) {
      const filename = path.join(directory, 'invalid.cts');
      await writeFile(filename, invalid);
      const rejected = await compile([filename]);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stdout, /error TS\d+/);
      assert.doesNotMatch(rejected.stdout, /TS2307|TS7016/);
    }
  });
}
