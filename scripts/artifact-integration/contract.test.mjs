import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { command, mountIsReadOnly, parseArguments } from '../test-artifact-integration.mjs';
import { fixtureCaptchaFetch } from './captcha.mjs';
import { digest, profiles, verifyTree } from './input.mjs';
import { collectionHeaders, totp } from './probes.mjs';

const endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const argumentsList = [
  '--mode',
  'verify',
  '--site',
  'analytics.np-servicerequest.org',
  '--assets',
  '/inputs/assets',
  '--public-key',
  '/inputs/public.pem',
  '--receipt',
  '/results/receipt.json',
];

test('exact accepted profiles bind independent applications and histories', () => {
  assert.equal(Object.keys(profiles).length, 3);
  for (const profile of Object.values(profiles)) {
    assert.match(profile.commit, /^[0-9a-f]{40}$/);
    for (const value of [profile.archive, profile.manifest, profile.contract])
      assert.match(value, /^[0-9a-f]{64}$/);
  }
  assert.equal(new Set(Object.values(profiles).map(profile => profile.archive)).size, 3);
});

test('fixture CLI rejects unknown, duplicate, relative and overlapping inputs', () => {
  assert.equal(parseArguments(argumentsList).mode, 'verify');
  assert.throws(() => parseArguments([...argumentsList, '--force', 'true']));
  assert.throws(() =>
    parseArguments([...argumentsList, '--site', 'analytics.np-servicerequest.org']),
  );
  assert.throws(() =>
    parseArguments(argumentsList.map(value => (value === '/inputs/assets' ? './assets' : value))),
  );
  assert.throws(() =>
    parseArguments(
      argumentsList.map(value =>
        value === '/results/receipt.json' ? '/inputs/assets/receipt.json' : value,
      ),
    ),
  );
  assert.throws(() =>
    parseArguments(argumentsList.map(value => (value === 'verify' ? 'run' : value))),
  );
  assert.throws(() =>
    parseArguments(
      argumentsList.map(value =>
        value === 'analytics.np-servicerequest.org' ? 'analytics.avasan.org' : value,
      ),
    ),
  );
});

test('mount guard uses deepest mount, decodes spaces and keeps sibling boundaries', () => {
  const mounts =
    '1 0 0:1 / / ro - overlay overlay ro\n' +
    '2 1 0:2 / /runtime ro - ext4 /dev/root rw\n' +
    '3 2 0:3 / /runtime/.next/cache rw - tmpfs tmpfs rw\n' +
    '4 1 0:4 / /space\\040name ro - ext4 /dev/root rw\n' +
    '5 1 0:5 / /runtime-sibling rw - tmpfs tmpfs rw';
  assert.equal(mountIsReadOnly(mounts, '/runtime/server.js'), true);
  assert.equal(mountIsReadOnly(mounts, '/runtime/.next/cache'), false);
  assert.equal(mountIsReadOnly(mounts, '/runtime-sibling'), false);
  assert.equal(mountIsReadOnly(mounts, '/space name/file'), true);
});

test('RFC 6238 SHA-1 TOTP vectors retain six-digit leading zeros', () => {
  const rfc6238Seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [seconds, expected] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ]) {
    assert.equal(totp(rfc6238Seed, seconds * 1000), expected);
  }
  assert.throws(() => totp('!'));
});

test('collection proof uses fresh UUIDs and Unix seconds without credentials in URLs', () => {
  const first = collectionHeaders('synthetic', undefined, 1700000000123);
  const second = collectionHeaders('synthetic', undefined, 1700000000123);
  assert.equal(first.authorization, 'Bearer synthetic');
  assert.equal(first['x-umami-request-timestamp'], '1700000000');
  assert.notEqual(first['x-umami-request-id'], second['x-umami-request-id']);
});

test('synthetic provider intercepts only exact siteverify URL and preserves ordinary fetch', async () => {
  let fallback;
  const transport = fixtureCaptchaFetch('analytics.fixture.invalid', async (...args) => {
    fallback = args;
    return Response.json({ local: true });
  });
  const url = 'http://127.0.0.1/readyz';
  assert.deepEqual(await (await transport(url, { method: 'GET' })).json(), { local: true });
  assert.equal(fallback[0], url);
  await transport(`${endpoint}?unexpected=1`);
  assert.equal(fallback[0], `${endpoint}?unexpected=1`);
  await assert.rejects(transport(endpoint, { method: 'GET' }));
});

