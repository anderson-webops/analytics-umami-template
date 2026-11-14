import fixtureAdmin from '../tests/api/docker/fixture-admin.json' with { type: 'json' };

export function getApiTestSuite(argv, environment = process.env) {
  let e2e = false;
  for (let index = 0; index < argv.length && argv[index] !== '--'; index++) {
    if (argv[index] === '--grep') index++;
    else if (argv[index] === '--e2e') e2e = true;
  }
  const command = e2e ? 'pnpm test:e2e:docker' : 'pnpm test:api';
  return {
    e2e,
    projectName: environment.COMPOSE_PROJECT_NAME || (e2e ? 'umami-e2e-test' : 'umami-api-test'),
    port: environment.UMAMI_TEST_PORT || (e2e ? '3200' : '3100'),
    reuseCommand: `${command} --no-build --keep`,
    downCommand: e2e ? `${command} --down` : 'pnpm test:api:down',
    browserCredentials:
      e2e && !environment.PLAYWRIGHT_BASE_URL
        ? { UMAMI_USER: fixtureAdmin.username, UMAMI_PASSWORD: fixtureAdmin.password }
        : {},
  };
}
