import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { EventDataPageTooBroadError, getEventData } from '@/queries/sql/events/getEventData';
import { GET } from './[websiteId]/event-data/route';

vi.mock('@/lib/request', () => ({ getQueryFilters: vi.fn(), parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql/events/getEventData', () => ({
  EventDataPageTooBroadError: class EventDataPageTooBroadError extends Error {
    constructor() {
      super('Narrow the page size or filters to view event properties.');
    }
  },
  getEventData: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: {},
    query: { startAt: 1, endAt: 2 },
    error: undefined,
  } as any);
  vi.mocked(getQueryFilters).mockResolvedValue({} as any);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
  vi.mocked(getEventData).mockReset();
});

test('returns a safe error rather than a partial oversized property page', async () => {
  vi.mocked(getEventData).mockRejectedValue(new EventDataPageTooBroadError());

  const response = await GET(new Request('http://localhost/api/websites/website-1/event-data'), {
    params: Promise.resolve({ websiteId: 'website-1' }),
  });

  expect(response.status).toBe(400);
  expect(await response.text()).toContain('Narrow the page size or filters');
});

test('does not conceal unrelated query failures', async () => {
  vi.mocked(getEventData).mockRejectedValue(new Error('database unavailable'));

  await expect(
    GET(new Request('http://localhost/api/websites/website-1/event-data'), {
      params: Promise.resolve({ websiteId: 'website-1' }),
    }),
  ).rejects.toThrow('database unavailable');
});
