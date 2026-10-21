import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Set a deterministic secret before anything reads it so that real crypto/jwt
// helpers used by the route and by the test produce matching tokens.
process.env.APP_SECRET = 'route-send-test-secret-0123456789abcdef';

import { POST as batchPOST } from '@/app/api/batch/route';
import { createCacheToken, parseCacheToken } from '@/lib/cache-token';
import clickhouse from '@/lib/clickhouse';
import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import { CollectionRequestReplayError } from '@/lib/collection-proof';
import { getCollectionIpLimit, getCollectionSourceStatus } from '@/lib/collection-rate-limit';
import { CACHE_TOKEN_TYPE, COLLECTION_TRUST_TIER, EVENT_TYPE } from '@/lib/constants';
import { getSalt, hash, secret } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { createToken, parseToken } from '@/lib/jwt';
import { fetchWebsite } from '@/lib/load';
import { parseRequest } from '@/lib/request';
import {
  reserveActiveCollectionBudget,
  reserveBackendCollectionRequest,
  withActiveCollectionSource,
} from '@/queries/prisma';
import {
  createSession,
  publishSessionLink,
  saveEvent,
  saveSessionData,
  saveSessionLink,
  updateSession,
} from '@/queries/sql';
import { OPTIONS, POST } from './route';

vi.mock('@/lib/clickhouse', () => ({ default: { enabled: false } }));

vi.mock('@/lib/collection-rate-limit', () => ({
  getCollectionIpLimit: vi.fn(async () => ({ blocked: false, retryAfter: 60 })),
  getCollectionSourceStatus: vi.fn(async () => ({ blocked: false, retryAfter: 60 })),
  transferCollectionIpLimit: vi.fn(),
}));

vi.mock('@/lib/detect', () => ({
  getClientInfo: vi.fn(),
  hasBlockedIp: vi.fn(),
}));

vi.mock('@/lib/load', () => ({
  fetchWebsite: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  getLink: vi.fn(async id => ({ id, deletedAt: null })),
  getPixel: vi.fn(async id => ({ id, deletedAt: null })),
  reserveActiveCollectionBudget: vi.fn(async () => admittedWebsite()),
  reserveBackendCollectionRequest: vi.fn(async () => {}),
  withActiveCollectionSource: vi.fn(async (_type, _id, operation) =>
    operation({
      website: {
        findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 0 })),
      },
    }),
  ),
}));

