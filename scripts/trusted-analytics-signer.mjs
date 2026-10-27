import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  validatePublicConfiguration,
  verifyEmbeddedRuntime,
  verifyTransportArchive,
} from './mac-artifact-transport.mjs';

export const builderFingerprint =
  '9312fb21bf79162b8bf481d22190fe8e7352be8d80ceae99ad435faa1249f316';
const scopes = new Map([
  ['analytics.example.com', 'anderson-webops/analytics-umami-template'],
  ...[
    'analytics.np-servicerequest.org',
    'analytics.mariettaviolinwithcarla.com',
    'analytics.retrozetrocomics.com',
    'analytics.jacobdanderson.net',
  ].map(site => [site, `anderson-webops/${site}`]),
]);
const installedRoot = path.join(
  os.homedir(),
  'Library/Application Support/AndersonArtifactBuilder/analytics-v1',
);
const builderRoot = path.dirname(installedRoot);
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const metadataLimit = 8 * 1024 * 1024;
const checks = ['dependency_audit', 'native_bindings', 'package_signatures', 'tests'];

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  );
}

export function validateAnalyticsApproval(approval, source, acceptance, contractBytes) {
  if (
    !exactKeys(approval, [
      'schemaVersion',
      'site',
      'repository',
      'builderId',
      'commit',
      'tree',
      'tag',
      'sourceSha256',
      'contractSha256',
      'acceptanceSha256',
      'assets',
      'productionActivationAuthorized',
    ]) ||
    approval.schemaVersion !== 1 ||
    !scopes.has(approval.site) ||
    scopes.get(approval.site) !== approval.repository ||
    approval.builderId !== 'jacob-m3' ||
    !commitPattern.test(approval.commit) ||
    !commitPattern.test(approval.tree) ||
    !/^v4\.\d+\.\d+$/.test(approval.tag) ||
    approval.productionActivationAuthorized !== false ||
    ['sourceSha256', 'contractSha256', 'acceptanceSha256'].some(
      name => !digestPattern.test(approval[name]),
    ) ||
    digest(contractBytes) !== approval.contractSha256
  ) {
    throw new Error('Analytics signing approval has an unsupported scope or identity.');
  }
  if (
    source.repository !== approval.repository ||
    source.commit !== approval.commit ||
    source.tree !== approval.tree ||
    source.mainCommit !== approval.commit ||
    source.tag !== approval.tag ||
    source.tagCommit !== approval.commit ||
    source.tagType !== 'tag' ||
    !commitPattern.test(source.tagObject) ||
    source.worktreeClean !== true ||
    source.packageVersion !== approval.tag.slice(1)
  ) {
    throw new Error('Analytics source identity differs from its independent approval.');
  }
  if (
    acceptance.commit !== approval.commit ||
    acceptance.tag !== approval.tag ||
    acceptance.target !== 'linux-arm64-glibc' ||
    acceptance.productionActivated !== false ||
    ![
      'freshVmDestroyed',
      'hostExchangeRestricted',
      'isolatedUnpackedAcceptance',
      'inventoryVerified',
      'requiredModulesVerified',
      'missingModuleRejected',
      'postgresRestoreVerified',
      'sourceChecksPassed',
      'registrySignaturesVerified',
      'noProviderEffects',
    ].every(name => acceptance[name] === true)
  ) {
    throw new Error('Analytics exact-artifact or disposable isolation acceptance is missing.');
  }
  const names = [
    `${approval.site}-${approval.tag}-linux-arm64-runtime.tar.gz`,
    'anderson-runtime-manifest.json',
    'public-build-configuration.json',
    'acceptance-receipt.json',
  ];
  if (!exactKeys(approval.assets, names)) throw new Error('Unexpected analytics asset set.');
  for (const [name, record] of Object.entries(approval.assets)) {
    if (
      !exactKeys(record, ['size', 'sha256']) ||
      !digestPattern.test(record.sha256) ||
      !Number.isSafeInteger(record.size) ||
      record.size < 1 ||
      record.size > (name.endsWith('.tar.gz') ? 1024 * 1024 * 1024 : metadataLimit)
    ) {
      throw new Error('Analytics approval contains unbounded asset metadata.');
    }
  }
}

