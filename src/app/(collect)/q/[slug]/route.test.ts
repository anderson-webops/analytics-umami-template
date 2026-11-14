import { beforeEach, expect, test, vi } from 'vitest';
import { POST } from '@/app/api/send/route';
import { getCollectionIpLimit, transferCollectionIpLimit } from '@/lib/collection-rate-limit';
import { findLink } from '@/queries/prisma';
import { GET } from './route';

vi.mock('@/app/api/send/route', () => ({ POST: vi.fn() }));
vi.mock('@/lib/collection-rate-limit', () => ({
  getCollectionIpLimit: vi.fn(),
  transferCollectionIpLimit: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({ findLink: vi.fn() }));

const slug = 'public-link';
const request = new Request(`https://analytics.example/q/${slug}`);
const context = { params: Promise.resolve({ slug }) };
const originalLink = { id: 'link-1', slug, url: 'https://old.example/' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(POST).mockResolvedValue(new Response(null, { status: 200 }) as never);
  vi.mocked(getCollectionIpLimit).mockResolvedValue({ blocked: false, retryAfter: 60 });
});

test('rejects a throttled link before resolving its slug', async () => {
  vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

  const response = await GET(request, context);

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(findLink).not.toHaveBeenCalled();
  expect(POST).not.toHaveBeenCalled();
});

test('rejects a throttled unknown slug without a database lookup', async () => {
  vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

  expect((await GET(request, { params: Promise.resolve({ slug: 'unknown-link' }) })).status).toBe(
    429,
  );
  expect(findLink).not.toHaveBeenCalled();
});

test('redirects using the current primary record, not the URL read before event ingestion', async () => {
  vi.mocked(findLink)
    .mockResolvedValueOnce(originalLink as never)
    .mockResolvedValueOnce({ ...originalLink, url: 'https://new.example/' } as never);

  const response = await GET(request, context);

  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe('https://new.example/');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(findLink).toHaveBeenCalledTimes(2);
  expect(POST).toHaveBeenCalledTimes(1);
  expect(transferCollectionIpLimit).toHaveBeenCalledWith(request, expect.any(Request));
  expect(vi.mocked(transferCollectionIpLimit).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(POST).mock.invocationCallOrder[0],
  );
});

test('preserves redirects when ingestion rejects an event after IP admission', async () => {
  vi.mocked(findLink).mockResolvedValue(originalLink as never);
  vi.mocked(POST).mockResolvedValueOnce(new Response(null, { status: 429 }) as never);

  const response = await GET(request, context);

  expect(response.status).toBe(307);
  expect(transferCollectionIpLimit).toHaveBeenCalledOnce();
  expect(findLink).toHaveBeenCalledTimes(2);
});

test('rejects a link deleted while event ingestion is pending', async () => {
  vi.mocked(findLink)
    .mockResolvedValueOnce(originalLink as never)
    .mockResolvedValueOnce(null);

  const response = await GET(request, context);

  expect(response.status).toBe(404);
  expect(POST).toHaveBeenCalledTimes(1);
});

test('rejects a slug reassigned to another link before redirect', async () => {
  vi.mocked(findLink)
    .mockResolvedValueOnce(originalLink as never)
    .mockResolvedValueOnce({ ...originalLink, id: 'link-2' } as never);

  expect((await GET(request, context)).status).toBe(404);
});

test('does not ingest an event for a deleted link', async () => {
  vi.mocked(findLink).mockResolvedValue(null);

  expect((await GET(request, context)).status).toBe(404);
  expect(POST).not.toHaveBeenCalled();
});

test.each([
  'foo',
  '/relative',
  'javascript:alert(1)',
  'data:text/html,synthetic',
  'https://user:password@example.com',
])('rejects the stored destination %s before recording a click', async url => {
  vi.mocked(findLink).mockResolvedValue({ ...originalLink, url } as never);

  const response = await GET(request, context);

  expect(response.status).toBe(404);
  expect(POST).not.toHaveBeenCalled();
});

test('a malformed slug is rejected before admission or database work', async () => {
  const response = await GET(request, { params: Promise.resolve({ slug: '../invalid' }) });

  expect(response.status).toBe(404);
  expect(getCollectionIpLimit).not.toHaveBeenCalled();
  expect(findLink).not.toHaveBeenCalled();
});

test('normalizes an admitted legacy HTTP destination before setting the redirect header', async () => {
  vi.mocked(findLink).mockResolvedValue({
    ...originalLink,
    url: ' https://Example.com/docs ',
  } as never);

  const response = await GET(request, context);

  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe('https://example.com/docs');
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('ingestion failure still requires the current live link before redirecting', async () => {
  vi.mocked(findLink).mockResolvedValue(originalLink as never);
  vi.mocked(POST).mockRejectedValueOnce(new Error('Synthetic telemetry failure'));

  const response = await GET(request, context);

  expect(response.status).toBe(307);
  expect(findLink).toHaveBeenCalledTimes(2);
});

test('an ingestion exception cannot revive a link removed before the final authority read', async () => {
  vi.mocked(findLink)
    .mockResolvedValueOnce(originalLink as never)
    .mockResolvedValueOnce(null);
  vi.mocked(POST).mockRejectedValueOnce(new Error('Synthetic telemetry failure'));

  expect((await GET(request, context)).status).toBe(404);
});

test('an unsafe replacement destination fails closed after ingestion', async () => {
  vi.mocked(findLink)
    .mockResolvedValueOnce(originalLink as never)
    .mockResolvedValueOnce({
      ...originalLink,
      url: 'javascript:alert(1)',
    } as never);

  expect((await GET(request, context)).status).toBe(404);
});

test('internal click ingestion excludes browser credentials while retaining provenance', async () => {
  vi.mocked(findLink).mockResolvedValue(originalLink as never);
  const browserRequest = new Request(request.url, {
    headers: {
      authorization: 'Bearer synthetic-browser-token',
      cookie: 'analytics-session=synthetic-session',
      'content-length': '999',
      'x-umami-cache': 'synthetic-cache',
      origin: 'https://analytics.example',
      referer: 'https://referrer.example',
    },
  });

  await GET(browserRequest, context);
  const internal = vi.mocked(POST).mock.calls[0][0];

  for (const name of ['authorization', 'cookie', 'content-length', 'x-umami-cache']) {
    expect(internal.headers.has(name)).toBe(false);
  }
  expect(internal.headers.get('origin')).toBe('https://analytics.example');
  expect(internal.headers.get('content-type')).toBe('application/json');
  expect(await internal.json()).toMatchObject({
    type: 'event',
    payload: { link: originalLink.id, url: request.url, referrer: 'https://referrer.example' },
  });
});
