import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as send from '@/app/api/send/route';
import { getCollectionIpLimit } from '@/lib/collection-rate-limit';
import { parseRequest } from '@/lib/request';
import { tooManyRequests } from '@/lib/response';
import { OPTIONS, POST } from './route';

const redisState = vi.hoisted(() => ({ enabled: false }));
const sendPost = vi.hoisted(() => vi.fn());
const countersKey = 'analytics-collection-rate-limit-counters';

vi.mock('@/app/api/send/route', () => ({ POST: sendPost }));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/lib/redis', () => ({ default: redisState }));

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
  (globalThis as typeof globalThis & Record<string, unknown>)[countersKey] = new Map();
  sendPost.mockImplementation(async request => {
    const limit = await getCollectionIpLimit(request);

    return limit.blocked ? tooManyRequests(limit.retryAfter) : Response.json({ cache: 'cache' });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as typeof globalThis & Record<string, unknown>)[countersKey];
});

test('a valid batch charges once per child, including the outer admission', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    body: [{ type: 'event' }, { type: 'event' }, { type: 'event' }],
    error: undefined,
  } as any);

  const response = await POST(batchRequest());
  const counters = (
    globalThis as typeof globalThis & Record<string, Map<string, { count: number }>>
  )[countersKey];

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ size: 3, processed: 3, errors: 0 });
  expect(send.POST).toHaveBeenCalledTimes(3);
  expect([...counters.values()].map(counter => counter.count)).toEqual([3]);
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
