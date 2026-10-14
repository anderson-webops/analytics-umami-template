import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  collectTransportRecords,
  createUstarHeader,
  validatePublicConfiguration,
  verifyTransportArchive,
  writeTransportArchive,
} from './mac-artifact-transport.mjs';

const site = 'analytics.avasan.org';
const repository = 'anderson-webops/analytics.avasan.org';
const configuration = {
  schema_version: 1,
  site,
  repository,
  environment: {
    PUBLIC_URL: `https://${site}`,
    CLIENT_IP_HEADER: 'x-real-ip',
    DISABLE_TELEMETRY: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    CLASSROOM_MODE: '1',
    PRIVATE_MODE: '1',
    MCP_ENABLED: '0',
  },
};

test('public build configuration is canonical and rejects private or changed values', () => {
  const canonical = validatePublicConfiguration(configuration, site, repository);
  assert.deepEqual(JSON.parse(canonical.toString()), configuration);
  assert.deepEqual(canonical, validatePublicConfiguration({ ...configuration }, site, repository));
  assert.throws(
    () =>
      validatePublicConfiguration(
        {
          ...configuration,
          environment: { ...configuration.environment, DATABASE_URL: 'private' },
        },
        site,
        repository,
      ),
    /private build configuration/,
  );
  assert.throws(
    () =>
      validatePublicConfiguration(
        {
          ...configuration,
          environment: { ...configuration.environment, PUBLIC_URL: 'https://other.test' },
        },
        site,
        repository,
      ),
    /reviewed origin/,
  );
  assert.throws(
    () =>
      validatePublicConfiguration(
        {
          ...configuration,
          environment: { ...configuration.environment, API_URL: 'https://user:pass@example.test/' },
        },
        site,
        repository,
      ),
    /without credentials/,
  );
});

test('USTAR header keeps exact names, metadata and checksum without extensions', () => {
  const longName = `runtime/node_modules/.pnpm/${'a'.repeat(120)}/node_modules/next/dist/server/index.js`;
  const record = {
    path: longName,
    type: 'file',
    mode: 0o444,
    size: 17,
    sha256: 'a'.repeat(64),
  };
  const header = createUstarHeader(record);
  const name = header.toString('utf8', 0, 100).split('\0')[0];
  const prefix = header.toString('utf8', 345, 500).split('\0')[0];
  const checksum = Number.parseInt(header.toString('ascii', 148, 156).trim(), 8);
  const copy = Buffer.from(header);
  copy.fill(32, 148, 156);
  assert.equal(`${prefix}/${name}`, longName);
  assert.equal(header.toString('ascii', 257, 263), 'ustar\0');
  assert.equal(header.toString('ascii', 156, 157), '0');
  assert.equal(
    checksum,
    copy.reduce((total, byte) => total + byte, 0),
  );
  assert.throws(
    () => createUstarHeader({ ...record, path: `runtime/${'a'.repeat(200)}` }),
    /portable USTAR/,
  );
});

test('transport archive preserves checked files and links without a runtime root member', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-transport-test-'));
  try {
    const root = path.join(temporary, 'runtime');
    await fs.mkdir(root, { mode: 0o755 });
    await fs.mkdir(path.join(root, 'modules'), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(root, 'server.js'), 'synthetic runtime\n', { mode: 0o444 });
    await fs.writeFile(path.join(root, 'runtime-manifest.json'), '{}\n', { mode: 0o444 });
    await fs.symlink('../server.js', path.join(root, 'modules', 'entry.js'));
    await fs.chmod(path.join(root, 'modules'), 0o555);
    await fs.chmod(root, 0o555);
    const bytes = await fs.readFile(path.join(root, 'server.js'));
    const manifest = {
      entries: {
        modules: { type: 'directory', mode: '0555' },
        'modules/entry.js': { type: 'symlink', target: '../server.js' },
        'server.js': {
          type: 'file',
          mode: '0444',
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
      },
    };
    const records = await collectTransportRecords(root, manifest);
    const archivePath = path.join(temporary, 'runtime.tar.gz');
    await writeTransportArchive(root, records, archivePath);
    assert.deepEqual(await verifyTransportArchive(archivePath, records), {});
    const tar = gunzipSync(await fs.readFile(archivePath));
    let offset = 0;
    for (const record of records) {
      const header = tar.subarray(offset, offset + 512);
      const basename = header.toString('utf8', 0, 100).split('\0')[0];
      const prefix = header.toString('utf8', 345, 500).split('\0')[0];
      assert.equal(prefix ? `${prefix}/${basename}` : basename, record.path);
      assert.equal(
        header.toString('ascii', 156, 157),
        record.type === 'file' ? '0' : record.type === 'directory' ? '5' : '2',
      );
      offset += 512;
      if (record.type === 'file') {
        const payload = tar.subarray(offset, offset + record.size);
        assert.equal(crypto.createHash('sha256').update(payload).digest('hex'), record.sha256);
        offset += Math.ceil(record.size / 512) * 512;
      }
    }
    assert.deepEqual(tar.subarray(offset), Buffer.alloc(1024));
    assert.ok(records.every(record => record.path !== 'runtime/'));
    const changedTar = Buffer.from(tar);
    changedTar[136] = changedTar[136] === 48 ? 49 : 48;
    changedTar.fill(32, 148, 156);
    const checksum = changedTar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    changedTar.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    const changedArchive = path.join(temporary, 'changed.tar.gz');
    await fs.writeFile(changedArchive, gzipSync(changedTar));
    await assert.rejects(
      verifyTransportArchive(changedArchive, records),
      /header is not canonical/,
    );
    await assert.rejects(
      collectTransportRecords(root, {
        entries: {
          ...manifest.entries,
          'server.js': { ...manifest.entries['server.js'], sha256: '0'.repeat(64) },
        },
      }),
      /changed after runtime verification/,
    );
    await assert.rejects(
      collectTransportRecords(root, {
        entries: { ...manifest.entries, '..': { type: 'directory' } },
      }),
      /Unsafe transport inventory path/,
    );
    await assert.rejects(
      collectTransportRecords(root, {
        entries: { ...manifest.entries, 'runtime-manifest.json': { type: 'file' } },
      }),
      /repeats a path/,
    );
    await assert.rejects(
      verifyTransportArchive(archivePath, [
        { ...records[0], path: 'runtime/../../escape' },
        ...records.slice(1),
      ]),
      /Unsafe or repeated/,
    );
  } finally {
    await fs.chmod(path.join(temporary, 'runtime', 'modules'), 0o755).catch(() => {});
    await fs.chmod(path.join(temporary, 'runtime'), 0o755).catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
