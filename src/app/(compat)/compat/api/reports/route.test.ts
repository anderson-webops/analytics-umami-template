import { beforeEach, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { fetchWebsite } from '@/lib/load';
import { reserveShareQueryCost } from '@/lib/share-query-budget';
import { canViewWebsiteSection } from '@/permissions';
import { getReports } from '@/queries/prisma';
import { GET } from './route';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
  delete process.env.DATABASE_REPLICA_URL;
});

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
vi.mock('@/lib/load', () => ({ fetchAccount: vi.fn(), fetchWebsite: vi.fn() }));
vi.mock('@/permissions', () => ({
  canUpdateWebsite: vi.fn(),
  canViewAuthenticatedWebsite: vi.fn(),
  canViewWebsiteSection: vi.fn(),
  getReportSection: vi.fn(() => 'goals'),
}));
vi.mock('@/queries/prisma', () => ({ getReports: vi.fn(), getWebsiteSegment: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';
const checkAuthMock = vi.mocked(checkAuth);
const getReportsMock = vi.mocked(getReports);

beforeEach(() => {
  checkAuthMock.mockReset();
  getReportsMock.mockReset();
  vi.mocked(fetchWebsite).mockResolvedValue({ id: websiteId } as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  getReportsMock.mockResolvedValue({ data: [], count: 0 } as any);
});

function request(page = 1, pageSize = 20) {
  return GET(
    new Request(
      `https://analytics.example/api/reports?websiteId=${websiteId}&type=goal&page=${page}&pageSize=${pageSize}`,
    ),
  );
}

test('legacy report lists reject exhausted and deep-page shares before querying', async () => {
  const shareId = `legacy-reports-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId } } as any);
  expect((await reserveShareQueryCost(shareId, 599)).blocked).toBe(false);

  expect((await request()).status).toBe(429);
  expect((await request(10_000, 500)).status).toBe(400);
  expect(getReportsMock).not.toHaveBeenCalled();
});

test('legacy report lists retain ordinary authorized access', async () => {
  checkAuthMock.mockResolvedValue({
    shareToken: { shareId: `legacy-reports-allowed-${crypto.randomUUID()}`, websiteId },
  } as any);

  expect((await request()).status).toBe(200);
  expect(getReportsMock).toHaveBeenCalledOnce();
});
