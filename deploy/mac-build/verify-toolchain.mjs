import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { inspectToolchainPayload } from '../../scripts/build-toolchain-cache.mjs';
import { toolchainMetadata, verifyBuildToolchain } from '../../scripts/build-toolchain-state.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const npmPrefix = path.join(root, 'build-toolchain');
const pnpmPrefix = path.join(root, 'deploy/mac-build/pnpm-toolchain');
const npmCli = path.join(npmPrefix, 'node_modules/npm/bin/npm-cli.js');
const pnpmCli = path.join(pnpmPrefix, 'node_modules/pnpm/pnpm');
const pnpmDescriptor = openSync(pnpmCli, 'r');
try {
  const header = Buffer.alloc(4);
  assert.equal(readSync(pnpmDescriptor, header, 0, header.length, 0), header.length);
  assert.equal(header.toString('hex'), '7f454c46', 'The installed pnpm command must be native ELF');
} finally {
  closeSync(pnpmDescriptor);
}

assert.equal(process.version, `v${toolchainMetadata.node}`);
verifyBuildToolchain(npmCli);
assert.deepEqual(
  inspectToolchainPayload(npmPrefix),
  JSON.parse(readFileSync(path.join(npmPrefix, 'PAYLOAD.json'), 'utf8')),
);
for (const [command, expected] of [
  ['npm', npmCli],
  ['npx', path.join(npmPrefix, 'node_modules/npm/bin/npx-cli.js')],
  ['pnpm', pnpmCli],
]) {
  assert.equal(realpathSync(`/usr/local/bin/${command}`), realpathSync(expected));
}
assert.equal(
  execFileSync(pnpmCli, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(),
  '12.18.0',
);

for (const prefix of [npmPrefix, pnpmPrefix]) {
  for (const args of [
    ['ls', '--all'],
    ['audit', '--audit-level=low'],
    ['audit', '--omit=dev', '--audit-level=low'],
    ['audit', 'signatures'],
  ]) {
    execFileSync(process.execPath, [npmCli, '--prefix', prefix, '--workspaces=false', ...args], {
      cwd: prefix,
      stdio: 'inherit',
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
}
console.log('Pinned npm and pnpm builder graphs, payload integrity and registry trust passed.');
