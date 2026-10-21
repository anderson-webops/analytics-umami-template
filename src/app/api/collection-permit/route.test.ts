import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCacheToken, parseCacheToken } from '@/lib/cache-token';
import { hasCollectionPermit } from '@/lib/collection-permit';
import { CollectionRequestReplayError } from '@/lib/collection-proof';
import { secret } from '@/lib/crypto';
import { parseRequest } from '@/lib/request';
import {
  getWebsite,
  reserveBackendCollectionRequest,
  withActiveCollectionSource,
} from '@/queries/prisma';
import { POST } from './route';

vi.mock('@/lib/collection-rate-limit', () => ({
  getCollectionIpLimit: vi.fn(async () => ({ blocked: false, retryAfter: 60 })),
}));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/queries/prisma', () => ({
  getWebsite: vi.fn(),
  reserveBackendCollectionRequest: vi.fn(),
  withActiveCollectionSource: vi.fn(),
}));

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WEBSITE_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = 'a'.repeat(43);
const DIGEST = createHash('sha256').update(CREDENTIAL).digest('hex');

function cacheHeader(collectionGeneration?: number) {
  return createCacheToken(
    {
      websiteId: WEBSITE_ID,
      sessionId: '33333333-3333-4333-8333-333333333333',
      visitId: '44444444-4444-4444-8444-444444444444',
      collectionGeneration,
      iat: Math.floor(Date.now() / 1000),
      identityHash: 'a'.repeat(128),
      sessionSalt: 'b'.repeat(128),
    },
    secret(),
    3600,
  );
}

