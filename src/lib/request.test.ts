import { beforeEach, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { parseRequest } from './request';

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

beforeEach(() => {
  checkAuthMock.mockReset();
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