vi.mock('@/queries/sql', () => ({
  createSession: vi.fn(),
  publishSessionLink: vi.fn(),
  saveEvent: vi.fn(),
  saveSessionData: vi.fn(),
  saveSessionLink: vi.fn(),
  updateSession: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getClientInfoMock = vi.mocked(getClientInfo);
const hasBlockedIpMock = vi.mocked(hasBlockedIp);
const fetchWebsiteMock = vi.mocked(fetchWebsite);
const createSessionMock = vi.mocked(createSession);
const saveEventMock = vi.mocked(saveEvent);
const saveSessionDataMock = vi.mocked(saveSessionData);
const saveSessionLinkMock = vi.mocked(saveSessionLink);
const publishSessionLinkMock = vi.mocked(publishSessionLink);
const updateSessionMock = vi.mocked(updateSession);
const reserveActiveCollectionBudgetMock = vi.mocked(reserveActiveCollectionBudget);
const reserveBackendCollectionRequestMock = vi.mocked(reserveBackendCollectionRequest);
const withActiveCollectionSourceMock = vi.mocked(withActiveCollectionSource);

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const admittedWebsite = (collectionGeneration = 0) => ({
  sourceType: 'website' as const,
  sourceId: WEBSITE_ID,
  accountType: 'user' as const,
  accountId: '44444444-4444-4444-8444-444444444444',
  collectionGeneration,
});
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const PIXEL_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_SEED = '44444444-4444-4444-8444-444444444444';
const BACKEND_CREDENTIAL = 'a'.repeat(43);

const defaultClientInfo = {
  ip: '203.0.113.5',
  userAgent: 'Mozilla/5.0',
  device: 'desktop',
  browser: 'chrome',
  os: 'Windows 10',
  country: 'US',
  region: 'US-CA',
  city: 'San Francisco',
};

/**
 * Drives POST by making parseRequest resolve to the given body. Because the
 * route calls parseRequest(request, schema, ...), the schema is still captured
 * on the mock for direct schema assertions.
 */
function callPOST(
  { type, payload }: { type: string; payload: Record<string, any> },
  {
    headers,
    unauthenticated = false,
  }: { headers?: Record<string, string>; unauthenticated?: boolean } = {},
) {
  const normalizedPayload =
    payload.website && !payload.hostname ? { ...payload, hostname: 'example.com' } : payload;
  parseRequestMock.mockResolvedValue({
    body: { type, payload: normalizedPayload },
    error: undefined,
  });

  return POST(
    new Request('http://localhost/api/send', {
      method: 'POST',
      headers: {
        'x-umami-request-id': randomUUID(),
        'x-umami-request-timestamp': String(Math.floor(Date.now() / 1000)),
        ...((type === 'identify' || payload.id || payload.name || payload.data) && !unauthenticated
          ? { authorization: `Bearer ${BACKEND_CREDENTIAL}` }
          : {}),
        ...headers,
      },
    }),
  );
}

async function readCache(response: Response) {
  const body = await response.json();
  const cache = parseCacheToken(body.cache, secret());

  expect(Object.keys(body)).toEqual(['cache']);
  expect(cache).not.toBeNull();

  if (!cache) {
    throw new Error('Expected a valid collection cache token.');
  }

  return cache;
}

function makeCacheToken(overrides: Record<string, any> = {}, ttlSeconds = 3600) {
  return createCacheToken(
    {
      websiteId: WEBSITE_ID,
      sessionId: 'cached-session',
      visitId: 'cached-visit',
      iat: Math.floor(Date.now() / 1000),
      identityHash: hash(''),
      sessionSalt: getSalt(process.env.SALT_ROTATION || 'month', new Date()),
      ...overrides,
    },
    secret(),
    ttlSeconds,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    'COLLECTION_SERVER_KEYS_JSON',
    JSON.stringify({
      [WEBSITE_ID]: [
        {
          sha256: createHash('sha256').update(BACKEND_CREDENTIAL).digest('hex'),
          scopes: ['identity', 'event', 'revenue'],
          ownerType: 'user',
          ownerId: '44444444-4444-4444-8444-444444444444',
          generation: 0,
        },
      ],
    }),
  );
  (clickhouse as any).enabled = false;
  delete process.env.REMOVE_TRAILING_SLASH;
  delete process.env.SALT_ROTATION;

  hasBlockedIpMock.mockReturnValue(false);
  fetchWebsiteMock.mockResolvedValue({
    id: WEBSITE_ID,
    domain: 'example.com',
    collectionGeneration: 0,
  } as any);
  getClientInfoMock.mockResolvedValue({ ...defaultClientInfo } as any);
  createSessionMock.mockResolvedValue(undefined as any);
  saveEventMock.mockResolvedValue(undefined as any);
  saveSessionDataMock.mockResolvedValue(undefined as any);
  saveSessionLinkMock.mockResolvedValue(true);
  publishSessionLinkMock.mockResolvedValue(undefined);
  updateSessionMock.mockResolvedValue(undefined as any);
  reserveActiveCollectionBudgetMock.mockResolvedValue(admittedWebsite());
  reserveBackendCollectionRequestMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test.each([false, true])(
  'property-rich collection is rejected before any persistent write in ClickHouse mode %s',
  async enabled => {
    (clickhouse as any).enabled = enabled;
    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
    reserveActiveCollectionBudgetMock.mockRejectedValueOnce(
      new CollectionBudgetExceededError(86_400),
    );
    const payload = {
      website: WEBSITE_ID,
      url: '/',
      data: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, 'x'])),
    };

    const response = await callPOST(
      { type: 'event', payload },
      { headers: { 'x-real-ip': '192.0.2.10', 'x-forwarded-for': '192.0.2.99' } },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('86400');
    expect(reserveActiveCollectionBudgetMock).toHaveBeenCalledWith(
      'website',
      WEBSITE_ID,
      { type: 'event', payload: { ...payload, hostname: 'example.com' } },
      '192.0.2.10',
      'backend',
      expect.objectContaining({
        keyDigest: createHash('sha256').update(BACKEND_CREDENTIAL).digest('hex'),
        requestId: expect.any(String),
      }),
      !enabled,
    );
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(saveEventMock).not.toHaveBeenCalled();
  },
);

test('a prior-owner key cannot reserve backend collection or write after transfer', async () => {
  reserveActiveCollectionBudgetMock.mockRejectedValueOnce(
    new Error('COLLECTION_KEY_OWNER_CHANGED'),
  );
  const deniedAtAdmission = await callPOST({
    type: 'identify',
    payload: { website: WEBSITE_ID, id: 'verified-user' },
  });

  expect(deniedAtAdmission.status).toBe(403);
  expect(withActiveCollectionSourceMock).not.toHaveBeenCalled();

  withActiveCollectionSourceMock.mockRejectedValueOnce(new Error('COLLECTION_KEY_OWNER_CHANGED'));
  const deniedAtWrite = await callPOST({
    type: 'identify',
    payload: { website: WEBSITE_ID, id: 'verified-user' },
  });

  expect(deniedAtWrite.status).toBe(403);
  expect(saveSessionLinkMock).not.toHaveBeenCalled();
});

describe('parseRequest error handling', () => {
  test('returns the parseRequest error response and does not process the event', async () => {
    parseRequestMock.mockResolvedValue({
      body: undefined,
      error: () => Response.json({ error: { code: 'bad-request', status: 400 } }, { status: 400 }),
    });

    const response = await POST(new Request('http://localhost/api/send', { method: 'POST' }));

    expect(response.status).toBe(400);
    expect(getCollectionIpLimit).toHaveBeenCalledOnce();
    expect(vi.mocked(getCollectionIpLimit).mock.invocationCallOrder[0]).toBeLessThan(
      parseRequestMock.mock.invocationCallOrder[0],
    );
    expect(saveEventMock).not.toHaveBeenCalled();
    expect(getClientInfoMock).not.toHaveBeenCalled();
  });

  test('rejects a blocked IP without parsing the request body', async () => {
    vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

    const response = await POST(new Request('http://localhost/api/send', { method: 'POST' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(parseRequestMock).not.toHaveBeenCalled();
    expect(getCollectionSourceStatus).not.toHaveBeenCalled();
  });

  test('calls parseRequest with skipAuth so tracker requests are unauthenticated', async () => {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(parseRequestMock.mock.calls[0][2]).toEqual({
      skipAuth: true,
      maxBodyBytes: 128 * 1024,
    });
  });
});

describe('schema validation', () => {
  // The schema is passed to parseRequest; grab it and exercise safeParse directly.
  async function getSchema() {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });
    return parseRequestMock.mock.calls[0][1] as {
      safeParse: (value: unknown) => { success: boolean };
    };
  }

  test('rejects ignored identity and advanced fields instead of accepting them as pageviews', async () => {
    const schema = await getSchema();
    const payload = { website: WEBSITE_ID, hostname: 'example.com', url: '/' };

    expect(schema.safeParse({ type: 'event', payload }).success).toBe(true);
    expect(
      schema.safeParse({ type: 'event', payload: { ...payload, id: 'claimed-user' } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'event', payload: { ...payload, name: 'signup', id: 'user-42' } })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ type: 'event', payload: { ...payload, userId: 'claimed-user' } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'event', payload: { ...payload, data: { plan: 'private' } } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'performance', payload: { ...payload, id: 'claimed-user' } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'performance', payload: { ...payload, data: { plan: 'private' } } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'identify', payload: { ...payload, name: 'ignored-event' } })
        .success,
    ).toBe(false);
  });

  test('rejects an invalid type enum value', async () => {
    const schema = await getSchema();

    expect(schema.safeParse({ type: 'bogus', payload: { website: WEBSITE_ID } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        type: 'event',
        payload: { website: WEBSITE_ID, hostname: 'example.com' },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        type: 'identify',
        payload: { website: WEBSITE_ID, hostname: 'example.com' },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        type: 'performance',
        payload: { website: WEBSITE_ID, hostname: 'example.com' },
      }).success,
    ).toBe(true);
  });

  test('requires exactly one of website, link, or pixel', async () => {
    const schema = await getSchema();

    // zero set -> invalid
    expect(schema.safeParse({ type: 'event', payload: {} }).success).toBe(false);
    // one set -> valid
    expect(
      schema.safeParse({
        type: 'event',
        payload: { website: WEBSITE_ID, hostname: 'example.com' },
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ type: 'event', payload: { link: LINK_ID } }).success).toBe(true);
    expect(schema.safeParse({ type: 'event', payload: { pixel: PIXEL_ID } }).success).toBe(true);
    // two set -> invalid
    expect(
      schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID, link: LINK_ID } }).success,
    ).toBe(false);
    // all three set -> invalid
    expect(
      schema.safeParse({
        type: 'event',
        payload: { website: WEBSITE_ID, link: LINK_ID, pixel: PIXEL_ID },
      }).success,
    ).toBe(false);
  });

  test('rejects CSV formula injection triggers in name and tag', async () => {
    const schema = await getSchema();

    for (const bad of [
      '=1+1',
      '+cmd',
      '-2',
      '@SUM',
      '\tvalue',
      '\rvalue',
      '\n=1+1',
      '\r\n@SUM',
      ' \t\n+cmd',
      '\u200b=1+1',
    ]) {
      expect(
        schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID, name: bad } }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID, tag: bad } }).success,
      ).toBe(false);
    }

    // A safe leading character passes.
    expect(
      schema.safeParse({
        type: 'event',
        payload: { website: WEBSITE_ID, hostname: 'example.com', name: 'signup' },
      }).success,
    ).toBe(true);
  });

  test('enforces web vitals numeric bounds', async () => {
    const schema = await getSchema();

    expect(
      schema.safeParse({ type: 'performance', payload: { website: WEBSITE_ID, lcp: -1 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'performance', payload: { website: WEBSITE_ID, lcp: 60001 } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'performance', payload: { website: WEBSITE_ID, cls: 101 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        type: 'performance',
        payload: { website: WEBSITE_ID, hostname: 'example.com', lcp: 2500 },
      }).success,
    ).toBe(true);
  });

  test('accepts only a bounded UUID session seed', async () => {
    const schema = await getSchema();
    const payload = { website: WEBSITE_ID, hostname: 'example.com', sessionSeed: SESSION_SEED };

    expect(schema.safeParse({ type: 'event', payload }).success).toBe(true);
    expect(
      schema.safeParse({ type: 'event', payload: { ...payload, sessionSeed: 'shared-device' } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'event', payload: { ...payload, sessionSeed: 'x'.repeat(1024) } })
        .success,
    ).toBe(false);
  });
});

describe('bot classification', () => {
  test('persists the bot classification returned by client detection', async () => {
    getClientInfoMock.mockResolvedValue({
      ...defaultClientInfo,
      isBot: true,
      botName: 'test-bot',
      botCategory: 'crawler',
    } as any);

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(200);
    expect(saveEventMock.mock.calls[0][0]).toMatchObject({
      isBot: true,
      botName: 'test-bot',
      botCategory: 'crawler',
    });
  });
});

describe('IP blocklist', () => {
  test('returns an empty 204 when the client IP is blocked', async () => {
    hasBlockedIpMock.mockReturnValue(true);

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
    expect(saveEventMock).not.toHaveBeenCalled();
    expect(reserveActiveCollectionBudgetMock).not.toHaveBeenCalled();
  });
});

