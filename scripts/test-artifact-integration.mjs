import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { digest, profiles, verifyBundle, verifyTree } from './artifact-integration/input.mjs';
import { exerciseIntegration } from './artifact-integration/probes.mjs';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));

export function parseArguments(values) {
  const options = {};
  const allowed = new Set([
    'mode',
    'site',
    'assets',
    'public-key',
    'runtime',
    'work',
    'pg-bin',
    'receipt',
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.slice(2);
    const value = values[index + 1];
    assert(
      values[index]?.startsWith('--') && allowed.has(name) && value && !options[name],
      'Invalid fixture arguments',
    );
    options[name] = value;
  }
  assert(
    ['verify', 'run'].includes(options.mode) && profiles[options.site],
    'Fixture mode/profile required',
  );
  for (const name of [
    'assets',
    'public-key',
    'receipt',
    ...(options.mode === 'run' ? ['runtime', 'work', 'pg-bin'] : []),
  ]) {
    assert(path.isAbsolute(options[name] ?? ''), `Absolute --${name} required`);
    assert.equal(path.resolve(options[name]), options[name], 'Paths must be normalized');
  }
  const protectedRoots = [options.assets, options.runtime, options['pg-bin'], scriptsRoot].filter(
    Boolean,
  );
  for (const output of [options.receipt, options.work].filter(Boolean)) {
    assert(
      !protectedRoots.some(root => output === root || output.startsWith(`${root}/`)),
      'Output overlaps immutable input',
    );
  }
  return options;
}

export function mountIsReadOnly(mountinfo, target) {
  const mounts = mountinfo
    .trim()
    .split('\n')
    .map(line => {
      const fields = line.split(' ');
      return {
        root: fields[4].replace(/\\([0-7]{3})/g, (_encoded, octal) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        ),
        options: fields[5].split(','),
      };
    })
    .filter(
      mount =>
        target === mount.root || target.startsWith(`${mount.root === '/' ? '' : mount.root}/`),
    );
  mounts.sort((left, right) => right.root.length - left.root.length);
  return mounts[0]?.options.includes('ro') === true;
}

async function assertIsolation(options) {
  assert.equal(process.platform, 'linux', 'Exact runtime execution requires Linux');
  assert.equal(process.arch, 'arm64', 'Exact runtime execution requires ARM64');
  assert.equal(process.version, 'v24.18.1', 'Use the accepted artifact runtime toolchain');
  assert(process.getuid() !== 0, 'Fixture must run as non-root');
  assert.equal(process.pid, 1, 'Fixture runner must be PID 1 in a private PID namespace');
  assert.deepEqual(
    Object.keys(os.networkInterfaces()).sort(),
    ['lo'],
    'Fixture requires a private loopback-only network',
  );
  const status = await fs.readFile('/proc/self/status', 'utf8');
  assert(
    /^CapEff:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status),
    'Fixture needs zero capabilities and no-new-privileges',
  );
  const mountinfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
  for (const target of ['/', options.runtime, options.assets, scriptsRoot]) {
    assert(mountIsReadOnly(mountinfo, target), 'Fixture input/root mount must be read-only');
  }
  for (const forbidden of [
    '/var/run/docker.sock',
    '/run/docker.sock',
    path.join(options.runtime, '.git'),
    path.join(options.runtime, 'src'),
    path.join(options.runtime, '.env'),
    path.join(options.runtime, '.env.local'),
    path.join(scriptsRoot, '..', 'src'),
    path.join(scriptsRoot, '..', '.git'),
  ]) {
    await assert.rejects(
      fs.access(forbidden),
      'Source, private environment or container authority is exposed',
    );
  }
  const requireRuntime = createRequire(path.join(options.runtime, 'server.js'));
  for (const name of ['vitest', 'typescript', '@biomejs/biome']) {
    assert.throws(() => requireRuntime.resolve(name), 'Development dependencies are exposed');
  }
  return {
    architecture: process.arch,
    node: process.version,
    uid: process.getuid(),
    effectiveCapabilities: '0',
    noNewPrivileges: true,
    network: 'loopback-only',
    privatePidNamespace: true,
    runtimeReadOnly: true,
    sourceCheckoutAvailable: false,
    developmentDependenciesAvailable: false,
  };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function command(
  executable,
  args,
  cwd,
  env,
  timeout = 120000,
  expectedCode = 0,
  signal,
) {
  signal?.throwIfAborted();
  const child = spawn(executable, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const terminate = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const timer = setTimeout(terminate, timeout);
  signal?.addEventListener('abort', terminate, { once: true });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code =>
        code === expectedCode ? resolve() : reject(new Error('Fixture subprocess failed')),
      );
    });
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', terminate);
  }
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
  try {
    const code = await new Promise(resolve => server.once('exit', resolve));
    assert.equal(code, 0, 'Runtime did not shut down cleanly');
  } finally {
    clearTimeout(timer);
  }
}

