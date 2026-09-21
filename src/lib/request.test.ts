import { beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { checkAuth } from '@/lib/auth';
import { fetchWebsite } from '@/lib/load';
import { getWebsiteSegment } from '@/queries/prisma';
import { getQueryFilters, parseRequest } from './request';
import { readRequestBodyBytes } from './request-body';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
  delete process.env.DATABASE_REPLICA_URL;
});

vi.mock('@/lib/auth', () => ({
  checkAuth: vi.fn(),
}));

vi.mock('@/lib/load', () => ({
  fetchAccount: vi.fn(),
  fetchWebsite: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  getWebsiteSegment: vi.fn(),
}));

const checkAuthMock = vi.mocked(checkAuth);
const fetchWebsiteMock = vi.mocked(fetchWebsite);
const getWebsiteSegmentMock = vi.mocked(getWebsiteSegment);

beforeEach(() => {
  checkAuthMock.mockReset();
  fetchWebsiteMock.mockReset();
  getWebsiteSegmentMock.mockReset();
  fetchWebsiteMock.mockResolvedValue({ id: 'website-1' } as any);
});

test('rejects direct query filters when a public share disables filters', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      websiteId: '00000000-0000-4000-8000-000000000001',
      parameters: { allowFilter: false },
    },
  } as any);

  const result = await parseRequest(
    new Request('https://analytics.example/api/test?startAt=1&endAt=2&country=US'),
  );
  const response = result.error?.();

  expect(response?.status).toBe(403);
  await expect(response?.json()).resolves.toMatchObject({
    error: { code: 'share-filters-disabled' },
  });
});

test('allows date and paging parameters when a public share disables filters', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      websiteId: '00000000-0000-4000-8000-000000000001',
      parameters: { allowFilter: false },
    },
  } as any);

  const result = await parseRequest(
    new Request('https://analytics.example/api/test?startAt=1&endAt=2&page=1'),
  );

  expect(result.error).toBeUndefined();
});

test('rejects report filter objects when a public share disables filters', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: {
      websiteId: '00000000-0000-4000-8000-000000000001',
      parameters: { allowFilter: false },
    },
  } as any);

  const result = await parseRequest(
    new Request('https://analytics.example/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filters: { country: 'US' } }),
    }),
  );

  expect(result.error?.().status).toBe(403);
});

test('rejects an oversized request URL before authentication', async () => {
  const result = await parseRequest(
    new Request(`https://analytics.example/api/test?search=${'a'.repeat(17 * 1024)}`),
  );

  expect(result.error?.().status).toBe(400);
  expect(checkAuthMock).not.toHaveBeenCalled();
});

test('rejects excessive query parameter fan-out before authentication', async () => {
  const query = Array.from({ length: 201 }, (_, index) => `field${index}=value`).join('&');
  const result = await parseRequest(new Request(`https://analytics.example/api/test?${query}`));

  expect(result.error?.().status).toBe(400);
  expect(checkAuthMock).not.toHaveBeenCalled();
});

test('validates HEAD query parameters using the GET schema path', async () => {
  const schema = z.object({ page: z.coerce.number().int().positive() });
  const result = await parseRequest(
    new Request('https://analytics.example/api/test?page=2', { method: 'HEAD' }),
    schema,
    { skipAuth: true },
  );

  expect(result.error).toBeUndefined();
  expect(result.query).toEqual({ page: 2 });
});

test('cancels a chunked request as soon as its actual body exceeds the byte limit', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(10 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request('https://analytics.example/api/test', {
    method: 'POST',
    headers: { 'content-length': '1' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  await expect(readRequestBodyBytes(request, 16 * 1024)).rejects.toThrow(
    'Request body exceeds the configured size limit',
  );
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(2);
});

test("combines a saved segment's session property filters with active filters", async () => {
  getWebsiteSegmentMock.mockResolvedValue({
    type: 'segment',
    name: 'Paid users',
    parameters: {
      filters: [],
      sessionPropertyFilters: [{ propertyName: 'plan', dataType: 1, operator: 'eq', value: 'pro' }],
    },
  } as any);

  const filters = await getQueryFilters(
    {
      startAt: String(+new Date('2026-09-01T00:00:00.000Z')),
      endAt: String(+new Date('2026-09-02T00:00:00.000Z')),
      segment: 'segment-1',
      spf0: '1.eq.country.US',
    },
    'website-1',
  );

  expect(filters.sessionPropertyFilters).toEqual([
    { propertyName: 'country', dataType: 1, operator: 'eq', value: 'US' },
    { propertyName: 'plan', dataType: 1, operator: 'eq', value: 'pro' },
  ]);
});
