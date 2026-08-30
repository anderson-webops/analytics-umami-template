import { endOfMonth, startOfMonth } from 'date-fns';
import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import { getLinkedSessionIds, getSessionActivity } from '@/queries/sql';
import { GET } from './route';

vi.mock('@/lib/request', () => ({
  getQueryFilters: vi.fn(),
  parseRequest: vi.fn(),
}));

vi.mock('@/permissions', () => ({
  canViewWebsiteSection: vi.fn(),
}));

vi.mock('@/queries/sql', () => ({
  getLinkedDistinctIds: vi.fn(),
  getLinkedSessionIds: vi.fn(),
  getSessionActivity: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getQueryFiltersMock = vi.mocked(getQueryFilters);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const getLinkedSessionIdsMock = vi.mocked(getLinkedSessionIds);
const getSessionActivityMock = vi.mocked(getSessionActivity);
const WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const LINKED_SESSION_ID_1 = '00000000-0000-4000-8000-000000000003';
const LINKED_SESSION_ID_2 = '00000000-0000-4000-8000-000000000004';

beforeEach(() => {
  parseRequestMock.mockReset();
  getQueryFiltersMock.mockReset();
  canViewWebsiteSectionMock.mockReset();
  getLinkedSessionIdsMock.mockReset();
  getSessionActivityMock.mockReset();
});

test('uses linked session months to widen stitched activity without scanning event bounds', async () => {
  const query = {
    startAt: +new Date('2026-07-20T23:38:54.000Z'),
    endAt: +new Date('2026-07-21T00:08:01.000Z'),
    distinctId: 'bob@aol.com',
  };
  const linkedStart = new Date('2026-05-15T12:00:00.000Z');
  const linkedEnd = new Date('2026-08-02T12:00:00.000Z');
  const filters = {
    startDate: startOfMonth(linkedStart),
    endDate: endOfMonth(linkedEnd),
  };

  parseRequestMock.mockResolvedValue({ auth: {}, query, error: undefined });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getLinkedSessionIdsMock.mockResolvedValue([
    { sessionId: LINKED_SESSION_ID_1, createdAt: linkedStart.toISOString() },
    { sessionId: LINKED_SESSION_ID_2, createdAt: linkedEnd.toISOString() },
  ]);
  getQueryFiltersMock.mockResolvedValue(filters);
  getSessionActivityMock.mockResolvedValue([{ eventId: 'event-1' }]);

  const response = await GET(
    new Request(
      `http://localhost/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}/activity?startAt=1784590734000&endAt=1784592481000&distinctId=bob%40aol.com`,
    ),
    {
      params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
    },
  );

  expect(response.status).toBe(200);
  expect(getLinkedSessionIdsMock).toHaveBeenCalledWith(WEBSITE_ID, 'bob@aol.com');
  expect(getQueryFiltersMock).toHaveBeenCalledWith(
    {
      ...query,
      startAt: +startOfMonth(linkedStart),
      endAt: +endOfMonth(linkedEnd),
    },
    WEBSITE_ID,
  );
  expect(getSessionActivityMock).toHaveBeenCalledWith(
    WEBSITE_ID,
    [SESSION_ID, LINKED_SESSION_ID_1, LINKED_SESSION_ID_2],
    filters,
  );
  await expect(response.json()).resolves.toEqual([{ eventId: 'event-1' }]);
});
