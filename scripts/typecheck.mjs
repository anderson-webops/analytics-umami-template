import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const packagePath = require.resolve('typescript-native/package.json');
const compiler = JSON.parse(readFileSync(packagePath, 'utf8'));

if (!compiler.version.startsWith('7.') || typeof compiler.bin?.tsc !== 'string') {
  throw new Error('Type checking requires the pinned TypeScript 7 native compiler.');
}

const result = spawnSync(
  process.execPath,
  [resolve(dirname(packagePath), compiler.bin.tsc), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
