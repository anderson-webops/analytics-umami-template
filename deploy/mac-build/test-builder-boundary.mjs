import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

for (const script of ['release.sh', 'publish.sh']) {
  for (const argumentsList of [
    [],
    ['v4.2.185', 'config.json', 'jacob-m3', 'key.pem', '--publish'],
  ]) {
    test(`legacy ${script} stops before all operations: ${argumentsList.length} arguments`, () => {
      const result = spawnSync('/bin/bash', [path.join(directory, script), ...argumentsList], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      });
      assert.equal(result.status, 78);
      assert.match(result.stderr, /retired/);
      assert.equal(result.stdout, '');
    });
  }
}

test('unsigned controller cannot run from a checkout', () => {
  const result = spawnSync('/bin/bash', [path.join(directory, 'build-unsigned.sh'), 'check'], {
    encoding: 'utf8',
    env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /reviewed installed/);
});

test('unsigned builder retains the disposable guest and independent signature boundary', () => {
  const source = fs.readFileSync(path.join(directory, 'build-unsigned.sh'), 'utf8');
  assert.match(source, /--mount none/);
  assert.match(source, /--ssh-agent=false/);
  assert.match(source, /--network none --user 0:0 --privileged/);
  assert.match(source, /colima --profile "\$profile" delete --force --data/);
  assert.match(source, /--save-config=false --activate=false --ssh-config=false/);
  assert.match(source, /type=volume,src=\$volume,dst=\/work,volume-nocopy/);
  assert.match(source, /refs\/remotes\/origin\/main/);
  assert.doesNotMatch(
    source,
    /type=bind|docker\.sock|private-key\.pem|publish\.sh|gh release|transport\.mjs["']? sign/,
  );
  assert.ok(source.indexOf('--mount none') < source.indexOf('container-phase.sh build'));
});

test('every supervised phase stays within the existing time and output bounds', () => {
  const source = fs.readFileSync(path.join(directory, 'build-unsigned.sh'), 'utf8');
  const phases = [...source.matchAll(/run-bounded\.mjs" "\$output\/[^"\n]+" (\d+) (\d+)/g)];
  assert.equal(phases.length, 3);
  for (const [, seconds, bytes] of phases) {
    assert.ok(Number(seconds) >= 1 && Number(seconds) <= 7200);
    assert.ok(Number(bytes) >= 1 && Number(bytes) <= 8 * 1024 * 1024);
  }
  assert.match(source, /freshVmDestroyed:destroyed==='true'/);
  assert.match(source, /defaultBuilderRestored:restored==='true'/);
});
