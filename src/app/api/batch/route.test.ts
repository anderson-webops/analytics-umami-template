import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as send from '@/app/api/send/route';
import { getCollectionIpLimit } from '@/lib/collection-rate-limit';
import { parseRequest } from '@/lib/request';
import { tooManyRequests } from '@/lib/response';
import { OPTIONS, POST } from './route';

const redisState = vi.hoisted(() => ({ enabled: false }));
const sendPost = vi.hoisted(() => vi.fn());
const sharedCounters = vi.hoisted(() => new Map<string, bigint>());

vi.mock('@/app/api/send/route', () => ({ POST: sendPost }));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/lib/redis', () => ({ default: redisState }));
vi.mock('@/lib/prisma', () => ({
  default: {
    transaction: vi.fn(async operation =>
      operation({
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join('?');

          if (query.includes('transaction_timestamp() AS "currentTime"')) {
            return [{ currentTime: new Date() }];
          }

          if (query.includes('INSERT INTO collection_ingest_budget')) {
            const [key, , , limit] = values as [string, Date, Date, number];
            const count = sharedCounters.get(key) ?? 0n;

            if (count >= BigInt(limit)) {
              return [];
            }

            sharedCounters.set(key, count + 1n);
            return [{ requests: count + 1n }];
          }

          throw new Error('Unexpected collection rate-limit query.');
        },
        $executeRaw: async () => 0,
      }),
    ),
  },
}));

function batchRequest(origin?: string) {
  return new Request('https://analytics.example.com/api/batch', {
    method: 'POST',
    headers: { 'x-real-ip': '203.0.113.7', ...(origin ? { Origin: origin } : {}) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
  vi.stubEnv('COLLECTION_RATE_LIMIT_PER_IP', '10');
  sharedCounters.clear();
  sendPost.mockImplementation(async request => {
    const limit = await getCollectionIpLimit(request);

    return limit.blocked ? tooManyRequests(limit.retryAfter) : Response.json({ cache: 'cache' });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('a valid batch charges once per child, including the outer admission', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: [{ type: 'event' }, { type: 'event' }, { type: 'event' }],
    error: undefined,
  } as any);

  const response = await POST(batchRequest());
  const ipCounts = [...sharedCounters.entries()]
    .filter(([key]) => key.startsWith('rate:ip:'))
    .map(([, count]) => count);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ size: 3, processed: 3, errors: 0 });
  expect(send.POST).toHaveBeenCalledTimes(3);
  expect(ipCounts).toEqual([3n]);
});

test('a retried backend batch derives the same distinct child request IDs', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: [{ type: 'event' }, { type: 'identify' }],
    error: undefined,
  } as any);
  const received: string[] = [];
  sendPost.mockImplementation(async request => {
    await getCollectionIpLimit(request);
    received.push(request.headers.get('x-umami-request-id'));
    return Response.json({ cache: null });
  });
  const headers = {
    'x-umami-request-id': '33333333-3333-4333-8333-333333333333',
    'x-umami-request-timestamp': String(Math.floor(Date.now() / 1000)),
  };
  const makeRequest = () =>
    new Request('https://analytics.example/api/batch', {
      method: 'POST',
      headers,
    });

  expect((await POST(makeRequest())).status).toBe(200);
  expect((await POST(makeRequest())).status).toBe(200);
  expect(received).toHaveLength(4);
  expect(received[0]).not.toBe(received[1]);
  expect(received.slice(0, 2)).toEqual(received.slice(2));
});

test('moving an accepted item cannot change its replay ID', async () => {
  const accepted = {
    type: 'event',
    payload: { website: '11111111-1111-4111-8111-111111111111', name: 'signup' },
  };
  const other = {
    type: 'event',
    payload: { website: '11111111-1111-4111-8111-111111111111', name: 'purchase' },
  };
  vi.mocked(parseRequest)
    .mockResolvedValueOnce({ body: [accepted], error: undefined } as any)
    .mockResolvedValueOnce({ body: [other, accepted], error: undefined } as any);
  const received: Array<{ name: string; requestId: string | null }> = [];
  sendPost.mockImplementation(async request => {
    await getCollectionIpLimit(request);
    const body = await request.json();
    received.push({
      name: body.payload.name,
      requestId: request.headers.get('x-umami-request-id'),
    });
    return Response.json({ cache: null });
  });
  const headers = { 'x-umami-request-id': '33333333-3333-4333-8333-333333333333' };

  await POST(new Request('https://analytics.example/api/batch', { method: 'POST', headers }));
  await POST(new Request('https://analytics.example/api/batch', { method: 'POST', headers }));

  expect(received[0].requestId).toBe(received[2].requestId);
  expect(received[0].requestId).not.toBe(received[1].requestId);
});

