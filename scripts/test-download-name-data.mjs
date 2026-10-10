import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import { downloadNameData } from './download-name-data.mjs';

const runsDirectory = path.join(process.cwd(), '.ai-work/runs');
const fixtures = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createFixture(locale = 'zz-ZZ') {
  await fs.mkdir(runsDirectory, { recursive: true });
  const root = await fs.mkdtemp(path.join(runsDirectory, 'name-data-'));
  fixtures.push(root);
  const messageDirectory = path.join(root, 'public/intl/messages');
  await fs.mkdir(messageDirectory, { recursive: true });
  await fs.writeFile(path.join(messageDirectory, `${locale}.json`), '{}');
  return root;
}

function makeManifest(bytes, kind = 'country', locale = 'zz-ZZ') {
  return {
    [kind]: {
      revision: 'a'.repeat(40),
      files: {
        [locale]: {
          sourceLocale: 'zz_ZZ',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    },
  };
}

test('pins the upstream revision, verifies bytes, and refuses changed existing data', async () => {
  const root = await createFixture();
  const bytes = Buffer.from('{"US":"United States"}\n');
  const manifest = makeManifest(bytes);
  let requests = 0;
  const fetchSource = async (url, options) => {
    requests++;
    assert.equal(
      url,
      `https://raw.githubusercontent.com/umpirsky/country-list/${'a'.repeat(40)}/data/zz_ZZ/country.json`,
    );
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['accept-encoding'], 'identity');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  };
  const filename = path.join(root, 'public/intl/country/zz-ZZ.json');

  assert.deepEqual(await downloadNameData('country', { root, manifest, fetchSource }), [filename]);
  assert.deepEqual(await fs.readFile(filename), bytes);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o644);
  assert.deepEqual(await downloadNameData('country', { root, manifest, fetchSource }), []);
  assert.equal(requests, 1);

  await fs.writeFile(filename, 'partial');
  await assert.rejects(
    downloadNameData('country', { root, manifest, fetchSource }),
    /digest and size/,
  );
  assert.equal(requests, 1);
});

test('pins the Galician source while retaining the existing ga-ES output name', async () => {
  for (const kind of ['country', 'language']) {
    const root = await createFixture('ga-ES');
    await assert.rejects(
      downloadNameData(kind, {
        root,
        fetchSource: async url => {
          assert.match(url, new RegExp(`/data/gl_ES/${kind}\\.json$`));
          throw new Error('stopped before download');
        },
      }),
      /stopped before download/,
    );
  }
});

test('rejects unreviewed missing locales and nonregular existing paths', async () => {
  const root = await createFixture();
  const fetchSource = () => {
    throw new Error('No network request expected.');
  };
  await assert.rejects(
    downloadNameData('country', { root, manifest: {}, fetchSource }),
    /No reviewed/,
  );

  const destination = path.join(root, 'public/intl/country/zz-ZZ.json');
  await fs.symlink(path.join(root, 'public/intl/messages/zz-ZZ.json'), destination);
  await assert.rejects(
    downloadNameData('country', { root, manifest: {}, fetchSource }),
    /regular file/,
  );
});

test('accepts only byte-identical committed assets without explicit pins', async () => {
  const root = await createFixture();
  const destination = path.join(root, 'public/intl/country/zz-ZZ.json');
  const fetchSource = () => {
    throw new Error('No network request expected.');
  };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, '{"US":"United States"}\n');
  await assert.rejects(
    downloadNameData('country', { root, manifest: {}, fetchSource }),
    /lacks a committed source/,
  );

  await execFileAsync('git', ['init', '-q', root]);
  await execFileAsync('git', ['-C', root, 'add', 'public/intl']);
  await execFileAsync('git', [
    '-C',
    root,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  assert.deepEqual(await downloadNameData('country', { root, manifest: {}, fetchSource }), []);

  await fs.writeFile(destination, '{"US":"Changed"}\n');
  await assert.rejects(
    downloadNameData('country', { root, manifest: {}, fetchSource }),
    /differs from committed source/,
  );
});

test('rejects bad status, response envelopes, truncated and oversized bodies without partial output', async t => {
  const bytes = Buffer.from('{"US":"United States"}\n');
  const manifest = makeManifest(bytes);
  const scenarios = [
    ['redirect', new Response(null, { status: 302 }), /HTTP 302/],
    ['missing', new Response(null, { status: 404 }), /HTTP 404/],
    [
      'wrong declared length',
      new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }),
      /download envelope/,
    ],
    [
      'encoded response',
      new Response(bytes, { headers: { 'content-encoding': 'gzip' } }),
      /download envelope/,
    ],
    ['truncated body', new Response(bytes.subarray(0, -1)), /digest and size/],
    ['oversized body', new Response(Buffer.concat([bytes, bytes])), /byte limit/],
  ];

  for (const [name, response, error] of scenarios) {
    await t.test(name, async () => {
      const root = await createFixture();
      await assert.rejects(
        downloadNameData('country', { root, manifest, fetchSource: async () => response }),
        error,
      );
      assert.deepEqual(await fs.readdir(path.join(root, 'public/intl/country')), []);
    });
  }
});

test('rejects validly pinned but malformed or nonflat JSON', async () => {
  for (const bytes of [Buffer.from('{broken'), Buffer.from('{"US":{"nested":true}}')]) {
    const root = await createFixture();
    await assert.rejects(
      downloadNameData('country', {
        root,
        manifest: makeManifest(bytes),
        fetchSource: async () => new Response(bytes),
      }),
      /valid JSON|flat map/,
    );
    assert.deepEqual(await fs.readdir(path.join(root, 'public/intl/country')), []);
  }
});

test('rejects a matching-size digest change and network failure without writing output', async () => {
  const root = await createFixture();
  const bytes = Buffer.from('{"US":"United States"}\n');
  const manifest = makeManifest(bytes);
  const changed = Buffer.from('{"US":"United State!"}\n');

  await assert.rejects(
    downloadNameData('country', {
      root,
      manifest,
      fetchSource: async () => new Response(changed),
    }),
    /digest and size/,
  );
  await assert.rejects(
    downloadNameData('country', {
      root,
      manifest,
      fetchSource: async () => {
        throw new Error('transport timeout');
      },
    }),
    /transport timeout/,
  );
  assert.deepEqual(await fs.readdir(path.join(root, 'public/intl/country')), []);
});
