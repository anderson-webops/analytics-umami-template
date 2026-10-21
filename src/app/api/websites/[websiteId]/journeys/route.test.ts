import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getJourney } from '@/queries/sql/journeys/getJourney';
import { GET } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql/journeys/getJourney', () => ({ getJourney: vi.fn() }));

const websiteId = '00000000-0000-4000-8000-000000000001';
const request = new Request(`https://analytics.example/api/websites/${websiteId}/journeys`);
const context = { params: Promise.resolve({ websiteId }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'viewer' } },
    query: { steps: 3, startAt: Date.UTC(2026, 9, 1), endAt: Date.UTC(2026, 9, 2) },
  } as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(getQueryFilters).mockResolvedValue({
    startDate: new Date('2026-10-01T00:00:00.000Z'),
    endDate: new Date('2026-10-02T00:00:00.000Z'),
  } as any);
});

test('journey rows and header disclose possible unverified traffic', async () => {
  const row = { items: ['/public', 'VerifiedEvent'], count: 3 };
  vi.mocked(getJourney).mockResolvedValue([row]);

  const response = await GET(request, context);

  expect(response.status).toBe(200);
  expect(response.headers.get('X-Traffic-Provenance')).toBe(
    'may_include_unverified_public_observations',
  );
  expect(await response.json()).toEqual([
    { ...row, trafficProvenance: 'may_include_unverified_public_observations' },
  ]);
});

test('empty journeys still declare traffic provenance', async () => {
  vi.mocked(getJourney).mockResolvedValue([]);

  const response = await GET(request, context);

  expect(response.headers.get('X-Traffic-Provenance')).toBe(
    'may_include_unverified_public_observations',
  );
  expect(await response.json()).toEqual([]);
});

test('journeys keep the section permission gate', async () => {
  vi.mocked(canViewWebsiteSection).mockResolvedValue(false);

  const response = await GET(request, context);

  expect(response.status).toBe(401);
  expect(getJourney).not.toHaveBeenCalled();
});