describe('website lookup', () => {
  test('returns 400 when the website does not exist', async () => {
    fetchWebsiteMock.mockResolvedValue(null as any);

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Tracking source not found.', status: 400 },
    });
    expect(saveEventMock).not.toHaveBeenCalled();
    expect(getCollectionIpLimit).toHaveBeenCalledOnce();
    expect(reserveActiveCollectionBudgetMock).not.toHaveBeenCalled();
  });

  test('does not look up or count a source after the IP limit is reached', async () => {
    vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

    const response = await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(fetchWebsiteMock).not.toHaveBeenCalled();
    expect(getCollectionSourceStatus).not.toHaveBeenCalled();
    expect(reserveActiveCollectionBudgetMock).not.toHaveBeenCalled();
  });

  test('does not repeat a lookup when a verified source is already throttled', async () => {
    vi.mocked(getCollectionSourceStatus).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

    const response = await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(response.status).toBe(429);
    expect(fetchWebsiteMock).not.toHaveBeenCalled();
    expect(reserveActiveCollectionBudgetMock).not.toHaveBeenCalled();
  });

  test('counts a source only after its identity is verified', async () => {
    const response = await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(response.status).toBe(200);
    expect(getCollectionSourceStatus).toHaveBeenCalledWith(WEBSITE_ID);
    expect(reserveActiveCollectionBudgetMock).toHaveBeenCalledWith(
      'website',
      WEBSITE_ID,
      expect.anything(),
      expect.any(String),
      'anonymous',
    );
    expect(vi.mocked(getCollectionIpLimit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(getCollectionSourceStatus).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(getCollectionSourceStatus).mock.invocationCallOrder[0]).toBeLessThan(
      fetchWebsiteMock.mock.invocationCallOrder[0],
    );
    expect(fetchWebsiteMock.mock.invocationCallOrder[0]).toBeLessThan(
      reserveActiveCollectionBudgetMock.mock.invocationCallOrder[0],
    );
  });

  test('a bearer header cannot turn an ordinary browser pageview into backend admission', async () => {
    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { authorization: `Bearer ${BACKEND_CREDENTIAL}` } },
    );

    expect(response.status).toBe(200);
    expect(reserveActiveCollectionBudgetMock).toHaveBeenCalledWith(
      'website',
      WEBSITE_ID,
      expect.anything(),
      expect.any(String),
      'anonymous',
    );
  });

  test('normalizes UUID spelling before source lookup and persistent budget accounting', async () => {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });
    const schema = parseRequestMock.mock.calls[0][1];
    const mixedCaseId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const parsed = schema.parse({
      type: 'event',
      payload: { website: mixedCaseId, hostname: 'example.com', url: '/' },
    });

    expect(parsed.payload.website).toBe(mixedCaseId.toLowerCase());
  });

  test('does not look up a website for link events', async () => {
    await callPOST({ type: 'event', payload: { link: LINK_ID, url: '/' } });

    expect(fetchWebsiteMock).not.toHaveBeenCalled();
  });
});

describe('session creation', () => {
  test('creates a session when clickhouse is disabled and there is no cache', async () => {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock.mock.calls[0][0]).toMatchObject({
      websiteId: WEBSITE_ID,
      browser: 'chrome',
      os: 'Windows 10',
      device: 'desktop',
    });
  });

  test('does not create a session when clickhouse is enabled', async () => {
    (clickhouse as any).enabled = true;

    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(createSessionMock).not.toHaveBeenCalled();
  });
});

describe('eventType selection ladder', () => {
  test('link events use the linkEvent type', async () => {
    await callPOST({ type: 'event', payload: { link: LINK_ID, url: '/' } });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ eventType: EVENT_TYPE.linkEvent });
  });

  test('pixel events use the pixelEvent type', async () => {
    await callPOST({ type: 'event', payload: { pixel: PIXEL_ID, url: '/' } });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ eventType: EVENT_TYPE.pixelEvent });
  });

  test.each([
    { sourceType: 'link' as const, sourceId: LINK_ID },
    { sourceType: 'pixel' as const, sourceId: PIXEL_ID },
  ])('$sourceType events reject an owner change after budget admission', async source => {
    const admission = {
      ...admittedWebsite(),
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      collectionGeneration: null,
    };
    reserveActiveCollectionBudgetMock.mockResolvedValueOnce(admission);
    withActiveCollectionSourceMock.mockRejectedValueOnce(new Error('COLLECTION_SOURCE_CHANGED'));

    const response = await callPOST({
      type: 'event',
      payload: { [source.sourceType]: source.sourceId, url: '/' },
    });

    expect(response.status).toBe(409);
    expect(withActiveCollectionSourceMock).toHaveBeenCalledWith(
      source.sourceType,
      source.sourceId,
      expect.any(Function),
      undefined,
      admission,
    );
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test('named website events use the customEvent type', async () => {
    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/', name: 'signup' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({
      eventType: EVENT_TYPE.customEvent,
      eventName: 'signup',
    });
  });

  test('unnamed website events use the pageView type', async () => {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ eventType: EVENT_TYPE.pageView });
  });
});

describe('event url and referrer parsing', () => {
  test('extracts url path, query, domain and referrer fields', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/products?utm_source=news&gclid=abc',
        referrer: 'https://www.google.com/search?q=umami',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({
      hostname: 'example.com',
      urlPath: '/products',
      urlQuery: 'utm_source=news&gclid=abc',
      utmSource: 'news',
      gclid: 'abc',
      referrerPath: '/search',
      referrerQuery: '',
      referrerDomain: 'google.com',
    });
  });

  test('does not persist private page or referrer query values and fragments', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/reset?token=SYNTHETIC-SECRET&utm_source=news#private-fragment',
        referrer: 'https://search.example/results?q=SYNTHETIC-REFERRER#private-referrer',
      },
    });

    const saved = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(saved).toMatchObject({
      urlPath: '/reset',
      urlQuery: 'utm_source=news',
      utmSource: 'news',
      referrerPath: '/results',
      referrerQuery: '',
      referrerDomain: 'search.example',
    });
    expect(JSON.stringify(saved)).not.toContain('SYNTHETIC-SECRET');
    expect(JSON.stringify(saved)).not.toContain('SYNTHETIC-REFERRER');
    expect(JSON.stringify(saved)).not.toContain('private-fragment');
  });

  test('retains a paid click identifier without storing unrelated query data', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        url: '/landing?dclid=click-1&token=SYNTHETIC-SECRET',
      },
    });

    const saved = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(saved.urlQuery).toBe('dclid=click-1');
    expect(JSON.stringify(saved)).not.toContain('SYNTHETIC-SECRET');
  });

  test('does not save referrer domain when it matches the hostname', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/products',
        referrer: 'https://www.example.com/prev?a=1',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({
      referrerPath: '/prev',
      referrerQuery: '',
    });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('does not save referrer domain for a path-only referrer', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/products',
        referrer: '/prev?a=1',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({
      referrerPath: '/prev',
      referrerQuery: '',
    });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('saves referrer domain for a lookalike domain that only shares a prefix', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/products',
        referrer: 'https://example.com.br/page',
      },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({
      referrerDomain: 'example.com.br',
      referrerPath: '/page',
    });
  });

  test('resolves a path-only referrer against the url domain when hostname is missing', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        url: 'https://example.com/products',
        referrer: '/prev',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({ referrerPath: '/prev' });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('does not save referrer domain when hostname differs only by case', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'EXAMPLE.com',
        url: '/products',
        referrer: 'https://example.com/prev',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({ referrerPath: '/prev' });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('does not save referrer domain when hostname includes a port', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com:8443',
        url: '/products',
        referrer: 'https://example.com:8443/prev',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({ referrerPath: '/prev' });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('REMOVE_TRAILING_SLASH strips a trailing slash from the url path', async () => {
    process.env.REMOVE_TRAILING_SLASH = '1';

    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/blog/' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '/blog' });
  });

  test('REMOVE_TRAILING_SLASH keeps the root path as "/"', async () => {
    process.env.REMOVE_TRAILING_SLASH = '1';

    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '/' });
  });

  test('REMOVE_TRAILING_SLASH keeps the root path after removing a hash', async () => {
    process.env.REMOVE_TRAILING_SLASH = '1';

    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/#hero' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '/' });
  });

  test('REMOVE_TRAILING_SLASH strips a trailing slash after removing a hash', async () => {
    process.env.REMOVE_TRAILING_SLASH = '1';

    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/blog/#hero' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '/blog' });
  });

  test('maps a "/undefined" pathname to an empty url path', async () => {
    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/undefined' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '' });
  });
});

