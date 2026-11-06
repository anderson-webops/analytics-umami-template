import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

test('Linux builder installs system certificate roots before package bootstrapping', () => {
  const source = fs.readFileSync(path.join(directory, 'Dockerfile'), 'utf8');
  const certificates = source.indexOf('ca-certificates=');
  const bootstrap = source.indexOf('npm install --global');

  assert.ok(certificates >= 0 && certificates < bootstrap);
  assert.match(source, /ca-certificates=\d{8}(?:[+~]deb\d+u\d+)?\s/);
  assert.match(source, /test -s \/etc\/ssl\/certs\/ca-certificates\.crt/);
  assert.doesNotMatch(source, /strict-ssl=false|NODE_TLS_REJECT_UNAUTHORIZED=0|--insecure/);
});

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

test('legacy transport signing rejects a key path before touching it', () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(directory, '../../scripts/mac-artifact-transport.mjs'),
      'sign',
      '--output',
      '/unavailable/candidate-output',
      '--key',
      '/unavailable/private-key',
    ],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Checkout-controlled signing is retired/);
  assert.doesNotMatch(result.stderr, /ENOENT|private-key/);
  assert.equal(result.stdout, '');
});

test('unsigned builder uses its installed policy to bind the exact application and release line', () => {
  const source = fs.readFileSync(path.join(directory, 'build-unsigned.sh'), 'utf8');
  assert.match(
    source,
    /"\$installed_root\/deploy\/mac-build\/public-environment\.mjs" "\$configuration" release-identity "\$tag"/,
  );
  assert.ok(source.indexOf('release-identity') < source.indexOf('bundle create'));
});

test('public release identity command admits only the exact Avasan profile and v5 tag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-release-identity-'));
  const filename = path.join(root, 'configuration.json');
  const configuration = {
    schema_version: 1,
    site: 'analytics.avasan.org',
    repository: 'anderson-webops/analytics.avasan.org',
    environment: {
      PUBLIC_URL: 'https://analytics.avasan.org',
      CLIENT_IP_HEADER: 'x-real-ip',
      CLASSROOM_MODE: '1',
      PRIVATE_MODE: '1',
      DISABLE_PUBLIC_SHARES: '1',
      DISABLE_TELEMETRY: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      DISABLE_UPDATES: '1',
      ENABLE_UPDATE_CHECKS: '0',
      MCP_ENABLED: '0',
      SKIP_BUILD_GEO: '1',
    },
  };
  try {
    fs.writeFileSync(filename, JSON.stringify(configuration));
    for (const [tag, accepted] of [
      ['v5.0.1', true],
      ['v4.2.188', false],
      ['v6.0.0', false],
      ['v5.0.1\n', false],
    ]) {
      const result = spawnSync(
        process.execPath,
        [path.join(directory, 'public-environment.mjs'), filename, 'release-identity', tag],
        {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin' },
        },
      );
      assert.equal(result.status, accepted ? 0 : 1);
      assert.equal(
        result.stdout,
        accepted ? `${configuration.site}\n${configuration.repository}\n` : '',
      );
    }
    configuration.environment.MCP_ENABLED = '1';
    fs.writeFileSync(filename, JSON.stringify(configuration));
    const result = spawnSync(
      process.execPath,
      [path.join(directory, 'public-environment.mjs'), filename, 'release-identity', 'v5.0.1'],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /classroom privacy profile/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('bounded single-file Docker logs explicitly disable incompatible compression', () => {
  const source = fs.readFileSync(path.join(directory, 'build-unsigned.sh'), 'utf8');
  const logging = [...source.matchAll(/--log-driver local[^\n]+/g)];
  assert.equal(logging.length, 2);
  for (const [options] of logging) {
    assert.match(options, /--log-opt max-size=8m/);
    assert.match(options, /--log-opt max-file=1/);
    assert.match(options, /--log-opt compress=false/);
  }
});
