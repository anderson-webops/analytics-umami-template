import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCacheToken, parseCacheToken } from '@/lib/cache-token';
import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import { CollectionRequestReplayError } from '@/lib/collection-proof';
import { hash, secret } from '@/lib/crypto';
import { getRequestBodySize } from '@/lib/request-body';
import { POST } from './route';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
  delete process.env.DATABASE_REPLICA_URL;
});

const mocks = vi.hoisted(() => ({
  enabled: false,
  findWebsite: vi.fn(),
  fetchWebsite: vi.fn(),
  cloudBlocked: vi.fn(),
  clientInfo: vi.fn(),
  blockedIp: vi.fn(),
  ipLimit: vi.fn(),
  sourceLimit: vi.fn(),
  reserveBudget: vi.fn(),
  reserveBackend: vi.fn(),
  withSource: vi.fn(),
  createSession: vi.fn(),
  saveEvent: vi.fn(),
  query: vi.fn(),
  issue: vi.fn(),
  event: vi.fn(),
  clickhouseQuery: vi.fn(),
  insert: vi.fn(),
  metric: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewWebsite: vi.fn() }));
vi.mock('@/lib/clickhouse', () => ({
  default: {
    get enabled() {
      return mocks.enabled;
    },
    rawQuery: mocks.clickhouseQuery,
    insert: mocks.insert,
  },
}));
vi.mock('@/lib/load', () => ({
  fetchWebsite: mocks.fetchWebsite,
  fetchAccount: vi.fn(),
  isWebsiteCollectionBlocked: mocks.cloudBlocked,
}));
vi.mock('@/lib/detect', () => ({ getClientInfo: mocks.clientInfo, hasBlockedIp: mocks.blockedIp }));
vi.mock('@/lib/collection-rate-limit', () => ({
  getCollectionIpLimit: mocks.ipLimit,
  getCollectionSourceStatus: mocks.sourceLimit,
}));
vi.mock('@/lib/errors/metrics', () => ({ recordErrorIngestion: mocks.metric }));
vi.mock('@/queries/prisma', () => ({
  getWebsite: vi.fn(),
  getWebsiteSegment: vi.fn(),
  getLink: vi.fn(),
  getPixel: vi.fn(),
  reserveActiveCollectionBudget: mocks.reserveBudget,
  reserveBackendCollectionRequest: mocks.reserveBackend,
  withActiveCollectionSource: mocks.withSource,
}));
vi.mock('@/queries/sql', () => ({
  createSession: mocks.createSession,
  saveEvent: mocks.saveEvent,
  publishSessionLink: vi.fn(),
  saveSessionData: vi.fn(),
  saveSessionLink: vi.fn(),
  updateSession: vi.fn(),
}));

const WEBSITE = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SEED = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = 'a'.repeat(43);
const source = (generation = 0) => ({
  sourceType: 'website',
  sourceId: WEBSITE,
  accountType: 'user',
  accountId: OWNER,
  collectionGeneration: generation,
});
const transaction = {
  website: { findFirst: mocks.findWebsite },
  $queryRaw: mocks.query,
  errorIssue: { createMany: mocks.issue },
  errorEvent: { createMany: mocks.event },
};
const errorPayload = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  website: WEBSITE,
  eventId: randomUUID(),
  timestamp: Date.now(),
  name: 'TypeError',
  message: 'Synthetic checkout failure',
  stack: '',
  handled: false,
  url: '/checkout',
  release: 'synthetic',
  environment: 'test',
  tags: {},
  ...overrides,
});