describe('cache token handling', () => {
  test('a recreated website does not reuse a public session or visit from its prior generation', async () => {
    const token = makeCacheToken({ sessionId: 'prior-session', visitId: 'prior-visit' });
    reserveActiveCollectionBudgetMock.mockResolvedValueOnce(admittedWebsite(1));
    withActiveCollectionSourceMock.mockImplementationOnce(async (_type, _id, operation) =>
      operation({
        website: {
          findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 1 })),
        },
      } as any),
    );
    fetchWebsiteMock.mockResolvedValueOnce({
      id: WEBSITE_ID,
      domain: 'example.com',
      collectionGeneration: 1,
    } as any);

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(response.status).toBe(200);
    expect(createSessionMock).toHaveBeenCalledOnce();
    const savedEvent = saveEventMock.mock.calls[0][0] as Record<string, any>;
    const cache = await readCache(response);
    expect(savedEvent.sessionId).not.toBe('prior-session');
    expect(savedEvent.visitId).not.toBe('prior-visit');
    expect(cache.sessionId).toBe(savedEvent.sessionId);
    expect(cache.collectionGeneration).toBe(1);
  });

  test('a browser session seed cannot select the prior generation session after recreation', async () => {
    const first = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED },
    });
    const oldSessionId = saveEventMock.mock.calls[0][0].sessionId;
    const oldCache = (await first.json()).cache;

    reserveActiveCollectionBudgetMock.mockResolvedValueOnce(admittedWebsite(1));
    withActiveCollectionSourceMock.mockImplementationOnce(async (_type, _id, operation) =>
      operation({
        website: {
          findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 1 })),
        },
      } as any),
    );

    const second = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED } },
      { headers: { 'x-umami-cache': oldCache } },
    );

    expect(second.status).toBe(200);
    expect(saveEventMock.mock.calls[1][0].sessionId).not.toBe(oldSessionId);
    expect((await readCache(second)).collectionGeneration).toBe(1);
  });

  test('a rotated backend credential cannot select the prior verified session generation', async () => {
    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/', name: 'signup', sessionSeed: SESSION_SEED },
    });
    const oldSessionId = saveEventMock.mock.calls[0][0].sessionId;

    vi.stubEnv(
      'COLLECTION_SERVER_KEYS_JSON',
      JSON.stringify({
        [WEBSITE_ID]: [
          {
            sha256: createHash('sha256').update(BACKEND_CREDENTIAL).digest('hex'),
            scopes: ['event'],
            ownerType: 'user',
            ownerId: '44444444-4444-4444-8444-444444444444',
            generation: 1,
          },
        ],
      }),
    );
    reserveActiveCollectionBudgetMock.mockResolvedValueOnce(admittedWebsite(1));
    withActiveCollectionSourceMock.mockImplementationOnce(async (_type, _id, operation) =>
      operation({
        website: {
          findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 1 })),
        },
      } as any),
    );

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/', name: 'signup', sessionSeed: SESSION_SEED },
    });

    expect(response.status).toBe(200);
    expect(saveEventMock.mock.calls[1][0].sessionId).not.toBe(oldSessionId);
  });

  test('the current generation may reuse its matching public session and visit', async () => {
    const token = makeCacheToken({ collectionGeneration: 1 });
    reserveActiveCollectionBudgetMock.mockResolvedValueOnce(admittedWebsite(1));
    withActiveCollectionSourceMock.mockImplementationOnce(async (_type, _id, operation) =>
      operation({
        website: {
          findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 1 })),
        },
      } as any),
    );
    fetchWebsiteMock.mockResolvedValueOnce({
      id: WEBSITE_ID,
      domain: 'example.com',
      collectionGeneration: 1,
    } as any);

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(response.status).toBe(200);
    expect(createSessionMock).not.toHaveBeenCalled();
    expect((await readCache(response)).visitId).toBe('cached-visit');
  });

  test.each([false, true])(
    'a generation change after budget reservation rejects the write under the source lock with ClickHouse %s',
    async enabled => {
      (clickhouse as any).enabled = enabled;
      withActiveCollectionSourceMock.mockImplementationOnce(async (_type, _id, operation) =>
        operation({
          website: {
            findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 1 })),
          },
        } as any),
      );

      const response = await callPOST({
        type: 'event',
        payload: { website: WEBSITE_ID, url: '/' },
      });

      expect(response.status).toBe(409);
      expect(saveEventMock).not.toHaveBeenCalled();
      expect(createSessionMock).not.toHaveBeenCalled();
    },
  );

  test('a valid cache token revalidates the website without recreating the matching session', async () => {
    const token = makeCacheToken();

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(fetchWebsiteMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).not.toHaveBeenCalled();
    expect((await readCache(response)).visitId).toBe('cached-visit');
  });

  test('accepts an existing cache token with an alternate UUID spelling', async () => {
    const token = makeCacheToken({ websiteId: WEBSITE_ID.toUpperCase() });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(response.status).toBe(200);
    expect(reserveActiveCollectionBudgetMock).toHaveBeenCalledWith(
      'website',
      WEBSITE_ID,
      expect.anything(),
      expect.any(String),
      'anonymous',
    );
  });

  test('a valid cache token creates the computed session before event writes when the cached session differs', async () => {
    const token = makeCacheToken({ sessionId: 'cached-session' });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const createdSession = createSessionMock.mock.calls[0][0] as Record<string, any>;
    const savedEvent = saveEventMock.mock.calls[0][0] as Record<string, any>;
    const cache = await readCache(response);

    expect(createdSession.id).not.toBe('cached-session');
    expect(savedEvent.sessionId).toBe(createdSession.id);
    expect(savedEvent.visitId).not.toBe('cached-visit');
    expect(cache.sessionId).toBe(createdSession.id);
    expect(cache.visitId).toBe(savedEvent.visitId);
  });

  test('a browser cache token cannot select the verified identity session', async () => {
    const token = makeCacheToken({ sessionId: 'cached-session' });

    const response = await callPOST(
      { type: 'identify', payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const createdSession = createSessionMock.mock.calls[0][0] as Record<string, any>;
    const savedLink = saveSessionLinkMock.mock.calls[0][0] as Record<string, any>;
    const updatedSession = updateSessionMock.mock.calls[0][0] as Record<string, any>;
    const savedSessionData = saveSessionDataMock.mock.calls[0][0] as Record<string, any>;
    expect(createdSession.id).not.toBe('cached-session');
    expect(savedLink.sessionId).toBe(createdSession.id);
    expect(updatedSession.sessionId).toBe(createdSession.id);
    expect(savedSessionData.sessionId).toBe(createdSession.id);
    expect(await response.json()).toEqual({ cache: null });
    expect(savedLink.sessionId).not.toBe('cached-session');
  });

  test('a drifted cache token resets the visit in clickhouse mode without creating a session row', async () => {
    (clickhouse as any).enabled = true;
    const token = makeCacheToken({ sessionId: 'cached-session' });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED } },
      { headers: { 'x-umami-cache': token } },
    );

    const savedEvent = saveEventMock.mock.calls[0][0] as Record<string, any>;
    const cache = await readCache(response);

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(savedEvent.sessionId).toBe(cache.sessionId);
    expect(savedEvent.visitId).not.toBe('cached-visit');
    expect(cache.visitId).toBe(savedEvent.visitId);
  });

  test('an invalid cache token falls back to website lookup', async () => {
    await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': 'not-a-jwt' } },
    );

    expect(fetchWebsiteMock).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])(
    'separates browsers with the same IP and User-Agent without tracker storage in ClickHouse mode %s',
    async enabled => {
      (clickhouse as any).enabled = enabled;
      const first = await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });
      const second = await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });
      const firstCache = await readCache(first);
      const secondCache = await readCache(second);

      expect(firstCache.sessionId).not.toBe(secondCache.sessionId);
      expect(firstCache.visitId).not.toBe(secondCache.visitId);
      expect(createSessionMock).toHaveBeenCalledTimes(enabled ? 0 : 2);
      expect(saveEventMock).toHaveBeenCalledTimes(2);
    },
  );

  test('separates two tracker tabs behind the same IP and User-Agent', async () => {
    const first = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED },
    });
    const second = await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        url: '/',
        sessionSeed: '55555555-5555-4555-8555-555555555555',
      },
    });
    const firstCache = await readCache(first);
    const secondCache = await readCache(second);

    expect(firstCache.sessionId).not.toBe(secondCache.sessionId);
    expect(firstCache.visitId).not.toBe(secondCache.visitId);
  });

  test('does not return a reusable public cache for a verified identity', async () => {
    const token = makeCacheToken();
    const response = await callPOST(
      { type: 'identify', payload: { website: WEBSITE_ID, id: 'new-visitor' } },
      { headers: { 'x-umami-cache': token } },
    );
    expect(createSessionMock.mock.calls[0][0].id).not.toBe('cached-session');
    expect(await response.json()).toEqual({ cache: null });
  });

  test('keeps one browser session across requests using its tracker seed', async () => {
    const first = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED },
    });
    const firstCache = await readCache(first.clone());
    const second = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED } },
      { headers: { 'x-umami-cache': ((await first.json()) as { cache: string }).cache } },
    );
    const secondCache = await readCache(second);

    expect(secondCache.sessionId).toBe(firstCache.sessionId);
    expect(secondCache.visitId).toBe(firstCache.visitId);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(saveEventMock.mock.calls[0][0]).not.toHaveProperty('sessionSeed');
    expect(firstCache).not.toHaveProperty('sessionSeed');
  });

  test('preserves established link-event identity without issuing replay tokens', async () => {
    const first = await callPOST({ type: 'event', payload: { link: LINK_ID, url: '/' } });
    const second = await callPOST({ type: 'event', payload: { link: LINK_ID, url: '/' } });

    expect(await first.json()).toEqual({ cache: null });
    expect(await second.json()).toEqual({ cache: null });
    expect(saveEventMock.mock.calls[0][0].sessionId).toBe(saveEventMock.mock.calls[1][0].sessionId);
  });

  test('rejects pre-fix cache identities and creates a fresh session', async () => {
    const legacy = createToken(
      {
        type: CACHE_TOKEN_TYPE,
        websiteId: WEBSITE_ID,
        sessionId: 'old-shared-session',
        visitId: 'old-visit',
        iat: Math.floor(Date.now() / 1000),
      },
      secret(),
      { expiresIn: 3600 },
    );
    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': legacy } },
    );
    const newCache = await readCache(response);

    expect(newCache.sessionId).not.toBe('old-shared-session');
    expect(newCache.visitId).not.toBe('old-visit');
    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });

  test('a token with a non-cache type is ignored', async () => {
    const token = createToken(
      { type: 'share', websiteId: WEBSITE_ID, sessionId: 's', visitId: 'v', iat: 1 },
      secret(),
    );

    await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(fetchWebsiteMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });

  test('an expired cache token is treated as absent', async () => {
    const token = createToken(
      {
        type: CACHE_TOKEN_TYPE,
        websiteId: WEBSITE_ID,
        sessionId: 'cached-session',
        visitId: 'cached-visit',
      },
      secret(),
      { expiresIn: -10 },
    );

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(fetchWebsiteMock).toHaveBeenCalledTimes(1);
    // A fresh visitId is generated rather than reusing the token's value.
    expect((await readCache(response)).visitId).not.toBe('cached-visit');
  });

  test('returns an opaque cache token that preserves the recorded identifiers', async () => {
    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    const body = (await response.json()) as Record<string, any>;
    const decoded = parseCacheToken(body.cache, secret());

    expect(Object.keys(body)).toEqual(['cache']);
    expect(parseToken(body.cache, secret())).toBeNull();
    if (!decoded) {
      throw new Error('Expected a valid collection cache token.');
    }
    expect(decoded.type).toBe(CACHE_TOKEN_TYPE);
    expect(decoded.sessionId).toBe(saveEventMock.mock.calls[0][0].sessionId);
    expect(decoded.visitId).toBe(saveEventMock.mock.calls[0][0].visitId);
    expect(decoded.websiteId).toBe(WEBSITE_ID);
  });
});

