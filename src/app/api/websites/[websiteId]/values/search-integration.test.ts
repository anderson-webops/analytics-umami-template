import { beforeEach, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { canViewSharedWebsiteFilters, canViewWebsiteSection } from '@/permissions';
import { getValues } from '@/queries/sql';
import { GET } from './route';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
});

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewSharedWebsiteFilters: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));
vi.mock('@/queries/sql', () => ({ getValues: vi.fn() }));

const params = Promise.resolve({ websiteId: 'website-1' });
const base = `https://analytics.example/api/websites/website-1/values?startAt=${Date.UTC(2025, 0, 1)}&endAt=${Date.UTC(2025, 0, 2)}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkAuth).mockResolvedValue({
    shareToken: {
      shareId: 'synthetic-journey-share',
      websiteId: 'website-1',
      parameters: { journeys: true, allowFilter: false },
    },
  } as never);
  vi.mocked(canViewSharedWebsiteFilters).mockResolvedValue(false);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(getValues).mockResolvedValue([{ value: '/home' }] as never);
});

test('a filter-disabled journey selector can search paths without opening other dimensions', async () => {
  const allowed = await GET(new Request(`${base}&type=path&search=home`), { params });
  expect(allowed.status).toBe(200);
  await expect(allowed.json()).resolves.toEqual([{ value: '/home' }]);
  expect(canViewWebsiteSection).toHaveBeenCalledWith(expect.anything(), 'website-1', [
    'journeys',
    'attribution',
  ]);

  const denied = await GET(new Request(`${base}&type=distinctId&search=visitor`), { params });
  expect(denied.status).toBe(403);
  expect(getValues).toHaveBeenCalledTimes(1);
});
