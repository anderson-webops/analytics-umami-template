import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function selectNpmSeed({
  nodePath = process.execPath,
  npmExecpath = process.env.npm_execpath,
  platform = process.platform,
} = {}) {
  const nodeDirectory = path.dirname(nodePath);
  const candidates = [
    npmExecpath,
    path.resolve(nodeDirectory, '../node_modules/npm/bin/npm-cli.js'),
    path.join(nodeDirectory, platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'),
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const cli = realpathSync(candidate);
    if (path.basename(cli) !== 'npm-cli.js') continue;
    const manifest = JSON.parse(readFileSync(path.resolve(cli, '../../package.json'), 'utf8'));
    if (manifest.name === 'npm') return cli;
  }
  assert.fail('A JavaScript npm CLI is required to bootstrap the locked build profile');
}
