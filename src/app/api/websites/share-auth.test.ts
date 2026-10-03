import { beforeEach, expect, test, vi } from 'vitest';
import { getQueryFilters, parseRequest } from '@/lib/request';
import {
  canCreateWebsite,
  canUpdateWebsite,
  canViewSharedWebsite,
  canViewTeam,
} from '@/permissions';
import { createWebsite, getTeamWebsites, getWebsite, updateWebsite } from '@/queries/prisma';
import { getAllUserWebsitesIncludingTeamAccess, getUserWebsites } from '@/queries/prisma/website';
import { GET as getMyWebsitesRoute } from '../me/websites/route';
import { GET as getTeamWebsitesRoute } from '../teams/[teamId]/websites/route';
import { GET as getWebsiteRoute, POST as update } from './[websiteId]/route';
import { POST as create, GET as listWebsitesRoute } from './route';

const websiteListMocks = vi.hoisted(() => ({
  getAllUserWebsitesIncludingTeamAccess: vi.fn(),
  getUserWebsites: vi.fn(),
}));

vi.mock('@/lib/load', () => ({ fetchAccount: vi.fn(), fetchTeam: vi.fn() }));
vi.mock('@/lib/request', () => ({ getQueryFilters: vi.fn(), parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canCreateWebsite: vi.fn(),
  canUpdateWebsite: vi.fn(),
  canViewSharedWebsite: vi.fn(),
  canViewTeam: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  createWebsite: vi.fn(),
  getAllUserWebsitesIncludingTeamAccess: websiteListMocks.getAllUserWebsitesIncludingTeamAccess,
  getTeamWebsites: vi.fn(),
  getUserWebsites: websiteListMocks.getUserWebsites,
  getWebsite: vi.fn(),
  updateWebsite: vi.fn(),
}));
vi.mock('@/queries/prisma/website', () => websiteListMocks);

const getQueryFiltersMock = vi.mocked(getQueryFilters);
const parseRequestMock = vi.mocked(parseRequest);
const canCreateWebsiteMock = vi.mocked(canCreateWebsite);
const canUpdateWebsiteMock = vi.mocked(canUpdateWebsite);
const canViewSharedWebsiteMock = vi.mocked(canViewSharedWebsite);
const canViewTeamMock = vi.mocked(canViewTeam);
const createWebsiteMock = vi.mocked(createWebsite);
const getAllUserWebsitesMock = vi.mocked(getAllUserWebsitesIncludingTeamAccess);
const getTeamWebsitesMock = vi.mocked(getTeamWebsites);
const getUserWebsitesMock = vi.mocked(getUserWebsites);
const getWebsiteMock = vi.mocked(getWebsite);
const updateWebsiteMock = vi.mocked(updateWebsite);
const websiteId = '3979e857-a987-4795-9380-12024a4440a9';

function setAuth(authType: 'api-key' | 'session', shareId?: string | null, includeTeams = false) {
  parseRequestMock.mockResolvedValue({
    auth: { authType, user: { id: 'user-1', isAdmin: false } },
    body: { name: 'Example', domain: 'example.com', ...(shareId !== undefined && { shareId }) },
    query: includeTeams ? { includeTeams: 'true' } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  canCreateWebsiteMock.mockResolvedValue(true);
  canUpdateWebsiteMock.mockResolvedValue(true);
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
