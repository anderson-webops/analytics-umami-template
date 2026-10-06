import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const rootRequire = createRequire(import.meta.url);
const postcssRequire = createRequire(rootRequire.resolve('postcss'));
const { SourceMapConsumer } = postcssRequire('source-map-js');
const leafMap = { version: 3, sources: ['example.js'], names: [], mappings: 'AAAA' };

function indexedMap(line, map = leafMap) {
  return { version: 3, sections: [{ offset: { line, column: 0 }, map }] };
}

test('the full dependency graph resolves the patched source-map-js version', async () => {
  const lock = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
  const versions = [...lock.matchAll(/^ {2}source-map-js@([^:]+):$/gm)].map(match => match[1]);
  assert.deepEqual([...new Set(versions)], ['1.2.2']);
  assert.equal(postcssRequire('source-map-js/package.json').version, '1.2.2');
});

test('indexed maps reject excessive, invalid, and cumulatively excessive offsets', () => {
  for (const line of [10_000_001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new SourceMapConsumer(indexedMap(line)), {
      message: 'Section offset line must not exceed 10000000.',
    });
  }
  for (const line of [-1, 1.5]) {
    assert.throws(() => new SourceMapConsumer(indexedMap(line)), {
      message: 'Section offset line and column must be non-negative integers.',
    });
  }
  assert.throws(() => new SourceMapConsumer(indexedMap(9_000_000, indexedMap(2_000_000))), {
    message: 'Section offset line must not exceed 10000000, including offsets of nested sections.',
  });
});

test('ordinary indexed mappings remain readable', () => {
  const consumer = new SourceMapConsumer(indexedMap(2));
  const mappings = [];
  consumer.eachMapping(mapping => mappings.push(mapping));
  assert.deepEqual(mappings, [
    {
      source: 'example.js',
      generatedLine: 3,
      generatedColumn: 0,
      originalLine: 1,
      originalColumn: 0,
      name: null,
    },
  ]);
});
