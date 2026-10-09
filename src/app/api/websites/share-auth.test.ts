import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import {
  canCreateWebsite,
  canUpdateWebsite,
  canViewAllWebsites,
  canViewAuthenticatedWebsite,
  canViewSharedWebsite,
  canViewTeam,
  redactWebsiteListShareIds,
} from '@/permissions';
import { createWebsite, getTeamWebsites, getWebsite, updateWebsite } from '@/queries/prisma';
import {
  getAllUserWebsitesIncludingTeamAccess,
  getUserWebsites,
  getWebsites,
} from '@/queries/prisma/website';
import { GET as getAdminWebsitesRoute } from '../admin/websites/route';
import { GET as getMyWebsitesRoute } from '../me/websites/route';
import { GET as getTeamWebsitesRoute } from '../teams/[teamId]/websites/route';
import { GET as getUserWebsitesRoute } from '../users/[userId]/websites/route';
import { GET as getWebsiteRoute, POST as update } from './[websiteId]/route';
import { POST as create, GET as listWebsitesRoute } from './route';

const websiteListMocks = vi.hoisted(() => ({
  getAllUserWebsitesIncludingTeamAccess: vi.fn(),
  getUserWebsites: vi.fn(),
  getWebsites: vi.fn(),
}));

vi.mock('@/lib/load', () => ({ fetchAccount: vi.fn(), fetchTeam: vi.fn() }));
vi.mock('@/lib/request', () => ({ getQueryFilters: vi.fn(), parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canCreateWebsite: vi.fn(),
  canUpdateWebsite: vi.fn(),
  canViewAllWebsites: vi.fn(),
  canViewAuthenticatedWebsite: vi.fn(),
  canViewSharedWebsite: vi.fn(),
  canViewTeam: vi.fn(),
  redactWebsiteListShareIds: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  createWebsite: vi.fn(),
  getAllUserWebsitesIncludingTeamAccess: websiteListMocks.getAllUserWebsitesIncludingTeamAccess,
  getTeamWebsites: vi.fn(),
  getUserWebsites: websiteListMocks.getUserWebsites,
  getWebsites: websiteListMocks.getWebsites,
  getWebsite: vi.fn(),
  updateWebsite: vi.fn(),
}));
vi.mock('@/queries/prisma/website', () => websiteListMocks);

const getQueryFiltersMock = vi.mocked(getQueryFilters);
const parseRequestMock = vi.mocked(parseRequest);
const canCreateWebsiteMock = vi.mocked(canCreateWebsite);
const canUpdateWebsiteMock = vi.mocked(canUpdateWebsite);
const canViewAllWebsitesMock = vi.mocked(canViewAllWebsites);
const canViewAuthenticatedWebsiteMock = vi.mocked(canViewAuthenticatedWebsite);
const canViewSharedWebsiteMock = vi.mocked(canViewSharedWebsite);
const canViewTeamMock = vi.mocked(canViewTeam);
const redactWebsiteListShareIdsMock = vi.mocked(redactWebsiteListShareIds);
const createWebsiteMock = vi.mocked(createWebsite);
const getAllUserWebsitesMock = vi.mocked(getAllUserWebsitesIncludingTeamAccess);
const getTeamWebsitesMock = vi.mocked(getTeamWebsites);
const getUserWebsitesMock = vi.mocked(getUserWebsites);
const getWebsitesMock = vi.mocked(getWebsites);
const getWebsiteMock = vi.mocked(getWebsite);
const updateWebsiteMock = vi.mocked(updateWebsite);
const websiteId = '3979e857-a987-4795-9380-12024a4440a9';

