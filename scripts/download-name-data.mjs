import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sources from './name-data-sources.json' with { type: 'json' };

const MAX_DOWNLOAD_BYTES = 128 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_LOCALE = /^[a-z]{2,3}_[A-Z]{2}$/;
const execFileAsync = promisify(execFile);

function getPinnedSource(kind, locale, manifest) {
  if (!['country', 'language'].includes(kind)) {
    throw new Error('Unsupported name-data kind.');
  }

  const entry = manifest[kind];
  const file = entry?.files?.[locale];

  if (!file) {
    return null;
  }

  if (
    !REVISION.test(entry.revision) ||
    !SOURCE_LOCALE.test(file.sourceLocale) ||
    !SHA256.test(file.sha256) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_DOWNLOAD_BYTES
  ) {
    throw new Error(`Invalid reviewed ${kind} source for ${locale}.`);
  }

  return {
    ...file,
    url: `https://raw.githubusercontent.com/umpirsky/${kind}-list/${entry.revision}/data/${file.sourceLocale}/${kind}.json`,
  };
}

function verifyNameData(bytes, source) {
  if (
    bytes.length !== source.size ||
    createHash('sha256').update(bytes).digest('hex') !== source.sha256
  ) {
    throw new Error('Name data does not match its reviewed digest and size.');
  }

  let data;

  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Name data is not valid JSON.');
  }

  if (
    !data ||
    Array.isArray(data) ||
    typeof data !== 'object' ||
    !Object.keys(data).length ||
    Object.entries(data).some(
      ([key, value]) =>
        !key ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        typeof value !== 'string' ||
        !value.trim(),
    )
  ) {
    throw new Error('Name data must be a flat map of nonempty strings.');
  }
}

export async function fetchPinnedNameData(source, fetchSource = fetch) {
  const response = await fetchSource(source.url, {
    redirect: 'manual',
    headers: { 'accept-encoding': 'identity' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`Reviewed name-data source returned HTTP ${response.status}.`);
  }

  const declaredLength = response.headers.get('content-length');

  if (
    (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== source.size)) ||
    ![null, 'identity'].includes(response.headers.get('content-encoding'))
  ) {
    await response.body.cancel();
    throw new Error('Reviewed name-data response has an invalid download envelope.');
  }

  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of response.body) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_DOWNLOAD_BYTES || totalBytes > source.size) {
      throw new Error('Reviewed name-data response exceeds its byte limit.');
    }

    chunks.push(Buffer.from(chunk));
  }

  const bytes = Buffer.concat(chunks);
  verifyNameData(bytes, source);
  return bytes;
}

async function getExistingFile(filename) {
  try {
    const stats = await fs.lstat(filename);

    if (!stats.isFile()) {
      throw new Error(`Name-data path is not a regular file: ${filename}`);
    }

    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function verifyCommittedNameData(root, kind, filename) {
  const relativePath = `public/intl/${kind}/${filename}`;
  const current = await fs.readFile(path.join(root, relativePath));
  let committed;

  try {
    ({ stdout: committed } = await execFileAsync(
      'git',
      ['-C', root, 'show', `HEAD:${relativePath}`],
      {
        encoding: 'buffer',
        maxBuffer: MAX_DOWNLOAD_BYTES,
      },
    ));
  } catch {
    throw new Error(`Existing ${kind} name data lacks a committed source: ${filename}`);
  }

  if (!current.equals(committed)) {
    throw new Error(`Existing ${kind} name data differs from committed source: ${filename}`);
  }

  if (current.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Existing ${kind} name data exceeds the byte limit: ${filename}`);
  }
}

export async function downloadNameData(kind, options = {}) {
  const { root = process.cwd(), manifest = sources, fetchSource = fetch } = options;
  const messageDirectory = path.join(root, 'public/intl/messages');
  const destinationDirectory = path.join(root, 'public/intl', kind);
  const messageFiles = await fs.readdir(messageDirectory, { withFileTypes: true });
  const downloaded = [];

  if (!['country', 'language'].includes(kind)) {
    throw new Error('Unsupported name-data kind.');
  }

  await fs.mkdir(destinationDirectory, { recursive: true });

  for (const entry of messageFiles.filter(file => file.name.endsWith('.json'))) {
    if (!entry.isFile()) {
      throw new Error(`Message path is not a regular file: ${entry.name}`);
    }

    const locale = path.basename(entry.name, '.json');
    const destination = path.join(destinationDirectory, entry.name);
    const source = getPinnedSource(kind, locale, manifest);

    if (await getExistingFile(destination)) {
      if (source) {
        verifyNameData(await fs.readFile(destination), source);
      } else {
        await verifyCommittedNameData(root, kind, entry.name);
      }

      continue;
    }

    if (!source) {
      throw new Error(`No reviewed ${kind} source for missing locale ${locale}.`);
    }

    const bytes = await fetchPinnedNameData(source, fetchSource);
    const temporary = path.join(destinationDirectory, `.${entry.name}.${randomUUID()}.tmp`);

    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await fs.chmod(temporary, 0o644);
      await fs.link(temporary, destination);
      downloaded.push(destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  return downloaded;
}