describe('collector response privacy', () => {
  test('preflight allows the tracker headers without exposing a collection response', () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Umami-Website-Id');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('an approved browser origin receives only an opaque cache token', async () => {
    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { Origin: 'https://example.com' } },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(response.headers.get('Vary')).toContain('Origin');
    expect(Object.keys(body)).toEqual(['cache']);
    expect(parseToken(body.cache, secret())).toBeNull();
  });

  test('the www alias is readable only by that exact approved origin', async () => {
    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { Origin: 'https://www.example.com' } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.example.com');
    expect(await readCache(response)).toMatchObject({ websiteId: WEBSITE_ID });
  });

  test('server callers without Origin receive no browser-readable CORS grant', async () => {
    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await readCache(response)).toMatchObject({ websiteId: WEBSITE_ID });
  });

  test.each([{ link: LINK_ID }, { pixel: PIXEL_ID }])(
    'link and pixel events retain public CORS without a website session token: %s',
    async source => {
      const response = await callPOST(
        { type: 'event', payload: { ...source, url: '/' } },
        { headers: { Origin: 'https://unrelated.example' } },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      await expect(response.json()).resolves.toEqual({ cache: null });
    },
  );

  test.each([
    'https://unrelated.example',
    'null',
    'https://example.com.evil.test',
    'http://example.com:3000',
  ])('rejects a claimed website hostname from an unrelated browser origin: %s', async origin => {
    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { Origin: origin } },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(reserveActiveCollectionBudgetMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(saveEventMock).not.toHaveBeenCalled();
  });
});