async function executeFixture(options, transport, receipt) {
  receipt.isolation = await assertIsolation(options);
  assert.equal(await fs.realpath(options.work), options.work);
  assert.equal((await fs.readdir(options.work)).length, 0, 'Fixture workspace must start empty');
  const temporary = await fs.mkdtemp(path.join(options.work, 'synthetic-'));
  await fs.chmod(temporary, 0o700);
  const environment = {
    PATH: `${options['pg-bin']}:/usr/bin:/bin`,
    HOME: temporary,
    TMPDIR: temporary,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
  const postgresData = path.join(temporary, 'postgres');
  const pgctl = path.join(options['pg-bin'], 'pg_ctl');
  const databasePort = await availablePort();
  let postgresInitialized = false;
  let server;
  let client;
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  const interrupted = () => controller.abort();
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    receipt.stage = 'private-postgres-initialization';
    await command(
      path.join(options['pg-bin'], 'initdb'),
      ['-D', postgresData, '-A', 'trust', '-U', 'artifact_fixture', '--no-locale'],
      temporary,
      environment,
      120000,
      0,
      signal,
    );
    postgresInitialized = true;
    await command(
      pgctl,
      [
        '-D',
        postgresData,
        '-l',
        path.join(temporary, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${databasePort} -k ${temporary} -c max_connections=20 -c shared_buffers=32MB`,
        '-w',
        'start',
      ],
      temporary,
      environment,
      120000,
      0,
      signal,
    );
    const databaseUrl = `postgresql://artifact_fixture@127.0.0.1:${databasePort}/postgres`;
    const port = await availablePort();
    const origin = `https://${options.site}`;
    const runtimeRequire = createRequire(path.join(options.runtime, 'server.js'));
    for (const name of ['pg']) {
      assert(
        (await fs.realpath(runtimeRequire.resolve(name))).startsWith(`${options.runtime}/`),
        'Fixture dependency is outside accepted artifact',
      );
    }
    const { Client } = runtimeRequire('pg');
    const fixture = {
      owner: randomUUID(),
      otherOwner: randomUUID(),
      website: randomUUID(),
      otherWebsite: randomUUID(),
      username: `fixture-${randomUUID()}`,
      password: 'Synthetic.Artifact.Fixture.Only.2026',
      credential: randomBytes(32).toString('base64url'),
      eventCredential: randomBytes(32).toString('base64url'),
    };
    const keys = {
      [fixture.website]: [fixture.credential, fixture.eventCredential].map((credential, index) => ({
        sha256: digest(credential),
        ownerType: 'user',
        ownerId: fixture.owner,
        generation: 0,
        scopes: index === 0 ? ['event', 'identity', 'revenue', 'recorder'] : ['event'],
      })),
    };
    const runtimeEnvironment = {
      ...environment,
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      DIRECT_DATABASE_URL: databaseUrl,
      APP_SECRET: randomBytes(32).toString('hex'),
      TWO_FACTOR_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      PUBLIC_URL: origin,
      DISABLE_TELEMETRY: '1',
      DISABLE_PUBLIC_SHARES: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      ENABLE_UPDATE_CHECKS: '0',
      MCP_ENABLED: '0',
      CLASSROOM_MODE: '0',
      TURNSTILE_SITE_KEY: randomBytes(20).toString('hex'),
      TURNSTILE_SECRET_KEY: randomBytes(24).toString('hex'),
      REVENUE_ATTESTED_INTAKE_ENABLED: '1',
      COLLECTION_SERVER_KEYS_JSON: JSON.stringify(keys),
      ARTIFACT_INTEGRATION_SYNTHETIC: '1',
      ARTIFACT_INTEGRATION_CAPTCHA_HOST: options.site,
      HOSTNAME: '127.0.0.1',
      UMAMI_BIND_ADDRESS: '127.0.0.1',
      PORT: String(port),
    };
    receipt.stage = 'packaged-migration-tool';
    await command(
      process.execPath,
      [path.join(options.runtime, 'runtime-scripts/check-db.mjs'), '--migrate-only'],
      options.runtime,
      runtimeEnvironment,
      120000,
      0,
      signal,
    );
    client = new Client({
      connectionString: databaseUrl,
      options: '-c TimeZone=UTC -c statement_timeout=10000',
      connectionTimeoutMillis: 5000,
      query_timeout: 15000,
    });
    await client.connect();
    const hash = '$2b$12$mt2oSrbq.s3OnbiU1/a4XOGBSl7TDL.hnG1E9GjQTdor3GavbItIK';
    await client.query(
      "INSERT INTO \"user\"(user_id,username,password,role,two_factor_required,updated_at) VALUES ($1,$2,$3,'user',true,now()),($4,$5,$3,'user',true,now())",
      [fixture.owner, fixture.username, hash, fixture.otherOwner, `other-${randomUUID()}`],
    );
    await client.query(
      "INSERT INTO website(website_id,name,domain,user_id,created_by,updated_at) VALUES ($1,'Fixture','fixture.invalid',$2,$2,now()),($3,'Other fixture','fixture.invalid',$4,$4,now())",
      [fixture.website, fixture.owner, fixture.otherWebsite, fixture.otherOwner],
    );
    receipt.stage = 'runtime-startup';
    server = spawn(
      process.execPath,
      [
        '--import',
        path.join(scriptsRoot, 'artifact-integration/captcha.mjs'),
        path.join(options.runtime, 'server.js'),
      ],
      { cwd: options.runtime, env: runtimeEnvironment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.stdout.resume();
    server.stderr.resume();
    let spawnError = false;
    server.once('error', () => {
      spawnError = true;
    });
    const base = `http://127.0.0.1:${port}`;
    const started = Date.now();
    while (true) {
      signal.throwIfAborted();
      assert(
        !spawnError && server.exitCode === null && server.signalCode === null,
        'Runtime exited before readiness',
      );
      let ready = false;
      try {
        ready =
          (await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1000) })).status === 200;
      } catch {}
      if (ready) break;
      assert(Date.now() - started < 60000, 'Runtime startup timed out');
      await delay(100);
    }
    await exerciseIntegration({
      base,
      origin,
      client,
      fixture,
      signal,
      runJob: (name, expectedCode) =>
        command(
          process.execPath,
          [path.join(options.runtime, 'runtime-scripts', name)],
          options.runtime,
          { ...runtimeEnvironment, REPLAY_PRUNE_MAX_BATCHES: '1', HEATMAP_PRUNE_MAX_BATCHES: '1' },
          40000,
          expectedCode,
          signal,
        ),
      record: async (name, operation) => {
        signal.throwIfAborted();
        receipt.stage = name;
        await operation();
        receipt.checks[name] = 'passed';
      },
    });
    receipt.stage = 'graceful-shutdown';
    await stopServer(server);
    signal.throwIfAborted();
    receipt.checks['graceful-shutdown'] = 'passed';
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    let cleanupPassed = true;
    try {
      await stopServer(server);
    } catch {
      cleanupPassed = false;
    }
    try {
      await client?.end();
    } catch {
      cleanupPassed = false;
    }
    if (postgresInitialized) {
      try {
        const pidExists = await fs.stat(path.join(postgresData, 'postmaster.pid')).then(
          () => true,
          () => false,
        );
        if (pidExists)
          await command(
            pgctl,
            ['-D', postgresData, '-m', 'immediate', '-w', 'stop'],
            temporary,
            environment,
            15000,
          );
      } catch {
        cleanupPassed = false;
      }
    }
    if (cleanupPassed) await fs.rm(temporary, { recursive: true });
    receipt.cleanup = cleanupPassed ? 'passed' : 'failed-private-scratch-retained';
    assert(cleanupPassed, 'Fixture cleanup failed');
    receipt.verifiedEntriesAfter = await verifyTree(options.runtime, transport);
  }
}

export async function main(values) {
  const options = parseArguments(values);
  const receipt = {
    schemaVersion: 1,
    kind: 'exact-artifact-synthetic-integration',
    site: options.site,
    commit: profiles[options.site].commit,
    tag: 'v4.2.188',
    archiveSha256: profiles[options.site].archive,
    manifestSha256: profiles[options.site].manifest,
    startedAt: new Date().toISOString(),
    status: 'failed',
    stage: 'signed-input-verification',
    checks: {},
    providerScope: 'Synthetic CAPTCHA transport only; no external provider/TLS acceptance',
    productionAccess: false,
    activationAuthorized: false,
    realOwnerPossession: false,
  };
  try {
    const transport = await verifyBundle(options.assets, options['public-key'], options.site);
    receipt.checks['signed-input-verification'] = 'passed';
    if (options.mode === 'run') {
      receipt.stage = 'runtime-inventory-before';
      receipt.verifiedEntriesBefore = await verifyTree(options.runtime, transport);
      await executeFixture(options, transport, receipt);
      receipt.status = 'synthetic-integration-passed';
    } else {
      receipt.status = 'input-verification-only';
    }
  } catch {
    process.exitCode = 1;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await fs.writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