function setAuth(authType: 'api-key' | 'session', shareId?: string | null, includeTeams = false) {
  parseRequestMock.mockResolvedValue({
    auth: { authType, user: { id: 'user-1', username: 'user', role: 'user', isAdmin: false } },
    body: { name: 'Example', domain: 'example.com', ...(shareId !== undefined && { shareId }) },
    query: includeTeams ? { includeTeams: 'true' } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  canCreateWebsiteMock.mockResolvedValue(true);
  canUpdateWebsiteMock.mockResolvedValue(true);
  canViewAllWebsitesMock.mockResolvedValue(true);
  canViewAuthenticatedWebsiteMock.mockResolvedValue(true);
  canViewSharedWebsiteMock.mockResolvedValue(true);
  canViewTeamMock.mockResolvedValue(true);
  getQueryFiltersMock.mockResolvedValue({} as any);
  createWebsiteMock.mockResolvedValue({ website: { id: websiteId }, share: null } as any);
  updateWebsiteMock.mockResolvedValue({
    website: { id: websiteId },
    share: { slug: 'existing-public-slug' },
  } as any);
  getWebsiteMock.mockResolvedValue({ id: websiteId, shareId: 'existing-public-slug' } as any);
  const page = { data: [{ id: websiteId, shareId: 'existing-public-slug' }], count: 1 };
  getAllUserWebsitesMock.mockResolvedValue(page as any);
  getTeamWebsitesMock.mockResolvedValue(page as any);
  getUserWebsitesMock.mockResolvedValue(page as any);
  getWebsitesMock.mockResolvedValue(page as any);
  redactWebsiteListShareIdsMock.mockImplementation(async (auth, websites) =>
    websites.map(website => ({
      ...website,
      shareId:
        auth.authType === 'session' && auth.user?.role !== 'view-only' ? website.shareId : null,
    })),
  );
});

test('API keys cannot create public shares through website creation', async () => {
  setAuth('api-key', 'public-slug');
  const blocked = await create(new Request('http://localhost/api/websites', { method: 'POST' }));
  expect(blocked.status).toBe(401);
  expect(createWebsiteMock).not.toHaveBeenCalled();

  setAuth('api-key');
  const allowed = await create(new Request('http://localhost/api/websites', { method: 'POST' }));
  expect(allowed.status).toBe(200);
  expect(createWebsiteMock).toHaveBeenCalledWith(
    expect.anything(),
    'user-1',
    expect.objectContaining({ initialShare: undefined }),
  );
});

test('API keys cannot change public shares through website updates', async () => {
  for (const shareId of ['public-slug', null]) {
    setAuth('api-key', shareId);
    const blocked = await update(
      new Request(`http://localhost/api/websites/${websiteId}`, { method: 'POST' }),
      { params: Promise.resolve({ websiteId }) },
    );
    expect(blocked.status).toBe(401);
  }
  expect(updateWebsiteMock).not.toHaveBeenCalled();

  setAuth('api-key');
  const allowed = await update(
    new Request(`http://localhost/api/websites/${websiteId}`, { method: 'POST' }),
    { params: Promise.resolve({ websiteId }) },
  );
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).shareId).toBeNull();
});

test.each(['api-key', 'session'] as const)(
  '%s website reads preserve authorized data without leaking share slugs to API keys',
  async authType => {
    setAuth(authType);
    const requests = [
      listWebsitesRoute(new Request('http://localhost/api/websites')),
      getMyWebsitesRoute(new Request('http://localhost/api/me/websites')),
      getTeamWebsitesRoute(new Request('http://localhost/api/teams/team-1/websites'), {
        params: Promise.resolve({ teamId: 'team-1' }),
      }),
    ];

    for (const pending of requests) {
      const response = await pending;
      expect(response.status).toBe(200);
      expect((await response.json()).data[0]).toEqual({
        id: websiteId,
        shareId: authType === 'api-key' ? null : 'existing-public-slug',
      });
    }

    const detail = await getWebsiteRoute(
      new Request(`http://localhost/api/websites/${websiteId}`),
      {
        params: Promise.resolve({ websiteId }),
      },
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).shareId).toBe(
      authType === 'api-key' ? null : 'existing-public-slug',
    );

    setAuth(authType, undefined, true);
    for (const pending of [
      listWebsitesRoute(new Request('http://localhost/api/websites?includeTeams=true')),
      getMyWebsitesRoute(new Request('http://localhost/api/me/websites?includeTeams=true')),
    ]) {
      const response = await pending;
      expect(response.status).toBe(200);
      expect((await response.json()).data[0].shareId).toBe(
        authType === 'api-key' ? null : 'existing-public-slug',
      );
    }
  },
);

test('read-only website access does not reveal a public share slug', async () => {
  setAuth('session');
  canUpdateWebsiteMock.mockResolvedValue(false);
  redactWebsiteListShareIdsMock.mockImplementation(async (_auth, websites) =>
    websites.map(website => ({ ...website, shareId: null })),
  );

  const detail = await getWebsiteRoute(new Request(`http://localhost/api/websites/${websiteId}`), {
    params: Promise.resolve({ websiteId }),
  });
  const teamList = await getTeamWebsitesRoute(
    new Request('http://localhost/api/teams/team-1/websites'),
    { params: Promise.resolve({ teamId: 'team-1' }) },
  );

  expect(detail.status).toBe(200);
  expect((await detail.json()).shareId).toBeNull();
  expect(teamList.status).toBe(200);
  expect((await teamList.json()).data[0].shareId).toBeNull();
});

