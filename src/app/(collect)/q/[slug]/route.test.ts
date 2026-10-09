import { beforeEach, expect, test, vi } from 'vitest';
import { POST } from '@/app/api/send/route';
import { findLink } from '@/queries/prisma';
import { GET } from './route';

vi.mock('@/app/api/send/route', () => ({ POST: vi.fn() }));
vi.mock('@/queries/prisma', () => ({ findLink: vi.fn() }));

const slug = 'public-link';
const request = new Request(`https://analytics.example/q/${slug}`);
const context = { params: Promise.resolve({ slug }) };
const originalLink = { id: 'link-1', slug, url: 'https://old.example/' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(POST).mockResolvedValue(new Response(null, { status: 200 }) as never);
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
