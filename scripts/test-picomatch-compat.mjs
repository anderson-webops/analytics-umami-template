import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const scratch = path.join(root, '.ai-work/runs/picomatch-tests');
mkdirSync(scratch, { recursive: true });

function fixture(context, archive) {
  const directory = mkdtempSync(path.join(scratch, 'case-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync('tar', ['-xzf', path.join(root, archive), '-C', directory], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return path.join(directory, 'package');
}

test('maintained Picomatch bounds repeated wildcard and effective nested quantifier paths', {
  timeout: 60_000,
}, context => {
  const directory = fixture(context, 'vendor/picomatch-4.0.7-webops.1.tgz');
  for (const [pattern, additionalOptions] of [
    '+(*)b',
    '+(*a)b',
    '*(a*)b',
    '+(a*b)b',
    '+(@(*a))b',
    '+([*a)b',
    'src/+(*a)b',
    '+(*a|c)b',
    '+(@(+(*(a))))b',
    '+(!(x))b',
    '+(@(+(a)))b',
    '+((a)+)b',
    '+(a+)b',
    '+(ab|abab)c',
    '+(a|a?)b',
    '+(["]*)b',
    '+([[a]*)b',
    '+("a"|a)b',
  ]
    .map(pattern => [pattern, {}])
    .concat([
      ['+(a\\*)b', { unescape: true }],
      ['+([*])b', { nobracket: true }],
      ['+(a|A)b', { nocase: true }],
      ['+(k|K)b', { flags: 'iu' }],
    ])) {
    const execution = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const pm = require(process.argv[1]);
      const posix = require(process.argv[1] + '/posix');
      const pattern = process.argv[2];
      const additionalOptions = JSON.parse(process.argv[3]);
      for (const variant of [{}, {maxExtglobRecursion:false}, {windows:true}, {capture:true}, {fastpaths:false}, {contains:true}]) {
        const options = {...additionalOptions, ...variant};
        const state = pm.parse(pattern, options);
        const matchers = [pm(pattern, options), posix(pattern, options), pm.makeRe(pattern, options), pm.compileRe(state, options), pm(state, options)];
        const input = (pattern.startsWith('src/') ? 'src/' : '') + 'a'.repeat(36) + 'c';
        for (const matcher of matchers) {
          assert.equal(typeof matcher === 'function' ? matcher(input) : matcher.test(input), false);
        }
        assert.equal(pm(pattern, options)(pattern), true);
        assert.equal(pm('*', {...options, ignore:pattern})(input), pm('*', options)(input));
      }
    `,
        directory,
        pattern,
        JSON.stringify(additionalOptions),
      ],
      { timeout: 3000, encoding: 'utf8' },
    );
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, `${pattern}: ${execution.stderr}`);
  }
});

test('maintained Picomatch preserves ordinary glob, escape, class and safe-collapse behavior', context => {
  const original = fixture(context, 'vendor/picomatch/upstream/picomatch-4.0.7.tgz');
  const maintained = fixture(context, 'vendor/picomatch-4.0.7-webops.1.tgz');
  const require = createRequire(import.meta.url);
  const stock = require(original);
  const patched = require(maintained);
  const patterns = [
    '**/*.js',
    'build/*.sln',
    'build/*.mk',
    '@(*.js|*.ts)',
    '+(a|b)b',
    '*(a|b)b',
    '+(ab)b',
    '+(?a)b',
    '+([*]a)b',
    '+("*"a)b',
    '+(\\*a)b',
    '+(@(a|b))b',
    '+(*(a))b',
    '+(*(a)|*(b))b',
    '+([]*])b',
    'file[!a].js',
    '**/{one,two}.js',
  ];
  const inputs = [
    '',
    'ab',
    'aab',
    'aaab',
    'abab',
    '*a*ab',
    'fileb.js',
    'src/one.js',
    'one.js',
    '.hidden.js',
    'build/project.sln',
    'build/generated.mk',
    'src\\one.js',
    '*b',
    ']b',
    ']*]b',
  ];
  for (const options of [
    {},
    { capture: true },
    { dot: true },
    { windows: true },
    { fastpaths: false },
  ]) {
    for (const pattern of patterns) {
      assert.equal(
        patched.makeRe(pattern, options).source,
        stock.makeRe(pattern, options).source,
        pattern,
      );
      for (const input of inputs)
        assert.equal(
          patched(pattern, options)(input),
          stock(pattern, options)(input),
          `${pattern}: ${input}`,
        );
    }
  }
});

test('Picomatch archives reproduce the reviewed original bytes and parser patch', () => {
  const result = spawnSync('python3', ['-B', 'scripts/package-picomatch.py', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});
