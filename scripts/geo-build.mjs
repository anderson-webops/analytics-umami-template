import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import maxmind from 'maxmind';
import { list } from 'tar';
import pinnedSource from './geo-source.json' with { type: 'json' };

const DATABASE_NAME = 'GeoLite2-City.mmdb';
const MAX_DOWNLOAD_BYTES = 96 * 1024 * 1024;
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 64;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const SHA256 = /^[a-f0-9]{64}$/;

function httpsUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) {
      return url;
    }
  } catch {}

  throw new Error('The GeoIP source must be an HTTPS URL without credentials or a fragment.');
}

export function getGeoSource(env = process.env) {
  const customUrl = env.GEO_DATABASE_URL?.trim();
  const licenseKey = env.MAXMIND_LICENSE_KEY?.trim();
  const customDigest = env.GEO_DATABASE_SHA256?.trim();
  const customDatabaseDigest = env.GEO_DATABASE_MMDB_SHA256?.trim();
  const url = customUrl
    ? httpsUrl(customUrl)
    : licenseKey
      ? httpsUrl(
          `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${encodeURIComponent(licenseKey)}&suffix=tar.gz`,
        )
      : httpsUrl(pinnedSource.url);

  if ((customUrl || licenseKey) && !SHA256.test(customDigest ?? '')) {
    throw new Error('Custom GeoIP sources require an independently approved GEO_DATABASE_SHA256.');
  }

  if (!customUrl && !licenseKey && customDigest) {
    throw new Error('GEO_DATABASE_SHA256 requires a custom GeoIP source.');
  }

  if (!customUrl && !licenseKey && customDatabaseDigest) {
    throw new Error('GEO_DATABASE_MMDB_SHA256 requires a custom GeoIP source.');
  }

  if (!SHA256.test(pinnedSource.sha256) || !SHA256.test(pinnedSource.databaseSha256)) {
    throw new Error('The reviewed GeoIP source has invalid digests.');
  }

  if (!customUrl && !licenseKey && !url.pathname.includes(`/${pinnedSource.revision}/`)) {
    throw new Error('The reviewed GeoIP source must use its pinned revision.');
  }

  const direct = url.pathname.toLowerCase().endsWith('.mmdb');

  if (
    (customUrl || licenseKey) &&
    ((!direct && !SHA256.test(customDatabaseDigest ?? '')) ||
      (direct && customDatabaseDigest && customDatabaseDigest !== customDigest))
  ) {
    throw new Error('Custom GeoIP archives require an approved GEO_DATABASE_MMDB_SHA256.');
  }

  const databaseSha256 =
    customUrl || licenseKey
      ? direct
        ? customDigest
        : customDatabaseDigest
      : pinnedSource.databaseSha256;

  return {
    url,
    sha256: customDigest || pinnedSource.sha256,
    databaseSha256,
    direct,
  };
}

export async function downloadGeoSource(source, destination, fetchSource = fetch) {
  let currentUrl = httpsUrl(source.url);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchSource(currentUrl, { redirect: 'manual', signal });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();

      if (!location || redirects === MAX_REDIRECTS) {
        throw new Error('The GeoIP download exceeded its redirect limit.');
      }

      currentUrl = httpsUrl(new URL(location, currentUrl));
      continue;
    }

    if (response.status !== 200 || !response.body) {
      throw new Error(`The GeoIP source returned HTTP ${response.status}.`);
    }

    const declaredLength = response.headers.get('content-length');

    if (
      (declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_DOWNLOAD_BYTES)) ||
      ![null, 'identity'].includes(response.headers.get('content-encoding'))
    ) {
      await response.body.cancel();
      throw new Error('The GeoIP response is not within the download envelope.');
    }

    const hash = createHash('sha256');
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;

        if (bytes > MAX_DOWNLOAD_BYTES) {
          callback(new Error('The GeoIP download exceeded its byte limit.'));
          return;
        }

        hash.update(chunk);
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );

    if (hash.digest('hex') !== source.sha256) {
      throw new Error('The GeoIP download does not match its reviewed SHA-256.');
    }

    return;
  }
}

export async function extractGeoArchive(archivePath, destination) {
  let entries = 0;
  let totalBytes = 0;
  let databaseEntries = 0;
  let write;
  let invalidReason;
  const stage = await fs.mkdtemp(path.join(path.dirname(destination), '.geo-archive-'));
  const tarPath = path.join(stage, 'archive.tar');

  try {
    let expandedBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        expandedBytes += chunk.length;

        if (expandedBytes > MAX_ARCHIVE_BYTES) {
          callback(new Error('The GeoIP archive exceeded its expanded byte limit.'));
          return;
        }

        callback(null, chunk);
      },
    });

    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      limiter,
      createWriteStream(tarPath, { flags: 'wx', mode: 0o600 }),
    );

    await list({
      file: tarPath,
      strict: true,
      filter(_entryPath, entry) {
        entries++;
        totalBytes += entry.size;

        if (
          entries > MAX_ARCHIVE_ENTRIES ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          totalBytes > MAX_ARCHIVE_BYTES
        ) {
          invalidReason = 'The GeoIP archive exceeded its entry or size limit.';
          return false;
        }

        if (path.posix.basename(entry.path) !== DATABASE_NAME) {
          return false;
        }

        databaseEntries++;

        if (
          !['File', 'ContiguousFile'].includes(entry.type) ||
          databaseEntries > 1 ||
          entry.size > MAX_DATABASE_BYTES
        ) {
          invalidReason = 'The GeoIP archive must contain one regular City database.';
          return false;
        }

        return true;
      },
      onReadEntry(entry) {
        write = pipeline(entry, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
        write.catch(() => {});
      },
    });

    if (invalidReason) {
      await write?.catch(() => {});
      throw new Error(invalidReason);
    }

    if (databaseEntries !== 1 || !write) {
      throw new Error('The GeoIP archive did not contain one City database.');
    }

    await write;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

export async function verifyGeoDatabase(filePath, source = getGeoSource()) {
  const stat = await fs.stat(filePath);

  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_DATABASE_BYTES) {
    throw new Error('The GeoIP database has an invalid size.');
  }

  if ((await sha256File(filePath)) !== source.databaseSha256) {
    throw new Error('The GeoIP database does not match its reviewed SHA-256.');
  }

  const reader = await maxmind.open(filePath);

  if (reader.metadata.databaseType !== 'GeoLite2-City') {
    throw new Error('The GeoIP database is not a City database.');
  }
}

export async function buildGeoDatabase(
  env = process.env,
  directory = path.resolve('geo'),
  fetchSource = fetch,
) {
  const source = getGeoSource(env);
  await fs.mkdir(directory, { recursive: true });
  const stage = await fs.mkdtemp(path.join(directory, '.build-geo-'));
  const downloadPath = path.join(stage, 'download');
  const databasePath = path.join(stage, DATABASE_NAME);

  try {
    await downloadGeoSource(source, downloadPath, fetchSource);

    if (source.direct) {
      await fs.copyFile(downloadPath, databasePath);
    } else {
      await extractGeoArchive(downloadPath, databasePath);
    }

    await verifyGeoDatabase(databasePath, source);

    await fs.chmod(databasePath, 0o644);
    await fs.rename(databasePath, path.join(directory, DATABASE_NAME));
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
