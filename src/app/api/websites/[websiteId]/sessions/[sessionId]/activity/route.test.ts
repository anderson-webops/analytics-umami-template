import { endOfMonth, startOfMonth } from 'date-fns';
import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canViewWebsiteSection } from '@/permissions';
import {
  getLinkedDistinctIds,
  getLinkedSessionIds,
  getSessionActivity,
  getWebsiteSession,
} from '@/queries/sql';
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
  getWebsiteSession: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getQueryFiltersMock = vi.mocked(getQueryFilters);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const getLinkedDistinctIdsMock = vi.mocked(getLinkedDistinctIds);
const getLinkedSessionIdsMock = vi.mocked(getLinkedSessionIds);
const getSessionActivityMock = vi.mocked(getSessionActivity);
const getWebsiteSessionMock = vi.mocked(getWebsiteSession);
const WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const LINKED_SESSION_ID_1 = '00000000-0000-4000-8000-000000000003';
const LINKED_SESSION_ID_2 = '00000000-0000-4000-8000-000000000004';

beforeEach(() => {
  parseRequestMock.mockReset();
  getQueryFiltersMock.mockReset();
  canViewWebsiteSectionMock.mockReset();
  getLinkedDistinctIdsMock.mockReset();
  getLinkedSessionIdsMock.mockReset();
  getSessionActivityMock.mockReset();
  getWebsiteSessionMock.mockReset();
  getWebsiteSessionMock.mockResolvedValue({
    id: SESSION_ID,
    distinctId: 'bob@aol.com',
  } as Awaited<ReturnType<typeof getWebsiteSession>>);
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

  parseRequestMock.mockResolvedValue({
    auth: { user: { id: `activity-user-${crypto.randomUUID()}` } },
    query,
    error: undefined,
  });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getLinkedDistinctIdsMock.mockResolvedValue(['bob@aol.com']);
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
  expect(getLinkedSessionIdsMock).toHaveBeenCalledWith(WEBSITE_ID, 'bob@aol.com', 2001);
  expect(getWebsiteSessionMock).toHaveBeenCalledWith(WEBSITE_ID, SESSION_ID);
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

test('keeps activity scoped to the raw session when multiple identities are linked', async () => {
  const query = {
    startAt: +new Date('2026-07-20T23:38:54.000Z'),
    endAt: +new Date('2026-07-21T00:08:01.000Z'),
  };
  const filters = { startDate: new Date(query.startAt), endDate: new Date(query.endAt) };

  parseRequestMock.mockResolvedValue({ auth: {}, query, error: undefined });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getLinkedDistinctIdsMock.mockResolvedValue(['distinct-1', 'distinct-2']);
  getQueryFiltersMock.mockResolvedValue(filters);
  getSessionActivityMock.mockResolvedValue([{ eventId: 'event-1' }]);

  await GET(
    new Request(
      `http://localhost/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}/activity?startAt=1784590734000&endAt=1784592481000`,
    ),
    {
      params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
    },
  );

  expect(getLinkedSessionIdsMock).not.toHaveBeenCalled();
  expect(getSessionActivityMock).toHaveBeenCalledWith(WEBSITE_ID, [SESSION_ID], filters);
});

test('rejects an unrelated identity before reading linked history or activity', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {},
    query: { startAt: 1, endAt: 2, distinctId: 'unrelated' },
    error: undefined,
  });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getLinkedDistinctIdsMock.mockResolvedValue(['bob@aol.com']);

  const response = await GET(new Request('http://localhost'), {
    params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
  });

  expect(response.status).toBe(400);
  expect(getLinkedSessionIdsMock).not.toHaveBeenCalled();
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});

test('rejects a supplied identity when the anchor has collided identities', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {},
    query: { startAt: 1, endAt: 2, distinctId: 'bob@aol.com' },
    error: undefined,
  });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getLinkedDistinctIdsMock.mockResolvedValue(['bob@aol.com', 'other']);

  const response = await GET(new Request('http://localhost'), {
    params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
  });

  expect(response.status).toBe(400);
  expect(getLinkedSessionIdsMock).not.toHaveBeenCalled();
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});

test('uses the existing session identity when there are no link rows', async () => {
  parseRequestMock.mockResolvedValue({
    auth: { user: { id: `activity-user-${crypto.randomUUID()}` } },
    query: { startAt: 1, endAt: 2, distinctId: 'bob@aol.com' },
    error: undefined,
  });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getLinkedDistinctIdsMock.mockResolvedValue([]);
  getLinkedSessionIdsMock.mockResolvedValue([]);
  getQueryFiltersMock.mockResolvedValue({});
  getSessionActivityMock.mockResolvedValue([]);

  const response = await GET(new Request('http://localhost'), {
    params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
  });

  expect(response.status).toBe(200);
  expect(getLinkedSessionIdsMock).toHaveBeenCalledWith(WEBSITE_ID, 'bob@aol.com', 2001);
  expect(getSessionActivityMock).toHaveBeenCalledWith(WEBSITE_ID, [SESSION_ID], {});
});

test('rejects an unknown anchor even when the caller supplies an identity', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {},
    query: { startAt: 1, endAt: 2, distinctId: 'bob@aol.com' },
    error: undefined,
  });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getWebsiteSessionMock.mockResolvedValue(undefined);

  const response = await GET(new Request('http://localhost'), {
    params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
  });

  expect(response.status).toBe(404);
  expect(getLinkedDistinctIdsMock).not.toHaveBeenCalled();
  expect(getLinkedSessionIdsMock).not.toHaveBeenCalled();
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});

test('does not query session data when the sessions section is denied', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {},
    query: { startAt: 1, endAt: 2 },
    error: undefined,
  });
  canViewWebsiteSectionMock.mockResolvedValue(false);

  const response = await GET(new Request('http://localhost'), {
    params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
  });

  expect(response.status).toBe(401);
  expect(canViewWebsiteSectionMock).toHaveBeenCalledWith({}, WEBSITE_ID, 'sessions');
  expect(getWebsiteSessionMock).not.toHaveBeenCalled();
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});