export function validateAnalyticsManifest(
  manifest,
  approval,
  receipt,
  configurationBytes,
  contractBytes,
) {
  const runtime = {
    os: 'linux',
    architecture: 'arm64',
    libc: 'glibc',
    node: '24.18.1',
    npm: '12.0.2',
    package_manager: 'pnpm@11.18.0',
  };
  if (
    !exactKeys(manifest, [
      'schema_version',
      'site',
      'repository',
      'builder_id',
      'commit',
      'version',
      'tag',
      'source_clean',
      'runtime',
      'configuration_sha256',
      'runtime_contract_sha256',
      'checks',
      'archive',
      'files',
    ]) ||
    manifest.schema_version !== 1 ||
    manifest.site !== approval.site ||
    manifest.repository !== approval.repository ||
    manifest.builder_id !== approval.builderId ||
    manifest.commit !== approval.commit ||
    manifest.tag !== approval.tag ||
    manifest.version !== approval.tag.slice(1) ||
    manifest.source_clean !== true ||
    !isDeepStrictEqual(manifest.runtime, runtime) ||
    manifest.runtime_contract_sha256 !== digest(contractBytes) ||
    manifest.configuration_sha256 !== digest(configurationBytes) ||
    !exactKeys(manifest.checks, checks) ||
    !checks.every(name => manifest.checks[name] === true) ||
    !exactKeys(receipt, ['commit', 'tag', 'checks']) ||
    receipt.commit !== approval.commit ||
    receipt.tag !== approval.tag ||
    !isDeepStrictEqual(receipt.checks, manifest.checks) ||
    !exactKeys(manifest.archive, ['name', 'size', 'sha256']) ||
    manifest.archive.name !== `${approval.site}-${approval.tag}-linux-arm64-runtime.tar.gz` ||
    !isDeepStrictEqual(approval.assets[manifest.archive.name], {
      size: manifest.archive.size,
      sha256: manifest.archive.sha256,
    })
  ) {
    throw new Error('Analytics envelope differs from the approved source, runtime or acceptance.');
  }
  const canonical = validatePublicConfiguration(
    JSON.parse(configurationBytes),
    approval.site,
    approval.repository,
  );
  if (!canonical.equals(configurationBytes))
    throw new Error('Analytics public configuration is not canonical.');
}

export function validateSignerEnvironment(environment, uid) {
  const allowed = new Set([
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'TMPDIR',
    'LANG',
    'TZ',
    '__CF_USER_TEXT_ENCODING',
  ]);
  if (Object.keys(environment).some(name => !allowed.has(name))) {
    throw new Error('Trusted analytics signing requires a fresh credential-free environment.');
  }
  const encoding = environment.__CF_USER_TEXT_ENCODING;
  if (
    encoding !== undefined &&
    (!/^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/i.test(encoding) ||
      Number.parseInt(encoding.split(':')[0], 16) !== uid)
  ) {
    throw new Error('Unexpected macOS text-encoding identity.');
  }
}

export function signManifestBytes(
  manifestBytes,
  privateBytes,
  publicKey,
  fingerprint = builderFingerprint,
) {
  try {
    const key = crypto.createPrivateKey(privateBytes);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      publicKey.asymmetricKeyType !== 'ed25519' ||
      digest(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })) !== fingerprint ||
      digest(publicKey.export({ type: 'spki', format: 'der' })) !== fingerprint
    ) {
      throw new Error('Analytics builder private-key identity differs.');
    }
    const signature = crypto.sign(null, manifestBytes, key);
    if (signature.length !== 64 || !crypto.verify(null, manifestBytes, publicKey, signature)) {
      throw new Error('Analytics detached signature verification failed.');
    }
    return signature;
  } finally {
    privateBytes.fill(0);
  }
}

async function secureDirectory(directory) {
  const metadata = await fs.lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw new Error('Trusted analytics directory is not protected.');
  }
}

async function ownedBytes(filePath, maximum = metadataLimit, privateMode = true) {
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid() ||
      metadata.size > maximum ||
      (privateMode && (metadata.mode & 0o777) !== 0o600)
    ) {
      throw new Error('Trusted analytics input is not a bounded owner-only file.');
    }
    const bytes = await file.readFile();
    if (bytes.length !== metadata.size) throw new Error('Trusted analytics input changed.');
    return bytes;
  } finally {
    await file.close();
  }
}

