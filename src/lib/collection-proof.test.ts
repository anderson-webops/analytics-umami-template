import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import {
  getBackendCollectionProof,
  getBackendCollectionRequest,
  hasActiveCollectionKey,
  matchesCollectionOwner,
} from './collection-proof';

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WEBSITE_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = 'a'.repeat(43);
const DIGEST = createHash('sha256').update(CREDENTIAL).digest('hex');
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const BINDING = { keyDigest: DIGEST, ownerType: 'user' as const, ownerId: OWNER_ID, generation: 0 };

function request(credential = CREDENTIAL) {
  return new Request('https://analytics.example/api/send', {
    headers: { authorization: `Bearer ${credential}` },
  });
}

function configure(scopes: string[]) {
  vi.stubEnv(
    'COLLECTION_SERVER_KEYS_JSON',
    JSON.stringify({
      [WEBSITE_ID]: [
        { sha256: DIGEST, scopes, ownerType: 'user', ownerId: OWNER_ID, generation: 0 },
      ],
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test('accepts only a matching website, credential, and complete scope set', () => {
  configure(['event', 'revenue']);

  expect(getBackendCollectionProof(request(), WEBSITE_ID, ['event', 'revenue'])).toBe(DIGEST);
  expect(getBackendCollectionProof(request(), WEBSITE_ID, ['identity'])).toBeNull();
  expect(getBackendCollectionProof(request(), OTHER_WEBSITE_ID, ['event'])).toBeNull();
  expect(getBackendCollectionProof(request('b'.repeat(43)), WEBSITE_ID, ['event'])).toBeNull();
  expect(hasActiveCollectionKey(WEBSITE_ID, BINDING, 'event')).toBe(true);
});

test('revocation, omitted configuration, and malformed configuration fail closed', () => {
  configure(['identity']);
  expect(getBackendCollectionProof(request(), WEBSITE_ID, ['identity'])).toBe(DIGEST);

  vi.stubEnv('COLLECTION_SERVER_KEYS_JSON', '{}');
  expect(getBackendCollectionProof(request(), WEBSITE_ID, ['identity'])).toBeNull();
  expect(hasActiveCollectionKey(WEBSITE_ID, BINDING, 'identity')).toBe(false);

  for (const invalid of [
    '',
    '{',
    '[]',
    JSON.stringify({ [WEBSITE_ID]: [{ sha256: DIGEST, scopes: ['unknown'] }] }),
    JSON.stringify({ [WEBSITE_ID]: [{ sha256: DIGEST, scopes: ['event', 'event'] }] }),
    JSON.stringify({
      [WEBSITE_ID]: [{ sha256: DIGEST, scopes: ['event'] }],
      [OTHER_WEBSITE_ID]: [{ sha256: DIGEST, scopes: ['event'] }],
    }),
  ]) {
    vi.stubEnv('COLLECTION_SERVER_KEYS_JSON', invalid);
    expect(getBackendCollectionProof(request(), WEBSITE_ID, ['event'])).toBeNull();
  }
});

test('public cache and claimed Origin are not backend credentials', () => {
  configure(['identity']);

  expect(
    getBackendCollectionProof(
      new Request('https://analytics.example/api/send', {
        headers: { Origin: 'https://example.com', 'x-umami-cache': 'public-cache' },
      }),
      WEBSITE_ID,
      ['identity'],
    ),
  ).toBeNull();
});

test('backend requests require a fresh request ID and timestamp', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  configure(['event']);
  const requestId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const headers = {
    authorization: `Bearer ${CREDENTIAL}`,
    'x-umami-request-id': requestId.toUpperCase(),
    'x-umami-request-timestamp': String(now),
  };
  const makeRequest = (overrides: Record<string, string> = {}) =>
    new Request('https://analytics.example/api/send', { headers: { ...headers, ...overrides } });

  expect(getBackendCollectionRequest(makeRequest(), WEBSITE_ID, ['event'])).toEqual({
    keyDigest: DIGEST,
    ownerType: 'user',
    ownerId: OWNER_ID,
    generation: 0,
    requestId,
  });
  expect(getBackendCollectionRequest(makeRequest(), OTHER_WEBSITE_ID, ['event'])).toBeNull();
  expect(getBackendCollectionRequest(makeRequest(), WEBSITE_ID, ['identity'])).toBeNull();

  for (const overrides of [
    { 'x-umami-request-id': '' },
    { 'x-umami-request-id': 'not-a-uuid' },
    { 'x-umami-request-timestamp': '' },
    { 'x-umami-request-timestamp': String(now - 301) },
    { 'x-umami-request-timestamp': String(now + 301) },
    { 'x-umami-request-timestamp': `${now}.0` },
  ]) {
    expect(getBackendCollectionRequest(makeRequest(overrides), WEBSITE_ID, ['event'])).toBeNull();
  }
});

test('owner changes and return transfers cannot revive an old collection key', () => {
  const originalOwner = { userId: OWNER_ID, teamId: null, collectionGeneration: 0 };
  const newOwner = {
    userId: '55555555-5555-4555-8555-555555555555',
    teamId: null,
    collectionGeneration: 1,
  };

  expect(matchesCollectionOwner(BINDING, originalOwner)).toBe(true);
  expect(matchesCollectionOwner(BINDING, newOwner)).toBe(false);
  expect(matchesCollectionOwner(BINDING, { ...originalOwner, collectionGeneration: 2 })).toBe(
    false,
  );
  expect(
    matchesCollectionOwner(BINDING, { userId: null, teamId: OWNER_ID, collectionGeneration: 0 }),
  ).toBe(false);
});
