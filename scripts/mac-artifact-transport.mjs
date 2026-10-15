import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';
import { verifyRuntimeArtifact } from './runtime-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxArchiveBytes = 1024 * 1024 * 1024;
const maxManifestBytes = 8 * 1024 * 1024;
const maxEntries = 100_000;
const nativeFileName = /(?:\.node|\.so(?:\.[0-9]+)*)$/;
const publicEnvironmentNames = new Set([
  'ALLOWED_FRAME_URLS',
  'API_URL',
  'BASE_PATH',
  'CLASSROOM_MODE',
  'CLIENT_IP_HEADER',
  'CLOUD_MODE',
  'CLOUD_URL',
  'COLLECT_API_ENDPOINT',
  'COLLECT_API_HOST',
  'CORS_MAX_AGE',
  'DEFAULT_CURRENCY',
  'DEFAULT_LOCALE',
  'DISABLE_PUBLIC_SHARES',
  'DISABLE_TELEMETRY',
  'ENABLE_TEST_CONSOLE',
  'ENABLE_UPDATE_CHECKS',
  'FAVICON_URL',
  'FORCE_SSL',
  'LINKS_URL',
  'MCP_ENABLED',
  'NEXT_TELEMETRY_DISABLED',
  'PIXELS_URL',
  'PRIVATE_MODE',
  'PUBLIC_URL',
  'TRACKER_SCRIPT_NAME',
  'TRACKER_SCRIPT_URL',
  'TRUST_CLIENT_INFO_PAYLOAD',
  'UMAMI_SELF_RECORD',
  'UMAMI_SELF_TRACK',
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function digestFile(filePath) {
  const file = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error('Transport input must be a single regular file.');
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return { sha256: hash.digest('hex'), size: metadata.size };
  } finally {
    await file.close();
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

export function validatePublicConfiguration(configuration, site, repository) {
  if (
    !configuration ||
    Array.isArray(configuration) ||
    Object.keys(configuration).sort().join(',') !== 'environment,repository,schema_version,site' ||
    configuration.schema_version !== 1 ||
    configuration.site !== site ||
    configuration.repository !== repository ||
    !/^[a-z0-9][a-z0-9.-]{2,100}$/.test(site) ||
    !/^anderson-webops\/[a-z0-9][a-z0-9.-]{2,100}$/.test(repository) ||
    !configuration.environment ||
    Array.isArray(configuration.environment)
  ) {
    throw new Error('The public build configuration has an invalid identity or shape.');
  }

  const environment = configuration.environment;
  for (const [name, value] of Object.entries(environment)) {
    if (
      !publicEnvironmentNames.has(name) ||
      typeof value !== 'string' ||
      value.length > 2048 ||
      hasControlCharacters(value)
    ) {
      throw new Error(`Unsafe or private build configuration field: ${name}`);
    }
  }

  if (
    environment.PUBLIC_URL !== `https://${site}` ||
    environment.DISABLE_TELEMETRY !== '1' ||
    environment.NEXT_TELEMETRY_DISABLED !== '1' ||
    environment.CLIENT_IP_HEADER !== 'x-real-ip'
  ) {
    throw new Error(
      'The public build configuration must retain its reviewed origin and privacy defaults.',
    );
  }

  for (const name of ['CLASSROOM_MODE', 'CLOUD_MODE', 'MCP_ENABLED', 'PRIVATE_MODE']) {
    if (environment[name] !== undefined && !['0', '1'].includes(environment[name])) {
      throw new Error(`The ${name} build flag must be 0 or 1.`);
    }
  }

  for (const [name, value] of Object.entries(environment)) {
    if (!name.endsWith('_URL') || !value || name === 'PUBLIC_URL') continue;
    if (value.startsWith('/')) continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`The ${name} build URL is invalid.`);
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    ) {
      throw new Error(`The ${name} build URL must be public HTTPS without credentials.`);
    }
  }

  return Buffer.from(`${JSON.stringify(canonicalJson(configuration))}\n`);
}

export function createUstarHeader(record) {
  const header = Buffer.alloc(512);
  const memberName = Buffer.from(record.path);
  let basename = memberName;
  let prefix = Buffer.alloc(0);
  if (memberName.length > 100) {
    for (let index = memberName.length - 1; index > 0; index -= 1) {
      if (memberName[index] !== 47) continue;
      const candidatePrefix = memberName.subarray(0, index);
      const candidateName = memberName.subarray(index + 1);
      if (candidatePrefix.length <= 155 && candidateName.length <= 100) {
        prefix = candidatePrefix;
        basename = candidateName;
        break;
      }
    }
  }
  if (
    basename.length > 100 ||
    prefix.length > 155 ||
    !/^[\x20-\x7e]+$/.test(record.path) ||
    record.path.includes('\\')
  ) {
    throw new Error(`Transport path cannot fit in portable USTAR: ${record.path}`);
  }

  const octal = (offset, width, value) => {
    const digits = value.toString(8).padStart(width - 1, '0');
    if (digits.length !== width - 1) throw new Error('Transport metadata exceeds USTAR limits.');
    header.write(`${digits}\0`, offset, width, 'ascii');
  };
  basename.copy(header, 0);
  prefix.copy(header, 345);
  octal(100, 8, record.mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, record.type === 'file' ? record.size : 0);
  octal(136, 12, 0);
  header.fill(32, 148, 156);
  header.write(record.type === 'directory' ? '5' : record.type === 'symlink' ? '2' : '0', 156);
  if (record.type === 'symlink') {
    const target = Buffer.from(record.target);
    if (target.length > 100) throw new Error('Transport link target exceeds USTAR limits.');
    target.copy(header, 157);
  }
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

async function readNativeIdentity(filePath, relativePath) {
  const file = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(20);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (
      bytesRead !== bytes.length ||
      bytes.toString('binary', 0, 4) !== '\x7fELF' ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== 183
    ) {
      throw new Error(`A native binding is not Linux ARM64 ELF64 little-endian: ${relativePath}`);
    }
  } finally {
    await file.close();
  }
}

export async function collectTransportRecords(root, manifest) {
  root = await fs.realpath(root);
  const names = [...Object.keys(manifest.entries), 'runtime-manifest.json'].sort();
  if (names.length > maxEntries)
    throw new Error('Transport entry count exceeds the reviewed limit.');
  if (new Set(names).size !== names.length) throw new Error('Transport inventory repeats a path.');
  const records = [];
  let expandedBytes = 0;

  for (const name of names) {
    const relative = path.posix.normalize(name);
    if (
      name === '.' ||
      name === '..' ||
      name.includes('\\') ||
      hasControlCharacters(name) ||
      relative !== name ||
      name.startsWith('/') ||
      name.startsWith('../')
    ) {
      throw new Error('Unsafe transport inventory path.');
    }
    const fullPath = path.join(root, name);
    const metadata = await fs.lstat(fullPath);
    const mode = metadata.mode & 0o7777;
    if ((!metadata.isSymbolicLink() && mode & 0o022) || mode & 0o7000) {
      throw new Error(`Transport path has writable or special permissions: ${name}`);
    }
    let record;
    if (metadata.isDirectory()) {
      record = { path: `runtime/${name}`, type: 'directory', mode };
    } else if (metadata.isSymbolicLink()) {
      const target = await fs.readlink(fullPath);
      if (
        path.isAbsolute(target) ||
        !isWithin(root, path.resolve(path.dirname(fullPath), target)) ||
        !isWithin(root, await fs.realpath(fullPath))
      ) {
        throw new Error(`Transport symlink escapes its runtime: ${name}`);
      }
      if (nativeFileName.test(name)) await readNativeIdentity(await fs.realpath(fullPath), name);
      record = { path: `runtime/${name}`, type: 'symlink', mode, target };
    } else if (metadata.isFile() && metadata.nlink === 1) {
      expandedBytes += metadata.size;
      if (expandedBytes > maxArchiveBytes) {
        throw new Error('Transport expanded payload exceeds the reviewed limit.');
      }
      const digest = await digestFile(fullPath);
      if (
        name !== 'runtime-manifest.json' &&
        (digest.size !== manifest.entries[name]?.size ||
          digest.sha256 !== manifest.entries[name]?.sha256)
      ) {
        throw new Error(`Transport source changed after runtime verification: ${name}`);
      }
      if (nativeFileName.test(name)) await readNativeIdentity(fullPath, name);
      record = { path: `runtime/${name}`, type: 'file', mode, ...digest };
    } else {
      throw new Error(`Unsupported transport member: ${name}`);
    }
    createUstarHeader(record);
    records.push(record);
  }

  return records;
}

async function* archiveBlocks(root, records) {
  for (const record of records) {
    yield createUstarHeader(record);
    if (record.type !== 'file') continue;
    const relative = record.path.slice('runtime/'.length);
    const fullPath = path.join(root, relative);
    const metadata = await fs.lstat(fullPath);
    const file = await fs.open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        opened.size !== record.size
      ) {
        throw new Error(`Transport source changed during archive creation: ${relative}`);
      }
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let remaining = record.size;
      while (remaining > 0) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remaining), null);
        if (bytesRead === 0) throw new Error(`Transport source truncated: ${relative}`);
        const chunk = Buffer.from(buffer.subarray(0, bytesRead));
        hash.update(chunk);
        yield chunk;
        remaining -= bytesRead;
      }
      if (hash.digest('hex') !== record.sha256 || (await file.stat()).size !== record.size) {
        throw new Error(`Transport source changed while archived: ${relative}`);
      }
    } finally {
      await file.close();
    }
    const padding = (512 - (record.size % 512)) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

