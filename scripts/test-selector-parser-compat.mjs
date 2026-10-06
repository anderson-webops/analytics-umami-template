import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('unused legacy CSS plugin cannot reintroduce vulnerable selector parsers', async () => {
  const [manifest, lock] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
  ]);
  assert.equal(manifest.devDependencies['rollup-plugin-postcss'], undefined);
  assert.doesNotMatch(lock, /^ {2}rollup-plugin-postcss@/m);

  const versions = [...lock.matchAll(/^ {2}postcss-selector-parser@([^:]+):$/gm)].map(
    match => match[1],
  );
  assert.deepEqual([...new Set(versions)], ['7.1.6']);
});
