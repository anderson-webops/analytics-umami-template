import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import {
  MAX_AUTH_SESSION_ROWS,
  reserveAuthenticatedQueryCost,
  reserveShareQueryCost,
} from '@/lib/share-query-budget';
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
vi.mock('@/permissions', () => ({ canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql', () => ({
  getLinkedDistinctIds: vi.fn(),
  getLinkedSessionIds: vi.fn(),
  getSessionActivity: vi.fn(),
  getWebsiteSession: vi.fn(),
}));

const getQueryFiltersMock = vi.mocked(getQueryFilters);
const parseRequestMock = vi.mocked(parseRequest);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const getLinkedDistinctIdsMock = vi.mocked(getLinkedDistinctIds);
const getLinkedSessionIdsMock = vi.mocked(getLinkedSessionIds);
const getSessionActivityMock = vi.mocked(getSessionActivity);
const getWebsiteSessionMock = vi.mocked(getWebsiteSession);
const WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const LINKED_SESSION_ID = '00000000-0000-4000-8000-000000000003';
const startAt = Date.UTC(2025, 11, 28);
const endAt = Date.UTC(2025, 11, 29);
const params = { params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }) };
let shareId: string;

beforeEach(() => {
  shareId = `activity-budget-${crypto.randomUUID()}`;
  getQueryFiltersMock.mockReset();
  parseRequestMock.mockReset();
  canViewWebsiteSectionMock.mockReset();
  getLinkedDistinctIdsMock.mockReset();
  getLinkedSessionIdsMock.mockReset();
  getSessionActivityMock.mockReset();
  getWebsiteSessionMock.mockReset();
  parseRequestMock.mockResolvedValue({
    auth: { shareToken: { shareId, websiteId: WEBSITE_ID } },
    query: { startAt, endAt },
  });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  getWebsiteSessionMock.mockResolvedValue({
    id: SESSION_ID,
    distinctId: 'visitor-1',
  } as Awaited<ReturnType<typeof getWebsiteSession>>);
  getLinkedDistinctIdsMock.mockResolvedValue(['visitor-1']);
  getLinkedSessionIdsMock.mockResolvedValue([
    { sessionId: LINKED_SESSION_ID, createdAt: '2006-01-15T00:00:00.000Z' },
  ]);
  getQueryFiltersMock.mockResolvedValue({});
  getSessionActivityMock.mockResolvedValue([]);
});

test('blocks a historical range that exceeds the remaining share budget', async () => {
  expect(await reserveShareQueryCost(shareId, 450)).toMatchObject({ blocked: false });

  const response = await GET(new Request('http://localhost'), params);

  expect(response.status).toBe(429);
  expect(getLinkedDistinctIdsMock).toHaveBeenCalledWith(WEBSITE_ID, SESSION_ID, 2);
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});

test('allows linked history until the actual-range budget is exhausted', async () => {
  const responses = [
    await GET(new Request('http://localhost'), params),
    await GET(new Request('http://localhost'), params),
    await GET(new Request('http://localhost'), params),
  ];

  expect(responses.map(response => response.status)).toEqual([200, 200, 429]);
  expect(getSessionActivityMock).toHaveBeenCalledTimes(2);
});

test('rejects oversized linked histories before reading activity', async () => {
  getLinkedSessionIdsMock.mockResolvedValue(
    Array(501).fill({ sessionId: LINKED_SESSION_ID, createdAt: '2025-12-29T00:00:00.000Z' }),
  );

  const response = await GET(new Request('http://localhost'), params);

  expect(response.status).toBe(400);
  expect(getLinkedSessionIdsMock).toHaveBeenCalledWith(WEBSITE_ID, 'visitor-1', 501);
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});

test('authenticated linked activity reserves the expanded range before reading', async () => {
  const userId = `linked-user-${crypto.randomUUID()}`;
  parseRequestMock.mockResolvedValue({ auth: { user: { id: userId } }, query: { startAt, endAt } });
  expect((await reserveAuthenticatedQueryCost(userId, 19_900)).blocked).toBe(false);

  const response = await GET(new Request('http://localhost'), params);

  expect(response.status).toBe(429);
  expect(getLinkedSessionIdsMock).toHaveBeenCalledWith(WEBSITE_ID, 'visitor-1', 2_001);
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});

test('authenticated linked activity rejects unbounded session histories', async () => {
  parseRequestMock.mockResolvedValue({
    auth: { user: { id: `linked-user-${crypto.randomUUID()}` } },
    query: { startAt, endAt },
  });
  getLinkedSessionIdsMock.mockResolvedValue(
    Array(MAX_AUTH_SESSION_ROWS + 1).fill({
      sessionId: LINKED_SESSION_ID,
      createdAt: '2025-12-29T00:00:00.000Z',
    }),
  );

  const response = await GET(new Request('http://localhost'), params);

  expect(response.status).toBe(400);
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});

test('rejects an unrelated supplied identity before reading linked history', async () => {
  parseRequestMock.mockResolvedValue({
    auth: { shareToken: { shareId, websiteId: WEBSITE_ID } },
    query: { startAt, endAt, distinctId: 'intruder' },
  });

  const response = await GET(new Request('http://localhost'), params);

  expect(response.status).toBe(400);
  expect(getLinkedSessionIdsMock).not.toHaveBeenCalled();
  expect(getSessionActivityMock).not.toHaveBeenCalled();
});

test('requires sessions permission rather than another analytics section', async () => {
  canViewWebsiteSectionMock.mockResolvedValue(false);

  const response = await GET(new Request('http://localhost'), params);

  expect(response.status).toBe(401);
  expect(canViewWebsiteSectionMock).toHaveBeenCalledWith(expect.anything(), WEBSITE_ID, 'sessions');
  expect(getWebsiteSessionMock).not.toHaveBeenCalled();
});