export async function writeTransportArchive(root, records, archivePath) {
  await pipeline(
    Readable.from(archiveBlocks(root, records)),
    createGzip({ level: 9, mtime: 0 }),
    createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
  );
  const archive = await digestFile(archivePath);
  if (archive.size > maxArchiveBytes)
    throw new Error('Transport archive exceeds the reviewed limit.');
  return archive;
}

function parseOctal(bytes) {
  const text = bytes.toString('ascii').replace(/\0+$/, '');
  if (!/^[0-7]+$/.test(text)) throw new Error('Transport USTAR metadata is invalid.');
  return Number.parseInt(text, 8);
}

function parseUstarHeader(header) {
  const checksumBytes = Buffer.from(header);
  checksumBytes.fill(32, 148, 156);
  const checksum = checksumBytes.reduce((total, byte) => total + byte, 0);
  const basename = header.toString('utf8', 0, 100).split('\0')[0];
  const prefix = header.toString('utf8', 345, 500).split('\0')[0];
  const type = { 0: 'file', 5: 'directory', 2: 'symlink' }[header.toString('ascii', 156, 157)];
  if (
    header.toString('ascii', 257, 263) !== 'ustar\0' ||
    header.toString('ascii', 263, 265) !== '00' ||
    parseOctal(header.subarray(148, 155)) !== checksum ||
    parseOctal(header.subarray(108, 116)) !== 0 ||
    parseOctal(header.subarray(116, 124)) !== 0 ||
    parseOctal(header.subarray(136, 148)) !== 0 ||
    !type
  ) {
    throw new Error('Transport contains an unsupported or corrupted USTAR header.');
  }
  return {
    path: prefix ? `${prefix}/${basename}` : basename,
    type,
    mode: parseOctal(header.subarray(100, 108)),
    size: parseOctal(header.subarray(124, 136)),
    ...(type === 'symlink' ? { target: header.toString('utf8', 157, 257).split('\0')[0] } : {}),
  };
}