test('share-only website reads never expose private website metadata', async () => {
  getWebsiteMock.mockResolvedValue({
    id: websiteId,
    name: 'Shared site',
    domain: 'example.com',
    resetAt: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    userId: 'owner-1',
    shareId: 'private-share-slug',
    replayConfig: { capture: true },
  } as any);
  canViewAuthenticatedWebsiteMock.mockResolvedValue(false);

  for (const auth of [
    { shareToken: { websiteId } },
    { user: { id: 'unrelated-user' }, shareToken: { websiteId } },
  ]) {
    parseRequestMock.mockResolvedValue({ auth } as any);
    const response = await getWebsiteRoute(
      new Request(`http://localhost/api/websites/${websiteId}`),
      {
        params: Promise.resolve({ websiteId }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: websiteId,
      name: 'Shared site',
      domain: 'example.com',
      resetAt: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
    });
  }
  expect(canViewAuthenticatedWebsiteMock).toHaveBeenCalledTimes(2);

  parseRequestMock.mockResolvedValue({ auth: { user: { id: 'owner-1' } } } as any);
  canViewAuthenticatedWebsiteMock.mockResolvedValue(true);
  const ownerResponse = await getWebsiteRoute(
    new Request(`http://localhost/api/websites/${websiteId}`),
    { params: Promise.resolve({ websiteId }) },
  );
  expect(ownerResponse.status).toBe(200);
  expect(await ownerResponse.json()).toEqual(expect.objectContaining({ userId: 'owner-1' }));
});

test('a downgraded view-only owner cannot discover public share slugs through website lists', async () => {
  const userId = '9ba94192-bc42-4786-9c5a-aa109aebcd77';
  for (const includeTeams of [false, true]) {
    const search = includeTeams ? '?includeTeams=true' : '';
    parseRequestMock.mockResolvedValue({
      auth: {
        authType: 'session',
        user: { id: userId, username: 'viewer', role: 'view-only', isAdmin: false },
      },
      query: includeTeams ? { includeTeams: 'true' } : {},
    } as any);

    for (const response of await Promise.all([
      listWebsitesRoute(new Request(`http://localhost/api/websites${search}`)),
      getMyWebsitesRoute(new Request(`http://localhost/api/me/websites${search}`)),
      getTeamWebsitesRoute(new Request('http://localhost/api/teams/team-1/websites'), {
        params: Promise.resolve({ teamId: 'team-1' }),
      }),
      getUserWebsitesRoute(new Request(`http://localhost/api/users/${userId}/websites${search}`), {
        params: Promise.resolve({ userId }),
      }),
    ])) {
      expect(response.status).toBe(200);
      expect((await response.json()).data[0].shareId).toBeNull();
    }
  }
});

test('admin website lists also honor current share-management authority', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {
      authType: 'session',
      user: { id: 'admin-1', username: 'admin', role: 'view-only', isAdmin: true },
    },
    query: {},
  } as any);

  const response = await getAdminWebsitesRoute(new Request('http://localhost/api/admin/websites'));
  expect(response.status).toBe(200);
  expect((await response.json()).data[0].shareId).toBeNull();
  expect(redactWebsiteListShareIdsMock).toHaveBeenCalledTimes(1);
});

test('interactive sessions retain website share management', async () => {
  setAuth('session', 'public-slug');
  const created = await create(new Request('http://localhost/api/websites', { method: 'POST' }));
  expect(created.status).toBe(200);
  expect(createWebsiteMock).toHaveBeenCalledWith(
    expect.anything(),
    'user-1',
    expect.objectContaining({ initialShare: expect.objectContaining({ slug: 'public-slug' }) }),
  );

  const updated = await update(
    new Request(`http://localhost/api/websites/${websiteId}`, { method: 'POST' }),
    { params: Promise.resolve({ websiteId }) },
  );
  expect(updated.status).toBe(200);
  expect(updateWebsiteMock).toHaveBeenCalledWith(
    websiteId,
    expect.anything(),
    'user-1',
    expect.objectContaining({ shareSlug: 'public-slug' }),
  );
});