export async function copyApprovedAsset(sourcePath, destinationPath, expected) {
  if (
    !exactKeys(expected, ['size', 'sha256']) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1 ||
    expected.size > 1024 * 1024 * 1024 ||
    !digestPattern.test(expected.sha256)
  ) {
    throw new Error('Invalid approved analytics asset metadata.');
  }
  const input = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== expected.size ||
      (before.mode & 0o022) !== 0
    )
      throw new Error('Unsafe analytics intake asset.');
    output = await fs.open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.alloc(64 * 1024);
    const copiedHash = crypto.createHash('sha256');
    let position = 0;
    while (position < expected.size) {
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, expected.size - position),
        position,
      );
      if (!bytesRead) throw new Error('Analytics intake asset was truncated.');
      copiedHash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await output.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (!bytesWritten) throw new Error('Analytics intake could not be written.');
        written += bytesWritten;
      }
      position += bytesRead;
    }
    const after = await input.stat();
    if (
      (await input.read(buffer, 0, 1, position)).bytesRead ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      copiedHash.digest('hex') !== expected.sha256
    )
      throw new Error('Analytics intake changed or differs from approval.');
    await output.sync();
  } finally {
    await output?.close();
    await input.close();
  }
}

async function verifyInstallation() {
  if (
    path.dirname(fileURLToPath(import.meta.url)) !== installedRoot ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    process.version !== 'v24.22.1' ||
    process.execArgv.length
  ) {
    throw new Error('Use the reviewed installed Mac analytics signer.');
  }
  validateSignerEnvironment(process.env, process.getuid());
  await secureDirectory(builderRoot);
  await secureDirectory(installedRoot);
  const installed = JSON.parse(await ownedBytes(path.join(installedRoot, 'installation.json')));
  const files = [
    'trusted-analytics-signer.mjs',
    'mac-artifact-transport.mjs',
    'runtime-artifact.mjs',
  ];
  if (
    !exactKeys(installed, ['schemaVersion', 'files']) ||
    installed.schemaVersion !== 1 ||
    !exactKeys(installed.files, files)
  )
    throw new Error('Analytics signer installation inventory is incomplete.');
  for (const [name, expected] of Object.entries(installed.files)) {
    if (
      !digestPattern.test(expected) ||
      digest(await ownedBytes(path.join(installedRoot, name))) !== expected
    ) {
      throw new Error('Analytics signer installation changed.');
    }
  }
}

async function checkedPublicKey() {
  const publicPath = path.join(builderRoot, 'public-key.pem');
  const disk = execFileSync('/bin/df', ['-P', publicPath], { encoding: 'utf8' })
    .trim()
    .split('\n')[1]
    ?.split(/\s+/)[0];
  if (!disk?.startsWith('/dev/')) throw new Error('Analytics key volume is unavailable.');
  const info = execFileSync('/usr/sbin/diskutil', ['info', '-plist', disk]);
  const encrypted = execFileSync(
    '/usr/bin/plutil',
    ['-extract', 'Encryption', 'raw', '-o', '-', '-'],
    {
      input: info,
      encoding: 'utf8',
    },
  ).trim();
  if (encrypted !== 'true')
    throw new Error('Analytics signing key requires the approved encrypted Mac volume.');
  const key = crypto.createPublicKey(await ownedBytes(publicPath, 4096, false));
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    digest(key.export({ type: 'spki', format: 'der' })) !== builderFingerprint
  ) {
    throw new Error('Analytics builder public-key identity differs.');
  }
  return key;
}

