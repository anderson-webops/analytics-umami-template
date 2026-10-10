import { beforeEach, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { fetchWebsite } from '@/lib/load';
import { reserveAuthenticatedQueryCost } from '@/lib/share-query-budget';
import { canViewAuthenticatedWebsite } from '@/permissions';
import { getEventMetrics, getPageviewMetrics, getSessionMetrics } from '@/queries/sql';
import { GET } from './route';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
  delete process.env.DATABASE_REPLICA_URL;
});

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
vi.mock('@/lib/load', () => ({ fetchWebsite: vi.fn(), fetchAccount: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewAuthenticatedWebsite: vi.fn() }));
vi.mock('@/queries/sql', () => ({
  getEventMetrics: vi.fn(),
  getPageviewMetrics: vi.fn(),
  getSessionMetrics: vi.fn(),
}));

const checkAuthMock = vi.mocked(checkAuth);
const fetchWebsiteMock = vi.mocked(fetchWebsite);
const canViewAuthenticatedWebsiteMock = vi.mocked(canViewAuthenticatedWebsite);
const getEventMetricsMock = vi.mocked(getEventMetrics);
const getPageviewMetricsMock = vi.mocked(getPageviewMetrics);
const getSessionMetricsMock = vi.mocked(getSessionMetrics);
const websiteId = '00000000-0000-4000-8000-000000000001';
const params = { params: Promise.resolve({ websiteId }) };

beforeEach(() => {
  checkAuthMock.mockReset();
  fetchWebsiteMock.mockReset();
  fetchWebsiteMock.mockResolvedValue({ id: websiteId, resetAt: null } as any);
  canViewAuthenticatedWebsiteMock.mockReset();
  getEventMetricsMock.mockReset();
  getPageviewMetricsMock.mockReset();
  getSessionMetricsMock.mockReset();
  canViewAuthenticatedWebsiteMock.mockResolvedValue(true);
  getEventMetricsMock.mockResolvedValue([] as any);
  getPageviewMetricsMock.mockResolvedValue([] as any);
  getSessionMetricsMock.mockResolvedValue([] as any);
});

test('charges all seven export queries before opening the analytics database', async () => {
  const userId = `export-user-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ user: { id: userId } } as any);
  expect((await reserveAuthenticatedQueryCost(userId, 19_000)).blocked).toBe(false);
  const historical = new Request(
    `https://analytics.example/api/websites/${websiteId}/export?startAt=${Date.UTC(2006, 0, 1)}&endAt=${Date.UTC(2025, 11, 31)}`,
  );

  expect((await GET(historical, params)).status).toBe(429);
  expect(getEventMetricsMock).not.toHaveBeenCalled();
  expect(getPageviewMetricsMock).not.toHaveBeenCalled();
  expect(getSessionMetricsMock).not.toHaveBeenCalled();

  checkAuthMock.mockResolvedValue({
    user: { id: `ordinary-export-${crypto.randomUUID()}` },
  } as any);
  const ordinary = new Request(
    `https://analytics.example/api/websites/${websiteId}/export?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 31)}`,
  );
  const response = await GET(ordinary, params);

  expect(response.status).toBe(200);
  expect(getEventMetricsMock).toHaveBeenCalledOnce();
  expect(getPageviewMetricsMock).toHaveBeenCalledTimes(2);
  expect(getSessionMetricsMock).toHaveBeenCalledTimes(4);
});
