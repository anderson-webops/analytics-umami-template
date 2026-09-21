/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptsDirectory, '..');
const expectReady = process.env.RUNTIME_ACCEPTANCE_EXPECT_READY === '1';
const useStartupEntrypoint = process.env.RUNTIME_ACCEPTANCE_USE_STARTUP === '1';
const port = Number(process.env.PORT);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Artifact acceptance requires a valid PORT.');
}

const entrypoint = useStartupEntrypoint
  ? path.join(scriptsDirectory, 'start-production.mjs')
  : path.join(runtimeRoot, 'server.js');
const output = [];
const server = spawn(process.execPath, [entrypoint], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    HOSTNAME: '127.0.0.1',
    UMAMI_BIND_ADDRESS: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', chunk => {
    if (output.reduce((total, value) => total + value.length, 0) < 65_536) {
      output.push(chunk.toString());
    }
  });
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function request(pathname, method = 'GET') {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(2_000),
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Runtime exited before readiness checks completed.\n${output.join('')}`);
    }

    try {
      const response = await request('/healthz');

      if (response.status === 200) {
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }

    await wait(100);
  }

  throw new Error(`Runtime did not start within 30 seconds.\n${output.join('')}`);
}

async function expectProbe(pathname, method, status, body) {
  const response = await request(pathname, method);

  if (response.status !== status) {
    throw new Error(`${method} ${pathname} returned ${response.status}; expected ${status}.`);
  }

  for (const header of ['location', 'set-cookie', 'www-authenticate']) {
    if (response.headers.has(header)) {
      throw new Error(`${method} ${pathname} unexpectedly returned ${header}.`);
    }
  }

  if (response.headers.get('cache-control') !== 'no-store') {
    throw new Error(`${method} ${pathname} did not return Cache-Control: no-store.`);
  }

  const responseBody = await response.text();

  if (responseBody !== body) {
    throw new Error(`${method} ${pathname} returned an unexpected response body.`);
  }
}

async function stopServer() {
  if (server.exitCode !== null) {
    return server.exitCode;
  }

  server.kill('SIGTERM');

  return Promise.race([
    new Promise(resolve => server.once('exit', code => resolve(code ?? 0))),
    wait(10_000).then(() => {
      server.kill('SIGKILL');
      throw new Error('Runtime did not stop within 10 seconds after SIGTERM.');
    }),
  ]);
}

try {
  await waitForServer();
  await expectProbe('/healthz', 'GET', 200, '{"ok":true}');
  await expectProbe('/healthz', 'HEAD', 200, '');
  await expectProbe(
    '/readyz',
    'GET',
    expectReady ? 200 : 503,
    expectReady ? '{"ok":true}' : '{"ok":false}',
  );
  await expectProbe('/readyz', 'HEAD', expectReady ? 200 : 503, '');

  const exitCode = await stopServer();

  // The standalone Next server reports SIGTERM as 128 + 15. The production
  // wrapper forwards the signal and exits cleanly after the child stops.
  const acceptedExitCodes = useStartupEntrypoint ? [0] : [0, 143];

  if (!acceptedExitCodes.includes(exitCode)) {
    throw new Error(`Runtime exited with status ${exitCode}.\n${output.join('')}`);
  }

  console.log('Artifact health, readiness, and graceful-shutdown acceptance passed.');
} catch (error) {
  await stopServer().catch(() => undefined);
  throw error;
}
