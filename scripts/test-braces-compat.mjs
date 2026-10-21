import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootRequire = createRequire(import.meta.url);

function installedBraces(plugin) {
  const pluginRequire = createRequire(rootRequire.resolve(plugin));
  const globbyRequire = createRequire(pluginRequire.resolve('globby'));
  const globRequire = createRequire(globbyRequire.resolve('fast-glob'));
  const micromatchRequire = createRequire(globRequire.resolve('micromatch'));
  const packagePath = micromatchRequire.resolve('braces/package.json');
  return {
    braces: micromatchRequire('braces'),
    micromatch: globRequire('micromatch'),
    packagePath,
  };
}

test('both build-tool paths resolve the guarded local package', async () => {
  const lock = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.match(lock, /^ {2}braces: file:vendor\/braces$/m);
  assert.match(lock, /^ {2}braces@file:vendor\/braces:$/m);
  assert.doesNotMatch(lock, /^ {2}braces@3\.0\.3:$/m);

  for (const plugin of ['rollup-plugin-copy', 'rollup-plugin-delete']) {
    const { packagePath } = installedBraces(plugin);
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    assert.equal(manifest.version, '3.0.4-webops.3');
  }
});

test('ordinary patterns retain compile, expand, and stringify behavior', () => {
  for (const plugin of ['rollup-plugin-copy', 'rollup-plugin-delete']) {
    const { braces, micromatch } = installedBraces(plugin);
    assert.deepEqual(braces('a/{b,c}/d'), ['a/(b|c)/d']);
    assert.deepEqual(braces.expand('a/{b,c}/d'), ['a/b/d', 'a/c/d']);
    assert.deepEqual(braces.expand('item-{1..3}'), ['item-1', 'item-2', 'item-3']);
    assert.equal(braces.stringify('a/{b,c}/d'), 'a/{b,c}/d');
    assert.deepEqual(micromatch(['foo-a', 'foo-b', 'foo-c'], 'foo-{a,b}'), ['foo-a', 'foo-b']);
    assert.ok(braces.parse(`${'{'.repeat(256)}x${'}'.repeat(256)}`));
    assert.ok(braces.parse(`${'('.repeat(101)}x${')'.repeat(101)}`));
  }
});

test('compiled ranges and direct AST strings stay within an aggregate byte budget', () => {
  const { braces } = installedBraces('rollup-plugin-copy');
  assert.equal(braces.compile('{1..10000}').length, 29);
  assert.ok(braces.compile('{1..1000000..-1}').length < 100);
  assert.equal(braces.compile('{1..3}', { transform: String }), '([1-3])');
  assert.throws(() => braces.compile('{1..999999999..2}'), /aggregate limit/);
  assert.throws(() => braces.compile('{1..9999..2}'.repeat(400)), /byte limit/);
  const oversizedRangeAst = {
    type: 'root',
    nodes: [{ type: 'brace', ranges: 1, nodes: Array(150000).fill({ type: 'text', value: '1' }) }],
  };
  assert.throws(() => braces.compile(oversizedRangeAst), /node budget/);
  let transformCalls = 0;
  assert.throws(
    () =>
      braces.compile('{a..z..2}', {
        transform: () => {
          transformCalls++;
          return 'x'.repeat(700000);
        },
      }),
    TypeError,
  );
  assert.equal(transformCalls, 0);

  const repeatedText = { type: 'text', value: 'x'.repeat(1024) };
  const oversizedAst = { type: 'root', nodes: Array(8193).fill(repeatedText) };
  assert.throws(() => braces.stringify(oversizedAst), /byte limit/);
  assert.throws(() => braces.compile(oversizedAst), /byte limit/);
});

test('compiled array patterns are bounded before aggregation', () => {
  const { braces } = installedBraces('rollup-plugin-copy');
  assert.deepEqual(braces(['a', 'b']), ['a', 'b']);
  assert.throws(() => braces(Array(10001).fill('x')), /aggregate limit/);
});

test('aggregate expansion is bounded before Cartesian and array outputs are materialized', () => {
  for (const plugin of ['rollup-plugin-copy', 'rollup-plugin-delete']) {
    const { braces } = installedBraces(plugin);
    assert.equal(braces.expand('{a,b}'.repeat(13)).length, 8192);
    assert.throws(() => braces.expand('{a,b}'.repeat(30)), {
      name: 'RangeError',
      message: 'expanded array length exceeds aggregate limit',
    });
    assert.throws(() => braces.expand('{1..1000}{1..1000}'), {
      name: 'RangeError',
      message: 'expanded array length exceeds aggregate limit',
    });
    assert.equal(braces.expand('{a,{b,c}}'.repeat(8)).length, 6561);
    assert.throws(() => braces.expand('{a,{b,c}}'.repeat(9)), {
      name: 'RangeError',
      message: 'expanded array length exceeds aggregate limit',
    });
    assert.throws(() => braces(Array(11).fill('{1..1000}'), { expand: true }), {
      name: 'RangeError',
      message: 'expanded array length exceeds aggregate limit',
    });
    assert.deepEqual(braces.expand('item-{1..3}'), ['item-1', 'item-2', 'item-3']);
  }
});

