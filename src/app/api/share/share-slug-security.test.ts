import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { canCreateWebsite, canUpdateShareEntity, canUpdateWebsite } from '@/permissions';
import {
  createShare,
  createWebsite,
  getShare,
  getWebsite,
  updateShare,
  updateWebsite,
} from '@/queries/prisma';
import { POST as updateWebsiteRoute } from '../websites/[websiteId]/route';
import { POST as createWebsiteRoute } from '../websites/route';
import { POST as updateShareRoute } from './id/[shareId]/route';
import { POST as createShareRoute } from './route';

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(async (request: Request, schema: any) => {
    const parsed = schema.safeParse(await request.json());

    if (!parsed.success) {
      return { error: () => Response.json({ error: { code: 'bad-request' } }, { status: 400 }) };
    }

    return {
      auth: { authType: 'session', user: { id: 'manager', isAdmin: true } },
      body: parsed.data,
    };
  }),
  getQueryFilters: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ isEnvEnabled: () => false }));
vi.mock('@/lib/load', () => ({ fetchAccount: vi.fn(), fetchTeam: vi.fn() }));
vi.mock('@/lib/subscription', () => ({ getCloudWebsiteLimit: vi.fn() }));
vi.mock('@/permissions', () => ({
  canCreateTeamWebsite: vi.fn(),
  canCreateWebsite: vi.fn(),
  canUpdateBoard: vi.fn(),
  canUpdateLink: vi.fn(),
  canUpdatePixel: vi.fn(),
  canUpdateShareEntity: vi.fn(),
  canUpdateWebsite: vi.fn(),
  redactWebsiteListShareIds: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  createShare: vi.fn(),
  createWebsite: vi.fn(),
  getBoard: vi.fn(),
  getLink: vi.fn(),
  getPixel: vi.fn(),
  getShare: vi.fn(),
  getWebsite: vi.fn(),
  updateShare: vi.fn(),
  updateWebsite: vi.fn(),
}));
vi.mock('@/queries/prisma/website', () => ({
  getAllUserWebsitesIncludingTeamAccess: vi.fn(),
  getUserWebsites: vi.fn(),
}));

const entityId = '3979e857-a987-4795-9380-12024a4440a9';
const shareId = '1068c1e3-f88f-497e-96a3-3da919872381';
const existingSlug = 'existingShareSecret';
const shareBody = {
  entityId,
  shareType: ENTITY_TYPE.website,
  name: 'Example',
  parameters: { overview: true },
};

function post(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DISABLE_PUBLIC_SHARES', '0');
  vi.mocked(canCreateWebsite).mockResolvedValue(true);
  vi.mocked(canUpdateWebsite).mockResolvedValue(true);
  vi.mocked(canUpdateShareEntity).mockResolvedValue(true);
  vi.mocked(getShare).mockResolvedValue({
    id: shareId,
    entityId,
    shareType: ENTITY_TYPE.website,
    slug: existingSlug,
  } as any);
  vi.mocked(getWebsite).mockResolvedValue({ id: entityId } as any);
  vi.mocked(createShare).mockImplementation(async data => data as any);
  vi.mocked(updateShare).mockImplementation(async (_id, data) => ({ id: shareId, ...data }) as any);
  vi.mocked(createWebsite).mockResolvedValue({ website: { id: entityId } } as any);
  vi.mocked(updateWebsite).mockResolvedValue({ website: { id: entityId }, share: null } as any);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test.each(['guessable', 'aaaaaaaa', 'A'.repeat(100)])(
  'share creation rejects caller-selected slug %s',
  async slug => {
    const response = await createShareRoute(post('/api/share', { ...shareBody, slug }));

    expect(response.status).toBe(400);
    expect(createShare).not.toHaveBeenCalled();
  },
);

test('share creation returns a server-generated bearer slug', async () => {
  const response = await createShareRoute(post('/api/share', shareBody));

  expect(response.status).toBe(200);
  expect((await response.json()).slug).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect(createShare).toHaveBeenCalledWith(
    expect.objectContaining({ slug: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/) }),
    'manager',
  );
});

test('editing a share preserves its existing URL', async () => {
  const response = await updateShareRoute(
    post(`/api/share/id/${shareId}`, {
      name: 'Renamed',
      slug: existingSlug,
      parameters: { events: true },
    }),
    { params: Promise.resolve({ shareId }) },
  );

  expect(response.status).toBe(200);
  expect(updateShare).toHaveBeenCalledWith(
    shareId,
    { name: 'Renamed', slug: existingSlug, rotate: undefined, parameters: { events: true } },
    'manager',
  );
});

test('editing a share rejects a caller-selected replacement URL', async () => {
  const response = await updateShareRoute(
    post(`/api/share/id/${shareId}`, {
      name: 'Renamed',
      slug: 'guessable',
      parameters: {},
    }),
    { params: Promise.resolve({ shareId }) },
  );

  expect(response.status).toBe(400);
  expect(updateShare).not.toHaveBeenCalled();
});

test('explicit rotation generates a new bearer slug', async () => {
  const response = await updateShareRoute(
    post(`/api/share/id/${shareId}`, {
      name: 'Renamed',
      slug: existingSlug,
      rotate: true,
      parameters: {},
    }),
    { params: Promise.resolve({ shareId }) },
  );

  expect(response.status).toBe(200);
  expect(updateShare).toHaveBeenCalledWith(
    shareId,
    { name: 'Renamed', slug: existingSlug, rotate: true, parameters: {} },
    'manager',
  );
});

test('a share edit reports a conflict if its public URL changed during the request', async () => {
  vi.mocked(updateShare).mockRejectedValueOnce(new Error('SHARE_SLUG_CHANGED'));

  const response = await updateShareRoute(
    post(`/api/share/id/${shareId}`, {
      name: 'Stale edit',
      slug: existingSlug,
      parameters: {},
    }),
    { params: Promise.resolve({ shareId }) },
  );

  expect(response.status).toBe(409);
});

test('website creation rejects a caller-selected public link', async () => {
  const response = await createWebsiteRoute(
    post('/api/websites', { name: 'Example', domain: 'example.com', shareId: 'guessable' }),
  );

  expect(response.status).toBe(400);
  expect(createWebsite).not.toHaveBeenCalled();
});

test('website creation without a public link still works', async () => {
  const response = await createWebsiteRoute(
    post('/api/websites', { name: 'Example', domain: 'example.com' }),
  );

  expect(response.status).toBe(200);
  expect((await response.json()).shareId).toBeNull();
});

test('website updates reject caller-selected public links', async () => {
  const response = await updateWebsiteRoute(
    post(`/api/websites/${entityId}`, { shareId: 'guessable' }),
    { params: Promise.resolve({ websiteId: entityId }) },
  );

  expect(response.status).toBe(400);
  expect(updateWebsite).not.toHaveBeenCalled();
});

test('website owners can still revoke existing public links', async () => {
  const response = await updateWebsiteRoute(post(`/api/websites/${entityId}`, { shareId: null }), {
    params: Promise.resolve({ websiteId: entityId }),
  });

  expect(response.status).toBe(200);
  expect(updateWebsite).toHaveBeenCalledWith(
    entityId,
    { name: undefined, domain: undefined },
    'manager',
    { removeShares: true, replayConfig: undefined },
  );
});