function request(
  payload = errorPayload(),
  options: { headers?: Record<string, string>; raw?: string; origin?: string | null } = {},
) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...options.headers });
  if (options.origin !== null) headers.set('Origin', options.origin ?? 'https://example.com');
  return new Request('https://analytics.example/api/send', {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify({ type: 'error', payload }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled = false;
  vi.stubEnv('DISABLE_BOT_CHECK', 'false');
  vi.stubEnv('ENABLE_CLIENT_SALT', 'false');
  vi.stubEnv('ERRORS_PER_MINUTE', '120');
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  vi.stubEnv(
    'COLLECTION_SERVER_KEYS_JSON',
    JSON.stringify({
      [WEBSITE]: [
        {
          sha256: createHash('sha256').update(CREDENTIAL).digest('hex'),
          scopes: ['identity'],
          ownerType: 'user',
          ownerId: OWNER,
          generation: 0,
        },
      ],
    }),
  );
  mocks.ipLimit.mockResolvedValue({ blocked: false, retryAfter: 60 });
  mocks.sourceLimit.mockResolvedValue({ blocked: false, retryAfter: 60 });
  mocks.fetchWebsite.mockResolvedValue({
    id: WEBSITE,
    domain: 'example.com',
    collectionGeneration: 0,
  });
  mocks.findWebsite.mockResolvedValue({
    domain: 'example.com',
    collectionGeneration: 0,
    resetAt: null,
  });
  mocks.cloudBlocked.mockResolvedValue(false);
  mocks.clientInfo.mockResolvedValue({
    ip: '192.0.2.10',
    userAgent: 'Mozilla/5.0',
    browser: 'Chrome',
    os: 'Linux',
    device: 'desktop',
    isBot: false,
  });
  mocks.blockedIp.mockReturnValue(false);
  mocks.reserveBudget.mockResolvedValue(source());
  mocks.withSource.mockImplementation(async (_type, _id, operation) => operation(transaction));
  mocks.query.mockResolvedValue([{ count: 1 }]);
  mocks.clickhouseQuery.mockResolvedValue([]);
});

afterEach(() => vi.unstubAllEnvs());

describe('guarded error ingestion', () => {
  test('reads and validates the body once, then writes inside the guarded source transaction', async () => {
    const payload = errorPayload();
    const input = request(payload, { headers: { 'x-real-ip': '192.0.2.10' } });
    const reader = vi.spyOn(input.body, 'getReader');
    const response = await POST(input);
    const result = await response.json();
    const cache = parseCacheToken(result.cache, secret());

    expect(response.status).toBe(200);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(input.bodyUsed).toBe(true);
    expect(getRequestBodySize(input)).toBe(
      Buffer.byteLength(JSON.stringify({ type: 'error', payload })),
    );
    expect(result).toEqual({
      ok: true,
      eventId: payload.eventId,
      issueId: expect.any(String),
      cache: expect.stringMatching(/^c1\./),
    });
    expect(mocks.reserveBudget).toHaveBeenCalledWith(
      'website',
      WEBSITE,
      expect.objectContaining({ type: 'error' }),
      '192.0.2.10',
      'anonymous',
    );
    expect(mocks.withSource).toHaveBeenCalledWith(
      'website',
      WEBSITE,
      expect.any(Function),
      undefined,
      source(),
    );
    expect(mocks.findWebsite).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { domain: true, collectionGeneration: true, resetAt: true },
      }),
    );
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: cache.sessionId, websiteId: WEBSITE }),
      transaction,
    );
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(mocks.event.mock.calls[0][0].data[0]).toMatchObject({
      id: payload.eventId,
      websiteId: WEBSITE,
      sessionId: cache.sessionId,
      visitId: cache.visitId,
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
    expect(mocks.metric).toHaveBeenCalledWith('accepted');
  });

  test('preserves the pageview session and visit through an opaque browser cache', async () => {
    const pageview = request(undefined, {
      raw: JSON.stringify({
        type: 'event',
        payload: { website: WEBSITE, hostname: 'example.com', url: '/', sessionSeed: SEED },
      }),
    });
    const tracked = await (await POST(pageview)).json();
    const cache = parseCacheToken(tracked.cache, secret());
    const response = await POST(
      request(errorPayload({ sessionSeed: SEED }), { headers: { 'x-umami-cache': tracked.cache } }),
    );
    expect(response.status).toBe(200);
    expect(mocks.event.mock.calls[0][0].data[0]).toMatchObject({
      sessionId: cache.sessionId,
      visitId: cache.visitId,
    });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  test('separates storage-disabled browsers sharing an IP and user agent', async () => {
    await POST(request());
    await POST(request());
    const first = mocks.event.mock.calls[0][0].data[0];
    const second = mocks.event.mock.calls[1][0].data[0];
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.visitId).not.toBe(second.visitId);
  });

  test('invalidates cache sessions after source recreation', async () => {
    const first = await (await POST(request())).json();
    const previous = parseCacheToken(first.cache, secret());
    mocks.reserveBudget.mockResolvedValue(source(1));
    mocks.findWebsite.mockResolvedValue({
      domain: 'example.com',
      collectionGeneration: 1,
      resetAt: null,
    });
    const response = await POST(
      request(errorPayload(), { headers: { 'x-umami-cache': first.cache } }),
    );
    expect(response.status).toBe(200);
    expect(mocks.event.mock.calls[1][0].data[0].sessionId).not.toBe(previous.sessionId);
    expect(parseCacheToken((await response.json()).cache, secret()).collectionGeneration).toBe(1);
  });

  test('rejects a foreign source despite a valid cache token', async () => {
    const token = createCacheToken(
      {
        websiteId: WEBSITE,
        sessionId: randomUUID(),
        visitId: randomUUID(),
        collectionGeneration: 0,
        iat: Math.floor(Date.now() / 1000),
        identityHash: hash(''),
        sessionSalt: hash('salt'),
      },
      secret(),
      60,
    );
    mocks.fetchWebsite.mockResolvedValue(null);
    const response = await POST(request(errorPayload(), { headers: { 'x-umami-cache': token } }));
    expect(response.status).toBe(400);
    expect(mocks.reserveBudget).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });

  test.each(['https://hostile.example', 'null'])(
    'rejects unapproved origin %s before reservations',
    async origin => {
      const response = await POST(request(errorPayload({ hostname: 'example.com' }), { origin }));
      expect(response.status).toBe(400);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(mocks.reserveBudget).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
    },
  );

  test('requires a matching source hostname for a non-browser caller', async () => {
    expect((await POST(request(errorPayload(), { origin: null }))).status).toBe(400);
    expect(
      (await POST(request(errorPayload({ hostname: 'example.com' }), { origin: null }))).status,
    ).toBe(200);
  });

  test('rejects whitespace-padded oversized bodies without trusting Content-Length', async () => {
    const body = JSON.stringify({ type: 'error', payload: errorPayload() });
    const response = await POST(
      request(undefined, {
        raw: body + ' '.repeat(48001 - Buffer.byteLength(body)),
        headers: { 'Content-Length': '10' },
      }),
    );
    expect(response.status).toBe(413);
    expect(mocks.reserveBudget).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.metric).toHaveBeenCalledWith('oversized');
  });

  test.each([Date.now() - 31 * 86400000, Date.now() + 600000])(
    'rejects timestamps outside the canonical collection window: %s',
    async timestamp => {
      expect((await POST(request(errorPayload({ timestamp })))).status).toBe(400);
      expect(mocks.reserveBudget).not.toHaveBeenCalled();
    },
  );

  test('accepts bounded retries from an earlier day', async () => {
    const timestamp = Date.now() - 86400000;
    expect((await POST(request(errorPayload({ timestamp })))).status).toBe(200);
    expect(mocks.event.mock.calls[0][0].data[0].createdAt).toEqual(new Date(timestamp));
  });

  test.each([
    { id: 'forged-owner' },
    { ip: '192.0.2.99' },
    { userAgent: 'override' },
    { data: { revenue: 100 } },
  ])('blocks unauthorized tracking claims %j', async override => {
    const response = await POST(request(errorPayload(override)));
    expect(response.status).toBe(override.id ? 403 : 400);
    expect(mocks.reserveBudget).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });

  test('requires owner-bound backend proof for identified errors and omits public cache issuance', async () => {
    const response = await POST(
      request(errorPayload({ id: 'verified-user', sessionSeed: SEED }), {
        headers: {
          Authorization: `Bearer ${CREDENTIAL}`,
          'x-umami-request-id': randomUUID(),
          'x-umami-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).cache).toBeNull();
    expect(mocks.reserveBudget).toHaveBeenCalledWith(
      'website',
      WEBSITE,
      expect.any(Object),
      expect.any(String),
      'backend',
      expect.objectContaining({ ownerId: OWNER, generation: 0 }),
      true,
    );
    expect(mocks.reserveBackend).toHaveBeenCalledWith(
      transaction,
      WEBSITE,
      expect.objectContaining({ ownerId: OWNER }),
    );
    expect(mocks.createSession.mock.calls[0][0].distinctId).toBe('verified-user');
  });

  test.each([
    ['COLLECTION_SOURCE_NOT_FOUND', 400],
    ['COLLECTION_SOURCE_CHANGED', 409],
    ['COLLECTION_KEY_OWNER_CHANGED', 403],
  ])('preserves source admission failure %s', async (message, status) => {
    mocks.withSource.mockRejectedValue(new Error(String(message)));
    expect((await POST(request())).status).toBe(status);
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  test('preserves nonce replay rejection', async () => {
    mocks.reserveBudget.mockRejectedValue(new CollectionRequestReplayError());
    expect((await POST(request())).status).toBe(409);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  test('rejects pre-reset timestamps inside the current source transaction', async () => {
    mocks.findWebsite.mockResolvedValue({
      domain: 'example.com',
      collectionGeneration: 0,
      resetAt: new Date(),
    });
    expect((await POST(request(errorPayload({ timestamp: Date.now() - 60000 })))).status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  test('revalidates domain and generation before session and error writes', async () => {
    mocks.findWebsite.mockResolvedValue({ domain: 'changed.example', collectionGeneration: 0 });
    expect((await POST(request())).status).toBe(400);
    mocks.findWebsite.mockResolvedValue({ domain: 'example.com', collectionGeneration: 1 });
    expect((await POST(request())).status).toBe(409);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });

  test('shares the account, source and client budget rejection with normal collection', async () => {
    mocks.reserveBudget.mockRejectedValue(new CollectionBudgetExceededError(90));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('90');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  test('enforces the separate error quota in the same transaction', async () => {
    mocks.query.mockResolvedValue([{ count: 121 }]);
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.metric).toHaveBeenCalledWith('throttled');
  });

  test('sanitizes storage failures without exposing collected content', async () => {
    mocks.query.mockRejectedValue(
      new Error('Synthetic database failure containing private payload'),
    );
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private payload');
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.metric).toHaveBeenCalledWith('failed');
  });

  test('honors cloud collection blocks before persistence', async () => {
    mocks.cloudBlocked.mockResolvedValue(true);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.reserveBudget).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  test.each(['false', '0', 'off', 'no'])(
    'keeps bot filtering enabled when DISABLE_BOT_CHECK is %s',
    async flag => {
      vi.stubEnv('DISABLE_BOT_CHECK', flag);
      mocks.clientInfo.mockResolvedValue({ isBot: true });
      const response = await POST(request());
      expect(await response.json()).toEqual({ ok: false, reason: 'bot' });
      expect(mocks.reserveBudget).not.toHaveBeenCalled();
      expect(mocks.metric).toHaveBeenCalledWith('blocked');
    },
  );

  test('writes ClickHouse errors through the guarded transaction without relational session writes', async () => {
    mocks.enabled = true;
    expect((await POST(request())).status).toBe(200);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith('error_event', [
      expect.objectContaining({
        website_id: WEBSITE,
        session_id: expect.any(String),
        visit_id: expect.any(String),
      }),
    ]);
  });

  test('scrubs sensitive error text and tags before persistence', async () => {
    const response = await POST(
      request(
        errorPayload({
          message: 'Failed https://example.com/path?private=value password=synthetic',
          tags: { token: 'synthetic', section: 'checkout' },
          url: '/checkout?private=value',
        }),
      ),
    );
    expect(response.status).toBe(200);
    const event = mocks.event.mock.calls[0][0].data[0];
    expect(event.message).not.toContain('synthetic');
    expect(event.message).not.toContain('?');
    expect(event.tags).toEqual({ section: 'checkout' });
    expect(event.urlPath).toBe('/checkout');
  });
});