test('identical backend items receive distinct stable IDs across reordered retries', async () => {
  const repeated = { type: 'event', payload: { website: 'site', name: 'signup' } };
  const other = { type: 'event', payload: { website: 'site', name: 'visit' } };
  vi.mocked(parseRequest)
    .mockResolvedValueOnce({ body: [repeated, other, repeated], error: undefined } as any)
    .mockResolvedValueOnce({ body: [other, repeated, repeated], error: undefined } as any);
  const received: Array<{ name: string; requestId: string | null }> = [];
  sendPost.mockImplementation(async request => {
    await getCollectionIpLimit(request);
    const body = await request.json();
    received.push({
      name: body.payload.name,
      requestId: request.headers.get('x-umami-request-id'),
    });
    return Response.json({ cache: null });
  });
  const headers = { 'x-umami-request-id': '33333333-3333-4333-8333-333333333333' };

  await POST(new Request('https://analytics.example/api/batch', { method: 'POST', headers }));
  await POST(new Request('https://analytics.example/api/batch', { method: 'POST', headers }));

  expect(received).toHaveLength(6);
  expect(received[0].requestId).not.toBe(received[2].requestId);
  expect(received[0].requestId).toBe(received[4].requestId);
  expect(received[2].requestId).toBe(received[5].requestId);
  expect(received[1].requestId).toBe(received[3].requestId);
});

test('an empty child response is counted as not recorded without aborting the batch', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: [{ type: 'event' }, { type: 'event' }],
    error: undefined,
  } as any);
  sendPost
    .mockImplementationOnce(async request => {
      await getCollectionIpLimit(request);
      return new Response(null, { status: 204 });
    })
    .mockImplementationOnce(async request => {
      await getCollectionIpLimit(request);
      return Response.json({ cache: null });
    });

  const response = await POST(batchRequest());

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    size: 2,
    processed: 1,
    errors: 1,
    details: [{ index: 0, response: { error: { code: 'not-recorded', status: 204 } } }],
  });
  expect(send.POST).toHaveBeenCalledTimes(2);
});

test('batch reuses session state only for later items from the same website', async () => {
  const firstWebsite = '11111111-1111-4111-8111-111111111111';
  const secondWebsite = '22222222-2222-4222-8222-222222222222';
  const sessionSeed = '44444444-4444-4444-8444-444444444444';
  vi.mocked(parseRequest).mockResolvedValue({
    body: [
      { type: 'event', payload: { website: firstWebsite, sessionSeed } },
      { type: 'event', payload: { website: secondWebsite, sessionSeed } },
      { type: 'event', payload: { website: firstWebsite, sessionSeed } },
    ],
    error: undefined,
  } as any);
  const received: { website: string; cache: string | null }[] = [];
  sendPost.mockImplementation(async request => {
    await getCollectionIpLimit(request);
    const body = await request.json();
    received.push({ website: body.payload.website, cache: request.headers.get('x-umami-cache') });
    return Response.json({ cache: `token-${body.payload.website}` });
  });

  const response = await POST(batchRequest());

  expect(response.status).toBe(200);
  expect(received).toEqual([
    { website: firstWebsite, cache: null },
    { website: secondWebsite, cache: null },
    { website: firstWebsite, cache: `token-${firstWebsite}` },
  ]);
});

test('batch does not join separate anonymous visitors without a seed', async () => {
  const website = '11111111-1111-4111-8111-111111111111';
  vi.mocked(parseRequest).mockResolvedValue({
    body: [
      { type: 'event', payload: { website } },
      { type: 'event', payload: { website } },
    ],
    error: undefined,
  } as any);
  const received: (string | null)[] = [];
  sendPost.mockImplementation(async request => {
    await getCollectionIpLimit(request);
    received.push(request.headers.get('x-umami-cache'));
    return Response.json({ cache: 'first-visitor-token' });
  });

  const response = await POST(batchRequest());

  expect(response.status).toBe(200);
  expect(received).toEqual([null, null]);
});

test('batch stops before dispatching more children when the caller IP limit is reached', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: Array.from({ length: 12 }, () => ({ type: 'event' })),
    error: undefined,
  } as any);

  const response = await POST(batchRequest());
  const ipCounts = [...sharedCounters.entries()]
    .filter(([key]) => key.startsWith('rate:ip:'))
    .map(([, count]) => count);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    size: 12,
    processed: 10,
    errors: 1,
    details: [{ index: 10, response: { error: { code: 'too-many-requests', status: 429 } } }],
  });
  expect(send.POST).toHaveBeenCalledTimes(10);
  expect(ipCounts).toEqual([10n]);
});

