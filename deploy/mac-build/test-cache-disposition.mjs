import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./cache-disposition.mjs', import.meta.url));
const days = 24 * 60 * 60;

function disposition(kind, sizeKiB, ageSeconds) {
  return spawnSync(process.execPath, [script, kind, String(sizeKiB), String(ageSeconds)], {
    encoding: 'utf8',
  });
}

for (const [kind, limitKiB, maxIdleDays] of [
  ['compiler', 512 * 1024, 30],
  ['pnpm', 2 * 1024 * 1024, 90],
]) {
  test(`${kind} retains a large recently used cache`, () => {
    const result = disposition(kind, limitKiB + 1, 6 * days);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'retain');
  });

  test(`${kind} proposes an oversized cache only after seven idle days`, () => {
    assert.equal(disposition(kind, limitKiB + 1, 7 * days).stdout, 'retain');
    assert.equal(disposition(kind, limitKiB + 1, 7 * days + 1).stdout, 'eligible');
    assert.equal(disposition(kind, limitKiB, 7 * days + 1).stdout, 'retain');
  });

  test(`${kind} proposes any cache past its idle-age budget`, () => {
    assert.equal(disposition(kind, 1, maxIdleDays * days).stdout, 'retain');
    assert.equal(disposition(kind, 1, maxIdleDays * days + 1).stdout, 'eligible');
  });
}

test('invalid measurements fail closed', () => {
  for (const args of [
    ['unknown', '1', '1'],
    ['compiler', '-1', '1'],
    ['compiler', '1', '1.5'],
    ['compiler', '9007199254740993', '1'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 64);
    assert.equal(result.stdout, '');
  }
});
