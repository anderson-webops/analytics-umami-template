import { beforeEach, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { parseRequest } from '@/lib/request';
import { MAX_SHARE_SESSION_ROWS, reserveShareQueryCost } from '@/lib/share-query-budget';
import { canDeleteWebsite, canViewWebsiteSection } from '@/permissions';
import {
  getLinkedDistinctIds,
  getLinkedSessionIds,
  getSessionData,
  getWebsiteSession,
} from '@/queries/sql';
import { GET as getSessionProperties } from './websites/[websiteId]/sessions/[sessionId]/properties/route';
import { GET as getSessionDetail } from './websites/[websiteId]/sessions/[sessionId]/route';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
  delete process.env.DATABASE_REPLICA_URL;
});

vi.mock('@/lib/auth', () => ({ checkAuth: vi.fn() }));
vi.mock('@/permissions', () => ({
  canDeleteWebsite: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));
vi.mock('@/queries/sql', () => ({
  getLinkedDistinctIds: vi.fn(),
  getLinkedSessionIds: vi.fn(),
  getSessionData: vi.fn(),
  getWebsiteSession: vi.fn(),
}));

const checkAuthMock = vi.mocked(checkAuth);
const canDeleteWebsiteMock = vi.mocked(canDeleteWebsite);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const getLinkedDistinctIdsMock = vi.mocked(getLinkedDistinctIds);
const getLinkedSessionIdsMock = vi.mocked(getLinkedSessionIds);
const getSessionDataMock = vi.mocked(getSessionData);
const getWebsiteSessionMock = vi.mocked(getWebsiteSession);
const WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const params = { params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }) };

beforeEach(() => {
  checkAuthMock.mockReset();
  canDeleteWebsiteMock.mockReset();
  canViewWebsiteSectionMock.mockReset();
  getLinkedDistinctIdsMock.mockReset();
  getLinkedSessionIdsMock.mockReset();
  getSessionDataMock.mockReset();
  getWebsiteSessionMock.mockReset();
  canViewWebsiteSectionMock.mockResolvedValue(true);
  canDeleteWebsiteMock.mockResolvedValue(false);
  getWebsiteSessionMock.mockResolvedValue({ id: SESSION_ID, distinctId: 'visitor-1' } as any);
  getLinkedDistinctIdsMock.mockResolvedValue(['visitor-1']);
  getLinkedSessionIdsMock.mockResolvedValue([]);
  getSessionDataMock.mockResolvedValue([]);
});

