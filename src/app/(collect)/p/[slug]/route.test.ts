import { beforeEach, expect, test, vi } from 'vitest';
import { POST } from '@/app/api/send/route';
import { getCollectionIpLimit, transferCollectionIpLimit } from '@/lib/collection-rate-limit';
import redis from '@/lib/redis';
import { findPixel } from '@/queries/prisma';
import { GET } from './route';

vi.mock('@/app/api/send/route', () => ({ POST: vi.fn() }));
vi.mock('@/lib/collection-rate-limit', () => ({
  getCollectionIpLimit: vi.fn(),
  transferCollectionIpLimit: vi.fn(),
}));
vi.mock('@/lib/redis', () => ({
  default: { enabled: false, client: { fetch: vi.fn() } },
}));
vi.mock('@/queries/prisma', () => ({ findPixel: vi.fn() }));

const slug = 'public-pixel';
const request = new Request(`https://analytics.example/p/${slug}`);
const context = { params: Promise.resolve({ slug }) };
const pixel = { id: 'pixel-1', slug };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCollectionIpLimit).mockResolvedValue({ blocked: false, retryAfter: 60 });
  vi.mocked(POST).mockResolvedValue(new Response(null, { status: 200 }) as never);
});

test('rejects throttled valid and unknown pixel slugs before cache or database access', async () => {
  vi.mocked(getCollectionIpLimit).mockResolvedValue({ blocked: true, retryAfter: 60 });

  expect((await GET(request, context)).status).toBe(429);
  expect(
    (
      await GET(new Request('https://analytics.example/p/unknown-pixel'), {
        params: Promise.resolve({ slug: 'unknown-pixel' }),
      })
    ).status,
  ).toBe(429);
  expect(redis.client.fetch).not.toHaveBeenCalled();
  expect(findPixel).not.toHaveBeenCalled();
  expect(POST).not.toHaveBeenCalled();
});

test('transfers admitted collection capacity before returning the pixel', async () => {
  vi.mocked(findPixel).mockResolvedValue(pixel as never);

  const response = await GET(request, context);

  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('image/gif');
  expect(transferCollectionIpLimit).toHaveBeenCalledWith(request, expect.any(Request));
  expect(vi.mocked(transferCollectionIpLimit).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(POST).mock.invocationCallOrder[0],
  );
});

test('preserves the pixel response when ingestion rejects the event after IP admission', async () => {
  vi.mocked(findPixel).mockResolvedValue(pixel as never);
  vi.mocked(POST).mockResolvedValueOnce(new Response(null, { status: 429 }) as never);

  expect((await GET(request, context)).status).toBe(200);
  expect(transferCollectionIpLimit).toHaveBeenCalledOnce();
  expect(findPixel).toHaveBeenCalledOnce();
});
