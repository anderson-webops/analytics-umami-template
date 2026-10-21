import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getEventData } from '@/queries/sql/events/getEventData';
import { GET } from './route';

vi.mock('@/lib/request', () => ({
  getQueryFilters: vi.fn(),
  parseRequest: vi.fn(),
}));

vi.mock('@/permissions', () => ({
  canViewWebsiteSection: vi.fn(),
}));

vi.mock('@/queries/sql/events/getEventData', () => ({
  EventDataPageTooBroadError: class extends Error {},
  getEventData: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getQueryFiltersMock = vi.mocked(getQueryFilters);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const getEventDataMock = vi.mocked(getEventData);

beforeEach(() => {
  parseRequestMock.mockReset().mockResolvedValue({ auth: {}, query: {}, error: undefined } as any);
  getQueryFiltersMock.mockReset().mockResolvedValue({} as any);
  canViewWebsiteSectionMock.mockReset().mockResolvedValue(true);
  getEventDataMock.mockReset();
});

test('keeps same-ID events separate in an unfiltered property page', async () => {
  getEventDataMock.mockResolvedValue({
    data: [
      {
        websiteId: 'website-1',
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'purchase',
        urlPath: '/shop',
        dataKey: 'currency',
      },
      {
        websiteId: 'website-1',
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'secondary',
        urlPath: '/shop',
        dataKey: 'secondary-only',
      },
      {
        websiteId: 'website-1',
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'purchase',
        urlPath: '/other',
        dataKey: 'other-path',
      },
    ],
    count: 3,
    page: 1,
    pageSize: 3,
  } as any);

  const response = await GET(new Request('http://localhost/api/websites/website-1/event-data'), {
    params: Promise.resolve({ websiteId: 'website-1' }),
  });

  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({
    count: 3,
    data: [
      { eventId: 'event-1', eventName: 'purchase', eventProperties: [{ dataKey: 'currency' }] },
      {
        eventId: 'event-1',
        eventName: 'secondary',
        eventProperties: [{ dataKey: 'secondary-only' }],
      },
      { eventId: 'event-1', eventName: 'purchase', eventProperties: [{ dataKey: 'other-path' }] },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('sessionId');
  expect(JSON.stringify(result)).not.toContain('urlPath');
});