export async function verifyTransportArchive(archivePath, records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > maxEntries) {
    throw new Error('The transport inventory is empty or exceeds its entry limit.');
  }
  const archiveMetadata = await fs.lstat(archivePath);
  if (
    !archiveMetadata.isFile() ||
    archiveMetadata.nlink !== 1 ||
    archiveMetadata.size > maxArchiveBytes
  ) {
    throw new Error('Transport archive is not a bounded regular file.');
  }
  const stream = createReadStream(archivePath).pipe(createGunzip());
  const iterator = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let expandedBytes = 0;
  const readExact = async length => {
    const pieces = [];
    let received = 0;
    while (received < length) {
      if (pending.length === 0) {
        const next = await iterator.next();
        if (next.done) throw new Error('The transport archive was truncated.');
        pending = next.value;
      }
      const count = Math.min(length - received, pending.length);
      pieces.push(pending.subarray(0, count));
      pending = pending.subarray(count);
      received += count;
    }
    return Buffer.concat(pieces, length);
  };
  let embeddedManifestBytes;
  const seen = new Set();

  for (const expected of records) {
    if (
      typeof expected.path !== 'string' ||
      !expected.path.startsWith('runtime/') ||
      expected.path === 'runtime/' ||
      expected.path.includes('\\') ||
      path.posix.normalize(expected.path) !== expected.path ||
      seen.has(expected.path)
    ) {
      throw new Error('Unsafe or repeated transport inventory path.');
    }
    seen.add(expected.path);
    const header = await readExact(512);
    if (!header.equals(createUstarHeader(expected))) {
      throw new Error(`Transport archive header is not canonical: ${expected.path}`);
    }
    const actual = parseUstarHeader(header);
    if (
      actual.path !== expected.path ||
      actual.type !== expected.type ||
      actual.mode !== expected.mode ||
      actual.size !== (expected.type === 'file' ? expected.size : 0) ||
      (expected.type === 'symlink' && actual.target !== expected.target)
    ) {
      throw new Error(`Transport archive member differs from its manifest: ${expected.path}`);
    }
    if (expected.type === 'symlink') {
      const resolved = path.posix.resolve(path.posix.dirname(`/${expected.path}`), expected.target);
      if (path.posix.isAbsolute(expected.target) || !isWithin('/runtime', resolved)) {
        throw new Error('Transport symlink escapes its runtime.');
      }
    }
    if (expected.type !== 'file') continue;
    if (
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0 ||
      expandedBytes + expected.size > maxArchiveBytes
    ) {
      throw new Error('Transport expanded payload exceeds the reviewed limit.');
    }
    expandedBytes += expected.size;
    const hash = crypto.createHash('sha256');
    let remaining = expected.size;
    const nativeHead = Buffer.alloc(20);
    let nativeBytes = 0;
    const manifestChunks = [];
    if (expected.path === 'runtime/runtime-manifest.json' && expected.size > 64 * 1024 * 1024) {
      throw new Error('Embedded runtime manifest exceeds its limit.');
    }
    while (remaining > 0) {
      const chunk = await readExact(Math.min(remaining, 64 * 1024));
      hash.update(chunk);
      if (nativeFileName.test(expected.path) && nativeBytes < nativeHead.length) {
        const count = Math.min(chunk.length, nativeHead.length - nativeBytes);
        chunk.copy(nativeHead, nativeBytes, 0, count);
        nativeBytes += count;
      }
      if (expected.path === 'runtime/runtime-manifest.json') manifestChunks.push(chunk);
      remaining -= chunk.length;
    }
    if (hash.digest('hex') !== expected.sha256) {
      throw new Error(`Transport archive file hash differs: ${expected.path}`);
    }
    if (
      nativeFileName.test(expected.path) &&
      (nativeBytes !== 20 ||
        nativeHead.toString('binary', 0, 4) !== '\x7fELF' ||
        nativeHead[4] !== 2 ||
        nativeHead[5] !== 1 ||
        nativeHead.readUInt16LE(18) !== 183)
    ) {
      throw new Error(
        `Transport native binding is not Linux ARM64 ELF64 little-endian: ${expected.path}`,
      );
    }
    if (manifestChunks.length) embeddedManifestBytes = Buffer.concat(manifestChunks);
    const padding = (512 - (expected.size % 512)) % 512;
    if (padding && !(await readExact(padding)).equals(Buffer.alloc(padding))) {
      throw new Error('Transport archive has nonzero file padding.');
    }
  }
  if (!(await readExact(1024)).equals(Buffer.alloc(1024)) || pending.length) {
    throw new Error('Transport archive has an invalid end marker.');
  }
  if (!(await iterator.next()).done) throw new Error('Transport archive has unlisted members.');
  if (!embeddedManifestBytes) throw new Error('Transport archive lacks its runtime manifest.');
  return JSON.parse(embeddedManifestBytes.toString());
}

