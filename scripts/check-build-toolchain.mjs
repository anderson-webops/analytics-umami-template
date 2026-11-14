import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { nodeIdentity, verifyReusableToolchain } from './build-toolchain-cache.mjs';
import { selectedNpmCli, toolchainMetadata } from './build-toolchain-state.mjs';

const prefix = path.resolve(path.dirname(selectedNpmCli()), '../../..');
const receipt = verifyReusableToolchain(prefix, nodeIdentity());
const contract = JSON.parse(
  readFileSync(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
);
assert.equal(contract.runtime.node, receipt.node);
const application = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pnpm = JSON.parse(
  readFileSync(new URL('../deploy/mac-build/pnpm-toolchain/package.json', import.meta.url), 'utf8'),
);
assert.equal(contract.runtime.packageManager, application.packageManager);
assert.equal(contract.runtime.packageManager, `pnpm@${pnpm.dependencies.pnpm}`);
assert.equal(receipt.versions.npm, toolchainMetadata.npm);
assert.equal(receipt.profile, toolchainMetadata.profile);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
