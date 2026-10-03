import { beforeEach, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import {
  canUpdateBoard,
  canUpdateLink,
  canUpdatePixel,
  canUpdateShareEntity,
  canUpdateWebsite,
  canViewAuthenticatedWebsite,
  canViewBoard,
  canViewLink,
  canViewPixel,
  canViewShareEntity,
} from '@/permissions';
import { getShare, getSharesByEntityId } from '@/queries/prisma';
import { GET as listBoardShares } from '../boards/[boardId]/shares/route';
import { GET as listLinkShares } from '../links/[linkId]/shares/route';
import { GET as listPixelShares } from '../pixels/[pixelId]/shares/route';
import { GET as listWebsiteShares } from '../websites/[websiteId]/shares/route';
import { GET as getShareById } from './id/[shareId]/route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canUpdateBoard: vi.fn(),
  canUpdateLink: vi.fn(),
  canUpdatePixel: vi.fn(),
  canUpdateShareEntity: vi.fn(),
  canUpdateWebsite: vi.fn(),
  canViewBoard: vi.fn(),
  canViewLink: vi.fn(),
  canViewPixel: vi.fn(),
  canViewShareEntity: vi.fn(),
  canViewAuthenticatedWebsite: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  createShare: vi.fn(),
  deleteShare: vi.fn(),
  getShare: vi.fn(),
  getSharesByEntityId: vi.fn(),
  updateShare: vi.fn(),
}));

const entityId = '3979e857-a987-4795-9380-12024a4440a9';
const shareId = '1068c1e3-f88f-497e-96a3-3da919872381';
const sibling = { id: shareId, entityId, slug: 'sibling-secret', parameters: { events: true } };
const page = { data: [sibling], count: 1, page: 1, pageSize: 20 };

const shareLists = [
  {
    label: 'board',
    path: 'boards',
    param: 'boardId',
    handler: listBoardShares,
    update: canUpdateBoard,
  },
  { label: 'link', path: 'links', param: 'linkId', handler: listLinkShares, update: canUpdateLink },
  {
    label: 'pixel',
    path: 'pixels',
    param: 'pixelId',
    handler: listPixelShares,
    update: canUpdatePixel,
  },
  {
    label: 'website',
    path: 'websites',
    param: 'websiteId',
    handler: listWebsiteShares,
    update: canUpdateWebsite,
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { shareToken: { websiteId: entityId } },
    query: {},
  });
  vi.mocked(canViewBoard).mockResolvedValue(true);
  vi.mocked(canViewLink).mockResolvedValue(true);
  vi.mocked(canViewPixel).mockResolvedValue(true);
  vi.mocked(canViewShareEntity).mockResolvedValue(true);
  vi.mocked(canViewAuthenticatedWebsite).mockResolvedValue(true);
  vi.mocked(getShare).mockResolvedValue(sibling as any);
  vi.mocked(getSharesByEntityId).mockResolvedValue(page as any);
});

for (const { label, path, param, handler, update } of shareLists) {
  const request = new Request(`http://localhost/api/${path}/${entityId}/shares`);
  const params = { params: Promise.resolve({ [param]: entityId }) } as any;

  test.each([
    { label: 'public share holder', auth: { shareToken: { websiteId: entityId } } },
    { label: 'read-only member', auth: { user: { id: 'viewer' } } },
  ])(`${label} shares deny $label despite view access`, async ({ auth }) => {
    vi.mocked(parseRequest).mockResolvedValue({ auth, query: {} });
    vi.mocked(update).mockResolvedValue(false);

    const response = await handler(request, params);

    expect(response.status).toBe(401);
    expect(getSharesByEntityId).not.toHaveBeenCalled();
  });

  test(`${label} share manager can still list slugs`, async () => {
    vi.mocked(parseRequest).mockResolvedValue({ auth: { user: { id: 'manager' } }, query: {} });
    vi.mocked(update).mockResolvedValue(true);

    const response = await handler(request, params);

    expect(response.status).toBe(200);
    expect((await response.json()).data[0].slug).toBe(sibling.slug);
  });
}

test('share detail denies public holders and read-only members even when they know an ID', async () => {
  for (const auth of [{ shareToken: { websiteId: entityId } }, { user: { id: 'viewer' } }]) {
    vi.mocked(parseRequest).mockResolvedValue({ auth });
    vi.mocked(canUpdateShareEntity).mockResolvedValue(false);

    const response = await getShareById(new Request(`http://localhost/api/share/id/${shareId}`), {
      params: Promise.resolve({ shareId }),
    });

    expect(response.status).toBe(401);
  }
});

test('share manager can still read share details', async () => {
  vi.mocked(parseRequest).mockResolvedValue({ auth: { user: { id: 'manager' } } });
  vi.mocked(canUpdateShareEntity).mockResolvedValue(true);

  const response = await getShareById(new Request(`http://localhost/api/share/id/${shareId}`), {
    params: Promise.resolve({ shareId }),
  });

  expect(response.status).toBe(200);
  expect((await response.json()).slug).toBe(sibling.slug);
});