export function verifyEmbeddedRuntime(transport, embedded, trustedContract) {
  const expectedApplicationId = transport.repository.split('/')[1];
  if (
    embedded?.format !== 1 ||
    embedded?.artifact !== 'umami-direct-runtime' ||
    embedded.source?.commit !== transport.commit ||
    embedded.source?.version !== transport.version ||
    embedded.source?.dirty !== false ||
    embedded.contractSha256 !== transport.runtime_contract_sha256 ||
    embedded.deployment?.applicationId !== expectedApplicationId ||
    embedded.runtime?.os !== 'linux' ||
    embedded.runtime?.arch !== 'arm64' ||
    embedded.runtime?.libc !== 'glibc' ||
    embedded.runtime?.node !== '24.18.1' ||
    !embedded.entries ||
    typeof embedded.entries !== 'object' ||
    Object.keys(embedded.entries).length + 1 !== transport.files.length
  ) {
    throw new Error('Embedded runtime identity is inconsistent with its signed transport.');
  }
  const records = new Map(transport.files.map(record => [record.path, record]));
  for (const [relative, entry] of Object.entries(embedded.entries)) {
    const record = records.get(`runtime/${relative}`);
    if (
      !record ||
      entry.type !== record.type ||
      (entry.type !== 'symlink' && Number.parseInt(entry.mode, 8) !== record.mode) ||
      (entry.type === 'file' && (entry.size !== record.size || entry.sha256 !== record.sha256)) ||
      (entry.type === 'symlink' && entry.target !== record.target)
    ) {
      throw new Error(`Embedded runtime inventory differs from transport: ${relative}`);
    }
  }
  for (const required of trustedContract.requiredFiles) {
    if (!records.has(`runtime/${required}`)) {
      throw new Error(`Signed runtime lacks a required contract path: ${required}`);
    }
  }
  if (!records.has('runtime/runtime-manifest.json')) {
    throw new Error('Signed runtime lacks its embedded manifest.');
  }
}

