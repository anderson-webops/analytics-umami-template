import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  selectedNpmCli,
  toolchainMetadata,
  verifyBuildToolchain,
} from './build-toolchain-state.mjs';

verifyBuildToolchain();
const root = path.resolve(import.meta.dirname, '..');
const scratch = path.join(root, '.ai-work/runs/npm-source-verification');
mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(path.join(scratch, 'upstream-'));
try {
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        selectedNpmCli(),
        'pack',
        `npm@${toolchainMetadata.npm}`,
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        directory,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
  );
  const record = Object.values(packed)[0];
  assert.equal(record.integrity, toolchainMetadata.upstreamIntegrity);
  execFileSync(
    'python3',
    [
      '-B',
      path.join(root, 'scripts/package-npm-toolchain.py'),
      path.join(directory, record.filename),
      '--check',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      timeout: 60_000,
    },
  );
} finally {
  rmSync(directory, { recursive: true });
}
