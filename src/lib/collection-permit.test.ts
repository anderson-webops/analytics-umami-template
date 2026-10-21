import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { createCacheToken, parseCacheToken } from '@/lib/cache-token';
import { secret } from '@/lib/crypto';
import { createCollectionPermit, hasCollectionPermit } from './collection-permit';

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL = 'a'.repeat(43);
const DIGEST = createHash('sha256').update(CREDENTIAL).digest('hex');
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const BINDING = { keyDigest: DIGEST, ownerType: 'user' as const, ownerId: OWNER_ID, generation: 0 };

function setup() {
  vi.stubEnv('APP_SECRET', 'synthetic-app-secret-000000000000000000');
  vi.stubEnv(
    'COLLECTION_SERVER_KEYS_JSON',
    JSON.stringify({
      [WEBSITE_ID]: [
        {
          sha256: DIGEST,
          scopes: ['recorder'],
          ownerType: 'user',
          ownerId: OWNER_ID,
          generation: 0,
        },
      ],
    }),
  );
  const cache = parseCacheToken(
    createCacheToken(
      {
        websiteId: WEBSITE_ID,
        sessionId: '22222222-2222-4222-8222-222222222222',
        visitId: '33333333-3333-4333-8333-333333333333',
        iat: Math.floor(Date.now() / 1000),
        identityHash: 'a'.repeat(128),
        sessionSalt: 'b'.repeat(128),
      },
      secret(),
      3600,
    ),
    secret(),
  );
  if (!cache) throw new Error('Expected synthetic cache token.');
  return cache;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test('permit is bound to active website, session, visit, feature and key', () => {
  const cache = setup();
  const permit = createCollectionPermit(
    cache,
    'record',
    BINDING,
    'https://example.com',
    'example.com',
  );

  expect(hasCollectionPermit(permit, cache, 'record', 'https://example.com')).toBe(true);
  expect(hasCollectionPermit(permit, cache, 'heatmap', 'https://example.com')).toBe(false);
  expect(hasCollectionPermit(permit, cache, 'record', 'https://evil.example')).toBe(false);
  expect(hasCollectionPermit(permit, cache, 'record', null)).toBe(false);
  expect(
    hasCollectionPermit(permit, cache, 'record', 'https://example.com', {
      userId: OWNER_ID,
      teamId: null,
      collectionGeneration: 0,
      domain: 'example.com',
    }),
  ).toBe(true);
  expect(
    hasCollectionPermit(
      permit,
      { ...cache, collectionGeneration: 1 },
      'record',
      'https://example.com',
      {
        userId: OWNER_ID,
        teamId: null,
        collectionGeneration: 0,
        domain: 'example.com',
      },
    ),
  ).toBe(false);
  expect(
    hasCollectionPermit(permit, cache, 'record', 'https://example.com', {
      userId: OWNER_ID,
      teamId: null,
      collectionGeneration: 2,
      domain: 'example.com',
    }),
  ).toBe(false);
  expect(
    hasCollectionPermit(permit, cache, 'record', 'https://example.com', {
      userId: '55555555-5555-4555-8555-555555555555',
      teamId: null,
      collectionGeneration: 1,
      domain: 'example.com',
    }),
  ).toBe(false);
  expect(
    hasCollectionPermit(
      permit,
      { ...cache, visitId: 'another-visit' },
      'record',
      'https://example.com',
    ),
  ).toBe(false);
  expect(
    hasCollectionPermit(
      permit,
      { ...cache, sessionId: 'another-session' },
      'record',
      'https://example.com',
    ),
  ).toBe(false);
  expect(
    hasCollectionPermit(
      permit,
      { ...cache, websiteId: 'other-website' },
      'record',
      'https://example.com',
    ),
  ).toBe(false);

  vi.stubEnv('COLLECTION_SERVER_KEYS_JSON', '{}');
  expect(hasCollectionPermit(permit, cache, 'record', 'https://example.com')).toBe(false);
});

test('permit expires and never accepts public cache or tampering', () => {
  const cache = setup();
  const permit = createCollectionPermit(
    cache,
    'heatmap',
    BINDING,
    'https://example.com',
    'example.com',
  );

  expect(hasCollectionPermit(permit, cache, 'heatmap', 'https://example.com')).toBe(true);
  expect(hasCollectionPermit(permit, cache, 'record', 'https://example.com')).toBe(false);
  expect(hasCollectionPermit('public-cache', cache, 'heatmap', 'https://example.com')).toBe(false);
  expect(hasCollectionPermit(`${permit}a`, cache, 'heatmap', 'https://example.com')).toBe(false);

  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61_000);
  expect(hasCollectionPermit(permit, cache, 'heatmap', 'https://example.com')).toBe(false);
});

test('a domain change invalidates an otherwise valid recorder permit', () => {
  const cache = setup();
  const permit = createCollectionPermit(
    cache,
    'record',
    BINDING,
    'https://example.com',
    'example.com',
  );
  const currentWebsite = {
    userId: OWNER_ID,
    teamId: null,
    collectionGeneration: 0,
    domain: 'other.example.com',
  };

  expect(hasCollectionPermit(permit, cache, 'record', 'https://example.com', currentWebsite)).toBe(
    false,
  );
  expect(
    hasCollectionPermit(permit, cache, 'record', 'https://example.com', {
      ...currentWebsite,
      domain: 'www.example.com',
    }),
  ).toBe(false);
});