test('range limits cover explicit steps, descending sequences, and letters', () => {
  const { braces } = installedBraces('rollup-plugin-copy');
  for (const pattern of ['{1..2001..2}', '{1001..1}', `{a..\u0510}`]) {
    assert.throws(() => braces.expand(pattern), {
      name: 'RangeError',
      message: /expanded array length exceeds range limit/,
    });
  }
  assert.deepEqual(braces.expand('{1..10..2}'), ['1', '3', '5', '7', '9']);
  assert.deepEqual(braces.expand('{10..1..2}'), ['10', '8', '6', '4', '2']);
  assert.deepEqual(braces.expand('{a..e..2}'), ['a', 'c', 'e']);
  assert.throws(() => braces.expand('{1..10001}', { rangeLimit: false }), {
    name: 'RangeError',
    message: 'expanded array length exceeds aggregate limit',
  });
  assert.throws(() => braces.expand('{9007199254740992..9007199254740993}'), RangeError);
  assert.deepEqual(braces.expand('{1..3}', { transform: null }), ['1', '2', '3']);
  assert.deepEqual(braces.expand('{1..3}', { transform: false }), ['1', '2', '3']);
  assert.equal(braces.expand(`${'x'.repeat(8386)}{a..ш}`).length, 1000);
  const boundedNumericRange = braces.expand(`${'x'.repeat(834)}{1..10000}`, { rangeLimit: false });
  assert.equal(boundedNumericRange.length, 10000);
  assert.ok(
    boundedNumericRange.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) <
      8 * 1024 * 1024,
  );
});

