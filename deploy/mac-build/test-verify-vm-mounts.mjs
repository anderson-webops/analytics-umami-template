import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./verify-vm-mounts.mjs', import.meta.url));
const exchange = '/Volumes/Storage/General Storage/Builder/exchange';
const validMount = { target: exchange, fstype: 'virtiofs', options: 'rw,relatime' };

function verify(filesystems) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify({ filesystems }),
    encoding: 'utf8',
  });
}

test('accepts only the writable exchange share', () => {
  const result = verify([validMount]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

for (const [description, filesystems] of [
  ['no shared mount', []],
  [
    'an additional Sites mount',
    [
      validMount,
      { target: '/Volumes/Storage/General Storage/Sites', fstype: 'virtiofs', options: 'rw' },
    ],
  ],
  [
    'only a Sites mount',
    [{ target: '/Volumes/Storage/General Storage/Sites', fstype: 'virtiofs', options: 'rw' }],
  ],
  ['a read-only exchange mount', [{ ...validMount, options: 'ro,relatime' }]],
  ['an unexpected mount type', [{ ...validMount, fstype: 'ext4' }]],
  [
    'a nested Sites mount',
    [{ ...validMount, children: [{ target: '/Volumes/Storage/General Storage/Sites' }] }],
  ],
  ['a malformed nested mount', [{ ...validMount, children: {} }]],
]) {
  test(`rejects ${description}`, () => {
    const result = verify(filesystems);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /share only the writable Storage exchange/);
  });
}

test('rejects malformed mount inventory', () => {
  const result = spawnSync(process.execPath, [script], {
    input: '{',
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
});