test('synthetic CAPTCHA controls preserve nonce consumption, action, host and outages', async () => {
  const transport = fixtureCaptchaFetch('analytics.fixture.invalid');
  const request = response =>
    transport(endpoint, {
      method: 'POST',
      redirect: 'error',
      body: new URLSearchParams({ secret: 'synthetic', response }),
    });
  const token = `fixture-valid-${randomUUID()}`;
  assert.deepEqual(await (await request(token)).json(), {
    success: true,
    action: 'login',
    hostname: 'analytics.fixture.invalid',
  });
  assert.equal((await (await request(token)).json()).success, false);
  assert.equal((await (await request('fixture-wrong-action')).json()).action, 'signup');
  assert.equal((await (await request('fixture-wrong-host')).json()).hostname, 'unrelated.invalid');
  assert.equal((await (await request('fixture-invalid')).json()).success, false);
  await assert.rejects(request('fixture-unavailable'));
});

test('unpacked verification rejects mutations, extras, missing paths, modes and escaping links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-integration-unit-'));
  try {
    const runtime = await fs.realpath(root);
    const bytes = Buffer.from('synthetic');
    const filename = path.join(runtime, 'server.js');
    await fs.writeFile(filename, bytes, { mode: 0o444 });
    const transport = {
      files: [
        {
          path: 'runtime/server.js',
          type: 'file',
          mode: 0o444,
          size: bytes.length,
          sha256: digest(bytes),
        },
      ],
    };
    assert.equal(await verifyTree(runtime, transport), 1);
    await fs.chmod(filename, 0o644);
    await assert.rejects(verifyTree(runtime, transport));
    await fs.writeFile(filename, 'different');
    await fs.chmod(filename, 0o444);
    await assert.rejects(verifyTree(runtime, transport));
    await fs.chmod(filename, 0o644);
    await fs.writeFile(filename, bytes);
    await fs.chmod(filename, 0o444);
    await fs.writeFile(path.join(runtime, 'extra'), 'unexpected');
    await assert.rejects(verifyTree(runtime, transport));
    await fs.rm(path.join(runtime, 'extra'));
    await fs.symlink('/etc/passwd', path.join(runtime, 'escape'));
    const links = {
      files: [
        ...transport.files,
        { path: 'runtime/escape', type: 'symlink', target: '/etc/passwd' },
      ],
    };
    await assert.rejects(verifyTree(runtime, links));
    await fs.rm(path.join(runtime, 'escape'));
    await fs.rm(filename);
    await assert.rejects(verifyTree(runtime, transport));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fixture subprocesses enforce their exact success/backlog outcome', async () => {
  const environment = { PATH: '/usr/bin:/bin' };
  await command(process.execPath, ['-e', 'process.exit(0)'], os.tmpdir(), environment, 5000);
  await command(process.execPath, ['-e', 'process.exit(2)'], os.tmpdir(), environment, 5000, 2);
  await assert.rejects(
    command(process.execPath, ['-e', 'process.exit(2)'], os.tmpdir(), environment, 5000),
  );
  await assert.rejects(
    command(process.execPath, ['-e', 'process.exit(0)'], os.tmpdir(), environment, 5000, 2),
  );
});

test('fixture subprocesses stop on deadline, cancellation and missing executables', async () => {
  const environment = { PATH: '/usr/bin:/bin' };
  await assert.rejects(
    command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], os.tmpdir(), environment, 50),
  );
  const controller = new AbortController();
  const running = command(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    os.tmpdir(),
    environment,
    5000,
    0,
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(running);
    await assert.rejects(
      command(
        process.execPath,
        ['-e', 'process.exit(0)'],
        os.tmpdir(),
        environment,
        5000,
        0,
        controller.signal,
      ),
    );
    await assert.rejects(
      command('/nonexistent-fixture-executable', [], os.tmpdir(), environment, 5000),
    );
  } finally {
    clearTimeout(timer);
  }
});