test('preflight rejects oversized alternatives and output before materializing ranges', () => {
  const probe = `
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const vendorRequire = createRequire(require.resolve('./vendor/braces/lib/expand.js'));
    const fillPath = vendorRequire.resolve('fill-range');
    const fill = vendorRequire('fill-range');
    let calls = 0;
    require.cache[fillPath].exports = (...args) => { calls += 1; return fill(...args); };
    const braces = require('./vendor/braces');
    const tooManyArms = '{' + Array(11).fill('{1..1000}').join(',') + '}';
    assert.throws(() => braces.expand(tooManyArms), /aggregate limit/);
    assert.equal(calls, 0);
    assert.throws(() => braces.expand('{1..1000}{1..1000}'), /aggregate limit/);
    assert.equal(calls, 0);
    assert.throws(() => braces.expand('x'.repeat(9000) + '{1..1000}'), /byte limit/);
    assert.equal(calls, 0);
    assert.throws(() => braces.expand('é'.repeat(4500) + '{1..1000}'), /byte limit/);
    assert.equal(calls, 0);
    assert.equal(braces.expand('x'.repeat(8384) + '{1..1000}').length, 1000);
    assert.equal(calls, 1);
    assert.throws(() => braces.expand('{1..20000}', { step: {} }), TypeError);
    assert.throws(() => braces.expand('{1..20000}', { step: () => 1 }), TypeError);
    assert.throws(() => braces.expand("{1..20000..''}", { step: {} }), TypeError);
    const arrayOptions = [];
    arrayOptions.step = 10001;
    assert.throws(() => braces.expand('{1..10001}', arrayOptions), TypeError);
    const callableOptions = () => {};
    callableOptions.step = 10001;
    assert.throws(() => braces.expand('{1..10001}', callableOptions), TypeError);
    assert.equal(calls, 1);
    const crafted = braces.parse('{1..20000}');
    crafted.nodes[1].type = 'bos';
    assert.throws(() => braces.expand(crafted), /range limit/);
    assert.equal(calls, 1);
    const craftedStep = braces.parse('{1..20000..2}');
    craftedStep.nodes[1].nodes[5].value = { step: 1 };
    assert.throws(() => braces.expand(craftedStep), TypeError);
    assert.equal(calls, 1);
    const craftedCommas = braces.parse(tooManyArms);
    craftedCommas.nodes[1].commas = 0;
    assert.throws(() => braces.expand(craftedCommas), /aggregate limit/);
    assert.equal(calls, 1);
    const extraClose = braces.parse('{a,b}{1..2}');
    extraClose.nodes[1].nodes.splice(-1, 0, ...Array(12).fill({ type: 'close', value: '}' }));
    assert.throws(() => braces.expand(extraClose), TypeError);
    assert.equal(calls, 1);
    const missingOpen = braces.parse('{a,b}'.repeat(8) + '{1..2}');
    for (const child of missingOpen.nodes) {
      if (child.type === 'brace' && child.commas > 0) child.nodes.shift();
    }
    assert.throws(() => braces.expand(missingOpen), TypeError);
    assert.equal(calls, 1);
    assert.throws(() => braces.expand('{1..20}', {}, { count: -100000, bytes: 0 }), TypeError);
    assert.equal(calls, 1);
    const extraRangeArgument = braces.parse("{1..20000..''}");
    extraRangeArgument.nodes[1].nodes.splice(-1, 0, { type: 'text', value: 'x' });
    assert.throws(() => braces.expand(extraRangeArgument, { step: 20000 }), TypeError);
    assert.equal(calls, 1);
    const numericLetterArgument = braces.parse('{a..\u4e20}');
    numericLetterArgument.nodes[1].nodes[1].value = 1.5;
    assert.throws(() => braces.expand(numericLetterArgument), TypeError);
    assert.equal(calls, 1);
    const sharedText = { type: 'text', value: 'x'.repeat(8192) };
    const oversizedLiteral = { type: 'brace', invalid: true, nodes: Array(1025).fill(sharedText) };
    assert.throws(() => braces.expand({ type: 'root', nodes: [oversizedLiteral] }), /byte limit/);
    assert.equal(calls, 1);
    const arrayText = braces.parse('x{1..20}');
    arrayText.nodes[1].value = Array(1001).fill('x');
    assert.throws(() => braces.expand(arrayText), TypeError);
    assert.equal(calls, 1);
    const oversizedArrayText = braces.parse('x');
    oversizedArrayText.nodes[1].value = Array(8193).fill('x'.repeat(1023));
    assert.throws(() => braces.expand(oversizedArrayText), TypeError);
    assert.equal(calls, 1);
    assert.throws(() => braces.expand('{1..3}', { transform: () => 'x' }), TypeError);
    assert.throws(() => braces.expand('{1..3}', { toRegex: true }), TypeError);
    assert.equal(calls, 1);
    assert.throws(() => braces(Array(11).fill('{1..1000}'), { expand: true }), /aggregate limit/);
    assert.equal(calls, 11);
    assert.throws(() => braces(Array(2).fill('{a,a}'.repeat(13)), { expand: true, nodupes: true }), /aggregate limit/);
    assert.equal(calls, 11);
    assert.deepEqual(braces.expand('{a,{b,c}}'), ['a', 'b', 'c']);
    assert.deepEqual(braces.expand('{x{a,b}}'), ['{xa}', '{xb}']);
  `;
  execFileSync(process.execPath, ['-e', probe], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'pipe',
  });
});

test('deep strings are rejected before recursive walkers exhaust the stack', () => {
  const { braces } = installedBraces('rollup-plugin-copy');
  for (const input of [
    `${'{'.repeat(4000)}x${'}'.repeat(4000)}`,
    `${'('.repeat(4000)}x${')'.repeat(4000)}`,
  ]) {
    for (const operation of [
      braces.parse,
      braces.compile,
      braces.expand,
      braces.stringify,
      braces,
    ]) {
      assert.throws(() => operation(input), {
        name: 'SyntaxError',
        message: 'Brace pattern exceeds maximum nesting depth (256)',
      });
    }
  }
});

test('direct AST entry points cannot bypass the depth limit', () => {
  const { braces } = installedBraces('rollup-plugin-delete');
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    const ast = { type: 'root', nodes: [] };
    let current = ast;
    for (let depth = 0; depth < 257; depth += 1) {
      const child = { type: 'brace', nodes: [], parent: current };
      current.nodes.push(child);
      current = child;
    }
    current.nodes.push({ type: 'text', value: 'x', parent: current });
    assert.throws(() => operation(ast), {
      name: 'SyntaxError',
      message: 'Brace pattern exceeds maximum nesting depth (256)',
    });
  }
});

test('iterable AST nodes cannot bypass recursive walker guards', () => {
  const { braces } = installedBraces('rollup-plugin-copy');
  const ast = { type: 'root', nodes: new Set() };
  let current = ast;
  for (let depth = 0; depth < 257; depth += 1) {
    const child = { type: 'brace', nodes: new Set(), parent: current };
    current.nodes.add(child);
    current = child;
  }
  current.nodes.add({ type: 'text', value: 'x', parent: current });
  for (const operation of [braces.compile, braces.stringify]) {
    assert.throws(() => operation(ast), {
      name: 'SyntaxError',
      message: 'Brace pattern exceeds maximum nesting depth (256)',
    });
  }
});
