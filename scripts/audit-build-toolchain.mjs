import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { nodeIdentity, verifyReusableToolchain } from './build-toolchain-cache.mjs';
import { selectedNpmCli } from './build-toolchain-state.mjs';

const argumentsList = process.argv.slice(2);
assert.ok(
  argumentsList.every(argument => argument === '--omit=dev'),
  'Unsupported toolchain audit option',
);
const cli = selectedNpmCli();
const prefix = path.resolve(path.dirname(cli), '../../..');
verifyReusableToolchain(prefix, nodeIdentity());
const result = spawnSync(
  process.execPath,
  [cli, 'audit', '--prefix', prefix, '--workspaces=false', '--audit-level=low', ...argumentsList],
  {
    stdio: 'inherit',
    timeout: 300_000,
  },
);
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  'The selected build toolchain must have a complete zero-finding audit',
);
const pnpmPrefix = path.resolve(import.meta.dirname, '../deploy/mac-build/pnpm-toolchain');
const pnpmResult = spawnSync(
  process.execPath,
  [
    cli,
    '--prefix',
    pnpmPrefix,
    '--workspaces=false',
    'audit',
    '--audit-level=low',
    ...argumentsList,
  ],
  { stdio: 'inherit', timeout: 300_000 },
);
if (pnpmResult.error) throw pnpmResult.error;
assert.equal(pnpmResult.status, 0, 'The locked pnpm graph must have a complete zero-finding audit');
