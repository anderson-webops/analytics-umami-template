import { beforeEach, expect, test, vi } from 'vitest';
import { IdentitySearchTooBroadError } from '@/lib/identity-search-error';
import { getQueryFilters, parseRequest } from '@/lib/request';
import {
  canViewAuthenticatedWebsite,
  canViewSharedWebsiteFilters,
  canViewWebsiteSection,
} from '@/permissions';
import {
  getEventExpandedMetrics,
  getEventMetrics,
  getSessionExpandedMetrics,
  getSessionMetrics,
  getSessionReplays,
  getValues,
  getWebsiteSessions,
} from '@/queries/sql';
import { GET as getExpandedMetrics } from '../metrics/expanded/route';
import { GET as getMetrics } from '../metrics/route';
import { GET as getReplays } from '../replays/route';
import { GET as getValuesRoute } from '../values/route';
import { GET as getSessions } from './route';

vi.mock('@/lib/request', () => ({ getQueryFilters: vi.fn(), parseRequest: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { rawQuery: vi.fn() } }));
vi.mock('@/permissions', () => ({
  canViewAuthenticatedWebsite: vi.fn(),
  canViewSharedWebsiteFilters: vi.fn(),
  canViewWebsiteSection: vi.fn(),
}));
vi.mock('@/queries/sql', () => ({
  getEventExpandedMetrics: vi.fn(),
  getEventMetrics: vi.fn(),
  getSessionExpandedMetrics: vi.fn(),
  getSessionMetrics: vi.fn(),
  getSessionReplays: vi.fn(),
  getWebsiteSessions: vi.fn(),
  getValues: vi.fn(),
}));

const websiteId = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ websiteId }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({ auth: { user: { id: 'owner' } }, query: {} });
  vi.mocked(getQueryFilters).mockResolvedValue({ search: 'broad' });
  vi.mocked(canViewAuthenticatedWebsite).mockResolvedValue(true);
  vi.mocked(canViewSharedWebsiteFilters).mockResolvedValue(true);
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
});

test.each([
  ['sessions', getSessions, getWebsiteSessions],
  ['replays', getReplays, getSessionReplays],
] as const)(
  '%s returns a bounded error for broad verified identity search',
  async (name, route, query) => {
    vi.mocked(query).mockRejectedValue(new IdentitySearchTooBroadError());

    const response = await route(
      new Request(
        `http://localhost/api/websites/${websiteId}/${name}?startAt=1&endAt=2&search=broad`,
      ),
      params,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'bad-request' } });
  },
);

test.each([
  ['metrics', getMetrics, getSessionMetrics, 'distinctId'],
  ['expanded metrics', getExpandedMetrics, getSessionExpandedMetrics, 'distinctId'],
  ['event metrics', getMetrics, getEventMetrics, 'event'],
  ['expanded event metrics', getExpandedMetrics, getEventExpandedMetrics, 'event'],
] as const)(
  '%s returns a bounded error for a broad verified identity filter',
  async (_, route, query, type) => {
    vi.mocked(parseRequest).mockResolvedValue({
      auth: { user: { id: 'owner' } },
      query: { type, search: 'broad' },
    });
    vi.mocked(query).mockRejectedValueOnce(new IdentitySearchTooBroadError());

    const response = await route(
      new Request(`http://localhost/api/websites/${websiteId}/metrics?type=${type}&search=broad`),
      params,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'bad-request', message: 'Identity search is too broad.' },
    });
  },
);

test('metrics do not convert unrelated query failures into a client error', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'owner' } },
    query: { type: 'distinctId' },
  });
  vi.mocked(getSessionMetrics).mockRejectedValueOnce(new Error('query failed'));

  await expect(
    getMetrics(
      new Request(`http://localhost/api/websites/${websiteId}/metrics?type=distinctId`),
      params,
    ),
  ).rejects.toThrow('query failed');
});

test('identity values return a bounded error for broad verified discovery', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'owner' } },
    query: { type: 'distinctId' },
  });
  vi.mocked(getValues).mockRejectedValueOnce(new IdentitySearchTooBroadError());

  const response = await getValuesRoute(
    new Request(`http://localhost/api/websites/${websiteId}/values?type=distinctId`),
    params,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: 'bad-request', message: 'Identity search is too broad.' },
  });
});

test.each([
  ['metrics', getMetrics, getSessionMetrics],
  ['expanded metrics', getExpandedMetrics, getSessionExpandedMetrics],
] as const)('%s preserves a valid verified identity result', async (_, route, query) => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'owner' } },
    query: { type: 'distinctId', search: 'verified' },
  });
  vi.mocked(query).mockResolvedValueOnce([] as never);

  const response = await route(
    new Request(
      `http://localhost/api/websites/${websiteId}/metrics?type=distinctId&search=verified`,
    ),
    params,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
  expect(query).toHaveBeenCalledWith(websiteId, expect.objectContaining({ type: 'distinctId' }), {
    search: 'broad',
    distinctId: 'c.verified',
  });
});
