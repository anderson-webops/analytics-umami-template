import fs from 'node:fs';
import path from 'node:path';
import { validatePublicConfiguration } from '../../scripts/mac-artifact-transport.mjs';

export function verifyUnsignedAssets(directory, site, tag, repository, configurationPath) {
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(site) || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) {
    throw new Error('Invalid unsigned release identity.');
  }
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error('Unsigned release assets path is not a directory.');
  }

  const expected = [
    `${site}-${tag}-linux-arm64-runtime.tar.gz`,
    'acceptance-receipt.json',
    'anderson-runtime-manifest.json',
    'public-build-configuration.json',
  ].sort();
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(expected)) {
    throw new Error('Unsigned release assets are not the expected exact file set.');
  }

  let totalBytes = 0;
  for (const name of expected) {
    const metadata = fs.lstatSync(path.join(directory, name));
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size < 1 ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error(
        `Unsigned release asset has an unsafe type, link count, size, or mode: ${name}`,
      );
    }
    totalBytes += metadata.size;
  }
  if (totalBytes > 1_100_000 * 1024) {
    throw new Error('Unsigned release assets exceed their transport size bound.');
  }

  if ((repository === undefined) !== (configurationPath === undefined)) {
    throw new Error('Both reviewed configuration identity and path are required.');
  }
  if (configurationPath !== undefined) {
    const reviewed = validatePublicConfiguration(
      JSON.parse(fs.readFileSync(configurationPath, 'utf8')),
      site,
      repository,
    );
    const packaged = fs.readFileSync(path.join(directory, 'public-build-configuration.json'));
    if (!packaged.equals(reviewed)) {
      throw new Error('The packaged public configuration differs from the reviewed input.');
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [directory, site, tag, repository, configurationPath] = process.argv.slice(2);
  if (!directory || !site || !tag) {
    process.stderr.write('Expected ASSET_DIRECTORY SITE TAG [REPOSITORY CONFIGURATION].\n');
    process.exitCode = 64;
  } else {
    verifyUnsignedAssets(directory, site, tag, repository, configurationPath);
  }
}