describe('anonymous authoritative collection boundary', () => {
  async function callBatch(
    items: Array<{ type: string; payload: Record<string, unknown> }>,
    headers: Record<string, string> = {},
  ) {
    parseRequestMock.mockImplementation(async (request, requestSchema) => ({
      body: requestSchema.parse(await request.json()),
      error: undefined,
    }));

    try {
      return await batchPOST(
        new Request('http://localhost/api/batch', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-umami-request-id': randomUUID(),
            'x-umami-request-timestamp': String(Math.floor(Date.now() / 1000)),
            ...headers,
          },
          body: JSON.stringify(items),
        }),
      );
    } finally {
      parseRequestMock.mockReset();
    }
  }

  test.each([false, true])(
    'a repeated authorized event is rejected before another write in ClickHouse mode %s',
    async enabled => {
      (clickhouse as any).enabled = enabled;
      const requestId = randomUUID();
      const headers = { 'x-umami-request-id': requestId };
      const event = { type: 'event', payload: { website: WEBSITE_ID, url: '/', name: 'signup' } };

      const first = await callPOST(event, { headers });
      const reservation = enabled
        ? reserveActiveCollectionBudgetMock
        : reserveBackendCollectionRequestMock;
      reservation.mockRejectedValueOnce(new CollectionRequestReplayError());
      const second = await callPOST(event, { headers });

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(saveEventMock).toHaveBeenCalledOnce();
    },
  );

  test('batch preserves ordinary anonymous pageviews', async () => {
    const response = await callBatch([
      { type: 'event', payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/' } },
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ size: 1, processed: 1, errors: 0 });
    expect(saveEventMock).toHaveBeenCalledOnce();
    expect(saveEventMock.mock.calls[0][0].distinctId).toBeUndefined();
    expect(saveEventMock.mock.calls[0][0].trustTier).toBe(COLLECTION_TRUST_TIER.unverified);
  });

  test.each([
    ['pageview', { type: 'event', payload: { website: WEBSITE_ID, url: '/' } }],
    ['performance', { type: 'performance', payload: { website: WEBSITE_ID, url: '/' } }],
    ['link', { type: 'event', payload: { link: LINK_ID, url: '/' } }],
    ['pixel', { type: 'event', payload: { pixel: PIXEL_ID, url: '/' } }],
  ])('rejects anonymous backdating of %s observations', async (_name, event) => {
    const response = await callPOST({
      ...event,
      payload: { ...event.payload, timestamp: Math.floor(Date.now() / 1000) - 3600 },
    });

    expect(response.status).toBe(403);
    expect(reserveActiveCollectionBudgetMock).not.toHaveBeenCalled();
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test('backend event proof permits a historical website pageview without issuing a public cache', async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 3600;
    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/', timestamp } },
      { headers: { authorization: `Bearer ${BACKEND_CREDENTIAL}` } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cache: null });
    expect(saveEventMock.mock.calls[0][0].createdAt).toEqual(new Date(timestamp * 1000));
    expect(saveEventMock.mock.calls[0][0].trustTier).toBe(COLLECTION_TRUST_TIER.unverified);
  });

  test('historical identify keeps its existing identity-only credential scope', async () => {
    vi.stubEnv(
      'COLLECTION_SERVER_KEYS_JSON',
      JSON.stringify({
        [WEBSITE_ID]: [
          {
            sha256: createHash('sha256').update(BACKEND_CREDENTIAL).digest('hex'),
            scopes: ['identity'],
            ownerType: 'user',
            ownerId: '44444444-4444-4444-8444-444444444444',
            generation: 0,
          },
        ],
      }),
    );

    const response = await callPOST({
      type: 'identify',
      payload: {
        website: WEBSITE_ID,
        id: 'verified-user',
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cache: null });
    expect(saveSessionLinkMock).toHaveBeenCalledOnce();
  });

  test('batch rejects backdating while keeping an ordinary public pageview', async () => {
    const response = await callBatch([
      {
        type: 'event',
        payload: {
          website: WEBSITE_ID,
          hostname: 'example.com',
          url: '/',
          timestamp: Math.floor(Date.now() / 1000) - 3600,
        },
      },
      { type: 'event', payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/' } },
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ size: 2, processed: 1, errors: 1 });
    expect(saveEventMock).toHaveBeenCalledOnce();
    expect(saveEventMock.mock.calls[0][0].trustTier).toBe(COLLECTION_TRUST_TIER.unverified);
  });

  test.each(['', ' \u0085 '])(
    'batch rejects a blank named event %j without dropping an ordinary pageview',
    async name => {
      const response = await callBatch(
        [
          {
            type: 'event',
            payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/', name },
          },
          { type: 'event', payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/' } },
        ],
        { authorization: `Bearer ${BACKEND_CREDENTIAL}` },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ size: 2, processed: 1, errors: 1 });
      expect(saveEventMock).toHaveBeenCalledOnce();
      expect(saveEventMock.mock.calls[0][0].trustTier).toBe(COLLECTION_TRUST_TIER.unverified);
    },
  );

  test.each([false, true])(
    'verified events cannot reuse a public session seed or cache in ClickHouse mode %s',
    async enabled => {
      (clickhouse as any).enabled = enabled;
      const publicResponse = await callPOST({
        type: 'event',
        payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED },
      });
      const publicCache = ((await publicResponse.json()) as { cache: string }).cache;
      const publicSessionId = saveEventMock.mock.calls[0][0].sessionId;
      const verifiedResponse = await callPOST(
        {
          type: 'event',
          payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED, name: 'signup' },
        },
        { headers: { 'x-umami-cache': publicCache } },
      );
      const verifiedSessionId = saveEventMock.mock.calls[1][0].sessionId;

      expect(verifiedResponse.status).toBe(200);
      expect(await verifiedResponse.json()).toEqual({ cache: null });
      expect(verifiedSessionId).not.toBe(publicSessionId);
      expect(saveEventMock.mock.calls[0][0].trustTier).toBe(COLLECTION_TRUST_TIER.unverified);
      expect(saveEventMock.mock.calls[1][0].trustTier).toBe(
        COLLECTION_TRUST_TIER.backendAuthorized,
      );

      const anotherPublicResponse = await callPOST(
        { type: 'event', payload: { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED } },
        { headers: { 'x-umami-cache': publicCache } },
      );

      expect(anotherPublicResponse.status).toBe(200);
      expect(saveEventMock.mock.calls[2][0].sessionId).toBe(publicSessionId);
      expect(saveEventMock.mock.calls[2][0].sessionId).not.toBe(verifiedSessionId);
    },
  );

  test('verified identity and custom event can share only a server-derived session', async () => {
    const payload = { website: WEBSITE_ID, url: '/', sessionSeed: SESSION_SEED, id: 'user-42' };
    const identity = await callPOST({ type: 'identify', payload });
    const customEvent = await callPOST({
      type: 'event',
      payload: { ...payload, name: 'signup' },
    });

    expect(identity.status).toBe(200);
    expect(customEvent.status).toBe(200);
    expect(saveSessionLinkMock.mock.calls[0][0].sessionId).toBe(
      saveEventMock.mock.calls[0][0].sessionId,
    );
    expect(await identity.json()).toEqual({ cache: null });
    expect(await customEvent.json()).toEqual({ cache: null });
  });

  test('batch cannot promote an anonymous identity or revenue claim while preserving pageviews', async () => {
    const items = [
      { type: 'event', payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/' } },
      {
        type: 'identify',
        payload: { website: WEBSITE_ID, hostname: 'example.com', id: 'claimed-person' },
      },
      {
        type: 'event',
        payload: {
          website: WEBSITE_ID,
          hostname: 'example.com',
          url: '/checkout',
          name: 'purchase',
          data: { currency: 'USD', revenue: 500 },
        },
      },
    ];
    const response = await callBatch(items);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ size: 3, processed: 1, errors: 2 });
    expect(saveEventMock).toHaveBeenCalledOnce();
    expect(saveSessionLinkMock).not.toHaveBeenCalled();
    expect(saveSessionDataMock).not.toHaveBeenCalled();
  });

  test('batch checks the backend credential against each child website', async () => {
    const response = await callBatch(
      [
        { type: 'event', payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/' } },
        {
          type: 'identify',
          payload: {
            website: '22222222-2222-4222-8222-222222222222',
            hostname: 'example.com',
            id: 'claimed-person',
          },
        },
      ],
      { authorization: `Bearer ${BACKEND_CREDENTIAL}` },
    );

    expect(await response.json()).toMatchObject({ processed: 1, errors: 1 });
    expect(saveEventMock).toHaveBeenCalledOnce();
    expect(saveSessionLinkMock).not.toHaveBeenCalled();
  });

  test('mixed authorized batches cannot attach verified events to public sessions', async () => {
    const response = await callBatch(
      [
        {
          type: 'event',
          payload: {
            website: WEBSITE_ID,
            hostname: 'example.com',
            url: '/',
            sessionSeed: SESSION_SEED,
          },
        },
        {
          type: 'event',
          payload: {
            website: WEBSITE_ID,
            hostname: 'example.com',
            url: '/',
            sessionSeed: SESSION_SEED,
            name: 'signup',
          },
        },
      ],
      { authorization: `Bearer ${BACKEND_CREDENTIAL}` },
    );

    expect(await response.json()).toMatchObject({ size: 2, processed: 2, errors: 0 });
    expect(saveEventMock.mock.calls[0][0].sessionId).not.toBe(
      saveEventMock.mock.calls[1][0].sessionId,
    );
    expect(saveEventMock.mock.calls.map(([args]) => args.trustTier)).toEqual([
      COLLECTION_TRUST_TIER.unverified,
      COLLECTION_TRUST_TIER.backendAuthorized,
    ]);
    expect(reserveActiveCollectionBudgetMock.mock.calls.map(call => call[4])).toEqual([
      'anonymous',
      'backend',
    ]);
  });

  test('anonymous custom properties never reach either event-data sink', async () => {
    const response = await callPOST(
      {
        type: 'event',
        payload: { website: WEBSITE_ID, url: '/', name: 'signup', data: { plan: 'private' } },
      },
      { unauthenticated: true },
    );

    expect(response.status).toBe(403);
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test('an ordinary public pageview rejects a caller-claimed identity', async () => {
    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/about', id: 'claimed-person' } },
      { unauthenticated: true },
    );

    expect(response.status).toBe(403);
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test.each([
    ['empty event name', { name: '' }],
    ['whitespace event name', { name: '  ' }],
    ['invisible Unicode event name', { name: ' \u0085 ' }],
    ['zero-width Unicode event name', { name: ' \u200b ' }],
    ['pageview identity with backend proof', { id: 'claimed-person' }],
  ])('rejects %s during request validation', async (_description, fields) => {
    parseRequestMock.mockImplementationOnce(async (request, requestSchema) => {
      const parsed = requestSchema.safeParse(await request.json());
      return parsed.success
        ? { body: parsed.data, error: undefined }
        : { body: undefined, error: () => new Response(null, { status: 400 }) };
    });

    const response = await POST(
      new Request('http://localhost/api/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${BACKEND_CREDENTIAL}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'event',
          payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/about', ...fields },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test('preserves a valid padded custom-event name', async () => {
    const payload = {
      website: WEBSITE_ID,
      hostname: 'example.com',
      url: '/about',
      name: ' signup ',
    };
    const response = await callPOST({ type: 'event', payload });
    const requestSchema = parseRequestMock.mock.calls[0][1];

    expect(requestSchema.safeParse({ type: 'event', payload }).success).toBe(true);
    expect(response.status).toBe(200);
    expect(saveEventMock.mock.calls[0][0].eventName).toBe(' signup ');
  });

  test('an originless caller cannot bind a claimed person to a website session', async () => {
    const response = await callPOST(
      {
        type: 'identify',
        payload: { website: WEBSITE_ID, id: 'claimed-person', data: { plan: 'enterprise' } },
      },
      { unauthenticated: true },
    );
    const schema = parseRequestMock.mock.calls[0][1];

    expect(
      schema.safeParse({
        type: 'identify',
        payload: {
          website: WEBSITE_ID,
          hostname: 'example.com',
          id: 'claimed-person',
          data: { plan: 'enterprise' },
        },
      }).success,
    ).toBe(true);

    expect.soft(response.status).toBeGreaterThanOrEqual(400);
    expect.soft(saveSessionLinkMock).not.toHaveBeenCalled();
    expect.soft(saveSessionDataMock).not.toHaveBeenCalled();
  });

  test('a claimed allowed Origin cannot authorize a caller-supplied identity', async () => {
    const response = await callPOST(
      {
        type: 'identify',
        payload: { website: WEBSITE_ID, id: 'claimed-person', data: { plan: 'enterprise' } },
      },
      { headers: { Origin: 'https://example.com' }, unauthenticated: true },
    );

    expect.soft(response.status).toBeGreaterThanOrEqual(400);
    expect.soft(saveSessionLinkMock).not.toHaveBeenCalled();
    expect.soft(saveSessionDataMock).not.toHaveBeenCalled();
  });

  test('an originless caller cannot create an authoritative revenue event', async () => {
    const response = await callPOST(
      {
        type: 'event',
        payload: {
          website: WEBSITE_ID,
          url: '/checkout',
          name: 'purchase',
          data: { currency: 'USD', revenue: 500 },
        },
      },
      { unauthenticated: true },
    );
    const schema = parseRequestMock.mock.calls[0][1];

    expect(
      schema.safeParse({
        type: 'event',
        payload: {
          website: WEBSITE_ID,
          hostname: 'example.com',
          url: '/checkout',
          name: 'purchase',
          data: { currency: 'USD', revenue: 500 },
        },
      }).success,
    ).toBe(true);

    expect.soft(response.status).toBeGreaterThanOrEqual(400);
    expect.soft(saveEventMock).not.toHaveBeenCalled();
  });

  test('a backend credential cannot submit revenue before durable order deduplication exists', async () => {
    const response = await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        url: '/checkout',
        name: 'purchase',
        data: { order: { currency: 'USD', revenue: 500 } },
      },
    });

    expect(response.status).toBe(403);
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test('a backend credential cannot submit a purchase price without verified-order provenance', async () => {
    const response = await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        url: '/checkout',
        name: 'purchase',
        data: { price: 500 },
      },
    });

    expect(response.status).toBe(403);
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test.each(['grossrevenue', 'prerevenueEstimate'])(
    'a backend credential cannot submit legacy substring revenue key %s',
    async revenueKey => {
      const response = await callPOST({
        type: 'event',
        payload: {
          website: WEBSITE_ID,
          url: '/checkout',
          name: 'purchase',
          data: { grosscurrency: 'USD', [revenueKey]: 500 },
        },
      });

      expect(response.status).toBe(403);
      expect(saveEventMock).not.toHaveBeenCalled();
    },
  );

  test('a backend credential cannot hide revenue inside identity properties', async () => {
    const response = await callPOST({
      type: 'identify',
      payload: {
        website: WEBSITE_ID,
        id: 'customer-1',
        data: { purchase: { totalRevenue: 500 } },
      },
    });

    expect(response.status).toBe(403);
    expect(saveSessionLinkMock).not.toHaveBeenCalled();
    expect(saveSessionDataMock).not.toHaveBeenCalled();
  });

  test('a backend credential can submit unrelated concurrency properties', async () => {
    const response = await callPOST({
      type: 'identify',
      payload: {
        website: WEBSITE_ID,
        id: 'customer-1',
        data: { concurrencyLimit: 8 },
      },
    });

    expect(response.status).toBe(200);
    expect(saveSessionDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionData: { concurrencyLimit: 8 } }),
      expect.anything(),
    );
  });

  test('an originless caller cannot write nested revenue fields used by ClickHouse', async () => {
    const eventData = { order: { currency: 'USD', revenue: 500 } };
    const payload = {
      website: WEBSITE_ID,
      hostname: 'example.com',
      url: '/checkout',
      name: 'purchase',
      data: eventData,
    };
    const response = await callPOST({ type: 'event', payload }, { unauthenticated: true });
    const schema = parseRequestMock.mock.calls[0][1];

    expect(schema.safeParse({ type: 'event', payload }).success).toBe(true);
    expect(response.status).toBe(403);
    expect(saveEventMock).not.toHaveBeenCalled();
  });
});