function gitValue(args, sourceRoot) {
  return execFileSync('git', args, {
    cwd: sourceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export async function prepareTransport({
  sourceRoot,
  runtimeRoot,
  configPath,
  outputDir,
  builderId,
  tag,
  receiptPath,
}) {
  sourceRoot = await fs.realpath(sourceRoot);
  runtimeRoot = await fs.realpath(runtimeRoot);
  if (sourceRoot !== repositoryRoot) {
    throw new Error('Transport packaging must run from the reviewed source checkout.');
  }
  if (!/^[a-z0-9-]{1,64}$/.test(builderId) || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) {
    throw new Error('The builder ID or semantic release tag is invalid.');
  }
  const commit = gitValue(['rev-parse', 'HEAD'], sourceRoot);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  if (
    !/^[0-9a-f]{40}$/.test(commit) ||
    gitValue(['cat-file', '-t', `refs/tags/${tag}`], sourceRoot) !== 'tag' ||
    gitValue(['rev-parse', `${tag}^{commit}`], sourceRoot) !== commit ||
    gitValue(['status', '--porcelain'], sourceRoot)
  ) {
    throw new Error('Transport source must be a clean checkout of its annotated release tag.');
  }
  if (
    process.platform !== 'linux' ||
    process.arch !== 'arm64' ||
    !process.report.getReport().header.glibcVersionRuntime ||
    process.versions.node !== '24.18.1' ||
    execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim() !== '12.0.2' ||
    execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim() !== '11.18.0'
  ) {
    throw new Error('Transport packaging requires the exact reviewed Linux ARM64 toolchain.');
  }
  if (
    receipt?.commit !== commit ||
    receipt?.tag !== tag ||
    Object.keys(receipt).sort().join(',') !== 'checks,commit,tag' ||
    Object.keys(receipt.checks ?? {})
      .sort()
      .join(',') !== 'dependency_audit,native_bindings,package_signatures,tests' ||
    Object.values(receipt.checks).some(value => value !== true)
  ) {
    throw new Error('The release check receipt is missing or incomplete.');
  }

  const configuration = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const { site, repository } = configuration;
  const publicConfiguration = validatePublicConfiguration(configuration, site, repository);
  const applicationId = repository.split('/')[1];
  const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const runtimeManifest = await verifyRuntimeArtifact(runtimeRoot, {
    release: true,
    expectedCommit: commit,
    expectedApplicationId: applicationId,
  });
  if (
    tag !== `v${packageJson.version}` ||
    runtimeManifest.source.version !== packageJson.version ||
    runtimeManifest.runtime.os !== 'linux' ||
    runtimeManifest.runtime.arch !== 'arm64' ||
    runtimeManifest.runtime.libc !== 'glibc' ||
    runtimeManifest.runtime.node !== '24.18.1'
  ) {
    throw new Error(
      'Transport source, version, runtime, and deployment contract are inconsistent.',
    );
  }

  const records = await collectTransportRecords(runtimeRoot, runtimeManifest);
  await fs.mkdir(outputDir, { recursive: false, mode: 0o700 });
  const archiveName = `${site}-${tag}-linux-arm64-runtime.tar.gz`;
  const archivePath = path.join(outputDir, archiveName);
  const archive = await writeTransportArchive(runtimeRoot, records, archivePath);
  const packedRuntime = await verifyTransportArchive(archivePath, records);
  if (
    packedRuntime.source?.commit !== commit ||
    packedRuntime.contractSha256 !== runtimeManifest.contractSha256
  ) {
    throw new Error('Packed runtime identity changed during transport preparation.');
  }
  await verifyRuntimeArtifact(runtimeRoot, {
    release: true,
    expectedCommit: commit,
    expectedApplicationId: applicationId,
  });

  const transport = {
    schema_version: 1,
    site,
    repository,
    builder_id: builderId,
    commit,
    version: packageJson.version,
    tag,
    source_clean: true,
    runtime: {
      os: 'linux',
      architecture: 'arm64',
      libc: 'glibc',
      node: '24.18.1',
      npm: '12.0.2',
      package_manager: 'pnpm@11.18.0',
    },
    configuration_sha256: sha256(publicConfiguration),
    runtime_contract_sha256: runtimeManifest.contractSha256,
    checks: receipt.checks,
    archive: { name: archiveName, ...archive },
    files: records,
  };
  const transportBytes = Buffer.from(`${JSON.stringify(transport)}\n`);
  if (transportBytes.length > maxManifestBytes) {
    throw new Error('Transport manifest exceeds the reviewed limit.');
  }
  await fs.writeFile(path.join(outputDir, 'anderson-runtime-manifest.json'), transportBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  await fs.writeFile(path.join(outputDir, 'public-build-configuration.json'), publicConfiguration, {
    flag: 'wx',
    mode: 0o600,
  });
  await fs.copyFile(
    receiptPath,
    path.join(outputDir, 'acceptance-receipt.json'),
    fsConstants.COPYFILE_EXCL,
  );
  return transport;
}

export async function signTransport(outputDir, privateKeyPath) {
  if (process.platform !== 'darwin')
    throw new Error('The private builder key must remain on the Mac.');
  const keyMetadata = await fs.lstat(privateKeyPath);
  const parentMetadata = await fs.lstat(path.dirname(privateKeyPath));
  const approvedSigningDirectory = process.env.ANDERSON_BUILDER_SIGNING_DIR;
  const disk = execFileSync('df', ['-P', privateKeyPath], { encoding: 'utf8' })
    .trim()
    .split('\n')[1]
    ?.split(/\s+/)[0];
  if (!disk?.startsWith('/dev/')) throw new Error('The signing key has no verified local disk.');
  const diskInfo = execFileSync('diskutil', ['info', '-plist', disk]);
  const encrypted = execFileSync('plutil', ['-extract', 'Encryption', 'raw', '-o', '-', '-'], {
    input: diskInfo,
    encoding: 'utf8',
  }).trim();
  if (
    encrypted !== 'true' ||
    !keyMetadata.isFile() ||
    keyMetadata.nlink !== 1 ||
    keyMetadata.uid !== process.getuid() ||
    (keyMetadata.mode & 0o777) !== 0o600 ||
    !parentMetadata.isDirectory() ||
    parentMetadata.uid !== process.getuid() ||
    (parentMetadata.mode & 0o077) !== 0 ||
    !approvedSigningDirectory ||
    (await fs.realpath(path.dirname(privateKeyPath))) !==
      (await fs.realpath(approvedSigningDirectory)) ||
    isWithin(repositoryRoot, await fs.realpath(privateKeyPath)) ||
    isWithin(outputDir, await fs.realpath(privateKeyPath)) ||
    (process.env.ANDERSON_BUILDER_EXCHANGE &&
      isWithin(
        await fs.realpath(process.env.ANDERSON_BUILDER_EXCHANGE),
        await fs.realpath(privateKeyPath),
      ))
  ) {
    throw new Error('The signing key must be a private Mac-owned file outside the repository.');
  }
  const manifestPath = path.join(outputDir, 'anderson-runtime-manifest.json');
  const manifestBytes = await fs.readFile(manifestPath);
  if (manifestBytes.length > maxManifestBytes)
    throw new Error('Transport manifest exceeds its limit.');
  const manifest = JSON.parse(manifestBytes.toString());
  const publicConfiguration = await fs.readFile(
    path.join(outputDir, 'public-build-configuration.json'),
  );
  const receipt = JSON.parse(
    await fs.readFile(path.join(outputDir, 'acceptance-receipt.json'), 'utf8'),
  );
  const sourceCommit = gitValue(['rev-parse', 'HEAD'], repositoryRoot);
  if (
    manifest.commit !== sourceCommit ||
    gitValue(['cat-file', '-t', `refs/tags/${manifest.tag}`], repositoryRoot) !== 'tag' ||
    gitValue(['rev-parse', `${manifest.tag}^{commit}`], repositoryRoot) !== sourceCommit ||
    gitValue(['status', '--porcelain'], repositoryRoot) ||
    !publicConfiguration.equals(
      validatePublicConfiguration(
        JSON.parse(publicConfiguration.toString()),
        manifest.site,
        manifest.repository,
      ),
    ) ||
    manifest.configuration_sha256 !== sha256(publicConfiguration) ||
    receipt.commit !== manifest.commit ||
    receipt.tag !== manifest.tag ||
    JSON.stringify(receipt.checks) !== JSON.stringify(manifest.checks) ||
    manifest.runtime_contract_sha256 !==
      (await digestFile(path.join(repositoryRoot, 'deploy/runtime-artifact.json'))).sha256
  ) {
    throw new Error(
      'Transport manifest does not match clean reviewed Mac source and configuration.',
    );
  }
  const archivePath = path.join(outputDir, manifest.archive.name);
  const archive = await digestFile(archivePath);
  if (archive.size !== manifest.archive.size || archive.sha256 !== manifest.archive.sha256) {
    throw new Error('The archive changed before transport signing.');
  }
  const trustedContract = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, 'deploy/runtime-artifact.json'), 'utf8'),
  );
  const embedded = await verifyTransportArchive(archivePath, manifest.files);
  verifyEmbeddedRuntime(manifest, embedded, trustedContract);
  const privateKey = crypto.createPrivateKey(await fs.readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('The builder key must be Ed25519.');
  const signature = crypto.sign(null, manifestBytes, privateKey);
  if (
    signature.length !== 64 ||
    !crypto.verify(null, manifestBytes, crypto.createPublicKey(privateKey), signature)
  ) {
    throw new Error('The detached manifest signature could not be verified.');
  }
  const signaturePath = path.join(outputDir, 'anderson-runtime-manifest.sig');
  await fs.writeFile(signaturePath, signature, { flag: 'wx', mode: 0o600 });
  const names = [
    manifest.archive.name,
    'anderson-runtime-manifest.json',
    'anderson-runtime-manifest.sig',
    'public-build-configuration.json',
    'acceptance-receipt.json',
  ];
  const checksums = [];
  for (const name of names.sort()) {
    checksums.push(`${(await digestFile(path.join(outputDir, name))).sha256}  ${name}`);
  }
  await fs.writeFile(path.join(outputDir, 'SHA256SUMS'), `${checksums.join('\n')}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { manifestSha256: sha256(manifestBytes), archive };
}

export async function verifySignedTransport(outputDir, publicKeyPath) {
  const manifestBytes = await fs.readFile(path.join(outputDir, 'anderson-runtime-manifest.json'));
  const signature = await fs.readFile(path.join(outputDir, 'anderson-runtime-manifest.sig'));
  if (manifestBytes.length > maxManifestBytes || signature.length !== 64) {
    throw new Error('Signed transport metadata exceeds its reviewed limits.');
  }
  const publicKey = crypto.createPublicKey(await fs.readFile(publicKeyPath));
  if (
    publicKey.asymmetricKeyType !== 'ed25519' ||
    !crypto.verify(null, manifestBytes, publicKey, signature)
  ) {
    throw new Error('The detached transport signature is invalid.');
  }
  const manifest = JSON.parse(manifestBytes.toString());
  const configurationBytes = await fs.readFile(
    path.join(outputDir, 'public-build-configuration.json'),
  );
  const configuration = JSON.parse(configurationBytes.toString());
  if (
    manifest.schema_version !== 1 ||
    manifest.commit !== gitValue(['rev-parse', 'HEAD'], repositoryRoot) ||
    manifest.configuration_sha256 !== sha256(configurationBytes) ||
    !configurationBytes.equals(
      validatePublicConfiguration(configuration, manifest.site, manifest.repository),
    ) ||
    manifest.runtime_contract_sha256 !==
      (await digestFile(path.join(repositoryRoot, 'deploy/runtime-artifact.json'))).sha256
  ) {
    throw new Error('Signed transport source, contract, or public configuration differs.');
  }
  const archivePath = path.join(outputDir, manifest.archive.name);
  const archive = await digestFile(archivePath);
  if (archive.sha256 !== manifest.archive.sha256 || archive.size !== manifest.archive.size) {
    throw new Error('Signed transport archive differs from its manifest.');
  }
  const embedded = await verifyTransportArchive(archivePath, manifest.files);
  const trustedContract = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, 'deploy/runtime-artifact.json'), 'utf8'),
  );
  verifyEmbeddedRuntime(manifest, embedded, trustedContract);
  const names = [
    manifest.archive.name,
    'anderson-runtime-manifest.json',
    'anderson-runtime-manifest.sig',
    'public-build-configuration.json',
    'acceptance-receipt.json',
  ].sort();
  const checksums = [];
  for (const name of names) {
    checksums.push(`${(await digestFile(path.join(outputDir, name))).sha256}  ${name}`);
  }
  if (
    (await fs.readFile(path.join(outputDir, 'SHA256SUMS'), 'utf8')) !== `${checksums.join('\n')}\n`
  ) {
    throw new Error('Signed transport checksums differ from exact asset bytes.');
  }
  return manifest;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1]) {
      throw new Error('Transport options must be named key-value pairs.');
    }
    options.set(args[index].slice(2), args[index + 1]);
  }
  if (command === 'prepare') {
    const result = await prepareTransport({
      sourceRoot: repositoryRoot,
      runtimeRoot: options.get('runtime'),
      configPath: options.get('config'),
      outputDir: options.get('output'),
      builderId: options.get('builder-id'),
      tag: options.get('tag'),
      receiptPath: options.get('receipt'),
    });
    process.stdout.write(`Prepared unsigned ${result.site} transport at ${result.commit}.\n`);
  } else if (command === 'sign') {
    await signTransport(options.get('output'), options.get('key'));
    process.stdout.write('Signed and checksummed the exact transport bytes.\n');
  } else if (command === 'verify') {
    const manifest = await verifySignedTransport(options.get('output'), options.get('public-key'));
    process.stdout.write(`Verified signed ${manifest.site} transport at ${manifest.commit}.\n`);
  } else {
    throw new Error(
      'Usage: mac-artifact-transport.mjs prepare --runtime ROOT --config FILE --receipt FILE --output DIR --builder-id ID --tag TAG | sign --output DIR --key FILE | verify --output DIR --public-key FILE',
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
