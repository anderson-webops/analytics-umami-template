import { beforeEach, expect, test, vi } from 'vitest';
import { isRelationalOnly } from '@/lib/db';
import { parseRequest } from '@/lib/request';
import { canDeleteWebsite, canViewWebsiteSection } from '@/permissions';
import { deleteSession } from '@/queries/prisma';
import { getLinkedDistinctIds, getLinkedSessionIds, getWebsiteSession } from '@/queries/sql';
import { DELETE, GET } from './route';

vi.mock('@/lib/db', () => ({
  isRelationalOnly: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/permissions', () => ({
  canDeleteWebsite: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  deleteSession: vi.fn(),
}));

vi.mock('@/queries/sql', () => ({
  getLinkedDistinctIds: vi.fn(),
  getLinkedSessionIds: vi.fn(),
  getWebsiteSession: vi.fn(),
}));

const isRelationalOnlyMock = vi.mocked(isRelationalOnly);
const parseRequestMock = vi.mocked(parseRequest);
const canDeleteWebsiteMock = vi.mocked(canDeleteWebsite);
const canViewWebsiteSectionMock = vi.mocked(canViewWebsiteSection);
const deleteSessionMock = vi.mocked(deleteSession);
const getLinkedDistinctIdsMock = vi.mocked(getLinkedDistinctIds);
const getLinkedSessionIdsMock = vi.mocked(getLinkedSessionIds);
const getWebsiteSessionMock = vi.mocked(getWebsiteSession);
const WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const MISSING_SESSION_ID = '00000000-0000-4000-8000-000000000003';
const LINKED_SESSION_ID = '00000000-0000-4000-8000-000000000004';

beforeEach(() => {
  isRelationalOnlyMock.mockReset();
  parseRequestMock.mockReset();
  canDeleteWebsiteMock.mockReset();
  canViewWebsiteSectionMock.mockReset();
  deleteSessionMock.mockReset();
  getLinkedDistinctIdsMock.mockReset();
  getLinkedSessionIdsMock.mockReset();
  getWebsiteSessionMock.mockReset();
});

test('GET returns not found when the session does not exist', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, error: undefined });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  isRelationalOnlyMock.mockReturnValue(true);
  canDeleteWebsiteMock.mockResolvedValue(false);
  getWebsiteSessionMock.mockResolvedValue(undefined);

  const response = await GET(
    new Request(`http://localhost/api/websites/${WEBSITE_ID}/sessions/${MISSING_SESSION_ID}`),
    {
      params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: MISSING_SESSION_ID }),
    },
  );

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'not-found', status: 404 },
  });
  expect(getLinkedDistinctIdsMock).not.toHaveBeenCalled();
  expect(getLinkedSessionIdsMock).not.toHaveBeenCalled();
});

test('GET includes canDelete when relational storage and delete permission are available', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, error: undefined });
  canViewWebsiteSectionMock.mockResolvedValue(true);
  isRelationalOnlyMock.mockReturnValue(true);
  canDeleteWebsiteMock.mockResolvedValue(true);
  getWebsiteSessionMock.mockResolvedValue({
    id: SESSION_ID,
    distinctId: 'distinct-1',
  });
  getLinkedSessionIdsMock.mockResolvedValue([
    { sessionId: LINKED_SESSION_ID, createdAt: '2026-07-24T00:00:00.000Z' },
  ]);

  const response = await GET(
    new Request(`http://localhost/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`),
    {
      params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
    },
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    id: SESSION_ID,
    canDelete: true,
    stitchedSessionCount: 2,
  });
});

test('DELETE rejects session deletion for non-relational storage', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, error: undefined });
  isRelationalOnlyMock.mockReturnValue(false);

  const response = await DELETE(
    new Request(`http://localhost/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    }),
    {
      params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
    },
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'bad-request' },
  });
  expect(canDeleteWebsiteMock).not.toHaveBeenCalled();
  expect(deleteSessionMock).not.toHaveBeenCalled();
});

test('DELETE returns unauthorized when the user cannot delete the website', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, error: undefined });
  isRelationalOnlyMock.mockReturnValue(true);
  canDeleteWebsiteMock.mockResolvedValue(false);

  const response = await DELETE(
    new Request(`http://localhost/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    }),
    {
      params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
    },
  );

  expect(response.status).toBe(401);
  expect(deleteSessionMock).not.toHaveBeenCalled();
});

test('DELETE returns not found when the session does not exist', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, error: undefined });
  isRelationalOnlyMock.mockReturnValue(true);
  canDeleteWebsiteMock.mockResolvedValue(true);
  deleteSessionMock.mockResolvedValue(null);

  const response = await DELETE(
    new Request(`http://localhost/api/websites/${WEBSITE_ID}/sessions/${MISSING_SESSION_ID}`, {
      method: 'DELETE',
    }),
    {
      params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: MISSING_SESSION_ID }),
    },
  );

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'not-found', status: 404 },
  });
});

test('DELETE removes the session when the request is valid', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, error: undefined });
  isRelationalOnlyMock.mockReturnValue(true);
  canDeleteWebsiteMock.mockResolvedValue(true);
  deleteSessionMock.mockResolvedValue({ id: SESSION_ID });

  const response = await DELETE(
    new Request(`http://localhost/api/websites/${WEBSITE_ID}/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    }),
    {
      params: Promise.resolve({ websiteId: WEBSITE_ID, sessionId: SESSION_ID }),
    },
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
  expect(deleteSessionMock).toHaveBeenCalledWith(WEBSITE_ID, SESSION_ID);
});