test.each([
  ['detail', getSessionDetail, getWebsiteSessionMock],
  ['properties', getSessionProperties, getSessionDataMock],
] as const)(
  '%s rejects an exhausted public-share budget before querying',
  async (_, handler, query) => {
    const shareId = `session-budget-${crypto.randomUUID()}`;
    checkAuthMock.mockResolvedValue({ shareToken: { shareId, websiteId: WEBSITE_ID } } as any);
    expect(await reserveShareQueryCost(shareId, 600)).toMatchObject({ blocked: false });

    const response = await handler(
      new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
      params,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(query).not.toHaveBeenCalled();
  },
);

test.each([
  ['detail', getSessionDetail],
  ['properties', getSessionProperties],
] as const)('%s preserves signed-in access without a share budget', async (_, handler) => {
  checkAuthMock.mockResolvedValue({ user: { id: 'owner-1' } } as any);

  const response = await handler(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    params,
  );

  expect(response.status).toBe(200);
});

test('a signed-in caller presenting a share token remains subject to its budget', async () => {
  const shareId = `session-budget-${crypto.randomUUID()}`;
  checkAuthMock.mockResolvedValue({
    user: { id: 'owner-1' },
    shareToken: { shareId, websiteId: WEBSITE_ID },
  } as any);
  expect(await reserveShareQueryCost(shareId, 600)).toMatchObject({ blocked: false });

  const response = await getSessionDetail(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    params,
  );

  expect(response.status).toBe(429);
  expect(getWebsiteSessionMock).not.toHaveBeenCalled();
});

test('public session detail refuses oversized linked identity results', async () => {
  checkAuthMock.mockResolvedValue({ shareToken: { shareId: crypto.randomUUID() } } as any);
  getLinkedDistinctIdsMock.mockResolvedValue(Array(MAX_SHARE_SESSION_ROWS + 1).fill('visitor'));

  const response = await getSessionDetail(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    params,
  );

  expect(response.status).toBe(400);
  expect(getLinkedDistinctIdsMock).toHaveBeenCalledWith(
    WEBSITE_ID,
    SESSION_ID,
    MAX_SHARE_SESSION_ROWS + 1,
  );
  expect(getLinkedSessionIdsMock).not.toHaveBeenCalled();
});

test('public session detail refuses oversized linked session results', async () => {
  checkAuthMock.mockResolvedValue({ shareToken: { shareId: crypto.randomUUID() } } as any);
  getLinkedSessionIdsMock.mockResolvedValue(
    Array(MAX_SHARE_SESSION_ROWS + 1).fill({ sessionId: SESSION_ID, createdAt: new Date() }),
  );

  const response = await getSessionDetail(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    params,
  );

  expect(response.status).toBe(400);
  expect(getLinkedSessionIdsMock).toHaveBeenCalledWith(
    WEBSITE_ID,
    'visitor-1',
    MAX_SHARE_SESSION_ROWS + 1,
  );
});

test('public session detail rejects an anchor beyond the linked-session limit', async () => {
  checkAuthMock.mockResolvedValue({ shareToken: { shareId: crypto.randomUUID() } } as any);
  getLinkedSessionIdsMock.mockResolvedValue(
    Array.from({ length: MAX_SHARE_SESSION_ROWS }, (_, index) => ({
      sessionId: `linked-${index}`,
      createdAt: new Date().toISOString(),
    })),
  );

  const response = await getSessionDetail(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    params,
  );

  expect(response.status).toBe(400);
});

test('an explicitly budgeted public share fails closed without a query schema', async () => {
  checkAuthMock.mockResolvedValue({ shareToken: { shareId: crypto.randomUUID() } } as any);

  const { error } = await parseRequest(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    undefined,
    { budgetShareQuery: true },
  );

  expect(error?.().status).toBe(400);
});

test('public session properties refuses oversized result sets', async () => {
  checkAuthMock.mockResolvedValue({ shareToken: { shareId: crypto.randomUUID() } } as any);
  getSessionDataMock.mockResolvedValue(Array(MAX_SHARE_SESSION_ROWS + 1).fill({ dataKey: 'key' }));

  const response = await getSessionProperties(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    params,
  );

  expect(response.status).toBe(400);
  expect(getSessionDataMock).toHaveBeenCalledWith(
    WEBSITE_ID,
    SESSION_ID,
    MAX_SHARE_SESSION_ROWS + 1,
  );
});

test('signed-in session detail keeps unbounded source compatibility', async () => {
  checkAuthMock.mockResolvedValue({ user: { id: 'owner-1' } } as any);

  const response = await getSessionDetail(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    params,
  );

  expect(response.status).toBe(200);
  expect(getLinkedDistinctIdsMock).toHaveBeenCalledWith(WEBSITE_ID, SESSION_ID, undefined);
  expect(getLinkedSessionIdsMock).toHaveBeenCalledWith(WEBSITE_ID, 'visitor-1', undefined);
});

test.each([
  ['detail', getSessionDetail, getWebsiteSessionMock],
  ['properties', getSessionProperties, getSessionDataMock],
] as const)('%s requires the sessions share section', async (_, handler, query) => {
  checkAuthMock.mockResolvedValue({ shareToken: { shareId: crypto.randomUUID() } } as any);
  canViewWebsiteSectionMock.mockResolvedValue(false);

  const response = await handler(
    new Request(`https://analytics.example/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    params,
  );

  expect(response.status).toBe(401);
  expect(canViewWebsiteSectionMock).toHaveBeenCalledWith(expect.anything(), WEBSITE_ID, 'sessions');
  expect(query).not.toHaveBeenCalled();
});