function request(cache: string, authorized = true) {
  return new Request('http://localhost/api/collection-permit', {
    method: 'POST',
    headers: {
      'x-umami-cache': cache,
      'x-umami-request-id': randomUUID(),
      'x-umami-request-timestamp': String(Math.floor(Date.now() / 1000)),
      ...(authorized ? { authorization: `Bearer ${CREDENTIAL}` } : {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_SECRET', 'synthetic-app-secret-000000000000000000');
  vi.stubEnv(
    'COLLECTION_SERVER_KEYS_JSON',
    JSON.stringify({
      [WEBSITE_ID]: [
        {
          sha256: DIGEST,
          scopes: ['recorder'],
          ownerType: 'user',
          ownerId: '44444444-4444-4444-8444-444444444444',
          generation: 0,
        },
      ],
    }),
  );
  vi.mocked(parseRequest).mockResolvedValue({
    body: { website: WEBSITE_ID, feature: 'heatmap', origin: 'https://example.com', consent: true },
    error: undefined,
  } as any);
  vi.mocked(getWebsite).mockResolvedValue({
    id: WEBSITE_ID,
    domain: 'example.com',
    deletedAt: null,
    recorderEnabled: true,
    collectionGeneration: 0,
    replayConfig: { heatmapEnabled: true, replayEnabled: true, maskLevel: 'strict' },
  } as any);
  vi.mocked(reserveBackendCollectionRequest).mockResolvedValue(undefined);
  vi.mocked(withActiveCollectionSource).mockImplementation((_type, websiteId, operation) =>
    operation({ website: { findFirst: () => getWebsite(websiteId) } } as any),
  );
});

afterEach(() => vi.unstubAllEnvs());

test('only a backend credential can mint a session-and-feature-bound permit', async () => {
  const cache = cacheHeader();
  const response = await POST(request(cache));

  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  const { permit } = await response.json();
  const parsedCache = parseCacheToken(cache, secret());
  if (!parsedCache) throw new Error('Expected a valid synthetic cache token.');
  expect(hasCollectionPermit(permit, parsedCache, 'heatmap', 'https://example.com')).toBe(true);
  expect(hasCollectionPermit(permit, parsedCache, 'record', 'https://example.com')).toBe(false);

  expect((await POST(request(cache, false))).status).toBe(403);
  expect(getWebsite).toHaveBeenCalledOnce();
  expect(vi.mocked(withActiveCollectionSource).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(getWebsite).mock.invocationCallOrder[0],
  );
});

test('a changed domain cannot mint a recorder permit or consume its request ID', async () => {
  vi.mocked(getWebsite).mockResolvedValueOnce({
    domain: 'other.example.com',
    collectionGeneration: 0,
    recorderEnabled: true,
    replayConfig: { heatmapEnabled: true, maskLevel: 'strict' },
  } as any);

  const response = await POST(request(cacheHeader()));

  expect(response.status).toBe(400);
  expect(reserveBackendCollectionRequest).not.toHaveBeenCalled();
});

test('a prior-generation public cache cannot mint a recorder permit with a new backend key', async () => {
  vi.stubEnv(
    'COLLECTION_SERVER_KEYS_JSON',
    JSON.stringify({
      [WEBSITE_ID]: [
        {
          sha256: DIGEST,
          scopes: ['recorder'],
          ownerType: 'user',
          ownerId: '44444444-4444-4444-8444-444444444444',
          generation: 1,
        },
      ],
    }),
  );
  vi.mocked(getWebsite).mockResolvedValueOnce({
    id: WEBSITE_ID,
    domain: 'example.com',
    deletedAt: null,
    recorderEnabled: true,
    collectionGeneration: 1,
    replayConfig: { heatmapEnabled: true, maskLevel: 'strict' },
  } as any);

  expect((await POST(request(cacheHeader()))).status).toBe(403);
  expect(reserveBackendCollectionRequest).not.toHaveBeenCalled();
});

test('a current-generation public cache can mint a permit with its rotated backend key', async () => {
  vi.stubEnv(
    'COLLECTION_SERVER_KEYS_JSON',
    JSON.stringify({
      [WEBSITE_ID]: [
        {
          sha256: DIGEST,
          scopes: ['recorder'],
          ownerType: 'user',
          ownerId: '44444444-4444-4444-8444-444444444444',
          generation: 1,
        },
      ],
    }),
  );
  vi.mocked(getWebsite).mockResolvedValueOnce({
    id: WEBSITE_ID,
    domain: 'example.com',
    deletedAt: null,
    recorderEnabled: true,
    collectionGeneration: 1,
    replayConfig: { heatmapEnabled: true, maskLevel: 'strict' },
  } as any);

  expect((await POST(request(cacheHeader(1)))).status).toBe(200);
  expect(reserveBackendCollectionRequest).toHaveBeenCalledOnce();
});

test('a repeated backend permit request cannot mint another permit', async () => {
  vi.mocked(reserveBackendCollectionRequest).mockRejectedValueOnce(
    new CollectionRequestReplayError(),
  );

  const response = await POST(request(cacheHeader()));

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
});

test('an ownership transfer prevents minting a permit with the prior owner key', async () => {
  vi.mocked(withActiveCollectionSource).mockRejectedValueOnce(
    new Error('COLLECTION_KEY_OWNER_CHANGED'),
  );

  const response = await POST(request(cacheHeader()));

  expect(response.status).toBe(403);
  expect(reserveBackendCollectionRequest).not.toHaveBeenCalled();
});

test('wrong website, disabled feature, and unmasked replay cannot mint permits', async () => {
  const cache = cacheHeader();
  vi.mocked(parseRequest).mockResolvedValueOnce({
    body: {
      website: OTHER_WEBSITE_ID,
      feature: 'heatmap',
      origin: 'https://example.com',
      consent: true,
    },
    error: undefined,
  } as any);
  expect((await POST(request(cache))).status).toBe(403);

  vi.mocked(getWebsite).mockResolvedValueOnce({
    id: WEBSITE_ID,
    domain: 'example.com',
    collectionGeneration: 0,
    recorderEnabled: true,
    replayConfig: { heatmapEnabled: false },
  } as any);
  expect((await POST(request(cache))).status).toBe(400);

  vi.mocked(parseRequest).mockResolvedValueOnce({
    body: { website: WEBSITE_ID, feature: 'record', origin: 'https://example.com', consent: true },
    error: undefined,
  } as any);
  vi.mocked(getWebsite).mockResolvedValueOnce({
    id: WEBSITE_ID,
    domain: 'example.com',
    collectionGeneration: 0,
    recorderEnabled: true,
    replayConfig: { replayEnabled: true, maskLevel: 'moderate' },
  } as any);
  expect((await POST(request(cache))).status).toBe(403);
});

test('permit cannot be minted for an unencrypted site origin', async () => {
  vi.mocked(parseRequest).mockResolvedValueOnce({
    body: { website: WEBSITE_ID, feature: 'heatmap', origin: 'http://example.com', consent: true },
    error: undefined,
  } as any);

  expect((await POST(request(cacheHeader()))).status).toBe(400);
});

test('permit request schema requires explicit consent', async () => {
  await POST(request(cacheHeader()));
  const schema = vi.mocked(parseRequest).mock.calls[0][1];

  expect(
    schema.safeParse({
      website: WEBSITE_ID,
      feature: 'record',
      origin: 'https://example.com',
      consent: true,
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({ website: WEBSITE_ID, feature: 'record', origin: 'https://example.com' })
      .success,
  ).toBe(false);
  expect(
    schema.safeParse({
      website: WEBSITE_ID,
      feature: 'record',
      origin: 'https://example.com',
      consent: false,
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      website: WEBSITE_ID,
      feature: 'record',
      origin: 'https://example.com',
      consent: true,
      arbitrary: 'ignored-claim',
    }).success,
  ).toBe(false);
});