describe('30-minute visit expiry', () => {
  test('regenerates the visit when the cached iat is older than 30 minutes', async () => {
    const oldIat = Math.floor(Date.now() / 1000) - 2000;
    const token = makeCacheToken({ iat: oldIat });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect((await readCache(response)).visitId).not.toBe('cached-visit');
  });

  test('keeps the cached visit when within the 30-minute window', async () => {
    const recentIat = Math.floor(Date.now() / 1000) - 100;
    const token = makeCacheToken({ iat: recentIat });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect((await readCache(response)).visitId).toBe('cached-visit');
  });

  test('a public cache token does not authorize a historical event timestamp', async () => {
    const token = makeCacheToken();

    const response = await callPOST(
      {
        type: 'event',
        payload: { website: WEBSITE_ID, url: '/', timestamp: Math.floor(Date.now() / 1000) - 3600 },
      },
      { headers: { 'x-umami-cache': token } },
    );

    expect(response.status).toBe(403);
    expect(saveEventMock).not.toHaveBeenCalled();
  });
});

describe('identify collection', () => {
  test('uses distinct IDs to separate sessions with the same client fingerprint', async () => {
    const first = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-1' },
    });
    const second = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-2' },
    });

    const firstSessionId = createSessionMock.mock.calls[0][0].id;
    const secondSessionId = createSessionMock.mock.calls[1][0].id;

    expect(await first.json()).toEqual({ cache: null });
    expect(await second.json()).toEqual({ cache: null });
    expect(firstSessionId).not.toBe(secondSessionId);
    expect(createSessionMock.mock.calls[0][0]).toMatchObject({
      id: firstSessionId,
      distinctId: 'user-1',
    });
    expect(createSessionMock.mock.calls[1][0]).toMatchObject({
      id: secondSessionId,
      distinctId: 'user-2',
    });
  });

  test('normalizes distinct IDs before calculating the session ID', async () => {
    const prefix = 'a'.repeat(50);
    const first = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: `${prefix}-first`, sessionSeed: SESSION_SEED },
    });
    const second = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: `${prefix}-second`, sessionSeed: SESSION_SEED },
    });

    expect(await first.json()).toEqual({ cache: null });
    expect(await second.json()).toEqual({ cache: null });
    expect(createSessionMock.mock.calls[0][0].id).toBe(createSessionMock.mock.calls[1][0].id);
    expect(createSessionMock.mock.calls[0][0]).toMatchObject({ distinctId: prefix });
    expect(createSessionMock.mock.calls[1][0]).toMatchObject({ distinctId: prefix });
  });

  test('saves a session link and updates the session for a new distinctId', async () => {
    await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42' },
    });

    expect(saveSessionLinkMock).toHaveBeenCalledTimes(1);
    expect(updateSessionMock).toHaveBeenCalledTimes(1);
    expect(saveSessionLinkMock.mock.calls[0][0]).toMatchObject({
      websiteId: WEBSITE_ID,
      distinctId: 'user-42',
    });
  });

  test('keeps collection available without claiming a link after identity history reaches its cap', async () => {
    saveSessionLinkMock.mockResolvedValue(false);

    const response = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } },
    });
    expect(response.status).toBe(200);
    expect(saveSessionLinkMock).toHaveBeenCalledTimes(1);
    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(saveSessionDataMock).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ cache: null });
  });

  test('uses the active source transaction for ClickHouse link admission', async () => {
    (clickhouse as any).enabled = true;

    const response = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } },
    });

    expect(response.status).toBe(200);
    expect(saveSessionLinkMock.mock.calls[0][1]).toBeDefined();
    expect(saveSessionDataMock.mock.calls[0][1]).toBeUndefined();
    expect(publishSessionLinkMock).toHaveBeenCalledTimes(1);
  });

  test('saves session data when a data payload is present', async () => {
    await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } },
    });

    expect(saveSessionDataMock).toHaveBeenCalledTimes(1);
    expect(saveSessionDataMock.mock.calls[0][0]).toMatchObject({
      websiteId: WEBSITE_ID,
      sessionData: { plan: 'pro' },
    });
  });

  test('publishes a ClickHouse identity only after the source transaction commits', async () => {
    (clickhouse as any).enabled = true;
    let committed = false;
    withActiveCollectionSourceMock.mockImplementationOnce(async (_type, _id, operation) => {
      const result = await operation({
        website: {
          findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 0 })),
        },
      } as any);
      committed = true;
      return result;
    });
    publishSessionLinkMock.mockImplementationOnce(async () => {
      expect(committed).toBe(true);
    });

    const response = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cache: null });
    expect(publishSessionLinkMock).toHaveBeenCalledTimes(1);
    expect(withActiveCollectionSourceMock).toHaveBeenCalledTimes(2);
    expect(withActiveCollectionSourceMock.mock.calls[1][3]).toMatchObject({
      ownerType: 'user',
      requestId: expect.any(String),
    });
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  test.each([
    ['COLLECTION_KEY_OWNER_CHANGED', 403],
    ['COLLECTION_SOURCE_NOT_FOUND', 400],
  ])('does not publish a pending link after %s', async (failure, expectedStatus) => {
    (clickhouse as any).enabled = true;
    withActiveCollectionSourceMock
      .mockImplementationOnce(async (_type, _id, operation) =>
        operation({
          website: {
            findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 0 })),
          },
        } as any),
      )
      .mockRejectedValueOnce(new Error(failure));

    const response = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42' },
    });

    expect(response.status).toBe(expectedStatus);
    expect(withActiveCollectionSourceMock).toHaveBeenCalledTimes(2);
    expect(publishSessionLinkMock).not.toHaveBeenCalled();
  });

  test('a failed ClickHouse delivery reports partial identity failure without claiming the link', async () => {
    (clickhouse as any).enabled = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    publishSessionLinkMock.mockRejectedValueOnce(new Error('synthetic delivery failure'));

    const response = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } },
    });
    expect(response.status).toBe(503);
    expect(saveSessionDataMock).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      error: { code: 'identity-link-unavailable', status: 503 },
    });
    consoleError.mockRestore();
  });

  test('a rolled-back source transaction never publishes a ClickHouse link', async () => {
    (clickhouse as any).enabled = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    withActiveCollectionSourceMock.mockImplementationOnce(async (_type, _id, operation) => {
      await operation({
        website: {
          findFirst: vi.fn(async () => ({ domain: 'example.com', collectionGeneration: 0 })),
        },
      } as any);
      throw new Error('synthetic transaction rollback');
    });

    const response = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42' },
    });

    expect(response.status).toBe(500);
    expect(publishSessionLinkMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('repeated verified identity uses its isolated session without a browser cache', async () => {
    const first = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42' },
    });
    const second = await callPOST(
      { type: 'identify', payload: { website: WEBSITE_ID, id: 'user-42' } },
      { headers: { 'x-umami-cache': makeCacheToken() } },
    );

    expect(await first.json()).toEqual({ cache: null });
    expect(await second.json()).toEqual({ cache: null });
    expect(saveSessionLinkMock).toHaveBeenCalledTimes(2);
    expect(saveSessionLinkMock.mock.calls[0][0].sessionId).toBe(
      saveSessionLinkMock.mock.calls[1][0].sessionId,
    );
  });

  test('rotating a website credential preserves its verified session identity', async () => {
    const rotatedCredential = 'b'.repeat(43);
    vi.stubEnv(
      'COLLECTION_SERVER_KEYS_JSON',
      JSON.stringify({
        [WEBSITE_ID]: [BACKEND_CREDENTIAL, rotatedCredential].map(credential => ({
          sha256: createHash('sha256').update(credential).digest('hex'),
          scopes: ['identity'],
          ownerType: 'user',
          ownerId: '44444444-4444-4444-8444-444444444444',
          generation: 0,
        })),
      }),
    );

    const payload = { website: WEBSITE_ID, id: 'user-42', sessionSeed: SESSION_SEED };
    const first = await callPOST({ type: 'identify', payload });
    const second = await callPOST(
      { type: 'identify', payload },
      { headers: { authorization: `Bearer ${rotatedCredential}` } },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(saveSessionLinkMock.mock.calls[0][0].sessionId).toBe(
      saveSessionLinkMock.mock.calls[1][0].sessionId,
    );
  });

  test('does not write identity records without a website id', async () => {
    await callPOST({
      type: 'identify',
      payload: { link: LINK_ID, id: 'user-42' },
    });

    expect(saveSessionLinkMock).not.toHaveBeenCalled();
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  test('identity link write failures reject before session data is saved', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    saveSessionLinkMock.mockRejectedValue(new Error('link failed'));

    const response = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'identity-link-unavailable', status: 503 },
    });
    expect(saveSessionDataMock).not.toHaveBeenCalled();
    expect(updateSessionMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('performance collection', () => {
  test('saves a performance event with the web vitals metrics', async () => {
    await callPOST({
      type: 'performance',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/dashboard',
        lcp: 1200,
        inp: 50,
        cls: 0.05,
        fcp: 900,
        ttfb: 300,
      },
    });

    expect(saveEventMock).toHaveBeenCalledTimes(1);
    expect(saveEventMock.mock.calls[0][0]).toMatchObject({
      eventType: EVENT_TYPE.performance,
      urlPath: '/dashboard',
      lcp: 1200,
      inp: 50,
      cls: 0.05,
      fcp: 900,
      ttfb: 300,
    });
  });
});

describe('error handling', () => {
  test('returns a 500 server error when persistence throws', async () => {
    saveEventMock.mockRejectedValue(new Error('db down'));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'server-error', status: 500 },
    });
    consoleLog.mockRestore();
  });
});
