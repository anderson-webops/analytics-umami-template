import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getUTM } from '@/queries/sql/utm/getUTM';
import { GET } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql/utm/getUTM', () => ({ getUTM: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'viewer' } },
    query: { type: 'utm_source', limit: 1 },
  } as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(getQueryFilters).mockResolvedValue({
    startDate: new Date(0),
    endDate: new Date(),
  } as any);
});

test('UTM API marks public observations in rows and header', async () => {
  vi.mocked(getUTM).mockResolvedValue([
    { utm: 'claimed-source', views: 4 },
    { utm: 'other-source', views: 2 },
  ] as never);

  const response = await GET(
    new Request(`https://analytics.example/api/websites/${websiteId}/utm/metrics`),
    { params: Promise.resolve({ websiteId }) },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('X-Metric-Provenance')).toBe('unverified_public_observations');
  expect(await response.json()).toEqual([
    {
      utm: 'claimed-source',
      views: 4,
      metricProvenance: 'unverified_public_observations',
    },
  ]);
});

test('empty UTM API result still declares provenance', async () => {
  vi.mocked(getUTM).mockResolvedValue([] as never);

  const response = await GET(
    new Request(`https://analytics.example/api/websites/${websiteId}/utm/metrics`),
    { params: Promise.resolve({ websiteId }) },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('X-Metric-Provenance')).toBe('unverified_public_observations');
  expect(await response.json()).toEqual([]);
});

test('UTM API retains the website-section permission gate', async () => {
  vi.mocked(canViewWebsiteSection).mockResolvedValue(false);

  const response = await GET(
    new Request(`https://analytics.example/api/websites/${websiteId}/utm/metrics`),
    { params: Promise.resolve({ websiteId }) },
  );

  expect(response.status).toBe(401);
  expect(response.headers.get('X-Metric-Provenance')).toBeNull();
  expect(getUTM).not.toHaveBeenCalled();
});
