import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseCollectionServerKeys } from './collection-key-config.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const checkEnvScript = fileURLToPath(new URL('./check-env.js', import.meta.url));
const websiteId = 'aaaaaaaa-1111-4111-8111-111111111111';
const otherWebsiteId = 'bbbbbbbb-2222-4222-8222-222222222222';
const digest = 'a'.repeat(64);
const key = {
  sha256: digest,
  scopes: ['identity', 'event'],
  ownerType: 'user',
  ownerId: otherWebsiteId,
  generation: 0,
};
const valid = JSON.stringify({ [websiteId]: [key] });
const invalidConfigurations = [
  '{',
  '[]',
  JSON.stringify({ [websiteId]: [{ sha256: digest, scopes: ['identity'] }] }),
  JSON.stringify({ [websiteId]: [{ ...key, ownerType: 'unknown' }] }),
  JSON.stringify({ [websiteId]: [{ ...key, ownerId: 'not-a-uuid' }] }),
  JSON.stringify({ [websiteId]: [{ ...key, generation: -1 }] }),
  JSON.stringify({ [websiteId]: [{ ...key, generation: 0.5 }] }),
  JSON.stringify({ [websiteId]: [{ ...key, generation: 2_147_483_648 }] }),
  JSON.stringify({ 'not-a-uuid': [{ sha256: digest, scopes: ['identity'] }] }),
  JSON.stringify({ [websiteId.toUpperCase()]: [{ sha256: digest, scopes: ['identity'] }] }),
  JSON.stringify({ [websiteId]: [{ sha256: 123, scopes: ['identity'] }] }),
  JSON.stringify({ [websiteId]: [{ sha256: digest, scopes: ['unknown'] }] }),
  JSON.stringify({ [websiteId]: [{ sha256: digest, scopes: ['event', 'event'] }] }),
  JSON.stringify({ [websiteId]: [{ sha256: digest, scopes: [] }] }),
  JSON.stringify({ [websiteId]: [{ ...key, extra: true }] }),
  JSON.stringify({
    [websiteId]: [{ sha256: digest, scopes: ['event'] }],
    [otherWebsiteId]: [{ sha256: digest, scopes: ['identity'] }],
  }),
  JSON.stringify({
    [websiteId]: Array.from({ length: 9 }, (_, index) => ({
      sha256: index.toString(16).padStart(64, '0'),
      scopes: ['event'],
    })),
  }),
  JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
        [],
      ]),
    ),
  ),
  `${valid}${' '.repeat(16_385)}`,
];

function checkStartup(script, configuration) {
  return spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      DOTENV_CONFIG_PATH: '/dev/null',
      NODE_ENV: 'production',
      APP_SECRET: 'synthetic-app-secret-11111111111111111',
      PUBLIC_URL: 'https://analytics.example',
      CLIENT_IP_HEADER: 'X-Forwarded-For',
      DATABASE_URL:
        'postgresql://synthetic:synthetic-password-0000000000000000@localhost:5432/synthetic',
      ...(configuration === undefined ? {} : { COLLECTION_SERVER_KEYS_JSON: configuration }),
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('collection key configuration accepts only bounded, site-scoped records', () => {
  assert.deepEqual(parseCollectionServerKeys(valid), JSON.parse(valid));
  assert.deepEqual(parseCollectionServerKeys('{}'), {});

  for (const configuration of invalidConfigurations) {
    assert.equal(parseCollectionServerKeys(configuration), null);
  }
});

test('source and bundled production startup reject invalid key configuration without disclosing it', async () => {
  const runsDirectory = path.join(repositoryRoot, '.ai-work', 'runs');
  await mkdir(runsDirectory, { recursive: true });
  const testDirectory = await mkdtemp(path.join(runsDirectory, 'collection-key-config-'));
  const bundledScript = path.join(testDirectory, 'check-env.mjs');

  try {
    await build({
      entryPoints: [checkEnvScript],
      outfile: bundledScript,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      packages: 'bundle',
      banner: {
        js: "import { createRequire as __umamiCreateRequire } from 'node:module'; const require = __umamiCreateRequire(import.meta.url);",
      },
      logLevel: 'silent',
    });

    for (const script of [checkEnvScript, bundledScript]) {
      assert.equal(checkStartup(script, undefined).status, 0);
      assert.equal(checkStartup(script, '').status, 0);
      assert.equal(checkStartup(script, valid).status, 0);

      for (const configuration of invalidConfigurations) {
        const result = checkStartup(script, configuration);
        assert.equal(result.status, 1, path.basename(script));
        assert.match(result.stderr, /COLLECTION_SERVER_KEYS_JSON must contain valid/);
        assert.doesNotMatch(result.stderr, /a{64}|synthetic-password|not-a-uuid/);
      }
    }
  } finally {
    await rm(testDirectory, { recursive: true, force: true });
  }
});