async function signAnalytics(inputDirectory, approvalName) {
  await verifyInstallation();
  if (!/^[a-z0-9.-]+-[a-f0-9]{40}\.json$/.test(approvalName))
    throw new Error('Invalid analytics approval name.');
  const approvals = path.join(installedRoot, 'approvals');
  await secureDirectory(approvals);
  const approval = JSON.parse(await ownedBytes(path.join(approvals, approvalName)));
  if (approvalName !== `${approval.site}-${approval.commit}.json`)
    throw new Error('Analytics approval identity differs.');
  const prefix = path.join(approvals, approvalName.slice(0, -5));
  const sourceBytes = await ownedBytes(`${prefix}.source.json`);
  const contractBytes = await ownedBytes(`${prefix}.contract.json`);
  const acceptanceBytes = await ownedBytes(`${prefix}.acceptance.json`);
  if (
    digest(sourceBytes) !== approval.sourceSha256 ||
    digest(acceptanceBytes) !== approval.acceptanceSha256
  ) {
    throw new Error('Analytics independent acceptance snapshots changed.');
  }
  validateAnalyticsApproval(
    approval,
    JSON.parse(sourceBytes),
    JSON.parse(acceptanceBytes),
    contractBytes,
  );
  const input = await fs.realpath(inputDirectory);
  if (!isDeepStrictEqual((await fs.readdir(input)).sort(), Object.keys(approval.assets).sort())) {
    throw new Error('Unexpected analytics intake members.');
  }
  const releases = path.join(installedRoot, 'releases');
  await secureDirectory(releases);
  const parent = path.join(releases, approval.site);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await secureDirectory(parent);
  const destination = path.join(parent, approval.tag);
  if (
    await fs.lstat(destination).then(
      () => true,
      error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    throw new Error('Immutable analytics signing output already exists.');
  const intake = await fs.mkdtemp(path.join(installedRoot, 'intake-'));
  let retained = false;
  try {
    for (const [name, record] of Object.entries(approval.assets)) {
      await copyApprovedAsset(path.join(input, name), path.join(intake, name), record);
    }
    const manifestBytes = await ownedBytes(path.join(intake, 'anderson-runtime-manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    const configurationBytes = await ownedBytes(
      path.join(intake, 'public-build-configuration.json'),
    );
    const receipt = JSON.parse(await ownedBytes(path.join(intake, 'acceptance-receipt.json')));
    validateAnalyticsManifest(manifest, approval, receipt, configurationBytes, contractBytes);
    const embedded = await verifyTransportArchive(
      path.join(intake, manifest.archive.name),
      manifest.files,
    );
    const contract = JSON.parse(contractBytes);
    verifyEmbeddedRuntime(manifest, embedded, contract);
    if (!isDeepStrictEqual(embedded.deployment, contract.deployment)) {
      throw new Error('Analytics embedded deployment differs from the reviewed profile.');
    }
    const publicKey = await checkedPublicKey();
    const privateBytes = await ownedBytes(path.join(builderRoot, 'private-key.pem'), 4096);
    const signature = signManifestBytes(manifestBytes, privateBytes, publicKey);
    await fs.writeFile(path.join(intake, 'anderson-runtime-manifest.sig'), signature, {
      flag: 'wx',
      mode: 0o600,
    });
    const sums = [];
    for (const name of [...Object.keys(approval.assets), 'anderson-runtime-manifest.sig'].sort()) {
      const file = await fs.open(
        path.join(intake, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const hash = crypto.createHash('sha256');
      try {
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      } finally {
        await file.close();
      }
      sums.push(`${hash.digest('hex')}  ${name}`);
    }
    await fs.writeFile(path.join(intake, 'SHA256SUMS'), `${sums.join('\n')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(intake, destination);
    retained = true;
    return {
      site: approval.site,
      commit: approval.commit,
      tag: approval.tag,
      output: destination,
      manifestSha256: digest(manifestBytes),
      productionActivated: false,
    };
  } finally {
    if (!retained) await fs.rm(intake, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, approval, input, ...extra] = process.argv.slice(2);
  if (operation === 'check' && !approval && !input && !extra.length) {
    verifyInstallation()
      .then(() => checkedPublicKey())
      .then(() => {
        console.log(
          JSON.stringify({
            installation: 'verified',
            publicKeySha256: builderFingerprint,
            privateKeyRead: false,
          }),
        );
      })
      .catch(() => {
        console.error('Trusted analytics installation check failed.');
        process.exitCode = 1;
      });
  } else if (operation === 'sign' && approval && input && !extra.length) {
    signAnalytics(input, approval)
      .then(result => console.log(JSON.stringify(result)))
      .catch(() => {
        console.error(
          'Trusted analytics signing failed; no publication or activation was performed.',
        );
        process.exitCode = 1;
      });
  } else {
    console.error(
      'Usage: installed trusted-analytics-signer.mjs check | sign APPROVAL_NAME UNSIGNED_DIRECTORY',
    );
    process.exitCode = 64;
  }
}
