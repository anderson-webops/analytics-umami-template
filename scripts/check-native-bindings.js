import fs from 'node:fs';
import path from 'node:path';

const lockfilePath = path.resolve(process.cwd(), 'pnpm-lock.yaml');
const lockfile = fs.readFileSync(lockfilePath, 'utf8');

const requiredLinuxArm64Packages = [
  '@biomejs/cli-linux-arm64',
  '@biomejs/cli-linux-arm64-musl',
  '@esbuild/linux-arm64',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-libvips-linuxmusl-arm64',
  '@img/sharp-linux-arm64',
  '@img/sharp-linuxmusl-arm64',
  '@next/swc-linux-arm64-gnu',
  '@next/swc-linux-arm64-musl',
  '@parcel/watcher-linux-arm64-glibc',
  '@parcel/watcher-linux-arm64-musl',
  '@rolldown/binding-linux-arm64-gnu',
  '@rolldown/binding-linux-arm64-musl',
  '@rollup/rollup-linux-arm64-gnu',
  '@rollup/rollup-linux-arm64-musl',
  '@swc/core-linux-arm64-gnu',
  '@swc/core-linux-arm64-musl',
  'lightningcss-linux-arm64-gnu',
  'lightningcss-linux-arm64-musl',
];

const missing = requiredLinuxArm64Packages.filter(
  packageName =>
    !lockfile.includes(`'${packageName}@`) && !lockfile.includes(`\n  ${packageName}@`),
);

if (missing.length > 0) {
  console.error(
    `pnpm-lock.yaml is missing required Linux ARM64 optional packages:\n${missing
      .map(packageName => ` - ${packageName}`)
      .join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `Verified ${requiredLinuxArm64Packages.length} Linux ARM64 native package entries in pnpm-lock.yaml.`,
);