test('a source limit stops the batch before dispatching later items', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: [{ type: 'event' }, { type: 'event' }],
    error: undefined,
  } as any);
  sendPost.mockImplementationOnce(async request => {
    expect((await getCollectionIpLimit(request)).blocked).toBe(false);
    return tooManyRequests(60);
  });

  const response = await POST(batchRequest());

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    size: 2,
    processed: 0,
    errors: 1,
    details: [{ index: 0, response: { error: { code: 'too-many-requests', status: 429 } } }],
  });
  expect(send.POST).toHaveBeenCalledOnce();
  expect([...sharedCounters.keys()].filter(key => key.startsWith('rate:ip:'))).toHaveLength(1);
  expect([...sharedCounters.values()]).toEqual([1n, 1n]);
});

test('a non-rate-limit child error preserves later independent batch items', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: [{ type: 'event' }, { type: 'event' }],
    error: undefined,
  } as any);
  sendPost.mockImplementationOnce(async request => {
    expect((await getCollectionIpLimit(request)).blocked).toBe(false);
    return Response.json({ error: { code: 'bad-request', status: 400 } }, { status: 400 });
  });

  const response = await POST(batchRequest());

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ size: 2, processed: 1, errors: 1 });
  expect(send.POST).toHaveBeenCalledTimes(2);
});

test('a skipped website item does not make a mixed batch wildcard-readable', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: [
      ...Array.from({ length: 10 }, () => ({ payload: { link: 'link-id' } })),
      { payload: { website: 'website-id' } },
    ],
    error: undefined,
  } as any);
  sendPost.mockImplementation(async request => {
    expect((await getCollectionIpLimit(request)).blocked).toBe(false);
    return Response.json({ cache: null });
  });

  const response = await POST(batchRequest('https://unrelated.example'));

  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(await response.json()).toMatchObject({ size: 11, processed: 10, errors: 1 });
  expect(send.POST).toHaveBeenCalledTimes(10);
});

test('batch preflight permits tracker headers and accepted replies echo only their source origin', async () => {
  const origin = 'https://example.com';
  vi.mocked(parseRequest).mockResolvedValue({ body: [{ type: 'event' }], error: undefined } as any);
  sendPost.mockResolvedValueOnce(
    Response.json(
      { cache: 'opaque-token' },
      { headers: { 'Access-Control-Allow-Origin': origin } },
    ),
  );

  const preflight = OPTIONS();
  const response = await POST(batchRequest(origin));

  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('X-Umami-Website-Id');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect(response.headers.get('Vary')).toContain('Origin');
  expect(await response.json()).toMatchObject({ cache: 'opaque-token' });
});

test('a batch does not grant an unrelated origin access to its cache token', async () => {
  vi.mocked(parseRequest).mockResolvedValue({ body: [{ type: 'event' }], error: undefined } as any);

  const response = await POST(batchRequest('https://unrelated.example'));

  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(await response.json()).toMatchObject({ cache: 'cache' });
});

test('a link and pixel batch remains readable without exposing a session token', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: [{ payload: { link: 'link-id' } }, { payload: { pixel: 'pixel-id' } }],
    error: undefined,
  } as any);
  sendPost.mockImplementation(async () => Response.json({ cache: null }));

  const response = await POST(batchRequest('https://unrelated.example'));

  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(await response.json()).toEqual({
    size: 2,
    processed: 2,
    errors: 0,
    details: [],
    cache: null,
  });
});

test('malformed batch envelopes consume admission and block before parsing at the limit', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: undefined,
    error: () => Response.json({ error: 'bad request' }, { status: 400 }),
  } as any);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect((await POST(batchRequest())).status).toBe(400);
  }

  const blocked = await POST(batchRequest());

  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('Retry-After')).toBe('60');
  expect(parseRequest).toHaveBeenCalledTimes(10);
  expect(send.POST).not.toHaveBeenCalled();
});

test('batch preflight rejects oversized arrays before recursive request parsing', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    error: () => Response.json({ error: 'bad request' }, { status: 400 }),
  } as any);

  expect((await POST(batchRequest())).status).toBe(400);

  const preflight = vi.mocked(parseRequest).mock.calls[0][2]?.bodyPreflight;

  expect(preflight?.(Array(20).fill({ type: 'event' }))).toBe(true);
  expect(preflight?.(Array(21).fill(null))).toBe(false);
  expect(preflight?.(Array(10_000).fill(null))).toBe(false);
  expect(send.POST).not.toHaveBeenCalled();
});
