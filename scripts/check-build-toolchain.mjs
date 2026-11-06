import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { digestRegularFile, verifyReusableToolchain } from './build-toolchain-cache.mjs';
import { selectedNpmCli } from './build-toolchain-state.mjs';

const prefix = path.resolve(path.dirname(selectedNpmCli()), '../../..');
const receipt = verifyReusableToolchain(prefix, digestRegularFile(process.execPath));
const contract = JSON.parse(
  readFileSync(new URL('../deploy/runtime-artifact.json', import.meta.url), 'utf8'),
);
assert.equal(contract.runtime.node, receipt.node);
assert.equal(contract.runtime.npmBuildOnly, receipt.versions.npm);
assert.equal(contract.runtime.npmBuildProfile, receipt.profile);
assert.equal(contract.runtime.npmBuildLockSha256, receipt.lockSha256);
assert.equal(contract.runtime.npmBuildPayloadSha256, receipt.payloadTreeSha256);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
