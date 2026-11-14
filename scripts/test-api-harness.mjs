import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { verifyFixtureEnvironment } from '../tests/api/docker/start.mjs';
import { getApiTestSuite } from './api-test-plan.mjs';

const root = path.resolve(import.meta.dirname, '..');
const startup = path.join(root, 'tests/api/docker/start.mjs');
const fixtureEnvironment = {
  UMAMI_TEST_LOCAL_COMPOSE: '1',
  DATABASE_URL: 'postgresql://umami:umami@db:5432/umami',
  APP_SECRET: 'umami-disposable-api-test-secret-00000000000000',
  KAFKA_HISTORY_ATTESTED_CLEAN: 'true',
  CLICKHOUSE_HISTORY_ATTESTED_CLEAN: 'true',
};

async function withRequestFixture(context, cookiePath, verify) {
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://127.0.0.1');
    outgoing.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/cookie') {
      outgoing.setHeader(
        'Set-Cookie',
        `fixture_session=synthetic; Path=${cookiePath}; HttpOnly; SameSite=Strict`,
      );
    }
    outgoing.end(
      JSON.stringify({
        cookie: incoming.headers.cookie ?? null,
        retained: url.searchParams.get('retained'),
        repeated: url.searchParams.getAll('repeated'),
      }),
    );
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  context.after(() => {
    server.closeAllConnections();
    return new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { request } = await import('@playwright/test');
  const client = await request.newContext({
    baseURL: `http://127.0.0.1:${address.port}`,
    timeout: 3_000,
  });
  context.after(() => client.dispose());
  await verify(client);
}

for (const cookiePath of ['/api', '/api/']) {
  test(`request cookies honor the ${cookiePath} path boundary`, {
    timeout: 10_000,
  }, async context => {
    await withRequestFixture(context, cookiePath, async client => {
      await client.get('/cookie');
      assert.equal(
        (await (await client.get('/api/current')).json()).cookie,
        'fixture_session=synthetic',
      );
      assert.equal((await (await client.get('/apiv2')).json()).cookie, null);
      assert.equal(
        (await (await client.get('/api')).json()).cookie,
        cookiePath === '/api' ? 'fixture_session=synthetic' : null,
      );
    });
  });
}

test('request parameters retain existing URL query entries', { timeout: 10_000 }, async context => {
  await withRequestFixture(context, '/api', async client => {
    const response = await client.get('/echo?retained=yes&repeated=first', {
      params: new URLSearchParams({ repeated: 'second' }),
    });
    const result = await response.json();
    assert.equal(result.retained, 'yes');
    assert.deepEqual(result.repeated, ['first', 'second']);
  });
});

test('the disposable fixture accepts only its exact database and application identity', () => {
  verifyFixtureEnvironment(fixtureEnvironment);
  verifyFixtureEnvironment({
    ...fixtureEnvironment,
    CLICKHOUSE_URL: 'http://umami:umami@clickhouse:8123/umami',
  });
});

for (const [name, value] of [
  ['UMAMI_TEST_LOCAL_COMPOSE', undefined],
  ['UMAMI_TEST_LOCAL_COMPOSE', 'true'],
  ['DATABASE_URL', 'postgresql://umami:umami@localhost:5432/umami'],
  ['DATABASE_URL', 'postgresql://umami:umami@db:5432/another'],
  ['DATABASE_URL', 'postgresql://other:umami@db:5432/umami'],
  ['DATABASE_URL', 'postgresql://umami:other@db:5432/umami'],
  ['DATABASE_URL', 'postgresql://umami:umami@db:5433/umami'],
  ['DATABASE_URL', 'postgresql://umami:umami@db:5432/umami?schema=other'],
  ['DATABASE_URL', 'postgresql://umami:umami@db:5432/umami#fragment'],
  ['DATABASE_URL', 'https://db/umami'],
  ['APP_SECRET', 'another-application-secret-000000000000000000'],
  ['NODE_ENV', 'production'],
  ['DIRECT_DATABASE_URL', fixtureEnvironment.DATABASE_URL],
  ['SKIP_DB_CHECK', '1'],
  ['SKIP_DB_MIGRATION', '1'],
  ['REDIS_URL', 'redis://cache.example.invalid'],
  ['KAFKA_URL', 'kafka.example.invalid'],
  ['KAFKA_BROKER', 'kafka.example.invalid'],
  ['KAFKA_HISTORY_ATTESTED_CLEAN', undefined],
  ['KAFKA_HISTORY_ATTESTED_CLEAN', 'false'],
  ['CLICKHOUSE_HISTORY_ATTESTED_CLEAN', undefined],
  ['CLICKHOUSE_HISTORY_ATTESTED_CLEAN', 'false'],
  ['CLICKHOUSE_URL', 'http://umami:umami@localhost:8123/umami'],
]) {
  test(`the disposable fixture rejects ${name}=${value ?? '(missing)'}`, () => {
    assert.throws(() => verifyFixtureEnvironment({ ...fixtureEnvironment, [name]: value }));
  });
}

test('importing the fixture launcher does not run migrations or start a server', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(startup).href)})`],
    { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('direct startup rejects an unowned environment before any database command', () => {
  const result = spawnSync(process.execPath, [startup], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disposable API fixture/);
});

test('Compose names the dedicated test image without restoring production containers', () => {
  const compose = readFileSync(path.join(root, 'docker-compose.test.yml'), 'utf8');
  assert.match(compose, /dockerfile: tests\/api\/docker\/Dockerfile/);
  assert.match(compose, /UMAMI_TEST_LOCAL_COMPOSE: "1"/);
  assert.match(compose, /127\.0\.0\.1:\$\{UMAMI_TEST_PORT:-3100\}:3000/);
  assert.match(compose, /tmpfs:/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /no-new-privileges:true/);
  assert.equal(existsSync(path.join(root, 'Dockerfile')), false);
  assert.equal(existsSync(path.join(root, 'docker-compose.yml')), false);
});

test('every CI database image is immutable and ClickHouse matches the local fixture', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const images = [...workflow.matchAll(/^\s+image: (.+)$/gm)].map(match => match[1].trim());
  assert.equal(images.length, 4);
  for (const image of images) assert.match(image, /^[A-Za-z0-9._/:+-]+@sha256:[a-f0-9]{64}$/);
  const clickhouse = images.filter(image => image.startsWith('clickhouse/clickhouse-server:'));
  assert.equal(clickhouse.length, 1);
  const compose = readFileSync(path.join(root, 'docker-compose.test.yml'), 'utf8');
  assert.ok(compose.split('\n').some(line => line.trim() === `image: ${clickhouse[0]}`));
});

test('the API image shares the current verified Node and independent tool graphs', () => {
  const fixture = readFileSync(path.join(root, 'tests/api/docker/Dockerfile'), 'utf8');
  const builder = readFileSync(path.join(root, 'deploy/mac-build/Dockerfile'), 'utf8');
  assert.equal(fixture.match(/^FROM (\S+)/m)?.[1], builder.match(/^FROM (\S+)/m)?.[1]);
  assert.match(fixture, /verify-toolchain\.mjs/);
  assert.match(fixture, /--frozen-lockfile/);
  assert.match(fixture, /pnpm run audit:all/);
  assert.match(fixture, /pnpm run audit:prod/);
  assert.match(fixture, /USER node/);
  assert.match(fixture, /disposable-api-tests/);
  assert.match(fixture, /apt-get install --no-install-recommends -y ca-certificates openssl/);
  assert.match(fixture, /--config\.package-import-method=hardlink/);
  assert.ok(fixture.indexOf('RUN pnpm install') < fixture.indexOf('COPY --chown=node:node . .'));
});

test('the full API matrix uses a compiled server rather than an accumulating development compiler', () => {
  const fixture = readFileSync(path.join(root, 'tests/api/docker/Dockerfile'), 'utf8');
  const launcher = readFileSync(startup, 'utf8');
  assert.match(fixture, /pnpm run build:app/);
  assert.match(fixture, /repairStandaloneRuntime/);
  assert.match(fixture, /await copyReplayCssBindings\(appDir\)/);
  assert.match(launcher, /path\.join\(appDir, 'server\.js'\)/);
  assert.doesNotMatch(launcher, /'dev'|--webpack|DISABLE_MEM/);
  assert.match(launcher, /HOSTNAME: '0\.0\.0\.0'/);
  assert.match(launcher, /NODE_ENV: 'production'/);
});

test('the API build context excludes private state and existing installations', () => {
  const context = readFileSync(path.join(root, 'tests/api/docker/Dockerfile.dockerignore'), 'utf8');
  assert.equal(context.split('\n')[0], '**');
  assert.ok(context.split('\n').includes('!.gitignore'));
  for (const pattern of ['**/.ai-work', '**/.git', '**/node_modules', '**/.env*']) {
    assert.ok(context.split('\n').includes(pattern), `Missing context exclusion ${pattern}`);
  }
});

test('kept-stack commands preserve genuine fixture ownership and prohibit an implicit rebuild', () => {
  const launcher = readFileSync(path.join(root, 'scripts/test-api.ts'), 'utf8');
  assert.match(launcher, /upArgs\.push\('--no-build'\)/);
  assert.match(launcher, /same fixture environment: \$\{suite\.reuseCommand\}/);
  assert.equal(getApiTestSuite([], {}).reuseCommand, 'pnpm test:api --no-build --keep');
  assert.equal(
    getApiTestSuite(['--e2e'], {}).reuseCommand,
    'pnpm test:e2e:docker --no-build --keep',
  );
  assert.doesNotMatch(launcher, /Run tests with: PLAYWRIGHT_BASE_URL=/);
});

for (const [args, e2e] of [
  [[], false],
  [['--e2e'], true],
  [['--e2e', '--', '--list'], true],
  [['--', '--e2e'], false],
  [['--grep', '--e2e'], false],
  [['--grep', 'logout', '--e2e'], true],
]) {
  test(`suite selection preserves option boundaries for ${JSON.stringify(args)}`, () => {
    const suite = getApiTestSuite(args, {});
    assert.equal(suite.e2e, e2e);
    assert.equal(suite.projectName, e2e ? 'umami-e2e-test' : 'umami-api-test');
    assert.equal(suite.port, e2e ? '3200' : '3100');
    assert.equal(suite.downCommand, e2e ? 'pnpm test:e2e:docker --down' : 'pnpm test:api:down');
  });
}

test('explicit stack identity is retained for both test suites', () => {
  for (const args of [[], ['--e2e']]) {
    const suite = getApiTestSuite(args, {
      COMPOSE_PROJECT_NAME: 'owned-fixture',
      UMAMI_TEST_PORT: '43100',
    });
    assert.equal(suite.projectName, 'owned-fixture');
    assert.equal(suite.port, '43100');
  }
});

test('synthetic browser credentials are supplied only to a local disposable stack', () => {
  const administrator = JSON.parse(
    readFileSync(path.join(root, 'tests/api/docker/fixture-admin.json'), 'utf8'),
  );
  assert.deepEqual(getApiTestSuite(['--e2e'], {}).browserCredentials, {
    UMAMI_USER: administrator.username,
    UMAMI_PASSWORD: administrator.password,
  });
  assert.deepEqual(getApiTestSuite([], {}).browserCredentials, {});
  assert.deepEqual(
    getApiTestSuite(['--e2e'], { PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:43210' })
      .browserCredentials,
    {},
  );
  assert.deepEqual(
    getApiTestSuite(['--e2e'], { PLAYWRIGHT_BASE_URL: 'https://test.example.invalid' })
      .browserCredentials,
    {},
  );
  const launcher = readFileSync(path.join(root, 'scripts/test-api.ts'), 'utf8');
  assert.match(launcher, /options\.e2e\s*\? suite\.browserCredentials/);
});

test('browser setup verifies a provisioned administrator without default-password mutation', () => {
  const setup = readFileSync(path.join(root, 'tests/e2e/admin.setup.ts'), 'utf8');
  assert.match(setup, /verify the provisioned test administrator/);
  assert.match(setup, /passwordChangeRequired: false/);
  assert.doesNotMatch(setup, /DEFAULT_ADMIN_PASSWORD|\/api\/me\/password/);
});

test('browser logout retains the explicit menu action and separate confirmed-page coverage', () => {
  const helper = readFileSync(path.join(root, 'tests/e2e/helpers.ts'), 'utf8');
  const profile = helper.indexOf("getByRole('button', { name: /^Profile$/i }).click()");
  const menu = helper.indexOf("getByRole('menuitem', { name: /^Logout$/i }).click()");
  const loginRoute = helper.indexOf('toHaveURL(/\\/login$/');
  assert.ok(profile > 0 && menu > profile && loginRoute > menu);
  const confirmedPage = readFileSync(path.join(root, 'tests/e2e/logout.spec.ts'), 'utf8');
  assert.match(confirmedPage, /page\.goto\('\/logout'\)/);
  assert.match(
    confirmedPage,
    /getByRole\('main'\)\s*\.getByRole\('button', \{ name: \/\^Logout\$\/i \}\)\s*\.click\(\)/,
  );
  assert.match(confirmedPage, /status\(\)\)\.toBe\(200\)/);
  assert.match(confirmedPage, /status\(\)\)\.toBe\(401\)/);
});

test('parallel browser user fixtures retain separate identities and supported passwords', async () => {
  const { users } = await import('../tests/e2e/fixtures.ts');
  assert.notEqual(users.teamUserCreate.username, users.userCreate.username);
  for (const user of [users.teamUserCreate, users.userCreate])
    assert.ok(user.password.length >= 12);
});

test('fixture startup and API clients share a provisioned, nondefault synthetic administrator', () => {
  const administrator = JSON.parse(
    readFileSync(path.join(root, 'tests/api/docker/fixture-admin.json'), 'utf8'),
  );
  const launcher = readFileSync(startup, 'utf8');
  const client = readFileSync(path.join(root, 'tests/api/helpers/constants.ts'), 'utf8');
  assert.equal(administrator.username, 'admin');
  assert.ok(administrator.password.length >= 12 && administrator.password.length <= 72);
  assert.match(administrator.password, /synthetic|fixture|test-only|disposable/i);
  assert.notEqual(administrator.password, fixtureEnvironment.APP_SECRET);
  assert.match(launcher, /scripts\/change-password\.js/);
  assert.match(launcher, /UMAMI_PASSWORD: fixtureAdmin\.password/);
  assert.match(launcher, /check-db\.js', '--verify-only'/);
  assert.match(client, /API_TEST_ADMIN_PASSWORD \|\| fixtureAdmin\.password/);
});

test('the approved public fixture exception preserves exact credentials and every other secret check', () => {
  const administrator = JSON.parse(
    readFileSync(path.join(root, 'tests/api/docker/fixture-admin.json'), 'utf8'),
  );
  assert.equal(
    createHash('sha256')
      .update(
        JSON.stringify({ username: administrator.username, password: administrator.password }),
      )
      .digest('hex'),
    'e6b762a43c61387f8cd9929320775afbd99b8a097ae6bbab4416c859476df112',
  );
  const policy = readFileSync(path.join(root, '.gitguardian.yaml'), 'utf8').trimEnd().split('\n');
  assert.deepEqual(policy.slice(0, 3), ['version: 2', 'secret:', '  ignored_matches:']);
  assert.equal(policy.length, 9);
  for (let index = 3; index < policy.length; index += 2) {
    assert.match(policy[index], /^ {4}- name: [A-Za-z0-9 ._-]+$/);
    assert.match(policy[index + 1], /^ {6}match: [a-f0-9]{64}$/);
  }
  assert.deepEqual(
    policy.filter(line => line.startsWith('      match: ')).map(line => line.trim().slice(7)),
    [
      '281a94510feb4d0e2c7391dd461db16f8683c8b324f97129b6d3831c8f488d85',
      'a58a4d9e0116e63f36b8a5be0295067deca4e43bd72e92be2473945cf5f90fd8',
      'c4066fccb80dc1e6e52c976b2f2497ab65f2151127fd83f02a542103d562be7e',
    ],
  );
});
