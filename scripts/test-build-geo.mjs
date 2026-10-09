import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';
import {
  buildGeoDatabase,
  downloadGeoSource,
  extractGeoArchive,
  getGeoSource,
  verifyGeoDatabase,
} from './geo-build.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const directories = [];

async function scratch() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'umami-geo-test-'));
  directories.push(directory);
  return directory;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
  );
});

test('default source is pinned to its immutable mirror revision and reviewed digests', () => {
  const source = getGeoSource({});

  assert.match(source.url.pathname, /\/[a-f0-9]{40}\/redist\/GeoLite2-City\.tar\.gz$/);
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  assert.match(source.databaseSha256, /^[a-f0-9]{64}$/);
  assert.equal(source.direct, false);
});

test('custom sources require an independent digest and recognize signed direct URLs', () => {
  const url = 'https://geo.example/GeoLite2-City.mmdb?signature=synthetic';

  assert.throws(() => getGeoSource({ GEO_DATABASE_URL: url }), /approved GEO_DATABASE_SHA256/);
  assert.throws(
    () => getGeoSource({ MAXMIND_LICENSE_KEY: 'synthetic' }),
    /approved GEO_DATABASE_SHA256/,
  );
  assert.throws(() => getGeoSource({ GEO_DATABASE_SHA256: 'a'.repeat(64) }), /requires a custom/);
  assert.throws(
    () =>
      getGeoSource({
        GEO_DATABASE_URL: 'https://geo.example/GeoLite2-City.tar.gz',
        GEO_DATABASE_SHA256: 'a'.repeat(64),
      }),
    /approved GEO_DATABASE_MMDB_SHA256/,
  );
  assert.throws(
    () =>
      getGeoSource({
        GEO_DATABASE_URL: 'http://geo.example/db.mmdb',
        GEO_DATABASE_SHA256: 'a'.repeat(64),
      }),
    /HTTPS URL/,
  );

  const source = getGeoSource({ GEO_DATABASE_URL: url, GEO_DATABASE_SHA256: 'a'.repeat(64) });

  assert.equal(source.direct, true);
  assert.equal(source.sha256, 'a'.repeat(64));
  assert.equal(source.databaseSha256, 'a'.repeat(64));

  const archive = getGeoSource({
    GEO_DATABASE_URL: 'https://geo.example/GeoLite2-City.tar.gz',
    GEO_DATABASE_SHA256: 'a'.repeat(64),
    GEO_DATABASE_MMDB_SHA256: 'b'.repeat(64),
  });

  assert.equal(archive.databaseSha256, 'b'.repeat(64));
});

test('download verifies bytes and rejects a mismatched digest', async () => {
  const directory = await scratch();
  const bytes = Buffer.from('synthetic database response');
  const url = new URL('https://geo.example/GeoLite2-City.mmdb');
  const fetchSource = async () => new Response(bytes, { status: 200 });

  await downloadGeoSource(
    { url, sha256: sha256(bytes) },
    path.join(directory, 'valid'),
    fetchSource,
  );
  assert.deepEqual(await fs.readFile(path.join(directory, 'valid')), bytes);

  await assert.rejects(
    downloadGeoSource(
      { url, sha256: '0'.repeat(64) },
      path.join(directory, 'invalid'),
      fetchSource,
    ),
    /reviewed SHA-256/,
  );
});

test('download rejects insecure redirects, oversized responses, and failed status', async () => {
  const directory = await scratch();
  const source = {
    url: new URL('https://geo.example/GeoLite2-City.mmdb'),
    sha256: sha256('small'),
  };

  await assert.rejects(
    downloadGeoSource(
      source,
      path.join(directory, 'redirect'),
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://geo.example/db.mmdb' } }),
    ),
    /HTTPS URL/,
  );
  await assert.rejects(
    downloadGeoSource(
      source,
      path.join(directory, 'oversized'),
      async () =>
        new Response('small', { headers: { 'content-length': String(97 * 1024 * 1024) } }),
    ),
    /download envelope/,
  );
  await assert.rejects(
    downloadGeoSource(
      source,
      path.join(directory, 'missing'),
      async () => new Response('missing', { status: 404 }),
    ),
    /HTTP 404/,
  );
});

test('archive extraction accepts one regular City database and rejects duplicates', async () => {
  const directory = await scratch();
  const first = path.join(directory, 'GeoLite2-City_20261006');
  const second = path.join(directory, 'GeoLite2-City_20261007');
  const firstBytes = randomBytes(4096);
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(path.join(first, 'GeoLite2-City.mmdb'), firstBytes);
  await fs.writeFile(path.join(second, 'GeoLite2-City.mmdb'), randomBytes(4096));

  const validArchive = path.join(directory, 'valid.tar.gz');
  await create({ gzip: true, file: validArchive, cwd: directory }, [path.basename(first)]);
  await extractGeoArchive(validArchive, path.join(directory, 'extracted.mmdb'));
  assert.deepEqual(await fs.readFile(path.join(directory, 'extracted.mmdb')), firstBytes);

  const duplicateArchive = path.join(directory, 'duplicate.tar.gz');
  await create({ gzip: true, file: duplicateArchive, cwd: directory }, [
    path.basename(first),
    path.basename(second),
  ]);
  await assert.rejects(
    extractGeoArchive(duplicateArchive, path.join(directory, 'duplicate.mmdb')),
    /one regular City database/,
  );
});

test('failed validation preserves the previously installed database', async () => {
  const directory = await scratch();
  const existing = path.join(directory, 'GeoLite2-City.mmdb');
  await fs.writeFile(existing, 'existing fixture');
  const bytes = Buffer.from('not a MaxMind database');

  await assert.rejects(
    buildGeoDatabase(
      {
        GEO_DATABASE_URL: 'https://geo.example/GeoLite2-City.mmdb',
        GEO_DATABASE_SHA256: sha256(bytes),
      },
      directory,
      async () => new Response(bytes, { status: 200 }),
    ),
  );
  assert.equal(await fs.readFile(existing, 'utf8'), 'existing fixture');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['GeoLite2-City.mmdb']);
});

test('stale packaged geolocation data fails the independent digest check', async () => {
  const directory = await scratch();
  const stale = path.join(directory, 'GeoLite2-City.mmdb');
  await fs.writeFile(stale, 'stale fixture');

  await assert.rejects(verifyGeoDatabase(stale, getGeoSource({})), /reviewed SHA-256/);
});

test('production artifact builds cannot bypass geolocation verification', async () => {
  const result = spawnSync(process.execPath, ['scripts/build-geo.js'], {
    cwd: repositoryRoot,
    env: { ...process.env, SKIP_BUILD_GEO: '1', GEO_BUILD_REQUIRED: '1' },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot skip the verified GeoIP build/);

  const directory = await scratch();
  const dotenvPath = path.join(directory, 'override.env');
  await fs.writeFile(dotenvPath, 'GEO_BUILD_REQUIRED=0\nSKIP_BUILD_GEO=1\n');
  const overridden = spawnSync(process.execPath, ['scripts/build-geo.js'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      GEO_BUILD_REQUIRED: '1',
      SKIP_BUILD_GEO: '1',
      DOTENV_CONFIG_PATH: dotenvPath,
      DOTENV_CONFIG_OVERRIDE: 'true',
    },
    encoding: 'utf8',
  });

  assert.notEqual(overridden.status, 0);
  assert.match(overridden.stderr, /cannot skip the verified GeoIP build/);
});
